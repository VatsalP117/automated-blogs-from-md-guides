# Chapter 10 — Beyond PostgreSQL: The Database Systems Landscape

## Table of Contents

- [10.1 When PostgreSQL Is Not the Right Tool](#101-when-postgresql-is-not-the-right-tool)
- [10.2 OLTP vs OLAP: The Fundamental Divide](#102-oltp-vs-olap-the-fundamental-divide)
- [10.3 Column Stores (Redshift, BigQuery, ClickHouse)](#103-column-stores-redshift-bigquery-clickhouse)
- [10.4 Time-Series Databases (TimescaleDB, InfluxDB)](#104-time-series-databases-timescaledb-influxdb)
- [10.5 Key-Value Stores (Redis)](#105-key-value-stores-redis)
- [10.6 Document Stores (MongoDB)](#106-document-stores-mongodb)
- [10.7 NewSQL and Distributed SQL (CockroachDB, PlanetScale, Neon, YugabyteDB)](#107-newsql-and-distributed-sql-cockroachdb-planetscale-neon-yugabytedb)
- [10.8 Event Sourcing and CQRS](#108-event-sourcing-and-cqrs)
- [10.9 Search Engines (Elasticsearch, Typesense, Meilisearch)](#109-search-engines-elasticsearch-typesense-meilisearch)
- [10.10 Message Queues and Streaming (Kafka, RabbitMQ, SQS)](#1010-message-queues-and-streaming-kafka-rabbitmq-sqs)
- [10.11 The Polyglot Persistence Decision Framework](#1011-the-polyglot-persistence-decision-framework)
- [10.12 Things That Will Bite You in Production](#1012-things-that-will-bite-you-in-production)

---

## 10.1 When PostgreSQL Is Not the Right Tool

Throughout this guide, we've treated PostgreSQL as a powerful, general-purpose database — and it is. PostgreSQL handles relational data, JSON documents, full-text search, geospatial queries, time-series data (with extensions), and even graph-like queries (with recursive CTEs). It's the Swiss Army knife of databases.

But a Swiss Army knife is not the best tool for felling a tree.

Here are the workloads where PostgreSQL genuinely struggles, not because it's poorly designed, but because its architecture optimizes for a different set of tradeoffs:

### Extreme write throughput (millions of writes per second)

PostgreSQL uses MVCC (Multi-Version Concurrency Control) with heap-based storage. Every write creates a new tuple version, which must eventually be vacuumed. The WAL (Write-Ahead Log) must be flushed to disk for durability. At very high write rates — think IoT telemetry from millions of devices, or a global ad-click tracking system doing 2M+ writes/second — PostgreSQL's single-writer WAL becomes a bottleneck.

You can shard PostgreSQL across multiple servers (using Citus, for example), but at this point you're fighting the architecture. A system designed for distributed writes (like Kafka for event ingestion, or ClickHouse for analytical writes) handles this more naturally.

**Threshold:** If you need sustained writes above ~50K-100K rows/second on a single instance (depending on row size and hardware), you'll start hitting limits. PG can burst higher, but sustained throughput at this level requires serious tuning and beefy hardware.

### Sub-millisecond key lookups at massive scale

PostgreSQL's indexed lookups are fast — typically 0.5–2ms for a B-tree index lookup including network round-trip. But for workloads that need sub-100-microsecond lookups on hundreds of millions of keys (session stores, feature flags, rate limiters), the overhead of PostgreSQL's query parser, planner, MVCC visibility checks, and network protocol adds up.

Redis serves these lookups from memory with no parsing overhead, no query planning, and minimal protocol overhead. A Redis GET takes ~100 microseconds from the application.

**But be honest:** most applications don't need sub-millisecond lookups. If your P99 latency budget for a database call is 10ms, PostgreSQL is fine.

### Real-time analytics on petabytes

PostgreSQL is a row-store. When you run `SELECT AVG(price) FROM orders WHERE date > '2024-01-01'`, it reads entire rows (all columns) from disk, even though you only need `price` and `date`. On a 100-column table with 500 million rows, this means reading 50x more data than necessary.

Column-store databases (BigQuery, ClickHouse, Redshift) store each column separately. That same query reads only two columns, compresses them efficiently (prices cluster around common values), and processes them using vectorized CPU operations. The speedup can be 10x–100x for analytical queries.

**Threshold:** Once your analytical tables exceed ~100M rows and your queries aggregate across many of them, a column store will dramatically outperform PostgreSQL for those specific queries.

### Graph traversal

Finding all friends-of-friends-of-friends, detecting cycles in dependency graphs, or computing shortest paths involves recursive traversals that touch many loosely connected rows. PostgreSQL supports `WITH RECURSIVE` CTEs for this, but they're limited: no built-in shortest-path algorithm, no parallel graph traversal, and performance degrades with traversal depth.

Graph databases (Neo4j, Amazon Neptune) store data as nodes and edges with optimized adjacency lists, making multi-hop traversals orders of magnitude faster for deep graphs.

**But be honest:** most "graph problems" in typical applications (social follows, org hierarchies, simple recommendations) work fine with recursive CTEs or even a couple of self-joins. You need a dedicated graph database when you're doing 5+ hop traversals on graphs with millions of edges.

### Full-text search at scale with advanced relevance

PostgreSQL's `tsvector`/`tsquery` full-text search is genuinely good — it supports stemming, ranking, phrase search, and GIN/GiST indexing. For a search feature on a blog or documentation site with a few million documents, PG full-text search is often sufficient.

Where it falls short: faceted search (filter by category + price range + rating while searching text), typo tolerance/fuzzy matching at scale, per-user personalization of search results, synonym expansion, and managing hundreds of millions of documents with sub-100ms response times. These require dedicated search infrastructure.

> **What a senior engineer actually thinks about**
>
> I've seen teams adopt Elasticsearch, Redis, MongoDB, and Kafka on day one of a project because they "might need it." They spend months managing infrastructure for specialized databases while PostgreSQL could have handled every workload for their first 2 years. My rule: start with PostgreSQL for everything. When a specific workload demonstrably hits PG's limits (with actual measurements, not "I read a blog post that said..."), add the specialized store for that workload only. The operational cost of each additional database is enormous — monitoring, backups, failover, schema management, connection management, consistency between systems.

---

## 10.2 OLTP vs OLAP: The Fundamental Divide

This is the most important conceptual distinction in database architecture. Once you understand it, every database technology choice becomes clearer.

### OLTP — Online Transaction Processing

OLTP workloads are what your web application does every day:

- A user signs up → INSERT one row into `users`
- A user views their profile → SELECT one row by primary key
- A user places an order → INSERT into `orders` and `order_items`, UPDATE `inventory`, all in a transaction
- A user updates their settings → UPDATE one row

**Characteristics:**
- **Many small operations**: thousands to millions of transactions per second
- **Point lookups**: queries typically fetch 1–100 rows by indexed key
- **Low latency required**: each operation should complete in < 50ms
- **High concurrency**: hundreds of users operating simultaneously
- **Mixed read/write**: both reads and writes happen constantly
- **ACID transactions**: correctness is critical (don't lose orders, don't double-charge)

PostgreSQL is an excellent OLTP database. It was designed for exactly this workload.

### OLAP — Online Analytical Processing

OLAP workloads are what your data team, business intelligence dashboards, and reporting systems do:

- "What was our total revenue per region per month for the last 2 years?"
- "Which product categories have declining sales trends?"
- "What's the average order value segmented by customer acquisition channel?"
- "Show me all customers who purchased product A but not product B in Q3"

**Characteristics:**
- **Few large operations**: maybe 10–100 queries per minute, each scanning millions of rows
- **Full table scans**: queries aggregate across large portions of data
- **Higher latency acceptable**: a report taking 5–30 seconds is fine
- **Low concurrency**: 5–20 analysts, not 10,000 users
- **Read-heavy**: analytics are almost exclusively reads against a data snapshot
- **Joins across large tables**: combining fact tables (orders) with dimension tables (products, customers, dates)

### Why the same database can't optimally serve both

This is a physical storage problem, not a software engineering problem.

**Row-oriented storage** (PostgreSQL, MySQL): Data is stored row by row on disk.

```
Disk page 1: [user_1_id, user_1_name, user_1_email, user_1_role, user_1_created, ...]
Disk page 2: [user_2_id, user_2_name, user_2_email, user_2_role, user_2_created, ...]
Disk page 3: [user_3_id, user_3_name, user_3_email, user_3_role, user_3_created, ...]
```

When you do `SELECT * FROM users WHERE id = 42`, you read one page, which contains the entire row. Fast. Perfect for OLTP.

When you do `SELECT AVG(age) FROM users`, you read every page (every row), loading all columns into memory, even though you only need the `age` column. Wasteful. Slow for OLAP.

**Column-oriented storage** (ClickHouse, Redshift, Parquet): Data is stored column by column.

```
Column file 'id':        [1, 2, 3, 4, 5, ...]
Column file 'name':      ['Alice', 'Bob', 'Carol', ...]
Column file 'email':     ['alice@co', 'bob@co', 'carol@co', ...]
Column file 'age':       [28, 35, 42, 31, 27, ...]
```

When you do `SELECT AVG(age) FROM users`, you read only the `age` column file. On a table with 20 columns, you read 1/20th of the data. Additionally, same-type data compresses dramatically better (a column of integers compresses far better than a row mixing integers, strings, dates, and booleans).

When you do `SELECT * FROM users WHERE id = 42`, you need to read all column files and reconstruct the row. Slow. Terrible for OLTP.

This is not a limitation of any particular database — it's a fundamental tradeoff in data layout.

### A concrete example

Imagine an e-commerce database with an `orders` table: 200 million rows, 30 columns (id, customer_id, status, total, shipping_address, billing_address, etc.).

**OLTP query** — "Get order #12345 for customer display":

```sql
SELECT * FROM orders WHERE id = 12345;
```

| Storage | How it works | Time |
|---|---|---|
| Row store (PG) | B-tree index lookup → read 1 page (8KB) | ~1ms |
| Column store | Read position 12345 from all 30 column files | ~50ms |

**OLAP query** — "Monthly revenue for 2024":

```sql
SELECT date_trunc('month', created_at) AS month,
       SUM(total) AS revenue
FROM orders
WHERE created_at >= '2024-01-01'
GROUP BY 1 ORDER BY 1;
```

| Storage | How it works | Time |
|---|---|---|
| Row store (PG) | Sequential scan: read all 200M rows × 30 columns ≈ 60GB | ~180s |
| Column store | Read 2 columns (created_at + total) ≈ 3GB, compressed ≈ 500MB | ~3s |

That's the difference. Not 2x faster. **60x faster.** And the gap widens with more columns and more rows.

> **What a senior engineer actually thinks about**
>
> Most startups don't need a separate OLAP database for their first year or two. Run your analytics queries on a PostgreSQL read replica. When those queries start taking minutes and affecting replica lag, that's your signal to add a column store. The transition point is usually around 50M–200M rows in your largest analytical table, depending on query complexity. I've seen teams spin up a Redshift cluster for a 5M-row table that PostgreSQL handles in under a second.

---

## 10.3 Column Stores (Redshift, BigQuery, ClickHouse)

### How Columnar Storage Physically Works

Let's go deeper than the overview. Here's what happens inside a column-store database:

**1. Data is stored in column files (or column chunks):**

Each column is stored as a contiguous array of values. A table with 30 columns becomes 30 separate files (or file segments). Within each file, values are stored in the same order as the rows — value at position N in the `price` column corresponds to value at position N in the `customer_id` column.

**2. Compression is dramatically more effective:**

When you have a column of integers (e.g., `quantity_ordered`), the values cluster around a narrow range (1–10 for most orders). A column store can use:

- **Run-Length Encoding (RLE)**: If 10,000 consecutive rows have `status = 'shipped'`, store it once with a count instead of 10,000 times.
- **Dictionary encoding**: Replace string values with integer IDs. If there are 5 order statuses, store 3-bit integers instead of variable-length strings.
- **Delta encoding**: For sorted or nearly-sorted columns (like timestamps), store the difference between consecutive values. Instead of `[1710000000, 1710000001, 1710000003, ...]`, store `[1710000000, +1, +2, ...]`.
- **Bit-packing**: If a column's values fit in 12 bits, don't waste 32 or 64 bits per value.

A row-oriented database stores rows like `[int, string, float, timestamp, string, ...]` — the mix of types prevents most compression schemes from working well. A column of homogeneous types compresses 5x–20x better.

**3. Vectorized execution:**

Modern CPUs can process multiple values in a single instruction using SIMD (Single Instruction, Multiple Data). When you compute `SUM(price)`, a column store loads a batch of 1000 price values into CPU registers and sums them in ~10 instructions instead of 1000. Row stores can't do this because each row contains mixed types.

**4. Zone maps / min-max indexes:**

Column stores divide each column into chunks (e.g., 100,000 values per chunk). For each chunk, they store the minimum and maximum values. When your query says `WHERE price > 100`, any chunk where `max(price) < 100` is skipped entirely. This is coarse-grained filtering but extremely fast for sorted or semi-sorted data.

### The Major Column Stores

**Amazon Redshift:**
- Managed column store based on PartiQL (fork of PostgreSQL 8.0 from 2005)
- Uses the PG wire protocol, so `pg` clients work
- Best for: teams already on AWS, structured data in S3, integration with AWS data pipeline
- Pricing: pay per cluster (provisioned) or per query (Serverless)
- Limitation: not real-time; designed for batch-loaded data with periodic COPY commands

**Google BigQuery:**
- Serverless column store — no infrastructure to manage
- Stores data in Google's Capacitor format across distributed storage
- Best for: zero-ops analytics, ad-hoc exploration, Google Cloud ecosystem
- Pricing: per-query (bytes scanned) + storage. Can be surprisingly expensive for frequent queries
- Limitation: not a transactional database; designed for large reads, not point lookups

**ClickHouse:**
- Open-source column store, originally built by Yandex for web analytics
- Extremely fast for real-time analytics (sub-second queries on billions of rows)
- Best for: log analytics, event tracking, real-time dashboards, high ingestion rate
- Uses its own wire protocol and SQL dialect (not PG-compatible)
- Limitation: no transactions, no UPDATE/DELETE in the traditional sense (uses async mutations), eventual consistency for replicas

**Query performance comparison:**

Consider a query: "Top 10 products by revenue in the last 30 days" on a table with 500M rows and 25 columns:

```sql
SELECT product_id, SUM(quantity * price) AS revenue
FROM order_items
WHERE created_at >= NOW() - INTERVAL '30 days'
GROUP BY product_id
ORDER BY revenue DESC
LIMIT 10;
```

| Database | Approach | Approximate time |
|---|---|---|
| PostgreSQL | Sequential scan (no useful index for range + aggregation) | 45–120s |
| PostgreSQL + BRIN index | BRIN on created_at helps, still scans wide rows | 15–40s |
| Redshift | Column scan, compressed, vectorized | 2–8s |
| ClickHouse | Column scan, aggressive compression, vectorized | 0.3–1.5s |
| BigQuery | Serverless distributed scan | 2–5s |

### DuckDB — The Local Analytics Engine

DuckDB deserves a special mention. It's an embedded column-store database (like SQLite, but columnar) that runs in-process. You can:

- Query Parquet, CSV, and JSON files directly
- Process data locally without any server
- Integrate with PostgreSQL via the `postgres` extension

```sql
-- DuckDB can query your PostgreSQL database directly
INSTALL postgres;
LOAD postgres;

ATTACH 'postgresql://user:pass@host:5432/mydb' AS pg_db (TYPE postgres);

-- Run columnar analytics against PG data
SELECT date_trunc('month', created_at) AS month,
       SUM(total) AS revenue
FROM pg_db.public.orders
WHERE created_at >= '2024-01-01'
GROUP BY 1;
```

DuckDB reads the data from PostgreSQL, processes it using its columnar engine, and returns results. For datasets that fit in memory (up to ~100GB), this can be faster than running the query in PostgreSQL directly.

It's also excellent for local data exploration:

```typescript
// Node.js with duckdb-async
import { Database } from 'duckdb-async';

const db = await Database.create(':memory:');

// Analyze a 10GB Parquet file locally in seconds
const result = await db.all(`
  SELECT
    date_trunc('month', event_time) AS month,
    event_type,
    COUNT(*) AS count
  FROM read_parquet('s3://my-bucket/events/*.parquet')
  WHERE event_time >= '2024-01-01'
  GROUP BY 1, 2
  ORDER BY 1, 3 DESC
`);
```

> **What a senior engineer actually thinks about**
>
> ClickHouse is my go-to for analytics when the team can manage infrastructure. BigQuery when they can't. Redshift if they're already deep in the AWS ecosystem. But before spinning up any of these, I try DuckDB on a read replica or exported Parquet files. If DuckDB handles it (and it handles a surprising amount), you've saved yourself an entire analytics infrastructure. The step-by-step escalation: PG read replica → DuckDB locally → managed column store.

---

## 10.4 Time-Series Databases (TimescaleDB, InfluxDB)

### What Makes Time-Series Data Different

Time-series data has distinct properties that make general-purpose databases struggle at scale:

1. **Append-mostly**: New data always arrives at the "end" (recent timestamps). Historical data is rarely updated. This is fundamentally different from user profiles (frequently updated) or orders (occasionally updated).

2. **Time-ordered**: Queries almost always filter by time range ("last 24 hours", "last 7 days"). The primary access pattern is `WHERE time BETWEEN X AND Y`.

3. **High cardinality**: Each unique combination of metric/source is a "series." A monitoring system tracking 50 metrics across 1,000 servers produces 50,000 series. Each series has one data point per second, which is 4.3 billion data points per day.

4. **Downsampling/retention**: You need second-resolution data for the last hour, minute-resolution for the last week, hourly for the last year, and daily forever. Raw data must be progressively compressed.

5. **Bulk aggregation**: Queries like "average CPU across all servers per 5-minute bucket" scan large time ranges and group by time windows.

Common time-series workloads:
- Server/application monitoring (CPU, memory, request latency)
- IoT sensor data (temperature, humidity, vibration)
- Financial market data (stock prices, trading volumes)
- User analytics events (page views, clicks, conversions)

### How Time-Series Databases Optimize

**Automatic time-based partitioning:** Instead of one giant table, the database automatically splits data into time-based partitions (called "chunks" in TimescaleDB). A query for "last 24 hours" only touches 1–2 chunks out of thousands.

**Columnar compression on older chunks:** Recent data stays row-oriented for fast writes. Older data is compressed into a columnar format, reducing storage 10–20x and improving scan performance.

**Downsampling/continuous aggregates:** The database automatically maintains pre-computed aggregates (e.g., hourly averages) that update as new data arrives. Querying the aggregate is instant instead of scanning millions of raw rows.

**Specialized indexes:** Time-series databases build indexes optimized for time ranges and tag lookups (which server, which metric) rather than general-purpose B-trees.

### TimescaleDB — PostgreSQL Extension

TimescaleDB is PostgreSQL with a time-series extension. This is significant: you get all of PostgreSQL's features (SQL, JOINs, transactions, extensions) plus time-series optimizations. Your existing PG knowledge, tools, and drivers all work.

**Setup:**

```sql
-- Enable the extension
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Create a regular table
CREATE TABLE sensor_data (
  time        TIMESTAMPTZ NOT NULL,
  sensor_id   INTEGER NOT NULL,
  temperature DOUBLE PRECISION,
  humidity    DOUBLE PRECISION,
  battery     DOUBLE PRECISION
);

-- Convert to a hypertable (auto-partitioned by time)
SELECT create_hypertable('sensor_data', 'time',
  chunk_time_interval => INTERVAL '1 day'
);

-- Optional: add a space partition for high-cardinality data
SELECT add_dimension('sensor_data', 'sensor_id', number_partitions => 4);
```

A **hypertable** looks and behaves like a regular PostgreSQL table to your application. Under the hood, it's automatically partitioned into chunks by time. Each chunk is a real PG table, and TimescaleDB routes queries to the relevant chunks.

**Querying — it's just SQL:**

```sql
-- Average temperature per sensor, last 24 hours, in 5-minute buckets
SELECT
  time_bucket('5 minutes', time) AS bucket,
  sensor_id,
  AVG(temperature) AS avg_temp,
  MAX(temperature) AS max_temp,
  MIN(temperature) AS min_temp
FROM sensor_data
WHERE time > NOW() - INTERVAL '24 hours'
GROUP BY bucket, sensor_id
ORDER BY bucket DESC;

-- Moving average with a window function
SELECT
  time,
  sensor_id,
  temperature,
  AVG(temperature) OVER (
    PARTITION BY sensor_id
    ORDER BY time
    ROWS BETWEEN 11 PRECEDING AND CURRENT ROW
  ) AS moving_avg_12
FROM sensor_data
WHERE time > NOW() - INTERVAL '1 hour'
  AND sensor_id = 42;

-- Downsample: daily aggregates for a year-long dashboard
SELECT
  time_bucket('1 day', time) AS day,
  sensor_id,
  AVG(temperature) AS avg_temp,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY temperature) AS p95_temp
FROM sensor_data
WHERE time > NOW() - INTERVAL '1 year'
GROUP BY day, sensor_id
ORDER BY day;
```

**Continuous aggregates (materialized views that auto-update):**

```sql
-- Create a continuous aggregate for hourly averages
CREATE MATERIALIZED VIEW sensor_hourly
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', time) AS hour,
  sensor_id,
  AVG(temperature) AS avg_temp,
  MAX(temperature) AS max_temp,
  MIN(temperature) AS min_temp,
  COUNT(*) AS sample_count
FROM sensor_data
GROUP BY hour, sensor_id
WITH NO DATA;

-- Set up automatic refresh policy
SELECT add_continuous_aggregate_policy('sensor_hourly',
  start_offset    => INTERVAL '3 hours',
  end_offset      => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour'
);

-- Query the aggregate (instant, even over a year of data)
SELECT * FROM sensor_hourly
WHERE hour > NOW() - INTERVAL '30 days'
  AND sensor_id = 42
ORDER BY hour;
```

**Compression (available in TimescaleDB 2.0+):**

```sql
-- Enable compression on chunks older than 7 days
ALTER TABLE sensor_data SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'sensor_id',
  timescaledb.compress_orderby = 'time DESC'
);

SELECT add_compression_policy('sensor_data', INTERVAL '7 days');
```

Compression typically achieves 10–20x reduction and stores the data in a columnar format, making analytical queries on historical data faster.

**Retention (automatically drop old data):**

```sql
-- Delete raw data older than 90 days
SELECT add_retention_policy('sensor_data', INTERVAL '90 days');
-- Keep hourly aggregates forever (continuous aggregate is not affected)
```

### When you need a dedicated TSDB vs PG with good partitioning

**Plain PostgreSQL with partitioning works when:**
- You have < 1 billion time-series data points
- You have < 10,000 unique series
- You don't need sub-second query performance on time-range aggregations
- You don't need automatic downsampling
- You're already on PostgreSQL and don't want another system

**TimescaleDB works when:**
- You need time-series optimizations but also need relational features (JOINs to user tables, transactions)
- You have moderate to high data volumes (billions of points)
- Your team knows PostgreSQL
- You want continuous aggregates and compression without application-level logic

**Dedicated TSDB (InfluxDB, Prometheus) works when:**
- You have extremely high write throughput (> 1M points/second)
- Your workload is purely time-series with no relational needs
- You need specialized time-series query languages (InfluxQL, PromQL)
- You need built-in alerting and anomaly detection

> **What a senior engineer actually thinks about**
>
> TimescaleDB is one of the best examples of "PostgreSQL extension instead of new database." You add one extension and get 90% of what a dedicated TSDB gives you, with no new operational burden, no new backup strategy, and no consistency issues between systems. I reach for InfluxDB/Prometheus only for dedicated infrastructure monitoring where the Grafana integration is established, or when write volumes genuinely exceed what a single PG instance can handle (> 1M inserts/second sustained).

---

## 10.5 Key-Value Stores (Redis)

If PostgreSQL is a full-service restaurant (menu, courses, table service), Redis is a vending machine — you put in a key, you get a value, instantly. That simplicity is its superpower.

Redis keeps all data in memory. Every operation — read or write — happens against in-memory data structures. Disk is used only for persistence (saving state across restarts). This gives Redis sub-millisecond latency that no disk-based database can match.

### Data Structures

Redis is not just a key-value store. It's a **data structure server**. Each value type has its own set of operations:

**Strings** — The simplest. A key maps to a binary-safe string (up to 512MB).

```redis
SET session:abc123 '{"userId":42,"role":"admin"}' EX 3600
GET session:abc123
INCR page:views:homepage          -- atomic increment (counter)
SETNX lock:process-orders "pid1"  -- set only if not exists (distributed lock)
```

**Hashes** — A key maps to a hash map of field-value pairs. Like a JavaScript object stored at a key.

```redis
HSET user:42 name "Alice" email "alice@co.com" role "admin"
HGET user:42 name                       -- "Alice"
HGETALL user:42                         -- all fields and values
HINCRBY user:42 login_count 1           -- atomic field increment
```

**Lists** — Ordered sequences. Implemented as linked lists (fast push/pop at both ends, slow random access).

```redis
LPUSH notifications:42 '{"type":"mention","from":99}'
RPUSH notifications:42 '{"type":"like","postId":5}'
LRANGE notifications:42 0 9            -- get first 10 items
LLEN notifications:42                  -- count
LTRIM notifications:42 0 99           -- keep only last 100 (bounded list)
```

**Sets** — Unordered collections of unique strings. O(1) membership check.

```redis
SADD online:users "user:42" "user:99" "user:7"
SISMEMBER online:users "user:42"       -- true (O(1))
SCARD online:users                     -- count of online users
SINTER online:users premium:users      -- users who are both online AND premium
```

**Sorted Sets** — Like sets, but each member has a score (float). Members are ordered by score. Incredibly useful.

```redis
ZADD leaderboard 1500 "player:42" 2300 "player:7" 1800 "player:99"
ZRANGE leaderboard 0 9 REV WITHSCORES  -- top 10 by score, descending
ZRANK leaderboard "player:42"          -- rank of player 42
ZINCRBY leaderboard 50 "player:42"     -- add 50 points
ZRANGEBYSCORE leaderboard 1000 2000    -- all players with score 1000-2000
```

Use cases: leaderboards, priority queues, rate limiters (sorted by timestamp), autocomplete (sorted by frequency).

**Streams** — Append-only log data structure (like a mini Kafka). (Redis 5.0+)

```redis
XADD events:orders * action "placed" order_id "12345" total "99.50"
XADD events:orders * action "paid" order_id "12345"
XRANGE events:orders - +                     -- all entries
XREAD COUNT 10 BLOCK 5000 STREAMS events:orders $  -- wait for new entries
```

**HyperLogLog** — Probabilistic data structure that estimates the count of unique elements using ~12KB of memory regardless of the actual count.

```redis
PFADD unique:visitors:2024-03-22 "user:42" "user:99" "user:7"
PFADD unique:visitors:2024-03-22 "user:42"   -- duplicate, not counted
PFCOUNT unique:visitors:2024-03-22            -- ~3 (approximate)
PFMERGE unique:visitors:2024-03 unique:visitors:2024-03-01 ... unique:visitors:2024-03-31
-- Monthly unique visitors without storing every visitor ID
```

### Persistence Modes

**RDB (Redis Database) Snapshots:** Redis forks the process and writes the entire dataset to disk as a point-in-time snapshot. Configured to run periodically (e.g., every 5 minutes if 100+ keys changed).

- Pros: Compact file, fast startup, good for backups
- Cons: Data loss between snapshots (up to 5 minutes)

**AOF (Append-Only File):** Every write operation is appended to a log file. On restart, Redis replays the log.

- Pros: Minimal data loss (configurable: `everysec` loses ~1 second, `always` loses nothing)
- Cons: Larger files, slower restart

**Hybrid (RDB + AOF):** Use both. RDB for fast restarts, AOF for durability between snapshots. This is the recommended production configuration since Redis 4.0.

```conf
# redis.conf
save 900 1          # snapshot if 1 key changed in 15 min
save 300 10         # snapshot if 10 keys changed in 5 min
save 60 10000       # snapshot if 10000 keys changed in 1 min

appendonly yes
appendfsync everysec
```

### Cache Patterns

The most common use of Redis alongside PostgreSQL is as a cache. Here are the patterns:

**Cache-Aside (Lazy Loading):**

```typescript
async function getUser(userId: number): Promise<User> {
  const cacheKey = `user:${userId}`;

  // Try cache first
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // Cache miss — fetch from PostgreSQL
  const { rows: [user] } = await pool.query(
    'SELECT * FROM users WHERE id = $1',
    [userId]
  );

  if (user) {
    // Store in cache with TTL
    await redis.set(cacheKey, JSON.stringify(user), 'EX', 3600);
  }

  return user;
}
```

**Write-Through:** Update the cache on every write. The cache is always up-to-date.

```typescript
async function updateUser(userId: number, data: Partial<User>): Promise<User> {
  const { rows: [user] } = await pool.query(
    'UPDATE users SET name = COALESCE($1, name), email = COALESCE($2, email) WHERE id = $3 RETURNING *',
    [data.name, data.email, userId]
  );

  // Update cache immediately after database write
  await redis.set(`user:${userId}`, JSON.stringify(user), 'EX', 3600);

  return user;
}
```

**Write-Behind (Write-Back):** Write to the cache immediately and asynchronously flush to the database. Dangerous but useful for high-write scenarios (like view counts).

```typescript
async function incrementViewCount(postId: number): Promise<void> {
  // Write to Redis immediately (fast)
  await redis.hincrby(`post:views`, String(postId), 1);
  // Flush to PostgreSQL periodically (batch job every minute)
}

// Background job
async function flushViewCounts(): Promise<void> {
  const views = await redis.hgetall('post:views');
  if (Object.keys(views).length === 0) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [postId, count] of Object.entries(views)) {
      await client.query(
        'UPDATE posts SET view_count = view_count + $1 WHERE id = $2',
        [parseInt(count), parseInt(postId)]
      );
    }
    await client.query('COMMIT');
    await redis.del('post:views'); // clear after flushing
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
```

**Cache Invalidation** — The hardest problem in computer science (after naming things):

```typescript
// Option 1: TTL-based (eventual consistency)
await redis.set(key, value, 'EX', 300); // auto-expires after 5 min

// Option 2: Explicit invalidation on write
async function deleteUser(userId: number) {
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  await redis.del(`user:${userId}`);
  await redis.del(`user-posts:${userId}`);
  await redis.del(`user-profile:${userId}`);
  // What if you forget one of these? Stale data.
}

// Option 3: Key pattern invalidation (if using key prefixes)
// Requires SCAN (don't use KEYS in production — it blocks Redis)
async function invalidateUserCache(userId: number) {
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `user:${userId}:*`, 'COUNT', 100);
    cursor = nextCursor;
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } while (cursor !== '0');
}
```

### Pub/Sub

Redis Pub/Sub enables real-time message broadcasting between services:

```typescript
// Publisher
await redis.publish('channel:orders', JSON.stringify({
  action: 'placed',
  orderId: 12345,
  customerId: 42,
}));

// Subscriber
const sub = redis.duplicate(); // dedicated connection for subscriptions
await sub.subscribe('channel:orders');
sub.on('message', (channel, message) => {
  const event = JSON.parse(message);
  console.log(`Order ${event.orderId} was ${event.action}`);
});
```

Note: Redis Pub/Sub is fire-and-forget. If a subscriber is offline when a message is published, it misses the message. For reliable messaging, use Redis Streams or a dedicated message queue.

### Redis Cluster

For horizontal scaling, Redis Cluster splits data across multiple nodes using hash slots (16,384 slots distributed across nodes). The client library handles routing.

```typescript
import Redis from 'ioredis';

const cluster = new Redis.Cluster([
  { host: 'redis-node-1', port: 6379 },
  { host: 'redis-node-2', port: 6379 },
  { host: 'redis-node-3', port: 6379 },
]);

await cluster.set('key', 'value'); // automatically routed to correct node
```

### When Redis + PG is the right architecture

The pattern: PostgreSQL is your source of truth (durable, consistent, relational). Redis is your performance layer (caching, sessions, rate limiting, real-time).

```
Client → API Server → Redis (cache check)
                    → PostgreSQL (if cache miss)
                    → Redis (cache update)
```

Typical Redis uses alongside PG:
- **Session storage**: User sessions with 30-minute TTL
- **API rate limiting**: Sorted set with request timestamps per API key
- **Caching**: Query results, computed values, API responses
- **Real-time features**: Online presence, typing indicators, live dashboards
- **Distributed locks**: Coordinating access to shared resources across app instances
- **Job queues**: Using lists or sorted sets (though Bull/BullMQ abstracts this)

> **What a senior engineer actually thinks about**
>
> Redis is the first specialized database I add to any architecture, usually within the first few months of a project. Session storage and caching alone justify it. But I'm strict about what goes in Redis vs PostgreSQL: if I need to query it, join it, or it's important business data — it's in PostgreSQL. If it's ephemeral, derived, or needs sub-millisecond access — it's in Redis. The moment you treat Redis as a primary data store for important data, you're one restart away from data loss (even with persistence — AOF replay is not a backup strategy).

---

## 10.6 Document Stores (MongoDB)

The "MongoDB vs PostgreSQL" debate has been one of the most heated in backend engineering. Let's skip the tribalism and look at this objectively.

### When the Document Model Genuinely Wins

MongoDB stores data as BSON (Binary JSON) documents in collections. Each document can have a different structure — no schema enforcement (though you can add validation).

```json
{
  "_id": ObjectId("507f1f77bcf86cd799439011"),
  "name": "Alice",
  "email": "alice@co.com",
  "addresses": [
    {
      "type": "home",
      "street": "123 Main St",
      "city": "Portland",
      "coordinates": { "lat": 45.5, "lng": -122.6 }
    },
    {
      "type": "work",
      "street": "456 Tech Blvd",
      "city": "Portland",
      "coordinates": { "lat": 45.52, "lng": -122.65 }
    }
  ],
  "preferences": {
    "theme": "dark",
    "notifications": {
      "email": true,
      "push": false,
      "frequency": "daily"
    }
  },
  "tags": ["premium", "early-adopter"],
  "lastLogin": ISODate("2024-03-15T10:30:00Z")
}
```

**Where MongoDB's document model genuinely shines:**

**1. Deeply nested, variable-schema documents:**

Content management systems, product catalogs with radically different attributes per category, or configuration documents where each record has a unique structure. In a relational model, this requires either EAV (Entity-Attribute-Value) tables (terrible for querying) or wide tables with 90% NULL columns.

```javascript
// Product catalog where electronics and clothing have completely different attributes
// MongoDB: each document has its own structure
db.products.insertMany([
  {
    name: "MacBook Pro 16",
    category: "electronics",
    specs: {
      cpu: "M3 Max",
      ram: "36GB",
      storage: "1TB SSD",
      ports: ["HDMI", "USB-C", "MagSafe", "SD"]
    }
  },
  {
    name: "Wool Sweater",
    category: "clothing",
    sizes: ["S", "M", "L", "XL"],
    colors: ["navy", "charcoal"],
    material: { primary: "merino wool", blend: "85% wool, 15% nylon" },
    careInstructions: ["dry clean", "hand wash cold"]
  }
]);
```

In PostgreSQL, you'd use JSONB columns for the variable parts — and that works. But if virtually every column varies per document type, you end up with one JSONB column and nothing relational, at which point MongoDB's query engine and indexing for nested documents is more natural.

**2. Geographically distributed writes:**

MongoDB Atlas provides multi-region, multi-writer deployments where writes can happen at the nearest data center. PostgreSQL's primary-replica model means all writes must go to a single primary. For applications where users across the globe need low-latency writes (collaborative editing, global social networks), MongoDB's distributed model is architecturally suited.

**3. Schema-less prototyping:**

During the early stages of a product when the data model changes daily, MongoDB's flexibility reduces friction. No migrations, no ALTER TABLE, just write a different document structure. This is a genuine advantage for the first 1–3 months of a project.

### When PostgreSQL JSONB Is Sufficient (Most Cases)

PostgreSQL's JSONB (Binary JSON) gives you document-store capabilities inside a relational database:

```sql
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  price NUMERIC(10, 2) NOT NULL,
  attributes JSONB NOT NULL DEFAULT '{}'
);

-- Index for fast lookups within JSONB
CREATE INDEX idx_products_attributes ON products USING GIN (attributes);

-- Query nested JSONB
SELECT name, price, attributes->>'cpu' AS cpu
FROM products
WHERE category = 'electronics'
  AND attributes @> '{"ram": "36GB"}'  -- contains this JSON subset
  AND price < 3000;

-- Update nested JSONB
UPDATE products
SET attributes = jsonb_set(attributes, '{specs,storage}', '"2TB SSD"')
WHERE id = 42;
```

PostgreSQL JSONB advantages over MongoDB:
- JOINs between structured and semi-structured data
- ACID transactions across JSONB and relational columns
- CHECK constraints on JSONB paths (PG 12+)
- Full-text search with ts_vector alongside JSONB
- Existing operational knowledge — no new backup/monitoring tooling

### MongoDB's Consistency Model

MongoDB's consistency model is fundamentally different from PostgreSQL's, and misunderstanding it causes production bugs:

**Write Concern:** Controls how many replicas must acknowledge a write before it's considered successful.

```javascript
// Default: acknowledged by primary only (fast, but can lose data on primary failure)
db.collection.insertOne(doc, { writeConcern: { w: 1 } });

// Majority: acknowledged by majority of replicas (durable, slower)
db.collection.insertOne(doc, { writeConcern: { w: "majority" } });
```

**Read Concern:** Controls what data a read can see.

```javascript
// local: reads from primary, may see data that hasn't replicated (default)
db.collection.find().readConcern("local");

// majority: only reads data acknowledged by majority (consistent but may see stale data)
db.collection.find().readConcern("majority");

// linearizable: strongest guarantee, similar to PostgreSQL's default behavior
db.collection.find().readConcern("linearizable");
```

With default settings, MongoDB can return data that a subsequent read doesn't see (if the primary fails and the write hadn't replicated). PostgreSQL never does this — a committed transaction is durable and visible to all subsequent reads.

### The "MongoDB vs Postgres" Decision Framework

| Factor | Choose MongoDB | Choose PostgreSQL |
|---|---|---|
| **Data structure** | Truly variable/nested per record | Mostly predictable with some flexible parts |
| **Relationships** | Few cross-document relationships | Many relationships between entities |
| **Consistency needs** | Eventual consistency acceptable | Strong consistency required |
| **Query patterns** | Single-document access patterns | Complex joins, aggregations, reports |
| **Global distribution** | Multi-region writes needed | Single-region or read replicas sufficient |
| **Schema stability** | Schema changes constantly | Schema is relatively stable |
| **Transaction scope** | Single-document (or simple multi-doc) | Multi-table transactions frequent |
| **Team expertise** | Strong JavaScript/NoSQL background | Strong SQL background |
| **Existing infrastructure** | Greenfield, no existing database | Existing PG infrastructure |

The honest answer for 80% of web applications: PostgreSQL with JSONB columns for the flexible parts. The document-model advantages of MongoDB are real but narrow, while PostgreSQL's relational features (JOINs, constraints, transactions) are needed more often.

> **What a senior engineer actually thinks about**
>
> I've migrated three separate projects from MongoDB to PostgreSQL. In every case, the "we don't know the schema yet" justification evaporated within 3 months as the schema stabilized. What remained was the pain of no JOINs (replaced by multiple queries or embedding), no multi-document transactions (worked around with application-level logic), and the operational complexity of a separate database. That said, I've seen MongoDB used well: a headless CMS where content blocks are genuinely unpredictable, and a global game that needed multi-region writes. Those were the right call.

---

## 10.7 NewSQL and Distributed SQL (CockroachDB, PlanetScale, Neon, YugabyteDB)

### What Problems They Solve

Traditional PostgreSQL is a single-node database. You can add read replicas, but writes always go to one primary. This creates hard limits:

1. **Write throughput ceiling**: A single server has finite CPU, memory, and disk I/O. If your application outgrows the biggest server you can buy, you're stuck.

2. **Geographic latency**: If your primary is in us-east-1 and users are in Tokyo, every write crosses the Pacific (~150ms round trip). Read replicas help for reads, but writes always hit the primary.

3. **Availability during failures**: If the primary fails, there's a failover window (seconds to minutes) where writes are unavailable. For some applications, this is unacceptable.

Distributed SQL databases solve these problems by spreading data across multiple nodes that coordinate to provide a single logical database.

### CockroachDB

CockroachDB (CRDB) is the most mature distributed SQL database. It uses the PostgreSQL wire protocol, so your `pg` or `postgres.js` client connects to it like any PG database. But under the hood, data is automatically sharded and replicated across nodes.

**How it works:**
- Data is split into "ranges" (typically 512MB each)
- Each range has 3 replicas on different nodes (configurable)
- Writes use Raft consensus (a majority of replicas must agree before a write is committed)
- The SQL layer translates queries into distributed reads/writes across ranges
- Transactions are distributed — a single transaction can touch data on multiple nodes

**The consistency tradeoff:**

CockroachDB provides serializable isolation by default (stronger than PG's default of READ COMMITTED). To coordinate across nodes, it uses a hybrid logical clock (HLC) inspired by Google's Spanner. Every transaction's commit requires communication between nodes, which adds latency:

| Operation | PostgreSQL (single node) | CockroachDB (3-node, same region) | CockroachDB (multi-region) |
|---|---|---|---|
| Simple INSERT | ~1ms | ~5-15ms | ~50-200ms |
| Point SELECT | ~0.5ms | ~2-5ms | ~10-50ms |
| Cross-region transaction | N/A | N/A | ~200-500ms |

**When CockroachDB makes sense:**
- You genuinely need horizontal write scaling (not just read scaling)
- You need multi-region deployments with local reads AND writes
- You need 99.999% uptime (no single point of failure)
- Your team is comfortable with the latency tradeoffs

**When CockroachDB is overkill:**
- Your workload fits on a single large PostgreSQL server (it usually does)
- Your users are concentrated in one geographic region
- You're not willing to accept the latency overhead of distributed consensus

### PlanetScale / Vitess

PlanetScale is a managed database service built on Vitess, which is MySQL-based (not PostgreSQL). It's relevant here because it solves a common problem: horizontal scaling for MySQL-style workloads.

Vitess was built by YouTube to shard MySQL. PlanetScale wraps it in a developer-friendly managed service with features like:
- **Database branching**: Create a branch of your schema (like a git branch), make changes, merge
- **Non-blocking schema changes**: ALTER TABLE operations that don't lock the table
- **Connection pooling**: Built-in, no PgBouncer equivalent needed

The catch: it's MySQL syntax, not PostgreSQL. No JSONB, different full-text search, different extension ecosystem. If you're in the PostgreSQL world, this isn't a direct option.

### Neon — Serverless PostgreSQL

Neon is a "serverless" PostgreSQL that separates compute from storage. This architecture enables features that traditional PostgreSQL can't offer:

**Scale-to-zero:** When no queries are running, compute instances shut down entirely. You pay nothing during idle periods. When a query arrives, a compute node boots in ~500ms. This is transformative for development databases, preview environments, and low-traffic applications.

**Database branching:** Create instant copy-on-write branches of your database (like a git branch). A branch shares the parent's data until you diverge. This enables:
- Per-PR preview databases (branch from production, run migrations, test)
- Safe testing of data migrations (branch, migrate, verify, delete branch)
- Development databases that start with production data (anonymized)

```bash
# Create a branch of your production database
neon branches create --name feature/new-checkout --parent main

# Each branch gets its own connection string
DATABASE_URL=postgresql://user:pass@ep-branch-xyz.us-east-2.aws.neon.tech/mydb
```

**Autoscaling:** Compute scales up during traffic spikes and down during quiet periods. No manual provisioning.

**How it works under the hood:**

Traditional PostgreSQL has compute (query processing) and storage (data files) tightly coupled on one server. Neon separates them:
- **Compute nodes**: Stateless PostgreSQL instances that process queries
- **Pageserver**: Distributed storage layer that serves data pages over the network
- **Safekeepers**: WAL persistence layer that ensures durability

When a query needs a data page, the compute node requests it from the pageserver (similar to how a CDN serves content). Branching works because branches share pages — a branch only stores the delta (pages that differ from the parent).

**Tradeoffs:**
- Read latency is slightly higher than local PostgreSQL (network hop to pageserver)
- Cold start on scale-to-zero adds ~500ms to the first query
- Full PG compatibility, but some extensions are restricted
- Relatively new — less production track record than RDS

### YugabyteDB

YugabyteDB is another distributed SQL database using the PG wire protocol. It's similar to CockroachDB in architecture (Raft consensus, automatic sharding) but differs in implementation:

- Built on a modified version of PostgreSQL's query layer (not just the wire protocol)
- Better PG compatibility than CockroachDB for some features (PG extensions, stored procedures)
- Uses a hybrid storage engine (based on RocksDB)
- Supports both YSQL (PostgreSQL-compatible) and YCQL (Cassandra-compatible) APIs

### AlloyDB (Google Cloud)

AlloyDB is Google's managed PostgreSQL-compatible database. It's not distributed SQL in the CockroachDB sense, but it separates compute from storage (like Neon/Aurora) to provide:
- 4x throughput of standard PG (Google's claim) through an intelligent caching layer
- Cross-region replicas
- Built-in AI/ML integration with pgvector

### When You Actually Need Distributed SQL

Most teams adopt distributed SQL too early. Here's a reality check:

**A single PostgreSQL instance on modern hardware can handle:**
- 500GB–5TB of data (SSD)
- 10,000–50,000 transactions per second
- 1,000+ concurrent connections (with PgBouncer)
- Sub-millisecond point lookups

**You should consider distributed SQL when:**
- Your write volume genuinely exceeds what a single server handles (> 50K writes/sec sustained)
- You need < 50ms write latency from multiple continents simultaneously
- You need zero-downtime operations including during node failures
- Regulatory requirements demand data residency (specific data must stay in specific regions)

**You should NOT adopt distributed SQL because:**
- "We might need to scale" (premature optimization)
- "Our reads are slow" (add read replicas instead)
- "We want high availability" (standard PG failover with Patroni/Stolon takes < 10 seconds)

> **What a senior engineer actually thinks about**
>
> I'm excited about Neon for the developer experience (branching and scale-to-zero are genuinely useful), and I respect CockroachDB for the engineering achievement it represents. But I've never worked at a company that actually needed distributed SQL. Instagram ran on PostgreSQL with application-level sharding. Discord uses PostgreSQL (with Rust services). Millions of applications serving millions of users run on a single well-configured PostgreSQL instance. The operational complexity of distributed consensus (debugging cross-node transaction failures, understanding latency spikes from Raft elections, dealing with clock skew) is significant. Start with PostgreSQL. If you genuinely outgrow it — and you'll know because you've measured — then evaluate distributed options.

---

## 10.8 Event Sourcing and CQRS

Event sourcing and CQRS (Command Query Responsibility Segregation) are architectural patterns, not databases. But they fundamentally change how you use databases, so understanding them is essential for a well-rounded backend perspective.

### What Event Sourcing Is

In a traditional application, you store the **current state** of entities:

```sql
-- Traditional: the users table stores current state
UPDATE users SET name = 'Alice Smith', email = 'alice.smith@new.com' WHERE id = 42;
-- Previous name and email are gone. History is lost.
```

In event sourcing, you store **events** (things that happened) and derive the current state from the event log:

```sql
-- Event sourced: the events table stores what happened
INSERT INTO events (stream_id, event_type, data, version) VALUES
('user-42', 'UserCreated',     '{"name":"Alice","email":"alice@co.com"}',         1),
('user-42', 'EmailChanged',    '{"oldEmail":"alice@co.com","newEmail":"alice@new.com"}', 2),
('user-42', 'NameChanged',     '{"oldName":"Alice","newName":"Alice Smith"}',      3),
('user-42', 'EmailChanged',    '{"oldEmail":"alice@new.com","newEmail":"alice.smith@new.com"}', 4);
```

To get the current state, you replay the events in order:

```
Start: {}
→ UserCreated:  { name: "Alice", email: "alice@co.com" }
→ EmailChanged: { name: "Alice", email: "alice@new.com" }
→ NameChanged:  { name: "Alice Smith", email: "alice@new.com" }
→ EmailChanged: { name: "Alice Smith", email: "alice.smith@new.com" }
= Current state: { name: "Alice Smith", email: "alice.smith@new.com" }
```

Think of it like Git: Git stores every commit (event), and the current code (state) is derived by replaying commits. You can see the full history, revert to any point, and understand exactly how the code got to its current state.

### How It Relates to Databases

**The event store** is an append-only log. In its simplest form, it's a PostgreSQL table:

```sql
CREATE TABLE events (
  id          BIGSERIAL PRIMARY KEY,
  stream_id   TEXT NOT NULL,          -- aggregate identifier (e.g., 'order-123')
  event_type  TEXT NOT NULL,          -- what happened
  data        JSONB NOT NULL,         -- event payload
  metadata    JSONB DEFAULT '{}',     -- correlation IDs, user info, etc.
  version     INTEGER NOT NULL,       -- per-stream version for optimistic concurrency
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (stream_id, version)         -- prevents concurrent conflicting writes
);

CREATE INDEX idx_events_stream ON events (stream_id, version);
CREATE INDEX idx_events_type ON events (event_type);
CREATE INDEX idx_events_created ON events (created_at);
```

**Projections** are read-optimized views derived from events. They serve the same purpose as materialized views — pre-computed query results:

```sql
-- A projection: current user state, updated by processing events
CREATE TABLE user_projections (
  user_id     TEXT PRIMARY KEY,
  name        TEXT,
  email       TEXT,
  status      TEXT,
  version     INTEGER NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL
);
```

When a new event is appended, a projection handler reads it and updates the projection:

```typescript
async function handleUserEvent(event: Event) {
  switch (event.event_type) {
    case 'UserCreated':
      await pool.query(
        `INSERT INTO user_projections (user_id, name, email, status, version, updated_at)
         VALUES ($1, $2, $3, 'active', $4, NOW())`,
        [event.stream_id, event.data.name, event.data.email, event.version]
      );
      break;
    case 'EmailChanged':
      await pool.query(
        `UPDATE user_projections SET email = $1, version = $2, updated_at = NOW()
         WHERE user_id = $3`,
        [event.data.newEmail, event.version, event.stream_id]
      );
      break;
    case 'UserDeactivated':
      await pool.query(
        `UPDATE user_projections SET status = 'deactivated', version = $1, updated_at = NOW()
         WHERE user_id = $2`,
        [event.version, event.stream_id]
      );
      break;
  }
}
```

### CQRS — Command Query Responsibility Segregation

CQRS separates the write model (commands that change state) from the read model (queries that return data). In a traditional application, the same database tables serve both writes and reads. In CQRS:

- **Write side**: Receives commands, validates business rules, appends events to the event store
- **Read side**: Consumes events, maintains denormalized projections optimized for specific queries

```
                  ┌─────────────────┐
Command ─────────>│   Write Model   │──── Events ────>  Event Store
                  │ (business rules) │                      │
                  └─────────────────┘                      │
                                                            │ (subscribe)
                                                            ▼
                  ┌─────────────────┐              ┌──────────────┐
Query ───────────>│   Read Model    │<─── update ──│  Projector   │
                  │  (projections)  │              └──────────────┘
                  └─────────────────┘
```

The read model can have multiple projections optimized for different queries:
- A `user_list_projection` optimized for listing users with pagination
- A `user_detail_projection` with all nested data for a single user view
- A `user_analytics_projection` with aggregated statistics

Each projection is a separate table (or even a separate database) that's rebuilt from the event log.

### When This Architecture Is Justified

**Audit-heavy domains:** Financial systems, healthcare, legal — where you must know exactly what happened and when. Events are the audit log by construction.

**Complex business logic:** When the business rules for writing data are fundamentally different from the query patterns for reading data. Example: an order system where placing an order involves inventory checks, payment processing, and fulfillment routing (complex write), but viewing order history is a simple list query (simple read).

**Temporal queries:** "What was the state of this account on March 15th?" With event sourcing, replay events up to that date. With traditional storage, you'd need a separate auditing system.

**Rebuilding read models:** When you add a new feature that needs a new query pattern, you can replay all historical events to build a new projection without data loss.

### When It's Overkill

**Most CRUD applications.** If your application is "form saves data, page displays data," event sourcing adds massive complexity for no benefit. A simple PostgreSQL table with an `updated_at` column and maybe an audit trigger is sufficient.

**Small teams.** Event sourcing requires maintaining the event store, projection handlers, and consistency between them. For a team of 2–3 developers, this overhead is not worth it.

**When consistency matters more than history.** Event sourcing introduces eventual consistency between the write model and read model (the projection handler hasn't processed the latest event yet). In many applications, users expect to see their changes immediately.

### Implementing Basic Event Sourcing with PostgreSQL

Here's a minimal but functional event-sourcing implementation using PostgreSQL:

```typescript
// src/event-store.ts
import { Pool, PoolClient } from 'pg';

interface Event {
  streamId: string;
  eventType: string;
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

interface StoredEvent extends Event {
  id: number;
  version: number;
  createdAt: Date;
}

class EventStore {
  constructor(private pool: Pool) {}

  async appendEvents(
    streamId: string,
    events: Omit<Event, 'streamId'>[],
    expectedVersion: number,
  ): Promise<StoredEvent[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Optimistic concurrency check
      const { rows } = await client.query(
        'SELECT MAX(version) AS current_version FROM events WHERE stream_id = $1',
        [streamId]
      );
      const currentVersion = rows[0].current_version ?? 0;

      if (currentVersion !== expectedVersion) {
        throw new ConcurrencyError(
          `Expected version ${expectedVersion}, but current version is ${currentVersion}`
        );
      }

      const stored: StoredEvent[] = [];
      for (let i = 0; i < events.length; i++) {
        const version = expectedVersion + i + 1;
        const event = events[i];
        const { rows: [row] } = await client.query(
          `INSERT INTO events (stream_id, event_type, data, metadata, version)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, stream_id, event_type, data, metadata, version, created_at`,
          [streamId, event.eventType, event.data, event.metadata || {}, version]
        );
        stored.push({
          id: row.id,
          streamId: row.stream_id,
          eventType: row.event_type,
          data: row.data,
          metadata: row.metadata,
          version: row.version,
          createdAt: row.created_at,
        });
      }

      // Notify listeners via PG NOTIFY
      await client.query(
        "SELECT pg_notify('new_events', $1)",
        [JSON.stringify({ streamId, fromVersion: expectedVersion + 1 })]
      );

      await client.query('COMMIT');
      return stored;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getEvents(streamId: string, fromVersion = 0): Promise<StoredEvent[]> {
    const { rows } = await this.pool.query(
      `SELECT id, stream_id, event_type, data, metadata, version, created_at
       FROM events
       WHERE stream_id = $1 AND version > $2
       ORDER BY version`,
      [streamId, fromVersion]
    );
    return rows.map((row) => ({
      id: row.id,
      streamId: row.stream_id,
      eventType: row.event_type,
      data: row.data,
      metadata: row.metadata,
      version: row.version,
      createdAt: row.created_at,
    }));
  }

  async getAllEvents(fromId = 0, limit = 1000): Promise<StoredEvent[]> {
    const { rows } = await this.pool.query(
      `SELECT id, stream_id, event_type, data, metadata, version, created_at
       FROM events
       WHERE id > $1
       ORDER BY id
       LIMIT $2`,
      [fromId, limit]
    );
    return rows.map((row) => ({
      id: row.id,
      streamId: row.stream_id,
      eventType: row.event_type,
      data: row.data,
      metadata: row.metadata,
      version: row.version,
      createdAt: row.created_at,
    }));
  }
}

class ConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrencyError';
  }
}
```

```typescript
// Usage: Order aggregate
class OrderAggregate {
  private state: OrderState = { status: 'new', items: [], total: 0 };
  private version = 0;

  constructor(private streamId: string) {}

  static async load(eventStore: EventStore, orderId: string): Promise<OrderAggregate> {
    const agg = new OrderAggregate(`order-${orderId}`);
    const events = await eventStore.getEvents(agg.streamId);
    for (const event of events) {
      agg.apply(event);
      agg.version = event.version;
    }
    return agg;
  }

  private apply(event: StoredEvent): void {
    switch (event.eventType) {
      case 'OrderCreated':
        this.state = { ...this.state, status: 'created', customerId: event.data.customerId as string };
        break;
      case 'ItemAdded':
        this.state.items.push(event.data.item as OrderItem);
        this.state.total += (event.data.item as OrderItem).price;
        break;
      case 'OrderConfirmed':
        this.state.status = 'confirmed';
        break;
    }
  }

  addItem(item: OrderItem): Omit<Event, 'streamId'>[] {
    if (this.state.status !== 'created') {
      throw new Error('Cannot add items to a confirmed order');
    }
    return [{ eventType: 'ItemAdded', data: { item } }];
  }

  confirm(): Omit<Event, 'streamId'>[] {
    if (this.state.items.length === 0) {
      throw new Error('Cannot confirm an empty order');
    }
    return [{ eventType: 'OrderConfirmed', data: {} }];
  }

  getState(): OrderState { return { ...this.state }; }
  getVersion(): number { return this.version; }
  getStreamId(): string { return this.streamId; }
}

// In your API handler
async function addItemToOrder(orderId: string, item: OrderItem) {
  const order = await OrderAggregate.load(eventStore, orderId);
  const events = order.addItem(item);
  await eventStore.appendEvents(order.getStreamId(), events, order.getVersion());
}
```

> **What a senior engineer actually thinks about**
>
> Event sourcing is one of those patterns where the blog posts make it sound elegant and the implementation is a slog. The 80% case — simple CRUD — doesn't benefit from it. But for the 20% of systems where audit trails, temporal queries, and complex business logic intersect (banking, logistics, insurance), it's the right architecture. My advice: start with a traditional approach. If you keep building workarounds for audit logging, undo functionality, or historical state queries, that's your signal to consider event sourcing — for that specific domain, not the entire application.

---

## 10.9 Search Engines (Elasticsearch, Typesense, Meilisearch)

### When PostgreSQL Full-Text Search Isn't Enough

PostgreSQL's full-text search is surprisingly capable. With `tsvector`, `tsquery`, GIN indexes, and `ts_rank`, you can build a search feature that handles:
- Stemming (searching "running" matches "run", "runs", "runner")
- Ranking by relevance
- Phrase search
- Multiple languages
- Partial matching with trigram indexes (`pg_trgm`)

For a documentation site, blog, e-commerce store with < 5 million documents, and standard search requirements, PG full-text search is often sufficient.

**Where PG falls short:**

**Faceted search:** "Show me laptops under $1000 with 16GB+ RAM, grouped by brand with count per brand." This requires combining full-text search with aggregated filtering. In Elasticsearch, this is a single query with facet aggregations. In PostgreSQL, you'd need complex CTEs or multiple queries.

**Fuzzy matching at scale:** Searching "postgrsql" should match "postgresql." PG's `pg_trgm` extension handles this, but at scale (50M+ documents), the trigram index becomes large and query performance degrades. Elasticsearch's fuzzy matching is designed for this scale.

**Relevance tuning:** Boosting matches in the title more than the body, personalized ranking per user, synonym expansion, "did you mean?" suggestions. PG supports basic weighting (A, B, C, D categories), but search engines provide fine-grained relevance scoring.

**Geo-search combined with text search:** "Pizza restaurants within 5 miles, sorted by relevance." This combines geographic filtering with text search in a single query. PG can do both separately (PostGIS + tsvector), but combining them efficiently is non-trivial.

**High-throughput search across many fields:** When documents have 50+ searchable fields and queries combine text search with filtering across multiple facets, search engines handle the multi-index merge more efficiently.

### How Inverted Indexes Work Differently

Both PostgreSQL GIN indexes and Elasticsearch use inverted indexes, but their implementations differ:

**PostgreSQL GIN (Generalized Inverted Index):**
- Stores a posting list: for each term, a sorted list of row IDs (ctids) that contain the term
- Updated synchronously with the table (no stale results)
- Lives alongside the heap (same MVCC visibility rules)
- One index per tsvector column

**Elasticsearch inverted index:**
- Also stores posting lists, but with additional data: term frequency, position, offset
- Organized into segments (immutable files), periodically merged
- Includes field-level norms (for relevance scoring), doc values (for sorting/aggregation), and stored fields
- Near-real-time: writes are visible after a configurable refresh interval (default 1 second)

The key difference: Elasticsearch's index carries much more metadata per term, enabling sophisticated relevance scoring without touching the source data. PG's GIN is simpler but requires hitting the heap for anything beyond "does this document match?"

### The Operational Cost

Running Elasticsearch in production is a significant operational commitment:

- **Cluster management**: Minimum 3 nodes for production (master-eligible nodes, data nodes, coordinating nodes)
- **Memory**: Elasticsearch needs 50% of available RAM for the JVM heap and 50% for the OS file cache
- **Index management**: Manually manage index lifecycle (create, optimize, delete old indexes)
- **Monitoring**: Cluster health, shard allocation, garbage collection pauses, search latency
- **Upgrades**: Major version upgrades often require reindexing
- **Cost**: A 3-node Elasticsearch cluster costs $500–2000+/month on cloud providers

### Lighter Alternatives

**Typesense:**
- Written in C++, single binary, simple to deploy
- Typo tolerance, faceting, geo-search built-in
- Much simpler operations than Elasticsearch
- Good for: e-commerce search, application search, under 100M documents
- Limitation: less flexible than Elasticsearch for complex analytics

**Meilisearch:**
- Written in Rust, single binary, sub-50ms search by design
- Excellent developer experience (simple API, minimal configuration)
- Built-in typo tolerance, faceting, filters
- Good for: user-facing search, documentation search, small-medium datasets
- Limitation: not designed for analytics or log search

**The decision ladder:**

```
Do you need search?
  ├── Simple text matching → PostgreSQL LIKE/ILIKE + trigram index
  ├── Full-text search < 5M docs → PostgreSQL tsvector + GIN
  ├── Full-text + facets + typo tolerance → Typesense or Meilisearch
  ├── Complex analytics + search → Elasticsearch (or OpenSearch)
  └── Log/event search at scale → Elasticsearch (or Loki/ClickHouse)
```

> **What a senior engineer actually thinks about**
>
> I use PostgreSQL full-text search as the default and only add a dedicated search engine when PG demonstrably can't handle the query patterns. The moment you add Elasticsearch, you're managing index consistency (keeping ES in sync with PG), a separate cluster, and the JVM. For most applications, `pg_trgm` + `tsvector` handles the search bar just fine. When I do need dedicated search, I reach for Typesense over Elasticsearch unless I specifically need Elasticsearch's analytics capabilities. The operational simplicity of a single binary vs a JVM cluster is worth a lot.

---

## 10.10 Message Queues and Streaming (Kafka, RabbitMQ, SQS)

### Why You Can't Use PostgreSQL as a Message Queue at Scale

It's tempting to use a database table as a queue:

```sql
CREATE TABLE job_queue (
  id BIGSERIAL PRIMARY KEY,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  completed_at TIMESTAMPTZ
);

-- Worker picks up a job
UPDATE job_queue
SET status = 'processing', locked_at = NOW(), locked_by = 'worker-1'
WHERE id = (
  SELECT id FROM job_queue
  WHERE status = 'pending'
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING *;
```

This actually works fine at small scale (< 1,000 messages/minute). The `FOR UPDATE SKIP LOCKED` (PG 9.5+) pattern is elegant — it atomically locks a row while skipping already-locked rows, preventing workers from processing the same message.

**Where it breaks down:**

1. **Polling overhead**: Workers must continuously poll the table (`SELECT ... LIMIT 1`). With 10 workers polling every 100ms, that's 100 queries/second doing nothing useful when the queue is empty. You can mitigate this with `LISTEN/NOTIFY`, but it adds complexity.

2. **Row lock contention**: Under high throughput, multiple workers compete for `FOR UPDATE` locks on the same rows. The lock manager becomes a bottleneck.

3. **Table bloat**: Completed jobs create dead tuples. With millions of jobs per day, VACUUM struggles to keep up. The table grows, sequential scans slow down, and index performance degrades.

4. **No built-in message guarantees**: You must implement retry logic, dead-letter queues, delayed delivery, and exactly-once processing in application code.

5. **No consumer groups**: There's no built-in way for multiple consumers to independently process the same stream of messages (like Kafka consumer groups).

### What Kafka Provides

Apache Kafka is a distributed streaming platform. Its core abstraction is the **log** — an append-only, ordered, persistent sequence of records partitioned across multiple brokers.

**Key concepts (mapped to frontend analogies):**

- **Topic**: Like an event bus category (e.g., "order-events", "user-events")
- **Partition**: A topic is split into partitions for parallelism. Each partition is an independent log. Think of it like sharding — messages with the same key always go to the same partition (ordering within a key is guaranteed).
- **Producer**: Writes messages to topics (like `dispatchEvent()`)
- **Consumer Group**: A set of consumers that cooperatively read from a topic. Each partition is assigned to exactly one consumer in the group. If you have 6 partitions and 3 consumers, each consumer reads 2 partitions.
- **Offset**: Each message has a position number in its partition. Consumers track their offset (where they've read up to). They can replay from any offset.

**Why Kafka is different from a database queue:**

| Property | PG Table Queue | Kafka |
|---|---|---|
| **Delivery** | Pull (polling) | Push + pull (consumer fetches, but can long-poll) |
| **Message retention** | Delete after processing | Retained for configurable time (days/weeks) |
| **Replay** | Not possible (deleted) | Reset offset to any point in time |
| **Throughput** | ~10K/s per partition | ~100K–1M/s per partition |
| **Consumer groups** | Application-level | Built-in |
| **Ordering** | Global (single table) | Per-partition |
| **Exactly-once** | Application-level | Exactly-once semantics (Kafka Streams) |

**When Kafka makes sense:**
- Event-driven microservices (services communicate via events)
- High-throughput event streaming (> 10K events/second)
- Event replay needed (rebuild a service's state from events)
- Multiple consumers need the same events (fan-out)
- Data pipeline (ingesting data into analytics, data lakes)

**When Kafka is overkill:**
- Simple background job processing (use a job queue like BullMQ + Redis)
- < 1,000 messages/minute (PG SKIP LOCKED works fine)
- Simple request/response patterns (use HTTP or gRPC)

### When PG LISTEN/NOTIFY + SKIP LOCKED Is Good Enough

For moderate workloads, PostgreSQL's built-in capabilities handle queuing well:

```typescript
import { Pool, Client } from 'pg';

// Producer: insert job and notify
async function enqueueJob(pool: Pool, payload: Record<string, unknown>) {
  await pool.query(
    `INSERT INTO job_queue (payload) VALUES ($1)`,
    [payload]
  );
  await pool.query("NOTIFY new_job");
}

// Consumer: listen for notifications, process with SKIP LOCKED
async function startWorker(pool: Pool, workerId: string) {
  // Dedicated connection for LISTEN (can't use pool for this)
  const listener = new Client({ connectionString: process.env.DATABASE_URL });
  await listener.connect();
  await listener.query('LISTEN new_job');

  listener.on('notification', async () => {
    await processNextJob(pool, workerId);
  });

  // Also poll periodically (in case NOTIFY was missed during reconnection)
  setInterval(() => processNextJob(pool, workerId), 5000);
}

async function processNextJob(pool: Pool, workerId: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      UPDATE job_queue
      SET status = 'processing', locked_at = NOW(), locked_by = $1
      WHERE id = (
        SELECT id FROM job_queue
        WHERE status = 'pending'
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING *
    `, [workerId]);

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return; // no pending jobs
    }

    const job = rows[0];
    try {
      await handleJob(job); // your business logic
      await client.query(
        "UPDATE job_queue SET status = 'completed', completed_at = NOW() WHERE id = $1",
        [job.id]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query(
        "UPDATE job_queue SET status = 'failed' WHERE id = $1",
        [job.id]
      );
      await client.query('COMMIT');
    }
  } finally {
    client.release();
  }
}
```

This works well for:
- Background email sending
- Webhook delivery
- Report generation
- Any workload under ~5,000 jobs/minute

### The Outbox Pattern

The outbox pattern solves a critical problem: how to reliably publish events from PostgreSQL to an external system (Kafka, RabbitMQ, webhooks) without losing events or publishing duplicates.

**The problem:**

```typescript
// BROKEN — not atomic
await pool.query('INSERT INTO orders (customer_id, total) VALUES ($1, $2)', [customerId, total]);
await kafka.send({ topic: 'order-events', messages: [{ value: JSON.stringify(order) }] });
// What if the Kafka send fails? The order exists but no event was published.
// What if the app crashes between the two lines? Same problem.
```

**The solution — outbox table:**

```sql
CREATE TABLE outbox (
  id          BIGSERIAL PRIMARY KEY,
  aggregate_type TEXT NOT NULL,     -- 'Order', 'User', etc.
  aggregate_id   TEXT NOT NULL,     -- the entity ID
  event_type  TEXT NOT NULL,         -- 'OrderPlaced', 'OrderShipped'
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ          -- NULL until published
);

CREATE INDEX idx_outbox_unpublished ON outbox (created_at)
  WHERE published_at IS NULL;
```

```typescript
// CORRECT — atomic: insert order AND outbox event in same transaction
async function placeOrder(customerId: number, items: OrderItem[]) {
  return withTransaction(pool, async (client) => {
    const { rows: [order] } = await client.query(
      'INSERT INTO orders (customer_id, total, status) VALUES ($1, $2, $3) RETURNING *',
      [customerId, calculateTotal(items), 'placed']
    );

    // Insert event into outbox in the SAME transaction
    await client.query(
      `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('Order', $1, 'OrderPlaced', $2)`,
      [order.id.toString(), JSON.stringify({ orderId: order.id, customerId, items, total: order.total })]
    );

    return order;
  });
}

// Separate publisher process reads the outbox and publishes to Kafka
async function publishOutboxEvents() {
  const { rows: events } = await pool.query(`
    SELECT * FROM outbox
    WHERE published_at IS NULL
    ORDER BY created_at
    LIMIT 100
    FOR UPDATE SKIP LOCKED
  `);

  for (const event of events) {
    try {
      await kafka.send({
        topic: `${event.aggregate_type.toLowerCase()}-events`,
        messages: [{
          key: event.aggregate_id,
          value: JSON.stringify(event.payload),
        }],
      });

      await pool.query(
        'UPDATE outbox SET published_at = NOW() WHERE id = $1',
        [event.id]
      );
    } catch (err) {
      console.error(`Failed to publish event ${event.id}:`, err);
      break; // stop on failure, retry on next poll
    }
  }
}

// Run the publisher on an interval
setInterval(publishOutboxEvents, 1000);
```

The key insight: because the order INSERT and the outbox INSERT are in the same transaction, they either both succeed or both fail. The publisher is a separate process that can retry indefinitely until the event is published. This gives you **at-least-once** delivery.

For **exactly-once** delivery, consumers must be idempotent (processing the same event twice produces the same result) or use deduplication.

> **What a senior engineer actually thinks about**
>
> The outbox pattern is the most important pattern for systems that need to coordinate between a database and an external system. I use it everywhere — for Kafka publishing, webhook delivery, email sending, anything that needs "if this database write happened, then this side effect must also happen." It's simpler than two-phase commit, more reliable than "just publish to Kafka and hope," and it works with any message broker. The implementation is 50 lines of code and saves you from an entire class of data consistency bugs.

---

## 10.11 The Polyglot Persistence Decision Framework

"Polyglot persistence" means using different database technologies for different parts of your system. It sounds sophisticated, but every additional database comes with costs that are often underestimated.

### The Cost of Each Additional Database

When you add a new database to your architecture, you take on:

**1. Operational complexity:**
- Separate backup and restore procedures
- Separate monitoring and alerting
- Separate upgrade processes
- Separate security configuration (users, network rules, encryption)
- On-call engineers need to understand failure modes of each system

**2. Data consistency challenges:**
- Data exists in two places — which is the source of truth?
- How do you handle the case where one write succeeds and the other fails?
- How do you detect and fix data drift between systems?

**3. Team knowledge requirements:**
- Every engineer needs to understand (or have access to someone who understands) each database
- Debugging production issues requires different tools and mental models for each system
- Hiring becomes harder (finding someone who knows PostgreSQL AND Redis AND Elasticsearch AND Kafka)

**4. Infrastructure cost:**
- Each database needs its own servers/instances
- High availability requires replication for each database
- Network costs for inter-database communication

### The "Start with Postgres" Strategy

Here's the strategy I recommend for every new project:

**Phase 1: PostgreSQL only.**

Use PostgreSQL for everything:
- Relational data → tables
- Semi-structured data → JSONB columns
- Full-text search → tsvector + GIN indexes
- Caching → materialized views (or no caching — PG is fast)
- Background jobs → SKIP LOCKED queue pattern
- Time-series data → partitioned tables
- Session storage → table with TTL cleanup

This gets you surprisingly far. Most applications never need to leave this phase.

**Phase 2: Add Redis.** (When you need it)

Trigger: your application needs sub-millisecond reads (caching), real-time features (presence, pub/sub), or distributed locking. Usually happens at medium scale.

Redis is the lowest-risk addition because:
- It's operationally simple (single process, simple config)
- It's well-understood (massive community, excellent documentation)
- It enhances PG rather than replacing it (PG remains source of truth)
- Failure is graceful (if Redis dies, you fall back to PG — slower but correct)

**Phase 3: Add specialized stores.** (When you've measured the need)

Trigger: a specific workload demonstrably exceeds PG's capabilities, confirmed by benchmarks on production-scale data.

```
Workload                      → Add
Analytics on 100M+ rows       → ClickHouse, BigQuery, or DuckDB
Full-text search + faceting   → Typesense, Meilisearch, or Elasticsearch
Event streaming               → Kafka (or Redis Streams for simpler needs)
Time-series at extreme scale  → TimescaleDB extension (still PG!) or InfluxDB
Global write distribution     → CockroachDB, YugabyteDB
```

### The Decision Checklist

Before adding a new database, ask yourself:

```
□ Have I measured that PostgreSQL cannot handle this workload?
  (Not "I think it might be slow" — actual measurements with production-scale data)

□ Can a PostgreSQL extension solve this?
  (TimescaleDB for time-series, PostGIS for geo, pg_trgm for fuzzy search)

□ Can I solve this with better PostgreSQL configuration?
  (More memory, better indexes, connection pooling, read replicas)

□ Who will operate this new database?
  (Backups, monitoring, upgrades, security, on-call)

□ How will I keep data consistent between systems?
  (Outbox pattern? CDC? Accept eventual consistency?)

□ Does my team have the expertise?
  (Or am I adding learning curve during a critical project phase?)

□ What's the blast radius if this database has an incident?
  (Can the application degrade gracefully?)
```

If the answers to the first three are all "yes, I genuinely need this," proceed. Otherwise, invest that engineering effort into making PostgreSQL work better.

### A Realistic Architecture Progression

**Year 1 (startup):**
```
Client → API → PostgreSQL
```
One database. Everything in PG. Simple. Fast to develop.

**Year 2 (growing):**
```
Client → API → PostgreSQL (primary + read replica)
                → Redis (sessions, caching)
```
Added Redis for caching hot queries and session storage. Read replica for reporting queries.

**Year 3 (scaling):**
```
Client → API → PostgreSQL (primary + 2 read replicas)
                → Redis Cluster (sessions, caching, rate limiting)
                → Typesense (product search)
                → Kafka → ClickHouse (analytics pipeline)
```
Added dedicated search for the product catalog (PG tsvector couldn't handle the faceted search UX the product team wanted). Added Kafka + ClickHouse for analytics (BI team's queries were causing replica lag).

**Year 5+ (scale):**

```
Client → API → PostgreSQL (sharded via Citus, or CockroachDB)
                → Redis Cluster
                → Elasticsearch (search + log analytics)
                → Kafka (event backbone)
                → ClickHouse (analytics)
                → TimescaleDB (infrastructure metrics)
```

Note that each addition was driven by a measured need, not speculation.

> **What a senior engineer actually thinks about**
>
> The best database architecture is the simplest one that meets your requirements. I've seen a 3-person startup running PostgreSQL, Redis, MongoDB, Elasticsearch, and RabbitMQ — spending more time on infrastructure than features. I've also seen a 500-person company running almost everything on PostgreSQL (with read replicas and Citus for sharding), adding Redis for caching and ClickHouse for analytics. The second company shipped faster and had fewer incidents. Every database you add is a decision you'll maintain for years. Make each one count.

---

## 10.12 Things That Will Bite You in Production

### 1. Cache invalidation inconsistency

**What happens:** User updates their profile. The API updates PostgreSQL. The cache invalidation call to Redis fails (network blip). For the next 5 minutes (until TTL expires), every read returns stale data.

**Why:** Updating two systems atomically is fundamentally hard. The database write and cache invalidation are not in the same transaction.

**Prevention:** Use short TTLs as your safety net. Implement "read-through" caching where a cache miss always hits the database. For critical data, skip the cache entirely. Accept that caches are eventually consistent by design.

### 2. Elasticsearch index out of sync with PostgreSQL

**What happens:** A product's price is updated in PostgreSQL but the Elasticsearch index still shows the old price. Customers see one price in search results and a different price on the product page.

**Why:** PG → ES sync is asynchronous. The sync process crashed, hit a rate limit, or fell behind.

**Prevention:** Use the outbox pattern. Monitor the sync lag. Display a warning on search results ("prices may not be up to date") or always fetch the price from PG on the product page. Implement a reconciliation job that periodically compares PG and ES data.

### 3. Redis memory exhaustion

**What happens:** Redis runs out of memory. Depending on configuration, it either starts evicting keys (data loss), rejects all writes (application errors), or crashes.

**Why:** No maxmemory limit set, or the application caches too aggressively without TTLs.

**Prevention:** Always set `maxmemory` and `maxmemory-policy` (usually `allkeys-lru` — evict least recently used keys when full). Always set TTLs on cache entries. Monitor Redis memory usage and alert at 70%.

### 4. Kafka consumer lag causing stale read models

**What happens:** In a CQRS/event-sourcing system, the event consumer falls behind. Users see outdated data because the read model hasn't been updated with recent events.

**Why:** Consumer crashed and restarted, processing is slower than production rate, or a deployment introduced a bug that slowed consumption.

**Prevention:** Monitor consumer lag (the difference between the latest produced offset and the consumer's current offset). Alert when lag exceeds your tolerance (e.g., > 1000 messages or > 30 seconds behind). Design the UI to show "last updated" timestamps on data that might be stale.

### 5. Distributed transaction failures across databases

**What happens:** The API writes an order to PostgreSQL and debits the user's wallet in a separate Redis-backed service. The PG write succeeds, the Redis write fails. Now the order exists but wasn't paid for.

**Why:** There's no distributed transaction spanning PG and Redis. Two-phase commit across heterogeneous databases is impractical.

**Prevention:** Use the Saga pattern: each step has a compensating action. If the wallet debit fails, the saga runs a compensating action to cancel the order in PG. Or use the outbox pattern: write the order and a "debit wallet" event to PG in one transaction, then process the debit asynchronously with retry.

### 6. Running analytics queries on the OLTP database

**What happens:** The data team runs a complex report that scans 50 million rows. It takes 3 minutes and uses 100% of the database's I/O. Meanwhile, user-facing queries that normally take 2ms now take 2 seconds. The application appears slow.

**Why:** Analytics queries (OLAP) compete for the same resources as transaction queries (OLTP). A full table scan evicts cached pages that the OLTP queries depend on.

**Prevention:** Run analytics on a read replica (set `hot_standby_feedback = on` to prevent vacuum conflicts). Better yet, replicate to a column store (ClickHouse, BigQuery) and run analytics there. At minimum, set `statement_timeout` on the OLTP database to kill runaway queries.

### 7. Not understanding Redis persistence tradeoffs

**What happens:** Redis is used as the primary store for user sessions. Redis restarts after an OOM kill. With RDB-only persistence, all sessions created in the last 5 minutes are lost. 10,000 users are logged out simultaneously.

**Why:** RDB snapshots only save state periodically. Data between snapshots is lost on restart.

**Prevention:** Enable AOF with `appendfsync everysec` for data that matters. Better yet, don't use Redis as the sole store for important data — use it as a cache backed by PG. For sessions specifically, consider storing session data in PG (with Redis as a fast lookup cache).

### 8. PgBouncer in transaction mode breaking prepared statements

**What happens:** You add PgBouncer to handle connection pooling. Everything works in development. In production, you get sporadic errors: `prepared statement "X" does not exist`.

**Why:** Transaction mode means different requests from the same application connection may go to different PG connections. A prepared statement created on connection A doesn't exist on connection B.

**Prevention:** Use PgBouncer 1.21+ with `prepared_statement` mode. Or disable named prepared statements in your driver (`prepare: false` in postgres.js). Or use session mode (less efficient but compatible).

### 9. Choosing MongoDB for a relational workload

**What happens:** The application grows, and features require joining data across collections. The team implements application-level joins (multiple queries), the aggregation pipeline for complex reports, and reference resolution in the backend. Code complexity explodes. Performance degrades because every "join" is multiple round trips.

**Why:** The initial decision to use MongoDB was based on "schema flexibility" for a workload that was actually relational (users have orders, orders have items, items belong to categories).

**Prevention:** Evaluate your data model honestly. If entities reference each other and you'll need to query across them, use a relational database. MongoDB's strengths (nested documents, schema flexibility) are real but narrow. Most web applications are relational.

### 10. Premature polyglot persistence

**What happens:** A small team is running 5 different data stores. Each one needs monitoring, backups, security updates, and expertise. An incident in Elasticsearch takes 6 hours to resolve because only one engineer (who's on vacation) knows how to manage it. Meanwhile, the PostgreSQL database — which handles 95% of the workload — is neglected because the team is spread thin.

**Why:** Each database was added because it seemed like the "right tool for the job" without weighing the operational cost. The team optimized for theoretical correctness instead of practical maintainability.

**Prevention:** Apply the decision checklist from section 10.11. Every new database must justify its operational cost. The "right tool for the job" is the simplest tool your team can operate reliably. A PostgreSQL instance that's well-monitored and well-understood beats a constellation of specialized databases that nobody fully understands.
