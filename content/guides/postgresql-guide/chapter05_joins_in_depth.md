# Chapter 5 — Joins in Depth

## Table of Contents

- [5.1 How Joins Actually Work Under the Hood](#51-how-joins-actually-work-under-the-hood)
- [5.2 INNER JOIN](#52-inner-join)
- [5.3 LEFT JOIN and RIGHT JOIN](#53-left-join-and-right-join)
- [5.4 FULL OUTER JOIN](#54-full-outer-join)
- [5.5 CROSS JOIN](#55-cross-join)
- [5.6 Self Joins](#56-self-joins)
- [5.7 Multi-Table Joins](#57-multi-table-joins)
- [5.8 Join Conditions Beyond Equality](#58-join-conditions-beyond-equality)
- [5.9 Common Join Mistakes](#59-common-join-mistakes)
- [5.10 CTEs (WITH Clause)](#510-ctes-with-clause)
- [5.11 Recursive CTEs](#511-recursive-ctes)
- [5.12 Lateral Joins](#512-lateral-joins)
- [5.13 Full Complex Query Examples](#513-full-complex-query-examples)

---

## 5.1 How Joins Actually Work Under the Hood

When you write a JOIN, PostgreSQL doesn't have one magic algorithm. It chooses from three physical join strategies based on the data characteristics, available indexes, and estimated costs. Understanding these strategies helps you understand why some joins are fast and others are slow.

### Nested Loop Join

**Algorithm:** For each row in the outer table, scan the inner table and find matching rows.

```
for each row in outer_table:
    for each row in inner_table:
        if join_condition matches:
            emit combined row
```

**Cost:** O(N × M) in the worst case, where N and M are the row counts. But if the inner table has an index on the join column, the inner lookup is O(log M), making the total O(N × log M).

**When PostgreSQL uses it:**
- The outer table is small (hundreds or low thousands of rows)
- There's an index on the inner table's join column
- The join uses equality, range, or any indexable condition

**What it looks like in EXPLAIN:**
```
Nested Loop  (cost=0.43..1234.56 rows=100 width=80)
  -> Index Scan using idx_users_active on users  (cost=0.43..12.45 rows=10 width=40)
  -> Index Scan using idx_orders_user_id on orders  (cost=0.43..122.00 rows=10 width=40)
        Index Cond: (user_id = users.id)
```

### Hash Join

**Algorithm:** Build a hash table from the smaller table, then probe it with rows from the larger table.

```
hash_table = build hash table from smaller_table on join key
for each row in larger_table:
    look up row's join key in hash_table
    if found:
        emit combined row
```

**Cost:** O(N + M) — one pass to build the hash table, one pass to probe it. Very fast, but requires enough memory (`work_mem`) to hold the hash table.

**When PostgreSQL uses it:**
- Both tables are large
- No useful index on the join column
- The join uses equality (hash joins don't support range conditions)

**What it looks like in EXPLAIN:**
```
Hash Join  (cost=1500.00..5000.00 rows=50000 width=80)
  Hash Cond: (orders.user_id = users.id)
  -> Seq Scan on orders  (cost=0.00..3000.00 rows=100000 width=40)
  -> Hash  (cost=1000.00..1000.00 rows=50000 width=40)
        -> Seq Scan on users  (cost=0.00..1000.00 rows=50000 width=40)
```

### Merge Join

**Algorithm:** Sort both tables on the join key, then merge them by walking through both sorted lists simultaneously.

```
sort outer_table by join key
sort inner_table by join key
merge both sorted lists, emitting matches
```

**Cost:** O(N log N + M log M) for the sorts, then O(N + M) for the merge. If both inputs are already sorted (from an index), the sort cost is zero and this is extremely efficient.

**When PostgreSQL uses it:**
- Both tables are large
- Both are already sorted on the join key (index order) or a sort is cheap
- The join uses equality or inequality comparisons

**What it looks like in EXPLAIN:**
```
Merge Join  (cost=0.86..5000.00 rows=50000 width=80)
  Merge Cond: (users.id = orders.user_id)
  -> Index Scan using users_pkey on users  (cost=0.43..2000.00 rows=50000 width=40)
  -> Index Scan using idx_orders_user_id on orders  (cost=0.43..3000.00 rows=100000 width=40)
```

### Summary: Which Join Strategy Wins?

| Strategy | Best When | Requires | Supports |
|---|---|---|---|
| Nested Loop | Small outer, indexed inner | Index on inner join column | Any condition |
| Hash Join | Large tables, no index | Enough `work_mem` for hash table | Equality only |
| Merge Join | Large tables, pre-sorted | Sorted inputs (indexes) | Equality, inequality |

You don't choose the strategy — the planner does. But you influence its choice by:
- Creating indexes on join columns (enables nested loop and merge join)
- Increasing `work_mem` (enables larger hash tables)
- Ensuring statistics are current (accurate row estimates → correct strategy choice)

---

## 5.2 INNER JOIN

An INNER JOIN returns only rows where the join condition matches in both tables. Rows from either side that have no match are excluded.

```sql
-- All orders with their user information
-- Users without orders are excluded
-- Orders without a matching user are excluded (shouldn't happen with FK, but logically)
SELECT
    u.id AS user_id,
    u.email,
    o.id AS order_id,
    o.total_cents,
    o.created_at AS ordered_at
FROM users u
INNER JOIN orders o ON o.user_id = u.id;
```

`INNER JOIN` and `JOIN` are identical — the `INNER` keyword is optional. Most codebases omit it:

```sql
-- Same as above, more common style:
SELECT u.id, u.email, o.id AS order_id, o.total_cents
FROM users u
JOIN orders o ON o.user_id = u.id;
```

### When Rows Multiply

INNER JOIN can produce MORE rows than either input table. If one user has 5 orders, the user's row appears 5 times in the output (once per order). This is correct behavior, but it's a common source of confusion in aggregation:

```sql
-- BUG: this overcounts because the JOIN multiplies rows
SELECT u.id, u.email, COUNT(*) AS login_count
FROM users u
JOIN orders o ON o.user_id = u.id
JOIN login_events le ON le.user_id = u.id
GROUP BY u.id, u.email;
-- If a user has 5 orders and 10 logins, this produces 50 rows before GROUP BY,
-- making login_count = 50 instead of 10.

-- FIX: aggregate separately before joining, or use DISTINCT in the count
SELECT u.id, u.email, COUNT(DISTINCT le.id) AS login_count
FROM users u
JOIN orders o ON o.user_id = u.id
JOIN login_events le ON le.user_id = u.id
GROUP BY u.id, u.email;

-- BETTER FIX: Don't join if you don't need columns from the other table
SELECT u.id, u.email, COUNT(*) AS login_count
FROM users u
JOIN login_events le ON le.user_id = u.id
GROUP BY u.id, u.email;
```

---

## 5.3 LEFT JOIN and RIGHT JOIN

### LEFT JOIN (LEFT OUTER JOIN)

Returns ALL rows from the left table and matching rows from the right table. Where there's no match, the right side columns are NULL.

```sql
-- All users, with their orders if they have any
-- Users without orders still appear (order columns are NULL)
SELECT
    u.id AS user_id,
    u.email,
    o.id AS order_id,
    o.total_cents
FROM users u
LEFT JOIN orders o ON o.user_id = u.id;
```

Result:
```
 user_id | email              | order_id | total_cents
---------+--------------------+----------+-------------
       1 | alice@example.com  |      101 |        5000
       1 | alice@example.com  |      102 |        3000
       2 | bob@example.com    |      103 |        8000
       3 | carol@example.com  |     NULL |        NULL  ← no orders
```

### The "Find Missing" Pattern

LEFT JOIN + IS NULL is the standard pattern for finding rows that DON'T have related rows:

```sql
-- Users who have never placed an order
SELECT u.id, u.email
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE o.id IS NULL;
```

This is often more efficient than `NOT EXISTS` or `NOT IN`, especially on large tables, because the planner can use an anti-join optimization.

### RIGHT JOIN

RIGHT JOIN is the mirror of LEFT JOIN: ALL rows from the right table, matching rows from the left.

```sql
-- All orders, with user info if available
SELECT u.email, o.id AS order_id, o.total_cents
FROM users u
RIGHT JOIN orders o ON o.user_id = u.id;
```

**In practice, RIGHT JOIN is almost never used.** You can always rewrite a RIGHT JOIN as a LEFT JOIN by swapping the table order. LEFT JOIN is the universal convention because people read left-to-right:

```sql
-- Equivalent to the RIGHT JOIN above, but more readable:
SELECT u.email, o.id AS order_id, o.total_cents
FROM orders o
LEFT JOIN users u ON u.id = o.user_id;
```

### The Asymmetry of Outer Joins

The critical thing to understand: in a LEFT JOIN, the left table drives the result. Every row from the left table appears at least once. The right table is optional.

This asymmetry matters when you add WHERE conditions:

```sql
-- CORRECT: Filter on the LEFT (driving) table in WHERE
SELECT u.id, u.email, o.total_cents
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE u.is_active = TRUE;
-- Returns all active users, with their orders or NULL

-- BUG: Filter on the RIGHT (optional) table in WHERE
SELECT u.id, u.email, o.total_cents
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE o.status = 'shipped';
-- This ELIMINATES users without orders (o.status is NULL, which fails the WHERE)
-- It effectively turns the LEFT JOIN into an INNER JOIN!

-- CORRECT: Filter the right table in the ON clause, not WHERE
SELECT u.id, u.email, o.total_cents
FROM users u
LEFT JOIN orders o ON o.user_id = u.id AND o.status = 'shipped';
-- Returns all users. For those without shipped orders, o.total_cents is NULL.
```

**This is one of the most common join mistakes.** The rule: for a LEFT JOIN, conditions on the right (optional) table go in the ON clause. Conditions on the left (driving) table can go in either ON or WHERE.

---

## 5.4 FULL OUTER JOIN

Returns ALL rows from both tables. Where there's no match, the missing side is NULL.

```sql
-- Reconciliation: match up records from two sources
SELECT
    a.id AS accounting_id,
    a.amount AS accounting_amount,
    b.id AS banking_id,
    b.amount AS banking_amount
FROM accounting_entries a
FULL OUTER JOIN bank_transactions b
    ON a.reference_number = b.reference_number;
```

Result:
```
 accounting_id | accounting_amount | banking_id | banking_amount
---------------+-------------------+------------+----------------
           101 |           5000.00 |       1001 |        5000.00  ← matched
           102 |           3000.00 |       NULL |           NULL  ← in accounting only
          NULL |              NULL |       1002 |        2500.00  ← in bank only
```

```sql
-- Find unmatched records on either side
SELECT
    a.id AS accounting_id,
    b.id AS banking_id,
    COALESCE(a.amount, b.amount) AS amount
FROM accounting_entries a
FULL OUTER JOIN bank_transactions b
    ON a.reference_number = b.reference_number
WHERE a.id IS NULL OR b.id IS NULL;
-- Returns only the unmatched rows
```

FULL OUTER JOIN is rare in application code but common in data reconciliation, reporting, and migration scripts.

---

## 5.5 CROSS JOIN

A CROSS JOIN produces the **Cartesian product** — every row from the left table paired with every row from the right table. If the left has N rows and the right has M rows, the result has N × M rows.

```sql
-- Generate all combinations of sizes and colors
SELECT s.name AS size, c.name AS color
FROM sizes s
CROSS JOIN colors c;
```

If `sizes` has 4 rows (S, M, L, XL) and `colors` has 3 rows (Red, Blue, Green), the result has 12 rows.

**Intentional use cases:**
```sql
-- Generate a report grid: every month × every product category
SELECT
    m.month,
    c.name AS category,
    COALESCE(SUM(o.total_cents), 0) AS revenue
FROM generate_series('2024-01-01'::DATE, '2024-12-01'::DATE, '1 month') AS m(month)
CROSS JOIN categories c
LEFT JOIN orders o ON date_trunc('month', o.created_at) = m.month
    AND o.category_id = c.id
GROUP BY m.month, c.name
ORDER BY m.month, c.name;
```

**Accidental cross joins** are a common bug — see Section 5.9.

---

## 5.6 Self Joins

A self join is joining a table to itself. It's used when rows in a table are related to other rows in the same table.

### Organizational Hierarchy

```sql
-- Employees table with a manager reference (adjacency list)
CREATE TABLE employees (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL,
    manager_id BIGINT REFERENCES employees(id),
    department TEXT NOT NULL
);

-- Get each employee with their manager's name
SELECT
    e.name AS employee,
    e.department,
    m.name AS manager
FROM employees e
LEFT JOIN employees m ON e.manager_id = m.id;
-- LEFT JOIN because the CEO has no manager (manager_id IS NULL)
```

Result:
```
 employee  | department  | manager
-----------+-------------+----------
 Alice     | Engineering | NULL        ← CEO, no manager
 Bob       | Engineering | Alice
 Carol     | Marketing   | Alice
 Dave      | Engineering | Bob
```

### Finding Related Rows

```sql
-- Find pairs of users who share the same email domain
SELECT
    u1.email AS user1_email,
    u2.email AS user2_email
FROM users u1
JOIN users u2 ON split_part(u1.email, '@', 2) = split_part(u2.email, '@', 2)
WHERE u1.id < u2.id;  -- avoid duplicates (Alice,Bob) and (Bob,Alice), and self-pairs
```

### Friend/Follow Relationships

```sql
CREATE TABLE follows (
    follower_id BIGINT NOT NULL REFERENCES users(id),
    followed_id BIGINT NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (follower_id, followed_id),
    CONSTRAINT no_self_follow CHECK (follower_id != followed_id)
);

-- Find mutual follows (both follow each other)
SELECT f1.follower_id AS user_a, f1.followed_id AS user_b
FROM follows f1
JOIN follows f2 ON f1.follower_id = f2.followed_id
    AND f1.followed_id = f2.follower_id
WHERE f1.follower_id < f1.followed_id;  -- avoid duplicates

-- Friends of friends (people followed by people you follow)
SELECT DISTINCT f2.followed_id AS suggested_user
FROM follows f1
JOIN follows f2 ON f1.followed_id = f2.follower_id
WHERE f1.follower_id = 1                -- your user id
  AND f2.followed_id != 1               -- not yourself
  AND f2.followed_id NOT IN (           -- not people you already follow
      SELECT followed_id FROM follows WHERE follower_id = 1
  );
```

---

## 5.7 Multi-Table Joins

Joining 3, 4, or 5+ tables is common in production queries. The key is understanding the join order and ensuring each join is correctly connected.

```sql
-- Full order details: order + user + items + products
SELECT
    o.id AS order_id,
    u.email AS customer_email,
    p.name AS product_name,
    oi.quantity,
    oi.unit_price_cents,
    (oi.quantity * oi.unit_price_cents) AS line_total_cents,
    o.created_at AS order_date
FROM orders o
JOIN users u ON u.id = o.user_id
JOIN order_items oi ON oi.order_id = o.id
JOIN products p ON p.id = oi.product_id
WHERE o.status = 'shipped'
  AND o.created_at >= '2024-01-01'
ORDER BY o.created_at DESC;
```

### How the Planner Handles Multi-Table Joins

For N tables, there are N! (factorial) possible join orders. For 5 tables, that's 120 orderings. For 10 tables, it's 3.6 million. The planner uses dynamic programming or genetic algorithms (for very large numbers of tables) to find the best order.

The order matters because:
- Joining a small table first produces a small intermediate result, making the next join cheaper
- The planner may choose different strategies (nested loop, hash, merge) for different pairs

**Practical implication:** You don't control the physical join order by the order you write the JOINs. The planner reorders them. Write joins in the order that's most readable for humans.

For cases where the planner gets it wrong (rare), you can force join order with:
```sql
SET join_collapse_limit = 1;  -- prevents planner from reordering joins
```
But this is almost never needed or advisable.

### Multi-Table Join Pattern: Aggregation with Selective Joins

```sql
-- Dashboard: projects with task counts, broken down by status
SELECT
    p.id AS project_id,
    p.name AS project_name,
    COUNT(*) FILTER (WHERE t.status = 'open') AS open_tasks,
    COUNT(*) FILTER (WHERE t.status = 'in_progress') AS in_progress_tasks,
    COUNT(*) FILTER (WHERE t.status = 'done') AS done_tasks,
    COUNT(*) AS total_tasks
FROM projects p
LEFT JOIN tasks t ON t.project_id = p.id AND t.deleted_at IS NULL
WHERE p.organization_id = 42
  AND p.deleted_at IS NULL
GROUP BY p.id, p.name
ORDER BY p.name;
```

Note the `LEFT JOIN` — we want all projects, even those with zero tasks. The `t.deleted_at IS NULL` condition is in the ON clause, not WHERE, to preserve the LEFT JOIN behavior.

---

## 5.8 Join Conditions Beyond Equality

Most joins use equality (`ON a.id = b.a_id`), but joins can use any condition.

### Range Joins

```sql
-- Pricing tiers: find the tier for each order based on amount ranges
CREATE TABLE pricing_tiers (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL,
    min_cents BIGINT NOT NULL,
    max_cents BIGINT  -- NULL means no upper limit
);

INSERT INTO pricing_tiers (name, min_cents, max_cents) VALUES
('micro', 0, 999),
('basic', 1000, 4999),
('standard', 5000, 19999),
('premium', 20000, NULL);

-- Join each order to its pricing tier
SELECT
    o.id AS order_id,
    o.total_cents,
    pt.name AS tier
FROM orders o
JOIN pricing_tiers pt
    ON o.total_cents >= pt.min_cents
    AND (o.total_cents <= pt.max_cents OR pt.max_cents IS NULL);
```

### Temporal Joins (Point-in-Time)

```sql
-- Find the exchange rate that was active at the time of each transaction
CREATE TABLE exchange_rates (
    currency TEXT NOT NULL,
    rate NUMERIC(12,6) NOT NULL,
    effective_from TIMESTAMPTZ NOT NULL,
    effective_to TIMESTAMPTZ,
    PRIMARY KEY (currency, effective_from)
);

SELECT
    t.id AS transaction_id,
    t.amount,
    t.currency,
    t.created_at,
    er.rate AS exchange_rate,
    (t.amount * er.rate)::NUMERIC(12,2) AS usd_amount
FROM transactions t
JOIN exchange_rates er
    ON t.currency = er.currency
    AND t.created_at >= er.effective_from
    AND (t.created_at < er.effective_to OR er.effective_to IS NULL);
```

### Inequality Joins

```sql
-- Find all employees who earn more than their manager
SELECT
    e.name AS employee,
    e.salary AS employee_salary,
    m.name AS manager,
    m.salary AS manager_salary
FROM employees e
JOIN employees m ON e.manager_id = m.id
WHERE e.salary > m.salary;
```

---

## 5.9 Common Join Mistakes

### Mistake 1: Accidental Cartesian Product

Forgetting a join condition produces a cross join:

```sql
-- BUG: Missing ON clause — every user paired with every order
SELECT u.email, o.id
FROM users u, orders o;
-- If 1000 users and 10000 orders → 10,000,000 rows!

-- CORRECT:
SELECT u.email, o.id
FROM users u
JOIN orders o ON o.user_id = u.id;
```

The comma syntax (`FROM a, b WHERE a.id = b.a_id`) is legacy SQL. Always use explicit JOIN syntax, which makes missing join conditions obvious.

### Mistake 2: Filtering the Optional Side of a LEFT JOIN in WHERE

Already covered in Section 5.3 but worth repeating because it's so common:

```sql
-- BUG: Turns LEFT JOIN into INNER JOIN
SELECT u.email, o.status
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE o.status = 'shipped';
-- Users without orders are excluded because o.status is NULL, which fails the WHERE

-- FIX: Move the condition to ON
SELECT u.email, o.status
FROM users u
LEFT JOIN orders o ON o.user_id = u.id AND o.status = 'shipped';
-- Users without shipped orders appear with o.status = NULL
```

### Mistake 3: Row Multiplication in Aggregation

```sql
-- BUG: Joining two one-to-many relationships multiplies counts
SELECT
    u.id,
    COUNT(o.id) AS order_count,      -- WRONG: inflated by payments
    COUNT(p.id) AS payment_count     -- WRONG: inflated by orders
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
LEFT JOIN payments p ON p.user_id = u.id
GROUP BY u.id;
-- A user with 5 orders and 3 payments produces 15 rows (5×3)
-- order_count = 15, payment_count = 15. Both wrong!

-- FIX 1: Use COUNT(DISTINCT ...)
SELECT
    u.id,
    COUNT(DISTINCT o.id) AS order_count,
    COUNT(DISTINCT p.id) AS payment_count
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
LEFT JOIN payments p ON p.user_id = u.id
GROUP BY u.id;

-- FIX 2 (better): Pre-aggregate, then join
SELECT
    u.id,
    COALESCE(oc.cnt, 0) AS order_count,
    COALESCE(pc.cnt, 0) AS payment_count
FROM users u
LEFT JOIN (SELECT user_id, COUNT(*) AS cnt FROM orders GROUP BY user_id) oc
    ON oc.user_id = u.id
LEFT JOIN (SELECT user_id, COUNT(*) AS cnt FROM payments GROUP BY user_id) pc
    ON pc.user_id = u.id;
```

Fix 2 is generally better because it avoids the N×M row explosion entirely.

### Mistake 4: Joining on the Wrong Column

```sql
-- BUG: Subtle typo — joining on id instead of user_id
SELECT u.email, o.total_cents
FROM users u
JOIN orders o ON o.id = u.id;
-- This joins where the order's PK equals the user's PK
-- It happens to "work" but returns completely wrong data

-- CORRECT:
SELECT u.email, o.total_cents
FROM users u
JOIN orders o ON o.user_id = u.id;
```

This is especially dangerous because it doesn't produce an error — it just returns wrong results silently. Review join conditions carefully.

---

## 5.10 CTEs (WITH Clause)

A CTE (Common Table Expression) defines a named temporary result set that you can reference within a larger query. Think of it as a temporary view that exists only for one statement.

```sql
-- CTE: readable, named intermediate result
WITH active_users AS (
    SELECT id, email, display_name
    FROM users
    WHERE is_active = TRUE
      AND last_login_at >= now() - INTERVAL '90 days'
),
user_order_stats AS (
    SELECT
        user_id,
        COUNT(*) AS order_count,
        SUM(total_cents) AS total_spent_cents
    FROM orders
    WHERE status != 'cancelled'
    GROUP BY user_id
)
SELECT
    au.email,
    au.display_name,
    COALESCE(uos.order_count, 0) AS order_count,
    COALESCE(uos.total_spent_cents, 0) AS total_spent_cents
FROM active_users au
LEFT JOIN user_order_stats uos ON uos.user_id = au.id
ORDER BY uos.total_spent_cents DESC NULLS LAST;
```

### CTEs vs Subqueries

CTEs and subqueries are often interchangeable. The choice is about readability:

```sql
-- Subquery version (same result, less readable for complex queries)
SELECT
    au.email,
    au.display_name,
    COALESCE(uos.order_count, 0) AS order_count
FROM (
    SELECT id, email, display_name
    FROM users
    WHERE is_active = TRUE AND last_login_at >= now() - INTERVAL '90 days'
) au
LEFT JOIN (
    SELECT user_id, COUNT(*) AS order_count
    FROM orders WHERE status != 'cancelled'
    GROUP BY user_id
) uos ON uos.user_id = au.id;
```

### CTE Optimization Behavior

In PostgreSQL 12+, CTEs that are referenced only once and have no side effects are **inlined** (optimized as if they were subqueries). This means there's usually no performance difference between CTEs and subqueries.

CTEs that are referenced multiple times or have side effects (like INSERT/UPDATE/DELETE in a CTE) are **materialized** — executed once and stored in a temporary buffer. You can control this explicitly:

```sql
-- Force materialization (useful if the CTE is expensive and referenced multiple times)
WITH expensive_calculation AS MATERIALIZED (
    SELECT user_id, complex_function(data) AS result
    FROM large_table
    WHERE condition
)
SELECT * FROM expensive_calculation WHERE result > 100
UNION ALL
SELECT * FROM expensive_calculation WHERE result < 50;

-- Force inlining (for optimization)
WITH simple_filter AS NOT MATERIALIZED (
    SELECT * FROM users WHERE is_active = TRUE
)
SELECT * FROM simple_filter WHERE email LIKE 'a%';
```

### Data-Modifying CTEs

CTEs can contain INSERT, UPDATE, DELETE, and the results can be used in the main query:

```sql
-- Archive old orders and return what was archived
WITH archived AS (
    DELETE FROM orders
    WHERE status = 'delivered' AND created_at < now() - INTERVAL '2 years'
    RETURNING *
)
INSERT INTO orders_archive
SELECT * FROM archived;

-- Upsert pattern: insert or update, return the result
WITH new_setting AS (
    INSERT INTO user_settings (user_id, key, value)
    VALUES (42, 'theme', 'dark')
    ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value
    RETURNING *
)
SELECT * FROM new_setting;
```

---

## 5.11 Recursive CTEs

Recursive CTEs are PostgreSQL's mechanism for traversing hierarchical or graph data in SQL. They're one of the most powerful features and are essential for working with tree structures.

### Anatomy of a Recursive CTE

```sql
WITH RECURSIVE cte_name AS (
    -- Base case: the starting point (non-recursive term)
    SELECT ... FROM ... WHERE ...

    UNION ALL

    -- Recursive case: references the CTE itself
    SELECT ... FROM ... JOIN cte_name ON ...
)
SELECT * FROM cte_name;
```

Execution:
1. Execute the base case → Result set R0
2. Execute the recursive case using R0 as input → Result set R1
3. Execute the recursive case using R1 as input → Result set R2
4. Continue until the recursive case returns no new rows
5. Final result = R0 ∪ R1 ∪ R2 ∪ ... (UNION ALL concatenation)

### Example: Organizational Chart (Full Tree Traversal)

```sql
-- Find the entire reporting chain under a manager
WITH RECURSIVE team_tree AS (
    -- Base case: the manager
    SELECT id, name, manager_id, 0 AS depth, ARRAY[name] AS path
    FROM employees
    WHERE id = 1  -- start from employee 1

    UNION ALL

    -- Recursive case: employees who report to someone already in the tree
    SELECT e.id, e.name, e.manager_id, tt.depth + 1, tt.path || e.name
    FROM employees e
    JOIN team_tree tt ON e.manager_id = tt.id
)
SELECT
    repeat('  ', depth) || name AS org_chart,
    depth,
    path
FROM team_tree
ORDER BY path;
```

Result:
```
 org_chart          | depth | path
--------------------+-------+-------------------------------
 Alice              |     0 | {Alice}
   Bob              |     1 | {Alice,Bob}
     Dave           |     2 | {Alice,Bob,Dave}
     Eve            |     2 | {Alice,Bob,Eve}
   Carol            |     1 | {Alice,Carol}
     Frank          |     2 | {Alice,Carol,Frank}
```

### Example: Finding All Ancestors (Walk Up the Tree)

```sql
-- Find all managers above a given employee
WITH RECURSIVE management_chain AS (
    -- Base: start with the employee
    SELECT id, name, manager_id, 0 AS distance
    FROM employees
    WHERE id = 42

    UNION ALL

    -- Recursive: go to each person's manager
    SELECT e.id, e.name, e.manager_id, mc.distance + 1
    FROM employees e
    JOIN management_chain mc ON e.id = mc.manager_id
)
SELECT * FROM management_chain WHERE distance > 0
ORDER BY distance;
```

### Example: Bill of Materials (Parts Explosion)

```sql
CREATE TABLE parts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE TABLE assemblies (
    parent_part_id BIGINT NOT NULL REFERENCES parts(id),
    child_part_id BIGINT NOT NULL REFERENCES parts(id),
    quantity INTEGER NOT NULL,
    PRIMARY KEY (parent_part_id, child_part_id)
);

-- Find all component parts (and sub-parts) needed to build part 1
WITH RECURSIVE bom AS (
    -- Base: direct components
    SELECT child_part_id, quantity, 1 AS level
    FROM assemblies
    WHERE parent_part_id = 1

    UNION ALL

    -- Recursive: sub-components of components
    SELECT a.child_part_id, a.quantity * bom.quantity, bom.level + 1
    FROM assemblies a
    JOIN bom ON a.parent_part_id = bom.child_part_id
)
SELECT
    p.name AS part_name,
    SUM(bom.quantity) AS total_quantity_needed
FROM bom
JOIN parts p ON p.id = bom.child_part_id
GROUP BY p.name
ORDER BY total_quantity_needed DESC;
```

### Cycle Detection

If your data has cycles (a graph, not a tree), a recursive CTE will loop forever. PostgreSQL 14+ has built-in cycle detection:

```sql
-- PostgreSQL 14+ cycle detection
WITH RECURSIVE traversal AS (
    SELECT id, name, next_id
    FROM nodes
    WHERE id = 1

    UNION ALL

    SELECT n.id, n.name, n.next_id
    FROM nodes n
    JOIN traversal t ON n.id = t.next_id
)
CYCLE id SET is_cycle USING path_array
SELECT * FROM traversal WHERE NOT is_cycle;
```

For older PostgreSQL versions, track visited nodes manually:

```sql
WITH RECURSIVE traversal AS (
    SELECT id, name, next_id, ARRAY[id] AS visited, FALSE AS is_cycle
    FROM nodes
    WHERE id = 1

    UNION ALL

    SELECT n.id, n.name, n.next_id, t.visited || n.id, n.id = ANY(t.visited)
    FROM nodes n
    JOIN traversal t ON n.id = t.next_id
    WHERE NOT t.is_cycle
)
SELECT * FROM traversal WHERE NOT is_cycle;
```

### Limiting Recursion Depth

To prevent runaway recursion:

```sql
WITH RECURSIVE tree AS (
    SELECT id, parent_id, name, 0 AS depth FROM categories WHERE parent_id IS NULL
    UNION ALL
    SELECT c.id, c.parent_id, c.name, t.depth + 1
    FROM categories c JOIN tree t ON c.parent_id = t.id
    WHERE t.depth < 10  -- stop at depth 10
)
SELECT * FROM tree;
```

---

## 5.12 Lateral Joins

`LATERAL` is one of PostgreSQL's most powerful and underused features. A LATERAL join allows the subquery on the right side to reference columns from the left side — something a normal subquery in FROM cannot do.

### The Problem LATERAL Solves

Suppose you want the 3 most recent orders for each user. Without LATERAL:

```sql
-- Approach 1: Window function + filter (works but reads all orders)
SELECT * FROM (
    SELECT
        u.id AS user_id,
        u.email,
        o.id AS order_id,
        o.total_cents,
        o.created_at,
        ROW_NUMBER() OVER (PARTITION BY u.id ORDER BY o.created_at DESC) AS rn
    FROM users u
    LEFT JOIN orders o ON o.user_id = u.id
) ranked
WHERE rn <= 3;
-- Problem: this computes ROW_NUMBER for ALL orders, then filters.
-- On a table with 10 million orders, it processes all 10 million.
```

### With LATERAL

```sql
SELECT
    u.id AS user_id,
    u.email,
    recent_orders.*
FROM users u
LEFT JOIN LATERAL (
    SELECT o.id AS order_id, o.total_cents, o.created_at
    FROM orders o
    WHERE o.user_id = u.id  -- references u.id from the outer query!
    ORDER BY o.created_at DESC
    LIMIT 3
) recent_orders ON TRUE
WHERE u.is_active = TRUE;
```

**How it works:** For each row in `users`, PostgreSQL executes the LATERAL subquery with that user's `id`. The subquery can reference `u.id` because of the LATERAL keyword. This is like a correlated subquery but in the FROM clause, returning multiple columns and multiple rows.

**Why it's efficient:** With an index on `orders(user_id, created_at DESC)`, each LATERAL execution is an index scan that reads exactly 3 rows. For 1000 active users, that's 1000 fast index lookups instead of one scan of the entire orders table.

### LATERAL Use Cases

**Top-N per group (the most common use):**
```sql
-- Top 5 products per category by revenue
SELECT c.name AS category, top.*
FROM categories c
LEFT JOIN LATERAL (
    SELECT p.name, p.price_cents,
           SUM(oi.quantity) AS units_sold
    FROM products p
    JOIN order_items oi ON oi.product_id = p.id
    WHERE p.category_id = c.id
    GROUP BY p.id, p.name, p.price_cents
    ORDER BY units_sold DESC
    LIMIT 5
) top ON TRUE;
```

**Dependent data lookup:**
```sql
-- For each event, look up the nearest preceding snapshot
SELECT
    e.id AS event_id,
    e.created_at,
    snapshot.*
FROM events e
LEFT JOIN LATERAL (
    SELECT s.id AS snapshot_id, s.data, s.created_at AS snapshot_time
    FROM snapshots s
    WHERE s.entity_id = e.entity_id
      AND s.created_at <= e.created_at
    ORDER BY s.created_at DESC
    LIMIT 1
) snapshot ON TRUE;
```

**Unnesting with extra data:**
```sql
-- Expand a JSONB array and join each element back to related data
SELECT
    o.id AS order_id,
    item_data.*
FROM orders o
LEFT JOIN LATERAL jsonb_array_elements(o.line_items) AS item_elem ON TRUE
LEFT JOIN LATERAL (
    SELECT
        item_elem ->> 'product_id' AS product_id,
        (item_elem ->> 'quantity')::INTEGER AS quantity,
        p.name AS product_name
    FROM products p
    WHERE p.id = (item_elem ->> 'product_id')::BIGINT
) item_data ON TRUE;
```

### LATERAL vs Correlated Subqueries in SELECT

```sql
-- Correlated subquery in SELECT: can only return ONE value
SELECT
    u.id,
    (SELECT COUNT(*) FROM orders WHERE user_id = u.id) AS order_count
FROM users u;

-- LATERAL: can return multiple columns and multiple rows
SELECT u.id, lo.*
FROM users u
LEFT JOIN LATERAL (
    SELECT COUNT(*) AS order_count,
           SUM(total_cents) AS total_spent,
           MAX(created_at) AS last_order
    FROM orders WHERE user_id = u.id
) lo ON TRUE;
-- One subquery execution returns three values
```

---

## 5.13 Full Complex Query Examples

These are the kinds of queries senior engineers write in production. Each one combines multiple concepts from this chapter and previous chapters.

### Example 1: Dashboard Query — Project Overview with Aggregated Task Stats

```sql
WITH task_stats AS (
    SELECT
        project_id,
        COUNT(*) AS total_tasks,
        COUNT(*) FILTER (WHERE status = 'done') AS completed_tasks,
        COUNT(*) FILTER (WHERE status = 'in_progress') AS active_tasks,
        COUNT(*) FILTER (WHERE due_date < CURRENT_DATE AND status NOT IN ('done', 'closed'))
            AS overdue_tasks,
        MIN(created_at) AS first_task_at,
        MAX(updated_at) AS last_activity_at
    FROM tasks
    WHERE deleted_at IS NULL
    GROUP BY project_id
)
SELECT
    p.external_id,
    p.name AS project_name,
    u.display_name AS created_by,
    p.created_at,
    COALESCE(ts.total_tasks, 0) AS total_tasks,
    COALESCE(ts.completed_tasks, 0) AS completed_tasks,
    COALESCE(ts.active_tasks, 0) AS active_tasks,
    COALESCE(ts.overdue_tasks, 0) AS overdue_tasks,
    CASE
        WHEN ts.total_tasks > 0
        THEN round(100.0 * ts.completed_tasks / ts.total_tasks, 1)
        ELSE 0
    END AS completion_percentage,
    ts.last_activity_at
FROM projects p
JOIN users u ON u.id = p.created_by
LEFT JOIN task_stats ts ON ts.project_id = p.id
WHERE p.organization_id = $1
  AND p.deleted_at IS NULL
ORDER BY ts.last_activity_at DESC NULLS LAST;
```

### Example 2: Activity Feed with Polymorphic Data

```sql
-- Unified activity feed combining different action types
WITH recent_activities AS (
    SELECT
        a.id,
        a.action,
        a.target_type,
        a.target_id,
        a.metadata,
        a.created_at,
        u.display_name AS actor_name,
        u.avatar_url AS actor_avatar
    FROM activities a
    JOIN users u ON u.id = a.actor_id
    WHERE a.organization_id = $1
      AND a.project_id = $2
      AND a.created_at >= now() - INTERVAL '7 days'
    ORDER BY a.created_at DESC
    LIMIT 50
)
SELECT
    ra.*,
    CASE ra.target_type
        WHEN 'task' THEN t.title
        WHEN 'comment' THEN left(c.body, 100)
        WHEN 'attachment' THEN att.filename
    END AS target_description
FROM recent_activities ra
LEFT JOIN tasks t ON ra.target_type = 'task' AND t.id = ra.target_id
LEFT JOIN comments c ON ra.target_type = 'comment' AND c.id = ra.target_id
LEFT JOIN attachments att ON ra.target_type = 'attachment' AND att.id = ra.target_id
ORDER BY ra.created_at DESC;
```

### Example 3: Leaderboard with Ranking, Ties, and Previous Period Comparison

```sql
WITH current_period AS (
    SELECT
        user_id,
        COUNT(*) AS tasks_completed,
        SUM(estimated_hours) AS hours_logged
    FROM tasks
    WHERE status = 'done'
      AND completed_at >= date_trunc('month', CURRENT_DATE)
      AND completed_at < date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
      AND organization_id = $1
    GROUP BY user_id
),
previous_period AS (
    SELECT
        user_id,
        COUNT(*) AS tasks_completed
    FROM tasks
    WHERE status = 'done'
      AND completed_at >= date_trunc('month', CURRENT_DATE) - INTERVAL '1 month'
      AND completed_at < date_trunc('month', CURRENT_DATE)
      AND organization_id = $1
    GROUP BY user_id
)
SELECT
    u.display_name,
    u.avatar_url,
    cp.tasks_completed,
    COALESCE(cp.hours_logged, 0) AS hours_logged,
    DENSE_RANK() OVER (ORDER BY cp.tasks_completed DESC) AS rank,
    cp.tasks_completed - COALESCE(pp.tasks_completed, 0) AS change_from_last_month
FROM current_period cp
JOIN users u ON u.id = cp.user_id
LEFT JOIN previous_period pp ON pp.user_id = cp.user_id
ORDER BY cp.tasks_completed DESC
LIMIT 20;
```

### Example 4: Search with Relevance Scoring

```sql
-- Search tasks by keyword with relevance ranking
-- Matches in title score higher than matches in description
SELECT
    t.external_id,
    t.title,
    left(t.description, 200) AS description_preview,
    p.name AS project_name,
    t.status,
    assigned_user.display_name AS assigned_to,
    t.created_at,
    -- Relevance score: title matches worth more
    (CASE WHEN t.title ILIKE '%' || $2 || '%' THEN 10 ELSE 0 END
     + CASE WHEN t.description ILIKE '%' || $2 || '%' THEN 3 ELSE 0 END
     + CASE WHEN t.status = 'open' THEN 2 ELSE 0 END
     + CASE WHEN t.status = 'in_progress' THEN 1 ELSE 0 END
    ) AS relevance
FROM tasks t
JOIN projects p ON p.id = t.project_id
LEFT JOIN users assigned_user ON assigned_user.id = t.assigned_to
WHERE t.organization_id = $1
  AND t.deleted_at IS NULL
  AND (t.title ILIKE '%' || $2 || '%' OR t.description ILIKE '%' || $2 || '%')
ORDER BY relevance DESC, t.updated_at DESC
LIMIT 20;
```

For production search, you'd use full-text search (Chapter 8) or a dedicated search engine for better relevance and performance. But this pattern works for small-to-medium datasets and demonstrates the scoring concept.

### Example 5: Recursive Task Dependencies

```sql
-- Find all tasks that block a given task (transitive dependencies)
CREATE TABLE task_dependencies (
    blocking_task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    blocked_task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (blocking_task_id, blocked_task_id),
    CONSTRAINT no_self_dependency CHECK (blocking_task_id != blocked_task_id)
);

-- Find all transitive blockers of task $1
WITH RECURSIVE all_blockers AS (
    -- Direct blockers
    SELECT blocking_task_id, 1 AS depth
    FROM task_dependencies
    WHERE blocked_task_id = $1

    UNION

    -- Blockers of blockers (UNION prevents cycles)
    SELECT td.blocking_task_id, ab.depth + 1
    FROM task_dependencies td
    JOIN all_blockers ab ON td.blocked_task_id = ab.blocking_task_id
    WHERE ab.depth < 20  -- safety limit
)
SELECT
    t.external_id,
    t.title,
    t.status,
    ab.depth AS dependency_distance
FROM all_blockers ab
JOIN tasks t ON t.id = ab.blocking_task_id
ORDER BY ab.depth, t.title;
```

Note the use of `UNION` (not `UNION ALL`) to prevent cycles — if task A blocks B and B blocks A, `UNION` deduplicates and the recursion terminates.

---

→ next: chapter06_indexes_and_performance.md
