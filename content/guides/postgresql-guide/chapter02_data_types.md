# Chapter 2 — Data Types in Depth

## Table of Contents

- [2.1 Why Data Types Are a Design Decision](#21-why-data-types-are-a-design-decision)
- [2.2 Numeric Types](#22-numeric-types)
- [2.3 Text Types](#23-text-types)
- [2.4 Boolean](#24-boolean)
- [2.5 Date, Time, and Timestamp Types](#25-date-time-and-timestamp-types)
- [2.6 UUID](#26-uuid)
- [2.7 JSONB vs JSON](#27-jsonb-vs-json)
- [2.8 Arrays](#28-arrays)
- [2.9 ENUM Types](#29-enum-types)
- [2.10 BYTEA — Binary Data](#210-bytea--binary-data)
- [2.11 SERIAL vs BIGSERIAL vs IDENTITY](#211-serial-vs-bigserial-vs-identity)
- [2.12 Custom Domain Types](#212-custom-domain-types)
- [2.13 Type Selection Guide for Common Backend Scenarios](#213-type-selection-guide-for-common-backend-scenarios)

---

## 2.1 Why Data Types Are a Design Decision

Choosing a data type is not a trivial, cosmetic choice. It is a schema design decision that affects:

1. **Storage size**: A `SMALLINT` uses 2 bytes, a `BIGINT` uses 8 bytes. Over 100 million rows, that's 600 MB of difference per column. When that column is indexed, the index is also larger, which means more pages to read, more memory used in shared buffers, and slower index scans.

2. **Correctness**: If you store a price as `REAL` (floating point), you will get rounding errors. `0.1 + 0.2` is not `0.3` in floating point. If you store it as `NUMERIC(10,2)`, you get exact decimal arithmetic. Choosing the wrong type can introduce silent data corruption that only shows up in financial reports months later.

3. **Query performance**: Comparing two `INTEGER` values is a single CPU instruction. Comparing two `TEXT` values requires scanning bytes, handling collation, and potentially dealing with variable-length data. Index scans on `INTEGER` columns are faster than on `TEXT` columns because integer keys are fixed-width and compact.

4. **Constraint enforcement**: PostgreSQL enforces type-level constraints automatically. You can't insert the string `'hello'` into an `INTEGER` column. You can't insert `'2024-13-45'` into a `DATE` column. Choosing the right type means the database rejects invalid data before your application code has to deal with it.

5. **Index compatibility**: Different types support different index types. JSONB supports GIN indexes. Geometric types support GiST indexes. Arrays support GIN indexes. Choosing the right type determines what kinds of efficient queries you can write.

**What senior engineers do**: They choose the narrowest type that correctly represents the data, they never use floating point for money, they always use `TIMESTAMPTZ` instead of `TIMESTAMP`, and they consider index implications before choosing between `TEXT`, `UUID`, and `BIGINT` for primary keys.

---

## 2.2 Numeric Types

### Integer Types

| Type | Storage | Range | Use When |
|---|---|---|---|
| `SMALLINT` | 2 bytes | -32,768 to 32,767 | Enum-like values, small counters, age |
| `INTEGER` | 4 bytes | -2,147,483,648 to 2,147,483,647 (~2.1 billion) | Most IDs, counts, quantities |
| `BIGINT` | 8 bytes | -9.2 × 10^18 to 9.2 × 10^18 | IDs that may exceed 2B, timestamps as integers, large counters |

**The key decision: INTEGER vs BIGINT for IDs.**

If your table will definitely have fewer than 2 billion rows over its entire lifetime, `INTEGER` is fine and saves 4 bytes per row and per index entry. But if there's any chance — a high-throughput events table, a log table, a table with frequent inserts and deletes — use `BIGINT`.

The mistake that hurts: Starting with `INTEGER` for a primary key, hitting the ~2.1 billion limit years later, and having to migrate a huge table. Twitter famously hit this with tweet IDs. The migration is painful. When in doubt, use `BIGINT`.

```sql
-- Production pattern: BIGINT for any table that could grow large
CREATE TABLE events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_type SMALLINT NOT NULL,  -- small set of known values
    user_id BIGINT NOT NULL,
    payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Exact Decimal: NUMERIC / DECIMAL

`NUMERIC(precision, scale)` stores exact decimal numbers. `precision` is the total number of significant digits. `scale` is the number of digits after the decimal point.

```sql
-- NUMERIC(10, 2) stores up to 99999999.99
-- 10 total digits, 2 after the decimal
CREATE TABLE products (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL,
    price NUMERIC(10, 2) NOT NULL CHECK (price >= 0)
);

INSERT INTO products (name, price) VALUES ('Widget', 29.99);
INSERT INTO products (name, price) VALUES ('Gadget', 1299.00);

-- This will FAIL — too many digits before decimal
INSERT INTO products (name, price) VALUES ('Yacht', 12345678901.00);
-- ERROR: numeric field overflow
```

**Why NUMERIC and not REAL/DOUBLE for money:**

```sql
-- Floating point is approximate
SELECT 0.1::REAL + 0.2::REAL;
-- Returns: 0.30000001192092896

-- NUMERIC is exact
SELECT 0.1::NUMERIC + 0.2::NUMERIC;
-- Returns: 0.3
```

If you store prices as `REAL` or `DOUBLE PRECISION`, you will eventually have a customer charged $19.990000000000002 or a financial report that's off by a penny. This is not hypothetical — it happens in production.

**Performance note**: `NUMERIC` is slower than `INTEGER` or `BIGINT` for arithmetic operations because it's stored as a variable-length decimal representation, not a machine-native number. For most applications this doesn't matter, but for analytical workloads doing millions of arithmetic operations, it's measurable.

**Common production pattern for money**: Store amounts in the smallest currency unit as `BIGINT` (e.g., cents for USD, so $29.99 is stored as `2999`). This gives you exact arithmetic with machine-native integer speed. Format for display in application code.

```sql
-- Alternative: store money as cents in BIGINT
CREATE TABLE order_items (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES orders(id),
    product_id BIGINT NOT NULL REFERENCES products(id),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price_cents BIGINT NOT NULL CHECK (unit_price_cents >= 0),
    -- $29.99 is stored as 2999
    total_cents BIGINT GENERATED ALWAYS AS (quantity * unit_price_cents) STORED
);
```

### Floating Point: REAL and DOUBLE PRECISION

| Type | Storage | Precision | Use When |
|---|---|---|---|
| `REAL` | 4 bytes | ~6 decimal digits | Scientific data, sensor readings, where approximate is OK |
| `DOUBLE PRECISION` | 8 bytes | ~15 decimal digits | Scientific data, coordinates, statistical computations |

**Rule: Never use floating point for money, scores that need exact comparison, or any value where `a + b` must exactly equal `c`.**

Legitimate uses for floating point:
- Geographic coordinates (latitude/longitude)
- Scientific measurements
- Machine learning feature values
- Statistical aggregations where approximate results are acceptable

```sql
-- Legitimate floating point use: geographic coordinates
CREATE TABLE locations (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL,
    latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180)
);
```

---

## 2.3 Text Types

### The Three Text Types

| Type | Description | Max Length |
|---|---|---|
| `CHAR(n)` | Fixed-length, blank-padded | Exactly n characters |
| `VARCHAR(n)` | Variable-length with limit | Up to n characters |
| `TEXT` | Variable-length, unlimited | Up to ~1 GB |

### Why TEXT Is Almost Always the Right Choice in PostgreSQL

This is one of the most counterintuitive facts about PostgreSQL: **`TEXT` and `VARCHAR(n)` have identical storage and performance.** There is no performance difference between them. PostgreSQL stores both as variable-length strings with a 4-byte length prefix. A `VARCHAR(255)` does NOT pre-allocate 255 bytes — it stores exactly as many bytes as the actual string uses, just like `TEXT`.

The only difference is that `VARCHAR(n)` adds a length check constraint. This check has a tiny CPU cost on every insert/update but is negligible.

So when should you use which?

- **`TEXT`**: Default choice. Use for any string column where the exact maximum length either doesn't matter or is enforced in application code.
- **`VARCHAR(n)`**: Use when you want the database to enforce a maximum length AND you have a well-defined business reason for that maximum (e.g., ISO country code is exactly 2 characters, so `VARCHAR(2)` is appropriate).
- **`CHAR(n)`**: Almost never. `CHAR(10)` stores `'hello'` as `'hello     '` (padded with spaces). This is almost never what you want. The only legitimate use is for fixed-length codes (ISO currency codes, etc.), and even then `VARCHAR(3)` is usually clearer.

```sql
-- Production schema example
CREATE TABLE users (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email TEXT NOT NULL,                      -- no arbitrary length limit
    display_name TEXT NOT NULL,               -- no arbitrary length limit
    country_code VARCHAR(2),                  -- ISO 3166-1 alpha-2, exact length matters
    bio TEXT,                                 -- could be any length

    -- Enforce meaningful business constraints with CHECK, not VARCHAR
    CONSTRAINT email_length CHECK (char_length(email) <= 254),
    CONSTRAINT display_name_length CHECK (char_length(display_name) <= 100)
);
```

**Why not `VARCHAR(255)` everywhere?** Because 255 is a MySQL-ism. In MySQL, `VARCHAR(255)` uses a 1-byte length prefix (vs 2 bytes for 256+), so there was a storage optimization reason. In PostgreSQL, there is no such optimization. `VARCHAR(255)` is an arbitrary limit that will eventually need a migration to change, for no performance benefit.

### Text and Collation

Text comparison and sorting in PostgreSQL depend on **collation** — the rules for how strings are compared, sorted, and matched. The default collation is set when you create the database (usually from the operating system locale).

This matters because:
- **Index ordering** follows the collation. An index sorted by German collation rules orders 'ä' differently than English collation.
- **LIKE optimizations** only work with certain collations. For `LIKE 'prefix%'` to use an index, you may need a special operator class.

```sql
-- Create an index that supports LIKE 'prefix%' with non-C collation
CREATE INDEX idx_users_email_pattern ON users (email text_pattern_ops);

-- Now this query can use the index:
SELECT * FROM users WHERE email LIKE 'alice@%';
```

If your database was created with the `C` or `POSIX` locale, regular B-tree indexes support `LIKE` prefix matching. Otherwise, you need `text_pattern_ops` (or `varchar_pattern_ops`).

---

## 2.4 Boolean

PostgreSQL's `BOOLEAN` type stores `TRUE`, `FALSE`, or `NULL`. It uses 1 byte of storage.

```sql
CREATE TABLE features (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL,
    is_enabled BOOLEAN NOT NULL DEFAULT FALSE
);

-- PostgreSQL accepts many representations:
INSERT INTO features (name, is_enabled) VALUES ('dark_mode', TRUE);
INSERT INTO features (name, is_enabled) VALUES ('beta', 't');
INSERT INTO features (name, is_enabled) VALUES ('legacy', 'yes');
INSERT INTO features (name, is_enabled) VALUES ('experimental', '1');
-- All of the above work. In practice, use TRUE/FALSE for clarity.
```

**Common mistake — NULL booleans:**

A `BOOLEAN` column that allows NULL has THREE states: true, false, and unknown. This makes every conditional check more complex:

```sql
-- If is_active allows NULL, this misses NULL rows:
SELECT * FROM users WHERE is_active = FALSE;

-- To include NULL rows:
SELECT * FROM users WHERE is_active IS NOT TRUE;
-- or
SELECT * FROM users WHERE is_active = FALSE OR is_active IS NULL;

-- Senior engineers avoid this by making booleans NOT NULL with a DEFAULT:
CREATE TABLE users (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);
```

**Partial index on booleans — a powerful production pattern:**

If 99% of your users are active and you frequently query the inactive ones:

```sql
-- Instead of indexing the entire column:
CREATE INDEX idx_users_active ON users (is_active);
-- Which wastes space indexing the 99% you don't filter on

-- Use a partial index:
CREATE INDEX idx_users_inactive ON users (id) WHERE is_active = FALSE;
-- Much smaller index, only contains the rows you actually query
```

---

## 2.5 Date, Time, and Timestamp Types

This section matters more than you think. Timezone bugs are one of the most common sources of production incidents in backend services.

### The Types

| Type | Storage | Description | Range |
|---|---|---|---|
| `DATE` | 4 bytes | Date only (no time) | 4713 BC to 5874897 AD |
| `TIME` | 8 bytes | Time of day only (no date) | 00:00:00 to 24:00:00 |
| `TIME WITH TIME ZONE` | 12 bytes | Time with timezone (rarely useful) | — |
| `TIMESTAMP` | 8 bytes | Date and time, NO timezone | 4713 BC to 294276 AD |
| `TIMESTAMPTZ` | 8 bytes | Date and time, WITH timezone | 4713 BC to 294276 AD |
| `INTERVAL` | 16 bytes | Time span | ±178000000 years |

### The Critical Rule: Always Use TIMESTAMPTZ

This is not a suggestion. **Always use `TIMESTAMPTZ` (timestamp with time zone) instead of `TIMESTAMP` (timestamp without time zone).**

Here's why. When you store a `TIMESTAMP` (without timezone), PostgreSQL stores the literal date and time you give it with no timezone context. If your server is in UTC and a client in New York inserts `'2024-06-15 14:00:00'`, PostgreSQL stores exactly `2024-06-15 14:00:00`. If another client in Tokyo reads it, they get `2024-06-15 14:00:00` — but what timezone is that? Nobody knows. The information is lost.

When you store a `TIMESTAMPTZ`, PostgreSQL converts the input to UTC and stores it in UTC internally. On retrieval, it converts from UTC to the client's session timezone. The same moment in time is correctly displayed regardless of who reads it.

```sql
-- Demonstrate the difference
SET timezone = 'America/New_York';

-- With TIMESTAMP (no timezone) — stores the literal value, no conversion
CREATE TABLE bad_events (happened_at TIMESTAMP);
INSERT INTO bad_events VALUES ('2024-06-15 14:00:00');

SET timezone = 'Asia/Tokyo';
SELECT * FROM bad_events;
-- Returns: 2024-06-15 14:00:00  (same literal — WRONG for a Tokyo user)

-- With TIMESTAMPTZ — stores in UTC, converts on display
CREATE TABLE good_events (happened_at TIMESTAMPTZ);
SET timezone = 'America/New_York';
INSERT INTO good_events VALUES ('2024-06-15 14:00:00');
-- Stored internally as: 2024-06-15 18:00:00 UTC

SET timezone = 'Asia/Tokyo';
SELECT * FROM good_events;
-- Returns: 2024-06-16 03:00:00+09 (correctly converted to Tokyo time)
```

**The confusing part**: `TIMESTAMPTZ` does NOT store the timezone. It stores the value in UTC. The "with time zone" part means it is *timezone-aware* — it knows the value is in UTC and will convert to the client's timezone on output. The `TIMESTAMP` type is *timezone-unaware* — it's just a number with no context.

### Practical TIMESTAMPTZ Usage

```sql
CREATE TABLE orders (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    total_cents BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ
);

-- Querying with timezone-aware comparisons
-- "Orders placed today in New York timezone"
SELECT * FROM orders
WHERE created_at >= (CURRENT_DATE AT TIME ZONE 'America/New_York')
  AND created_at < ((CURRENT_DATE + INTERVAL '1 day') AT TIME ZONE 'America/New_York');

-- "Orders in the last 24 hours" (timezone-independent)
SELECT * FROM orders
WHERE created_at >= now() - INTERVAL '24 hours';

-- "Orders placed between 9am and 5pm ET, regardless of the date"
SELECT * FROM orders
WHERE (created_at AT TIME ZONE 'America/New_York')::TIME
    BETWEEN '09:00' AND '17:00';
```

### DATE Type

Use `DATE` when you genuinely only care about the calendar date with no time component:

```sql
CREATE TABLE subscriptions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    plan_id BIGINT NOT NULL REFERENCES plans(id),
    start_date DATE NOT NULL DEFAULT CURRENT_DATE,
    end_date DATE,
    CONSTRAINT valid_range CHECK (end_date IS NULL OR end_date > start_date)
);
```

### INTERVAL Type

`INTERVAL` represents a duration of time. It's extremely useful for date arithmetic:

```sql
-- Users who signed up in the last 30 days
SELECT * FROM users WHERE created_at >= now() - INTERVAL '30 days';

-- Due dates: 14 days from the creation date
SELECT id, created_at, created_at + INTERVAL '14 days' AS due_date FROM tasks;

-- Interval arithmetic
SELECT INTERVAL '2 hours 30 minutes' + INTERVAL '1 hour 45 minutes';
-- Returns: 04:15:00

-- Age calculation
SELECT age(CURRENT_DATE, '1990-05-15'::DATE);
-- Returns: 35 years 10 mons 5 days (as of 2026-03-20)
```

### Common Timezone Mistakes

**Mistake 1: Using `TIMESTAMP` instead of `TIMESTAMPTZ`**
Already covered above. Always use `TIMESTAMPTZ`.

**Mistake 2: Confusing server timezone with UTC**
Your PostgreSQL server has a timezone setting. If it's set to `UTC` (recommended for servers), `TIMESTAMP` and `TIMESTAMPTZ` appear to behave the same — but they're fundamentally different. The bug appears when any client has a non-UTC timezone.

**Mistake 3: Comparing dates across timezones without conversion**
```sql
-- BAD: "Today" depends on which timezone
WHERE created_at::DATE = CURRENT_DATE

-- GOOD: Explicit timezone conversion
WHERE created_at >= (CURRENT_DATE AT TIME ZONE 'America/New_York')
  AND created_at < ((CURRENT_DATE + 1) AT TIME ZONE 'America/New_York')
```

**Mistake 4: Storing Unix timestamps as INTEGER**
Some developers store timestamps as Unix epoch seconds (INTEGER or BIGINT). This loses all of PostgreSQL's timestamp functionality: timezone handling, date arithmetic, range indexing, partitioning by date. Store as `TIMESTAMPTZ` and use `EXTRACT(EPOCH FROM ...)` when you need the Unix timestamp.

---

## 2.6 UUID

UUID (Universally Unique Identifier) is a 128-bit value stored in 16 bytes. PostgreSQL has a native `UUID` type.

### Generating UUIDs

```sql
-- Modern PostgreSQL (13+): use built-in gen_random_uuid() — no extension needed
SELECT gen_random_uuid();
-- Returns: a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11

-- Older PostgreSQL: use uuid-ossp extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
SELECT uuid_generate_v4();
```

`gen_random_uuid()` generates a version 4 UUID (random). This is the standard for application-generated IDs.

### UUID as Primary Key: Pros and Cons

**Pros:**
- **Globally unique without coordination**: You can generate UUIDs in application code before the INSERT without consulting the database. This is valuable in distributed systems, batch imports, and offline-first architectures.
- **No information leakage**: Sequential IDs reveal how many users/orders/etc. you have. UUIDs don't.
- **Merge-friendly**: Data from different shards or services can be combined without ID collisions.

**Cons:**
- **Larger**: 16 bytes vs 4 bytes (INTEGER) or 8 bytes (BIGINT). This affects every index, every foreign key, every join. On a table with 100 million rows and 5 indexes, that's gigabytes of additional storage.
- **Random insertion pattern**: Random UUIDs (v4) insert into random positions in B-tree indexes, causing page splits and index fragmentation. Sequential IDs insert at the end of the index, which is much more efficient for B-trees.
- **Slower joins and comparisons**: Comparing two 16-byte values is slower than comparing two 8-byte integers.
- **Harder to debug**: Telling someone "check order 12345" is easier than "check order a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11."

### The Random UUID Index Fragmentation Problem

This deserves special attention. A B-tree index stores entries in sorted order. When you insert a new row with a `BIGSERIAL` primary key, the new entry goes at the end of the index — extending the rightmost leaf page. This is cache-friendly and causes minimal page splits.

When you insert a row with a random UUID, the new entry could go anywhere in the index. If the target page is full, PostgreSQL splits it into two pages. Over time, this leads to:
- Pages that are only ~50-70% full instead of ~90% full
- More pages in the index = more disk space, more I/O
- Worse cache hit ratios in shared buffers

**Mitigation strategies:**

1. **UUIDv7** (time-ordered UUIDs): UUIDv7 encodes a timestamp in the most significant bits, so UUIDs are approximately time-ordered. This gives you the benefits of UUIDs (global uniqueness, no coordination) with the B-tree-friendly insertion pattern of sequential IDs.

```sql
-- PostgreSQL 17+ has built-in UUIDv7 support
-- For older versions, generate UUIDv7 in application code (Go, etc.)
-- Go libraries like github.com/google/uuid support UUIDv7
```

2. **Use BIGINT internally, UUID externally**: Use `BIGINT` for the primary key and all foreign keys (fast joins, compact indexes). Add a separate `UUID` column with a unique index for external-facing IDs (API responses, URLs).

```sql
CREATE TABLE orders (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    external_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    user_id BIGINT NOT NULL REFERENCES users(id),
    -- ...
);

-- Internal queries use the fast BIGINT id:
SELECT * FROM orders WHERE id = 12345;
-- API lookups use the UUID:
SELECT * FROM orders WHERE external_id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
```

**What large companies actually do**: It varies. Some use UUIDs everywhere and accept the overhead (Instagram used UUIDs, but custom time-ordered ones). Some use BIGINT internally with UUID externally. Some use custom ID schemes (Twitter's Snowflake, Instagram's custom ID with embedded timestamp). The trend is toward UUIDv7 as the best-of-both-worlds solution.

---

## 2.7 JSONB vs JSON

PostgreSQL has two JSON types: `JSON` and `JSONB`. They look the same from the outside but are completely different internally.

### JSON Type

The `JSON` type stores the input text as-is. Every time you query a JSON column, PostgreSQL re-parses the text. It preserves whitespace, key order, and duplicate keys.

### JSONB Type

The `JSONB` type parses the JSON on input and stores it in a decomposed binary format. Queries don't need to re-parse. It does NOT preserve whitespace or key order, and it removes duplicate keys (last value wins).

### Always Use JSONB

Unless you have a specific reason to preserve the exact JSON text (rare), use `JSONB`. The advantages:

| Feature | JSON | JSONB |
|---|---|---|
| Storage | Raw text | Decomposed binary |
| Insert speed | Faster (no parsing) | Slightly slower (parses on write) |
| Query speed | Very slow (re-parses) | Fast (pre-parsed) |
| Indexing | No | Yes (GIN indexes) |
| Operators | Basic | Full set of containment, existence operators |
| Equality comparison | Not supported | Supported |

### JSONB Operators

```sql
CREATE TABLE user_preferences (
    user_id BIGINT PRIMARY KEY REFERENCES users(id),
    prefs JSONB NOT NULL DEFAULT '{}'::JSONB
);

INSERT INTO user_preferences (user_id, prefs) VALUES
(1, '{"theme": "dark", "notifications": {"email": true, "push": false}, "tags": ["beta", "premium"]}');

-- -> returns JSON object/array (still JSONB)
SELECT prefs -> 'theme' FROM user_preferences WHERE user_id = 1;
-- Returns: "dark" (with quotes — it's a JSON string)

-- ->> returns text (extracts the value as a plain string)
SELECT prefs ->> 'theme' FROM user_preferences WHERE user_id = 1;
-- Returns: dark (without quotes — it's a text value)

-- #> path extraction (nested access, returns JSONB)
SELECT prefs #> '{notifications,email}' FROM user_preferences WHERE user_id = 1;
-- Returns: true

-- #>> path extraction (nested access, returns text)
SELECT prefs #>> '{notifications,email}' FROM user_preferences WHERE user_id = 1;
-- Returns: true (as text)

-- @> containment: does the left JSONB contain the right?
SELECT * FROM user_preferences WHERE prefs @> '{"theme": "dark"}';
-- Returns users with dark theme

-- ? existence: does the key exist?
SELECT * FROM user_preferences WHERE prefs ? 'theme';
-- Returns users who have a "theme" key

-- ?| existence: does ANY of these keys exist?
SELECT * FROM user_preferences WHERE prefs ?| array['theme', 'language'];

-- ?& existence: do ALL of these keys exist?
SELECT * FROM user_preferences WHERE prefs ?& array['theme', 'notifications'];
```

### Indexing JSONB

This is where JSONB truly shines. You can create GIN indexes that make containment and existence queries fast:

```sql
-- GIN index on the entire JSONB column
CREATE INDEX idx_prefs_gin ON user_preferences USING GIN (prefs);

-- This index supports:
-- @> containment queries
-- ? existence queries
-- ?| any-existence queries
-- ?& all-existence queries

-- For queries that extract a specific key with = or range operators:
CREATE INDEX idx_prefs_theme ON user_preferences ((prefs ->> 'theme'));

-- This supports:
SELECT * FROM user_preferences WHERE prefs ->> 'theme' = 'dark';
```

The `jsonb_path_ops` GIN operator class is more compact but only supports `@>`:

```sql
CREATE INDEX idx_prefs_gin_pathops ON user_preferences USING GIN (prefs jsonb_path_ops);
-- Smaller index, only supports @> containment queries, but faster for those
```

### When to Use JSONB vs Proper Columns

**Use JSONB for:**
- User preferences or settings that vary between users
- External API response caching
- Event metadata that varies by event type
- Feature flags or configuration
- Any data where the schema is genuinely dynamic or user-defined

**Use proper columns for:**
- Core business data (amounts, dates, statuses, IDs)
- Anything you need to enforce NOT NULL, UNIQUE, or foreign key constraints on
- Anything you frequently filter, sort, or join on
- Anything that has a known, stable schema

**The anti-pattern**: Storing everything in a single JSONB column ("schemaless" in PostgreSQL). You lose type checking, foreign key integrity, NOT NULL constraints, and column-level indexing. You end up writing complex JSONB queries that are harder to optimize than simple column access. JSONB is a tool for specific use cases, not a replacement for relational schema design.

### Updating JSONB

```sql
-- Set a top-level key
UPDATE user_preferences
SET prefs = prefs || '{"language": "en"}'::JSONB
WHERE user_id = 1;

-- Set a nested key using jsonb_set
UPDATE user_preferences
SET prefs = jsonb_set(prefs, '{notifications,sms}', 'true'::JSONB)
WHERE user_id = 1;

-- Remove a key
UPDATE user_preferences
SET prefs = prefs - 'theme'
WHERE user_id = 1;

-- Remove a nested key
UPDATE user_preferences
SET prefs = prefs #- '{notifications,push}'
WHERE user_id = 1;
```

**Important MVCC reminder**: Every JSONB update creates a new version of the entire row, even if you only changed one nested field. If your JSONB documents are large and updated frequently, this causes significant bloat. For frequently updated sub-fields, consider extracting them into their own columns.

---

## 2.8 Arrays

PostgreSQL supports array columns — a column that holds an ordered list of values of the same type.

```sql
CREATE TABLE articles (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title TEXT NOT NULL,
    tags TEXT[] NOT NULL DEFAULT '{}',
    scores INTEGER[]
);

INSERT INTO articles (title, tags, scores) VALUES
('PostgreSQL Guide', ARRAY['database', 'postgresql', 'tutorial'], ARRAY[95, 87, 92]),
('Go Patterns', '{golang,patterns,backend}', '{88,91}');  -- string literal syntax also works
```

### Querying Arrays

```sql
-- Contains: does the array contain this element?
SELECT * FROM articles WHERE 'postgresql' = ANY(tags);

-- Contains all: does the array contain all of these?
SELECT * FROM articles WHERE tags @> ARRAY['database', 'tutorial'];

-- Overlap: does the array share any elements?
SELECT * FROM articles WHERE tags && ARRAY['golang', 'postgresql'];

-- Array length
SELECT title, array_length(tags, 1) AS tag_count FROM articles;

-- Unnest: expand array into rows (extremely useful for joins and aggregations)
SELECT title, unnest(tags) AS tag FROM articles;
-- Returns:
-- PostgreSQL Guide | database
-- PostgreSQL Guide | postgresql
-- PostgreSQL Guide | tutorial
-- Go Patterns      | golang
-- Go Patterns      | patterns
-- Go Patterns      | backend

-- Access by index (1-based!)
SELECT tags[1] FROM articles;  -- first element

-- Slice
SELECT tags[1:2] FROM articles;  -- first two elements
```

### Indexing Arrays

```sql
-- GIN index for array containment and overlap queries
CREATE INDEX idx_articles_tags ON articles USING GIN (tags);

-- This makes @>, &&, and = ANY() queries fast
```

### When to Use Arrays vs Junction Tables

**Use arrays when:**
- The array values are simple (strings, integers) with no associated metadata
- You don't need to query "which articles have this tag" efficiently (though GIN indexes help)
- The array is small (< 100 elements)
- The values don't need foreign key constraints

**Use a junction table when:**
- Values have associated metadata (tag descriptions, tag categories, creation dates)
- Values need foreign key relationships
- You need efficient bidirectional lookups
- The list could be large

```sql
-- Junction table approach (usually better for core data)
CREATE TABLE tags (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE article_tags (
    article_id BIGINT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    tag_id BIGINT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (article_id, tag_id)
);

-- vs. Array approach (simpler for lightweight, denormalized data)
-- Already shown above: tags TEXT[] on the articles table
```

---

## 2.9 ENUM Types

PostgreSQL `ENUM` is a data type consisting of a static, ordered set of string values.

```sql
CREATE TYPE order_status AS ENUM ('pending', 'processing', 'shipped', 'delivered', 'cancelled');

CREATE TABLE orders (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    status order_status NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO orders (user_id, status) VALUES (1, 'pending');
INSERT INTO orders (user_id, status) VALUES (1, 'invalid_status');
-- ERROR: invalid input value for enum order_status: "invalid_status"
```

### ENUM Advantages

- **Type safety**: Only valid values can be inserted
- **Compact storage**: Stored as 4 bytes internally (an integer ordinal), not as a string
- **Ordering**: Values have an implicit order based on their position in the CREATE TYPE statement
- **Readable**: Queries show the string values, not numbers

### ENUM's Painful Limitation: Migrations

This is the reason many senior engineers avoid ENUMs:

```sql
-- Adding a new value: EASY (PostgreSQL 9.1+)
ALTER TYPE order_status ADD VALUE 'refunded';
-- But: you CANNOT add it in a specific position before PostgreSQL 9.1
-- In 9.1+: ALTER TYPE order_status ADD VALUE 'refunded' AFTER 'delivered';

-- Removing a value: IMPOSSIBLE without recreating the type
-- There is no ALTER TYPE ... REMOVE VALUE

-- Renaming a value: possible in PostgreSQL 10+
ALTER TYPE order_status RENAME VALUE 'cancelled' TO 'canceled';

-- Changing the order: IMPOSSIBLE without recreating the type
```

To remove an ENUM value or reorder values, you must:
1. Create a new ENUM type
2. ALTER every column and every index using the old type
3. DROP the old type
4. Rename the new type

This is painful for large tables in production because altering the column type requires a table rewrite (rewrites every single row).

### The Alternative: TEXT with CHECK Constraint

Many production systems use `TEXT` with a `CHECK` constraint instead of ENUMs:

```sql
CREATE TABLE orders (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'shipped', 'delivered', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Advantages over ENUM:**
- Adding a value: `ALTER TABLE orders DROP CONSTRAINT orders_status_check; ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN (..., 'refunded'));` — no table rewrite needed.
- Removing a value: Same approach, just update the CHECK constraint.
- `TEXT` is standard and works with every tool and ORM without special handling.

**Disadvantages vs ENUM:**
- More storage (variable-length text vs 4-byte ordinal) — but negligible for most tables.
- No built-in ordering by enum position.
- The CHECK constraint is a string that's harder to introspect than an ENUM type.

### Another Alternative: Lookup/Reference Table

```sql
CREATE TABLE order_statuses (
    id SMALLINT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    display_order SMALLINT NOT NULL
);

INSERT INTO order_statuses VALUES
(1, 'pending', 1),
(2, 'processing', 2),
(3, 'shipped', 3),
(4, 'delivered', 4),
(5, 'cancelled', 5);

CREATE TABLE orders (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    status_id SMALLINT NOT NULL REFERENCES order_statuses(id) DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

This is the most flexible approach: adding, removing, renaming, and reordering values are all simple DML operations (INSERT, DELETE, UPDATE on the lookup table). The downside is that every query showing the status requires a JOIN.

**What large companies actually do**: It depends on the team. Some use ENUMs sparingly for values that truly never change (e.g., credit/debit transaction types). Many prefer TEXT with CHECK constraints for simplicity. Some use lookup tables when they need metadata on the statuses (display labels, colors, permissions). The trend is away from ENUMs due to migration pain.

---

## 2.10 BYTEA — Binary Data

`BYTEA` stores raw binary data (byte strings). It's the equivalent of `BLOB` in other databases.

```sql
CREATE TABLE file_attachments (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    content BYTEA NOT NULL,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### When to Use BYTEA

**Use BYTEA for:**
- Small binary data (< 1 MB): encryption keys, hashes, small icons, thumbnails
- Data that needs transactional guarantees (the file is committed or rolled back with the rest of the transaction)

**Don't use BYTEA for:**
- Large files (images, videos, PDFs). Store these in object storage (S3, GCS) and save the URL/path in the database.
- The reason: large BYTEA values are TOASTed (stored in a separate TOAST table), which adds overhead. Every UPDATE to the row re-writes the BYTEA value even if it didn't change (MVCC full-row copies). This causes massive table bloat for large values.

### Working with BYTEA

```sql
-- Insert binary data (hex format)
INSERT INTO file_attachments (filename, mime_type, content)
VALUES ('icon.png', 'image/png', '\x89504e470d0a1a0a...'::BYTEA);

-- Insert from application code (Go/pgx handles this via []byte parameters)
-- In Go: db.Exec(ctx, "INSERT INTO ... VALUES ($1, $2, $3)", name, mime, fileBytes)

-- Get byte length
SELECT filename, octet_length(content) AS size_bytes FROM file_attachments;

-- Hash binary data
SELECT filename, encode(sha256(content), 'hex') AS content_hash FROM file_attachments;
```

---

## 2.11 SERIAL vs BIGSERIAL vs IDENTITY

All three are ways to create auto-incrementing integer columns. They look similar but have important differences.

### SERIAL / BIGSERIAL (Legacy Approach)

```sql
-- SERIAL is shorthand — PostgreSQL expands it to:
CREATE TABLE orders (
    id SERIAL PRIMARY KEY
);
-- is equivalent to:
CREATE SEQUENCE orders_id_seq;
CREATE TABLE orders (
    id INTEGER NOT NULL DEFAULT nextval('orders_id_seq')
);
ALTER SEQUENCE orders_id_seq OWNED BY orders.id;
```

`SERIAL` creates an `INTEGER` column. `BIGSERIAL` creates a `BIGINT` column.

**Problems with SERIAL:**
- The column is not technically constrained to only use the sequence — you can INSERT an explicit value, potentially causing a conflict later when the sequence catches up.
- `SERIAL` creates an implicit dependency between the table and a sequence object that's not always obvious.
- The column is `NOT NULL` but not `GENERATED` — some ORMs and tools don't treat it as a true auto-generated column.

### IDENTITY (Modern Approach — Use This)

```sql
-- GENERATED ALWAYS AS IDENTITY: prevents manual value insertion
CREATE TABLE orders (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- ...
);

-- GENERATED BY DEFAULT AS IDENTITY: allows manual value insertion (like SERIAL)
CREATE TABLE orders (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    -- ...
);
```

**`GENERATED ALWAYS`** means PostgreSQL always generates the value. If you try to INSERT an explicit value, you get an error (unless you use `OVERRIDING SYSTEM VALUE`, which is an explicit opt-in).

**`GENERATED BY DEFAULT`** means PostgreSQL generates a value if you don't provide one, but you CAN provide an explicit value. This behaves like SERIAL.

**Always prefer `GENERATED ALWAYS AS IDENTITY`** for primary keys. It prevents accidental manual insertion of IDs that could collide with future generated values.

```sql
-- Production example
CREATE TABLE users (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- This works:
INSERT INTO users (email) VALUES ('alice@example.com');
-- id is automatically generated

-- This fails (which is good — prevents ID collisions):
INSERT INTO users (id, email) VALUES (999, 'bob@example.com');
-- ERROR: cannot insert a non-DEFAULT value into column "id"

-- If you really need to (data migration), explicitly override:
INSERT INTO users (id, email) OVERRIDING SYSTEM VALUE VALUES (999, 'bob@example.com');
```

### Sequences Under the Hood

Both SERIAL and IDENTITY use **sequences** internally. A sequence is a database object that generates unique integers. Key properties:

- Sequences are **not transactional**: If you call `nextval()` and then ROLLBACK the transaction, the sequence value is consumed. You'll have a gap. This is by design — making sequences transactional would make them a massive bottleneck.
- Gaps are normal and expected. Never write application logic that assumes IDs are contiguous.
- Sequences are very fast — they use lightweight locking to avoid contention.

```sql
-- See the current sequence value (without advancing it)
SELECT currval('users_id_seq');

-- See the next value (advances the sequence)
SELECT nextval('users_id_seq');

-- Reset a sequence (dangerous — only for dev/testing)
ALTER SEQUENCE users_id_seq RESTART WITH 1;
```

---

## 2.12 Custom Domain Types

A **domain** is a custom data type based on an existing type with additional constraints. It's a way to enforce business rules at the type level.

```sql
-- Email domain: TEXT with a basic format check
CREATE DOMAIN email_address AS TEXT
    CHECK (VALUE ~ '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$');

-- Positive amount: NUMERIC that must be positive
CREATE DOMAIN positive_amount AS NUMERIC(12, 2)
    CHECK (VALUE > 0);

-- Non-empty text: TEXT that can't be empty or just whitespace
CREATE DOMAIN non_empty_text AS TEXT
    CHECK (VALUE IS NOT NULL AND trim(VALUE) <> '');

-- Use them in tables:
CREATE TABLE invoices (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    recipient_email email_address NOT NULL,
    amount positive_amount NOT NULL,
    description non_empty_text NOT NULL
);

INSERT INTO invoices (recipient_email, amount, description) VALUES
('alice@example.com', 150.00, 'Consulting services');

-- These all fail:
INSERT INTO invoices (recipient_email, amount, description) VALUES
('not-an-email', 150.00, 'Test');         -- violates email_address CHECK
INSERT INTO invoices (recipient_email, amount, description) VALUES
('alice@example.com', -50.00, 'Test');     -- violates positive_amount CHECK
INSERT INTO invoices (recipient_email, amount, description) VALUES
('alice@example.com', 150.00, '   ');      -- violates non_empty_text CHECK
```

**When to use domains:**
- When the same validation applies to the same "kind" of data across multiple tables (email addresses, phone numbers, currency amounts)
- When you want to centralize a constraint so changing it updates all tables using the domain

**When not to use domains:**
- For one-off constraints on a single column — just use a `CHECK` constraint directly
- If the constraint might need to differ between tables

---

## 2.13 Type Selection Guide for Common Backend Scenarios

This is the reference table you'll come back to when designing schemas.

| Scenario | Recommended Type | Reasoning |
|---|---|---|
| **Primary key** | `BIGINT GENERATED ALWAYS AS IDENTITY` | Fast, compact, index-friendly. Use UUID for distributed systems. |
| **External-facing ID** | `UUID` (separate column) | No information leakage, globally unique |
| **User email** | `TEXT` with CHECK or domain | No artificial length limit needed |
| **User display name** | `TEXT` with CHECK constraint on length | Business rule, not storage rule |
| **Country code** | `VARCHAR(2)` or `CHAR(2)` | Fixed format, ISO standard |
| **Currency code** | `VARCHAR(3)` or `CHAR(3)` | Fixed format, ISO 4217 |
| **Money / prices** | `NUMERIC(12,2)` or `BIGINT` (cents) | Exact arithmetic; BIGINT-cents for performance-critical paths |
| **Quantity / count** | `INTEGER` with CHECK (value >= 0) | Range is sufficient, enforce non-negative |
| **Percentage** | `NUMERIC(5,2)` with CHECK (0-100) | Exact decimals, bounded range |
| **Latitude / longitude** | `DOUBLE PRECISION` | Approximate is fine; use PostGIS `GEOGRAPHY` for distance queries |
| **Timestamps** | `TIMESTAMPTZ` | Always timezone-aware. No exceptions. |
| **Date only** | `DATE` | Calendar dates with no time component |
| **Duration** | `INTERVAL` | Native date/time arithmetic |
| **Status / state** | `TEXT` with CHECK or ENUM | CHECK is more migration-friendly |
| **Boolean flags** | `BOOLEAN NOT NULL DEFAULT FALSE` | Never nullable booleans |
| **Tags / labels** | `TEXT[]` or junction table | Arrays for simple; junction for rich metadata |
| **User preferences** | `JSONB` | Semi-structured, varies per user |
| **API response cache** | `JSONB` | Schema varies by external API |
| **Audit metadata** | `JSONB` | Change details vary by operation |
| **File content (small)** | `BYTEA` | < 1 MB, needs transactional guarantees |
| **File content (large)** | Store in S3/GCS, save URL as `TEXT` | Database is not an object store |
| **IP address** | `INET` | Native type with operators and indexing |
| **MAC address** | `MACADDR` | Native type |
| **Network range** | `CIDR` | Native type with containment operators |
| **Integer range** | `INT4RANGE` / `INT8RANGE` | Range types with overlap, containment |
| **Date range** | `DATERANGE` / `TSTZRANGE` | Range types for bookings, availability |

### Complete Example: A Users Table with Thoughtful Type Choices

```sql
CREATE TABLE users (
    -- BIGINT IDENTITY: fast PK, no overflow risk, prevents manual ID insertion
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- UUID for API responses: no info leakage, globally unique
    external_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,

    -- TEXT: no arbitrary length limit; CHECK for business rules
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,

    -- TIMESTAMPTZ: always timezone-aware
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- BOOLEAN NOT NULL: no three-valued logic headaches
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    email_verified BOOLEAN NOT NULL DEFAULT FALSE,

    -- TEXT with CHECK: migration-friendly status field
    role TEXT NOT NULL DEFAULT 'member'
        CHECK (role IN ('member', 'admin', 'owner')),

    -- JSONB: semi-structured preferences that vary per user
    preferences JSONB NOT NULL DEFAULT '{}'::JSONB,

    -- INET: native IP type for last login tracking
    last_login_ip INET,

    -- Business rule constraints
    CONSTRAINT email_format CHECK (email ~ '^[^@]+@[^@]+\.[^@]+$'),
    CONSTRAINT display_name_length CHECK (char_length(display_name) BETWEEN 1 AND 100)
);

-- Indexes chosen based on query patterns:
CREATE INDEX idx_users_created_at ON users (created_at);
CREATE INDEX idx_users_role ON users (role) WHERE role != 'member';  -- partial: most users are members
CREATE INDEX idx_users_email_pattern ON users (email text_pattern_ops);  -- for LIKE 'prefix%' queries
CREATE INDEX idx_users_preferences ON users USING GIN (preferences);  -- for JSONB containment queries
```

Every type choice in this table has a reason. Every constraint prevents a class of bugs. Every index serves a real query pattern. This is what production schemas look like at companies that take data integrity seriously.

---

→ next: chapter03_schema_design.md
