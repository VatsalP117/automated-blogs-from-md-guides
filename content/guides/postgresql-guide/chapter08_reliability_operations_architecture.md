# Chapter 8 — Reliability, Operations, and Architecture

## Table of Contents

- [8.1 WAL in Depth](#81-wal-in-depth)
- [8.2 Replication](#82-replication)
- [8.3 Backup Strategies](#83-backup-strategies)
- [8.4 Vacuuming in Depth](#84-vacuuming-in-depth)
- [8.5 High Availability Patterns](#85-high-availability-patterns)
- [8.6 Read Replicas](#86-read-replicas)
- [8.7 Sharding](#87-sharding)
- [8.8 Monitoring and Observability](#88-monitoring-and-observability)
- [8.9 Things That Will Bite You in Production](#89-things-that-will-bite-you-in-production)

---

## 8.1 WAL in Depth

### What the WAL Actually Is

The Write-Ahead Log (WAL) is PostgreSQL's single most important reliability mechanism. The concept is deceptively simple: before any change to actual data files is flushed to disk, a description of that change is first written to a sequential, append-only log. If the server crashes, PostgreSQL replays the WAL from the last known-good checkpoint to reconstruct any changes that were in-flight.

**Frontend analogy:** Think of WAL like an `undo/redo` log in a collaborative editor (e.g., Google Docs operational transforms). Every mutation is logged sequentially before the document state is updated. If the app crashes mid-edit, you replay the log to reconstruct the current state.

### Why Not Just Write Data Directly?

Data files are organized as 8 KB pages scattered across potentially many files on disk. Updating a single row means:

1. Reading the page containing that row into shared buffers (RAM).
2. Modifying the tuple in memory.
3. Eventually flushing that dirty page to disk.

The problem is that a single transaction might modify dozens of pages across different files. If the system crashes halfway through flushing those pages, you have a **torn write** — some pages reflect the transaction, others don't. Your database is now inconsistent.

WAL solves this because:
- WAL writes are **sequential** (append-only to a single stream), which is the fastest possible I/O pattern for spinning disks and still very fast on SSDs.
- WAL writes happen **before** data page writes.
- WAL records contain enough information to **redo** the operation on the data page.
- After a crash, PostgreSQL reads the WAL forward from the last checkpoint and replays any records whose changes weren't yet flushed to data files.

### What Gets Written to WAL

Every modification to the database produces one or more WAL records. Specifically:

| Operation | WAL Record Contains |
|---|---|
| INSERT | The full new tuple (or a compressed delta if full_page_writes applies) |
| UPDATE | The new tuple data, reference to old tuple location (for visibility) |
| DELETE | Reference to the tuple being marked dead |
| Index modification | The index entry being added or removed |
| Commit | A commit record with the transaction ID and timestamp |
| Abort | An abort record |
| Checkpoint | A checkpoint record marking the LSN up to which all data pages are flushed |
| Schema changes | DDL operations (table creation, ALTER TABLE, etc.) |
| Page first-modified after checkpoint | A full-page image (FPI) — the entire 8 KB page — if `full_page_writes = on` |

**Full Page Images (FPI):** After a checkpoint, the first time any page is modified, PostgreSQL writes the **entire** 8 KB page into the WAL before the change. This protects against partial page writes — if the OS writes only half of an 8 KB page to disk during a crash, PostgreSQL can restore the full page from the WAL. This is called a "full-page write" or "backup block."

```
-- You can see full_page_writes status:
SHOW full_page_writes;
-- Default: on (and you should almost never turn it off)
```

### WAL Record Structure

Each WAL record has this structure:

```
+------------------+-------------------+---------------------------+
| WAL Record Header | Record-type data  | Optional Full Page Image  |
+------------------+-------------------+---------------------------+
| - xl_tot_len     | Depends on        | Complete 8KB page if      |
| - xl_xid (txn)   | operation type    | first modification after  |
| - xl_prev (prev   | (heap_insert,     | checkpoint                |
|   record LSN)    |  heap_update,     |                           |
| - xl_info        |  btree_insert,    |                           |
| - xl_rmid        |  etc.)            |                           |
|   (resource mgr) |                   |                           |
+------------------+-------------------+---------------------------+
```

The `xl_rmid` (Resource Manager ID) indicates which subsystem generated the record — heap, btree, hash, transaction, etc. Each resource manager knows how to replay its own record types.

### LSN: Log Sequence Number

Every WAL record is identified by its **Log Sequence Number (LSN)** — a 64-bit integer representing the byte offset within the WAL stream. LSNs are written as two 32-bit hex values separated by a slash:

```sql
-- Current WAL write position:
SELECT pg_current_wal_lsn();
-- Result: 0/16B3790

-- Current WAL insert position (might be ahead of write):
SELECT pg_current_wal_insert_lsn();

-- Convert LSN to a numeric byte offset:
SELECT pg_current_wal_lsn() - '0/0'::pg_lsn AS bytes_written;
```

Every data page also stores the LSN of the last WAL record that modified it. During crash recovery, PostgreSQL compares the page's LSN with the WAL record's LSN — if the page's LSN is already >= the record's LSN, that record's change was already flushed, so it's skipped.

### WAL Segment Files

WAL is stored as a series of 16 MB files (by default) in `pg_wal/`:

```
pg_wal/
├── 000000010000000000000001
├── 000000010000000000000002
├── 000000010000000000000003
├── ...
```

The filename encodes the timeline ID and the segment number. The timeline changes during point-in-time recovery or failover (more on this later).

```sql
-- Current WAL file:
SELECT pg_walfile_name(pg_current_wal_lsn());
-- Result: 000000010000000000000042

-- How much WAL is being generated:
SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0') AS total_wal_bytes;
```

**Segment size** can be configured at `initdb` time (PG 11+):

```bash
initdb --wal-segsize=64  # 64 MB segments instead of default 16 MB
```

Larger segments reduce file management overhead for write-heavy systems but waste more space when recycling.

### WAL Configuration Parameters

| Parameter | Default | What It Does | Tuning Guidance |
|---|---|---|---|
| `wal_level` | `replica` | Controls how much information is written. `minimal` for standalone, `replica` for replication, `logical` for logical replication/CDC. | Set to `logical` if you ever want logical replication or CDC tools like Debezium. Cannot be changed without restart. |
| `max_wal_size` | `1GB` | Target maximum size of WAL between automatic checkpoints. Not a hard limit. | Increase for write-heavy loads to reduce checkpoint frequency. 4–16 GB is common in production. |
| `min_wal_size` | `80MB` | Minimum size of WAL to retain even after checkpoint. Prevents recycling too aggressively. | Keep at 256MB–1GB on active systems to avoid constant file creation/deletion. |
| `wal_buffers` | `-1` (auto) | Shared memory for WAL records before flush. Auto = 1/32 of shared_buffers, capped at 16 MB. | 16 MB (the auto cap) is fine for most workloads. Rarely needs manual tuning. |
| `wal_compression` | `off` (PG <15), `lz4` option in PG 15+ | Compresses full-page images in WAL records. | Enable (`lz4` or `zstd` in PG 15+) to reduce WAL volume by 30–60%. Low CPU overhead. |
| `full_page_writes` | `on` | Writes full page image on first modification after checkpoint. | Leave on. Turning it off risks corruption on partial writes. Only safe on storage with atomic 8 KB writes (some enterprise SSDs with battery-backed write cache). |
| `wal_writer_delay` | `200ms` | How frequently the WAL writer process flushes WAL buffers to disk. | 10–50ms for latency-sensitive workloads. Only matters for asynchronous commits. |
| `synchronous_commit` | `on` | Whether COMMIT waits for WAL flush to disk. | Per-transaction setting. Set to `off` for non-critical writes that can tolerate losing the last ~600ms of commits on crash. Massive throughput improvement. |
| `commit_delay` | `0` | Microseconds to wait before flushing WAL, hoping to batch multiple commits. | 10–100µs on multi-user systems. Only effective when `commit_siblings` concurrent transactions exist. |
| `commit_siblings` | `5` | Minimum concurrent transactions before `commit_delay` activates. | Keep at 5–10. |
| `wal_keep_size` | `0` (PG 13+) | Minimum WAL to retain for standby replication, in MB. | Set based on maximum expected replication lag. 1–16 GB is typical. Replaced `wal_keep_segments` in PG 13. |

### The Checkpoint Process

A **checkpoint** is the act of flushing all dirty pages from shared buffers to their actual data files, then writing a checkpoint record to the WAL. After a checkpoint, all WAL records before that point are no longer needed for crash recovery (though they may still be needed for replication or archiving).

**Why checkpoints matter:** They bound crash recovery time. Without checkpoints, crash recovery would need to replay the entire WAL from the beginning of time. With checkpoints, recovery starts from the last checkpoint.

Checkpoints are triggered by:
1. `max_wal_size` worth of WAL has been generated since the last checkpoint.
2. `checkpoint_timeout` time has passed (default: 5 minutes).
3. A manual `CHECKPOINT` command.
4. Certain operations like `pg_start_backup()` (pre-PG 15) or `pg_backup_start()` (PG 15+).

```sql
-- Force a checkpoint (requires superuser):
CHECKPOINT;

-- See last checkpoint info:
SELECT * FROM pg_control_checkpoint();
```

**Spread checkpoints:** PostgreSQL doesn't flush all dirty pages at once (that would cause a massive I/O spike). The `checkpoint_completion_target` parameter (default: `0.9` since PG 14, was `0.5` before) spreads the writes over 90% of the time until the next checkpoint. This is critical for consistent I/O performance.

```
checkpoint_timeout = 15min     -- Longer interval = fewer checkpoints = less total I/O
max_wal_size = 8GB             -- Allow more WAL between checkpoints
checkpoint_completion_target = 0.9  -- Spread writes over 90% of interval
```

**What happens during a checkpoint:**

```
1. Write a checkpoint-start record to WAL
2. Identify all dirty pages in shared buffers
3. Sort dirty pages by file and block number (to reduce random I/O)
4. Write dirty pages to data files, spread over checkpoint_completion_target time
5. fsync all modified data files
6. Write a checkpoint-complete record to WAL
7. Recycle/remove WAL segments that are no longer needed
```

> **What a senior engineer actually thinks about when they see this:**
> "If my checkpoint takes longer than `checkpoint_timeout`, I'll see warnings in the logs: `LOG: checkpoints are occurring too frequently`. This means max_wal_size is too low for my write rate. I need to increase it to avoid constant checkpoint I/O. I also watch `pg_stat_bgwriter.checkpoints_req` (forced by WAL size) vs `checkpoints_timed` (triggered by timeout). If req >> timed, my max_wal_size is too small."

### Synchronous vs Asynchronous Commit

By default (`synchronous_commit = on`), when you issue `COMMIT`, PostgreSQL:
1. Writes the commit WAL record to the WAL buffer.
2. Flushes (fsyncs) the WAL buffer to disk.
3. Returns success to the client only after the fsync completes.

This guarantees **durability** — a committed transaction will survive a crash. But it means every commit must wait for a disk write, which limits throughput.

**Asynchronous commit** (`synchronous_commit = off`) skips step 2 — the WAL writer will flush it eventually (within `wal_writer_delay`, typically 200ms). You get much higher throughput but risk losing the last ~200ms of committed transactions on crash.

```sql
-- Per-transaction async commit (safe for non-critical data like page views):
BEGIN;
SET LOCAL synchronous_commit = off;
INSERT INTO page_views (url, ts) VALUES ('/home', now());
COMMIT;  -- Returns immediately without waiting for disk flush

-- Per-session:
SET synchronous_commit = off;
```

This is a **per-transaction** setting. You can use synchronous commit for financial transactions and async for analytics inserts in the same application.

### WAL Archiving

WAL archiving copies completed WAL segments to a separate location (local directory, S3, GCS, etc.) for backup and point-in-time recovery.

```
# postgresql.conf
archive_mode = on               # Enable archiving (requires restart)
archive_command = 'cp %p /archive/%f'  # Copy WAL file to archive directory
# or for S3:
# archive_command = 'aws s3 cp %p s3://my-wal-archive/%f'

archive_timeout = 300           # Force-switch to a new WAL file every 5 minutes
                                # even if current segment isn't full
                                # (limits max data loss for low-traffic databases)
```

The `%p` is the full path of the WAL file to archive. The `%f` is just the filename. The archive command must return exit code 0 on success — PostgreSQL won't remove the WAL segment until the archive command succeeds.

**PG 15+ introduced `archive_library`** as an alternative to `archive_command`, allowing archiving via a shared library (like `pg_basebackup`'s built-in archiver) instead of forking a shell process for every segment.

### WAL Summarizer (PG 17)

PostgreSQL 17 introduced the **WAL summarizer**, a background process that creates summaries of WAL activity. These summaries enable **incremental backups** — instead of backing up all data files, you only back up files that changed since the last backup. This is a game-changer for large databases where full backups take hours.

```
# postgresql.conf (PG 17+)
summarize_wal = on
```

---

## 8.2 Replication

### Why Replication Exists

Replication serves three purposes:
1. **High availability:** If the primary fails, a replica can take over.
2. **Read scaling:** Distribute read queries across replicas.
3. **Geographic distribution:** Place replicas close to users for lower latency.

PostgreSQL offers two fundamentally different replication mechanisms.

### Physical (Streaming) Replication

Physical replication ships WAL records from the primary to one or more standbys. The standby replays those WAL records against its own data files, producing an exact byte-for-byte copy of the primary.

**How it works:**

```
Primary                                  Standby
┌─────────┐                             ┌─────────┐
│ WAL      │──── WAL stream ──────────→ │ WAL      │
│ Sender   │    (TCP connection)        │ Receiver │
│ Process  │                            │ Process  │
└─────────┘                             └─────────┘
     ↑                                       │
     │                                       ↓
┌─────────┐                             ┌─────────┐
│ WAL      │                            │ Startup  │
│ Segments │                            │ Process  │
│ (pg_wal) │                            │ (replay) │
└─────────┘                             └─────────┘
```

1. The **WAL sender** process on the primary reads WAL records and streams them over TCP to the standby.
2. The **WAL receiver** process on the standby writes those records to its own `pg_wal/`.
3. The **startup (recovery) process** on the standby replays those WAL records against data files.

**Setting up streaming replication:**

On the **primary** (`postgresql.conf`):
```
wal_level = replica                    # Minimum for physical replication
max_wal_senders = 10                   # Max concurrent replication connections
wal_keep_size = 2GB                    # Keep WAL for slow standbys (PG 13+)
```

On the **primary** (`pg_hba.conf`):
```
# Allow replication connections from standby IPs
host replication replicator 10.0.0.0/24 scram-sha-256
```

Create the replication user:
```sql
CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'secure_password_here';
```

On the **standby**, create the base backup and start:
```bash
# Take a base backup from the primary
pg_basebackup -h primary-host -U replicator -D /var/lib/postgresql/data \
  --checkpoint=fast --wal-method=stream -P

# Create standby signal file (PG 12+):
touch /var/lib/postgresql/data/standby.signal
```

On the **standby** (`postgresql.conf`):
```
primary_conninfo = 'host=primary-host port=5432 user=replicator password=secure_password_here application_name=standby1'
hot_standby = on                       # Allow read-only queries on standby
```

Start the standby and it will connect to the primary and begin streaming.

**Replication slots** prevent the primary from removing WAL segments that the standby hasn't received yet:

```sql
-- On primary: create a replication slot
SELECT pg_create_physical_replication_slot('standby1_slot');

-- On standby, reference it in postgresql.conf:
-- primary_slot_name = 'standby1_slot'
```

Without slots, if a standby falls too far behind and the primary recycles needed WAL segments, the standby must be rebuilt from scratch. With slots, the primary retains WAL until the standby catches up — but this means a dead standby can cause WAL to accumulate indefinitely on the primary, eventually filling the disk.

```sql
-- Monitor replication slots:
SELECT slot_name, active, restart_lsn, 
       pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS lag_bytes
FROM pg_replication_slots;
```

### Synchronous vs Asynchronous Replication

**Asynchronous (default):** The primary doesn't wait for standbys to confirm receipt of WAL. Commits return immediately after the primary flushes to its own disk. If the primary crashes, the standby might be slightly behind — you lose the transactions that were committed on the primary but not yet received by the standby.

**Synchronous:** The primary waits for at least one standby to confirm before returning success to the client.

```
# On primary:
synchronous_standby_names = 'FIRST 1 (standby1, standby2)'
# Wait for the first standby in the list to confirm

# Or require any 1 of multiple standbys:
synchronous_standby_names = 'ANY 1 (standby1, standby2, standby3)'
```

There are different levels of synchronous confirmation:

| `synchronous_commit` setting | Primary waits for | Guarantee |
|---|---|---|
| `on` | Standby has **written WAL to disk** | No data loss, even if standby crashes |
| `remote_write` | Standby has **received WAL in memory** | Faster, but standby crash could lose data |
| `remote_apply` | Standby has **replayed WAL** (data is queryable) | Strongest — queries on standby see committed data immediately |

```sql
-- Per-transaction synchronous level:
BEGIN;
SET LOCAL synchronous_commit = 'remote_apply';
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
COMMIT;  -- Won't return until standby has applied this change
```

**Performance cost:** Synchronous replication adds network round-trip latency to every commit. For a standby in the same data center (~0.5ms RTT), this is often acceptable. For cross-region replication (~50-100ms RTT), it's brutal. Most production setups use synchronous replication within the same region and asynchronous for cross-region replicas.

### Replication Lag

The delay between when a transaction commits on the primary and when it's visible on a standby.

```sql
-- On primary: check lag per standby
SELECT application_name,
       client_addr,
       state,
       sent_lsn,
       write_lsn,
       flush_lsn,
       replay_lsn,
       pg_wal_lsn_diff(sent_lsn, replay_lsn) AS replay_lag_bytes,
       write_lag,
       flush_lag,
       replay_lag
FROM pg_stat_replication;

-- On standby: check how far behind
SELECT now() - pg_last_xact_replay_timestamp() AS replication_delay;
-- Warning: this only works if the primary has recent writes.
-- On idle primaries, this query will show an ever-increasing "lag" 
-- even though the standby is fully caught up.

-- Better on PG 10+:
SELECT * FROM pg_stat_wal_receiver;
```

**What causes replication lag:**
- Network latency between primary and standby.
- Standby disk I/O being slower than the primary's write rate.
- Long-running queries on the standby blocking replay (when `hot_standby_feedback = on` or `max_standby_streaming_delay` is set high).
- Large transactions that generate lots of WAL (bulk loads, large DELETEs).

### Logical Replication

Logical replication decodes WAL records into logical changes (INSERT, UPDATE, DELETE on specific tables) and sends those to subscribers. Unlike physical replication, it works at the table level, not the whole cluster.

**Key differences from physical replication:**

| Aspect | Physical | Logical |
|---|---|---|
| Granularity | Entire cluster | Per-table |
| Schema changes | Automatically replicated | Must be applied manually on subscriber |
| Cross-version | Must be same major version | Can replicate between different major versions |
| Cross-platform | Must be same OS/architecture | Platform-independent |
| Subscriber writable | No (read-only) | Yes (subscriber can have its own writes) |
| Use cases | HA failover, read replicas | Zero-downtime upgrades, selective replication, CDC |

**Setting up logical replication:**

On the **publisher** (source):
```sql
-- postgresql.conf: wal_level = logical (requires restart)

-- Create a publication:
CREATE PUBLICATION my_pub FOR TABLE orders, customers;

-- Or publish everything:
CREATE PUBLICATION all_tables FOR ALL TABLES;

-- Publish only specific operations:
CREATE PUBLICATION inserts_only FOR TABLE events WITH (publish = 'insert');
```

On the **subscriber** (target):
```sql
-- Tables must already exist with compatible schema on the subscriber

CREATE SUBSCRIPTION my_sub
  CONNECTION 'host=publisher-host dbname=mydb user=replicator password=secure_password_here'
  PUBLICATION my_pub;
```

The subscriber will:
1. Take an initial snapshot (copying all existing data from published tables).
2. Then switch to streaming logical changes in real-time.

```sql
-- Monitor logical replication:
SELECT * FROM pg_stat_subscription;     -- On subscriber
SELECT * FROM pg_stat_replication;       -- On publisher (shows logical too)
SELECT * FROM pg_replication_slots;      -- On publisher
```

**Logical replication gotchas:**
- **DDL is not replicated.** If you `ALTER TABLE` on the publisher, you must apply the same DDL on the subscriber manually. Schema mismatch will break replication.
- **Sequences are not replicated.** Subscriber tables using sequences will have stale values. After failover, you must manually advance sequences.
- **Large objects (LOBs) are not replicated.**
- **TRUNCATE** is replicated (PG 11+) but only within a publication.
- **Initial sync can be slow** for large tables. It takes an initial snapshot and copies all rows.
- **Conflict handling** is minimal — if the subscriber has a conflicting row (e.g., duplicate PK), replication stops. PG 15 added `disable_on_error` to handle this more gracefully. PG 16 added origin-based conflict detection.

### Change Data Capture (CDC)

Logical replication's decoding infrastructure powers CDC tools like **Debezium**, which reads PostgreSQL's logical replication stream and publishes it to Kafka, enabling real-time data pipelines.

```
PostgreSQL (wal_level=logical)
  → Logical Decoding (pgoutput or wal2json plugin)
    → Debezium Connector
      → Kafka Topics
        → Consumers (search indexing, analytics, caches, etc.)
```

This is how production systems keep Elasticsearch, Redis caches, and data warehouses in sync with the primary database without application-level dual-writes.

---

## 8.3 Backup Strategies

### The Three Approaches

| Method | What It Captures | Recovery Granularity | Speed | Use Case |
|---|---|---|---|---|
| `pg_dump` / `pg_dumpall` | Logical SQL dump | Point-of-dump only | Slow for large DBs | Small DBs, cross-version migration, selective table backup |
| `pg_basebackup` | Physical file copy | Point-of-backup + PITR with WAL | Moderate | Medium DBs, simple PITR |
| Continuous archiving (WAL + base backup) | Full physical + WAL stream | Arbitrary point in time | Base backup slow; WAL continuous | Large production systems, strict RPO requirements |

### pg_dump: Logical Backups

`pg_dump` connects to PostgreSQL, reads the schema and data, and outputs SQL statements (or a custom binary format) that can recreate the database.

```bash
# Plain SQL dump (human-readable but slow to restore):
pg_dump -h localhost -U myuser mydb > backup.sql

# Custom format (compressed, supports parallel restore):
pg_dump -h localhost -U myuser -Fc mydb > backup.dump

# Directory format (parallel dump):
pg_dump -h localhost -U myuser -Fd -j 4 mydb -f backup_dir/

# Dump specific tables:
pg_dump -t orders -t customers mydb > partial.sql

# Dump schema only (no data):
pg_dump -s mydb > schema.sql

# Dump data only:
pg_dump -a mydb > data.sql
```

Restoring:
```bash
# Restore plain SQL:
psql mydb < backup.sql

# Restore custom format (parallel, selective):
pg_restore -h localhost -U myuser -d mydb -j 4 backup.dump

# Restore specific table from custom format:
pg_restore -t orders -d mydb backup.dump

# List contents of a custom dump:
pg_restore -l backup.dump
```

**pg_dumpall** dumps all databases, plus cluster-wide objects (roles, tablespaces):
```bash
pg_dumpall -h localhost -U postgres > full_cluster.sql
```

**Limitations of pg_dump:**
- Takes a snapshot at the start — long-running dumps on busy databases hold a transaction open, preventing vacuum from cleaning dead tuples on the dumped tables.
- Restore time is proportional to database size. A 500 GB database might take hours to restore.
- No incremental dumps. Every backup is a full copy.
- Cannot do point-in-time recovery. You get exactly what was in the database when the dump started.

### pg_basebackup: Physical Backups

`pg_basebackup` copies the entire data directory at the file level — every page of every table, every index, configuration files, everything. It's the foundation for both replica creation and PITR.

```bash
# Basic base backup:
pg_basebackup -h primary-host -U replicator -D /backup/base \
  --checkpoint=fast --wal-method=stream -P -v

# Compressed backup (PG 15+ server-side compression):
pg_basebackup -h primary-host -U replicator -D /backup/base \
  --compress=server-lz4:5 --checkpoint=fast -P

# Tar format (single file per tablespace):
pg_basebackup -h primary-host -U replicator -Ft -z \
  -D /backup/base_tar -P
```

Options:
- `--checkpoint=fast`: Forces an immediate checkpoint instead of waiting for the next scheduled one. Reduces backup startup time at the cost of a small I/O spike.
- `--wal-method=stream`: Streams WAL during the backup so the backup is self-contained. The alternative (`fetch`) copies WAL files after the backup, requiring them to still exist.
- `-P`: Shows progress.
- `--max-rate=100M`: Throttle backup to 100 MB/s to limit I/O impact on the primary.

### Incremental Backups (PG 17)

PostgreSQL 17 introduced native incremental backups using the WAL summarizer:

```bash
# First: full backup
pg_basebackup -h primary -U replicator -D /backup/full --checkpoint=fast

# Later: incremental backup (only changed files since the full backup)
pg_basebackup -h primary -U replicator -D /backup/incr1 \
  --incremental=/backup/full/backup_manifest

# Combine for restore:
pg_combinebackup /backup/full /backup/incr1 -o /backup/combined
```

This massively reduces backup time and storage for large databases where only a fraction of data changes between backups.

### Continuous Archiving and Point-in-Time Recovery (PITR)

PITR combines a base backup with archived WAL segments to recover the database to any point in time.

**Setup:**

1. Enable WAL archiving (as shown in section 8.1).
2. Take periodic base backups.
3. Continuously archive WAL segments.

**Recovery to a specific point in time:**

```bash
# 1. Stop PostgreSQL
pg_ctl stop

# 2. Move or remove the current data directory
mv /var/lib/postgresql/data /var/lib/postgresql/data_old

# 3. Restore the base backup
cp -r /backup/base /var/lib/postgresql/data

# or extract from tar:
# tar xf /backup/base.tar -C /var/lib/postgresql/data

# 4. Create recovery configuration (PG 12+):
# In postgresql.conf (or postgresql.auto.conf):
```

In `postgresql.conf`:
```
restore_command = 'cp /archive/%f %p'
# or: restore_command = 'aws s3 cp s3://my-wal-archive/%f %p'

recovery_target_time = '2026-03-22 14:30:00 UTC'  # Recover to this time
# OR:
# recovery_target_lsn = '0/1A2B3C4D'
# recovery_target_xid = '12345'
# recovery_target_name = 'my_named_restore_point'  # If you used pg_create_restore_point()

recovery_target_action = 'promote'  # 'promote', 'pause', or 'shutdown'
recovery_target_inclusive = true     # Include or exclude the target transaction
```

```bash
# 5. Create the recovery signal file
touch /var/lib/postgresql/data/recovery.signal

# 6. Start PostgreSQL
pg_ctl start
```

PostgreSQL will:
1. Read the base backup's data files.
2. Replay archived WAL segments using `restore_command` until it reaches the recovery target.
3. Promote to read-write mode (or pause/shutdown based on `recovery_target_action`).

**Named restore points** let you create logical markers in the WAL for easy recovery:
```sql
-- Before a risky migration:
SELECT pg_create_restore_point('before_migration_v42');
-- If the migration goes wrong, recover to this named point.
```

### RTO and RPO Tradeoffs

**RPO (Recovery Point Objective):** How much data you can afford to lose.
**RTO (Recovery Time Objective):** How long recovery can take.

| Strategy | RPO | RTO | Cost |
|---|---|---|---|
| pg_dump nightly | Up to 24 hours of data loss | Hours (proportional to DB size) | Low |
| Base backup + WAL archiving | Seconds to minutes (depends on `archive_timeout`) | Minutes to hours | Medium |
| Streaming replication + auto-failover | Zero (synchronous) or seconds (async) | Seconds to minutes | High (extra servers) |

**Production recommendation:** Use all three in combination.
- Streaming replicas for HA (near-zero RPO/RTO).
- Base backup + WAL archiving for disaster recovery (different failure domain).
- Periodic pg_dump for logical backups that survive storage-level corruption.

### Backup Validation

A backup that hasn't been tested is not a backup — it's a hope.

```bash
# Restore to a temporary instance and verify:
pg_restore -d test_restore -j 4 backup.dump

# Or for physical backups, start a temporary instance:
pg_ctl -D /tmp/test_restore start -o "-p 5433"
psql -p 5433 -c "SELECT count(*) FROM critical_table;"
pg_ctl -D /tmp/test_restore stop
```

Automate this. Run restore tests weekly. Many teams discover their backups are broken only during an actual emergency.

---

## 8.4 Vacuuming in Depth

### Why Vacuuming Exists

PostgreSQL uses MVCC (Multi-Version Concurrency Control), meaning an UPDATE doesn't overwrite a row — it creates a new version and marks the old one as dead. A DELETE marks a row as dead but doesn't remove it. These dead tuples accumulate and waste space. **VACUUM** reclaims that space.

But vacuuming isn't just about disk space. There's a much more critical reason: **Transaction ID Wraparound Protection**.

### Transaction ID Wraparound: The Silent Database Killer

PostgreSQL assigns a 32-bit transaction ID (XID) to each writing transaction. That means there are roughly 4.2 billion possible XIDs. PostgreSQL uses modular arithmetic — it considers XIDs in the "past" (up to 2 billion transactions ago) as older, and XIDs in the "future" as newer.

The problem: if a very old row has XID 100, and the current XID is 2,147,483,748 (2^31 + 100), that row is now 2^31 transactions in the past — right at the boundary. One more transaction, and modular arithmetic flips: the system would consider that old row to be in the **future**, meaning it becomes invisible. Your data effectively disappears.

To prevent this, PostgreSQL **freezes** old tuples by replacing their XID with a special `FrozenTransactionId` (2), which is defined to be in the past for all transactions. Vacuuming is the process that performs this freezing.

**If vacuum cannot keep up with XID consumption, PostgreSQL will shut down to prevent data loss:**

```
WARNING: database "mydb" must be vacuumed within 10000000 transactions
HINT: To avoid a database shutdown, execute a database-wide VACUUM for this database.

-- If ignored:
ERROR: database is not accepting commands to avoid wraparound data loss in database "mydb"
HINT: Stop the postmaster and vacuum that database in single-user mode.
```

This is the most dreaded PostgreSQL failure mode. When it happens, the database enters **single-user mode** requiring manual intervention. No application can connect until the vacuum completes, which can take hours or days on large databases.

```sql
-- Check how close each database is to wraparound:
SELECT datname, 
       age(datfrozenxid) AS xid_age,
       2147483647 - age(datfrozenxid) AS xids_remaining,
       round(100.0 * age(datfrozenxid) / 2147483647, 2) AS pct_to_wraparound
FROM pg_database
ORDER BY age(datfrozenxid) DESC;

-- Check per-table:
SELECT schemaname, relname,
       age(relfrozenxid) AS xid_age,
       pg_size_pretty(pg_total_relation_size(oid)) AS total_size,
       last_vacuum, last_autovacuum
FROM pg_stat_user_tables
ORDER BY age(relfrozenxid) DESC
LIMIT 20;
```

**Healthy systems keep `age(datfrozenxid)` well below 200 million.** If you see it above 1 billion, you have a problem that needs immediate attention.

### What VACUUM Actually Does

There are two forms of vacuum:

**Regular VACUUM (non-full):**
1. Scans heap pages for dead tuples (those no longer visible to any transaction).
2. Marks their space as reusable in the **Free Space Map (FSM)**.
3. Freezes old tuples whose XID is older than `vacuum_freeze_min_age` (default: 50 million transactions).
4. Updates the **Visibility Map (VM)** — marks pages where all tuples are visible to all transactions (enabling index-only scans).
5. Truncates empty pages at the end of the heap file (returns disk space to the OS, but only trailing pages).

Regular VACUUM does **not** lock the table. Reads and writes continue normally. It does **not** return space in the middle of the file to the OS — it only marks it as reusable within PostgreSQL.

**VACUUM FULL:**
1. Locks the table with an `ACCESS EXCLUSIVE` lock (no reads or writes).
2. Creates a completely new copy of the table with only live tuples.
3. Rebuilds all indexes.
4. Replaces the old file with the new one.
5. Returns all reclaimed space to the OS.

VACUUM FULL requires space for a full copy of the table and takes an exclusive lock for the entire duration. On a large table, this can mean hours of downtime.

```sql
-- Regular vacuum:
VACUUM orders;

-- Vacuum with verbose output:
VACUUM VERBOSE orders;

-- Vacuum and update planner statistics:
VACUUM ANALYZE orders;

-- Full vacuum (requires exclusive lock!):
VACUUM FULL orders;
```

**Alternative to VACUUM FULL:** Use `pg_repack` extension for online table and index reorganization without exclusive locks:

```sql
-- Install extension
CREATE EXTENSION pg_repack;
```
```bash
# Repack a table (no exclusive lock needed):
pg_repack -d mydb -t orders
```

### Autovacuum: The Background Janitor

Autovacuum is a background launcher that starts vacuum worker processes automatically based on table activity. It's enabled by default and you should almost never turn it off.

**How autovacuum decides what to vacuum:**

A table becomes a vacuum candidate when:
```
dead_tuples > autovacuum_vacuum_threshold + autovacuum_vacuum_scale_factor × reltuples
```

With defaults:
- `autovacuum_vacuum_threshold = 50` (minimum dead tuples)
- `autovacuum_vacuum_scale_factor = 0.2` (20% of table)

So a 1 million row table triggers autovacuum when it accumulates 200,050 dead tuples. For a 10-row table, it triggers at 52 dead tuples.

**The problem:** For very large tables (hundreds of millions of rows), 20% means tens of millions of dead tuples before vacuum runs. This is often too late. Lower the scale factor for large tables:

```sql
-- Set per-table autovacuum parameters:
ALTER TABLE huge_events SET (
    autovacuum_vacuum_scale_factor = 0.01,     -- Vacuum at 1% dead tuples
    autovacuum_vacuum_threshold = 10000,
    autovacuum_analyze_scale_factor = 0.005,   -- Analyze at 0.5%
    autovacuum_freeze_max_age = 100000000      -- Aggressive freeze for busy tables
);
```

**Autovacuum for ANALYZE:** Statistics are refreshed when:
```
modified_tuples > autovacuum_analyze_threshold + autovacuum_analyze_scale_factor × reltuples
```
Default: threshold 50, scale_factor 0.1 (10% of table modified).

### Autovacuum Configuration

| Parameter | Default | What It Does | Tuning Guidance |
|---|---|---|---|
| `autovacuum` | `on` | Master switch. | **Never turn off.** Even if you run manual vacuums, autovacuum handles freezing. |
| `autovacuum_max_workers` | `3` | Maximum concurrent autovacuum workers. | Increase to 5–8 for large clusters with many tables. Each worker vacuums one table. |
| `autovacuum_naptime` | `1min` | How often the launcher checks for tables needing vacuum. | 15–30s for busy systems. |
| `autovacuum_vacuum_cost_delay` | `2ms` (PG 12+) | Delay between I/O operations to throttle vacuum impact. Was 20ms before PG 12. | 2ms is usually fine. Lower to 0-1ms if vacuum is struggling to keep up. |
| `autovacuum_vacuum_cost_limit` | `-1` (uses `vacuum_cost_limit` = 200) | I/O credit limit per cycle. | Increase to 400–1000 for write-heavy workloads so vacuum runs faster. |
| `vacuum_freeze_min_age` | `50000000` | Don't freeze tuples younger than this many transactions. | Leave default unless you have specific freezing needs. |
| `vacuum_freeze_table_age` | `150000000` | Trigger aggressive (full-table-scan) vacuum when table's `relfrozenxid` age exceeds this. | Leave default. |
| `autovacuum_freeze_max_age` | `200000000` | Force vacuum to prevent wraparound when table's `relfrozenxid` age exceeds this. | Leave default. This is the safety net — autovacuum will vacuum this table even if it's busy. |

### Monitoring Vacuum Health

```sql
-- Tables most in need of vacuuming:
SELECT schemaname, relname,
       n_dead_tup,
       n_live_tup,
       round(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 2) AS dead_pct,
       last_vacuum,
       last_autovacuum,
       age(relfrozenxid) AS xid_age
FROM pg_stat_user_tables
WHERE n_dead_tup > 1000
ORDER BY n_dead_tup DESC
LIMIT 20;

-- Currently running autovacuum workers:
SELECT pid, datname, relid::regclass, phase, 
       heap_blks_total, heap_blks_scanned, heap_blks_vacuumed,
       index_vacuum_count, max_dead_tuples, num_dead_tuples
FROM pg_stat_progress_vacuum;

-- Check if autovacuum is being blocked:
SELECT blocked_locks.pid AS blocked_pid,
       blocked_activity.query AS blocked_query,
       blocking_locks.pid AS blocking_pid,
       blocking_activity.query AS blocking_query
FROM pg_catalog.pg_locks blocked_locks
JOIN pg_catalog.pg_stat_activity blocked_activity 
  ON blocked_activity.pid = blocked_locks.pid
JOIN pg_catalog.pg_locks blocking_locks 
  ON blocking_locks.locktype = blocked_locks.locktype
  AND blocking_locks.relation = blocked_locks.relation
  AND blocking_locks.pid != blocked_locks.pid
JOIN pg_catalog.pg_stat_activity blocking_activity 
  ON blocking_activity.pid = blocking_locks.pid
WHERE NOT blocked_locks.granted
  AND blocked_activity.query LIKE 'autovacuum%';
```

### Table Bloat

Even with regular vacuum, tables can accumulate "bloat" — unused space within the heap that vacuum has marked as reusable but hasn't returned to the OS. This happens because regular vacuum only truncates trailing empty pages; if dead tuples are scattered throughout the file, the space is reused by new inserts but the file doesn't shrink.

**Estimating bloat:**

```sql
-- Quick estimate using pgstattuple extension:
CREATE EXTENSION pgstattuple;

SELECT * FROM pgstattuple('orders');
-- Returns: table_len, tuple_count, tuple_len, dead_tuple_count, 
--          dead_tuple_len, free_space, free_percent

-- For indexes:
SELECT * FROM pgstatindex('idx_orders_created_at');
-- Returns: tree_level, index_size, leaf_pages, empty_pages, 
--          deleted_pages, avg_leaf_density, leaf_fragmentation
```

**Dealing with severe bloat:**
1. `pg_repack` — online rebuild without exclusive lock (preferred).
2. `VACUUM FULL` — requires exclusive lock.
3. `CLUSTER` — rebuilds table ordered by a specific index (exclusive lock).
4. Create a new table, copy data, swap (manual but gives full control).

> **What a senior engineer actually thinks about when they see this:**
> "I set up monitoring for three things: (1) `age(datfrozenxid)` per database — alert at 500M, page at 1B; (2) dead tuple ratio per table — alert at 20%; (3) table and index bloat ratio — alert at 50%. I tune autovacuum aggressively for my largest tables (lower scale factor, higher cost limit). I have a runbook for wraparound emergencies. And I test that VACUUM FULL or pg_repack works on my biggest table in staging before I ever need it in production."

---

## 8.5 High Availability Patterns

### Why HA Matters

A single PostgreSQL instance is a single point of failure. If the server crashes, has a hardware failure, or needs maintenance, your application is down. High availability means the system continues serving requests even when individual components fail.

### Primary / Standby Architecture

The most common PostgreSQL HA pattern:

```
                         ┌──────────────┐
                         │  Application │
                         └──────┬───────┘
                                │
                         ┌──────▼───────┐
                         │ Connection   │
                         │ Router /     │
                         │ Load Balancer│
                         └──┬───────┬───┘
                   writes   │       │  reads
                         ┌──▼──┐ ┌──▼──────┐
                         │ PRI │ │ STANDBY  │
                         │MARY │→│ (hot     │
                         │     │ │ standby) │
                         └─────┘ └──────────┘
                      streaming replication
```

**Components of a production HA setup:**

1. **Primary:** Handles all writes and can handle reads.
2. **One or more hot standbys:** Read-only replicas receiving WAL via streaming replication.
3. **Connection router:** Directs writes to primary, reads to standbys. This can be:
   - **HAProxy/PgBouncer** with health checks
   - **Patroni** (manages failover + provides service discovery)
   - **Application-level** routing (connection string with multiple hosts)
4. **Failover manager:** Detects primary failure and promotes a standby. Options:
   - **Patroni** (most popular, uses DCS like etcd/ZooKeeper/Consul)
   - **repmgr**
   - **pg_auto_failover** (by Citus/Microsoft)
   - Cloud-managed (RDS, Cloud SQL, etc.)

### Patroni: The Industry Standard for HA

Patroni is a template for PostgreSQL HA with automatic failover, using a Distributed Consensus Store (DCS) like etcd for leader election.

```
┌─────────┐  ┌─────────┐  ┌─────────┐
│ Patroni │  │ Patroni │  │ Patroni │
│ + PG    │  │ + PG    │  │ + PG    │
│ Node 1  │  │ Node 2  │  │ Node 3  │
└────┬────┘  └────┬────┘  └────┬────┘
     │            │            │
     └────────┬───┘────────────┘
              │
        ┌─────▼─────┐
        │   etcd     │
        │  cluster   │
        │ (3+ nodes) │
        └────────────┘
```

**How Patroni failover works:**

1. Each Patroni node holds a **leader key** in etcd with a TTL (e.g., 30 seconds).
2. The current primary continuously refreshes the key.
3. If the primary fails, the key expires.
4. Remaining Patroni nodes initiate leader election.
5. The standby with the most replayed WAL wins.
6. The winning standby is **promoted** to primary.
7. Other standbys are reconfigured to follow the new primary.

Typical failover time: **10–30 seconds**.

```yaml
# Example Patroni configuration (patroni.yml):
scope: myapp-cluster
name: node1

restapi:
  listen: 0.0.0.0:8008
  connect_address: 10.0.1.1:8008

etcd3:
  hosts: 10.0.2.1:2379,10.0.2.2:2379,10.0.2.3:2379

bootstrap:
  dcs:
    ttl: 30
    loop_wait: 10
    retry_timeout: 10
    maximum_lag_on_failover: 1048576  # 1MB max lag for failover candidate
    postgresql:
      use_pg_rewind: true
      parameters:
        wal_level: replica
        max_wal_senders: 10
        max_replication_slots: 10
        hot_standby: on
        wal_log_hints: on  # Required for pg_rewind

postgresql:
  listen: 0.0.0.0:5432
  connect_address: 10.0.1.1:5432
  data_dir: /var/lib/postgresql/data
  authentication:
    replication:
      username: replicator
      password: ${REPL_PASSWORD}
    superuser:
      username: postgres
      password: ${PG_PASSWORD}
```

### What Happens During Failover

1. **Detection** (1–30 seconds): The DCS key expires, or health check fails.
2. **Election** (<1 second): Nodes compare WAL positions; most-ahead wins.
3. **Fencing** (immediate): Old primary is fenced (stopped or demoted) to prevent split-brain.
4. **Promotion** (1–5 seconds): `pg_promote()` or `pg_ctl promote` on the new primary.
5. **Reconfiguration** (1–5 seconds): Other standbys point to the new primary.
6. **Connection routing** (1–10 seconds): HAProxy/PgBouncer/DNS updates to point to new primary.

**During failover, your application will see:**
- Connection errors on existing connections to the old primary.
- Brief inability to connect to any primary.
- Once routing updates, connections go to the new primary.

**Application requirements for HA:**
- Retry logic for connection errors and "read-only transaction" errors.
- Idempotent writes (so retried transactions don't create duplicates).
- Connection pool configuration to quickly detect dead connections and reconnect.

```javascript
// Node.js example: retry logic for failover
async function executeWithRetry(pool, query, params, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await pool.query(query, params);
    } catch (err) {
      const retriable = [
        '57P01', // admin_shutdown
        '57P02', // crash_shutdown
        '57P03', // cannot_connect_now
        '08006', // connection_failure
        '08001', // sqlclient_unable_to_establish_sqlconnection
        '08004', // sqlserver_rejected_establishment_of_sqlconnection
        '25006', // read_only_sql_transaction (hitting old primary now demoted)
        '40001', // serialization_failure
      ];
      if (!retriable.includes(err.code) || attempt === maxRetries - 1) {
        throw err;
      }
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }
}
```

### Split-Brain Prevention

Split-brain occurs when both the old primary and the new primary accept writes simultaneously after a network partition. This causes data divergence that's extremely difficult to reconcile.

**Prevention mechanisms:**

1. **Fencing:** Patroni uses `pg_ctl stop` or STONITH (Shoot The Other Node In The Head) to ensure the old primary is truly down before promoting a new one.
2. **pg_rewind:** After failover, if the old primary comes back, `pg_rewind` resynchronizes it by replaying its divergent WAL against the new primary's timeline, turning it into a standby. Without `pg_rewind`, the old primary must be rebuilt from scratch.
3. **Watchdog:** Patroni can use a Linux software watchdog to ensure the primary is actually dead (kernel-level guarantee).

```sql
-- Enable pg_rewind support (must be set before first use):
-- In postgresql.conf: wal_log_hints = on
-- Or: initdb with --data-checksums
```

### Connection Routing

Applications need to connect to the right server — primary for writes, any standby for reads.

**PostgreSQL multi-host connection strings (PG 10+):**
```
postgresql://host1:5432,host2:5432,host3:5432/mydb?target_session_attrs=read-write
```

The client tries each host in order and picks the first one where the session attribute matches. `read-write` means only connect to the primary. `read-only` or `any` can connect to standbys.

**HAProxy configuration:**
```
frontend pg_write
    bind *:5432
    default_backend pg_primary

frontend pg_read
    bind *:5433
    default_backend pg_replicas

backend pg_primary
    option httpchk GET /primary
    http-check expect status 200
    server node1 10.0.1.1:5432 check port 8008
    server node2 10.0.1.2:5432 check port 8008
    server node3 10.0.1.3:5432 check port 8008

backend pg_replicas
    option httpchk GET /replica
    http-check expect status 200
    balance roundrobin
    server node1 10.0.1.1:5432 check port 8008
    server node2 10.0.1.2:5432 check port 8008
    server node3 10.0.1.3:5432 check port 8008
```

Patroni exposes REST endpoints (`/primary`, `/replica`) on port 8008 that HAProxy uses for health checks.

---

## 8.6 Read Replicas

### What You Can Safely Read from a Replica

Hot standbys accept read-only queries. But there are important caveats:

**Replication lag means stale reads.** A query on a replica might see data that's milliseconds to seconds (or even minutes, under load) behind the primary. This is called **eventual consistency** in practice.

**Safe for replicas:**
- Analytics/reporting queries.
- Dashboard queries that tolerate slight staleness.
- Search queries where near-real-time is acceptable.
- Any read that doesn't need to reflect the most recent write.

**Unsafe for replicas (without special handling):**
- "Read-your-own-write" patterns: user creates a record, then immediately queries for it. If the read hits a replica before replication delivers the write, the user sees a 404.
- Sequences that depend on the latest state (checking if a username is taken, then inserting it).
- Business logic where a stale read causes a wrong decision (checking inventory before allowing a purchase).

**Handling read-your-own-write consistency:**

Option 1: **Route to primary after writes.** After a user writes, send all their reads to the primary for a short window (e.g., 5 seconds).

Option 2: **LSN-based routing.** After a write, record the primary's LSN. For subsequent reads, only route to a replica that has replayed past that LSN.

```sql
-- On primary, after a write:
SELECT pg_current_wal_lsn();  -- Returns: 0/1A2B3C4D
-- Store this with the user's session

-- On replica, before routing a read:
SELECT pg_last_wal_replay_lsn() >= '0/1A2B3C4D'::pg_lsn;
-- Only route to this replica if true
```

Option 3: **Use synchronous replication with `remote_apply`.** The primary won't acknowledge the commit until the replica has applied it. Expensive but guarantees read-your-own-write consistency.

### Replica Conflicts

Replicas can experience conflicts between WAL replay and running queries.

**Scenario:** A query on the replica is doing a sequential scan of a table. Meanwhile, WAL replay needs to vacuum dead tuples from that same table. The replay can't proceed until the query finishes, but the query might run for minutes.

PostgreSQL has two settings to handle this:

```
# On replica:
max_standby_streaming_delay = 30s   # Max delay before canceling conflicting queries
max_standby_archive_delay = 30s     # Same, for WAL replay from archived files
```

If a query has been blocking replay for longer than this delay, PostgreSQL cancels the query with:
```
ERROR: canceling statement due to conflict with recovery
DETAIL: User query might have needed to see row versions that must be removed.
```

**To avoid this:**
- Set `hot_standby_feedback = on` on the replica, which tells the primary not to vacuum tuples the replica still needs. Downside: this can cause bloat on the primary.
- Increase `max_standby_streaming_delay` for long-running analytics queries (at the cost of increased replication lag).
- Use a dedicated analytics replica with very long delay settings.

```sql
-- Check for replica conflicts:
SELECT * FROM pg_stat_database_conflicts;
-- Shows counts of queries canceled due to: tablespace, lock, snapshot, 
-- bufferpin, and deadlock conflicts
```

---

## 8.7 Sharding

### When You Actually Need Sharding

**You probably don't need sharding.** A well-tuned PostgreSQL instance on modern hardware can handle:
- Hundreds of millions to low billions of rows per table.
- Tens of thousands of transactions per second.
- Terabytes of data.

Before considering sharding, exhaust these options:
1. **Optimize queries** (proper indexes, query rewriting).
2. **Vertical scaling** (more RAM, faster disks, more CPU).
3. **Table partitioning** (PostgreSQL native partitioning can handle very large tables).
4. **Read replicas** (offload read traffic).
5. **Archiving** (move old data to cold storage or archive tables).
6. **Connection pooling** (PgBouncer to handle more concurrent connections).

**Sharding becomes necessary when:**
- Write throughput exceeds what a single server can handle (the replicas help with reads, not writes).
- Dataset exceeds what fits on a single server's storage.
- You need geographic write locality (writes from Europe go to the Europe shard, writes from Asia go to the Asia shard).

### Sharding Approaches

#### Application-Level Sharding

Your application code decides which shard to route a query to.

```javascript
// Simple hash-based sharding by tenant ID
function getShardConnection(tenantId, shardCount = 4) {
  const shardIndex = tenantId % shardCount;
  return connectionPools[`shard_${shardIndex}`];
}

// Usage:
const pool = getShardConnection(order.tenantId);
await pool.query('INSERT INTO orders (tenant_id, ...) VALUES ($1, ...)', [order.tenantId]);
```

**Pros:** Full control, no middleware overhead, can optimize per-shard.
**Cons:** Complexity in application code, cross-shard queries are your problem, rebalancing is painful.

#### Citus (Distributed PostgreSQL)

Citus is a PostgreSQL extension (now part of Microsoft) that adds transparent horizontal sharding. Tables are distributed across worker nodes, and the coordinator node routes queries.

```sql
-- On coordinator:
CREATE EXTENSION citus;

-- Add worker nodes:
SELECT citus_add_node('worker1', 5432);
SELECT citus_add_node('worker2', 5432);

-- Distribute a table by tenant_id:
SELECT create_distributed_table('orders', 'tenant_id');

-- Now queries that filter on tenant_id are routed to the right shard:
SELECT * FROM orders WHERE tenant_id = 42;  -- Goes to one shard

-- Queries without tenant_id filter are scatter-gathered:
SELECT count(*) FROM orders;  -- Runs on all shards, results combined
```

**Co-location:** Tables distributed by the same column are co-located on the same shard, enabling efficient joins:

```sql
SELECT create_distributed_table('orders', 'tenant_id');
SELECT create_distributed_table('order_items', 'tenant_id');

-- This join runs locally on each shard (no cross-shard data movement):
SELECT o.id, oi.product_name
FROM orders o
JOIN order_items oi ON o.id = oi.order_id AND o.tenant_id = oi.tenant_id
WHERE o.tenant_id = 42;
```

**Reference tables:** Small tables (countries, currencies) that are replicated to every shard:
```sql
SELECT create_reference_table('countries');
-- JOINs with reference tables are always local
```

#### Foreign Data Wrappers (FDW) for Sharding

You can use `postgres_fdw` to create a federation of PostgreSQL servers:

```sql
-- On coordinator:
CREATE EXTENSION postgres_fdw;

CREATE SERVER shard1 FOREIGN DATA WRAPPER postgres_fdw
  OPTIONS (host 'shard1-host', port '5432', dbname 'mydb');

CREATE USER MAPPING FOR current_user SERVER shard1
  OPTIONS (user 'app_user', password 'secure_password_here');

-- Import foreign tables:
IMPORT FOREIGN SCHEMA public FROM SERVER shard1 INTO shard1_schema;
```

This approach works for federation but doesn't provide automatic sharding — your application or a proxy must route queries.

### Sharding Gotchas

1. **Cross-shard queries are expensive.** Any query that spans multiple shards requires coordination. Aggregations across shards require scatter-gather.
2. **Cross-shard transactions are complex.** Two-phase commit (2PC) works but is slow and error-prone. Design your sharding key to keep related data on the same shard.
3. **Resharding is painful.** Changing the number of shards requires data migration. Plan your shard key carefully upfront.
4. **Global uniqueness requires coordination.** Auto-incrementing IDs conflict across shards. Use UUIDs, ULIDs, or a coordinated sequence service.
5. **Foreign keys across shards don't work.** Referential integrity must be enforced at the application level.
6. **Schema changes must be applied to every shard.** Missing a shard = broken queries.
7. **Backups become per-shard.** Point-in-time recovery across shards requires careful coordination to ensure consistency.

---

## 8.8 Monitoring and Observability

### Essential Metrics to Monitor

#### Database-Level Metrics

```sql
-- Active connections and state:
SELECT state, count(*)
FROM pg_stat_activity
GROUP BY state;
-- Healthy: most connections in 'idle', few in 'active'
-- Unhealthy: many in 'active' or 'idle in transaction'

-- Long-running queries:
SELECT pid, now() - query_start AS duration, state, query
FROM pg_stat_activity
WHERE state = 'active'
  AND query_start < now() - interval '5 minutes'
ORDER BY duration DESC;

-- Connections near the limit:
SELECT count(*) AS current, 
       (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max
FROM pg_stat_activity;

-- Database-wide statistics:
SELECT datname,
       numbackends,
       xact_commit,
       xact_rollback,
       blks_read,
       blks_hit,
       round(100.0 * blks_hit / NULLIF(blks_hit + blks_read, 0), 2) AS cache_hit_ratio,
       tup_returned,
       tup_fetched,
       tup_inserted,
       tup_updated,
       tup_deleted,
       deadlocks,
       temp_files,
       temp_bytes
FROM pg_stat_database
WHERE datname = current_database();
```

**Cache hit ratio** should be > 99% in production. Below 95% indicates insufficient `shared_buffers` or a workload that doesn't fit in memory.

#### Table-Level Metrics

```sql
-- Tables with most sequential scans (might need indexes):
SELECT schemaname, relname, 
       seq_scan, seq_tup_read,
       idx_scan, idx_tup_fetch,
       n_tup_ins, n_tup_upd, n_tup_del,
       n_dead_tup,
       last_vacuum, last_autovacuum,
       last_analyze, last_autoanalyze
FROM pg_stat_user_tables
ORDER BY seq_scan DESC
LIMIT 20;

-- Index usage ratio per table:
SELECT schemaname, relname,
       CASE WHEN (seq_scan + idx_scan) = 0 THEN 0
            ELSE round(100.0 * idx_scan / (seq_scan + idx_scan), 2)
       END AS idx_scan_pct
FROM pg_stat_user_tables
WHERE (seq_scan + idx_scan) > 100
ORDER BY idx_scan_pct ASC;
```

#### Index Health

```sql
-- Unused indexes (candidates for removal):
SELECT schemaname, relname, indexrelname, idx_scan,
       pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
WHERE idx_scan = 0
  AND NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conindid = indexrelid  -- Keep indexes backing constraints
  )
ORDER BY pg_relation_size(indexrelid) DESC;

-- Index sizes:
SELECT schemaname, tablename, indexname,
       pg_size_pretty(pg_relation_size(indexname::regclass)) AS index_size
FROM pg_indexes
WHERE schemaname = 'public'
ORDER BY pg_relation_size(indexname::regclass) DESC;
```

#### Lock Monitoring

```sql
-- Current locks and what's waiting:
SELECT blocked_locks.pid AS blocked_pid,
       blocked_activity.usename AS blocked_user,
       now() - blocked_activity.query_start AS blocked_duration,
       blocking_locks.pid AS blocking_pid,
       blocking_activity.usename AS blocking_user,
       now() - blocking_activity.query_start AS blocking_duration,
       blocked_activity.query AS blocked_query,
       blocking_activity.query AS blocking_query
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

#### Replication Monitoring

```sql
-- On primary: lag per replica
SELECT application_name, client_addr, state,
       pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS replay_lag_bytes,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)) AS replay_lag_pretty,
       replay_lag
FROM pg_stat_replication;

-- Replication slot disk usage:
SELECT slot_name, slot_type, active,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal
FROM pg_replication_slots;
```

### Key Extensions for Monitoring

**pg_stat_statements** — the single most valuable monitoring extension:
```sql
CREATE EXTENSION pg_stat_statements;

-- Top queries by total time:
SELECT query,
       calls,
       round(total_exec_time::numeric, 2) AS total_time_ms,
       round(mean_exec_time::numeric, 2) AS mean_time_ms,
       round((100 * total_exec_time / sum(total_exec_time) OVER ())::numeric, 2) AS pct,
       rows
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 20;

-- Top queries by calls (most frequent):
SELECT query, calls, mean_exec_time
FROM pg_stat_statements
ORDER BY calls DESC
LIMIT 20;

-- Reset statistics:
SELECT pg_stat_statements_reset();
```

**pg_stat_kcache** (requires `pg_stat_statements`): tracks actual OS-level reads/writes per query.

**auto_explain**: automatically logs EXPLAIN plans for slow queries:
```
# postgresql.conf:
shared_preload_libraries = 'auto_explain'
auto_explain.log_min_duration = '1s'    # Log plans for queries > 1 second
auto_explain.log_analyze = on           # Include actual timing
auto_explain.log_buffers = on           # Include buffer usage
auto_explain.log_format = 'json'        # Machine-parseable format
```

**pg_wait_sampling**: samples wait events to understand where PostgreSQL is spending time (CPU, I/O, locks, etc.).

### Alerting Thresholds

| Metric | Warning | Critical |
|---|---|---|
| Cache hit ratio | < 98% | < 95% |
| Active connections | > 70% of max_connections | > 85% |
| Idle in transaction | Any > 5 minutes | Any > 30 minutes |
| Replication lag (bytes) | > 10 MB | > 100 MB |
| Replication lag (time) | > 5 seconds | > 30 seconds |
| XID age (datfrozenxid) | > 500M | > 1B |
| Dead tuple ratio | > 10% | > 25% |
| Long-running queries | > 5 minutes | > 30 minutes |
| Deadlocks per minute | > 0 | > 5 |
| Temp file usage | > 1 GB/query | > 10 GB/query |
| WAL generation rate | Sudden 3× increase | Sudden 10× increase |
| Disk usage | > 80% | > 90% |
| Inactive replication slots | Any | Inactive > 1 hour |

---

## 8.9 Things That Will Bite You in Production

### 1. Transaction ID Wraparound

**How it bites:** Autovacuum can't keep up with XID consumption. `age(datfrozenxid)` climbs past 2 billion. PostgreSQL refuses all writes. You're down until a manual vacuum completes, which takes hours.

**Prevention:** Monitor `age(datfrozenxid)`. Tune autovacuum aggressively for large tables. Alert at 500M, page at 1B. Never let anything block autovacuum (long-running transactions holding back the XID horizon are the most common cause).

### 2. Idle Transactions Blocking Vacuum

**How it bites:** A forgotten `BEGIN` without `COMMIT`/`ROLLBACK` (common with ORMs and connection pools) holds the XID horizon. No dead tuples created after that transaction started can be vacuumed, even by other transactions. Tables bloat. Eventually, wraparound risk.

**Prevention:**
```
idle_in_transaction_session_timeout = '5min'  # Kill idle-in-transaction sessions
```
Monitor for `state = 'idle in transaction'` in `pg_stat_activity`.

### 3. Replication Slots on Dead Replicas

**How it bites:** A replica goes down. Its replication slot stays active on the primary, retaining all WAL since the replica disconnected. WAL accumulates until the primary's disk fills up. Writes fail. **Both** the primary and the down replica are now broken.

**Prevention:** Monitor `pg_replication_slots` for inactive slots. Set `max_slot_wal_keep_size` (PG 13+) to cap WAL retention per slot:
```
max_slot_wal_keep_size = '10GB'  # Primary will drop WAL beyond this even if slot needs it
```

### 4. VACUUM FULL on a Large Table During Business Hours

**How it bites:** VACUUM FULL takes an `ACCESS EXCLUSIVE` lock. The table is completely locked — no reads, no writes — for the entire duration. On a 200 GB table, that's hours.

**Prevention:** Use `pg_repack` instead. Or schedule VACUUM FULL during maintenance windows. Always test on staging to estimate duration.

### 5. Running Out of Connections

**How it bites:** Each PostgreSQL connection is a process consuming ~5-10 MB of RAM. An application with 50 server instances each opening 20 connections = 1000 connections. At default `max_connections = 100`, you're 10× over the limit.

**Prevention:** Use PgBouncer in transaction pooling mode. Size the PostgreSQL pool to 2-4× CPU cores (typically 50–200 connections), and let PgBouncer multiplex thousands of application connections over that pool.

### 6. Unmonitored Bloat

**How it bites:** A table that receives heavy UPDATE traffic bloats to 10× its data size. Queries scan 10× the pages. Sequential scans that were fast become slow. Index performance degrades as indexes bloat too.

**Prevention:** Monitor bloat ratios. Schedule regular `pg_repack` for known high-churn tables. Tune `fillfactor` to leave room for HOT updates on frequently updated tables:
```sql
ALTER TABLE frequently_updated SET (fillfactor = 80);
-- Leaves 20% free space per page for HOT (Heap-Only Tuple) updates
```

### 7. Backup Not Tested

**How it bites:** You've been taking backups for months. The database crashes. You try to restore. The backup is corrupted, or the restore process fails due to a misconfigured `restore_command`, or it takes 12 hours instead of the 1 hour your RTO requires.

**Prevention:** Automate weekly restore tests. Measure actual restore time. Verify data integrity after restore.

### 8. Logical Replication Silently Breaking

**How it bites:** Someone runs an `ALTER TABLE ADD COLUMN` on the publisher but forgets the subscriber. Logical replication continues until it encounters a row that uses the new column, then fails silently or throws errors. Depending on configuration, it might stop replicating while the application keeps running, and nobody notices until the subscriber is hours behind.

**Prevention:** Include DDL deployment in your replication runbook. Monitor `pg_stat_subscription` for errors. Set up alerts on subscriber lag.

### 9. Synchronous Replication Causing Primary Stall

**How it bites:** `synchronous_standby_names` is set. The synchronous standby goes down or becomes unreachable. Every write on the primary now blocks indefinitely waiting for a standby acknowledgment that will never come. The primary appears frozen.

**Prevention:** Use `ANY N (standby1, standby2, standby3)` so any N of M standbys can satisfy the synchronous requirement. Have at least N+1 standbys. Monitor standby health and automatically remove unhealthy standbys from the synchronous list (Patroni handles this).

### 10. pg_dump on a Busy Database Causing Bloat

**How it bites:** `pg_dump` takes a transaction-level consistent snapshot. For large databases, this means holding a transaction open for hours. During that time, autovacuum can't clean dead tuples created after the dump started. Combined with a busy OLTP workload, tables can bloat significantly.

**Prevention:** Take logical backups from a standby, not the primary. Or use `pg_basebackup` instead, which doesn't hold a long-running transaction. If you must use `pg_dump` on the primary, run it during low-traffic periods.

> **What a senior engineer actually thinks about when they see this:**
> "My production checklist: (1) Patroni or equivalent for automatic failover — tested quarterly by actually killing the primary. (2) PgBouncer in front of every PostgreSQL instance. (3) pg_stat_statements enabled everywhere. (4) XID age monitoring with pages. (5) Replication slot monitoring with disk alerts. (6) Weekly automated restore tests. (7) Autovacuum tuned per-table for my largest tables. (8) idle_in_transaction_session_timeout set. (9) auto_explain for slow queries. (10) Runbooks for every failure mode listed above."
