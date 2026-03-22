# Chapter 1 — How PostgreSQL Actually Works (The Mental Model)

## Table of Contents

- [1.1 What PostgreSQL Is and Why It Matters](#11-what-postgresql-is-and-why-it-matters)
- [1.2 How PostgreSQL Differs from Other Databases](#12-how-postgresql-differs-from-other-databases)
- [1.3 The Full Journey of a Query](#13-the-full-journey-of-a-query)
- [1.4 PostgreSQL Architecture in Detail](#14-postgresql-architecture-in-detail)
- [1.5 The Query Planner — Your Silent Partner](#15-the-query-planner--your-silent-partner)
- [1.6 MVCC — The Most Important Concept You Must Understand](#16-mvcc--the-most-important-concept-you-must-understand)
- [1.7 How PostgreSQL Stores Data on Disk](#17-how-postgresql-stores-data-on-disk)
- [1.8 The Write-Ahead Log (WAL)](#18-the-write-ahead-log-wal)
- [1.9 The Connection Model](#19-the-connection-model)
- [1.10 How This Mental Model Changes How You Code](#110-how-this-mental-model-changes-how-you-code)
- [1.11 Common Misconceptions That Lead to Bad Decisions](#111-common-misconceptions-that-lead-to-bad-decisions)

---

## 1.1 What PostgreSQL Is and Why It Matters

PostgreSQL is an open-source, object-relational database management system (ORDBMS). That word "object-relational" is not marketing fluff — it means PostgreSQL supports not just tables and rows (the relational part) but also custom types, inheritance, and extensibility (the object part) at its core.

PostgreSQL has been in active development since 1986 (originating from UC Berkeley's POSTGRES project). It is the database of choice at companies like Apple, Instagram, Spotify, Reddit, Twitch, and the majority of YC startups. It is not a "lightweight" database. It is a full production-grade system capable of handling billions of rows and thousands of concurrent connections when configured correctly.

**Why does this matter to you as a backend engineer?**

Because PostgreSQL is not just a "place to store data." It is a **query execution engine**, a **concurrency control system**, a **data integrity enforcer**, and a **transaction coordinator** — all in one. The decisions you make about how to use it directly impact whether your application can serve 100 users or 100,000 users. Understanding how it works internally is the difference between writing code that accidentally locks your entire database and code that handles 10,000 concurrent requests cleanly.

---

## 1.2 How PostgreSQL Differs from Other Databases

Before we go deep into PostgreSQL internals, let's place it in context.

### PostgreSQL vs. MySQL

| Aspect | PostgreSQL | MySQL (InnoDB) |
|---|---|---|
| **Standards compliance** | Very strict SQL standard compliance | Looser; historically allowed invalid data silently |
| **MVCC implementation** | Stores old row versions in the main table (heap) | Stores old row versions in a separate undo log |
| **Default isolation** | READ COMMITTED | REPEATABLE READ |
| **JSON support** | Native JSONB with indexing, operators, path queries | JSON support exists but less mature |
| **Extensibility** | Extensions (PostGIS, pg_trgm, etc.), custom types, custom operators | Plugin system, less flexible |
| **Concurrency** | True serializable isolation via SSI | Serializable = gap locking (different guarantees) |
| **Replication** | Logical + physical replication built in | Binary log replication |
| **Partitioning** | Declarative partitioning (range, list, hash) | Similar partitioning since 5.7+ |

The single biggest practical difference: PostgreSQL's MVCC stores old row versions in the same heap as current rows. This has massive implications for how you think about vacuuming, bloat, and performance — we'll cover this in detail shortly.

### PostgreSQL vs. SQLite

SQLite is an embedded database — it runs inside your application process and stores everything in a single file. There is no separate server process, no network protocol, and no concurrent write access (only one writer at a time by default with WAL mode allowing concurrent reads).

PostgreSQL is a full client-server database. You connect to it over a network (or Unix socket). It handles many concurrent readers and writers simultaneously. You would use SQLite for mobile apps, browser storage, or development/testing. You would use PostgreSQL for any backend service serving real users.

### PostgreSQL vs. MongoDB

MongoDB is a document database — it stores data as JSON-like documents (BSON) in collections rather than rows in tables. There are no JOINs in the traditional sense; instead, you denormalize data or use the `$lookup` aggregation stage.

PostgreSQL gives you the relational model (tables, foreign keys, JOINs, constraints) AND document storage via JSONB columns. The key tradeoff: MongoDB gives you schema flexibility at the cost of data integrity guarantees. PostgreSQL gives you strong data integrity with the option of flexible JSONB columns where you need them. At large companies, PostgreSQL with JSONB often replaces what would have been a separate MongoDB deployment.

---

## 1.3 The Full Journey of a Query

When your Go service executes a query like:

```sql
SELECT u.name, u.email, COUNT(o.id) AS order_count
FROM users u
JOIN orders o ON o.user_id = u.id
WHERE u.created_at > '2024-01-01'
GROUP BY u.id, u.name, u.email
ORDER BY order_count DESC
LIMIT 20;
```

Here is exactly what happens inside PostgreSQL, step by step:

### Step 1: Connection and Authentication

Your application (via `pgx` or `database/sql`) opens a TCP connection to PostgreSQL (default port 5432). PostgreSQL forks a new **backend process** dedicated to your connection. This process handles all your queries for the lifetime of the connection. Authentication happens (password, md5, scram-sha-256, certificate, etc.).

### Step 2: Query Transmission

Your SQL string is sent over the PostgreSQL wire protocol. If you're using prepared statements (which `pgx` does by default), this is a two-step process: a `Parse` message sends the query template, and a `Bind` message sends the parameter values. If you're sending a simple query, the full SQL string goes in one message.

### Step 3: Parsing

The **parser** takes your SQL string and converts it into a **parse tree** — an internal tree representation of the query. This is where syntax errors are caught. The parser doesn't know anything about your actual tables yet; it just validates that your SQL is grammatically correct.

For our query, the parse tree would represent: "This is a SELECT with a JOIN, a WHERE clause, GROUP BY, ORDER BY, and LIMIT."

### Step 4: Analysis / Semantic Analysis

The **analyzer** (sometimes called the rewriter) takes the parse tree and resolves it against the **system catalog** — PostgreSQL's internal metadata tables that describe all your tables, columns, types, indexes, and constraints.

This is where PostgreSQL checks:
- Does the `users` table exist?
- Does it have columns `name`, `email`, `created_at`?
- Does the `orders` table exist with a `user_id` column?
- Is the type of `u.created_at` compatible with the string `'2024-01-01'`?

If anything doesn't match, you get an error like `ERROR: column "users.nmae" does not exist`. The output is a **query tree** — the parse tree with all identifiers resolved to actual database objects.

### Step 5: Rewriting

The **rewriter** applies any rules to the query tree. The most common example: if `users` were actually a view (a stored query), the rewriter would expand the view definition into the query tree. This step also handles row-level security policies if enabled.

### Step 6: Planning / Optimization

This is where the magic happens. The **query planner** (also called the optimizer) takes the query tree and generates an **execution plan** — a tree of physical operations that describes exactly how PostgreSQL will retrieve your data.

The planner considers:
- Which indexes are available on `users.created_at`, `orders.user_id`?
- How many rows does the `users` table have? How many match `created_at > '2024-01-01'`?
- Should it use a sequential scan, index scan, or bitmap scan?
- For the JOIN: should it use a nested loop, hash join, or merge join?
- For ORDER BY: should it sort in-memory or use an index?

The planner uses **table statistics** (collected by `ANALYZE` and autovacuum) to estimate row counts and choose the cheapest plan. "Cheapest" is measured in a cost model that estimates disk I/O and CPU work.

We cover the planner in enormous detail in Chapter 6.

### Step 7: Execution

The **executor** takes the plan and actually runs it. It reads data pages from disk (or the shared buffer cache), applies filters, performs joins, sorts results, and builds the result set.

For our query, execution might look like:
1. Scan an index on `users.created_at` to find users created after 2024-01-01
2. For each matching user, look up their orders via an index on `orders.user_id`
3. Count the orders per user (aggregation)
4. Sort by the count descending
5. Return the first 20 rows

### Step 8: Result Transmission

The result rows are sent back to your application over the wire protocol. For large result sets, PostgreSQL streams rows in batches rather than materializing the entire result in memory (this depends on your cursor usage — more on that in later chapters).

**The key insight:** Every query goes through all of these steps. Understanding this pipeline tells you where performance problems can occur:
- Bad parsing? No — parsing is fast.
- Bad planning? YES — the planner picks a bad plan because of stale statistics or missing indexes.
- Bad execution? YES — the plan is fine but the data is too large, or locks are blocking it.

---

## 1.4 PostgreSQL Architecture in Detail

Let's look at the physical architecture of a running PostgreSQL instance.

```
                     ┌──────────────────────────────────────────────┐
                     │            PostgreSQL Instance                │
                     │                                              │
  Client             │  ┌────────────┐  ┌────────────┐             │
  Connection ───────►│  │  Backend   │  │  Backend   │  ...        │
  (your Go app)      │  │  Process   │  │  Process   │             │
                     │  │  (PID 1)   │  │  (PID 2)   │             │
                     │  └─────┬──────┘  └─────┬──────┘             │
                     │        │               │                     │
                     │        ▼               ▼                     │
                     │  ┌─────────────────────────────────┐        │
                     │  │        Shared Buffers            │        │
                     │  │   (cached data pages in RAM)     │        │
                     │  └─────────────┬───────────────────┘        │
                     │                │                             │
                     │        ┌───────┴────────┐                   │
                     │        ▼                ▼                   │
                     │  ┌──────────┐    ┌───────────┐             │
                     │  │   Data   │    │    WAL     │             │
                     │  │  Files   │    │   Files    │             │
                     │  │ (heap,   │    │ (write-    │             │
                     │  │  index)  │    │  ahead log)│             │
                     │  └──────────┘    └───────────┘             │
                     │                                              │
                     │  Background Processes:                       │
                     │  ┌────────────────────────────────────┐     │
                     │  │ Postmaster (main process)          │     │
                     │  │ Background Writer                  │     │
                     │  │ Checkpointer                       │     │
                     │  │ WAL Writer                         │     │
                     │  │ Autovacuum Launcher + Workers      │     │
                     │  │ Stats Collector                    │     │
                     │  │ Logical Replication Workers        │     │
                     │  └────────────────────────────────────┘     │
                     └──────────────────────────────────────────────┘
```

### The Postmaster

When you start PostgreSQL, one process starts: the **postmaster**. This is the supervisor process. It listens for incoming connections and forks a new **backend process** for each client connection. It also starts and supervises all the background processes.

### Backend Processes (One Per Connection)

Every time your Go application opens a connection to PostgreSQL, the postmaster forks a new OS-level process. This is not a thread — it is a full process with its own memory space. This backend process is exclusively yours for the lifetime of the connection. It parses your queries, plans them, executes them, and sends results back.

This has critical implications:
- **Memory**: Each backend uses memory (typically 5-10 MB minimum, more under load). 500 connections = 500 processes = significant memory usage.
- **Context switching**: The OS must schedule all these processes. At thousands of connections, context switching overhead becomes significant.
- **Connection pooling**: This is why PgBouncer (a connection pooler) is mandatory at scale — it multiplexes many application connections onto a smaller number of PostgreSQL backend processes.

### Shared Buffers

Shared buffers are PostgreSQL's main cache — a region of shared memory where data pages read from disk are cached. When a backend process needs to read a row, it first checks shared buffers. If the page is there (a "buffer hit"), no disk I/O is needed. If not (a "buffer miss"), the page is read from disk into shared buffers.

The default `shared_buffers` is 128MB, which is far too small for production. A common starting point is 25% of total RAM (e.g., 4GB on a 16GB machine).

Every backend process reads from and writes to the same shared buffers. This is how data is shared between connections — they're not each reading their own copy from disk.

### Background Processes

These processes run continuously to keep PostgreSQL healthy:

- **Background Writer**: Periodically writes "dirty" (modified) pages from shared buffers to disk. This smooths out I/O rather than writing everything at checkpoint time.
- **Checkpointer**: Periodically writes ALL dirty pages to disk and creates a checkpoint record in the WAL. After a crash, PostgreSQL only needs to replay WAL from the last checkpoint.
- **WAL Writer**: Flushes WAL data from memory to the WAL files on disk. This is what guarantees durability.
- **Autovacuum Launcher**: Starts autovacuum worker processes to clean up dead row versions (critical — we'll cover this extensively).
- **Stats Collector**: Collects statistics about table access patterns, row counts, etc. These stats are used by the query planner.

---

## 1.5 The Query Planner — Your Silent Partner

The query planner is probably the single most important component for you as an application developer to understand. Every query you write is subject to the planner's decisions, and the planner's decisions determine whether your query runs in 1ms or 10 seconds.

### What the Planner Does

Given a query, the planner generates multiple possible execution plans and picks the one with the lowest estimated cost. For a simple query like:

```sql
SELECT * FROM users WHERE email = 'alice@example.com';
```

The planner considers at least two plans:
1. **Sequential scan**: Read every single row in the `users` table and check if `email = 'alice@example.com'`. Cost: proportional to the total number of rows.
2. **Index scan** (if an index on `email` exists): Look up `'alice@example.com'` in the B-tree index, find the pointer to the actual row, read that one row. Cost: proportional to the height of the B-tree (typically 3-4 levels, so 3-4 page reads).

For a table with 10 million rows, the difference between these two plans is the difference between reading 10 million rows and reading 1 row. This is why indexes matter — but the planner has to decide which plan to use.

### How the Planner Decides

The planner uses **statistics** about your data to make these decisions. These statistics include:
- How many rows are in each table (`reltuples` in `pg_class`)
- How many distinct values each column has (`n_distinct` in `pg_stats`)
- The distribution of values in each column (most common values, histogram boundaries)
- Correlation between physical order and logical order

These statistics are collected by the `ANALYZE` command, which is run automatically by autovacuum. If your statistics are stale (you loaded a million rows and autovacuum hasn't run yet), the planner may make bad decisions.

**This is the most common cause of sudden query slowdowns in production**: the planner chooses a bad plan because its statistics don't match reality.

### Cost Model

The planner assigns a numeric cost to each possible plan. The cost model is based on:
- `seq_page_cost` (1.0 by default): Cost of reading one page sequentially from disk
- `random_page_cost` (4.0 by default): Cost of reading one page randomly from disk (seek time)
- `cpu_tuple_cost` (0.01): Cost of processing one row
- `cpu_index_tuple_cost` (0.005): Cost of processing one index entry
- `cpu_operator_cost` (0.0025): Cost of executing one operator

Notice that `random_page_cost` is 4x `seq_page_cost` by default. This reflects the reality of spinning hard drives where random reads require disk head movement. **On SSDs**, random reads are much closer in cost to sequential reads, so you should set `random_page_cost` to 1.1-1.5 on SSD-backed systems. Not doing this causes the planner to avoid index scans when they would actually be faster.

### You'll Use EXPLAIN Constantly

The way you see what the planner decided is with `EXPLAIN`:

```sql
EXPLAIN SELECT * FROM users WHERE email = 'alice@example.com';
```

Output:
```
Index Scan using users_email_idx on users  (cost=0.43..8.45 rows=1 width=72)
  Index Cond: (email = 'alice@example.com'::text)
```

And to see actual execution statistics:
```sql
EXPLAIN ANALYZE SELECT * FROM users WHERE email = 'alice@example.com';
```

Output:
```
Index Scan using users_email_idx on users  (cost=0.43..8.45 rows=1 width=72) (actual time=0.028..0.030 rows=1 loops=1)
  Index Cond: (email = 'alice@example.com'::text)
Planning Time: 0.085 ms
Execution Time: 0.052 ms
```

We'll spend an entire chapter learning to read these plans. For now, just know: **`EXPLAIN ANALYZE` is the single most important tool for understanding why your query is slow or fast.**

---

## 1.6 MVCC — The Most Important Concept You Must Understand

MVCC (Multi-Version Concurrency Control) is the mechanism PostgreSQL uses to allow multiple transactions to read and write data simultaneously without blocking each other. If you understand MVCC, you understand why PostgreSQL behaves the way it does in every concurrency scenario.

### The Problem MVCC Solves

Imagine two concurrent operations:
1. **Transaction A**: Reading a report that sums all order amounts
2. **Transaction B**: Inserting a new order

Without MVCC, you'd have two bad options:
- **Lock the entire table**: Transaction A locks the orders table while reading. Transaction B has to wait. This is terrible for throughput.
- **No locking**: Transaction A reads some rows, Transaction B inserts a new order, Transaction A reads more rows and might include the new order — giving an inconsistent sum (reading data that appeared mid-query).

### How MVCC Works in PostgreSQL

MVCC solves this by keeping **multiple versions** of each row. When a row is updated or deleted, PostgreSQL doesn't overwrite the old data. Instead, it creates a new version of the row and marks the old version as "dead" (but still physically present in the table).

Every row in PostgreSQL has two hidden system columns:
- `xmin`: The transaction ID of the transaction that **created** this row version
- `xmax`: The transaction ID of the transaction that **deleted** (or updated) this row version. If 0, the row is still "live."

You can actually see these:

```sql
SELECT xmin, xmax, id, name FROM users LIMIT 5;
```

```
 xmin  | xmax | id |  name
-------+------+----+--------
 1050  |    0 |  1 | Alice
 1050  |    0 |  2 | Bob
 1055  | 1060 |  3 | Charlie   -- updated by txn 1060
 1060  |    0 |  3 | Charlie2  -- new version from txn 1060
 1070  |    0 |  4 | Diana
```

### Visibility Rules

When a transaction reads data, it uses a **snapshot** — a record of which transactions were committed at the time the snapshot was taken. A row version is visible to a transaction if:

1. `xmin` is a committed transaction that committed **before** the snapshot was taken, AND
2. `xmax` is either 0 (not deleted) OR is a transaction that was NOT committed at snapshot time

This means:
- **Readers never block writers**: Transaction A can read old versions of rows while Transaction B modifies them.
- **Writers never block readers**: Transaction B can update a row while Transaction A is reading the old version.
- **Writers block writers**: If two transactions try to update the same row, the second one waits for the first to commit or rollback.

### A Concrete Example

```
Time    Transaction A              Transaction B
─────────────────────────────────────────────────────────
T1      BEGIN;
T2      SELECT balance FROM        
        accounts WHERE id = 1;
        → sees balance = 1000
T3                                 BEGIN;
T4                                 UPDATE accounts 
                                   SET balance = 500 
                                   WHERE id = 1;
T5      SELECT balance FROM
        accounts WHERE id = 1;
        → still sees balance = 1000!
        (A's snapshot was taken before
         B's update)
T6                                 COMMIT;
T7      SELECT balance FROM
        accounts WHERE id = 1;
        → Now what A sees depends on 
          isolation level:
          READ COMMITTED: sees 500
          REPEATABLE READ: still sees 1000
T8      COMMIT;
```

At T5, there are two physical versions of the row for account 1:
- Version 1: `xmin=100, xmax=200, balance=1000` (original, being deleted by txn 200)
- Version 2: `xmin=200, xmax=0, balance=500` (new version from txn 200)

Transaction A sees version 1 because transaction 200 hasn't committed yet in A's snapshot.

### The Critical Consequence: Dead Rows and VACUUM

Because PostgreSQL doesn't overwrite old row versions, every UPDATE and DELETE leaves dead row versions behind in the table's physical storage. These dead rows:
- Take up disk space
- Slow down sequential scans (the executor has to skip over them)
- Cause "table bloat" — the table file grows even if the logical data doesn't

This is where **VACUUM** comes in. VACUUM's job is to find dead row versions that are no longer visible to ANY active transaction and mark that space as reusable. **Autovacuum** is a background process that does this automatically.

If autovacuum can't keep up (common on very busy tables), dead rows accumulate, the table bloats, and queries get progressively slower. This is one of the most common performance problems in production PostgreSQL and we dedicate significant coverage to it in Chapter 11.

**Senior engineers know**: MVCC is not free. Every UPDATE creates a dead row version. Tables with heavy update patterns (counters, status columns, queue-like patterns) accumulate dead rows rapidly and need aggressive autovacuum tuning.

---

## 1.7 How PostgreSQL Stores Data on Disk

Understanding physical storage helps you understand why certain queries are fast and others are slow.

### Pages (Blocks)

All data in PostgreSQL is stored in **pages** (also called blocks). A page is a fixed-size chunk of 8 KB. This is the fundamental unit of I/O — PostgreSQL never reads or writes less than one 8 KB page at a time.

When PostgreSQL reads a single row from disk, it actually reads the entire 8 KB page containing that row. If you then read another row on the same page, it's already in memory (in shared buffers).

### Heap Files

A table's data is stored in one or more **heap files**. A heap file is simply a sequence of 8 KB pages. Rows are stored in pages in no particular order — when you INSERT a new row, PostgreSQL puts it in the first page that has enough free space (tracked by the Free Space Map, or FSM).

This "no particular order" part is important:
- A `SELECT * FROM users ORDER BY id` requires sorting even if `id` is the primary key, UNLESS there's an index the planner can use to return rows in order.
- A sequential scan of a heap reads pages 0, 1, 2, 3... in physical order. If your data is correlated with physical order (e.g., rows are inserted in time order and you query by time), sequential scans are efficient. If not (e.g., rows are scattered), random I/O hurts.

### Page Layout

Each 8 KB page has this structure:

```
┌─────────────────────────────────┐
│         Page Header             │  (24 bytes: LSN, flags, free space pointers)
├─────────────────────────────────┤
│      Item Pointers (Line        │  (array of 4-byte pointers)
│      Pointers)                  │  Each points to a tuple within this page
├─────────────────────────────────┤
│                                 │
│        Free Space               │
│                                 │
├─────────────────────────────────┤
│        Tuple Data               │  (actual row data, stored from bottom up)
│  ┌──────────────────────────┐   │
│  │  Tuple Header (23 bytes) │   │  xmin, xmax, ctid, null bitmap, etc.
│  │  Tuple Data (columns)    │   │
│  └──────────────────────────┘   │
│  ┌──────────────────────────┐   │
│  │  Tuple Header            │   │
│  │  Tuple Data              │   │
│  └──────────────────────────┘   │
├─────────────────────────────────┤
│     Special Space (indexes)     │
└─────────────────────────────────┘
```

The item pointer array grows downward from the top. Tuple data is added from the bottom upward. They meet in the middle; when they meet, the page is full.

Each item pointer is called a **CTID** (current tuple ID) and has the format `(page_number, item_number)`. This is how PostgreSQL locates any specific row — for example, CTID `(42, 3)` means page 42, item 3 on that page.

### Tuple Header Overhead

Every single row in PostgreSQL carries a tuple header of at least 23 bytes plus alignment padding (typically 24 bytes total). This means:
- A table of 100 million rows with a single INTEGER column (4 bytes) actually uses ~24 + 4 = 28 bytes per row, plus item pointer overhead. The overhead is significant for narrow rows.
- This is why PostgreSQL isn't ideal for very narrow, very high-volume data (counters, metrics) without careful schema design.

### TOAST (The Oversized-Attribute Storage Technique)

An 8 KB page can't store a row larger than about 2 KB comfortably (the hard limit is that a single row must fit in one page). For large values — long text fields, big JSONB documents, large bytea — PostgreSQL uses TOAST.

When a column value is too large, PostgreSQL:
1. First tries to **compress** it (using pglz or lz4)
2. If it's still too large, **moves it to a separate TOAST table** and stores a pointer in the main row

This happens automatically — you don't configure it. But it means:
- Selecting a large JSONB column that has been TOASTed requires extra I/O to read from the TOAST table
- `SELECT *` on a table with large text columns reads TOAST data you might not need — another reason to select only the columns you need

### Index Files

Indexes are stored in separate files from the heap. A B-tree index, for example, is a tree of 8 KB pages where each page contains index entries (key value + CTID pointer to the heap row). When you do an index scan, PostgreSQL:
1. Traverses the B-tree pages to find the matching key
2. Gets the CTID (e.g., page 42, item 3)
3. Reads page 42 from the heap to get the actual row data

This "hop from index to heap" is called a **heap fetch** and is the reason index-only scans (where all needed data is in the index itself) are faster.

### File Organization on Disk

On disk, each table and index is stored as one or more files in the data directory:

```
$PGDATA/base/<database_oid>/<table_filenode>
$PGDATA/base/<database_oid>/<table_filenode>.1    (if > 1GB, a second segment)
$PGDATA/base/<database_oid>/<table_filenode>_fsm  (free space map)
$PGDATA/base/<database_oid>/<table_filenode>_vm   (visibility map)
```

The **visibility map** tracks which pages contain only "all-visible" tuples (visible to all transactions). This is used by:
- Index-only scans: If a page is all-visible, PostgreSQL doesn't need to check the heap — it knows all tuples are visible.
- VACUUM: It can skip all-visible pages since there's nothing to clean up.

---

## 1.8 The Write-Ahead Log (WAL)

The Write-Ahead Log is how PostgreSQL guarantees **durability** — the "D" in ACID. It's also the foundation of replication, point-in-time recovery, and crash recovery.

### The Problem WAL Solves

When you UPDATE a row, PostgreSQL modifies the page in shared buffers (in RAM). If the server crashes before that modified page is written to the data file on disk, the change is lost. But writing every modified page to disk immediately after every change would be painfully slow — data files are large, and random writes to data files are expensive.

### How WAL Works

The WAL is a sequential, append-only log of all changes made to the database. Before any change is made to a data page in shared buffers, a WAL record describing the change is written to the WAL.

The protocol is:
1. Transaction modifies a page in shared buffers (in RAM)
2. A WAL record describing the change is written to the WAL buffer (in RAM)
3. When the transaction COMMITS, the WAL buffer is flushed to disk (WAL files)
4. The modified data page is NOT immediately written to the data file — it will be written later by the background writer or at checkpoint time

This is why it's called "write-AHEAD" — the log is written ahead of the data.

### Why This Is Efficient

WAL writes are sequential (append-only to the end of the log), which is very fast even on spinning disks. Data file writes are random (updating a page in the middle of a multi-GB file), which is slow. By deferring data file writes and ensuring the WAL is on disk, PostgreSQL gets both durability and performance.

### Crash Recovery

If PostgreSQL crashes:
1. On restart, it reads the WAL from the last checkpoint
2. For each WAL record, it checks if the corresponding change is already in the data file
3. If not, it replays the change (this is called "WAL replay" or "recovery")
4. After all WAL records are replayed, the database is in a consistent state

This means **no data is lost** as long as the WAL was flushed to disk before the crash — which it was, because PostgreSQL flushes WAL on COMMIT.

### WAL and Replication

WAL is also how replication works. A primary server streams its WAL records to one or more replica servers. The replicas apply these WAL records to their own data files, keeping an exact copy of the primary's data. This is called **physical (streaming) replication**.

### What This Means for You

- **Durability is guaranteed**: If your COMMIT returns success, the data is durable (on disk in WAL).
- **fsync matters**: PostgreSQL relies on `fsync` to ensure WAL writes are actually on persistent storage. Turning off fsync (don't do this) can lead to data loss on crash.
- **WAL volume**: Heavy write workloads generate a lot of WAL. This affects disk space, replication lag, and backup size.
- **Synchronous commit**: By default, `synchronous_commit = on` means COMMIT waits for WAL to be flushed to disk. You can set it to `off` to get faster commits at the risk of losing the last few milliseconds of transactions on crash. Some companies do this for non-critical data.

---

## 1.9 The Connection Model

PostgreSQL uses a **process-per-connection** model. This is fundamentally different from, say, MySQL (which uses threads) or Node.js (which uses an event loop).

### How It Works

```
Client 1 ──── TCP ────► Backend Process 1 (PID 12345)
Client 2 ──── TCP ────► Backend Process 2 (PID 12346)
Client 3 ──── TCP ────► Backend Process 3 (PID 12347)
   ...                      ...
Client N ──── TCP ────► Backend Process N (PID 12345+N)
```

Each backend process:
- Has its own memory (work_mem for sorting/hashing, temp buffers, etc.)
- Shares access to shared buffers (via shared memory)
- Runs queries sequentially within its own connection (one query at a time per connection)

### The Scaling Problem

If your Go application has 50 instances, each with a connection pool of 20 connections, that's 1,000 PostgreSQL backend processes. Each process uses:
- ~5-10 MB of memory minimum
- An OS process slot
- CPU time for context switching

At 1,000 connections, you're looking at 5-10 GB just for connection overhead, plus massive context switching. PostgreSQL's `max_connections` default is 100 for good reason — it doesn't scale well beyond a few hundred direct connections.

### The Solution: Connection Pooling

This is why **every production PostgreSQL deployment uses a connection pooler**, typically PgBouncer. PgBouncer sits between your application and PostgreSQL:

```
Go Instance 1 (20 connections) ──┐
Go Instance 2 (20 connections) ──┤
Go Instance 3 (20 connections) ──┼──► PgBouncer (50 server connections) ──► PostgreSQL
   ...                           │
Go Instance 50 (20 connections)──┘
```

1,000 application connections are multiplexed onto 50 actual PostgreSQL connections. PgBouncer queues requests when all 50 server connections are busy.

PgBouncer modes:
- **Session mode**: Each client gets a dedicated PostgreSQL connection for the lifetime of the client connection. Minimal multiplexing benefit, but supports all PostgreSQL features.
- **Transaction mode**: A PostgreSQL connection is assigned to a client only for the duration of a transaction. Between transactions, the connection is returned to the pool. Best for most workloads. Limitation: you can't use session-level features (prepared statements, SET commands, LISTEN/NOTIFY) across transactions.
- **Statement mode**: Each individual SQL statement gets a connection. Most aggressive pooling, but you can't use transactions at all. Rarely used.

**What senior engineers do**: Use PgBouncer in transaction mode with a carefully calculated pool size. The optimal number of PostgreSQL connections is typically `2 * CPU_cores + disk_spindles` (or on SSDs, roughly `2-3 * CPU_cores`). Going beyond this rarely helps and often hurts due to contention.

### Go-Specific Connection Pooling

Go's `database/sql` package has a built-in connection pool (`SetMaxOpenConns`, `SetMaxIdleConns`). When using `pgxpool` (from the `pgx` driver), you have a similar pool. These are *application-level* pools — they manage how your Go process shares its connections. You still want PgBouncer between the application pool and PostgreSQL if you have many application instances.

---

## 1.10 How This Mental Model Changes How You Code

Now that you understand how PostgreSQL works internally, here's how it should change your behavior as a backend engineer:

### 1. Respect the Planner — Write Predictable Queries

The planner is very good at optimizing queries, but it can only work with what you give it. If you wrap an indexed column in a function in your WHERE clause:

```sql
-- BAD: The planner can't use an index on created_at
SELECT * FROM orders WHERE EXTRACT(YEAR FROM created_at) = 2024;

-- GOOD: The planner can use an index on created_at
SELECT * FROM orders WHERE created_at >= '2024-01-01' AND created_at < '2025-01-01';
```

The first query applies a function to every row before comparing — it forces a sequential scan. The second query compares the raw column value to constants — the planner can use a range scan on an index.

### 2. Keep Transactions Short

Every open transaction holds a snapshot. As long as your snapshot is active, VACUUM cannot clean up dead rows that might be visible to your snapshot. A single long-running transaction (say, a 30-minute report query) prevents VACUUM from cleaning up dead rows created during those 30 minutes, causing table bloat.

```go
// BAD: Transaction open for the entire loop
tx, _ := db.Begin(ctx)
for _, item := range items {
    // process each item...
    tx.Exec(ctx, "UPDATE ...", item.ID)
}
tx.Commit(ctx)

// GOOD: Batch the work or use short transactions
for batch := range chunks(items, 100) {
    tx, _ := db.Begin(ctx)
    for _, item := range batch {
        tx.Exec(ctx, "UPDATE ...", item.ID)
    }
    tx.Commit(ctx)
}
```

### 3. Don't Over-Connect

If you're running 10 Go services with 50 connections each, that's 500 connections. PostgreSQL handles this poorly. Use PgBouncer and keep the actual PostgreSQL connection count low.

### 4. Understand That UPDATEs Are Expensive

Because of MVCC, every UPDATE creates a new row version and marks the old one as dead. An UPDATE of a single column in a wide row copies the entire row. This means:
- Frequent updates to the same rows cause bloat
- "Counter" patterns (incrementing a view count on every request) are problematic at scale
- Consider batching updates or using separate narrow tables for frequently-updated columns

### 5. SELECT Only What You Need

```sql
-- BAD: Reads all columns, including potentially TOASTed large text/JSONB columns
SELECT * FROM posts WHERE author_id = 42;

-- GOOD: Only reads the columns you actually need
SELECT id, title, created_at FROM posts WHERE author_id = 42;
```

This isn't just about network transfer. It affects:
- Whether an index-only scan is possible (if all needed columns are in the index)
- Whether TOAST tables need to be read
- How much memory the query uses for sorting/hashing

### 6. Keep Statistics Fresh

After bulk-loading data or making significant changes, run `ANALYZE` on the affected tables. Autovacuum does this automatically, but it may not kick in fast enough after a large bulk load.

```sql
-- After a bulk import
ANALYZE orders;
```

---

## 1.11 Common Misconceptions That Lead to Bad Decisions

### Misconception 1: "PostgreSQL is slow for large datasets"

Reality: PostgreSQL handles billions of rows routinely. Slowness is almost always caused by missing indexes, bad queries, stale statistics, or table bloat — not PostgreSQL itself. Senior engineers know that a slow query is THEIR problem to diagnose, not a database limitation.

### Misconception 2: "I should add indexes on every column that appears in a WHERE clause"

Reality: Every index has a cost — it slows down writes (INSERT, UPDATE, DELETE all have to update every index) and uses disk space. Indexes also need to be vacuumed. You should add indexes based on actual query patterns, verified with `EXPLAIN ANALYZE`, not preemptively on every column.

### Misconception 3: "Transactions are just for financial applications"

Reality: You need transactions whenever multiple statements must succeed or fail together. Adding an order and its line items? That's a transaction. Creating a user and their default settings? That's a transaction. If you don't use a transaction and your application crashes between the two inserts, you have inconsistent data.

### Misconception 4: "I can just use OFFSET for pagination"

Reality: `OFFSET 100000` still reads and discards 100,000 rows internally. The deeper you paginate, the slower it gets. Senior engineers use keyset (cursor-based) pagination in production. We cover this fully in Chapter 4.

### Misconception 5: "My ORM handles everything, so I don't need to understand SQL"

Reality: ORMs generate SQL. Bad ORM usage generates bad SQL. The N+1 query problem, missing joins, unnecessary subqueries, and wrong eager-loading strategies all come from not understanding what SQL the ORM generates. Senior engineers always check the generated SQL with `EXPLAIN ANALYZE`.

### Misconception 6: "Normalization means splitting everything into tiny tables"

Reality: Over-normalization leads to queries with 10 JOINs that are impossible to optimize. Under-normalization leads to data inconsistency and update anomalies. The right level of normalization is a design judgment call — and sometimes intentional denormalization (caching a user's name in an orders table to avoid a JOIN) is the correct production choice.

### Misconception 7: "VACUUM is some DBA thing I don't need to worry about"

Reality: If autovacuum falls behind, your tables bloat, your queries slow down, and eventually you can hit transaction ID wraparound — a situation where PostgreSQL literally refuses to accept writes until a VACUUM completes. Understanding and monitoring autovacuum is a required skill, not an optional DBA topic.

### Misconception 8: "PostgreSQL handles concurrency automatically — I don't need to think about it"

Reality: PostgreSQL's default isolation level (READ COMMITTED) allows several anomalies that can corrupt your application's data if you're not careful. Two concurrent API requests that both read-then-write the same row can overwrite each other's changes. You need to understand isolation levels and locking to write correct concurrent code. We cover this exhaustively in Chapter 7.

### Misconception 9: "Adding more connections will make the database faster"

Reality: The opposite is often true. Beyond a certain point (roughly 2-3x CPU cores), adding more connections causes MORE contention (lock contention, buffer contention, context switching) and makes everything SLOWER. This is counter-intuitive but well-established. Connection poolers like PgBouncer exist specifically to solve this.

### Misconception 10: "I should store everything in JSONB for flexibility"

Reality: JSONB is powerful, but it gives up the things that make relational databases valuable: column-level type checking, foreign key constraints, NOT NULL constraints, and efficient columnar access. Use JSONB for genuinely semi-structured data (user preferences, API response caches, metadata). Use proper columns for core business data.

---

## Chapter 1 Summary

You now have a mental model of PostgreSQL that will inform every decision you make:

1. **PostgreSQL is a query execution pipeline**: SQL string → parser → planner → executor → result. The planner is where performance is won or lost.

2. **MVCC means multiple row versions**: UPDATEs don't overwrite — they create new versions. This enables concurrent reads and writes but requires VACUUM to clean up dead versions.

3. **Everything is stored in 8 KB pages**: Understanding pages explains why sequential scans, index scans, and TOAST behave the way they do.

4. **WAL guarantees durability**: Changes go to the WAL first, then to data files. This is why PostgreSQL survives crashes.

5. **One process per connection**: This model is simple and robust but doesn't scale to thousands of connections. Connection pooling is mandatory at scale.

6. **The planner uses statistics**: Stale statistics → bad plans → slow queries. Autovacuum maintains statistics, but you need to understand when it falls behind.

Every subsequent chapter builds on this mental model. When we discuss indexes in Chapter 6, you'll understand them as B-tree page structures that the planner uses to avoid sequential scans of heap pages. When we discuss transactions in Chapter 7, you'll understand them as MVCC snapshots with visibility rules. When we discuss performance in Chapter 11, you'll understand bloat as dead row versions in heap pages that VACUUM hasn't reclaimed yet.

This is the foundation. Everything else is details.

---

→ next: chapter02_data_types.md
