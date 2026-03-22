# Chapter 3 — Schema Design & Data Modeling (Deep Dive)

## Table of Contents

- [3.1 What Schema Design Actually Means](#31-what-schema-design-actually-means)
- [3.2 Normalization — First Principles](#32-normalization--first-principles)
- [3.3 Denormalization — Breaking the Rules on Purpose](#33-denormalization--breaking-the-rules-on-purpose)
- [3.4 Primary Keys — The Identity of Every Row](#34-primary-keys--the-identity-of-every-row)
- [3.5 Foreign Keys — Enforcing Relationships](#35-foreign-keys--enforcing-relationships)
- [3.6 Constraints — The Database as Your Safety Net](#36-constraints--the-database-as-your-safety-net)
- [3.7 Common Schema Patterns Used in Production](#37-common-schema-patterns-used-in-production)
  - [3.7.1 Users and Authentication](#371-users-and-authentication)
  - [3.7.2 Multi-Tenancy](#372-multi-tenancy)
  - [3.7.3 Soft Deletes](#373-soft-deletes)
  - [3.7.4 Audit Logging](#374-audit-logging)
  - [3.7.5 Status / State Machines](#375-status--state-machines)
  - [3.7.6 Hierarchical Data](#376-hierarchical-data)
  - [3.7.7 Tagging Systems](#377-tagging-systems)
  - [3.7.8 Time-Series Data](#378-time-series-data)
- [3.8 Schema Versioning and Evolution](#38-schema-versioning-and-evolution)
- [3.9 Full Real-World Schema: Multi-Tenant SaaS Application](#39-full-real-world-schema-multi-tenant-saas-application)

---

## 3.1 What Schema Design Actually Means

Schema design is the process of deciding how your data is organized in the database: what tables exist, what columns they have, what types those columns use, what constraints enforce data integrity, and how tables relate to each other.

This is the single most impactful decision a backend engineer makes. A good schema:
- Prevents entire classes of bugs (duplicate data, orphaned records, invalid states)
- Makes common queries fast without exotic optimization
- Makes uncommon queries possible without rewriting the schema
- Evolves gracefully as requirements change
- Is understandable by every engineer who reads it

A bad schema:
- Forces you to write complex, slow queries to answer simple questions
- Allows invalid data that causes application bugs
- Requires expensive migrations to change
- Creates performance problems that no amount of indexing can fix

**The core tension in schema design is between normalization (eliminating redundancy for correctness) and denormalization (introducing controlled redundancy for performance).** Senior engineers don't dogmatically follow one approach — they make deliberate tradeoffs based on their specific workload.

---

## 3.2 Normalization — First Principles

Normalization is a set of rules (called "normal forms") that guide you in structuring tables to eliminate redundant data and prevent update anomalies. Let's build the intuition from scratch.

### The Problem: A Single Denormalized Table

Imagine you're building an e-commerce system and you start with one big table:

```sql
CREATE TABLE flat_orders (
    order_id INTEGER,
    order_date DATE,
    customer_name TEXT,
    customer_email TEXT,
    customer_address TEXT,
    product_name TEXT,
    product_price NUMERIC(10,2),
    quantity INTEGER
);

INSERT INTO flat_orders VALUES
(1, '2024-06-15', 'Alice', 'alice@example.com', '123 Main St', 'Widget', 29.99, 2),
(1, '2024-06-15', 'Alice', 'alice@example.com', '123 Main St', 'Gadget', 49.99, 1),
(2, '2024-06-16', 'Bob',   'bob@example.com',   '456 Oak Ave', 'Widget', 29.99, 5),
(3, '2024-06-17', 'Alice', 'alice@example.com', '123 Main St', 'Gizmo',  19.99, 3);
```

This table works — you can query it and get answers. But it has serious problems:

**Update anomaly**: If Alice changes her email, you must update EVERY row where she appears. Miss one row and now Alice has two different emails in your database. Which one is correct?

**Insertion anomaly**: You can't add a new product to your catalog without creating a fake order for it (because product information is tied to order rows).

**Deletion anomaly**: If you delete Alice's only order, you also lose the fact that Alice exists as a customer.

**Storage waste**: Alice's name, email, and address are repeated in every row of every order she places. That's wasted disk space, wasted I/O, and wasted memory.

Normalization eliminates these problems by splitting the data into separate tables with clear responsibilities.

### First Normal Form (1NF)

**Rule**: Every column must hold a single atomic value (no lists, no nested structures), and each row must be uniquely identifiable.

**Violation example:**
```
| order_id | products              |
|----------|-----------------------|
| 1        | Widget, Gadget        |  ← multiple values in one cell
```

**Fix**: One row per product:
```
| order_id | product    |
|----------|------------|
| 1        | Widget     |
| 1        | Gadget     |
```

In practice, PostgreSQL arrays technically violate 1NF but are acceptable when the array is treated as a single atomic value (like a list of tags) and you don't need to join or constrain individual elements. Pure 1NF would use a junction table. This is one of those places where theory and practice diverge.

### Second Normal Form (2NF)

**Rule**: Must be in 1NF, AND every non-key column must depend on the ENTIRE primary key, not just part of it.

This only matters when you have a **composite primary key** (a primary key made of multiple columns).

**Violation example:**

```sql
-- Primary key: (order_id, product_id)
-- product_name depends ONLY on product_id, not on the full (order_id, product_id)
CREATE TABLE order_items (
    order_id INTEGER,
    product_id INTEGER,
    product_name TEXT,       -- depends only on product_id → violates 2NF
    quantity INTEGER,        -- depends on (order_id, product_id) → fine
    PRIMARY KEY (order_id, product_id)
);
```

`product_name` depends only on `product_id` — it doesn't change based on which order it's in. This is a **partial dependency** on the primary key.

**Fix**: Move `product_name` to its own table keyed by `product_id`:

```sql
CREATE TABLE products (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE TABLE order_items (
    order_id INTEGER REFERENCES orders(id),
    product_id INTEGER REFERENCES products(id),
    quantity INTEGER NOT NULL,
    PRIMARY KEY (order_id, product_id)
);
```

### Third Normal Form (3NF)

**Rule**: Must be in 2NF, AND every non-key column must depend DIRECTLY on the primary key, not transitively through another non-key column.

**Violation example:**

```sql
CREATE TABLE employees (
    id INTEGER PRIMARY KEY,
    name TEXT,
    department_id INTEGER,
    department_name TEXT,    -- depends on department_id, not directly on employee id
    department_budget NUMERIC -- depends on department_id, not directly on employee id
);
```

`department_name` depends on `department_id`, which depends on `id`. This is a **transitive dependency**.

**Fix**: Move department info to its own table:

```sql
CREATE TABLE departments (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    budget NUMERIC(12,2)
);

CREATE TABLE employees (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    department_id INTEGER NOT NULL REFERENCES departments(id)
);
```

### Summary of Normal Forms

| Normal Form | Rule | Eliminates |
|---|---|---|
| 1NF | Atomic values, unique rows | Repeating groups |
| 2NF | No partial dependencies on composite keys | Partial key dependencies |
| 3NF | No transitive dependencies | Transitive dependencies |

**In practice, 3NF is the standard target for most application schemas.** Higher normal forms (BCNF, 4NF, 5NF) exist but are rarely explicitly targeted — if you reach 3NF, you've eliminated the vast majority of data anomalies.

### When NOT to Normalize

Normalization is not free. Every level of normalization adds JOINs. JOINs have a cost: they require more query planning, more I/O (reading from multiple tables), and more memory (hash tables or sort buffers for the join operation).

**Don't normalize when:**
- The denormalized data is read-only or rarely updated (no update anomalies to worry about)
- The JOIN cost is unacceptable for a hot query path
- The redundant data is derived and can be recalculated (e.g., a cached total)
- You're storing a historical snapshot (an order should store the price AT THE TIME OF PURCHASE, not a reference to the current price)

```sql
-- This denormalization is CORRECT:
CREATE TABLE order_items (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES orders(id),
    product_id BIGINT NOT NULL REFERENCES products(id),
    product_name TEXT NOT NULL,         -- snapshot at order time
    unit_price_cents BIGINT NOT NULL,   -- snapshot at order time
    quantity INTEGER NOT NULL CHECK (quantity > 0)
);
-- product_name and unit_price_cents are intentionally denormalized because
-- they represent the values AT THE TIME OF THE ORDER, not the current values.
-- If the product is renamed or the price changes, existing orders must not change.
```

---

## 3.3 Denormalization — Breaking the Rules on Purpose

Denormalization means intentionally introducing redundancy to improve read performance. Every large-scale system does this — the question is where and how.

### Types of Denormalization

**1. Storing computed values:**
```sql
ALTER TABLE orders ADD COLUMN item_count INTEGER;
ALTER TABLE orders ADD COLUMN total_cents BIGINT;

-- Kept in sync via trigger or application code
-- Avoids COUNT(*) and SUM() on order_items for every order list query
```

**2. Duplicating data from a related table:**
```sql
-- Storing the author's name directly on the post
-- to avoid joining the users table on every post listing
ALTER TABLE posts ADD COLUMN author_name TEXT;
```

**3. Materialized views** (a database-managed denormalization):
```sql
CREATE MATERIALIZED VIEW daily_order_stats AS
SELECT
    date_trunc('day', created_at) AS day,
    COUNT(*) AS order_count,
    SUM(total_cents) AS revenue_cents
FROM orders
GROUP BY 1;

-- Refreshed periodically
REFRESH MATERIALIZED VIEW CONCURRENTLY daily_order_stats;
```

### The Rules of Safe Denormalization

1. **Always keep the normalized source of truth.** The denormalized data is a cache. If it becomes inconsistent, you can always regenerate it from the normalized data.

2. **Document why the denormalization exists.** Future engineers need to understand that `posts.author_name` is an intentional cache, not the canonical source of the author's name.

3. **Define the consistency mechanism.** How is the denormalized data kept in sync? Options:
   - **Trigger**: Automatic, but adds write latency and complexity
   - **Application code**: Flexible, but can have bugs that cause inconsistency
   - **Periodic batch job**: Simple, but data is stale between runs
   - **Materialized view refresh**: Database-managed, but refresh has a cost

4. **Measure the actual impact.** Don't denormalize based on speculation. Measure the JOIN cost first. If the JOIN takes 2ms and your SLA is 200ms, the denormalization is premature.

### What Large Companies Actually Do

- **Read replicas**: Instead of denormalizing, route read-heavy queries to read replicas. The replica has the same schema but serves read traffic without impacting the primary's write performance.
- **Separate read models**: Use CQRS (Command Query Responsibility Segregation) — writes go to a normalized schema, reads go to a denormalized schema (often a materialized view or a separate data store like Elasticsearch).
- **Caching layer**: Cache the results of expensive JOINs in Redis or Memcached rather than denormalizing the schema.
- **Selective denormalization**: Denormalize only the specific columns needed for the hottest query paths. A display name that saves a JOIN on 10,000 QPS is worth it; a rarely-used field is not.

---

## 3.4 Primary Keys — The Identity of Every Row

Every table must have a primary key — a column (or set of columns) that uniquely identifies each row. The primary key is automatically `NOT NULL` and `UNIQUE`, and PostgreSQL creates a B-tree index on it.

### Natural Keys vs Surrogate Keys

A **natural key** is a value that inherently identifies the entity in the real world:
- A Social Security Number for a person
- An ISBN for a book
- An email address for a user account

A **surrogate key** is an artificial identifier with no business meaning:
- An auto-incrementing integer
- A UUID

**Senior engineers almost always use surrogate keys** because:

1. **Natural keys change.** People change their email. Companies change their tax ID. Books get new ISBNs for new editions. When a natural key changes, you must update it in EVERY table that references it via foreign keys. With a surrogate key, you update the `email` column in one row.

2. **Natural keys are often composite.** A "person" might need (first_name, last_name, date_of_birth, city) to be unique — an unwieldy composite key that every foreign key must also include.

3. **Natural keys are often strings.** Joining on `TEXT` columns is slower than joining on `BIGINT` columns. Indexes on strings are larger.

4. **Natural keys leak business information.** Using email as a primary key means every foreign key column in every related table contains an email address — more exposure surface for data leaks.

**When natural keys are appropriate:**
- Junction/association tables where the composite of the two foreign keys IS the natural key: `(user_id, role_id)`, `(article_id, tag_id)`
- Lookup/reference tables with stable codes: `(country_code)`, `(currency_code)`

### UUID vs BIGINT — The Primary Key Decision

We covered this in Chapter 2 (section 2.6). Here's the summary decision framework:

| Factor | BIGINT | UUID |
|---|---|---|
| Storage per key | 8 bytes | 16 bytes |
| Index performance | Excellent (sequential, compact) | Good with UUIDv7, poor with random UUIDv4 |
| Generation | Requires database sequence | Can be generated anywhere (app, client, offline) |
| Information leakage | Exposes ordering and count | Opaque |
| Distributed systems | Requires central sequence or coordination | No coordination needed |
| Debugging | Easy ("check order 42") | Cumbersome ("check order a0ee...380a") |

**The production pattern used at many companies:**

```sql
CREATE TABLE orders (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    external_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    -- internal queries use id (fast, compact)
    -- API responses expose external_id (secure, globally unique)
    ...
);
```

### Composite Primary Keys

A composite primary key consists of multiple columns:

```sql
CREATE TABLE enrollments (
    student_id BIGINT NOT NULL REFERENCES students(id),
    course_id BIGINT NOT NULL REFERENCES courses(id),
    enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    grade TEXT,
    PRIMARY KEY (student_id, course_id)
);
```

This enforces that a student can only be enrolled in a course once. It also creates an index on `(student_id, course_id)`.

**When to use composite primary keys:**
- Junction/association tables (many-to-many relationships)
- Tables where the combination of columns IS the natural identity
- When you want the database to enforce uniqueness of the combination

**When to avoid them:**
- When other tables need to reference this table — foreign keys to composite keys are verbose and error-prone
- When any component might change

If you need a composite uniqueness constraint but also want a simple surrogate key for foreign key references:

```sql
CREATE TABLE enrollments (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    student_id BIGINT NOT NULL REFERENCES students(id),
    course_id BIGINT NOT NULL REFERENCES courses(id),
    enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    grade TEXT,
    UNIQUE (student_id, course_id)
);
-- Other tables can reference enrollments(id) simply
-- The UNIQUE constraint still prevents duplicate enrollments
```

---

## 3.5 Foreign Keys — Enforcing Relationships

Foreign keys are constraints that ensure a value in one table corresponds to an existing row in another table. They are the backbone of relational integrity.

### Basic Foreign Key

```sql
CREATE TABLE orders (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

This means: every value in `orders.user_id` must correspond to an existing `users.id`. PostgreSQL will reject:
- Inserting an order with a `user_id` that doesn't exist in `users`
- Deleting a user who has orders (depending on the cascade behavior)

### Cascade Behaviors

What happens when the referenced row (the "parent") is deleted or updated?

```sql
CREATE TABLE orders (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- If the user is deleted, delete all their orders too
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- If the coupon is deleted, set this field to NULL
    coupon_id BIGINT REFERENCES coupons(id) ON DELETE SET NULL,

    -- If the shipping method is deleted, prevent deletion (default behavior)
    shipping_method_id BIGINT NOT NULL REFERENCES shipping_methods(id) ON DELETE RESTRICT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

| Behavior | Effect | Use When |
|---|---|---|
| `RESTRICT` (default) | Prevents deleting the parent if children exist | Child data is important and should not be silently orphaned |
| `CASCADE` | Deletes all children when parent is deleted | Children have no meaning without the parent (order items when order is deleted) |
| `SET NULL` | Sets the FK column to NULL when parent is deleted | The relationship is optional (the coupon was deleted but the order is still valid) |
| `SET DEFAULT` | Sets the FK column to its DEFAULT when parent is deleted | Rare; reassigns to a default parent |
| `NO ACTION` | Like RESTRICT but check is deferred to end of transaction | Needed when you're deleting interdependent rows within a transaction |

The same options exist for `ON UPDATE` (when the parent's primary key is updated), but updating primary keys is extremely rare and generally a design smell.

### Foreign Key Performance Implications

Foreign keys have a real performance cost:

1. **On INSERT/UPDATE of the child**: PostgreSQL must check that the referenced parent row exists. This requires a lookup on the parent table's primary key index. For high-throughput inserts, this adds measurable latency.

2. **On DELETE/UPDATE of the parent**: PostgreSQL must check if any child rows reference this parent. Without an index on the foreign key column IN THE CHILD TABLE, this check requires a sequential scan of the child table.

**Critical production rule: Always create an index on foreign key columns in child tables.**

```sql
CREATE TABLE order_items (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price_cents BIGINT NOT NULL
);

-- CRITICAL: Index the foreign key columns
CREATE INDEX idx_order_items_order_id ON order_items (order_id);
CREATE INDEX idx_order_items_product_id ON order_items (product_id);
```

Without `idx_order_items_order_id`, deleting an order (which cascades to delete its items) requires a sequential scan of `order_items` to find the matching rows. With a million order items, that's painfully slow. With the index, it's a fast index lookup.

PostgreSQL does NOT automatically create indexes on foreign key columns (unlike some other databases). This is a deliberate design choice — not every FK column needs an index — but in practice, you almost always want one.

### The Foreign Key Debate at Scale

Some very high-scale teams (notable examples: Uber's migration away from PostgreSQL, some microservice architectures) choose to drop foreign keys for performance reasons. The arguments:

**Against FKs at scale:**
- Every INSERT pays the lookup cost
- Cascade deletes can cause unpredictable write amplification
- In microservice architectures, the referenced data might be in a different service's database

**For FKs (the majority position):**
- Without FKs, orphaned data WILL accumulate — it's a matter of when, not if
- Application-level enforcement is more complex and more bug-prone than database-level
- The performance cost is measurable but usually not the bottleneck
- The data integrity guarantee is worth the cost for almost all workloads

**What senior engineers do**: Keep foreign keys in most systems. If a specific table has a proven, measured performance problem from FK checks, address that specific table (perhaps by dropping the FK on that table and adding an application-level consistency check). Don't preemptively drop all FKs "for performance."

---

## 3.6 Constraints — The Database as Your Safety Net

Constraints are rules that PostgreSQL enforces on your data. They are the most under-utilized feature by junior engineers and the most valued feature by senior engineers.

### NOT NULL

The most important constraint. A `NOT NULL` column cannot contain `NULL` values.

```sql
CREATE TABLE users (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email TEXT NOT NULL,         -- every user must have an email
    display_name TEXT NOT NULL,  -- every user must have a name
    bio TEXT                     -- bio is optional (allows NULL)
);
```

**Rule: Make every column NOT NULL unless you have a specific reason for it to be nullable.** NULL introduces three-valued logic (true, false, unknown) into every comparison, complicates queries, and is a frequent source of bugs.

```sql
-- NULL makes conditions tricky:
SELECT * FROM users WHERE bio = 'hello';      -- does NOT match NULL bios
SELECT * FROM users WHERE bio != 'hello';     -- does NOT match NULL bios either!
SELECT * FROM users WHERE bio IS NULL;        -- the only way to match NULLs

-- COALESCE is your friend when dealing with nullable columns:
SELECT COALESCE(bio, 'No bio provided') FROM users;
```

### UNIQUE

Ensures no two rows have the same value in the constrained column(s).

```sql
CREATE TABLE users (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,  -- no two users can have the same email
    username TEXT NOT NULL UNIQUE
);
```

A `UNIQUE` constraint automatically creates a B-tree index. You don't need to create a separate index on a UNIQUE column — it already has one.

**Multi-column UNIQUE (composite uniqueness):**

```sql
CREATE TABLE team_memberships (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    team_id BIGINT NOT NULL REFERENCES teams(id),
    role TEXT NOT NULL DEFAULT 'member',
    UNIQUE (user_id, team_id)  -- a user can be in a team only once
);
```

**NULL behavior in UNIQUE**: In PostgreSQL, NULL values are considered distinct for UNIQUE purposes. Two rows can both have `NULL` in a UNIQUE column. If you want to treat NULLs as equal, use a unique index with `NULLS NOT DISTINCT` (PostgreSQL 15+):

```sql
CREATE TABLE user_profiles (
    user_id BIGINT PRIMARY KEY REFERENCES users(id),
    phone TEXT,
    CONSTRAINT unique_phone UNIQUE NULLS NOT DISTINCT (phone)
    -- only one user can have NULL phone (if that's what you want)
);
```

### CHECK

Enforces an arbitrary boolean condition on a row.

```sql
CREATE TABLE products (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL,
    price_cents BIGINT NOT NULL,
    weight_kg NUMERIC(8,3),
    stock_count INTEGER NOT NULL DEFAULT 0,

    -- Single-column checks
    CONSTRAINT positive_price CHECK (price_cents > 0),
    CONSTRAINT non_negative_stock CHECK (stock_count >= 0),
    CONSTRAINT valid_weight CHECK (weight_kg IS NULL OR weight_kg > 0),

    -- Multi-column check
    CONSTRAINT valid_sale CHECK (
        sale_price_cents IS NULL OR sale_price_cents < price_cents
    ),

    sale_price_cents BIGINT
);

-- CHECK constraints are enforced on INSERT and UPDATE:
INSERT INTO products (name, price_cents, stock_count) VALUES ('Widget', -100, 5);
-- ERROR: new row for relation "products" violates check constraint "positive_price"
```

CHECK constraints are powerful because they turn business rules into database guarantees. An API bug that sends a negative price is caught before the data is written.

### EXCLUSION Constraints

Exclusion constraints are a powerful PostgreSQL feature for preventing overlapping data. The most common use case is **preventing overlapping time ranges** (room bookings, employee schedules, resource reservations).

```sql
-- Requires the btree_gist extension for combining different operator types
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE room_bookings (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id),
    booked_during TSTZRANGE NOT NULL,
    booked_by BIGINT NOT NULL REFERENCES users(id),

    -- No two bookings for the same room can overlap in time
    CONSTRAINT no_overlapping_bookings
        EXCLUDE USING GIST (room_id WITH =, booked_during WITH &&)
);

-- This works:
INSERT INTO room_bookings (room_id, booked_during, booked_by) VALUES
(1, '[2024-06-15 09:00, 2024-06-15 10:00)', 1);

INSERT INTO room_bookings (room_id, booked_during, booked_by) VALUES
(1, '[2024-06-15 10:00, 2024-06-15 11:00)', 2);  -- starts when previous ends

-- This fails:
INSERT INTO room_bookings (room_id, booked_during, booked_by) VALUES
(1, '[2024-06-15 09:30, 2024-06-15 10:30)', 3);  -- overlaps with first booking
-- ERROR: conflicting key value violates exclusion constraint "no_overlapping_bookings"
```

The exclusion constraint says: "For any two rows, it must NOT be the case that `room_id` is equal AND `booked_during` overlaps." This is something you simply cannot express with UNIQUE or CHECK.

**Range types**: The `TSTZRANGE` (timestamp with timezone range) type is used above. The `[` means inclusive lower bound, `)` means exclusive upper bound. `[09:00, 10:00)` includes 09:00 but not 10:00, so a booking at `[10:00, 11:00)` doesn't overlap. This is the standard convention for time ranges.

---

## 3.7 Common Schema Patterns Used in Production

### 3.7.1 Users and Authentication

```sql
CREATE TABLE users (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    external_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT email_format CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    CONSTRAINT display_name_length CHECK (char_length(display_name) BETWEEN 1 AND 100)
);

CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,

    CONSTRAINT valid_expiry CHECK (expires_at > created_at)
);
CREATE INDEX idx_sessions_user_id ON sessions (user_id);
CREATE INDEX idx_sessions_expires_at ON sessions (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE oauth_accounts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_user_id TEXT NOT NULL,
    access_token TEXT,
    refresh_token TEXT,
    token_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (provider, provider_user_id),
    CONSTRAINT valid_provider CHECK (provider IN ('google', 'github', 'apple'))
);
CREATE INDEX idx_oauth_accounts_user_id ON oauth_accounts (user_id);
```

**Design decisions explained:**
- `password_hash`, not `password` — never store plaintext passwords
- Session ID is a UUID — no sequential information leakage in session tokens
- `expires_at` with a CHECK constraint — sessions must have a future expiry
- Partial index on `sessions.expires_at WHERE revoked_at IS NULL` — only index active sessions
- OAuth accounts have `UNIQUE (provider, provider_user_id)` — one Google account links to one user

### 3.7.2 Multi-Tenancy

Multi-tenancy means a single database serves multiple customers ("tenants"). There are three common patterns:

**Pattern 1: Row-Level Tenancy (Shared Tables)**

Every table has a `tenant_id` column. All queries include `WHERE tenant_id = ?`.

```sql
CREATE TABLE tenants (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE projects (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id BIGINT NOT NULL REFERENCES tenants(id),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (tenant_id, name)
);
-- CRITICAL: tenant_id must be the LEADING column in composite indexes
-- so that queries filtering by tenant use the index efficiently
CREATE INDEX idx_projects_tenant ON projects (tenant_id, created_at DESC);

CREATE TABLE tasks (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id BIGINT NOT NULL REFERENCES tenants(id),
    project_id BIGINT NOT NULL REFERENCES projects(id),
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'in_progress', 'done', 'closed')),
    assigned_to BIGINT REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_tasks_tenant_project ON tasks (tenant_id, project_id, status);
CREATE INDEX idx_tasks_assigned ON tasks (assigned_to) WHERE assigned_to IS NOT NULL;
```

**Pros**: Simple, no extra infrastructure, easy to query across tenants (admin/analytics).
**Cons**: Every query must filter by `tenant_id` (miss it and you leak data), one large tenant can impact others (noisy neighbor), hard to shard later.

**Row-Level Security (RLS)** makes row-level tenancy safer:

```sql
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON projects
    USING (tenant_id = current_setting('app.current_tenant_id')::BIGINT);

-- Application sets the tenant on each request:
SET app.current_tenant_id = '42';
SELECT * FROM projects;  -- only sees tenant 42's projects, even without WHERE clause
```

**Pattern 2: Schema-Per-Tenant**

Each tenant gets its own PostgreSQL schema. Tables are identical but isolated.

```
tenant_1.projects
tenant_1.tasks
tenant_2.projects
tenant_2.tasks
```

**Pros**: Natural isolation, easy per-tenant backup/restore, no risk of forgetting tenant_id filter.
**Cons**: Schema migrations must run N times (once per tenant), many schemas can slow down PostgreSQL's catalog, harder to query across tenants.

**Pattern 3: Database-Per-Tenant**

Each tenant gets their own database. Maximum isolation.

**Pros**: Complete isolation, easy to move individual tenants to different hardware.
**Cons**: Most operational overhead, connection pooling is per-database, cross-tenant queries require dblink or federation.

**What large companies do**: Most start with row-level tenancy (Pattern 1) because it's simplest. Schema-per-tenant (Pattern 2) is used when data isolation requirements are strict (compliance, enterprise customers). Database-per-tenant (Pattern 3) is rare except in enterprise SaaS with strong data residency requirements.

### 3.7.3 Soft Deletes

Soft deletion means marking a row as deleted instead of physically removing it.

```sql
CREATE TABLE documents (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT,
    created_by BIGINT NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ  -- NULL means not deleted
);

-- Partial index: most queries want only non-deleted rows
CREATE INDEX idx_documents_active ON documents (created_by, created_at DESC)
    WHERE deleted_at IS NULL;

-- "Deleting" a document
UPDATE documents SET deleted_at = now() WHERE id = 42;

-- Querying non-deleted documents (most common)
SELECT * FROM documents WHERE deleted_at IS NULL AND created_by = 1;

-- Querying deleted documents (admin/recovery)
SELECT * FROM documents WHERE deleted_at IS NOT NULL;
```

**Pros:**
- Undo/recovery is trivial (set `deleted_at` back to NULL)
- Audit trail of when things were deleted
- Referencing rows don't break (no cascade deletion issues)

**Cons:**
- Every query must include `WHERE deleted_at IS NULL` — forget it once and you leak deleted data
- Table grows forever (soft-deleted rows are never physically removed unless you add a cleanup job)
- Unique constraints need special handling:

```sql
-- Problem: Two users can't have the same email, but what about deleted users?
-- If Alice deletes her account and Bob tries to register with the same email...

-- Solution 1: Unique index only on active rows
CREATE UNIQUE INDEX idx_users_email_active ON users (email)
    WHERE deleted_at IS NULL;

-- Solution 2: Include deleted_at in the unique constraint
-- (allows same email in different deleted states, but requires careful thought)
```

**The default view pattern**: Some teams create a view that pre-filters deleted rows:

```sql
CREATE VIEW active_documents AS
    SELECT * FROM documents WHERE deleted_at IS NULL;

-- Application code uses the view by default:
SELECT * FROM active_documents WHERE created_by = 1;
```

### 3.7.4 Audit Logging

Tracking who changed what and when. This is a compliance requirement at many companies.

**Pattern 1: Separate Audit Log Table**

```sql
CREATE TABLE audit_log (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    table_name TEXT NOT NULL,
    record_id BIGINT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
    old_data JSONB,
    new_data JSONB,
    changed_by BIGINT REFERENCES users(id),
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ip_address INET
);
CREATE INDEX idx_audit_log_table_record ON audit_log (table_name, record_id);
CREATE INDEX idx_audit_log_changed_at ON audit_log (changed_at);
CREATE INDEX idx_audit_log_changed_by ON audit_log (changed_by);
```

**Pattern 2: Trigger-Based Automatic Auditing**

```sql
CREATE OR REPLACE FUNCTION audit_trigger_func()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO audit_log (table_name, record_id, action, new_data, changed_at)
        VALUES (TG_TABLE_NAME, NEW.id, 'INSERT', to_jsonb(NEW), now());
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO audit_log (table_name, record_id, action, old_data, new_data, changed_at)
        VALUES (TG_TABLE_NAME, NEW.id, 'UPDATE', to_jsonb(OLD), to_jsonb(NEW), now());
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        INSERT INTO audit_log (table_name, record_id, action, old_data, changed_at)
        VALUES (TG_TABLE_NAME, OLD.id, 'DELETE', to_jsonb(OLD), now());
        RETURN OLD;
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_orders
    AFTER INSERT OR UPDATE OR DELETE ON orders
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_func();
```

**Pattern 3: Application-Level Auditing**

Some companies handle auditing in application code rather than triggers, because:
- Triggers add write latency to every operation
- Application code has access to context (current user, request ID) that triggers don't easily get
- Audit log writes can be made asynchronous (via a message queue)

**What large companies do**: A combination. Critical tables often have trigger-based auditing for completeness. High-throughput tables use application-level auditing with async writes. Compliance-heavy systems use both.

### 3.7.5 Status / State Machines

Many entities go through a series of states. Modeling this correctly prevents invalid state transitions.

```sql
CREATE TABLE orders (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'submitted', 'processing', 'shipped', 'delivered', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    submitted_at TIMESTAMPTZ,
    shipped_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,

    -- Enforce that status-specific timestamps are consistent
    CONSTRAINT submitted_has_timestamp CHECK (
        (status IN ('submitted', 'processing', 'shipped', 'delivered') AND submitted_at IS NOT NULL)
        OR status IN ('draft', 'cancelled')
    ),
    CONSTRAINT shipped_has_timestamp CHECK (
        (status IN ('shipped', 'delivered') AND shipped_at IS NOT NULL)
        OR status NOT IN ('shipped', 'delivered')
    )
);

-- Partial indexes for common status queries
CREATE INDEX idx_orders_processing ON orders (created_at)
    WHERE status = 'processing';
CREATE INDEX idx_orders_shipped ON orders (shipped_at)
    WHERE status = 'shipped';
```

**State transitions should be enforced in application code**, not in the database. A CHECK constraint can validate that the current status is in the allowed set, but it can't validate that the TRANSITION from the old status to the new status is valid (e.g., you can't go from 'draft' directly to 'delivered'). Use application-level logic or a trigger:

```sql
CREATE OR REPLACE FUNCTION validate_order_status_transition()
RETURNS TRIGGER AS $$
DECLARE
    valid_transitions JSONB := '{
        "draft": ["submitted", "cancelled"],
        "submitted": ["processing", "cancelled"],
        "processing": ["shipped", "cancelled"],
        "shipped": ["delivered"],
        "delivered": [],
        "cancelled": []
    }'::JSONB;
    allowed TEXT[];
BEGIN
    IF OLD.status = NEW.status THEN
        RETURN NEW;
    END IF;

    SELECT array_agg(value::TEXT)
    INTO allowed
    FROM jsonb_array_elements_text(valid_transitions -> OLD.status);

    IF NEW.status != ALL(COALESCE(allowed, ARRAY[]::TEXT[])) THEN
        RAISE EXCEPTION 'Invalid status transition: % → %', OLD.status, NEW.status;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER check_order_status
    BEFORE UPDATE OF status ON orders
    FOR EACH ROW EXECUTE FUNCTION validate_order_status_transition();
```

### 3.7.6 Hierarchical Data

Many real-world domains have tree structures: org charts, file systems, categories, comments with replies.

**Pattern 1: Adjacency List (Simple Parent Reference)**

```sql
CREATE TABLE categories (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    parent_id BIGINT REFERENCES categories(id),
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_categories_parent ON categories (parent_id);

-- Root categories have parent_id = NULL
INSERT INTO categories (name) VALUES ('Electronics');          -- id: 1
INSERT INTO categories (parent_id, name) VALUES (1, 'Phones');     -- id: 2
INSERT INTO categories (parent_id, name) VALUES (1, 'Laptops');    -- id: 3
INSERT INTO categories (parent_id, name) VALUES (2, 'Smartphones'); -- id: 4
INSERT INTO categories (parent_id, name) VALUES (2, 'Feature Phones'); -- id: 5
```

**Pros**: Simple, natural, easy to move a node (just update `parent_id`).
**Cons**: Querying an entire subtree requires recursive queries.

```sql
-- Get the full subtree under "Electronics" using a recursive CTE
WITH RECURSIVE category_tree AS (
    -- Base case: the root node
    SELECT id, parent_id, name, 0 AS depth, ARRAY[name] AS path
    FROM categories
    WHERE id = 1

    UNION ALL

    -- Recursive case: children of the current level
    SELECT c.id, c.parent_id, c.name, ct.depth + 1, ct.path || c.name
    FROM categories c
    JOIN category_tree ct ON c.parent_id = ct.id
)
SELECT * FROM category_tree ORDER BY path;
```

```
 id | parent_id |     name        | depth |                path
----+-----------+-----------------+-------+------------------------------------
  1 |      NULL | Electronics     |     0 | {Electronics}
  3 |         1 | Laptops         |     1 | {Electronics,Laptops}
  2 |         1 | Phones          |     1 | {Electronics,Phones}
  5 |         2 | Feature Phones  |     2 | {Electronics,Phones,"Feature Phones"}
  4 |         2 | Smartphones     |     2 | {Electronics,Phones,Smartphones}
```

**Pattern 2: Materialized Path (ltree)**

PostgreSQL's `ltree` extension stores the full path of each node as a label tree.

```sql
CREATE EXTENSION IF NOT EXISTS ltree;

CREATE TABLE categories_ltree (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL,
    path ltree NOT NULL
);
CREATE INDEX idx_categories_path ON categories_ltree USING GIST (path);

INSERT INTO categories_ltree (name, path) VALUES
('Electronics', 'electronics'),
('Phones', 'electronics.phones'),
('Laptops', 'electronics.laptops'),
('Smartphones', 'electronics.phones.smartphones'),
('Feature Phones', 'electronics.phones.feature_phones');

-- All descendants of Electronics (extremely fast with GiST index)
SELECT * FROM categories_ltree WHERE path <@ 'electronics';

-- All ancestors of Smartphones
SELECT * FROM categories_ltree WHERE path @> 'electronics.phones.smartphones';

-- Direct children of Electronics
SELECT * FROM categories_ltree WHERE path ~ 'electronics.*{1}';

-- Depth of each node
SELECT name, nlevel(path) AS depth FROM categories_ltree;
```

**Pros**: Subtree queries are fast (single index lookup). Depth and ancestor queries are trivial.
**Cons**: Moving a node requires updating the path of the node AND all its descendants. Path must be maintained manually.

**Pattern 3: Closure Table**

Stores all ancestor-descendant relationships explicitly in a separate table.

```sql
CREATE TABLE categories (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE TABLE category_closure (
    ancestor_id BIGINT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    descendant_id BIGINT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    depth INTEGER NOT NULL,
    PRIMARY KEY (ancestor_id, descendant_id)
);
CREATE INDEX idx_closure_descendant ON category_closure (descendant_id);

-- Each node is its own ancestor at depth 0
-- Electronics (1) → Phones (2) → Smartphones (4)
INSERT INTO category_closure VALUES
(1, 1, 0), (2, 2, 0), (3, 3, 0), (4, 4, 0), (5, 5, 0),  -- self
(1, 2, 1), (1, 3, 1),  -- Electronics → Phones, Laptops
(1, 4, 2), (1, 5, 2),  -- Electronics → Smartphones, Feature Phones
(2, 4, 1), (2, 5, 1);  -- Phones → Smartphones, Feature Phones

-- All descendants of Electronics
SELECT c.* FROM categories c
JOIN category_closure cc ON c.id = cc.descendant_id
WHERE cc.ancestor_id = 1 AND cc.depth > 0;

-- All ancestors of Smartphones
SELECT c.* FROM categories c
JOIN category_closure cc ON c.id = cc.ancestor_id
WHERE cc.descendant_id = 4 AND cc.depth > 0;
```

**Pros**: All queries (subtree, ancestors, depth) are fast indexed lookups.
**Cons**: Insert/move requires updating the closure table (more complex writes). The closure table can be large (N^2 in the worst case for deep trees).

**Which pattern to choose:**

| Criteria | Adjacency List | ltree | Closure Table |
|---|---|---|---|
| Simplicity | Best | Good | Complex |
| Subtree queries | Requires recursion | Excellent | Excellent |
| Move operations | Trivial | Requires path rewrite | Complex |
| Ancestor queries | Requires recursion | Excellent | Excellent |
| Write performance | Best | Good | Most write overhead |
| Best for | Shallow trees, few subtree queries | Read-heavy hierarchies | Complex queries, fixed hierarchies |

### 3.7.7 Tagging Systems

The classic many-to-many relationship.

```sql
CREATE TABLE tags (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE article_tags (
    article_id BIGINT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    tag_id BIGINT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (article_id, tag_id)
);
CREATE INDEX idx_article_tags_tag ON article_tags (tag_id);

-- Find articles with a specific tag
SELECT a.*
FROM articles a
JOIN article_tags at ON a.id = at.article_id
JOIN tags t ON at.tag_id = t.id
WHERE t.name = 'postgresql';

-- Find articles that have ALL of a set of tags
SELECT a.*
FROM articles a
JOIN article_tags at ON a.id = at.article_id
JOIN tags t ON at.tag_id = t.id
WHERE t.name IN ('postgresql', 'performance')
GROUP BY a.id
HAVING COUNT(DISTINCT t.name) = 2;  -- must match all 2 tags

-- Find an article's tags
SELECT t.name FROM tags t
JOIN article_tags at ON t.id = at.tag_id
WHERE at.article_id = 42;

-- Tag cloud: most used tags
SELECT t.name, COUNT(*) AS article_count
FROM tags t
JOIN article_tags at ON t.id = at.tag_id
GROUP BY t.id, t.name
ORDER BY article_count DESC
LIMIT 20;
```

### 3.7.8 Time-Series Data

For high-volume temporal data (logs, metrics, events), partitioning by time is essential.

```sql
CREATE TABLE events (
    id BIGINT GENERATED ALWAYS AS IDENTITY,
    tenant_id BIGINT NOT NULL,
    event_type TEXT NOT NULL,
    payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

-- Create monthly partitions
CREATE TABLE events_2024_01 PARTITION OF events
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
CREATE TABLE events_2024_02 PARTITION OF events
    FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');
CREATE TABLE events_2024_03 PARTITION OF events
    FOR VALUES FROM ('2024-03-01') TO ('2024-04-01');
-- ... create partitions for each month

-- Indexes are created on each partition (PostgreSQL propagates them automatically)
CREATE INDEX ON events (tenant_id, created_at DESC);
CREATE INDEX ON events (event_type, created_at DESC);

-- Queries automatically benefit from partition pruning:
SELECT * FROM events
WHERE created_at >= '2024-02-01' AND created_at < '2024-03-01'
  AND tenant_id = 42;
-- PostgreSQL only scans the events_2024_02 partition — skips all others

-- Dropping old data is instant (drop the partition, not DELETE)
DROP TABLE events_2024_01;
-- This is instant, no matter how many rows. DELETE would generate WAL,
-- create dead rows, and require VACUUM. Dropping a partition is free.
```

**Partitioning best practices:**
- Create future partitions ahead of time (a cron job or `pg_partman` extension)
- Partition column must be part of the primary key if you want one
- Common partition sizes: daily for high-volume data, monthly for moderate, yearly for low
- Always query with the partition key in WHERE — without it, PostgreSQL scans ALL partitions

---

## 3.8 Schema Versioning and Evolution

Schemas change over time. New features require new tables and columns. Business requirements shift. This is one of the hardest parts of working with relational databases.

### The Core Principle: Backward Compatibility

Every schema change must be **backward compatible with the currently running code**. Because in any real deployment:
1. You deploy the migration (schema change)
2. Old code is still running (old application instances haven't been replaced yet)
3. New code starts running
4. Old instances are shut down

During step 2, old code must work with the new schema. This means:
- **Adding a column**: Must be nullable or have a default value (old code doesn't insert it)
- **Dropping a column**: Old code might still SELECT or INSERT it — drop the column AFTER old code is gone
- **Renaming a column**: Never do this in one step. Add new column → update code to use both → drop old column
- **Adding a table**: Safe — old code doesn't know about it
- **Dropping a table**: Remove all code references first, then drop

We cover migration operations in detail in Chapter 10.

### Migration File Conventions

```
migrations/
├── 000001_create_users.up.sql
├── 000001_create_users.down.sql
├── 000002_create_orders.up.sql
├── 000002_create_orders.down.sql
├── 000003_add_users_phone.up.sql
├── 000003_add_users_phone.down.sql
```

Each migration is numbered sequentially. The `up` file applies the change. The `down` file reverses it. Migrations are applied in order and tracked in a `schema_migrations` table.

---

## 3.9 Full Real-World Schema: Multi-Tenant SaaS Application

Let's design a complete schema for a multi-tenant project management SaaS application. This brings together every concept from this chapter.

### Requirements

- Multiple organizations (tenants) sharing one database
- Each organization has workspaces, projects, tasks, and comments
- Users can belong to multiple organizations with different roles
- Tasks have statuses, assignments, labels, and file attachments
- Full audit trail of changes
- Soft deletion for key entities
- Activity feed showing recent changes

### The Schema

```sql
-- ============================================================
-- ORGANIZATIONS (TENANTS)
-- ============================================================

CREATE TABLE organizations (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    external_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    plan TEXT NOT NULL DEFAULT 'free'
        CHECK (plan IN ('free', 'pro', 'enterprise')),
    settings JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- USERS
-- ============================================================

CREATE TABLE users (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    external_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    avatar_url TEXT,
    password_hash TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT email_format CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    CONSTRAINT display_name_length CHECK (char_length(display_name) BETWEEN 1 AND 100)
);

-- ============================================================
-- ORGANIZATION MEMBERSHIPS
-- A user can belong to multiple organizations with different roles.
-- ============================================================

CREATE TABLE organization_memberships (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member'
        CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
    invited_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (organization_id, user_id)
);
CREATE INDEX idx_org_memberships_user ON organization_memberships (user_id);

-- ============================================================
-- PROJECTS
-- Each project belongs to one organization.
-- ============================================================

CREATE TABLE projects (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    external_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'archived')),
    created_by BIGINT NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,

    CONSTRAINT project_name_length CHECK (char_length(name) BETWEEN 1 AND 200)
);
CREATE UNIQUE INDEX idx_projects_org_name ON projects (organization_id, name)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_projects_org_active ON projects (organization_id, created_at DESC)
    WHERE deleted_at IS NULL;

-- ============================================================
-- LABELS
-- Reusable labels per organization for categorizing tasks.
-- ============================================================

CREATE TABLE labels (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color VARCHAR(7) NOT NULL DEFAULT '#6B7280',

    UNIQUE (organization_id, name),
    CONSTRAINT valid_hex_color CHECK (color ~ '^#[0-9a-fA-F]{6}$')
);

-- ============================================================
-- TASKS
-- The core entity. Belongs to a project. Has status, assignee, labels.
-- ============================================================

CREATE TABLE tasks (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    external_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    organization_id BIGINT NOT NULL REFERENCES organizations(id),
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parent_task_id BIGINT REFERENCES tasks(id) ON DELETE SET NULL,

    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'in_progress', 'in_review', 'done', 'closed')),
    priority SMALLINT NOT NULL DEFAULT 0
        CHECK (priority BETWEEN 0 AND 4),

    assigned_to BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_by BIGINT NOT NULL REFERENCES users(id),

    due_date DATE,
    estimated_hours NUMERIC(6,2),

    position INTEGER NOT NULL DEFAULT 0,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,

    CONSTRAINT title_length CHECK (char_length(title) BETWEEN 1 AND 500),
    CONSTRAINT completed_status CHECK (
        (completed_at IS NOT NULL AND status IN ('done', 'closed'))
        OR completed_at IS NULL
    )
);

-- Primary query: tasks in a project, ordered by position, excluding deleted
CREATE INDEX idx_tasks_project_position ON tasks (project_id, position)
    WHERE deleted_at IS NULL;

-- My tasks: tasks assigned to a user across all projects
CREATE INDEX idx_tasks_assigned ON tasks (assigned_to, status, due_date)
    WHERE deleted_at IS NULL AND assigned_to IS NOT NULL;

-- Overdue tasks
CREATE INDEX idx_tasks_overdue ON tasks (due_date)
    WHERE deleted_at IS NULL AND status NOT IN ('done', 'closed') AND due_date IS NOT NULL;

-- Tenant-scoped queries
CREATE INDEX idx_tasks_org ON tasks (organization_id, created_at DESC);

-- Parent-child relationship for subtasks
CREATE INDEX idx_tasks_parent ON tasks (parent_task_id) WHERE parent_task_id IS NOT NULL;

-- ============================================================
-- TASK-LABEL JUNCTION
-- Many-to-many: tasks can have multiple labels.
-- ============================================================

CREATE TABLE task_labels (
    task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    label_id BIGINT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, label_id)
);
CREATE INDEX idx_task_labels_label ON task_labels (label_id);

-- ============================================================
-- COMMENTS
-- Comments on tasks. Supports threading via parent_comment_id.
-- ============================================================

CREATE TABLE comments (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    parent_comment_id BIGINT REFERENCES comments(id) ON DELETE CASCADE,
    author_id BIGINT NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,

    CONSTRAINT body_not_empty CHECK (trim(body) <> '')
);
CREATE INDEX idx_comments_task ON comments (task_id, created_at)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_comments_parent ON comments (parent_comment_id)
    WHERE parent_comment_id IS NOT NULL;

-- ============================================================
-- FILE ATTACHMENTS
-- Files attached to tasks. Actual binary stored in S3/GCS.
-- ============================================================

CREATE TABLE attachments (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    external_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    uploaded_by BIGINT NOT NULL REFERENCES users(id),
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    storage_path TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_size CHECK (size_bytes > 0),
    CONSTRAINT filename_length CHECK (char_length(filename) BETWEEN 1 AND 255)
);
CREATE INDEX idx_attachments_task ON attachments (task_id);

-- ============================================================
-- ACTIVITY LOG (Audit + Activity Feed)
-- Records all significant actions for the activity feed and auditing.
-- ============================================================

CREATE TABLE activities (
    id BIGINT GENERATED ALWAYS AS IDENTITY,
    organization_id BIGINT NOT NULL,
    project_id BIGINT,
    task_id BIGINT,
    actor_id BIGINT NOT NULL REFERENCES users(id),
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id BIGINT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

-- Monthly partitions
CREATE TABLE activities_2024_01 PARTITION OF activities
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
CREATE TABLE activities_2024_02 PARTITION OF activities
    FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');
-- ... continue for each month, automate with pg_partman or cron

-- Activity feed for a project (most recent first)
CREATE INDEX ON activities (organization_id, project_id, created_at DESC);
-- Activity for a specific task
CREATE INDEX ON activities (task_id, created_at DESC) WHERE task_id IS NOT NULL;
-- Activity by a user
CREATE INDEX ON activities (actor_id, created_at DESC);
```

### Design Decision Justifications

| Decision | Reasoning |
|---|---|
| `BIGINT GENERATED ALWAYS AS IDENTITY` for PKs | Compact, fast joins, prevents manual ID insertion |
| `external_id UUID` on user-facing entities | No info leakage in APIs, globally unique |
| Row-level multi-tenancy with `organization_id` | Simplest approach; RLS can be added for extra safety |
| `organization_id` on tasks (redundant with project) | Enables efficient org-scoped queries without joining projects |
| `TEXT` with `CHECK` for statuses | Migration-friendly; no ENUM rewrite on status changes |
| Soft deletes on projects, tasks, comments | Recovery, audit trail, referential integrity |
| Partial indexes with `WHERE deleted_at IS NULL` | Most queries only need active records; small, fast indexes |
| `JSONB` for org settings and activity metadata | Semi-structured data that varies; avoids schema changes |
| Partitioned activities table | High-volume insert, time-range queries, easy old data removal |
| Separate labels table with junction | Labels are shared across tasks; junction allows many-to-many |
| `storage_path TEXT` not `BYTEA` for attachments | Files in S3/GCS; database stores the path, not the file |
| `position INTEGER` on tasks | Enables drag-and-drop reordering within a project |
| `parent_task_id` on tasks (adjacency list) | Simple subtask hierarchy; recursive queries acceptable |
| `parent_comment_id` on comments | Threaded comments; adjacency list is simple enough here |

This schema supports:
- Multi-tenant data isolation
- User management across organizations
- Full project/task CRUD with history
- Threaded comments
- File attachments via external storage
- Activity feed and audit log
- Soft deletion with recovery
- Efficient querying via targeted indexes

This is the kind of schema you'd find at a well-run startup or growth-stage company. It's not over-engineered (no unnecessary abstractions), but it's thorough (constraints prevent data corruption, indexes serve real query patterns, and the design anticipates growth).

---

→ next: chapter04_querying_beyond_crud.md
