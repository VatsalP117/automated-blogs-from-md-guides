# Chapter 4 — Querying Beyond CRUD

## Table of Contents

- [4.1 Why SELECT * Is a Code Smell](#41-why-select--is-a-code-smell)
- [4.2 Filtering: WHERE Clause Deep Dive](#42-filtering-where-clause-deep-dive)
- [4.3 Pattern Matching: LIKE, ILIKE, SIMILAR TO, Regex](#43-pattern-matching-like-ilike-similar-to-regex)
- [4.4 Sorting: ORDER BY in Depth](#44-sorting-order-by-in-depth)
- [4.5 Pagination: LIMIT/OFFSET vs Keyset Pagination](#45-pagination-limitoffset-vs-keyset-pagination)
- [4.6 Aggregations: GROUP BY, HAVING, and Aggregate Functions](#46-aggregations-group-by-having-and-aggregate-functions)
- [4.7 DISTINCT and DISTINCT ON](#47-distinct-and-distinct-on)
- [4.8 CASE Expressions](#48-case-expressions)
- [4.9 Working with NULLs](#49-working-with-nulls)
- [4.10 Essential Functions for Production Queries](#410-essential-functions-for-production-queries)
- [4.11 Subqueries](#411-subqueries)
- [4.12 Set Operations: UNION, INTERSECT, EXCEPT](#412-set-operations-union-intersect-except)

---

## 4.1 Why SELECT * Is a Code Smell

Every beginner writes `SELECT * FROM users WHERE id = 1`. Here's why senior engineers don't.

**Problem 1: You read data you don't need.**

If the `users` table has 20 columns including a large `bio TEXT` column and a `preferences JSONB` column, `SELECT *` reads all of them — even if you only need `id`, `email`, and `display_name`. The oversized columns may be TOASTed (stored in a separate table), requiring extra I/O to decompress and fetch. On a hot path serving 10,000 requests per second, that's wasted I/O, wasted memory, and wasted network bandwidth.

**Problem 2: Index-only scans become impossible.**

If you have an index on `(email, display_name)` and you query `SELECT email, display_name FROM users WHERE email = 'alice@example.com'`, PostgreSQL can answer the query entirely from the index without touching the heap (the main table). This is called an index-only scan and it's significantly faster. `SELECT *` always requires a heap fetch because the index doesn't contain all columns.

**Problem 3: Schema changes break your application silently.**

If someone adds a column to the table, `SELECT *` returns the new column. Your application code (particularly when scanning rows into structs in Go) may not expect it and either fails or silently ignores data. Explicit column lists make your contract with the database explicit.

**Problem 4: It makes query plans harder to read.**

When diagnosing performance, knowing exactly which columns are needed helps you understand whether an index-only scan is possible and which indexes are relevant.

```sql
-- BAD: reads everything, can't use index-only scan
SELECT * FROM users WHERE email = 'alice@example.com';

-- GOOD: explicit columns, index-only scan possible with covering index
SELECT id, email, display_name FROM users WHERE email = 'alice@example.com';
```

**The one exception:** In ad-hoc psql sessions when exploring data, `SELECT *` is fine. In application code, never.

---

## 4.2 Filtering: WHERE Clause Deep Dive

The WHERE clause is where most of the work in query optimization happens. Understanding how PostgreSQL evaluates WHERE conditions is essential for writing fast queries.

### Comparison Operators

```sql
-- Equality
SELECT * FROM orders WHERE status = 'shipped';

-- Inequality (both forms are equivalent)
SELECT * FROM orders WHERE status != 'shipped';
SELECT * FROM orders WHERE status <> 'shipped';

-- Range comparisons
SELECT * FROM orders WHERE total_cents > 10000;
SELECT * FROM orders WHERE total_cents >= 10000;
SELECT * FROM orders WHERE created_at < '2024-01-01';
```

### BETWEEN

`BETWEEN` is inclusive on both ends. It's syntactic sugar for `>= AND <=`.

```sql
-- These two are identical:
SELECT * FROM orders WHERE total_cents BETWEEN 1000 AND 5000;
SELECT * FROM orders WHERE total_cents >= 1000 AND total_cents <= 5000;

-- BETWEEN works with dates too:
SELECT * FROM orders
WHERE created_at BETWEEN '2024-01-01' AND '2024-12-31';

-- WARNING: With TIMESTAMPTZ, BETWEEN '2024-01-01' AND '2024-12-31'
-- includes '2024-12-31 00:00:00' but NOT '2024-12-31 23:59:59'.
-- For timestamp ranges, use explicit >= and <:
SELECT * FROM orders
WHERE created_at >= '2024-01-01' AND created_at < '2025-01-01';
```

### IN

`IN` checks if a value is in a list. PostgreSQL optimizes small IN lists into equality checks.

```sql
SELECT * FROM orders WHERE status IN ('shipped', 'delivered');

-- Equivalent to:
SELECT * FROM orders WHERE status = 'shipped' OR status = 'delivered';

-- IN with a subquery:
SELECT * FROM users WHERE id IN (
    SELECT user_id FROM orders WHERE total_cents > 10000
);
```

**Performance note:** For large IN lists (hundreds of values), PostgreSQL may choose a hash-based comparison rather than checking each value. But very large IN lists (thousands of values) from application code are a smell — consider using a temporary table or an `= ANY(ARRAY[...])` with a properly parameterized query.

### ANY and ALL

`ANY` and `ALL` are more flexible than `IN`. They work with any comparison operator, not just equality.

```sql
-- ANY: value matches at least one element (equivalent to IN for equality)
SELECT * FROM orders WHERE status = ANY(ARRAY['shipped', 'delivered']);

-- ANY with other operators:
SELECT * FROM products WHERE price_cents > ANY(ARRAY[1000, 2000, 3000]);
-- True if price_cents > 1000 (the minimum — at least one matches)

-- ALL: value matches every element
SELECT * FROM products WHERE price_cents > ALL(ARRAY[1000, 2000, 3000]);
-- True only if price_cents > 3000 (greater than ALL values)

-- ANY is particularly useful with array columns:
SELECT * FROM articles WHERE 'postgresql' = ANY(tags);
-- Returns articles where the tags array contains 'postgresql'
```

**In Go with pgx/sqlc**, `ANY` is the standard pattern for passing slices as parameters:

```sql
-- sqlc query definition:
-- name: GetOrdersByStatus :many
SELECT * FROM orders WHERE status = ANY(@statuses::text[]);
```

### EXISTS

`EXISTS` checks whether a subquery returns any rows. It's often more efficient than `IN` because it stops as soon as it finds the first matching row.

```sql
-- Users who have placed at least one order
SELECT u.id, u.email FROM users u
WHERE EXISTS (
    SELECT 1 FROM orders o WHERE o.user_id = u.id
);

-- Users who have NOT placed any order
SELECT u.id, u.email FROM users u
WHERE NOT EXISTS (
    SELECT 1 FROM orders o WHERE o.user_id = u.id
);
```

**EXISTS vs IN — when to use which:**

```sql
-- These are logically equivalent:
SELECT * FROM users WHERE id IN (SELECT user_id FROM orders);
SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id);

-- The planner often transforms one into the other, but:
-- EXISTS is preferable when:
--   - The subquery could return many duplicate values (EXISTS stops at first match)
--   - The subquery is correlated (references the outer table)
-- IN is preferable when:
--   - The list is small and static
--   - Readability is more important
```

### Operator Precedence in WHERE

`AND` has higher precedence than `OR`. This is a common source of bugs:

```sql
-- BUG: AND binds tighter than OR
-- This means: (status = 'shipped' AND total_cents > 5000) OR status = 'delivered'
-- NOT: status IN ('shipped', 'delivered') AND total_cents > 5000
SELECT * FROM orders
WHERE status = 'shipped' OR status = 'delivered' AND total_cents > 5000;

-- CORRECT: Use parentheses to be explicit
SELECT * FROM orders
WHERE (status = 'shipped' OR status = 'delivered') AND total_cents > 5000;

-- EVEN BETTER: Use IN for clarity
SELECT * FROM orders
WHERE status IN ('shipped', 'delivered') AND total_cents > 5000;
```

**Rule: Always use parentheses when combining AND and OR. Never rely on precedence for readability.**

---

## 4.3 Pattern Matching: LIKE, ILIKE, SIMILAR TO, Regex

### LIKE

`LIKE` does simple pattern matching with two wildcards:
- `%` matches any sequence of zero or more characters
- `_` matches exactly one character

```sql
-- Emails from example.com
SELECT * FROM users WHERE email LIKE '%@example.com';

-- Names starting with 'Al'
SELECT * FROM users WHERE display_name LIKE 'Al%';

-- Names with exactly 5 characters
SELECT * FROM users WHERE display_name LIKE '_____';

-- Escaping: to match a literal % or _
SELECT * FROM products WHERE name LIKE '%\%%';  -- contains a literal %
```

### ILIKE (Case-Insensitive LIKE)

PostgreSQL-specific extension. Same as LIKE but case-insensitive.

```sql
-- Matches 'alice', 'Alice', 'ALICE', etc.
SELECT * FROM users WHERE email ILIKE '%@example.com';
```

### Performance Implications of Pattern Matching

This matters a lot in production:

```sql
-- PREFIX match (LIKE 'prefix%'): CAN use a B-tree index
SELECT * FROM users WHERE email LIKE 'alice@%';
-- With text_pattern_ops index, this is an index range scan. Fast.

-- SUFFIX match (LIKE '%suffix'): CANNOT use a B-tree index
SELECT * FROM users WHERE email LIKE '%@example.com';
-- Requires a sequential scan of the entire table. Slow on large tables.

-- CONTAINS match (LIKE '%word%'): CANNOT use a B-tree index
SELECT * FROM users WHERE display_name LIKE '%alice%';
-- Sequential scan. For this use case, consider pg_trgm or full-text search.
```

**For suffix and contains matching**, use the `pg_trgm` extension:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN trigram index supports LIKE '%substring%' and ILIKE
CREATE INDEX idx_users_name_trgm ON users USING GIN (display_name gin_trgm_ops);

-- Now this uses the trigram index:
SELECT * FROM users WHERE display_name ILIKE '%alice%';
```

### Regular Expressions

PostgreSQL supports POSIX regular expressions with the `~` operator family:

```sql
-- ~ is case-sensitive regex match
SELECT * FROM users WHERE email ~ '^[a-z]+@example\.com$';

-- ~* is case-insensitive regex match
SELECT * FROM users WHERE email ~* '^[a-z]+@example\.com$';

-- !~ is negated regex (does NOT match)
SELECT * FROM users WHERE email !~ '@spam\.com$';

-- !~* is case-insensitive negated regex
SELECT * FROM users WHERE email !~* '@(spam|junk)\.com$';
```

**Performance warning:** Regex matching is expensive — it cannot use standard B-tree indexes. For simple patterns, prefer LIKE. For complex text search, use `pg_trgm` indexes or full-text search (Chapter 8).

### SIMILAR TO

`SIMILAR TO` uses SQL standard regex syntax (a hybrid of LIKE and regex). It exists for SQL standard compliance but is rarely used in practice. Prefer `LIKE` for simple patterns and `~` for regex.

---

## 4.4 Sorting: ORDER BY in Depth

### Basic Sorting

```sql
-- Ascending (default)
SELECT * FROM orders ORDER BY created_at ASC;

-- Descending
SELECT * FROM orders ORDER BY created_at DESC;

-- Multiple columns: sort by status first, then by date within each status
SELECT * FROM orders ORDER BY status ASC, created_at DESC;
```

### NULL Handling in ORDER BY

By default, NULLs sort LAST in ascending order and FIRST in descending order. You can override this:

```sql
-- NULLs first in ascending order (unusual but sometimes needed)
SELECT * FROM tasks ORDER BY due_date ASC NULLS FIRST;

-- NULLs last in descending order (common: "tasks with due dates first, then unscheduled")
SELECT * FROM tasks ORDER BY due_date DESC NULLS LAST;
```

This matters for indexes too. If your query sorts `ORDER BY due_date ASC NULLS LAST` but your index was created with default NULL ordering, the index may not be usable for the sort. You can create indexes with matching NULL order:

```sql
CREATE INDEX idx_tasks_due_date ON tasks (due_date ASC NULLS LAST);
```

### Sorting by Expression

```sql
-- Sort by the length of the name
SELECT * FROM products ORDER BY char_length(name);

-- Sort by a computed value
SELECT *, (price_cents * quantity) AS total
FROM order_items
ORDER BY total DESC;

-- Sort by a CASE expression (custom ordering)
SELECT * FROM tasks ORDER BY
    CASE status
        WHEN 'in_progress' THEN 1
        WHEN 'open' THEN 2
        WHEN 'in_review' THEN 3
        WHEN 'done' THEN 4
        WHEN 'closed' THEN 5
    END;
```

### ORDER BY and Performance

Sorting is expensive on large result sets. PostgreSQL must either:
1. **Use an index** that already has the data in the desired order (fast)
2. **Sort in memory** using `work_mem` (fast if it fits)
3. **Sort on disk** if the data exceeds `work_mem` (slow)

```sql
-- If there's an index on (created_at DESC), this sort is free:
SELECT id, created_at FROM orders ORDER BY created_at DESC LIMIT 20;

-- If there's no matching index, PostgreSQL sorts in memory or on disk:
-- EXPLAIN output will show "Sort" or "Sort Method: external merge" (disk sort)
```

**Rule: If a query always sorts the same way, consider creating an index that matches the sort order.** Especially important for paginated queries that always sort by the same column.

---

## 4.5 Pagination: LIMIT/OFFSET vs Keyset Pagination

### LIMIT/OFFSET — The Simple Approach

```sql
-- Page 1 (first 20 results)
SELECT * FROM orders ORDER BY created_at DESC LIMIT 20 OFFSET 0;

-- Page 2
SELECT * FROM orders ORDER BY created_at DESC LIMIT 20 OFFSET 20;

-- Page 100
SELECT * FROM orders ORDER BY created_at DESC LIMIT 20 OFFSET 1980;
```

### Why OFFSET Breaks at Scale

`OFFSET 1980` does NOT skip to position 1980 magically. PostgreSQL must:
1. Execute the query and sort all matching rows
2. Generate the first 2000 rows (1980 + 20)
3. Discard the first 1980 rows
4. Return the remaining 20

The cost of the query grows linearly with the offset. At OFFSET 1,000,000, PostgreSQL reads, sorts, and discards one million rows to return 20. This gets progressively slower:

```
OFFSET 0:       ~2ms
OFFSET 1000:    ~10ms
OFFSET 10000:   ~80ms
OFFSET 100000:  ~500ms
OFFSET 1000000: ~5000ms
```

**Additional problem:** If data is inserted or deleted between page requests, rows shift position. A user paginating through results may see duplicates or miss rows entirely.

### Keyset Pagination (Cursor-Based) — The Production Standard

Instead of saying "skip N rows," keyset pagination says "give me rows after this specific point."

```sql
-- First page: no cursor, just get the newest 20
SELECT id, title, created_at
FROM orders
WHERE status = 'shipped'
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

The last row returned might be `(created_at='2024-06-15 10:30:00', id=4523)`. To get the next page:

```sql
-- Next page: rows "after" the last row from the previous page
SELECT id, title, created_at
FROM orders
WHERE status = 'shipped'
  AND (created_at, id) < ('2024-06-15 10:30:00', 4523)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

The `(created_at, id) < ('2024-06-15 10:30:00', 4523)` is a **row value comparison**. PostgreSQL compares the tuple `(created_at, id)` lexicographically, which matches the ORDER BY. With an index on `(created_at DESC, id DESC)`, this is an index range scan regardless of how deep you paginate. Page 1 and page 10,000 have identical cost.

### Keyset Pagination: Full Production Pattern

```sql
-- Index that supports the sort + filter
CREATE INDEX idx_orders_shipped_cursor ON orders (created_at DESC, id DESC)
    WHERE status = 'shipped';

-- First page
SELECT id, title, created_at
FROM orders
WHERE status = 'shipped'
ORDER BY created_at DESC, id DESC
LIMIT 21;  -- fetch 21 to know if there's a next page (return 20, use 21st as signal)

-- Subsequent pages (application passes the cursor from the last row of previous page)
SELECT id, title, created_at
FROM orders
WHERE status = 'shipped'
  AND (created_at, id) < ($1, $2)  -- $1 = last_created_at, $2 = last_id
ORDER BY created_at DESC, id DESC
LIMIT 21;
```

**Why include `id` in the sort and cursor?** Because `created_at` is not unique — multiple orders can have the same timestamp. Without `id` as a tiebreaker, you'd skip or duplicate rows that share a timestamp. The `id` column (being the primary key) guarantees uniqueness.

**Cursor encoding:** In your API, encode the cursor as a base64 or opaque string:
```
cursor = base64("2024-06-15T10:30:00Z,4523")
```
The client sends this cursor to request the next page. The server decodes it to get the `(created_at, id)` values.

### When to Use Each

| Criteria | OFFSET | Keyset |
|---|---|---|
| Random page access ("jump to page 50") | Yes | No (must paginate sequentially) |
| Performance at deep pages | Degrades linearly | Constant |
| Consistent results during concurrent writes | No | Yes |
| Implementation complexity | Trivial | Moderate |
| Total count needed | Can use `COUNT(*)` | Requires separate query |

**What production systems use:** Keyset pagination for any user-facing list (feeds, search results, dashboards). OFFSET only for admin interfaces where page jumping is needed and data volume is small.

---

## 4.6 Aggregations: GROUP BY, HAVING, and Aggregate Functions

### GROUP BY Fundamentals

`GROUP BY` collapses rows that share the same values in the grouped columns into a single output row. Every column in the SELECT list must either be in the GROUP BY clause or be wrapped in an aggregate function.

```sql
-- Count orders per status
SELECT status, COUNT(*) AS order_count
FROM orders
GROUP BY status;

-- Result:
-- status     | order_count
-- -----------+------------
-- pending    | 150
-- shipped    | 843
-- delivered  | 2301
-- cancelled  | 47
```

### Aggregate Functions

```sql
-- COUNT: count rows
SELECT COUNT(*) FROM orders;                    -- count all rows
SELECT COUNT(coupon_id) FROM orders;            -- count non-NULL values only
SELECT COUNT(DISTINCT user_id) FROM orders;     -- count unique users who ordered

-- SUM: total
SELECT SUM(total_cents) FROM orders WHERE status = 'delivered';

-- AVG: average
SELECT AVG(total_cents)::NUMERIC(12,2) AS avg_order_value FROM orders;

-- MIN / MAX
SELECT MIN(created_at) AS first_order, MAX(created_at) AS last_order FROM orders;

-- Combined: order statistics per user
SELECT
    user_id,
    COUNT(*) AS order_count,
    SUM(total_cents) AS total_spent_cents,
    AVG(total_cents)::INTEGER AS avg_order_cents,
    MIN(created_at) AS first_order_at,
    MAX(created_at) AS last_order_at
FROM orders
WHERE status != 'cancelled'
GROUP BY user_id
ORDER BY total_spent_cents DESC;
```

### HAVING: Filtering After Aggregation

`WHERE` filters rows BEFORE aggregation. `HAVING` filters groups AFTER aggregation.

```sql
-- Users who have placed more than 10 orders
SELECT user_id, COUNT(*) AS order_count
FROM orders
GROUP BY user_id
HAVING COUNT(*) > 10
ORDER BY order_count DESC;

-- Products ordered by more than 100 different customers
SELECT product_id, COUNT(DISTINCT user_id) AS customer_count
FROM order_items oi
JOIN orders o ON oi.order_id = o.id
GROUP BY product_id
HAVING COUNT(DISTINCT user_id) > 100;
```

**Common mistake:** Using WHERE where HAVING is needed:
```sql
-- WRONG: Can't use aggregate in WHERE
SELECT user_id, COUNT(*) FROM orders WHERE COUNT(*) > 10 GROUP BY user_id;
-- ERROR: aggregate functions are not allowed in WHERE

-- CORRECT:
SELECT user_id, COUNT(*) FROM orders GROUP BY user_id HAVING COUNT(*) > 10;
```

### FILTER: Per-Aggregate Condition (PostgreSQL Extension)

`FILTER` lets you apply different conditions to different aggregates in the same query. This is extremely useful and often unknown.

```sql
-- Count orders by status in a single query (instead of multiple queries)
SELECT
    user_id,
    COUNT(*) AS total_orders,
    COUNT(*) FILTER (WHERE status = 'delivered') AS delivered_orders,
    COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_orders,
    SUM(total_cents) FILTER (WHERE status = 'delivered') AS delivered_revenue_cents,
    AVG(total_cents) FILTER (WHERE status != 'cancelled') AS avg_non_cancelled_cents
FROM orders
GROUP BY user_id;
```

Without `FILTER`, you'd need CASE expressions:
```sql
-- Equivalent but more verbose:
SUM(CASE WHEN status = 'delivered' THEN total_cents ELSE 0 END) AS delivered_revenue_cents
```

### Grouping Sets, CUBE, ROLLUP

For generating subtotals and grand totals in a single query:

```sql
-- ROLLUP: hierarchical subtotals
-- Subtotals for each category, then each category+status, then grand total
SELECT
    COALESCE(category, 'ALL CATEGORIES') AS category,
    COALESCE(status, 'ALL STATUSES') AS status,
    COUNT(*) AS product_count,
    SUM(price_cents) AS total_value_cents
FROM products
GROUP BY ROLLUP (category, status)
ORDER BY category, status;

-- Result includes rows for:
-- (Electronics, active)    → 150 products
-- (Electronics, archived)  → 23 products
-- (Electronics, ALL)       → 173 products (subtotal)
-- (Clothing, active)       → 89 products
-- ...
-- (ALL, ALL)               → 500 products (grand total)
```

---

## 4.7 DISTINCT and DISTINCT ON

### DISTINCT

`DISTINCT` removes duplicate rows from the result set.

```sql
-- All unique statuses that exist in orders
SELECT DISTINCT status FROM orders;

-- All unique (user_id, status) combinations
SELECT DISTINCT user_id, status FROM orders;
```

**Performance note:** `DISTINCT` requires either a sort or a hash aggregation. On large result sets, it's expensive. If you only need to know if a value exists, use `EXISTS` instead of `SELECT DISTINCT`.

### DISTINCT ON (PostgreSQL-Specific)

`DISTINCT ON (expression)` returns the first row for each unique value of the expression. This is incredibly powerful and not available in standard SQL.

```sql
-- Get the most recent order for each user
SELECT DISTINCT ON (user_id) user_id, id, total_cents, created_at
FROM orders
ORDER BY user_id, created_at DESC;
```

This is equivalent to the much more verbose:
```sql
-- Standard SQL approach (less efficient):
SELECT o.user_id, o.id, o.total_cents, o.created_at
FROM orders o
JOIN (
    SELECT user_id, MAX(created_at) AS max_created
    FROM orders
    GROUP BY user_id
) latest ON o.user_id = latest.user_id AND o.created_at = latest.max_created;
```

**How DISTINCT ON works:** PostgreSQL sorts the results by the DISTINCT ON expression (and the ORDER BY within each group), then takes the first row from each group.

**Critical rule:** The ORDER BY must START WITH the DISTINCT ON expression. You can add additional ordering within each group:

```sql
-- CORRECT: ORDER BY starts with user_id (the DISTINCT ON expression)
SELECT DISTINCT ON (user_id) user_id, id, total_cents, created_at
FROM orders
ORDER BY user_id, created_at DESC;

-- WRONG: ORDER BY doesn't start with user_id
SELECT DISTINCT ON (user_id) user_id, id, total_cents, created_at
FROM orders
ORDER BY created_at DESC;  -- ERROR or unpredictable results
```

**Real production uses:**
```sql
-- Latest login per user
SELECT DISTINCT ON (user_id) *
FROM login_events
ORDER BY user_id, created_at DESC;

-- Latest status change per task
SELECT DISTINCT ON (task_id) task_id, status, changed_at
FROM task_status_history
ORDER BY task_id, changed_at DESC;

-- Most expensive product per category
SELECT DISTINCT ON (category_id) category_id, id, name, price_cents
FROM products
ORDER BY category_id, price_cents DESC;
```

---

## 4.8 CASE Expressions

`CASE` is SQL's if/else. It's evaluated inline within a query and returns a value.

### Simple CASE

```sql
SELECT
    id,
    title,
    status,
    CASE status
        WHEN 'open' THEN 'Not Started'
        WHEN 'in_progress' THEN 'Working'
        WHEN 'done' THEN 'Finished'
        ELSE 'Unknown'
    END AS display_status
FROM tasks;
```

### Searched CASE (More Flexible)

```sql
SELECT
    id,
    total_cents,
    CASE
        WHEN total_cents >= 100000 THEN 'premium'
        WHEN total_cents >= 50000 THEN 'standard'
        WHEN total_cents >= 10000 THEN 'basic'
        ELSE 'micro'
    END AS order_tier
FROM orders;
```

### CASE in ORDER BY, GROUP BY, WHERE, and Aggregates

```sql
-- Custom sort order
SELECT * FROM tasks
ORDER BY CASE priority
    WHEN 4 THEN 1  -- critical first
    WHEN 3 THEN 2  -- high
    WHEN 2 THEN 3  -- medium
    WHEN 1 THEN 4  -- low
    WHEN 0 THEN 5  -- none
END;

-- Grouping by computed buckets
SELECT
    CASE
        WHEN age < 18 THEN 'minor'
        WHEN age BETWEEN 18 AND 25 THEN '18-25'
        WHEN age BETWEEN 26 AND 40 THEN '26-40'
        ELSE '40+'
    END AS age_group,
    COUNT(*) AS user_count
FROM users
GROUP BY 1;  -- "GROUP BY 1" means group by the first SELECT expression

-- Conditional aggregation (pivot-like)
SELECT
    date_trunc('month', created_at) AS month,
    SUM(CASE WHEN status = 'delivered' THEN total_cents ELSE 0 END) AS delivered_cents,
    SUM(CASE WHEN status = 'cancelled' THEN total_cents ELSE 0 END) AS cancelled_cents
FROM orders
GROUP BY 1
ORDER BY 1;
```

---

## 4.9 Working with NULLs

NULL is not a value — it's the absence of a value. It represents "unknown." This leads to behavior that surprises engineers who don't understand three-valued logic.

### NULL Comparison Rules

```sql
-- NULL is not equal to anything, including itself
SELECT NULL = NULL;       -- Returns NULL (not TRUE!)
SELECT NULL != NULL;      -- Returns NULL (not TRUE!)
SELECT NULL = 1;          -- Returns NULL
SELECT NULL > 0;          -- Returns NULL

-- The ONLY way to check for NULL:
SELECT * FROM users WHERE bio IS NULL;
SELECT * FROM users WHERE bio IS NOT NULL;
```

### IS DISTINCT FROM — NULL-Safe Comparison

`IS DISTINCT FROM` treats NULL as a comparable value — two NULLs are considered "not distinct" (equal).

```sql
-- Standard comparison fails with NULLs:
SELECT * FROM users WHERE bio = NULL;           -- returns NOTHING (NULL = NULL is NULL, not TRUE)
SELECT * FROM users WHERE bio != 'hello';       -- misses rows where bio IS NULL

-- IS DISTINCT FROM handles NULLs as you'd expect:
SELECT * FROM users WHERE bio IS DISTINCT FROM 'hello';
-- Returns rows where bio != 'hello' AND rows where bio IS NULL

SELECT * FROM users WHERE bio IS NOT DISTINCT FROM NULL;
-- Same as: WHERE bio IS NULL
```

### COALESCE — Default for NULLs

`COALESCE` returns the first non-NULL argument:

```sql
-- Replace NULL with a default value
SELECT COALESCE(bio, 'No bio provided') AS bio FROM users;

-- Chain multiple fallbacks
SELECT COALESCE(preferred_name, display_name, email) AS name FROM users;

-- Use in calculations to treat NULL as zero
SELECT SUM(COALESCE(discount_cents, 0)) FROM order_items;
```

### NULLIF — Create NULLs Conditionally

`NULLIF(a, b)` returns NULL if `a = b`, otherwise returns `a`. Useful for avoiding division by zero:

```sql
-- Avoid division by zero
SELECT total_cents / NULLIF(quantity, 0) AS unit_price FROM order_items;
-- If quantity is 0, NULLIF returns NULL, and total_cents / NULL = NULL (instead of error)
```

### NULL in Aggregates

Aggregate functions (except `COUNT(*)`) ignore NULLs:

```sql
-- Setup: values are 10, 20, NULL, 30
SELECT
    COUNT(*) AS count_all,          -- 4 (counts all rows)
    COUNT(value) AS count_non_null, -- 3 (counts non-NULL values)
    SUM(value) AS sum_value,        -- 60 (10+20+30, NULL ignored)
    AVG(value) AS avg_value;        -- 20 (60/3, not 60/4!)
```

**This `AVG` behavior is a common source of bugs.** If you want NULLs to count as 0 in the average:
```sql
SELECT AVG(COALESCE(value, 0)) AS avg_with_nulls_as_zero;  -- 60/4 = 15
```

### NULL in Boolean Logic

```sql
-- NULL AND TRUE = NULL (not FALSE!)
-- NULL OR TRUE = TRUE
-- NULL OR FALSE = NULL
-- NOT NULL = NULL

-- Practical implication:
-- WHERE is_active AND department_id = 5
-- If is_active is NULL, the whole condition evaluates to NULL (treated as FALSE)
-- The row is excluded — which might be correct or a bug depending on intent
```

---

## 4.10 Essential Functions for Production Queries

### String Functions

```sql
-- Concatenation (prefer || over concat())
SELECT first_name || ' ' || last_name AS full_name FROM employees;

-- Length
SELECT char_length('hello');  -- 5 (character count)
SELECT octet_length('hello'); -- 5 (byte count, differs for multi-byte chars)

-- Case conversion
SELECT lower('Hello World');   -- 'hello world'
SELECT upper('Hello World');   -- 'HELLO WORLD'
SELECT initcap('hello world'); -- 'Hello World'

-- Trimming
SELECT trim('  hello  ');          -- 'hello'
SELECT ltrim('  hello  ');         -- 'hello  '
SELECT rtrim('  hello  ');         -- '  hello'
SELECT trim(both 'x' from 'xxxhelloxxx');  -- 'hello'

-- Substring
SELECT substring('hello world' from 7 for 5);  -- 'world'
SELECT left('hello world', 5);                  -- 'hello'
SELECT right('hello world', 5);                 -- 'world'

-- Position / find
SELECT position('world' in 'hello world');  -- 7

-- Replace
SELECT replace('hello world', 'world', 'postgres');  -- 'hello postgres'

-- Split
SELECT string_to_array('a,b,c', ',');   -- {a,b,c}
SELECT split_part('a.b.c', '.', 2);     -- 'b'

-- Format (safe string building)
SELECT format('Hello %s, you have %s orders', 'Alice', 42);
-- 'Hello Alice, you have 42 orders'
```

### Date/Time Functions

```sql
-- Current time
SELECT now();                  -- current timestamp with timezone
SELECT CURRENT_TIMESTAMP;      -- same as now()
SELECT CURRENT_DATE;           -- current date only
SELECT CURRENT_TIME;           -- current time only

-- Extracting parts
SELECT EXTRACT(YEAR FROM now());       -- 2026
SELECT EXTRACT(MONTH FROM now());      -- 3
SELECT EXTRACT(DOW FROM now());        -- 5 (day of week, 0=Sunday)
SELECT EXTRACT(EPOCH FROM now());      -- Unix timestamp as decimal

-- Date truncation (rounding down to a unit)
SELECT date_trunc('month', now());     -- '2026-03-01 00:00:00+00'
SELECT date_trunc('hour', now());      -- '2026-03-20 14:00:00+00'
SELECT date_trunc('day', now());       -- '2026-03-20 00:00:00+00'

-- Date arithmetic
SELECT now() + INTERVAL '30 days';
SELECT now() - INTERVAL '2 hours';
SELECT '2024-06-15'::DATE + 14;        -- adds 14 days

-- Difference between dates
SELECT age('2026-03-20'::DATE, '2024-06-15'::DATE);  -- '1 year 9 mons 5 days'
SELECT '2026-03-20'::DATE - '2024-06-15'::DATE;      -- 644 (integer days)

-- Generate a series of dates (useful for reports with no gaps)
SELECT generate_series(
    '2024-01-01'::DATE,
    '2024-12-31'::DATE,
    '1 month'::INTERVAL
) AS month;
```

**The generate_series pattern for gapless time-series reports:**

```sql
-- Orders per day, including days with zero orders
SELECT
    d.day,
    COALESCE(COUNT(o.id), 0) AS order_count
FROM generate_series(
    '2024-06-01'::DATE,
    '2024-06-30'::DATE,
    '1 day'::INTERVAL
) AS d(day)
LEFT JOIN orders o ON date_trunc('day', o.created_at) = d.day
GROUP BY d.day
ORDER BY d.day;
```

### Math Functions

```sql
SELECT round(3.7);             -- 4
SELECT round(3.14159, 2);      -- 3.14
SELECT ceil(3.2);              -- 4
SELECT floor(3.8);             -- 3
SELECT abs(-42);               -- 42
SELECT greatest(10, 20, 30);   -- 30
SELECT least(10, 20, 30);      -- 10
SELECT random();               -- 0.0 to 1.0 (for sampling, not security)
```

---

## 4.11 Subqueries

A subquery is a query nested inside another query. They can appear in the SELECT list, FROM clause, or WHERE clause.

### Scalar Subqueries (Single Value)

```sql
-- In SELECT: add computed data
SELECT
    u.id,
    u.email,
    (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count
FROM users u;
```

**Warning:** This scalar subquery executes ONCE PER ROW in the outer query. For 10,000 users, it executes the COUNT 10,000 times. For small result sets this is fine. For large ones, a JOIN with GROUP BY is usually faster:

```sql
-- Better: single pass with JOIN
SELECT u.id, u.email, COALESCE(oc.order_count, 0) AS order_count
FROM users u
LEFT JOIN (
    SELECT user_id, COUNT(*) AS order_count
    FROM orders
    GROUP BY user_id
) oc ON u.id = oc.user_id;
```

### Subqueries in FROM (Derived Tables)

```sql
-- Calculate order statistics, then filter
SELECT * FROM (
    SELECT
        user_id,
        COUNT(*) AS order_count,
        SUM(total_cents) AS total_spent
    FROM orders
    GROUP BY user_id
) user_stats
WHERE total_spent > 100000
ORDER BY total_spent DESC;
```

### Correlated vs Non-Correlated Subqueries

**Non-correlated:** The subquery is independent — it runs once and the result is reused.
```sql
-- The subquery runs once, returns a single value
SELECT * FROM orders WHERE total_cents > (SELECT AVG(total_cents) FROM orders);
```

**Correlated:** The subquery references the outer query — it runs once per outer row.
```sql
-- For each user, find orders above that user's average
SELECT o.* FROM orders o
WHERE o.total_cents > (
    SELECT AVG(o2.total_cents) FROM orders o2 WHERE o2.user_id = o.user_id
);
```

Correlated subqueries are often slow because they execute per row. The planner sometimes transforms them into joins, but not always. If performance is an issue, rewrite as a JOIN:

```sql
-- Rewritten: single pass, no per-row subquery
SELECT o.* FROM orders o
JOIN (
    SELECT user_id, AVG(total_cents) AS avg_cents FROM orders GROUP BY user_id
) ua ON o.user_id = ua.user_id
WHERE o.total_cents > ua.avg_cents;
```

### Subqueries vs JOINs — When to Use Which

| Use Subquery When | Use JOIN When |
|---|---|
| You need a single value (scalar subquery) | You need columns from multiple tables |
| EXISTS/NOT EXISTS check | Many-to-many or one-to-many with multiple output rows |
| The subquery result is used for filtering only | The subquery result is part of the output |
| Readability is better with a subquery | Performance requires a join-based plan |

The planner often rewrites subqueries into joins internally, so the performance difference is often zero. Choose whichever is more readable.

---

## 4.12 Set Operations: UNION, INTERSECT, EXCEPT

Set operations combine the results of two or more queries.

### UNION

Combines results and removes duplicates (like DISTINCT):

```sql
-- All emails from both users and contacts (no duplicates)
SELECT email FROM users
UNION
SELECT email FROM contacts;
```

### UNION ALL

Combines results without removing duplicates (faster, no sort/hash needed):

```sql
-- All activity from two different tables (preserves duplicates)
SELECT 'order' AS source, id, created_at FROM orders
UNION ALL
SELECT 'payment' AS source, id, created_at FROM payments
ORDER BY created_at DESC
LIMIT 20;
```

**Rule: Always use UNION ALL unless you specifically need deduplication.** UNION (without ALL) requires PostgreSQL to sort or hash the entire result set to remove duplicates, which is expensive.

### INTERSECT

Returns rows that appear in BOTH queries:

```sql
-- Users who are both customers AND newsletter subscribers
SELECT email FROM users
INTERSECT
SELECT email FROM newsletter_subscribers;
```

### EXCEPT

Returns rows from the first query that do NOT appear in the second:

```sql
-- Users who are customers but NOT newsletter subscribers
SELECT email FROM users
EXCEPT
SELECT email FROM newsletter_subscribers;

-- Newsletter subscribers who are NOT registered users
SELECT email FROM newsletter_subscribers
EXCEPT
SELECT email FROM users;
```

### Rules for Set Operations

1. All queries must return the **same number of columns**
2. Corresponding columns must have **compatible types**
3. Column names come from the **first query**
4. `ORDER BY` applies to the **final combined result** (placed at the end)

```sql
-- Complex example: unified activity feed from multiple sources
(
    SELECT 'task_created' AS event_type, title AS description, created_at
    FROM tasks
    WHERE project_id = 42
)
UNION ALL
(
    SELECT 'comment_added', left(body, 100), created_at
    FROM comments
    WHERE task_id IN (SELECT id FROM tasks WHERE project_id = 42)
)
UNION ALL
(
    SELECT 'file_uploaded', filename, created_at
    FROM attachments
    WHERE task_id IN (SELECT id FROM tasks WHERE project_id = 42)
)
ORDER BY created_at DESC
LIMIT 50;
```

This pattern — unioning different entity types into a single feed — is the standard approach for building activity feeds in SQL.

---

→ next: chapter05_joins_in_depth.md
