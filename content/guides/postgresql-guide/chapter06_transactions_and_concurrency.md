# Chapter 6 — Transactions and Concurrency

## Table of Contents

- [6.1 Transactions: The Mental Model](#61-transactions-the-mental-model)
- [6.2 Transaction Isolation Levels](#62-transaction-isolation-levels)
  - [6.2.1 Read Uncommitted / Read Committed](#621-read-uncommitted--read-committed)
  - [6.2.2 Repeatable Read](#622-repeatable-read)
  - [6.2.3 Serializable and SSI](#623-serializable-and-ssi)
  - [6.2.4 Choosing an Isolation Level](#624-choosing-an-isolation-level)
- [6.3 MVCC — Multi-Version Concurrency Control](#63-mvcc--multi-version-concurrency-control)
  - [6.3.1 Tuple Versioning: xmin, xmax, and Visibility](#631-tuple-versioning-xmin-xmax-and-visibility)
  - [6.3.2 Snapshots](#632-snapshots)
  - [6.3.3 Visibility Map and Free Space Map](#633-visibility-map-and-free-space-map)
  - [6.3.4 PostgreSQL MVCC vs MySQL Undo-Log MVCC](#634-postgresql-mvcc-vs-mysql-undo-log-mvcc)
- [6.4 Locking](#64-locking)
  - [6.4.1 Table-Level Lock Modes](#641-table-level-lock-modes)
  - [6.4.2 Row-Level Locks](#642-row-level-locks)
  - [6.4.3 Advisory Locks](#643-advisory-locks)
  - [6.4.4 Lock Queues and Why ALTER TABLE Can Take Down Production](#644-lock-queues-and-why-alter-table-can-take-down-production)
  - [6.4.5 Debugging Locks with pg_locks](#645-debugging-locks-with-pg_locks)
- [6.5 Deadlocks](#65-deadlocks)
- [6.6 SELECT FOR UPDATE / FOR SHARE / SKIP LOCKED](#66-select-for-update--for-share--skip-locked)
- [6.7 Optimistic vs Pessimistic Locking](#67-optimistic-vs-pessimistic-locking)
- [6.8 Savepoints](#68-savepoints)
- [6.9 Transaction Management Patterns](#69-transaction-management-patterns)
- [6.10 Things That Will Bite You in Production](#610-things-that-will-bite-you-in-production)

---

## 6.1 Transactions: The Mental Model

If you come from frontend, you already understand the concept of atomic operations more than you think. Consider a Redux dispatch: you dispatch an action, the reducer produces a new state, and the UI updates — it either all happens or none of it does. You never see half-applied state. Transactions are exactly that, but for your database.

A transaction is a sequence of SQL statements that execute as a single logical unit. They either all succeed (COMMIT) or all fail (ROLLBACK). There is no in-between.

```sql
BEGIN;

UPDATE accounts SET balance = balance - 500.00 WHERE id = 1001;
UPDATE accounts SET balance = balance + 500.00 WHERE id = 1002;

INSERT INTO transfers (from_account, to_account, amount, created_at)
VALUES (1001, 1002, 500.00, now());

COMMIT;
```

If the server crashes between the two UPDATEs, neither takes effect. If the INSERT fails because of a constraint violation, the UPDATEs are rolled back. This is the "A" in ACID — Atomicity.

The four ACID properties:

| Property | What it means | Frontend analogy |
|---|---|---|
| **Atomicity** | All or nothing | A Redux dispatch either fully applies or doesn't |
| **Consistency** | Constraints are always satisfied after commit | TypeScript type checking — invalid states are rejected |
| **Isolation** | Concurrent transactions don't interfere | Race condition-free state management |
| **Durability** | Committed data survives crashes | `localStorage.setItem()` — it persists even if you close the tab |

Every single statement in PostgreSQL runs inside a transaction, even if you don't write `BEGIN`. When you execute a standalone `UPDATE`, PostgreSQL wraps it in an implicit transaction — auto-commit mode. This is important: there is no "non-transactional" mode in PostgreSQL.

> **What a senior engineer actually thinks about**
>
> "How long will this transaction be held open?" is the first question, not "will this work?" Long transactions hold locks, block autovacuum, and cause table bloat. The correctness is the easy part. The operational cost of your transaction design is what separates production-ready code from demo code.

---

## 6.2 Transaction Isolation Levels

Isolation levels determine what data a transaction can see when other transactions are making concurrent changes. This is where things get genuinely complicated, and where most production concurrency bugs live.

The SQL standard defines four isolation levels based on the anomalies they prevent:

| Anomaly | Description |
|---|---|
| **Dirty read** | Reading uncommitted data from another transaction |
| **Non-repeatable read** | A row you read changes when you read it again (another transaction committed an UPDATE) |
| **Phantom read** | A query returns different rows when re-executed (another transaction committed an INSERT or DELETE) |
| **Serialization anomaly** | The result of concurrent transactions differs from any serial execution ordering |

| Isolation Level | Dirty Read | Non-repeatable Read | Phantom Read | Serialization Anomaly |
|---|---|---|---|---|
| Read Uncommitted | Possible* | Possible | Possible | Possible |
| Read Committed | Not possible | Possible | Possible | Possible |
| Repeatable Read | Not possible | Not possible | Not possible** | Possible |
| Serializable | Not possible | Not possible | Not possible | Not possible |

\* In PostgreSQL, Read Uncommitted behaves identically to Read Committed — dirty reads are never possible.

\** In PostgreSQL, Repeatable Read also prevents phantom reads, which goes beyond the SQL standard minimum.

### 6.2.1 Read Uncommitted / Read Committed

**Read Committed is PostgreSQL's default isolation level.** Read Uncommitted is accepted as a syntax but behaves identically to Read Committed. PostgreSQL's MVCC architecture makes dirty reads impossible without special effort, so the developers chose not to implement a mode with weaker guarantees than Read Committed.

```sql
-- You can set it, but it acts as Read Committed
SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;
-- No different from:
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
```

**How Read Committed works:** Each statement within the transaction sees a snapshot of the database as of the moment *that statement* begins executing. Not the moment the transaction began — the moment each individual statement begins. This is a critical distinction.

Let's set up a demonstration:

```sql
CREATE TABLE inventory (
    product_id   integer PRIMARY KEY,
    product_name text NOT NULL,
    quantity     integer NOT NULL CHECK (quantity >= 0),
    updated_at   timestamptz DEFAULT now()
);

INSERT INTO inventory VALUES
    (1, 'Widget A', 100, now()),
    (2, 'Widget B', 50, now()),
    (3, 'Widget C', 200, now());
```

**Demonstrating a non-repeatable read:**

```
-- Session 1 (Read Committed, the default)
BEGIN;
SELECT quantity FROM inventory WHERE product_id = 1;
-- Returns: 100

                                        -- Session 2
                                        BEGIN;
                                        UPDATE inventory SET quantity = 80
                                            WHERE product_id = 1;
                                        COMMIT;

-- Session 1 reads again (same transaction)
SELECT quantity FROM inventory WHERE product_id = 1;
-- Returns: 80  <-- DIFFERENT from first read!
COMMIT;
```

Session 1's second SELECT sees the committed change from Session 2. The same query within the same transaction returned different results. This is a non-repeatable read, and Read Committed *allows* it.

**Demonstrating a phantom read:**

```
-- Session 1 (Read Committed)
BEGIN;
SELECT sum(quantity) FROM inventory;
-- Returns: 350

                                        -- Session 2
                                        INSERT INTO inventory VALUES
                                            (4, 'Widget D', 75, now());
                                        -- Auto-commits

-- Session 1
SELECT sum(quantity) FROM inventory;
-- Returns: 425  <-- New row appeared (phantom)
COMMIT;
```

**Why Read Committed is the default:** It offers the best balance of correctness and performance for most workloads. Because each statement sees the latest committed data, it rarely causes serialization failures that require application-level retries. The trade-off is that your transaction might see an inconsistent view of the world across statements.

> **What a senior engineer actually thinks about**
>
> Read Committed is fine for the vast majority of operations: inserting rows, updating a single entity, CRUD endpoints. You need a stronger level when your transaction reads data and then makes a decision based on what it read — like checking if a username is available and then inserting it, or checking inventory before decrementing.

**Common mistake — TOCTOU bugs under Read Committed:**

```sql
-- BROKEN: check-then-act under Read Committed
BEGIN;
SELECT quantity FROM inventory WHERE product_id = 1;
-- Returns 100, application sees "ok, we have enough"

-- Meanwhile, another transaction decrements to 5 and commits

UPDATE inventory SET quantity = quantity - 50 WHERE product_id = 1;
-- Succeeds! quantity is now -45... if you didn't have a CHECK constraint
COMMIT;
```

The CHECK constraint saves you here, but the pattern is fundamentally broken. The SELECT and UPDATE see different snapshots. We'll cover the correct approach (SELECT FOR UPDATE) in section 6.6.

### 6.2.2 Repeatable Read

Under Repeatable Read, the transaction takes a single snapshot at the start of the *first non-transaction-control statement* (your first SELECT, INSERT, UPDATE, or DELETE — not the BEGIN itself). Every subsequent statement in the transaction sees the same snapshot, regardless of what other transactions commit.

```sql
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
-- Or:
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;
```

**Demonstrating that non-repeatable reads are prevented:**

```
-- Session 1 (Repeatable Read)
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SELECT quantity FROM inventory WHERE product_id = 1;
-- Returns: 100

                                        -- Session 2
                                        UPDATE inventory SET quantity = 80
                                            WHERE product_id = 1;
                                        -- Commits

-- Session 1
SELECT quantity FROM inventory WHERE product_id = 1;
-- Still returns: 100  <-- Same as first read!
COMMIT;
```

**Demonstrating phantom read prevention (PostgreSQL goes beyond the standard):**

```
-- Session 1 (Repeatable Read)
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SELECT sum(quantity) FROM inventory;
-- Returns: 350

                                        -- Session 2
                                        INSERT INTO inventory VALUES
                                            (5, 'Widget E', 100, now());
                                        -- Commits

-- Session 1
SELECT sum(quantity) FROM inventory;
-- Still returns: 350  <-- No phantom!
COMMIT;
```

The SQL standard says Repeatable Read *may* allow phantom reads. PostgreSQL's snapshot-based implementation inherently prevents them too. This is a consequence of how MVCC works: the snapshot was taken before Widget E existed, so the transaction will never see it.

**The serialization anomaly you need to worry about:**

Repeatable Read prevents phantoms and non-repeatable reads, but it does NOT prevent serialization anomalies. Here's a classic write skew example:

```sql
-- Setup: doctors on call
CREATE TABLE on_call (
    doctor_id   integer PRIMARY KEY,
    shift_date  date NOT NULL,
    on_duty     boolean NOT NULL DEFAULT true
);

INSERT INTO on_call VALUES (1, '2025-03-15', true), (2, '2025-03-15', true);
```

```
-- Session 1 (Repeatable Read)
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SELECT count(*) FROM on_call
    WHERE shift_date = '2025-03-15' AND on_duty = true;
-- Returns: 2 (both doctors on duty, safe to take one off)

                                        -- Session 2 (Repeatable Read)
                                        BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;
                                        SELECT count(*) FROM on_call
                                            WHERE shift_date = '2025-03-15'
                                            AND on_duty = true;
                                        -- Returns: 2 (both on duty, safe to take one off)

UPDATE on_call SET on_duty = false WHERE doctor_id = 1;

                                        UPDATE on_call SET on_duty = false
                                            WHERE doctor_id = 2;

COMMIT;
                                        COMMIT;
```

Both transactions see 2 doctors on duty, decide it's safe to remove one, and each removes a different doctor. After both commit, zero doctors are on duty. Neither transaction broke any rules individually, but the combined result violates the business invariant "at least one doctor on duty." No serial execution order would produce this result — this is a serialization anomaly (specifically, write skew).

**Serialization failures under Repeatable Read:**

When two Repeatable Read transactions try to UPDATE the same row, one succeeds and the other gets an error:

```
ERROR:  could not serialize access due to concurrent update
```

Your application **must** catch this error and retry the entire transaction. This is non-negotiable. PostgreSQL does not retry for you.

```typescript
// Application-level retry logic (Node.js / pg)
async function withRepeatableRead<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  maxRetries = 3
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const client = await pool.connect();
    try {
      await client.query(
        'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ'
      );
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err: any) {
      await client.query('ROLLBACK');
      if (err.code === '40001' && attempt < maxRetries) {
        // 40001 = serialization_failure
        const backoff = Math.pow(2, attempt) * 10 + Math.random() * 50;
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
  throw new Error('Transaction failed after max retries');
}
```

### 6.2.3 Serializable and SSI

Serializable is the strictest isolation level. It guarantees that the result of concurrent transactions is equivalent to some serial execution order. If no serial ordering would produce the same result, one of the transactions is aborted.

```sql
BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;
```

**How PostgreSQL implements it — Serializable Snapshot Isolation (SSI):**

PostgreSQL does NOT implement Serializable by acquiring locks on everything upfront (that's what SQL Server's implementation does in some modes, and it kills performance). Instead, PostgreSQL uses an algorithm called **Serializable Snapshot Isolation (SSI)**, introduced in PostgreSQL 9.1.

SSI works on top of the same MVCC snapshot that Repeatable Read uses, with an additional layer of tracking:

1. **SIRead locks (predicate locks):** When a Serializable transaction reads data, PostgreSQL records what data it read — not just individual rows but predicates (e.g., "all rows in `on_call` where `shift_date = '2025-03-15'`"). These are not blocking locks. They don't prevent other transactions from modifying the data.

2. **Conflict detection:** PostgreSQL watches for **rw-conflicts** (read-write conflicts). A rw-conflict occurs when Transaction A reads something that Transaction B writes, or vice versa. SSI specifically looks for a pattern called a **dangerous structure**: a cycle of rw-conflicts that indicates a potential serialization anomaly.

3. **Abort on detection:** When PostgreSQL detects that a dangerous structure has formed, it aborts one of the transactions with:

```
ERROR:  could not serialize access due to read/write dependencies
        among transactions
DETAIL:  Reason code: Canceled on identification as a pivot,
         during commit attempt.
HINT:   The transaction might succeed if retried.
```

**The write skew example now prevented:**

```
-- Session 1 (Serializable)
BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SELECT count(*) FROM on_call
    WHERE shift_date = '2025-03-15' AND on_duty = true;
-- Returns: 2 (PostgreSQL records this predicate read)

                                        -- Session 2 (Serializable)
                                        BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;
                                        SELECT count(*) FROM on_call
                                            WHERE shift_date = '2025-03-15'
                                            AND on_duty = true;
                                        -- Returns: 2

UPDATE on_call SET on_duty = false WHERE doctor_id = 1;
-- PostgreSQL detects: Session 1 wrote to data Session 2 read

                                        UPDATE on_call SET on_duty = false
                                            WHERE doctor_id = 2;
                                        -- PostgreSQL detects the dangerous structure

COMMIT;
-- Succeeds

                                        COMMIT;
                                        -- ERROR: could not serialize access
                                        -- due to read/write dependencies
```

Session 2 is aborted because PostgreSQL detected a cycle: Session 1 read what Session 2 wrote, and Session 2 read what Session 1 wrote. No serial ordering can produce both outcomes.

**SSI internals — the three things it tracks:**

SSI maintains three structures in shared memory:

1. **SIREAD locks:** A table mapping `(transaction, relation/page/tuple)` → `lock`. These start granular (tuple-level) but get promoted to page-level or relation-level if memory pressure is high. Controlled by `max_pred_locks_per_transaction` (default 64), `max_pred_locks_per_relation` (default -2, meaning max(1, total/2)), and `max_pred_locks_per_page` (default 2).

2. **RW-conflict list:** A list of pairs `(T1, T2)` meaning "T1 read something that T2 later wrote" (an **in-conflict**) or "T1 wrote something that T2 already read" (an **out-conflict**).

3. **Transaction summary info:** For each in-flight serializable transaction, PostgreSQL tracks whether it has an in-conflict, an out-conflict, or both (the pivot in a dangerous structure).

The dangerous structure is formally: three transactions T0, T1, T2 where T0 --rw→ T1 --rw→ T2, and T0 is either T2 (a cycle of two) or has already committed. When detected, the middle transaction (T1, the "pivot") is aborted.

**Performance characteristics of Serializable:**

SSI is remarkably lightweight for what it achieves:

- Read-only transactions are never aborted. If PostgreSQL can determine a transaction only reads, it's always safe.
- SIRead locks don't block anything — they're bookkeeping markers. Readers never block writers, writers never block readers.
- The overhead is the memory for predicate locks and the CPU for checking conflicts at commit time.
- False positives are possible (PostgreSQL may abort a transaction that would have been fine). This is a trade-off for not requiring expensive full-cycle detection.

**PG version note:** In PostgreSQL 12+, partitioned table operations work correctly with SSI predicate locks. Earlier versions had edge cases where SSI didn't track predicates across partition boundaries properly.

> **What a senior engineer actually thinks about**
>
> "Should I just use Serializable everywhere?" Almost never, but sometimes yes. If your application has complex invariants where multiple transactions make decisions based on overlapping reads, Serializable + retry logic is often simpler and more correct than ad-hoc locking. Financial ledger systems, booking engines, and constraint-heavy domains benefit most. But you **must** build retry logic, and you'll see higher abort rates under contention. For simple CRUD APIs, Read Committed with targeted `SELECT FOR UPDATE` is the pragmatic choice.

### 6.2.4 Choosing an Isolation Level

| Scenario | Recommended Level | Why |
|---|---|---|
| Simple CRUD REST APIs | Read Committed (default) | Minimal overhead, no retries needed |
| Report generation (long read-only queries) | Repeatable Read | Consistent snapshot throughout the report |
| Bank transfers, booking systems | Read Committed + SELECT FOR UPDATE | Targeted locking without retry overhead |
| Complex invariants across multiple tables | Serializable | Only way to prevent write skew without manual locking |
| Analytics / data warehouse queries | Repeatable Read | Long queries see consistent data even as the warehouse loads |

**Summary:**

- Read Committed is the safe default. Each statement sees the latest committed data.
- Repeatable Read gives you a frozen snapshot for the whole transaction. Must handle serialization errors.
- Serializable catches every anomaly, including write skew. Must handle serialization errors. Overhead is modest but non-zero.
- Read Uncommitted doesn't exist in PostgreSQL; it's silently upgraded to Read Committed.

---

## 6.3 MVCC — Multi-Version Concurrency Control

MVCC is the engine behind everything you just read about isolation levels. It's also the single most important thing to understand about PostgreSQL's architecture. If frontend work has taught you anything about immutable state (think React — don't mutate state, create new copies), MVCC will feel oddly familiar.

**The core principle:** When you UPDATE a row in PostgreSQL, it doesn't modify the existing row in place. It creates a new version of the row and marks the old version as "expired." Multiple versions of the same logical row can coexist on disk simultaneously. Different transactions see different versions depending on their snapshot.

This is fundamentally different from how you might expect a database to work. There is no "current row" that gets overwritten. There are versions, and each transaction figures out which version is visible to it.

### 6.3.1 Tuple Versioning: xmin, xmax, and Visibility

Every row (called a "tuple" in PostgreSQL internals) has hidden system columns. The two most important are `xmin` and `xmax`:

| Column | Meaning |
|---|---|
| `xmin` | The transaction ID (XID) that created this tuple version (INSERT or UPDATE that produced it) |
| `xmax` | The transaction ID that deleted or expired this tuple version (DELETE or UPDATE that replaced it). 0 if the tuple is still live |

You can see these directly:

```sql
SELECT xmin, xmax, product_id, product_name, quantity
FROM inventory;
```

```
 xmin | xmax | product_id | product_name | quantity
------+------+------------+--------------+----------
  100 |    0 |          1 | Widget A     |      100
  100 |    0 |          2 | Widget B     |       50
  100 |    0 |          3 | Widget C     |      200
```

`xmin = 100` means transaction 100 created these rows. `xmax = 0` means no transaction has deleted or updated them yet.

Now let's UPDATE one:

```sql
BEGIN;  -- Suppose this gets transaction ID 105
UPDATE inventory SET quantity = 75 WHERE product_id = 2;
COMMIT;
```

On disk, the table now contains **two** physical tuples for `product_id = 2`:

```
Tuple version layout on disk (heap page):

┌─────────────────────────────────────────────────┐
│ Tuple 1: xmin=100, xmax=0                       │
│   product_id=1, product_name='Widget A', qty=100 │
├─────────────────────────────────────────────────┤
│ Tuple 2: xmin=100, xmax=105  ← marked as dead   │
│   product_id=2, product_name='Widget B', qty=50  │
├─────────────────────────────────────────────────┤
│ Tuple 3: xmin=100, xmax=0                       │
│   product_id=3, product_name='Widget C', qty=200 │
├─────────────────────────────────────────────────┤
│ Tuple 4: xmin=105, xmax=0   ← the new version   │
│   product_id=2, product_name='Widget B', qty=75  │
└─────────────────────────────────────────────────┘
```

The old tuple (xmin=100) now has `xmax=105`, indicating transaction 105 expired it. The new tuple (xmin=105) has `xmax=0`, indicating it's the current live version. The old tuple stays on the page until VACUUM removes it.

**DELETE works the same way** — it just sets `xmax` on the existing tuple without creating a new version:

```sql
BEGIN;  -- Transaction 110
DELETE FROM inventory WHERE product_id = 3;
COMMIT;
```

```
Tuple 3: xmin=100, xmax=110  ← marked as dead, no new tuple created
```

**Visibility rules:**

A tuple is visible to a transaction with snapshot S if:

1. `xmin` is a committed transaction that committed before S was taken, AND
2. Either `xmax` is 0 (no one has deleted it), OR `xmax` is a transaction that has NOT committed (or committed after S was taken)

More precisely, PostgreSQL checks:

```
visible if:
    xmin is committed AND xmin is in snapshot
    AND (
        xmax is invalid (0)
        OR xmax is aborted
        OR xmax is not yet visible in this snapshot
    )
```

This is simplified — the actual function is `HeapTupleSatisfiesMVCC()` in the source, and it handles edge cases like the transaction seeing its own changes, subtransactions, and hint bits.

**Hint bits:** Checking whether a transaction is committed requires looking at `pg_xact` (formerly `pg_clog`), which is expensive if done for every tuple. PostgreSQL caches the result by setting "hint bits" directly on the tuple header. The first transaction to check a tuple's visibility writes the hint bits back. This is why a read-only SELECT can cause writes to pages (dirty pages), which often surprises people.

**ctid — the physical location:**

Every tuple also has a `ctid` (tuple ID) that gives its physical location as `(page_number, offset_within_page)`:

```sql
SELECT ctid, xmin, xmax, product_id, quantity FROM inventory;
```

```
  ctid  | xmin | xmax | product_id | quantity
--------+------+------+------------+----------
 (0,1)  |  100 |    0 |          1 |      100
 (0,2)  |  100 |  105 |          2 |       50
 (0,3)  |  100 |  110 |          3 |      200
 (0,4)  |  105 |    0 |          2 |       75
```

An UPDATE creates the new version, which may be on the same page or a different one. The old tuple's `ctid` gets updated to point to the new version, forming a **version chain** that HOT (Heap-Only Tuple) updates and index scans can follow.

### 6.3.2 Snapshots

A snapshot defines which transaction IDs a given transaction considers "committed and visible." It consists of three pieces of information:

1. **xmin (snapshot xmin):** The lowest still-active transaction ID at snapshot time. Any transaction with XID < xmin is guaranteed to be either committed or aborted.
2. **xmax (snapshot xmax):** One past the highest allocated transaction ID at snapshot time. Any XID >= xmax has not yet started.
3. **xip_list:** The list of transaction IDs that were in-progress (active) when the snapshot was taken. Transactions in this list are NOT visible, even if their XIDs are between xmin and xmax.

```
Snapshot example:
  xmin = 100
  xmax = 107
  xip_list = [102, 104]

Visibility:
  XID 99  → committed (< xmin) → VISIBLE
  XID 100 → check pg_xact, not in xip → VISIBLE (if committed)
  XID 101 → check pg_xact, not in xip → VISIBLE (if committed)
  XID 102 → in xip_list → NOT VISIBLE (was in-progress)
  XID 103 → check pg_xact, not in xip → VISIBLE (if committed)
  XID 104 → in xip_list → NOT VISIBLE (was in-progress)
  XID 105 → check pg_xact, not in xip → VISIBLE (if committed)
  XID 106 → check pg_xact, not in xip → VISIBLE (if committed)
  XID 107 → >= xmax → NOT VISIBLE (started after snapshot)
```

You can view the current snapshot:

```sql
SELECT txid_current_snapshot();
-- Returns something like: 100:107:102,104
-- Format: xmin:xmax:xip_list
```

**PG version note:** In PostgreSQL 13+, `txid_current_snapshot()` was renamed to `pg_current_snapshot()` and the underlying system changed from 32-bit XIDs to 64-bit XIDs internally (FullTransactionId), though the external interface still uses 32-bit wrapping XIDs. PostgreSQL 14+ added `pg_snapshot_xmin()`, `pg_snapshot_xmax()`, and `pg_snapshot_xip()` functions for inspecting snapshots.

**When snapshots are taken:**

| Isolation Level | Snapshot Taken |
|---|---|
| Read Committed | At the start of each *statement* |
| Repeatable Read | At the start of the first *statement* after BEGIN |
| Serializable | At the start of the first *statement* after BEGIN |

This is why Read Committed can see changes from other committed transactions mid-transaction (each statement gets a fresh snapshot), while Repeatable Read and Serializable see a frozen-in-time view.

### 6.3.3 Visibility Map and Free Space Map

**Visibility Map (VM):**

The visibility map is a bitmap with two bits per heap page:

1. **All-visible bit:** Set when every tuple on the page is visible to all current and future transactions. This means VACUUM has confirmed all tuples are live and their `xmin` transactions are old enough that no snapshot could possibly exclude them.

2. **All-frozen bit:** (PG 9.6+) Set when every tuple on the page has been frozen (xmin replaced with a special "frozen" transaction ID that's always considered committed). Frozen pages never need to be visited by VACUUM again.

**Why the VM matters for performance:**

- **Index-only scans:** When PostgreSQL can answer a query entirely from an index, it still normally needs to check the heap to verify tuple visibility (the index doesn't store xmin/xmax). But if the VM says the page is all-visible, the heap check is skipped. This is why VACUUM is critical for index-only scan performance.

```sql
-- This query can use an index-only scan IF the VM is up to date
EXPLAIN ANALYZE
SELECT product_id FROM inventory WHERE product_id BETWEEN 1 AND 100;
```

```
Index Only Scan using inventory_pkey on inventory
    (cost=0.28..4.30 rows=100 width=4)
    (actual time=0.020..0.035 rows=100 loops=1)
  Index Cond: ((product_id >= 1) AND (product_id <= 100))
  Heap Fetches: 0   ← VM confirmed all-visible, no heap access
```

If VACUUM hasn't run recently and the VM is stale:

```
  Heap Fetches: 100  ← Had to check the heap for visibility
```

- **VACUUM efficiency:** VACUUM can skip all-visible pages entirely. If your table is mostly static with a few hot pages, VACUUM only processes those hot pages.

**Free Space Map (FSM):**

The FSM tracks how much free space is available on each heap page. When PostgreSQL needs to INSERT a new row or create a new tuple version from an UPDATE, it consults the FSM to find a page with enough room.

```
Free Space Map (simplified):

Page 0: 200 bytes free
Page 1: 8000 bytes free  ← lots of space (VACUUM reclaimed dead tuples)
Page 2: 50 bytes free
Page 3: 4000 bytes free

INSERT needs 150 bytes → placed on Page 0 or Page 3
```

When VACUUM removes dead tuples, it updates the FSM to reflect the freed space. Without regular VACUUM, dead tuples accumulate, the FSM shows pages as full, and PostgreSQL appends new pages to the end of the file — this is **table bloat**.

```sql
-- Check table bloat using pgstattuple extension
CREATE EXTENSION IF NOT EXISTS pgstattuple;

SELECT * FROM pgstattuple('inventory');
```

```
 table_len | tuple_count | tuple_len | tuple_percent | dead_tuple_count | dead_tuple_len | dead_tuple_percent | free_space | free_percent
-----------+-------------+-----------+---------------+------------------+----------------+--------------------+------------+--------------
    819200 |       10000 |    680000 |         82.97 |             2500 |         170000 |              20.75 |      45000 |         5.49
```

`dead_tuple_percent` of 20% means a fifth of the table is wasted space from expired tuple versions. Time to VACUUM.

### 6.3.4 PostgreSQL MVCC vs MySQL Undo-Log MVCC

PostgreSQL and MySQL (InnoDB) both implement MVCC but with fundamentally different approaches:

| Aspect | PostgreSQL | MySQL (InnoDB) |
|---|---|---|
| **UPDATE strategy** | Creates a new tuple in the heap; old tuple stays in place | Modifies the row in the clustered index in place; old version moved to undo log |
| **Where old versions live** | In the same heap table, alongside live tuples | In a separate undo tablespace (rollback segment) |
| **Cleanup** | VACUUM removes dead tuples | Purge thread removes undo log entries |
| **Table bloat** | Dead tuples cause bloat until VACUUM runs | Undo log grows but doesn't bloat the main table |
| **Read performance on updated rows** | No indirection — the current version is directly on the heap (once you find it) | Long undo chains slow reads if a transaction needs to follow the chain to find the right version |
| **Write amplification** | Higher — full tuple copy for every update, even if you change one column | Lower — only changed columns go to undo log (though clustered index rebuild has its own cost) |
| **Index maintenance** | Every index must be updated if the tuple moves to a new page (unless HOT update applies) | Secondary indexes point to the clustered index key, not physical location — fewer index updates |

```
PostgreSQL MVCC (heap + dead tuples):

Heap Page:
┌────────────────────────┐
│ Live tuple (v3)        │
│ Dead tuple (v2)  ← waste until VACUUM │
│ Dead tuple (v1)  ← waste until VACUUM │
│ Live tuple (other row) │
└────────────────────────┘

MySQL InnoDB MVCC (clustered index + undo log):

Clustered Index Page:          Undo Log:
┌────────────────────┐         ┌──────────────┐
│ Current row (v3)   │ ──ptr─→ │ v2 (old)     │
│ Other current row  │         │ v1 (oldest)  │
└────────────────────┘         └──────────────┘
```

**What this means in practice:**

- PostgreSQL tables tend to bloat more than InnoDB tables. You *must* let autovacuum do its job — don't disable it, and tune its aggressiveness for high-churn tables.
- PostgreSQL HOT (Heap-Only Tuple) updates mitigate some write amplification: if the updated tuple fits on the same page and no indexed column changed, PostgreSQL avoids updating indexes entirely. This is a significant optimization.
- InnoDB can suffer from "long undo chains" when a long-running transaction holds a read view while other transactions keep updating the same rows. The purge thread can't clean up, and reads have to traverse the chain.

> **What a senior engineer actually thinks about**
>
> MVCC means UPDATE and DELETE are more expensive than you'd expect. An UPDATE is essentially a DELETE + INSERT internally. This changes how you design batch jobs: updating 10 million rows in a single transaction creates 10 million dead tuples and holds a long transaction open (blocking VACUUM). Instead, process in batches of 1,000–10,000 rows with commits between them.

---

## 6.4 Locking

If MVCC is how PostgreSQL lets readers and writers coexist, locking is how it handles conflicts between writers, schema changes, and operations that need exclusive access.

PostgreSQL has a rich locking system with multiple levels. Frontend analogy: if MVCC is like React's immutable state giving every component a consistent snapshot, locks are like mutexes or semaphores that coordinate actual mutations — the "write" side of your state management.

### 6.4.1 Table-Level Lock Modes

PostgreSQL defines eight table-level lock modes, from weakest to strongest. Each has a specific set of other modes it conflicts with:

| Lock Mode | Acquired By | Conflicts With |
|---|---|---|
| **ACCESS SHARE** | `SELECT` | ACCESS EXCLUSIVE |
| **ROW SHARE** | `SELECT FOR UPDATE`, `SELECT FOR SHARE` | EXCLUSIVE, ACCESS EXCLUSIVE |
| **ROW EXCLUSIVE** | `INSERT`, `UPDATE`, `DELETE` | SHARE, SHARE ROW EXCLUSIVE, EXCLUSIVE, ACCESS EXCLUSIVE |
| **SHARE UPDATE EXCLUSIVE** | `VACUUM` (non-FULL), `ANALYZE`, `CREATE INDEX CONCURRENTLY`, `ALTER TABLE` (some variants), `REINDEX CONCURRENTLY` | SHARE UPDATE EXCLUSIVE, SHARE, SHARE ROW EXCLUSIVE, EXCLUSIVE, ACCESS EXCLUSIVE |
| **SHARE** | `CREATE INDEX` (non-concurrent) | ROW EXCLUSIVE, SHARE UPDATE EXCLUSIVE, SHARE ROW EXCLUSIVE, EXCLUSIVE, ACCESS EXCLUSIVE |
| **SHARE ROW EXCLUSIVE** | `CREATE TRIGGER`, `ALTER TABLE` (some variants) | ROW EXCLUSIVE, SHARE UPDATE EXCLUSIVE, SHARE, SHARE ROW EXCLUSIVE, EXCLUSIVE, ACCESS EXCLUSIVE |
| **EXCLUSIVE** | `REFRESH MATERIALIZED VIEW CONCURRENTLY` | ROW SHARE, ROW EXCLUSIVE, SHARE UPDATE EXCLUSIVE, SHARE, SHARE ROW EXCLUSIVE, EXCLUSIVE, ACCESS EXCLUSIVE |
| **ACCESS EXCLUSIVE** | `ALTER TABLE`, `DROP TABLE`, `TRUNCATE`, `REINDEX`, `VACUUM FULL`, `LOCK TABLE` | ALL lock modes |

**Conflict matrix** (✗ = conflict, ✓ = compatible):

```
                   AS   RS   RE   SUE   S    SRE  E    AE
ACCESS SHARE       ✓    ✓    ✓     ✓    ✓     ✓   ✓    ✗
ROW SHARE          ✓    ✓    ✓     ✓    ✓     ✓   ✗    ✗
ROW EXCLUSIVE      ✓    ✓    ✓     ✓    ✗     ✗   ✗    ✗
SHARE UPDATE EXCL  ✓    ✓    ✓     ✗    ✗     ✗   ✗    ✗
SHARE              ✓    ✓    ✗     ✗    ✓     ✗   ✗    ✗
SHARE ROW EXCL     ✓    ✓    ✗     ✗    ✗     ✗   ✗    ✗
EXCLUSIVE          ✓    ✗    ✗     ✗    ✗     ✗   ✗    ✗
ACCESS EXCLUSIVE   ✗    ✗    ✗     ✗    ✗     ✗   ✗    ✗
```

The key insight: **ACCESS EXCLUSIVE conflicts with everything**, including plain SELECTs. This is why `ALTER TABLE`, `DROP TABLE`, and `TRUNCATE` are so dangerous on busy tables — they block ALL queries until they complete.

**No lock escalation:** PostgreSQL does NOT escalate row locks to table locks, ever. If you lock a million rows with `SELECT FOR UPDATE`, you hold a million row-level locks, plus one table-level ROW SHARE lock. Databases like SQL Server sometimes escalate many row locks to a table lock for efficiency. PostgreSQL never does this. This means you'll never be surprised by a row-level operation suddenly blocking the entire table, but it does mean lock memory usage can be high.

### 6.4.2 Row-Level Locks

Row-level locks are separate from table-level locks. They're recorded in the tuple header itself (in the `xmax` field and related infomask bits), not in the lock manager's shared memory table. This makes them very lightweight — you can hold millions of row locks without exhausting shared memory.

The four row-level lock modes:

| Lock Mode | SQL | Conflicts With | Use Case |
|---|---|---|---|
| **FOR KEY SHARE** | `SELECT ... FOR KEY SHARE` | FOR UPDATE | Weakest. Prevents key columns from being changed. Used internally by FK checks |
| **FOR SHARE** | `SELECT ... FOR SHARE` | FOR UPDATE, FOR NO KEY UPDATE | Read lock — prevents any modification of locked rows |
| **FOR NO KEY UPDATE** | `SELECT ... FOR NO KEY UPDATE` | FOR UPDATE, FOR NO KEY UPDATE, FOR SHARE | Like FOR UPDATE but doesn't block FOR KEY SHARE. Regular `UPDATE` acquires this |
| **FOR UPDATE** | `SELECT ... FOR UPDATE` | All row-level locks | Strongest. Exclusive lock on the row. `DELETE` acquires this |

```
Row-level lock conflict matrix:

                     FOR KEY SHARE  FOR SHARE  FOR NO KEY UPDATE  FOR UPDATE
FOR KEY SHARE              ✓            ✓              ✓              ✗
FOR SHARE                  ✓            ✓              ✗              ✗
FOR NO KEY UPDATE          ✓            ✗              ✗              ✗
FOR UPDATE                 ✗            ✗              ✗              ✗
```

**Important detail:** A normal `UPDATE` that doesn't modify any key columns (primary key or columns referenced by a foreign key) acquires FOR NO KEY UPDATE, not FOR UPDATE. This allows concurrent foreign key checks (`FOR KEY SHARE`) to proceed without blocking. This distinction was added in PostgreSQL 9.3 and is a significant improvement for FK-heavy schemas.

```sql
-- This UPDATE acquires FOR NO KEY UPDATE (not changing the PK):
UPDATE inventory SET quantity = quantity - 1 WHERE product_id = 1;

-- This UPDATE acquires FOR UPDATE (changing the PK):
UPDATE inventory SET product_id = 999 WHERE product_id = 1;
```

### 6.4.3 Advisory Locks

Advisory locks are application-level locks that PostgreSQL provides as a service. They don't lock any actual database object — they lock an arbitrary integer (or pair of integers) that your application gives meaning to. Think of them like named mutexes.

```sql
-- Session-level advisory lock (held until explicitly released or session ends)
SELECT pg_advisory_lock(12345);
-- ... do protected work ...
SELECT pg_advisory_unlock(12345);

-- Transaction-level advisory lock (released automatically at COMMIT/ROLLBACK)
SELECT pg_advisory_xact_lock(12345);
-- ... do protected work ...
COMMIT;  -- lock released automatically

-- Try-lock variants (non-blocking, returns boolean)
SELECT pg_try_advisory_lock(12345);
-- Returns true if acquired, false if another session holds it
```

**Session-level vs transaction-level:**

| Variant | Function | Released When |
|---|---|---|
| Session-level | `pg_advisory_lock(key)` | Explicitly via `pg_advisory_unlock()`, or session disconnect |
| Transaction-level | `pg_advisory_xact_lock(key)` | Transaction COMMIT or ROLLBACK |

**Critical:** Session-level locks can be acquired multiple times by the same session (they're reentrant). Each acquisition must be matched by a corresponding `pg_advisory_unlock()`. If you acquire it 3 times, you must unlock it 3 times. This is a common source of leaked locks.

**Two-key variants:**

All advisory lock functions have two-key variants that take two `integer` arguments instead of one `bigint`:

```sql
-- Using two 32-bit keys (useful for composite identifiers)
SELECT pg_advisory_lock(schema_id, entity_id);

-- Common pattern: use table OID + row ID
SELECT pg_advisory_lock('inventory'::regclass::integer, 42);
```

**Production use cases:**

1. **Singleton cron jobs:** Ensure only one instance of a background job runs:

```sql
-- At the start of a cron job
SELECT pg_try_advisory_lock(hashtext('daily-report-generation'));
-- Returns false? Another instance is running. Exit gracefully.
```

2. **Rate limiting per entity:**

```sql
-- Serialize all operations for a specific tenant
SELECT pg_advisory_xact_lock(hashtext('tenant'), tenant_id);
```

3. **Distributed locking when you don't want Redis:**

```typescript
async function withDistributedLock(
  pool: Pool,
  lockKey: number,
  fn: () => Promise<void>
): Promise<boolean> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      'SELECT pg_try_advisory_lock($1)',
      [lockKey]
    );
    if (!rows[0].pg_try_advisory_lock) {
      return false; // Someone else has the lock
    }
    try {
      await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
    }
    return true;
  } finally {
    client.release();
  }
}
```

### 6.4.4 Lock Queues and Why ALTER TABLE Can Take Down Production

Lock requests in PostgreSQL form a queue. When a transaction requests a lock that conflicts with a held lock, it waits in the queue behind any other waiters. Here's where it gets dangerous:

```
Timeline of a production outage:

1. Transaction A: BEGIN; SELECT * FROM users WHERE ...; (holds ACCESS SHARE)
   [A has ACCESS SHARE on users table — allows reads]

2. DBA runs: ALTER TABLE users ADD COLUMN last_login timestamptz;
   [ALTER TABLE needs ACCESS EXCLUSIVE — conflicts with A's ACCESS SHARE]
   [ALTER TABLE enters the lock queue, WAITING]

3. New query arrives: SELECT * FROM users WHERE id = 5;
   [Needs ACCESS SHARE — compatible with A's lock, but...]
   [PostgreSQL checks the queue: there's an ACCESS EXCLUSIVE request waiting]
   [New SELECT must wait BEHIND the ALTER TABLE in the queue]

4. More SELECTs arrive → all queued behind the ALTER TABLE
5. Connection pool fills up → application errors → outage
```

This is the **lock queue convoy** problem. The ALTER TABLE itself might be instantaneous (adding a nullable column with no default is a metadata-only change in PG 11+), but while it's waiting for existing transactions to finish, it blocks ALL new queries.

**Mitigations:**

```sql
-- 1. Set a lock timeout so the ALTER TABLE gives up if it can't acquire the lock
SET lock_timeout = '3s';
ALTER TABLE users ADD COLUMN last_login timestamptz;
-- If it can't get the lock in 3 seconds, it errors out instead of blocking everything

-- 2. Kill long-running transactions first
SELECT pid, age(clock_timestamp(), query_start), query
FROM pg_stat_activity
WHERE state = 'active' AND query_start < now() - interval '5 minutes';

-- 3. Use low lock_timeout with retries in a deployment script
-- retry_ddl.sh
-- for i in 1 2 3 4 5; do
--   psql -c "SET lock_timeout = '2s'; ALTER TABLE users ADD COLUMN ..." && break
--   sleep 5
-- done
```

**PG version note:** PostgreSQL 11 added support for adding a column with a non-null DEFAULT without rewriting the table. Prior to PG 11, `ALTER TABLE ADD COLUMN ... DEFAULT 'value' NOT NULL` rewrote the entire table (holding ACCESS EXCLUSIVE the whole time), making it extremely dangerous on large tables.

### 6.4.5 Debugging Locks with pg_locks

When something is blocked, `pg_locks` is your diagnostic tool:

```sql
-- Find blocked queries and what's blocking them
SELECT
    blocked_locks.pid          AS blocked_pid,
    blocked_activity.usename   AS blocked_user,
    blocking_locks.pid         AS blocking_pid,
    blocking_activity.usename  AS blocking_user,
    blocked_activity.query     AS blocked_statement,
    blocking_activity.query    AS blocking_statement,
    blocked_locks.locktype     AS lock_type,
    blocked_locks.mode         AS blocked_mode,
    blocking_locks.mode        AS blocking_mode
FROM pg_catalog.pg_locks blocked_locks
JOIN pg_catalog.pg_stat_activity blocked_activity
    ON blocked_activity.pid = blocked_locks.pid
JOIN pg_catalog.pg_locks blocking_locks
    ON blocking_locks.locktype = blocked_locks.locktype
    AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database
    AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
    AND blocking_locks.page IS NOT DISTINCT FROM blocked_locks.page
    AND blocking_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple
    AND blocking_locks.virtualxid IS NOT DISTINCT FROM blocked_locks.virtualxid
    AND blocking_locks.transactionid IS NOT DISTINCT FROM blocked_locks.transactionid
    AND blocking_locks.classid IS NOT DISTINCT FROM blocked_locks.classid
    AND blocking_locks.objid IS NOT DISTINCT FROM blocked_locks.objid
    AND blocking_locks.objsubid IS NOT DISTINCT FROM blocked_locks.objsubid
    AND blocking_locks.pid != blocked_locks.pid
JOIN pg_catalog.pg_stat_activity blocking_activity
    ON blocking_activity.pid = blocking_locks.pid
WHERE NOT blocked_locks.granted;
```

**Simpler version for quick checks (PG 14+):**

```sql
-- PG 14+ has pg_blocking_pids() function
SELECT
    pid,
    pg_blocking_pids(pid) AS blocked_by,
    query AS blocked_query,
    wait_event_type,
    wait_event
FROM pg_stat_activity
WHERE cardinality(pg_blocking_pids(pid)) > 0;
```

**Viewing all locks on a specific table:**

```sql
SELECT
    l.locktype,
    l.mode,
    l.granted,
    l.pid,
    a.query,
    a.state,
    age(clock_timestamp(), a.query_start) AS query_age
FROM pg_locks l
JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.relation = 'inventory'::regclass
ORDER BY l.granted DESC, a.query_start;
```

**Viewing row-level locks:**

Row-level locks don't appear directly in `pg_locks` (they're stored in tuple headers). But you can see the transaction-level information:

```sql
-- See which rows are locked by examining xmax
SELECT ctid, xmin, xmax, product_id, quantity
FROM inventory
WHERE xmax != 0;
```

```sql
-- Combined view: table + row lock info
SELECT
    l.locktype,
    l.mode,
    l.granted,
    l.pid,
    CASE l.locktype
        WHEN 'tuple' THEN l.page::text || ',' || l.tuple::text
        ELSE ''
    END AS tuple_location,
    a.query
FROM pg_locks l
JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.relation = 'inventory'::regclass
ORDER BY l.locktype, l.mode;
```

> **What a senior engineer actually thinks about**
>
> Every time you write a migration, think about locks. `ALTER TABLE ADD COLUMN` (nullable, no default) — fast, metadata only. `ALTER TABLE ADD COLUMN ... DEFAULT x NOT NULL` — fast in PG 11+, table rewrite in PG 10-. `ALTER TABLE ALTER COLUMN TYPE` — full table rewrite, ACCESS EXCLUSIVE for the entire duration. `CREATE INDEX` — blocks writes. `CREATE INDEX CONCURRENTLY` — doesn't block writes but takes longer and can fail. Build the lock_timeout + retry pattern into your deployment tooling. Always.

---

## 6.5 Deadlocks

A deadlock occurs when two or more transactions hold locks that the other needs, creating a cycle of waiting. Neither can proceed, so PostgreSQL detects the cycle and kills one of them.

Frontend analogy: imagine two React components each waiting for the other to finish rendering before they can render. It never resolves. That's a deadlock.

**A concrete deadlock example:**

```sql
-- Setup
CREATE TABLE accounts (
    id      integer PRIMARY KEY,
    name    text NOT NULL,
    balance numeric(15,2) NOT NULL CHECK (balance >= 0)
);

INSERT INTO accounts VALUES
    (1, 'Alice', 1000.00),
    (2, 'Bob', 1000.00);
```

```
-- Session 1: Transfer $100 from Alice to Bob
BEGIN;
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
-- Acquires row lock on id=1

                                        -- Session 2: Transfer $200 from Bob to Alice
                                        BEGIN;
                                        UPDATE accounts SET balance = balance - 200
                                            WHERE id = 2;
                                        -- Acquires row lock on id=2

UPDATE accounts SET balance = balance + 100 WHERE id = 2;
-- BLOCKS — Session 2 holds the lock on id=2

                                        UPDATE accounts SET balance = balance + 200
                                            WHERE id = 1;
                                        -- BLOCKS — Session 1 holds the lock on id=1

                                        -- DEADLOCK DETECTED!
```

Both sessions are now waiting for each other. PostgreSQL detects this and kills one:

```
ERROR:  deadlock detected
DETAIL:  Process 12345 waits for ShareLock on transaction 1000;
         blocked by process 12346.
         Process 12346 waits for ShareLock on transaction 999;
         blocked by process 12345.
HINT:  See server log for query details.
CONTEXT:  while updating tuple (0,2) in relation "accounts"
```

**How PostgreSQL detects deadlocks — the wait-for graph:**

PostgreSQL doesn't check for deadlocks continuously (that would be expensive). Instead:

1. When a transaction has been waiting for a lock for `deadlock_timeout` milliseconds (default: 1 second), PostgreSQL builds a **wait-for graph**.
2. The wait-for graph has one node per transaction and directed edges from waiting transactions to the transactions they're waiting on.
3. If the graph contains a cycle, a deadlock exists.
4. PostgreSQL picks one transaction in the cycle as the **victim** and aborts it with error code `40P01` (deadlock_detected).

```
Wait-for graph for our example:

Session 1 ──waits for──→ Session 2
    ↑                        │
    └──────waits for─────────┘

Cycle detected → one transaction is aborted.
```

**The `deadlock_timeout` setting:**

```sql
SHOW deadlock_timeout;  -- Default: 1s

-- You can change it (superuser only)
SET deadlock_timeout = '2s';
```

This is NOT the time PostgreSQL waits before considering something a deadlock. It's the time a transaction waits before PostgreSQL even *checks* for deadlocks. Setting it too low wastes CPU on needless cycle detection. Setting it too high means deadlocks take longer to resolve. The default of 1s is reasonable for most workloads.

**How to prevent deadlocks — consistent lock ordering:**

The classic solution: all transactions that need multiple locks should acquire them in the same order.

```sql
-- CORRECT: Always lock accounts in ascending id order
BEGIN;
-- Lock lower ID first
UPDATE accounts SET balance = balance - 100 WHERE id = LEAST(1, 2);
UPDATE accounts SET balance = balance + 100 WHERE id = GREATEST(1, 2);
COMMIT;
```

Or, more explicitly with a helper function:

```sql
-- Lock both accounts in a consistent order, then perform the transfer
CREATE OR REPLACE FUNCTION transfer_funds(
    from_account integer,
    to_account integer,
    amount numeric
) RETURNS void AS $$
DECLARE
    lock_id_1 integer := LEAST(from_account, to_account);
    lock_id_2 integer := GREATEST(from_account, to_account);
BEGIN
    -- Lock in consistent order
    PERFORM id FROM accounts WHERE id = lock_id_1 FOR UPDATE;
    PERFORM id FROM accounts WHERE id = lock_id_2 FOR UPDATE;

    -- Now perform the transfer
    UPDATE accounts SET balance = balance - amount
        WHERE id = from_account;
    UPDATE accounts SET balance = balance + amount
        WHERE id = to_account;
END;
$$ LANGUAGE plpgsql;
```

**Reading deadlock log messages:**

In your PostgreSQL logs (with `log_lock_waits = on`):

```
2025-03-15 10:23:45.123 UTC [12345] ERROR:  deadlock detected
2025-03-15 10:23:45.123 UTC [12345] DETAIL:
    Process 12345 waits for ShareLock on transaction 98765;
        blocked by process 12346.
    Process 12346 waits for ShareLock on transaction 98764;
        blocked by process 12345.
    Process 12345: UPDATE accounts SET balance = balance + 100 WHERE id = 2
    Process 12346: UPDATE accounts SET balance = balance + 200 WHERE id = 1
2025-03-15 10:23:45.123 UTC [12345] HINT:
    See server log for query details.
2025-03-15 10:23:45.123 UTC [12345] CONTEXT:
    while updating tuple (0,2) in relation "accounts"
```

Key information to extract:
- **Which processes** are involved (PIDs 12345 and 12346)
- **Which queries** caused the deadlock (both UPDATE statements)
- **Which tuples** are being contended (tuple (0,2) in "accounts")
- **The lock type** being waited on (ShareLock on transaction)

**Design principles to minimize deadlocks:**

1. **Consistent ordering:** Lock resources in the same order everywhere.
2. **Keep transactions short:** The shorter the transaction, the smaller the window for deadlock.
3. **Lock explicitly upfront:** Use `SELECT FOR UPDATE` at the beginning to acquire all needed locks.
4. **Reduce lock granularity:** If possible, use advisory locks on a logical entity instead of locking rows across multiple tables.
5. **Retry on deadlock:** Application code should catch error `40P01` and retry the whole transaction.

```typescript
async function transferFunds(
  pool: Pool,
  fromId: number,
  toId: number,
  amount: number
): Promise<void> {
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT transfer_funds($1, $2, $3)',
        [fromId, toId, amount]
      );
      await client.query('COMMIT');
      return;
    } catch (err: any) {
      await client.query('ROLLBACK');
      if (err.code === '40P01' && attempt < maxRetries) {
        // Deadlock — jitter + retry
        await new Promise(r =>
          setTimeout(r, Math.random() * 100 * attempt)
        );
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}
```

---

## 6.6 SELECT FOR UPDATE / FOR SHARE / SKIP LOCKED

These clauses combine a SELECT with row-level locking. They're how you do pessimistic locking in PostgreSQL — you read data and lock it in the same operation, closing the TOCTOU gap that Read Committed allows.

### FOR UPDATE

`SELECT ... FOR UPDATE` acquires an exclusive row lock on each returned row. Other transactions that try to UPDATE, DELETE, or SELECT FOR UPDATE on the same rows will block until your transaction releases the lock.

**Production example — inventory reservation:**

```sql
-- Correct way to decrement inventory atomically
BEGIN;

-- Lock the row first
SELECT quantity FROM inventory
WHERE product_id = 42
FOR UPDATE;
-- Returns: quantity = 10
-- Row is now locked — no one else can modify it

-- Application checks: is quantity >= requested_amount?
-- If yes:
UPDATE inventory SET quantity = quantity - 3
WHERE product_id = 42;

INSERT INTO reservations (product_id, quantity, customer_id, created_at)
VALUES (42, 3, 99, now());

COMMIT;
```

Without FOR UPDATE, two concurrent requests could both read `quantity = 10`, both decide they can reserve 8, and both decrement — resulting in `quantity = -6` (or a CHECK constraint violation).

**NOWAIT and SKIP LOCKED modifiers:**

```sql
-- NOWAIT: Error immediately if the row is already locked
SELECT * FROM inventory WHERE product_id = 42 FOR UPDATE NOWAIT;
-- If locked: ERROR: could not obtain lock on row in relation "inventory"

-- SKIP LOCKED: Silently skip rows that are already locked
SELECT * FROM inventory WHERE product_id = 42 FOR UPDATE SKIP LOCKED;
-- If locked: Returns 0 rows instead of blocking
```

### FOR SHARE

`SELECT ... FOR SHARE` acquires a shared row lock. Multiple transactions can hold FOR SHARE on the same row simultaneously, but none of them can UPDATE or DELETE it until all shared locks are released.

**Use case — ensuring referenced data doesn't change:**

```sql
-- Ensure the user exists and doesn't get deleted while we create an order
BEGIN;

SELECT id FROM users WHERE id = 42 FOR SHARE;
-- Row is share-locked — other transactions can read it but can't DELETE or UPDATE it

INSERT INTO orders (user_id, total, created_at)
VALUES (42, 199.99, now());

COMMIT;
```

This is similar to what PostgreSQL does internally with foreign key checks — it acquires a FOR KEY SHARE lock on the referenced row.

### SKIP LOCKED — Building a Job Queue

`SKIP LOCKED` is the foundation for building reliable job queues in PostgreSQL without external infrastructure like Redis or RabbitMQ.

```sql
-- Job queue table
CREATE TABLE job_queue (
    id          bigserial PRIMARY KEY,
    job_type    text NOT NULL,
    payload     jsonb NOT NULL,
    status      text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    attempts    integer NOT NULL DEFAULT 0,
    max_attempts integer NOT NULL DEFAULT 3,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    locked_by   text,
    locked_at   timestamptz
);

CREATE INDEX idx_job_queue_pending
    ON job_queue (created_at)
    WHERE status = 'pending';
```

**Worker fetches the next available job:**

```sql
-- Each worker runs this — SKIP LOCKED ensures no two workers get the same job
BEGIN;

UPDATE job_queue
SET status = 'processing',
    locked_by = 'worker-' || pg_backend_pid()::text,
    locked_at = now(),
    attempts = attempts + 1,
    updated_at = now()
WHERE id = (
    SELECT id FROM job_queue
    WHERE status = 'pending'
      AND attempts < max_attempts
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
)
RETURNING id, job_type, payload;
```

What this does:

1. The inner SELECT finds the oldest pending job that hasn't exhausted its retries.
2. `FOR UPDATE SKIP LOCKED` locks the row — but if another worker already locked it, the subquery skips to the next available row instead of waiting.
3. The outer UPDATE atomically changes the status to 'processing'.
4. `RETURNING` gives you the job details to process.

**Batch dequeue (process N jobs at once):**

```sql
BEGIN;

WITH next_jobs AS (
    SELECT id FROM job_queue
    WHERE status = 'pending'
      AND attempts < max_attempts
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 10
)
UPDATE job_queue jq
SET status = 'processing',
    locked_by = 'worker-' || pg_backend_pid()::text,
    locked_at = now(),
    attempts = attempts + 1,
    updated_at = now()
FROM next_jobs
WHERE jq.id = next_jobs.id
RETURNING jq.id, jq.job_type, jq.payload;

-- Process the jobs...

COMMIT;
```

**Complete worker implementation in Node.js:**

```typescript
interface Job {
  id: number;
  job_type: string;
  payload: Record<string, unknown>;
}

async function processJobs(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query<Job>(`
      UPDATE job_queue
      SET status = 'processing',
          locked_by = 'worker-' || pg_backend_pid()::text,
          locked_at = now(),
          attempts = attempts + 1,
          updated_at = now()
      WHERE id = (
          SELECT id FROM job_queue
          WHERE status = 'pending'
            AND attempts < max_attempts
          ORDER BY created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
      )
      RETURNING id, job_type, payload
    `);

    if (rows.length === 0) {
      await client.query('COMMIT');
      return; // No jobs available
    }

    const job = rows[0];
    try {
      await executeJob(job);
      await client.query(
        `UPDATE job_queue
         SET status = 'completed', updated_at = now()
         WHERE id = $1`,
        [job.id]
      );
    } catch (err) {
      await client.query(
        `UPDATE job_queue
         SET status = CASE
             WHEN attempts >= max_attempts THEN 'failed'
             ELSE 'pending'
           END,
           locked_by = NULL,
           locked_at = NULL,
           updated_at = now()
         WHERE id = $1`,
        [job.id]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
```

> **What a senior engineer actually thinks about**
>
> SKIP LOCKED job queues work surprisingly well for moderate throughput (thousands of jobs per second). They're simpler to operate than a separate message broker and transactionally consistent with your other data. But they come with caveats: high-throughput queues create significant write load (each job state transition is an UPDATE → dead tuple), the partial index needs maintenance, and you need to handle stale "processing" jobs (workers that crashed without completing). For truly high-throughput event streaming, use Kafka. For reliable task queues integrated with your data, PostgreSQL + SKIP LOCKED is excellent.

**PG version note:** `SKIP LOCKED` was added in PostgreSQL 9.5. The `FOR NO KEY UPDATE` and `FOR KEY SHARE` modes were added in PostgreSQL 9.3.

---

## 6.7 Optimistic vs Pessimistic Locking

These are application-level strategies for handling concurrent access, not database features per se. PostgreSQL provides the mechanisms for both; you choose based on your contention profile.

### Pessimistic Locking

**Approach:** Lock first, then work. Assume conflicts are likely. Use `SELECT FOR UPDATE`, advisory locks, or explicit `LOCK TABLE`.

```sql
-- Pessimistic: lock the seat, then book it
BEGIN;
SELECT * FROM seats WHERE seat_id = 'A1' AND event_id = 100 FOR UPDATE;
-- Row is locked — nobody else can touch it
UPDATE seats SET status = 'booked', booked_by = 42 WHERE seat_id = 'A1' AND event_id = 100;
COMMIT;
```

**When to use:**
- High contention: many concurrent requests targeting the same rows
- Short-lived locks: you can acquire and release quickly
- Critical operations where you can't afford retries (payment processing)

**Trade-offs:**
- Blocks other transactions (potential for reduced throughput and deadlocks)
- Simple to reason about — if you got the lock, you own the data
- No retry logic needed (unless deadlocked)

### Optimistic Locking

**Approach:** Don't lock anything. Read the data, do your work, and at write time check if anyone else modified it. If so, retry.

**Implementation with a version column:**

```sql
CREATE TABLE products (
    id          integer PRIMARY KEY,
    name        text NOT NULL,
    price       numeric(10,2) NOT NULL,
    description text,
    version     integer NOT NULL DEFAULT 1,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Read the product (no lock)
SELECT id, name, price, description, version
FROM products WHERE id = 42;
-- Returns: id=42, name='Widget', price=29.99, version=5

-- Later, update with version check
UPDATE products
SET price = 34.99,
    version = version + 1,
    updated_at = now()
WHERE id = 42 AND version = 5;
-- If another transaction already incremented version to 6,
-- this WHERE clause matches 0 rows
```

Check the row count in your application:

```typescript
async function updateProductPrice(
  pool: Pool,
  productId: number,
  newPrice: number,
  expectedVersion: number,
  maxRetries = 3
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const result = await pool.query(
      `UPDATE products
       SET price = $1, version = version + 1, updated_at = now()
       WHERE id = $2 AND version = $3`,
      [newPrice, productId, expectedVersion]
    );

    if (result.rowCount === 1) {
      return; // Success
    }

    if (attempt >= maxRetries) {
      throw new Error(
        `Optimistic lock failure: product ${productId} was modified concurrently`
      );
    }

    // Re-read and retry
    const { rows } = await pool.query(
      'SELECT version FROM products WHERE id = $1',
      [productId]
    );
    if (rows.length === 0) {
      throw new Error(`Product ${productId} not found`);
    }
    expectedVersion = rows[0].version;
    // Recompute newPrice if it depends on current state...
  }
}
```

**Implementation with `updated_at` timestamp:**

```sql
-- Read
SELECT id, name, price, updated_at FROM products WHERE id = 42;
-- Returns: updated_at = '2025-03-15 10:00:00+00'

-- Update with timestamp check
UPDATE products
SET price = 34.99,
    updated_at = now()
WHERE id = 42 AND updated_at = '2025-03-15 10:00:00+00';
```

The timestamp approach is simpler (no extra column) but has a resolution issue: if two transactions happen within the same clock tick, they'll both succeed. In practice, `timestamptz` has microsecond resolution so this is unlikely but possible. The version column approach is strictly correct.

**When to use optimistic locking:**

- Low contention: concurrent conflicts are rare
- Long-running operations: user is editing a form for minutes, you can't hold a database lock the whole time
- Stateless APIs: you read data, return it to the client, and the client sends it back later
- CMS, admin panels, configuration editors

**Performance comparison:**

| Aspect | Pessimistic | Optimistic |
|---|---|---|
| Lock acquisition overhead | Yes (but fast for row locks) | None |
| Blocking other transactions | Yes | No |
| Retry on conflict | Only on deadlock | Always on conflict |
| Throughput under low contention | Good | Slightly better (no lock overhead) |
| Throughput under high contention | Degraded (blocking) | Degraded (retries and wasted work) |
| Deadlock risk | Yes | No |
| Implementation complexity | Lower | Higher (retry logic, version management) |

**Hybrid approach — optimistic read, pessimistic write:**

A common production pattern combines both: use optimistic locking for the long "think time" (user editing a form) and pessimistic locking for the brief critical write:

```sql
-- Step 1: Client reads product with version (no lock)
-- GET /api/products/42
-- Returns: { id: 42, price: 29.99, version: 5 }

-- Step 2: Client edits for 30 seconds, then submits
-- PUT /api/products/42 { price: 34.99, version: 5 }

-- Step 3: Server does pessimistic lock + version check
BEGIN;
SELECT version FROM products WHERE id = 42 FOR UPDATE;
-- Got version 5? Great, apply the change:
UPDATE products SET price = 34.99, version = 6, updated_at = now()
WHERE id = 42;
COMMIT;
-- Got version 6? Someone else edited it. Return 409 Conflict to client.
```

---

## 6.8 Savepoints

A savepoint is a named checkpoint within a transaction that you can roll back to without aborting the entire transaction. Think of them like `try/catch` blocks inside a transaction.

Frontend analogy: if a transaction is like a batch of state changes being applied, a savepoint is like creating a snapshot of intermediate state that you can restore to if part of the batch fails — similar to structuredClone-ing your state before a risky operation.

### Basic Usage

```sql
BEGIN;

INSERT INTO orders (customer_id, total) VALUES (42, 199.99);
-- order created with id = 1001

SAVEPOINT before_items;

INSERT INTO order_items (order_id, product_id, quantity, price)
VALUES (1001, 5, 2, 49.99);
-- Works fine

INSERT INTO order_items (order_id, product_id, quantity, price)
VALUES (1001, 999, 1, 99.99);
-- ERROR: product 999 violates foreign key constraint

-- Without savepoint, the entire transaction would be aborted.
-- With savepoint, we can recover:
ROLLBACK TO SAVEPOINT before_items;

-- Transaction is still alive! The order still exists.
-- Try inserting items with valid products:
INSERT INTO order_items (order_id, product_id, quantity, price)
VALUES (1001, 5, 2, 49.99);

INSERT INTO order_items (order_id, product_id, quantity, price)
VALUES (1001, 10, 1, 99.99);

RELEASE SAVEPOINT before_items;
-- Savepoint is dissolved — its changes are part of the main transaction now

COMMIT;
```

### Commands

| Command | Effect |
|---|---|
| `SAVEPOINT name` | Creates a named savepoint |
| `ROLLBACK TO SAVEPOINT name` | Rolls back all changes made after the savepoint. The savepoint still exists and can be rolled back to again |
| `RELEASE SAVEPOINT name` | Destroys the savepoint. Changes made after it are now part of the enclosing transaction. Does NOT commit anything |

**Important:** `RELEASE SAVEPOINT` does NOT commit. It just removes the savepoint marker. All changes are still part of the outer transaction and will be committed or rolled back with it.

### Nested Savepoints

Savepoints can be nested:

```sql
BEGIN;

SAVEPOINT sp1;
INSERT INTO logs (message) VALUES ('step 1');

    SAVEPOINT sp2;
    INSERT INTO logs (message) VALUES ('step 2');

        SAVEPOINT sp3;
        INSERT INTO logs (message) VALUES ('step 3');
        -- Oops, step 3 failed
        ROLLBACK TO SAVEPOINT sp3;
        -- step 3 is undone, but steps 1 and 2 remain

    RELEASE SAVEPOINT sp2;
    -- step 2 is now part of sp1's scope

COMMIT;
-- Final result: steps 1 and 2 are committed, step 3 is not
```

### Production Use Cases

**1. Batch processing with partial failure tolerance:**

```sql
CREATE OR REPLACE FUNCTION import_products(data jsonb)
RETURNS TABLE(product_id integer, status text, error_message text)
AS $$
DECLARE
    item jsonb;
    new_id integer;
BEGIN
    FOR item IN SELECT * FROM jsonb_array_elements(data)
    LOOP
        BEGIN
            SAVEPOINT import_item;

            INSERT INTO products (name, price, description)
            VALUES (
                item->>'name',
                (item->>'price')::numeric,
                item->>'description'
            )
            RETURNING id INTO new_id;

            product_id := new_id;
            status := 'imported';
            error_message := NULL;
            RETURN NEXT;

            RELEASE SAVEPOINT import_item;
        EXCEPTION WHEN OTHERS THEN
            ROLLBACK TO SAVEPOINT import_item;

            product_id := NULL;
            status := 'failed';
            error_message := SQLERRM;
            RETURN NEXT;
        END;
    END LOOP;
END;
$$ LANGUAGE plpgsql;
```

```sql
SELECT * FROM import_products('[
    {"name": "Widget X", "price": 10.00, "description": "Good widget"},
    {"name": null, "price": 20.00, "description": "Bad - null name"},
    {"name": "Widget Z", "price": 30.00, "description": "Another good one"}
]'::jsonb);
```

```
 product_id | status   | error_message
------------+----------+------------------------------------------
         15 | imported |
            | failed   | null value in column "name" violates
            |          | not-null constraint
         16 | imported |
```

Products 1 and 3 are imported; product 2 failed but didn't abort the whole batch.

**PL/pgSQL note:** In PL/pgSQL `BEGIN ... EXCEPTION ... END` blocks, PostgreSQL internally creates and manages savepoints for you. Each EXCEPTION block is a savepoint. This is why exception handling in PL/pgSQL has a performance cost — creating savepoints isn't free.

**2. Idempotent upserts in a larger transaction:**

```sql
BEGIN;

-- Main transaction work
UPDATE customer_stats SET total_orders = total_orders + 1 WHERE customer_id = 42;

SAVEPOINT upsert_address;
BEGIN
    INSERT INTO customer_addresses (customer_id, address_type, street, city, zip)
    VALUES (42, 'shipping', '123 Main St', 'Springfield', '62701');
EXCEPTION WHEN unique_violation THEN
    ROLLBACK TO SAVEPOINT upsert_address;
    UPDATE customer_addresses
    SET street = '123 Main St', city = 'Springfield', zip = '62701'
    WHERE customer_id = 42 AND address_type = 'shipping';
END;

COMMIT;
```

> **What a senior engineer actually thinks about**
>
> Savepoints have overhead — each one creates a subtransaction, which has its own entry in the transaction state tracking. Heavy use of savepoints (hundreds or thousands in a single transaction) can degrade performance. The PL/pgSQL EXCEPTION block cost is the most common place this shows up. Don't put an EXCEPTION block inside a tight loop iterating over millions of rows — restructure your logic to validate before inserting, or batch your error handling.

---

## 6.9 Transaction Management Patterns

This section covers the operational patterns that separate production-ready transaction code from tutorial code. These are the things that won't show up in a SQL textbook but will save you at 3 AM.

### Long Transactions and Their Cost

A "long transaction" is any transaction that stays open for more than a few seconds. In PostgreSQL, long transactions are toxic for three reasons:

**1. VACUUM cannot clean up:**

VACUUM removes dead tuples (the old versions left behind by UPDATEs and DELETEs). But it can only remove tuples that no active transaction might need. If Transaction A started 30 minutes ago with Repeatable Read, VACUUM cannot remove any dead tuples created after Transaction A's snapshot — even if the table has accumulated millions of dead tuples from other transactions.

```sql
-- Check for the "oldest" transaction holding back VACUUM
SELECT
    pid,
    age(clock_timestamp(), xact_start) AS transaction_age,
    state,
    query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL
ORDER BY xact_start
LIMIT 5;
```

```sql
-- Check how many dead tuples are piling up
SELECT
    schemaname,
    relname,
    n_live_tup,
    n_dead_tup,
    n_dead_tup::float / NULLIF(n_live_tup, 0) AS dead_ratio,
    last_autovacuum
FROM pg_stat_user_tables
WHERE n_dead_tup > 10000
ORDER BY n_dead_tup DESC;
```

**2. Lock holding:**

Every lock acquired during the transaction is held until COMMIT or ROLLBACK. A long transaction that updated a row 20 minutes ago is still holding that row lock. Any other transaction that needs to modify that row is blocked for the entire duration.

**3. Connection holding:**

Each open transaction consumes a database connection. If your pool has 20 connections and 5 are sitting in long transactions, you've lost 25% of your capacity.

### idle_in_transaction_session_timeout

PostgreSQL can automatically kill sessions that have been idle inside a transaction for too long:

```sql
-- Kill transactions that have been idle for more than 30 seconds
SET idle_in_transaction_session_timeout = '30s';

-- Or set it server-wide in postgresql.conf:
-- idle_in_transaction_session_timeout = 30000  (milliseconds)

-- Or per-user:
ALTER ROLE web_app SET idle_in_transaction_session_timeout = '30s';
```

When triggered, the session's transaction is aborted and the connection is terminated:

```
FATAL:  terminating connection due to idle-in-transaction timeout
```

**PG version note:** This setting was added in PostgreSQL 9.6. PostgreSQL 14 added `idle_session_timeout` which is similar but applies to idle sessions outside of transactions too.

### statement_timeout

Limits how long any single statement can run:

```sql
-- No statement can run longer than 5 seconds
SET statement_timeout = '5s';

-- For a specific transaction:
BEGIN;
SET LOCAL statement_timeout = '30s';
-- Complex query that might take a while
SELECT ... ;
COMMIT;
-- statement_timeout reverts to the session default after COMMIT
```

**Important:** `statement_timeout` applies to individual statements, not the whole transaction. A transaction with 100 fast statements can run as long as needed. Use `idle_in_transaction_session_timeout` for transaction-level protection.

### lock_timeout

How long to wait for a lock before giving up:

```sql
SET lock_timeout = '3s';

-- Now any lock request that takes longer than 3 seconds will error:
-- ERROR:  canceling statement due to lock timeout
```

This is essential for DDL operations in production:

```sql
-- Safe migration pattern
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE users ADD COLUMN last_login timestamptz;
COMMIT;
```

If the ALTER TABLE can't get its ACCESS EXCLUSIVE lock within 5 seconds (because long-running queries are holding ACCESS SHARE), it fails cleanly instead of sitting in the lock queue and blocking everything.

### Keeping Transactions Short

**Pattern 1: Read outside, write inside:**

```typescript
// BAD: Long transaction spanning HTTP calls and business logic
const client = await pool.connect();
await client.query('BEGIN');
const user = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
const permissions = await client.query(
  'SELECT * FROM permissions WHERE user_id = $1', [userId]
);
// ... lots of business logic, maybe external API calls ...
await client.query('UPDATE users SET last_active = now() WHERE id = $1', [userId]);
await client.query('COMMIT');
client.release();

// GOOD: Read without explicit transaction, write in a short transaction
const { rows: [user] } = await pool.query(
  'SELECT * FROM users WHERE id = $1', [userId]
);
const { rows: permissions } = await pool.query(
  'SELECT * FROM permissions WHERE user_id = $1', [userId]
);
// ... lots of business logic, maybe external API calls ...
await pool.query(
  'UPDATE users SET last_active = now() WHERE id = $1', [userId]
);
```

**Pattern 2: Batch processing with chunked transactions:**

```sql
-- BAD: One giant transaction that updates 10 million rows
BEGIN;
UPDATE orders SET archived = true WHERE created_at < '2024-01-01';
COMMIT;
-- Holds locks on millions of rows, creates millions of dead tuples,
-- blocks VACUUM for the entire duration

-- GOOD: Process in batches
DO $$
DECLARE
    batch_size integer := 5000;
    rows_updated integer;
BEGIN
    LOOP
        UPDATE orders SET archived = true
        WHERE id IN (
            SELECT id FROM orders
            WHERE created_at < '2024-01-01' AND archived = false
            LIMIT batch_size
            FOR UPDATE SKIP LOCKED
        );
        GET DIAGNOSTICS rows_updated = ROW_COUNT;
        RAISE NOTICE 'Updated % rows', rows_updated;

        IF rows_updated = 0 THEN EXIT; END IF;

        -- Let VACUUM and other transactions breathe
        PERFORM pg_sleep(0.1);
    END LOOP;
END $$;
```

The DO block version above still runs in a single transaction. For true batch commits, use application code:

```typescript
async function archiveOldOrders(pool: Pool): Promise<number> {
  let totalArchived = 0;
  const batchSize = 5000;

  while (true) {
    const result = await pool.query(`
      UPDATE orders SET archived = true
      WHERE id IN (
        SELECT id FROM orders
        WHERE created_at < '2024-01-01' AND archived = false
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
    `, [batchSize]);

    totalArchived += result.rowCount ?? 0;

    if ((result.rowCount ?? 0) < batchSize) {
      break; // No more rows to process
    }

    // Optional: small delay to reduce pressure
    await new Promise(r => setTimeout(r, 100));
  }

  return totalArchived;
}
```

**Pattern 3: Connection pool hygiene:**

```typescript
// BAD: Forgetting to release client on error
const client = await pool.connect();
await client.query('BEGIN');
await client.query('UPDATE ...');
// If this throws, client is never released and transaction stays open
await client.query('UPDATE ...');
await client.query('COMMIT');
client.release();

// GOOD: Always release in finally
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('UPDATE ...');
  await client.query('UPDATE ...');
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
}
```

**Pattern 4: Use pool.query() for single statements:**

```typescript
// If you're only executing a single statement, don't use a transaction.
// pool.query() checks out a client, runs the query, and releases — atomically.
await pool.query('INSERT INTO events (type, data) VALUES ($1, $2)', [type, data]);
```

> **What a senior engineer actually thinks about**
>
> Set `idle_in_transaction_session_timeout` in every production database. I typically use 30 seconds for web applications and 5 minutes for ETL/analytics users. Add `statement_timeout` too — 30 seconds for web app roles, longer for batch processing roles. These are your safety nets. They turn "mysterious connection exhaustion at 2 AM" into "a bad query got killed and the app recovered automatically."

---

## 6.10 Things That Will Bite You in Production

This section is a war-stories checklist. Every item here has caused real production incidents.

### 1. The Forgotten Transaction

A developer opens a `psql` session, runs `BEGIN`, does some exploratory queries, gets distracted, and leaves the session open for hours. That idle-in-transaction session is holding back VACUUM across the entire database. Dead tuples accumulate. Tables bloat. Index-only scans degrade as the VM becomes stale. Eventually query performance degrades enough to trigger alerts.

**Fix:**
```sql
-- Set globally
ALTER SYSTEM SET idle_in_transaction_session_timeout = '60s';
SELECT pg_reload_conf();

-- Monitor
SELECT pid, state, age(clock_timestamp(), xact_start) AS tx_age, query
FROM pg_stat_activity
WHERE state = 'idle in transaction'
ORDER BY xact_start;
```

### 2. ALTER TABLE Lock Queue Convoy

You run `ALTER TABLE users ADD COLUMN ...` during business hours. It needs ACCESS EXCLUSIVE, which conflicts with the ACCESS SHARE locks held by every SELECT on the table. The ALTER TABLE enters the lock queue. Every new SELECT arriving also gets queued behind it. Within seconds, your connection pool is exhausted.

**Fix:**
```sql
SET lock_timeout = '3s';
ALTER TABLE users ADD COLUMN last_login timestamptz;
-- Retry if it fails. Don't let it sit in the queue.
```

### 3. ORM-Generated Long Transactions

Many ORMs (Sequelize, TypeORM, Prisma) wrap request handlers in transactions by default or make it easy to accidentally hold a transaction across async operations. Your code might be:

```typescript
// This is implicitly holding a transaction open while you call
// an external HTTP API — potentially for seconds
await prisma.$transaction(async (tx) => {
  const user = await tx.user.findUnique({ where: { id: 1 } });
  const enriched = await fetch('https://api.external.com/enrich', {
    body: JSON.stringify(user)
  }); // <-- THIS IS INSIDE A TRANSACTION
  await tx.user.update({
    where: { id: 1 },
    data: { enrichedData: await enriched.json() }
  });
});
```

**Fix:** Move external calls outside the transaction. Read before, write after.

### 4. Serialization Failures Without Retry Logic

You switch to Repeatable Read or Serializable but forget to add retry logic. Under any meaningful concurrency, your application starts throwing `40001` errors that propagate to users as 500s.

**Fix:** Every codepath that uses Repeatable Read or Serializable MUST have retry logic with exponential backoff. See section 6.2.2 for the implementation.

### 5. Deadlocks from Inconsistent Lock Ordering

Application A transfers money from account 1 to account 2 (locks 1 then 2). Application B transfers money from account 2 to account 1 (locks 2 then 1). Under load, deadlocks happen constantly.

**Fix:** Always acquire locks in a deterministic order (e.g., ascending ID). See section 6.5.

### 6. SKIP LOCKED Job Queue Without Stale Job Recovery

Workers crash after dequeuing a job (status = 'processing') but before completing it. The job is stuck in 'processing' forever — no worker will pick it up because it's not 'pending'.

**Fix:** A periodic sweeper that resets stale jobs:

```sql
-- Run every minute via pg_cron or an application scheduler
UPDATE job_queue
SET status = 'pending',
    locked_by = NULL,
    locked_at = NULL,
    updated_at = now()
WHERE status = 'processing'
  AND locked_at < now() - interval '5 minutes'
  AND attempts < max_attempts;
```

### 7. SELECT FOR UPDATE on a Table with No Index

If your `WHERE` clause in a `SELECT FOR UPDATE` doesn't use an index, PostgreSQL does a sequential scan and locks every row it examines, even rows that don't match the final filter:

```sql
-- No index on customer_id — locks ALL rows during the scan
SELECT * FROM orders WHERE customer_id = 42 FOR UPDATE;
```

Under high concurrency, this serializes all access to the table.

**Fix:** Ensure there's an index on columns used in FOR UPDATE queries. Verify with EXPLAIN:

```sql
EXPLAIN SELECT * FROM orders WHERE customer_id = 42 FOR UPDATE;
-- Should show Index Scan, not Seq Scan
```

### 8. Running VACUUM FULL in Production

`VACUUM FULL` rewrites the entire table, requires ACCESS EXCLUSIVE (blocks all reads and writes), and can take hours on large tables. Regular `VACUUM` (without FULL) is usually sufficient.

**Fix:** Use `pg_repack` extension instead of VACUUM FULL if you need to reclaim space from a bloated table without blocking:

```sql
-- pg_repack repacks the table with minimal locking
-- Install the extension first
CREATE EXTENSION pg_repack;
-- Then from the command line:
-- pg_repack -t inventory --no-superuser-check mydatabase
```

### 9. Misunderstanding Read Committed + Aggregations

Under Read Committed, aggregate queries (SUM, COUNT) can produce results that never existed as a consistent snapshot:

```sql
-- Table has 100 accounts each with $1000 = $100,000 total
-- A transfer moves $500 from account 1 to account 100

-- If this SUM happens to read account 1 BEFORE the transfer
-- and account 100 AFTER the transfer, it sees:
-- account 1: $1000 (pre-transfer)
-- account 100: $1500 (post-transfer)
-- Total: $100,500 — $500 too high!

SELECT sum(balance) FROM accounts;
-- Might return a value that was never the "real" total
```

**Fix:** Use Repeatable Read for reports and aggregations that must be consistent.

### 10. Transaction ID Wraparound

PostgreSQL uses 32-bit transaction IDs that wrap around at about 4 billion. If VACUUM can't freeze old tuples (because long transactions hold back the freeze point), the database will eventually shut down to prevent data corruption:

```
WARNING:  database "mydb" must be vacuumed within 10000000 transactions
HINT:  To avoid a database shutdown, execute a database-wide VACUUM in "mydb".
```

This is the scariest PostgreSQL error you can get in production.

**Fix:**
```sql
-- Monitor transaction ID age
SELECT
    datname,
    age(datfrozenxid) AS xid_age,
    current_setting('autovacuum_freeze_max_age')::integer AS freeze_max
FROM pg_database
ORDER BY age(datfrozenxid) DESC;

-- If xid_age approaches freeze_max (default 200M), something is wrong.
-- Check for long-running transactions, fix them, then run:
VACUUM FREEZE;
```

**PG version note:** PostgreSQL 14 improved the anti-wraparound VACUUM performance significantly. PostgreSQL 15 added improvements to the visibility map freeze logic. Always keep PostgreSQL updated for the latest VACUUM improvements.

### 11. Connection Pool Size vs max_connections

Your application servers have `poolSize = 20` each, and you have 10 servers. That's 200 connections needed, but `max_connections = 100`. Under load, connections time out. Or worse, `max_connections = 1000` and you have 1000 connections fighting for CPU and memory.

**Fix:** Use a connection pooler like PgBouncer between your application and PostgreSQL. Set `max_connections` conservatively (100–300) and let PgBouncer multiplex thousands of application connections into a smaller number of real database connections. Keep individual transactions short so connections cycle quickly.

### 12. Mixing DDL and DML in a Transaction

```sql
BEGIN;
CREATE TABLE temp_import (data jsonb);
INSERT INTO temp_import SELECT * FROM ...;
-- Long processing...
DROP TABLE temp_import;
COMMIT;
```

The CREATE TABLE acquires an ACCESS EXCLUSIVE lock on the pg_catalog tables. If this transaction runs for a while, it can interfere with autovacuum and other DDL. More importantly, if this transaction fails, the CREATE TABLE is rolled back — but the space allocated for the table is not freed until VACUUM runs on the system catalogs.

**Fix:** Use `CREATE TEMPORARY TABLE` for ephemeral data — temp tables are session-scoped and automatically cleaned up.

---

**Final thought:** Transactions and concurrency are where "it works on my laptop" diverges most dramatically from "it works in production." On your laptop, there's one connection and no contention. In production, there are hundreds of connections, autovacuum running, background jobs, long-running reports, and DDL migrations — all at the same time. Every decision you make about transaction scope, isolation level, and locking strategy has consequences you won't see until there's real load. Build the habits now: keep transactions short, understand what locks your queries acquire, set timeouts as safety nets, and always have retry logic when using anything above Read Committed.
