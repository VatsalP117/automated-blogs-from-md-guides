# Chapter 9 — Using PostgreSQL from Application Code

## Table of Contents

- [9.1 Connection Management in Node.js](#91-connection-management-in-nodejs)
  - [The pg (node-postgres) Library](#the-pg-node-postgres-library)
  - [Pool vs Client](#pool-vs-client)
  - [Pool Configuration for Production](#pool-configuration-for-production)
  - [Query Methods and Parameterized Queries](#query-methods-and-parameterized-queries)
  - [Handling Connection Errors and Event Listeners](#handling-connection-errors-and-event-listeners)
  - [The postgres.js Library](#the-postgresjs-library)
- [9.2 Prepared Statements](#92-prepared-statements)
  - [How Prepared Statements Work in PG's Protocol](#how-prepared-statements-work-in-pgs-protocol)
  - [Why They Prevent SQL Injection](#why-they-prevent-sql-injection)
  - [Named vs Unnamed Prepared Statements](#named-vs-unnamed-prepared-statements)
  - [The PgBouncer Problem](#the-pgbouncer-problem)
- [9.3 ORM Tradeoffs](#93-orm-tradeoffs)
  - [Prisma](#prisma)
  - [Drizzle ORM](#drizzle-orm)
  - [When Raw SQL Is the Correct Choice](#when-raw-sql-is-the-correct-choice)
  - [Honest Comparison Table](#honest-comparison-table)
- [9.4 Migration Tooling](#94-migration-tooling)
  - [How to Structure Migrations in a Real Codebase](#how-to-structure-migrations-in-a-real-codebase)
  - [Migration Tools Compared](#migration-tools-compared)
  - [Migration Best Practices](#migration-best-practices)
- [9.5 Handling Database Errors in Application Code](#95-handling-database-errors-in-application-code)
  - [PostgreSQL Error Codes You Must Know](#postgresql-error-codes-you-must-know)
  - [Parsing Error Objects in node-postgres](#parsing-error-objects-in-node-postgres)
  - [Building Error Handling Middleware](#building-error-handling-middleware)
  - [Retrying on Serialization Failures](#retrying-on-serialization-failures)
- [9.6 Transaction Management Patterns in Application Code](#96-transaction-management-patterns-in-application-code)
  - [Using BEGIN/COMMIT/ROLLBACK with node-postgres](#using-begincommitrollback-with-node-postgres)
  - [Transaction Helper Implementation](#transaction-helper-implementation)
  - [Nested Transactions with Savepoints](#nested-transactions-with-savepoints)
  - [Avoiding Connection Leaks](#avoiding-connection-leaks)
- [9.7 Testing Strategies](#97-testing-strategies)
  - [Test Database Setup](#test-database-setup)
  - [Transaction Rollback per Test](#transaction-rollback-per-test)
  - [Seeding Data: Factories vs Fixtures](#seeding-data-factories-vs-fixtures)
  - [Using testcontainers-node](#using-testcontainers-node)
  - [Complete Test Setup with Vitest + node-postgres](#complete-test-setup-with-vitest--node-postgres)
- [9.8 Security in Application Code](#98-security-in-application-code)
  - [SQL Injection Prevention](#sql-injection-prevention)
  - [Connection String Security](#connection-string-security)
  - [SSL/TLS Connections](#ssltls-connections)
  - [Principle of Least Privilege](#principle-of-least-privilege)
  - [pg_hba.conf Basics](#pg_hbaconf-basics)
- [9.9 Things That Will Bite You in Production](#99-things-that-will-bite-you-in-production)

---

## 9.1 Connection Management in Node.js

If you've built frontend applications, you're used to making HTTP requests — each request opens a connection, gets a response, and the connection closes (or is reused via keep-alive). Database connections are fundamentally different: they are **expensive, stateful, long-lived resources** that you must manage carefully.

Every PostgreSQL connection spawns a dedicated operating system process on the server (not a thread — a full process). On a typical server, you might support 100–300 concurrent connections before the OS starts thrashing on context switching. If your Node.js application creates a new connection for every database query, you'll exhaust the server in seconds under load.

This is why connection pooling exists, and why understanding it is the single most important thing about using PostgreSQL from application code.

### The pg (node-postgres) Library

The `pg` library (npm package `pg`) is the foundational PostgreSQL driver for Node.js. Almost every ORM and higher-level tool builds on top of it. Understanding `pg` means understanding what's actually happening when any Node.js library talks to PostgreSQL.

Install it:

```bash
npm install pg
npm install -D @types/pg  # if using TypeScript
```

The library provides two primary interfaces: `Client` and `Pool`.

### Pool vs Client

**Client** is a single database connection. You connect, run queries, and disconnect:

```typescript
import { Client } from 'pg';

const client = new Client({
  host: 'localhost',
  port: 5432,
  database: 'myapp',
  user: 'myapp_user',
  password: process.env.DB_PASSWORD,
});

await client.connect();
const result = await client.query('SELECT NOW()');
console.log(result.rows[0]);
await client.end();
```

This is fine for scripts, migrations, or CLI tools. It is **not** what you use in a web server.

**Pool** manages a set of Client connections internally. When you call `pool.query()`, it checks out a client from the pool, runs the query, and returns the client to the pool. Think of it like a connection-level equivalent of a thread pool — or if you're used to frontend concepts, it's like an HTTP agent that maintains a pool of keep-alive sockets.

```typescript
import { Pool } from 'pg';

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'myapp',
  user: 'myapp_user',
  password: process.env.DB_PASSWORD,
  max: 20,
});

// This checks out a client, runs the query, and returns the client
const result = await pool.query('SELECT * FROM users WHERE id = $1', [42]);
console.log(result.rows[0]);
```

The pool handles all the complexity: creating connections on demand, keeping them alive, reusing them, destroying broken ones, and queuing requests when all connections are busy.

### Pool Configuration for Production

Here is a real production pool configuration with every option explained:

```typescript
import { Pool, PoolConfig } from 'pg';

const poolConfig: PoolConfig = {
  // Connection parameters
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,

  // Pool sizing
  max: parseInt(process.env.DB_POOL_MAX || '20', 10),
  min: parseInt(process.env.DB_POOL_MIN || '5', 10),

  // Timeout configuration
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,

  // PG 14+ keepalive (prevents connections from being killed by
  // load balancers or firewalls that drop idle TCP connections)
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,

  // Allow the Node.js process to exit even if pool connections
  // are still idle. Without this, your process hangs on shutdown.
  allowExitOnIdle: true,

  // SSL for production (cloud-hosted databases require this)
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: true, ca: process.env.DB_CA_CERT }
    : false,

  // Custom type parsing (override how PG types map to JS)
  // Example: parse BIGINT (int8) as number instead of string
  types: {
    getTypeParser(oid, format) {
      if (oid === 20) { // int8 (BIGINT)
        return (val: string) => parseInt(val, 10);
      }
      return undefined as any; // use default parser
    },
  },

  // Statement timeout per query (safety net)
  statement_timeout: 30_000, // 30 seconds
};

const pool = new Pool(poolConfig);

export default pool;
```

Let's break down the critical settings:

**`max` (default: 10)** — The maximum number of connections in the pool. This is the most important setting. A common mistake is setting this too high. If you have 10 Node.js instances each with `max: 50`, that's 500 connections to your database. PG's default `max_connections` is 100. You will get `FATAL: too many connections` errors.

The formula: `max = (PG max_connections - superuser_reserved_connections) / number_of_app_instances`. For most applications, 10–30 per instance is plenty.

**`idleTimeoutMillis` (default: 10000)** — How long a client can sit idle in the pool before being closed. Setting this too low causes connection churn (constantly creating/destroying connections). Setting it too high wastes resources. 30 seconds is a solid default.

**`connectionTimeoutMillis` (default: 0 = no timeout)** — How long to wait for a connection from the pool before throwing an error. With the default of 0, if all connections are busy and `max` is reached, your request hangs forever. **Always set this in production.** 5 seconds is reasonable — if you're waiting longer than that, something is already wrong.

**`allowExitOnIdle` (default: false)** — Without this, `pool.end()` must be called explicitly or your Node.js process will never exit. Setting this to `true` lets the process exit cleanly when the event loop is empty. Essential for serverless functions (AWS Lambda) and graceful shutdown.

> **What a senior engineer actually thinks about**
>
> The pool size is determined by your database, not your application. If PostgreSQL is configured with `max_connections = 100` and you have 4 app servers, each server gets at most 25 connections. But you also need headroom for migrations, monitoring, admin connections, and PgBouncer overhead. I typically use `max: 15` per instance and let the connection queue handle bursts. If the queue grows, that's a signal to optimize slow queries — not to increase pool size.

### Query Methods and Parameterized Queries

The pool (and client) expose a `query` method that accepts several calling signatures:

```typescript
// Simple query — no parameters
const result = await pool.query('SELECT COUNT(*) FROM users');
// result.rows = [{ count: '42' }]  (note: count returns as string)

// Parameterized query — the correct way to pass user input
const userId = req.params.id;
const result = await pool.query(
  'SELECT id, name, email FROM users WHERE id = $1',
  [userId]
);
// result.rows = [{ id: 1, name: 'Alice', email: 'alice@example.com' }]

// Multiple parameters
const result = await pool.query(
  `SELECT id, name, email
   FROM users
   WHERE created_at > $1
     AND role = $2
   ORDER BY created_at DESC
   LIMIT $3`,
  [new Date('2024-01-01'), 'admin', 50]
);

// Query config object — gives you more control
const result = await pool.query({
  text: 'SELECT * FROM users WHERE id = $1',
  values: [userId],
  name: 'get-user-by-id',    // creates a named prepared statement
  rowMode: 'array',           // return arrays instead of objects
});
// result.rows = [[1, 'Alice', 'alice@example.com', ...]]
```

**The `$1, $2, $3` syntax** is PostgreSQL's native parameterized query syntax. Unlike MySQL's `?` placeholders, PG uses numbered parameters. This has a real advantage: you can reference the same parameter multiple times:

```sql
SELECT * FROM events
WHERE (organizer_id = $1 OR attendee_id = $1)
  AND event_date > $2;
```

**The result object** has this shape:

```typescript
interface QueryResult<T> {
  rows: T[];           // array of row objects
  rowCount: number;    // number of rows affected (INSERT/UPDATE/DELETE)
  fields: FieldDef[];  // column metadata (name, dataTypeID, etc.)
  command: string;     // 'SELECT', 'INSERT', 'UPDATE', 'DELETE'
  oid: number;         // OID of inserted row (legacy, rarely used)
}
```

### Handling Connection Errors and Event Listeners

The pool emits events you should listen to:

```typescript
// Fired when a new client is created in the pool
pool.on('connect', (client) => {
  console.log('New client connected to pool');
  // Good place to run per-connection setup
  // e.g., SET statement_timeout, SET search_path
  client.query("SET search_path TO 'myapp, public'");
});

// Fired when a client is returned to the pool after use
pool.on('acquire', (client) => {
  // Useful for metrics: track how often connections are reused
});

// Fired when a client is checked out from the pool
pool.on('release', (client) => {
  // Useful for metrics
});

// Fired when a client sits idle too long and is removed
pool.on('remove', (client) => {
  console.log('Client removed from pool (idle timeout)');
});

// CRITICAL: fired when an idle client encounters an error
// If you don't handle this, it crashes your process!
pool.on('error', (err, client) => {
  console.error('Unexpected error on idle client:', err.message);
  // Don't crash. The pool will remove this client and create a new one.
  // But do alert your monitoring.
});
```

The `error` event on the pool is critical. When a client is sitting idle in the pool and the database restarts, or a network blip occurs, that client receives an error. If nothing handles it, Node.js treats it as an unhandled error and crashes your process. Always register a handler.

For individual queries, you handle errors with try/catch:

```typescript
async function getUserById(id: number) {
  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  } catch (err) {
    if (err.code === '57014') {
      // Query was cancelled (statement_timeout hit)
      throw new Error('Query timed out');
    }
    if (err.code === 'ECONNREFUSED') {
      // Database is down
      throw new Error('Database unavailable');
    }
    throw err; // rethrow unknown errors
  }
}
```

### The postgres.js Library

`postgres.js` (npm package `postgres`) is a newer, more modern PostgreSQL client for Node.js. It uses tagged template literals for queries, which feels much more natural if you're used to modern JavaScript:

```bash
npm install postgres
```

Basic setup:

```typescript
import postgres from 'postgres';

const sql = postgres({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME,
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 20,
  idle_timeout: 30,           // seconds
  connect_timeout: 5,         // seconds
  max_lifetime: 60 * 30,      // 30 min max connection lifetime
  prepare: true,               // use prepared statements (default)
  ssl: process.env.NODE_ENV === 'production' ? 'require' : false,
  transform: {
    column: postgres.toCamel,  // snake_case columns → camelCase JS properties
    value: postgres.toCamel,
  },
  connection: {
    statement_timeout: 30_000,
    application_name: 'myapp-api',
  },
});

export default sql;
```

Queries use tagged template literals, but **this is not string interpolation**. Under the hood, `postgres.js` extracts the interpolated values and sends them as parameters (just like `$1, $2`):

```typescript
// This is SAFE — values are parameterized
const userId = 42;
const users = await sql`
  SELECT id, name, email
  FROM users
  WHERE id = ${userId}
`;
// Equivalent to: pool.query('SELECT ... WHERE id = $1', [42])

// Multiple values
const role = 'admin';
const limit = 50;
const admins = await sql`
  SELECT id, name, email
  FROM users
  WHERE role = ${role}
  ORDER BY created_at DESC
  LIMIT ${limit}
`;

// Dynamic column names (use sql() helper for identifiers)
const column = 'email';
const result = await sql`
  SELECT ${sql(column)}
  FROM users
  WHERE id = ${userId}
`;

// Bulk insert
const users = [
  { name: 'Alice', email: 'alice@co.com' },
  { name: 'Bob', email: 'bob@co.com' },
];
await sql`
  INSERT INTO users ${sql(users, 'name', 'email')}
`;
// Generates: INSERT INTO users (name, email) VALUES ($1, $2), ($3, $4)

// Transactions
await sql.begin(async (tx) => {
  const [user] = await tx`
    INSERT INTO users (name, email)
    VALUES (${name}, ${email})
    RETURNING *
  `;
  await tx`
    INSERT INTO audit_log (user_id, action)
    VALUES (${user.id}, 'created')
  `;
});
```

**postgres.js vs pg — when to use which:**

| Aspect | pg (node-postgres) | postgres.js |
|---|---|---|
| **Maturity** | 10+ years, battle-tested | Newer but production-ready |
| **API style** | `query(text, values)` | Tagged template literals |
| **ORM compatibility** | Used by Prisma, TypeORM, Knex | Used by Drizzle |
| **Connection pooling** | Built-in Pool class | Built-in, pipelining support |
| **Pipelining** | No | Yes (sends multiple queries before waiting for responses) |
| **TypeScript** | Requires `@types/pg` | Native TS support |
| **COPY support** | Via pg-copy-streams | Built-in |
| **Realtime/LISTEN** | Supported | Supported with subscribe API |

For new projects, `postgres.js` is often the better choice for direct SQL usage. If you're using an ORM that depends on `pg`, stick with `pg`.

> **What a senior engineer actually thinks about**
>
> I pick `postgres.js` for new projects where I'm writing raw SQL or using Drizzle. The tagged template API eliminates an entire class of bugs where you forget to parameterize. But `pg` is the bedrock of the ecosystem — if you're using Prisma, TypeORM, or most other tools, you're using `pg` under the hood whether you know it or not. Know both.

---

## 9.2 Prepared Statements

If you've worked with frontend build tools, you know the concept of "compiling once, running many times" — you don't re-parse your JSX on every render. Prepared statements are the database equivalent: you send the query structure once, then send only the parameter values on subsequent executions.

### How Prepared Statements Work in PG's Protocol

PostgreSQL's wire protocol defines an **Extended Query** sub-protocol with three distinct phases:

1. **Parse** — The client sends a SQL string with parameter placeholders (`$1, $2`). PostgreSQL parses it, validates the syntax, resolves table and column references, and creates a **prepared statement** (an internal query plan template). The prepared statement can optionally be given a name.

2. **Bind** — The client sends actual parameter values. PostgreSQL binds them to the prepared statement, creating a **portal** (a ready-to-execute query with concrete values). At this stage, PG can also finalize the query plan because it now knows the actual parameter values (PG 12+ can use "custom plans" based on parameter values).

3. **Execute** — The client tells PostgreSQL to run the portal and return results.

```
Client                         PostgreSQL
  |                                |
  |--- Parse(name, SQL, types) --->|   Parse SQL, create plan template
  |<-- ParseComplete --------------|
  |                                |
  |--- Bind(name, values) -------->|   Bind values, create portal
  |<-- BindComplete ---------------|
  |                                |
  |--- Execute(portal, maxRows) -->|   Run query, return results
  |<-- DataRow, DataRow, ... ------|
  |<-- CommandComplete ------------|
```

The key insight: when you use a **named** prepared statement, the Parse step happens once. Subsequent executions skip directly to Bind + Execute. For queries executed thousands of times (like `SELECT * FROM users WHERE id = $1`), this saves parsing and planning time on every execution.

### Why They Prevent SQL Injection

This is the most important security concept in database programming.

SQL injection happens when user input is concatenated into a SQL string, allowing an attacker to alter the query's structure:

```typescript
// VULNERABLE — never do this
const query = `SELECT * FROM users WHERE email = '${userInput}'`;
// If userInput = "'; DROP TABLE users; --"
// The query becomes:
// SELECT * FROM users WHERE email = ''; DROP TABLE users; --'
```

Prepared statements prevent this structurally, not through escaping. Here's why:

During the **Parse** phase, PostgreSQL receives the query structure with placeholders:

```sql
SELECT * FROM users WHERE email = $1
```

PG parses and plans this query. The structure is now **fixed** — it's a SELECT with one WHERE condition. No amount of creative input can add a DROP TABLE because that would require changing the parsed structure.

During the **Bind** phase, the parameter value arrives as **data**, not as SQL text. PostgreSQL treats `$1` as a typed value. Even if the value contains `'; DROP TABLE users; --`, PostgreSQL treats the entire string as a literal string value for the email column. It never re-parses.

This is fundamentally different from escaping quotes. Escaping is a string manipulation that can fail in edge cases (character encoding tricks, backslash interpretation). Prepared statements separate code from data at the protocol level. They cannot be bypassed.

### Named vs Unnamed Prepared Statements

**Unnamed prepared statements** — When you call `pool.query('SELECT ...', [values])` in node-postgres, it uses the unnamed prepared statement. Each query goes through Parse → Bind → Execute, but the plan is not cached between calls. This is the default behavior.

**Named prepared statements** — When you provide a `name` in the query config, node-postgres caches the prepared statement on the connection:

```typescript
// First execution: Parse + Bind + Execute
const result = await pool.query({
  name: 'get-user-by-id',
  text: 'SELECT * FROM users WHERE id = $1',
  values: [42],
});

// Subsequent executions (same connection): only Bind + Execute
const result2 = await pool.query({
  name: 'get-user-by-id',
  text: 'SELECT * FROM users WHERE id = $1',
  values: [99],
});
```

In node-postgres, named prepared statements are cached per Client (connection). Since pool connections are reused, the same connection will skip the Parse phase on repeated queries. However, different connections in the pool each maintain their own cache.

**When named prepared statements help:**
- High-frequency queries that run thousands of times per second
- Complex queries where parse/plan time is significant

**When they hurt:**
- Queries with highly variable parameters where PG's custom plan (based on actual values) would be better than a generic plan
- When using PgBouncer in transaction mode (see below)

> **What a senior engineer actually thinks about**
>
> In practice, I almost never use named prepared statements explicitly with node-postgres. The unnamed extended protocol already gives you SQL injection protection and decent performance. Named statements save maybe 0.1ms per query on parse time — that matters at 50,000 queries/second, not at typical application loads. Where prepared statements become critical is in the PgBouncer interaction, which I'll explain next.

### The PgBouncer Problem

PgBouncer is a lightweight connection pooler that sits between your application and PostgreSQL. It allows hundreds of application connections to share a small number of actual PG connections. You'd use PgBouncer when you have many application instances (e.g., 20 Kubernetes pods × 20 pool connections = 400 connections, but PG can only handle 100).

PgBouncer has three modes:

- **Session mode** — A PgBouncer connection is assigned to an application client for the entire session. Named prepared statements work because the PG connection stays the same.
- **Transaction mode** — A PgBouncer connection is assigned only for the duration of a single transaction (or single query outside a transaction). Between queries, different application clients may get different PG connections. **Named prepared statements break** because the prepared statement exists on connection A, but your next query might go to connection B.
- **Statement mode** — Most restrictive. Each individual statement gets a potentially different connection. Multi-statement transactions don't work.

Transaction mode is the most common in production because it's the most efficient. But it breaks named prepared statements.

**Solutions:**

1. **Use unnamed prepared statements** (the default in node-postgres `pool.query()`). These work in transaction mode because each Parse + Bind + Execute happens within a single PgBouncer assignment.

2. **PgBouncer 1.21+** added `prepared_statement` mode that tracks named prepared statements across connections and re-prepares them as needed.

3. **Use `postgres.js` with `prepare: false`** if you're running through PgBouncer in transaction mode.

4. **Use Supavisor or pgcat** — newer connection poolers designed with prepared statement support from the start.

---

## 9.3 ORM Tradeoffs

If you've used frontend frameworks, you've experienced the abstraction spectrum: raw DOM manipulation (vanilla JS) → utility libraries (jQuery) → component frameworks (React, Vue) → meta-frameworks (Next.js, Nuxt). Each layer adds convenience and removes control. ORMs are the same spectrum for databases.

The question isn't "should I use an ORM?" — it's "how much abstraction is right for this project?"

### Prisma

Prisma is the most popular ORM in the Node.js/TypeScript ecosystem. It takes a **schema-first** approach: you define your database schema in Prisma's schema language, and it generates a type-safe TypeScript client.

**How Prisma actually works under the hood:**

Unlike traditional ORMs that generate SQL in JavaScript, Prisma runs a **query engine binary** (written in Rust) as a sidecar process. Your TypeScript code sends query requests to this binary via IPC, and the binary generates SQL, manages connections, and returns results. This is fundamentally different from other ORMs.

```
Your TS Code → Prisma Client (TS) → Query Engine (Rust binary) → PostgreSQL
```

This architecture has real implications: the Rust binary is fast at query generation but adds deployment complexity (you need the right binary for your platform), memory overhead (the binary runs as a child process), and debugging opacity (errors sometimes come from the binary, not your code).

**Schema definition:**

```prisma
// prisma/schema.prisma

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model User {
  id        Int       @id @default(autoincrement())
  email     String    @unique
  name      String
  role      Role      @default(USER)
  posts     Post[]
  profile   Profile?
  createdAt DateTime  @default(now()) @map("created_at")
  updatedAt DateTime  @updatedAt @map("updated_at")

  @@map("users")
  @@index([email])
}

model Post {
  id          Int        @id @default(autoincrement())
  title       String
  content     String?
  published   Boolean    @default(false)
  author      User       @relation(fields: [authorId], references: [id])
  authorId    Int        @map("author_id")
  categories  Category[]
  createdAt   DateTime   @default(now()) @map("created_at")

  @@map("posts")
  @@index([authorId])
}

model Profile {
  id     Int    @id @default(autoincrement())
  bio    String?
  avatar String?
  user   User   @relation(fields: [userId], references: [id])
  userId Int    @unique @map("user_id")

  @@map("profiles")
}

model Category {
  id    Int    @id @default(autoincrement())
  name  String @unique
  posts Post[]

  @@map("categories")
}

enum Role {
  USER
  ADMIN
  MODERATOR
}
```

**Generated client usage:**

```typescript
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development'
    ? ['query', 'info', 'warn', 'error']
    : ['error'],
});

// Simple query — type-safe, autocomplete works
const user = await prisma.user.findUnique({
  where: { id: 42 },
});
// typeof user: { id: number, email: string, name: string, ... } | null

// Nested include — this is where Prisma shines and hurts
const userWithPosts = await prisma.user.findUnique({
  where: { id: 42 },
  include: {
    posts: {
      where: { published: true },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: {
        categories: true,
      },
    },
    profile: true,
  },
});
```

**What Prisma generates for that nested include:**

Here's the critical thing most people don't realize. When you write `include: { posts: { include: { categories: true } } }`, Prisma does NOT generate a JOIN query. It generates **multiple separate queries**:

```sql
-- Query 1: Get the user
SELECT "users"."id", "users"."email", "users"."name", ...
FROM "users" WHERE "users"."id" = $1;

-- Query 2: Get the user's posts
SELECT "posts"."id", "posts"."title", ...
FROM "posts" WHERE "posts"."author_id" = $1
  AND "posts"."published" = true
ORDER BY "posts"."created_at" DESC LIMIT 10;

-- Query 3: Get categories for those posts (via junction table)
SELECT "categories"."id", "categories"."name", ...
FROM "categories"
INNER JOIN "_CategoryToPost" ON "categories"."id" = "_CategoryToPost"."A"
WHERE "_CategoryToPost"."B" IN ($1, $2, $3, ...);
```

For a single user, this is fine — 3 queries is acceptable. But now imagine listing 50 users with their posts and categories. Without careful use of `include`, you get the classic N+1 problem.

**The N+1 problem with Prisma:**

```typescript
// This looks innocent but generates 1 + 50 + (50 × n) queries
const users = await prisma.user.findMany({ take: 50 });
for (const user of users) {
  const posts = await prisma.post.findMany({
    where: { authorId: user.id },
    include: { categories: true },
  });
  // Process posts...
}
```

The fix is to use `include` or `select` at the top level:

```typescript
// This generates 3 queries total, regardless of how many users
const users = await prisma.user.findMany({
  take: 50,
  include: {
    posts: {
      include: { categories: true },
    },
  },
});
```

But even with correct includes, Prisma still generates separate queries (not JOINs). For complex queries, this means more round trips to the database than hand-written SQL would require.

**Raw queries when Prisma isn't enough:**

```typescript
// $queryRaw returns typed results
const topAuthors = await prisma.$queryRaw<
  Array<{ id: number; name: string; postCount: bigint }>
>`
  SELECT u.id, u.name, COUNT(p.id) AS "postCount"
  FROM users u
  JOIN posts p ON p.author_id = u.id
  WHERE p.published = true
    AND p.created_at > ${thirtyDaysAgo}
  GROUP BY u.id, u.name
  HAVING COUNT(p.id) > 5
  ORDER BY "postCount" DESC
  LIMIT 20
`;

// $executeRaw for mutations that don't return rows
const affected = await prisma.$executeRaw`
  UPDATE posts
  SET published = true
  WHERE author_id = ${authorId}
    AND created_at > ${cutoffDate}
`;
```

**Transactions with Prisma:**

```typescript
// Sequential transaction — operations run in order in a single transaction
const [user, post] = await prisma.$transaction([
  prisma.user.create({ data: { name: 'Alice', email: 'alice@co.com' } }),
  prisma.post.create({ data: { title: 'First Post', authorId: 1 } }),
]);

// Interactive transaction — full control with rollback on throw
const result = await prisma.$transaction(async (tx) => {
  const sender = await tx.account.update({
    where: { id: senderId },
    data: { balance: { decrement: amount } },
  });

  if (sender.balance < 0) {
    throw new Error('Insufficient funds'); // triggers rollback
  }

  const recipient = await tx.account.update({
    where: { id: recipientId },
    data: { balance: { increment: amount } },
  });

  return { sender, recipient };
}, {
  maxWait: 5000,       // max time to wait for a connection
  timeout: 10_000,     // max time the transaction can run
  isolationLevel: 'Serializable', // PG isolation level
});
```

**When Prisma hurts you:**

- Complex aggregation queries require `$queryRaw`
- Bulk operations (insert 100K rows) are slow because Prisma generates individual INSERT statements by default (`createMany` helps but doesn't support nested creates)
- The Rust binary adds ~50MB of memory overhead and requires platform-specific builds
- Schema drift: if someone modifies the database outside of Prisma, you need `prisma db pull` to sync
- No partial indexes, no expression indexes, no custom operator classes in the schema language
- Generated migrations are sometimes suboptimal (e.g., dropping and recreating constraints instead of altering)

### Drizzle ORM

Drizzle takes the opposite approach from Prisma: instead of abstracting SQL away, it gives you a **SQL-like TypeScript API** where the code you write maps closely to the SQL it generates.

**Schema defined in TypeScript:**

```typescript
// src/db/schema.ts
import {
  pgTable,
  serial,
  text,
  varchar,
  boolean,
  timestamp,
  integer,
  pgEnum,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const roleEnum = pgEnum('role', ['USER', 'ADMIN', 'MODERATOR']);

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  name: text('name').notNull(),
  role: roleEnum('role').default('USER').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  emailIdx: uniqueIndex('users_email_idx').on(table.email),
}));

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  content: text('content'),
  published: boolean('published').default(false).notNull(),
  authorId: integer('author_id').notNull().references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  authorIdx: index('posts_author_id_idx').on(table.authorId),
}));

export const categories = pgTable('categories', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull().unique(),
});

export const postsToCategories = pgTable('posts_to_categories', {
  postId: integer('post_id').notNull().references(() => posts.id),
  categoryId: integer('category_id').notNull().references(() => categories.id),
}, (table) => ({
  pk: uniqueIndex('posts_categories_pk').on(table.postId, table.categoryId),
}));

// Relations (for relational query API)
export const usersRelations = relations(users, ({ many, one }) => ({
  posts: many(posts),
}));

export const postsRelations = relations(posts, ({ one, many }) => ({
  author: one(users, { fields: [posts.authorId], references: [users.id] }),
  categories: many(postsToCategories),
}));
```

**Query API — SQL-like:**

```typescript
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, and, gt, desc, count, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import * as schema from './schema';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema });

// SELECT with WHERE, ORDER BY, LIMIT — reads like SQL
const recentAdmins = await db
  .select({
    id: schema.users.id,
    name: schema.users.name,
    email: schema.users.email,
  })
  .from(schema.users)
  .where(
    and(
      eq(schema.users.role, 'ADMIN'),
      gt(schema.users.createdAt, thirtyDaysAgo),
    )
  )
  .orderBy(desc(schema.users.createdAt))
  .limit(50);

// JOIN — you see exactly what SQL is generated
const postsWithAuthors = await db
  .select({
    postId: schema.posts.id,
    postTitle: schema.posts.title,
    authorName: schema.users.name,
  })
  .from(schema.posts)
  .innerJoin(schema.users, eq(schema.posts.authorId, schema.users.id))
  .where(eq(schema.posts.published, true));

// Aggregation
const topAuthors = await db
  .select({
    authorId: schema.posts.authorId,
    authorName: schema.users.name,
    postCount: count(schema.posts.id).as('post_count'),
  })
  .from(schema.posts)
  .innerJoin(schema.users, eq(schema.posts.authorId, schema.users.id))
  .where(eq(schema.posts.published, true))
  .groupBy(schema.posts.authorId, schema.users.name)
  .having(gt(count(schema.posts.id), 5))
  .orderBy(desc(count(schema.posts.id)));

// Relational query API (Prisma-like includes)
const usersWithPosts = await db.query.users.findMany({
  with: {
    posts: {
      where: eq(schema.posts.published, true),
      limit: 10,
    },
  },
  limit: 50,
});

// INSERT with RETURNING
const [newUser] = await db
  .insert(schema.users)
  .values({ name: 'Alice', email: 'alice@co.com' })
  .returning();

// Transactions
const result = await db.transaction(async (tx) => {
  const [user] = await tx
    .insert(schema.users)
    .values({ name: 'Alice', email: 'alice@co.com' })
    .returning();

  const [post] = await tx
    .insert(schema.posts)
    .values({ title: 'First Post', authorId: user.id })
    .returning();

  return { user, post };
});
```

**Drizzle migrations with Drizzle Kit:**

```bash
# Generate migration from schema changes
npx drizzle-kit generate

# Apply pending migrations
npx drizzle-kit migrate

# Push schema directly (development only, no migration files)
npx drizzle-kit push

# Open Drizzle Studio (database browser)
npx drizzle-kit studio
```

### When Raw SQL Is the Correct Choice

ORMs add value for standard CRUD operations — fetching users, creating posts, updating records. But there are clear cases where raw SQL is the right tool:

**Complex analytical queries:**

```typescript
const revenueReport = await pool.query(`
  WITH monthly_revenue AS (
    SELECT
      date_trunc('month', o.created_at) AS month,
      p.category_id,
      c.name AS category_name,
      SUM(oi.quantity * oi.unit_price) AS revenue,
      COUNT(DISTINCT o.id) AS order_count,
      COUNT(DISTINCT o.customer_id) AS unique_customers
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    JOIN products p ON p.id = oi.product_id
    JOIN categories c ON c.id = p.category_id
    WHERE o.created_at >= $1
      AND o.status = 'completed'
    GROUP BY 1, 2, 3
  ),
  previous_period AS (
    SELECT
      date_trunc('month', o.created_at) + interval '1 month' AS month,
      p.category_id,
      SUM(oi.quantity * oi.unit_price) AS prev_revenue
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    JOIN products p ON p.id = oi.product_id
    WHERE o.created_at >= ($1::timestamptz - interval '1 year')
      AND o.created_at < $1
      AND o.status = 'completed'
    GROUP BY 1, 2
  )
  SELECT
    mr.month,
    mr.category_name,
    mr.revenue,
    mr.order_count,
    mr.unique_customers,
    pp.prev_revenue,
    CASE
      WHEN pp.prev_revenue > 0
      THEN round(((mr.revenue - pp.prev_revenue) / pp.prev_revenue * 100)::numeric, 2)
      ELSE NULL
    END AS yoy_growth_pct
  FROM monthly_revenue mr
  LEFT JOIN previous_period pp
    ON pp.month = mr.month AND pp.category_id = mr.category_id
  ORDER BY mr.month DESC, mr.revenue DESC
`, [startDate]);
```

No ORM can express this clearly. And if one could, you'd spend more time fighting the ORM's API than writing the SQL.

**Bulk operations:**

```typescript
// Insert 100K rows efficiently with COPY
import { pipeline } from 'stream/promises';
import { from as copyFrom } from 'pg-copy-streams';

const client = await pool.connect();
try {
  const stream = client.query(
    copyFrom('COPY products (name, price, category_id) FROM STDIN WITH (FORMAT csv)')
  );
  const fileStream = fs.createReadStream('./products.csv');
  await pipeline(fileStream, stream);
  console.log(`Imported ${stream.rowCount} rows`);
} finally {
  client.release();
}
```

**Performance-critical paths:**

```typescript
// Hand-optimized query using PG-specific features
const suggestions = await pool.query(`
  SELECT
    p.id,
    p.title,
    p.slug,
    ts_rank_cd(p.search_vector, query) AS rank,
    ts_headline('english', p.content, query,
      'StartSel=<mark>, StopSel=</mark>, MaxWords=35, MinWords=15'
    ) AS snippet
  FROM posts p,
    websearch_to_tsquery('english', $1) query
  WHERE p.search_vector @@ query
    AND p.published = true
  ORDER BY rank DESC
  LIMIT 10
`, [searchTerm]);
```

### Honest Comparison Table

| Aspect | Prisma | Drizzle | Raw SQL (pg/postgres.js) |
|---|---|---|---|
| **Type safety** | Excellent (generated) | Excellent (inferred) | Manual (generics) |
| **Learning curve** | Low (own DSL) | Medium (SQL-like API) | Requires SQL knowledge |
| **SQL transparency** | Low (multi-query includes) | High (1:1 SQL mapping) | Complete |
| **Complex queries** | Poor (need `$queryRaw`) | Good (but verbose) | Excellent |
| **Migrations** | Built-in (Prisma Migrate) | Built-in (Drizzle Kit) | Separate tool needed |
| **Bulk operations** | Weak | Good (`insert().values([...])`) | Best (COPY, unnest) |
| **JOIN support** | Generates separate queries | Real SQL JOINs | Real SQL JOINs |
| **Runtime overhead** | High (Rust binary) | Low | Minimal |
| **PG-specific features** | Limited | Growing | Full access |
| **Debugging** | Harder (binary layer) | Easier (predictable SQL) | Easiest |
| **Team onboarding** | Fastest | Moderate | Depends on SQL skill |
| **Best for** | CRUD-heavy apps, rapid prototyping | SQL-aware teams, mixed CRUD + complex | Performance-critical, complex queries |

> **What a senior engineer actually thinks about**
>
> I use Drizzle for 80% of queries (CRUD operations where the type safety and migration support add real value) and drop to raw SQL for the other 20% (reports, bulk operations, anything with CTEs or window functions). I avoid Prisma on new projects because the Rust binary is an operational wildcard — it's an extra process to monitor, it needs the right platform binary in Docker builds, and when something goes wrong, the error messages come from a black box. But I won't pretend Prisma isn't productive for straightforward apps.

---

## 9.4 Migration Tooling

Database migrations are version control for your schema. Just as you wouldn't manually edit files on a production server, you shouldn't manually run ALTER TABLE statements in production. Migrations are the mechanism that makes schema changes repeatable, reviewable, and reversible.

### How to Structure Migrations in a Real Codebase

**Directory structure:**

```
project/
├── src/
│   └── db/
│       ├── schema.ts         # Current schema (Drizzle) or schema.prisma (Prisma)
│       ├── migrations/
│       │   ├── 0001_create_users.sql
│       │   ├── 0002_create_posts.sql
│       │   ├── 0003_add_posts_published_index.sql
│       │   ├── 0004_create_categories.sql
│       │   └── 0005_add_user_role.sql
│       ├── seed.ts           # Seed data for development
│       └── client.ts         # DB connection setup
├── package.json
└── ...
```

**Sequential numbered files vs timestamps:**

There are two conventions for naming migration files:

1. **Sequential numbers**: `0001_`, `0002_`, `0003_`... Simple and readable. Used by Prisma, many Rails-style tools.
2. **Timestamps**: `20240315120000_`, `20240316083000_`... Used by Drizzle Kit, node-pg-migrate, many Go tools.

Timestamps have one advantage: they reduce merge conflicts. If developer A creates migration `0005` on their branch and developer B also creates migration `0005` on theirs, merging creates a conflict. With timestamps, each gets a unique name. The tradeoff is that timestamps are harder to read at a glance.

**Up/down migrations:**

Every migration should have an `up` (apply the change) and a `down` (reverse the change):

```sql
-- 0005_add_user_role.up.sql
ALTER TABLE users ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT 'USER';
CREATE INDEX idx_users_role ON users (role);

-- 0005_add_user_role.down.sql
DROP INDEX idx_users_role;
ALTER TABLE users DROP COLUMN role;
```

In practice, down migrations are often incomplete or untested. Dropping a column is easy, but what about data migrations? If you migrated data from one format to another, can you really reverse it? **Write down migrations, but don't rely on them for production rollbacks.** Instead, design migrations to be forward-compatible (see best practices below).

**Squashing old migrations:**

Over time, you accumulate hundreds of migration files. A new developer joining the team doesn't need to replay 500 migrations — they need the current schema. "Squashing" means collapsing old migrations into a single baseline migration:

```sql
-- 0000_baseline.sql (squashed from migrations 0001-0200)
-- Generated by: pg_dump --schema-only myapp_db > 0000_baseline.sql
CREATE TABLE users ( ... );
CREATE TABLE posts ( ... );
-- ... entire current schema
```

Then delete migrations 0001–0200 and start new migrations from 0201. Your migration tool needs to support marking the baseline as "already applied" for existing databases.

**Handling team conflicts (concurrent migrations):**

When two developers create migrations that touch the same table:

1. **Use a migration lock**: Most tools acquire an advisory lock before running migrations, preventing two processes from migrating simultaneously.
2. **Use timestamps for filenames**: Reduces naming conflicts.
3. **Review migrations in PRs**: A migration that alters a column someone else is also altering needs human coordination.
4. **CI check**: Run all pending migrations against a fresh database in CI to catch conflicts before merge.

### Migration Tools Compared

| Tool | Approach | Schema source | Language | Strengths |
|---|---|---|---|---|
| **Prisma Migrate** | Schema diff | schema.prisma | SQL generated | Automatic diff, type integration |
| **Drizzle Kit** | Schema diff | TypeScript schema | SQL generated | TS-native, good SQL output |
| **node-pg-migrate** | Manual SQL | Migration files | SQL/JS | Full control, no ORM dependency |
| **graphile-migrate** | Manual SQL | Migration files | SQL | Watch mode, committed/uncommitted split |
| **dbmate** | Manual SQL | Migration files | SQL | Language-agnostic, simple |

**node-pg-migrate** deserves special mention for raw SQL users:

```bash
npm install node-pg-migrate
```

```javascript
// migrations/1710000000000_create-users.js
exports.up = (pgm) => {
  pgm.createTable('users', {
    id: 'id', // shorthand for serial primary key
    email: { type: 'varchar(255)', notNull: true, unique: true },
    name: { type: 'text', notNull: true },
    password_hash: { type: 'text', notNull: true },
    role: {
      type: 'varchar(20)',
      notNull: true,
      default: "'USER'",
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });
  pgm.createIndex('users', 'email');
};

exports.down = (pgm) => {
  pgm.dropTable('users');
};
```

### Migration Best Practices

**1. Always test in staging first.** Run your migration against a staging database with production-scale data. A migration that takes 2ms on your dev database with 100 rows might lock a table for 30 minutes on a production table with 50 million rows.

**2. Never modify a deployed migration.** Once a migration has been applied to any shared environment (staging, production), it's immutable. If you need to fix it, create a new migration. Modifying an applied migration causes checksum mismatches and breaks your migration tool's state tracking.

**3. Separate schema changes from data migrations.** A schema migration (ADD COLUMN, CREATE INDEX) and a data migration (UPDATE rows to populate the new column) should be separate files. Schema changes can be quick; data changes on large tables are slow. Mixing them makes rollback impossible.

**4. Use non-breaking migrations.**

```sql
-- BAD: Renaming a column breaks application code instantly
ALTER TABLE users RENAME COLUMN name TO full_name;

-- GOOD: Multi-step non-breaking migration
-- Step 1 (this PR): Add new column
ALTER TABLE users ADD COLUMN full_name TEXT;
-- Step 2 (backfill): Copy data in batches
UPDATE users SET full_name = name WHERE full_name IS NULL; -- batched
-- Step 3 (next PR): Update app to read/write both columns
-- Step 4 (after deploy): Drop old column
ALTER TABLE users DROP COLUMN name;
```

**5. Use `CREATE INDEX CONCURRENTLY`** for production index creation. Regular `CREATE INDEX` locks the table for writes. `CONCURRENTLY` builds the index without blocking, but it's slower and can't run inside a transaction:

```sql
-- In your migration, disable the transaction wrapper
-- node-pg-migrate: exports.config = { transaction: false };
CREATE INDEX CONCURRENTLY idx_posts_author_id ON posts (author_id);
```

**6. Lock timeouts:** Set a lock timeout so migrations don't queue behind long-running queries:

```sql
SET lock_timeout = '5s';
ALTER TABLE users ADD COLUMN bio TEXT;
-- If it can't get the lock in 5 seconds, it fails instead of waiting forever
```

> **What a senior engineer actually thinks about**
>
> I've seen production outages caused by migrations more often than by application bugs. The worst are ALTER TABLE operations on large tables without `CONCURRENTLY` — they silently acquire an AccessExclusiveLock, queue behind all running queries, and then block all new queries until they finish. A "simple" `ADD COLUMN ... DEFAULT 'value'` used to rewrite the entire table in PG < 11. Even in PG 11+, where ADD COLUMN with a volatile default is fast, you still need to think about lock acquisition. Always, always test with production-scale data.

---

## 9.5 Handling Database Errors in Application Code

PostgreSQL communicates errors through structured error responses with SQLSTATE codes. Frontend developers are used to HTTP status codes (404, 500, etc.) — PG error codes serve the same purpose but are 5-character strings defined by the SQL standard.

### PostgreSQL Error Codes You Must Know

| Code | Name | When it happens | What to do |
|---|---|---|---|
| `23505` | unique_violation | INSERT/UPDATE violates a UNIQUE constraint | Return 409 Conflict or prompt user to change input |
| `23503` | foreign_key_violation | INSERT/UPDATE references a non-existent FK, or DELETE removes a row still referenced | Return 400 Bad Request with a message about the relationship |
| `23502` | not_null_violation | INSERT/UPDATE provides NULL for a NOT NULL column | Return 400 Bad Request — usually a missing required field |
| `23514` | check_violation | Value violates a CHECK constraint | Return 400 Bad Request — validate on the app side too |
| `40001` | serialization_failure | Transaction failed due to serialization conflict (SERIALIZABLE isolation) | **Retry the entire transaction** |
| `40P01` | deadlock_detected | Two transactions are waiting for each other's locks | **Retry the entire transaction** |
| `57014` | query_canceled | Query exceeded statement_timeout or was manually cancelled | Return 504 Gateway Timeout |
| `08006` | connection_failure | Connection to database was lost | Reconnect and retry (the pool handles this automatically) |
| `08001` | sqlclient_unable_to_establish_connection | Cannot connect to database | Check database status, return 503 Service Unavailable |
| `42P01` | undefined_table | Query references a table that doesn't exist | Bug in code — fix the query |
| `42703` | undefined_column | Query references a column that doesn't exist | Bug in code — usually a migration hasn't been applied |
| `53300` | too_many_connections | PostgreSQL's max_connections reached | Scale down pool sizes or add PgBouncer |

### Parsing Error Objects in node-postgres

When a query fails, node-postgres throws an error with these properties:

```typescript
interface DatabaseError extends Error {
  // Standard PG error fields
  code: string;           // SQLSTATE error code (e.g., '23505')
  severity: string;       // 'ERROR', 'FATAL', 'PANIC'
  detail: string;         // Human-readable detail
  hint: string;           // Suggested fix
  position: string;       // Error position in the query string
  where: string;          // Call stack within PG
  schema: string;         // Schema name (for constraint violations)
  table: string;          // Table name
  column: string;         // Column name
  constraint: string;     // Constraint name (e.g., 'users_email_key')
  dataType: string;       // Data type name
  routine: string;        // PG function that raised the error

  // node-postgres additions
  message: string;        // Human-readable error message
  stack: string;          // JS stack trace
}
```

The `constraint` field is particularly useful for unique violations — it tells you exactly which constraint was violated:

```typescript
try {
  await pool.query(
    'INSERT INTO users (email, name) VALUES ($1, $2)',
    [email, name]
  );
} catch (err) {
  if (err.code === '23505') {
    // err.constraint might be 'users_email_key'
    if (err.constraint === 'users_email_key') {
      throw new ConflictError('A user with this email already exists');
    }
    if (err.constraint === 'users_username_key') {
      throw new ConflictError('This username is already taken');
    }
  }
  throw err;
}
```

### Building Error Handling Middleware

Here's a complete error-handling layer for an Express application:

```typescript
// src/errors.ts
export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public code: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 409, 'CONFLICT', details);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string | number) {
    super(`${resource} with id ${id} not found`, 404, 'NOT_FOUND');
  }
}

export class DatabaseUnavailableError extends AppError {
  constructor() {
    super('Service temporarily unavailable', 503, 'DATABASE_UNAVAILABLE');
  }
}

// Map PG errors to application errors
const PG_CONSTRAINT_MESSAGES: Record<string, string> = {
  'users_email_key': 'A user with this email already exists',
  'users_username_key': 'This username is already taken',
  'orders_product_id_fkey': 'The specified product does not exist',
  'accounts_balance_check': 'Insufficient balance',
};

export function mapDatabaseError(err: any): AppError {
  switch (err.code) {
    case '23505': { // unique_violation
      const message = PG_CONSTRAINT_MESSAGES[err.constraint]
        || `Duplicate value violates unique constraint: ${err.constraint}`;
      return new ConflictError(message, {
        constraint: err.constraint,
        detail: err.detail,
      });
    }
    case '23503': { // foreign_key_violation
      const message = PG_CONSTRAINT_MESSAGES[err.constraint]
        || `Referenced record does not exist: ${err.constraint}`;
      return new ValidationError(message, {
        constraint: err.constraint,
        detail: err.detail,
      });
    }
    case '23502': { // not_null_violation
      return new ValidationError(
        `Missing required field: ${err.column}`,
        { column: err.column, table: err.table },
      );
    }
    case '23514': { // check_violation
      const message = PG_CONSTRAINT_MESSAGES[err.constraint]
        || `Value violates constraint: ${err.constraint}`;
      return new ValidationError(message, { constraint: err.constraint });
    }
    case '57014': // query_canceled
      return new AppError('Request timed out', 504, 'TIMEOUT');
    case '08006': // connection_failure
    case '08001': // unable to establish connection
    case '53300': // too_many_connections
      return new DatabaseUnavailableError();
    default:
      return new AppError('Internal server error', 500, 'INTERNAL_ERROR');
  }
}

// Express error handling middleware
export function errorHandler(err: Error, req: any, res: any, next: any) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
  }

  // Check if it's a PG error (has a SQLSTATE code)
  if ('code' in err && typeof (err as any).code === 'string' && (err as any).code.length === 5) {
    const appError = mapDatabaseError(err);
    if (appError.statusCode >= 500) {
      console.error('Database error:', err);
    }
    return res.status(appError.statusCode).json({
      error: {
        code: appError.code,
        message: appError.message,
        details: appError.details,
      },
    });
  }

  console.error('Unhandled error:', err);
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    },
  });
}
```

### Retrying on Serialization Failures

Serialization failures (`40001`) and deadlocks (`40P01`) are **expected** when using SERIALIZABLE isolation or under high concurrency. PostgreSQL's documentation explicitly says the application must retry these. Here's a robust retry implementation:

```typescript
interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryableCodes?: string[];
}

const DEFAULT_RETRYABLE_CODES = [
  '40001', // serialization_failure
  '40P01', // deadlock_detected
];

async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 50,
    maxDelayMs = 2000,
    retryableCodes = DEFAULT_RETRYABLE_CODES,
  } = options;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err: any) {
      lastError = err;

      if (!retryableCodes.includes(err.code)) {
        throw err; // not retryable
      }

      if (attempt === maxRetries) {
        throw err; // exhausted retries
      }

      // Exponential backoff with full jitter
      // This is important: without jitter, all concurrent retries
      // fire at the same time and collide again
      const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
      const jitteredDelay = Math.random() * Math.min(exponentialDelay, maxDelayMs);

      console.warn(
        `Retryable error (code: ${err.code}), attempt ${attempt + 1}/${maxRetries}, ` +
        `retrying in ${Math.round(jitteredDelay)}ms`
      );

      await new Promise((resolve) => setTimeout(resolve, jitteredDelay));
    }
  }

  throw lastError;
}

// Usage
const result = await withRetry(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const { rows: [account] } = await client.query(
      'SELECT balance FROM accounts WHERE id = $1 FOR UPDATE',
      [accountId]
    );
    if (account.balance < amount) {
      throw new ValidationError('Insufficient funds');
    }
    await client.query(
      'UPDATE accounts SET balance = balance - $1 WHERE id = $2',
      [amount, accountId]
    );
    await client.query('COMMIT');
    return account;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});
```

> **What a senior engineer actually thinks about**
>
> The retry with jitter pattern is critical but rarely implemented correctly. I've seen systems where all workers retry at exactly 100ms, 200ms, 400ms — creating "retry storms" that make the contention worse. Full jitter (randomize the entire delay window) is better than equal jitter (randomize half the window). AWS's architecture blog has an excellent analysis of this. Also: if you're retrying serialization failures more than occasionally, your access patterns have a contention problem that retrying won't fix — redesign the transaction.

---

## 9.6 Transaction Management Patterns in Application Code

Transactions in application code are where theory meets practice, and where most connection leaks and subtle bugs live. The fundamental challenge: you need to run multiple queries on the **same connection** (because transactions are connection-scoped), but your pool returns connections to the shared pool after each `pool.query()`.

### Using BEGIN/COMMIT/ROLLBACK with node-postgres

When using `pool.query()`, each call might use a different connection from the pool. This means:

```typescript
// BROKEN — each query might run on a different connection
await pool.query('BEGIN');
await pool.query('INSERT INTO users (name) VALUES ($1)', ['Alice']);
await pool.query('COMMIT');
// The BEGIN, INSERT, and COMMIT might go to three different connections!
```

You must check out a dedicated client from the pool:

```typescript
const client = await pool.connect(); // check out a connection
try {
  await client.query('BEGIN');
  await client.query(
    'INSERT INTO users (name, email) VALUES ($1, $2)',
    ['Alice', 'alice@co.com']
  );
  await client.query(
    'INSERT INTO audit_log (action, detail) VALUES ($1, $2)',
    ['user_created', 'Alice']
  );
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release(); // ALWAYS return the client to the pool
}
```

The `finally` block is non-negotiable. If you forget `client.release()`, that connection is permanently lost from the pool. After `max` connections leak, the pool is exhausted and your application hangs. This is the database equivalent of a memory leak.

### Transaction Helper Implementation

Writing the try/catch/finally for every transaction is error-prone and repetitive. Here's a production-grade transaction helper:

```typescript
import { Pool, PoolClient, QueryResultRow } from 'pg';

type IsolationLevel =
  | 'READ COMMITTED'
  | 'REPEATABLE READ'
  | 'SERIALIZABLE';

interface TransactionOptions {
  isolationLevel?: IsolationLevel;
  readOnly?: boolean;
  deferrable?: boolean; // only with SERIALIZABLE + readOnly
}

async function withTransaction<T>(
  pool: Pool,
  callback: (client: PoolClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const client = await pool.connect();

  const { isolationLevel, readOnly, deferrable } = options;

  let beginStatement = 'BEGIN';
  if (isolationLevel) {
    beginStatement += ` ISOLATION LEVEL ${isolationLevel}`;
  }
  if (readOnly) {
    beginStatement += ' READ ONLY';
  }
  if (deferrable && isolationLevel === 'SERIALIZABLE' && readOnly) {
    beginStatement += ' DEFERRABLE';
  }

  try {
    await client.query(beginStatement);
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Usage
const { user, post } = await withTransaction(pool, async (client) => {
  const { rows: [user] } = await client.query(
    'INSERT INTO users (name, email) VALUES ($1, $2) RETURNING *',
    ['Alice', 'alice@co.com']
  );

  const { rows: [post] } = await client.query(
    'INSERT INTO posts (title, author_id) VALUES ($1, $2) RETURNING *',
    ['First Post', user.id]
  );

  return { user, post };
});

// With options
const report = await withTransaction(
  pool,
  async (client) => {
    const { rows } = await client.query(`
      SELECT date_trunc('month', created_at) AS month,
             COUNT(*) AS total,
             SUM(amount) AS revenue
      FROM orders
      WHERE created_at >= $1
      GROUP BY 1
      ORDER BY 1
    `, [startDate]);
    return rows;
  },
  {
    isolationLevel: 'REPEATABLE READ',
    readOnly: true,
  },
);
```

### Nested Transactions with Savepoints

PostgreSQL doesn't support true nested transactions, but it supports **savepoints** — named markers within a transaction that you can roll back to without rolling back the entire transaction:

```typescript
async function withSavepoint<T>(
  client: PoolClient,
  name: string,
  callback: () => Promise<T>,
): Promise<T> {
  await client.query(`SAVEPOINT ${name}`);
  try {
    const result = await callback();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    throw err;
  }
}

// Usage: process an order where individual items might fail
await withTransaction(pool, async (client) => {
  const { rows: [order] } = await client.query(
    'INSERT INTO orders (customer_id, status) VALUES ($1, $2) RETURNING *',
    [customerId, 'pending']
  );

  const results = [];
  for (const item of orderItems) {
    try {
      const result = await withSavepoint(client, `item_${item.productId}`, async () => {
        // This might fail (insufficient stock, invalid product, etc.)
        await client.query(
          'UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1',
          [item.quantity, item.productId]
        );
        const { rows: [orderItem] } = await client.query(
          'INSERT INTO order_items (order_id, product_id, quantity, price) VALUES ($1, $2, $3, $4) RETURNING *',
          [order.id, item.productId, item.quantity, item.price]
        );
        return orderItem;
      });
      results.push({ ...result, status: 'added' });
    } catch (err) {
      results.push({ productId: item.productId, status: 'failed', reason: err.message });
    }
  }

  if (results.every((r) => r.status === 'failed')) {
    throw new Error('No items could be processed');
  }

  await client.query(
    'UPDATE orders SET status = $1 WHERE id = $2',
    ['confirmed', order.id]
  );

  return { order, items: results };
});
```

### Avoiding Connection Leaks

Connection leaks are the most common production issue with pool-based database access. Here's how they happen and how to prevent them:

**Leak scenario 1: Missing release on error path**

```typescript
// LEAKS if the INSERT throws
const client = await pool.connect();
await client.query('BEGIN');
await client.query('INSERT INTO users ...'); // throws!
await client.query('COMMIT');
client.release(); // never reached
```

**Leak scenario 2: Conditional early return**

```typescript
// LEAKS if user already exists
const client = await pool.connect();
const { rows } = await client.query('SELECT * FROM users WHERE email = $1', [email]);
if (rows.length > 0) {
  return rows[0]; // leaked! client never released
}
await client.query('INSERT INTO users ...');
client.release();
```

**Detection:** Add pool monitoring to catch leaks:

```typescript
// Log warnings when the pool is under pressure
setInterval(() => {
  const { totalCount, idleCount, waitingCount } = pool;
  if (waitingCount > 0) {
    console.warn(
      `Pool pressure: ${totalCount} total, ${idleCount} idle, ${waitingCount} waiting`
    );
  }
  if (totalCount === pool.options.max && idleCount === 0) {
    console.error('Pool exhausted — possible connection leak');
  }
}, 5000);

// node-postgres can detect leaked clients (unreleased for too long)
// by monkey-patching release with a timeout warning
const originalConnect = pool.connect.bind(pool);
pool.connect = async () => {
  const client = await originalConnect();
  const stack = new Error('Client checked out').stack;
  const timer = setTimeout(() => {
    console.error('Client checked out for >30s without release. Checkout stack:', stack);
  }, 30_000);

  const originalRelease = client.release.bind(client);
  client.release = (...args: any[]) => {
    clearTimeout(timer);
    return originalRelease(...args);
  };

  return client;
};
```

> **What a senior engineer actually thinks about**
>
> Every production application I've worked on has had a connection leak at some point. The `withTransaction` helper solves 90% of the problem. For the other 10%, I add the monitoring interval above and set up alerts when `waitingCount > 0` for more than 30 seconds. The monkey-patching approach for leak detection is invaluable during development but too noisy for production — use it in staging.

---

## 9.7 Testing Strategies

Testing database interactions is where most backend developers cut corners, and where most production bugs originate. The challenge: database tests are slower than unit tests (they hit a real database), they require state management (each test needs a clean starting point), and they can interfere with each other (concurrent tests modifying the same rows).

### Test Database Setup

**Rule #1: Never test against your development database.** Tests create and destroy data rapidly. If tests share a database with your development environment, you'll corrupt your dev data.

**Option A: Separate test database (simplest)**

```bash
# Create a test database
createdb myapp_test

# Set the test database URL in your test environment
# .env.test
DATABASE_URL=postgresql://localhost:5432/myapp_test
```

```typescript
// test/setup.ts
import { Pool } from 'pg';

const testPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5, // fewer connections for tests
});

export async function setupTestDatabase() {
  // Run migrations
  await runMigrations(testPool);
}

export async function teardownTestDatabase() {
  // Truncate all tables (faster than dropping and recreating)
  await testPool.query(`
    DO $$
    DECLARE
      r RECORD;
    BEGIN
      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' CASCADE';
      END LOOP;
    END $$;
  `);
}

export { testPool };
```

**Option B: docker-compose for CI (reproducible)**

```yaml
# docker-compose.test.yml
services:
  test-db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: myapp_test
      POSTGRES_USER: test_user
      POSTGRES_PASSWORD: test_password
    ports:
      - "5433:5432"  # different port to avoid conflicts
    tmpfs:
      - /var/lib/postgresql/data  # RAM disk for speed
    command: >
      postgres
        -c fsync=off
        -c synchronous_commit=off
        -c full_page_writes=off
        -c max_connections=50
```

The `tmpfs` mount and disabled fsync/synchronous_commit make tests significantly faster (5-10x) by not actually writing to disk. This is obviously terrible for production but perfect for tests.

```json
// package.json
{
  "scripts": {
    "test:db:up": "docker compose -f docker-compose.test.yml up -d",
    "test:db:down": "docker compose -f docker-compose.test.yml down -v",
    "test:migrate": "DATABASE_URL=postgresql://test_user:test_password@localhost:5433/myapp_test node-pg-migrate up",
    "test": "npm run test:db:up && npm run test:migrate && vitest run; npm run test:db:down"
  }
}
```

### Transaction Rollback per Test

The most elegant pattern for test isolation: wrap each test in a transaction and roll back after. Every change the test makes is undone instantly, leaving the database exactly as it was. No cleanup code, no stale data.

```typescript
// test/helpers.ts
import { Pool, PoolClient } from 'pg';

let pool: Pool;
let client: PoolClient;

export function getTestClient(): PoolClient {
  return client;
}

export async function setupTestTransaction() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1, // single connection for transaction isolation
    });
  }
  client = await pool.connect();
  await client.query('BEGIN');
}

export async function teardownTestTransaction() {
  await client.query('ROLLBACK');
  client.release();
}

// If your code uses a pool (not a client), you can override it:
// Create a proxy pool that always returns the same transactional client
export function createTestPool(): Pool {
  const mockPool = {
    query: (...args: any[]) => client.query(...args),
    connect: async () => {
      // Return a client proxy that doesn't actually release
      return {
        ...client,
        query: (...args: any[]) => client.query(...args),
        release: () => {}, // no-op; the test controls the transaction
      } as any;
    },
    end: async () => {},
  } as any;
  return mockPool;
}
```

```typescript
// test/users.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  setupTestTransaction,
  teardownTestTransaction,
  getTestClient,
} from './helpers';

describe('User repository', () => {
  beforeEach(async () => {
    await setupTestTransaction();
  });

  afterEach(async () => {
    await teardownTestTransaction();
  });

  it('creates a user and returns it', async () => {
    const client = getTestClient();
    const { rows: [user] } = await client.query(
      'INSERT INTO users (name, email) VALUES ($1, $2) RETURNING *',
      ['Alice', 'alice@test.com']
    );
    expect(user.name).toBe('Alice');
    expect(user.email).toBe('alice@test.com');
    expect(user.id).toBeDefined();
  });

  it('enforces unique emails', async () => {
    const client = getTestClient();
    await client.query(
      'INSERT INTO users (name, email) VALUES ($1, $2)',
      ['Alice', 'duplicate@test.com']
    );
    await expect(
      client.query(
        'INSERT INTO users (name, email) VALUES ($1, $2)',
        ['Bob', 'duplicate@test.com']
      )
    ).rejects.toMatchObject({ code: '23505' });
  });

  // Each test starts with a clean database (the BEGIN from beforeEach)
  it('starts with no users', async () => {
    const client = getTestClient();
    const { rows } = await client.query('SELECT COUNT(*) FROM users');
    expect(parseInt(rows[0].count)).toBe(0);
  });
});
```

### Seeding Data: Factories vs Fixtures

**Fixtures** — Static data files loaded before tests:

```typescript
// test/fixtures/users.ts
export const testUsers = [
  { name: 'Alice Admin', email: 'alice@test.com', role: 'ADMIN' },
  { name: 'Bob User', email: 'bob@test.com', role: 'USER' },
  { name: 'Carol Mod', email: 'carol@test.com', role: 'MODERATOR' },
];

export async function seedUsers(client: PoolClient) {
  for (const user of testUsers) {
    await client.query(
      'INSERT INTO users (name, email, role) VALUES ($1, $2, $3)',
      [user.name, user.email, user.role]
    );
  }
}
```

Fixtures are simple but brittle. When your schema changes (adding a required column), every fixture file needs updating.

**Factories** — Functions that create test data with sensible defaults and allow overrides:

```typescript
// test/factories.ts
import { PoolClient } from 'pg';

let sequence = 0;
function nextSeq() { return ++sequence; }

interface UserOverrides {
  name?: string;
  email?: string;
  role?: string;
}

export async function createUser(client: PoolClient, overrides: UserOverrides = {}) {
  const seq = nextSeq();
  const data = {
    name: overrides.name ?? `Test User ${seq}`,
    email: overrides.email ?? `user${seq}@test.com`,
    role: overrides.role ?? 'USER',
  };

  const { rows: [user] } = await client.query(
    'INSERT INTO users (name, email, role) VALUES ($1, $2, $3) RETURNING *',
    [data.name, data.email, data.role]
  );
  return user;
}

interface PostOverrides {
  title?: string;
  content?: string;
  published?: boolean;
  authorId?: number;
}

export async function createPost(client: PoolClient, overrides: PostOverrides = {}) {
  const seq = nextSeq();

  // Automatically create an author if not provided
  let authorId = overrides.authorId;
  if (!authorId) {
    const author = await createUser(client);
    authorId = author.id;
  }

  const data = {
    title: overrides.title ?? `Test Post ${seq}`,
    content: overrides.content ?? `Content for post ${seq}`,
    published: overrides.published ?? false,
    authorId,
  };

  const { rows: [post] } = await client.query(
    'INSERT INTO posts (title, content, published, author_id) VALUES ($1, $2, $3, $4) RETURNING *',
    [data.title, data.content, data.published, data.authorId]
  );
  return post;
}

// Usage in tests
it('lists published posts', async () => {
  const client = getTestClient();
  const author = await createUser(client, { name: 'Author' });
  await createPost(client, { authorId: author.id, published: true, title: 'Published' });
  await createPost(client, { authorId: author.id, published: false, title: 'Draft' });

  const { rows } = await client.query(
    'SELECT * FROM posts WHERE published = true'
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].title).toBe('Published');
});
```

Factories are more work upfront but far more maintainable. They're the standard in mature test suites.

### Using testcontainers-node

`testcontainers-node` spins up real Docker containers for each test suite, giving you a completely isolated PostgreSQL instance:

```bash
npm install -D testcontainers
```

```typescript
// test/setup-testcontainers.ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from 'testcontainers';
import { Pool } from 'pg';
import { migrate } from './migrate'; // your migration runner

let container: StartedPostgreSqlContainer;
let pool: Pool;

export async function startTestDatabase(): Promise<Pool> {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('test_db')
    .withUsername('test')
    .withPassword('test')
    .withCommand([
      'postgres',
      '-c', 'fsync=off',
      '-c', 'synchronous_commit=off',
    ])
    .start();

  pool = new Pool({
    host: container.getHost(),
    port: container.getMappedPort(5432),
    database: container.getDatabase(),
    user: container.getUsername(),
    password: container.getPassword(),
    max: 5,
  });

  await migrate(pool);
  return pool;
}

export async function stopTestDatabase() {
  await pool?.end();
  await container?.stop();
}

export function getPool(): Pool {
  return pool;
}
```

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: './test/global-setup.ts',
    setupFiles: ['./test/per-test-setup.ts'],
    pool: 'forks', // use forks, not threads (each fork gets its own DB context)
    poolOptions: {
      forks: { singleFork: true }, // share the container across tests
    },
  },
});
```

```typescript
// test/global-setup.ts
import { startTestDatabase, stopTestDatabase } from './setup-testcontainers';

export async function setup() {
  const pool = await startTestDatabase();
  // Store the connection URL for test workers
  process.env.TEST_DATABASE_URL = `postgresql://${pool.options.user}:${pool.options.password}@${pool.options.host}:${pool.options.port}/${pool.options.database}`;
}

export async function teardown() {
  await stopTestDatabase();
}
```

### Complete Test Setup with Vitest + node-postgres

Here's the complete test infrastructure pulling everything together:

```typescript
// test/per-test-setup.ts
import { beforeEach, afterEach, afterAll } from 'vitest';
import { Pool, PoolClient } from 'pg';

let pool: Pool;
let client: PoolClient;

beforeEach(async () => {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL,
      max: 2,
    });
  }
  client = await pool.connect();
  await client.query('BEGIN');
});

afterEach(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
});

afterAll(async () => {
  await pool?.end();
});

export function getClient(): PoolClient {
  return client;
}
```

```typescript
// test/integration/orders.test.ts
import { describe, it, expect } from 'vitest';
import { getClient } from '../per-test-setup';
import { createUser, createPost } from '../factories';

describe('Order processing', () => {
  it('transfers money between accounts atomically', async () => {
    const client = getClient();

    // Setup
    await client.query(`
      CREATE TEMPORARY TABLE IF NOT EXISTS accounts (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL,
        balance NUMERIC(10, 2) NOT NULL DEFAULT 0,
        CHECK (balance >= 0)
      )
    `);

    const sender = await createUser(client, { name: 'Sender' });
    const receiver = await createUser(client, { name: 'Receiver' });

    await client.query(
      'INSERT INTO accounts (user_id, balance) VALUES ($1, $2), ($3, $4)',
      [sender.id, 1000.00, receiver.id, 500.00]
    );

    // Execute transfer using a savepoint (since we're already in a transaction)
    await client.query('SAVEPOINT transfer');
    await client.query(
      'UPDATE accounts SET balance = balance - $1 WHERE user_id = $2',
      [250.00, sender.id]
    );
    await client.query(
      'UPDATE accounts SET balance = balance + $1 WHERE user_id = $2',
      [250.00, receiver.id]
    );
    await client.query('RELEASE SAVEPOINT transfer');

    // Verify
    const { rows: [senderAccount] } = await client.query(
      'SELECT balance FROM accounts WHERE user_id = $1',
      [sender.id]
    );
    const { rows: [receiverAccount] } = await client.query(
      'SELECT balance FROM accounts WHERE user_id = $1',
      [receiver.id]
    );

    expect(parseFloat(senderAccount.balance)).toBe(750.00);
    expect(parseFloat(receiverAccount.balance)).toBe(750.00);
  });

  it('rejects transfer when sender has insufficient funds', async () => {
    const client = getClient();

    await client.query(`
      CREATE TEMPORARY TABLE IF NOT EXISTS accounts (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL,
        balance NUMERIC(10, 2) NOT NULL DEFAULT 0,
        CHECK (balance >= 0)
      )
    `);

    const sender = await createUser(client, { name: 'Poor Sender' });
    await client.query(
      'INSERT INTO accounts (user_id, balance) VALUES ($1, $2)',
      [sender.id, 50.00]
    );

    await expect(
      client.query(
        'UPDATE accounts SET balance = balance - $1 WHERE user_id = $2',
        [100.00, sender.id]
      )
    ).rejects.toMatchObject({ code: '23514' }); // check_violation
  });
});
```

> **What a senior engineer actually thinks about**
>
> I've tried every testing approach: mocking the database (fast but unreliable — your tests pass but production breaks), using SQLite for tests (schema differences cause false positives), and running against a real PG instance (slow but catches real bugs). The transaction rollback pattern + testcontainers is the sweet spot. Each test runs against real PostgreSQL, with real constraints and real behavior, but rollback makes cleanup instant. The first test suite run is slow (container startup), but subsequent tests are fast. The key insight: database tests should test your SQL and your data model, not just your JavaScript logic.

---

## 9.8 Security in Application Code

Security is not a feature you add later — it's a property of how you write code from day one. Database security failures (SQL injection, leaked credentials, excessive privileges) are among the most common and most devastating vulnerabilities in web applications.

### SQL Injection Prevention

You've probably heard "use parameterized queries" a hundred times. Let's understand exactly what's safe and what isn't.

**NEVER safe — string concatenation or template literals:**

```typescript
// VULNERABLE — user input is part of the SQL string
const email = req.body.email;

// Template literal (backticks) — VULNERABLE
const result = await pool.query(`SELECT * FROM users WHERE email = '${email}'`);

// String concatenation — VULNERABLE
const result = await pool.query("SELECT * FROM users WHERE email = '" + email + "'");

// Even with "escaping" — DO NOT DO THIS
const escaped = email.replace(/'/g, "''");
const result = await pool.query(`SELECT * FROM users WHERE email = '${escaped}'`);
// This can still be bypassed with encoding tricks
```

**ALWAYS safe — parameterized queries:**

```typescript
// node-postgres parameterized query — SAFE
const result = await pool.query(
  'SELECT * FROM users WHERE email = $1',
  [email]
);

// postgres.js tagged template — SAFE (despite looking like interpolation)
const result = await sql`SELECT * FROM users WHERE email = ${email}`;

// Prisma — SAFE (parameterized internally)
const user = await prisma.user.findFirst({ where: { email } });

// Drizzle — SAFE (parameterized internally)
const user = await db.select().from(users).where(eq(users.email, email));
```

**The tricky case — dynamic table/column names:**

Parameterized queries only work for **values**, not for identifiers (table names, column names, operators). If you need dynamic identifiers, whitelist them:

```typescript
// VULNERABLE — dynamic column name
const sortColumn = req.query.sort; // user sends "name; DROP TABLE users"
const result = await pool.query(
  `SELECT * FROM users ORDER BY ${sortColumn}` // SQL injection!
);

// SAFE — whitelist approach
const ALLOWED_SORT_COLUMNS = new Set(['name', 'email', 'created_at']);

function getSortColumn(input: string): string {
  if (!ALLOWED_SORT_COLUMNS.has(input)) {
    return 'created_at'; // safe default
  }
  return input;
}

const sortColumn = getSortColumn(req.query.sort as string);
const result = await pool.query(
  `SELECT * FROM users ORDER BY ${sortColumn} DESC`
);

// SAFE — using pg's escapeIdentifier for dynamic identifiers
import { escapeIdentifier } from 'pg';

const column = escapeIdentifier(req.query.sort as string);
// This wraps the identifier in double quotes and escapes any embedded quotes
const result = await pool.query(`SELECT * FROM users ORDER BY ${column} DESC`);
```

### Connection String Security

Your database connection string contains credentials. Treat it like a secret key.

```
postgresql://myapp_user:s3cr3t_p4ssw0rd@db.example.com:5432/myapp?sslmode=require
```

**Never do this:**

```typescript
// NEVER hardcode credentials in source code
const pool = new Pool({
  connectionString: 'postgresql://user:password@host:5432/db',
});

// NEVER commit .env files to git
// .gitignore must include .env*
```

**Production credential management:**

```typescript
// Option 1: Environment variables (minimum viable security)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Option 2: Cloud secrets manager (recommended for production)
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

async function getDatabaseUrl(): Promise<string> {
  const client = new SecretsManagerClient({ region: 'us-east-1' });
  const response = await client.send(
    new GetSecretValueCommand({ SecretId: 'myapp/database-url' })
  );
  const secret = JSON.parse(response.SecretString!);
  return `postgresql://${secret.username}:${secret.password}@${secret.host}:${secret.port}/${secret.database}`;
}

const pool = new Pool({
  connectionString: await getDatabaseUrl(),
});

// Option 3: IAM database authentication (AWS RDS, GCP Cloud SQL)
// The "password" is a short-lived token generated from your IAM credentials
import { RDS } from '@aws-sdk/client-rds';

async function getAuthToken(): Promise<string> {
  const signer = new RDS.Signer({
    region: 'us-east-1',
    hostname: process.env.DB_HOST!,
    port: 5432,
    username: process.env.DB_USER!,
  });
  return signer.getAuthToken();
}
```

### SSL/TLS Connections

In production, database connections should always be encrypted. Without TLS, anyone on the network path (cloud provider infrastructure, VPC peers) can read your queries and results in plaintext — including passwords and personal data.

```typescript
import { Pool } from 'pg';
import { readFileSync } from 'fs';

// Minimum: require SSL (verifies the server has a certificate)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true },
});

// Full verification with CA certificate (recommended)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: true,
    ca: readFileSync('/path/to/ca-certificate.crt').toString(),
    // For mutual TLS (client certificate authentication):
    // key: readFileSync('/path/to/client-key.pem').toString(),
    // cert: readFileSync('/path/to/client-cert.pem').toString(),
  },
});

// DANGEROUS — disables certificate verification
// Only for development with self-signed certs
const pool = new Pool({
  ssl: { rejectUnauthorized: false }, // DO NOT use in production
});
```

Cloud providers typically provide a CA certificate you should bundle with your application:
- **AWS RDS**: Download the [RDS CA bundle](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html)
- **GCP Cloud SQL**: The Cloud SQL Auth Proxy handles TLS automatically
- **Azure Database**: Download the CA cert from the Azure portal

### Principle of Least Privilege

Your application's database user should have the minimum permissions needed to operate. It should NOT be a superuser, it should NOT own the database, and it should NOT be able to create or drop tables.

```sql
-- Create a restricted application user
CREATE ROLE myapp_user LOGIN PASSWORD 'strong_password_here';

-- Grant only what the application needs
GRANT CONNECT ON DATABASE myapp TO myapp_user;
GRANT USAGE ON SCHEMA public TO myapp_user;

-- Table-level permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO myapp_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO myapp_user;

-- Apply to future tables too
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO myapp_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO myapp_user;

-- Separate migration user with elevated privileges
CREATE ROLE myapp_migrator LOGIN PASSWORD 'different_strong_password';
GRANT ALL PRIVILEGES ON DATABASE myapp TO myapp_migrator;
GRANT ALL PRIVILEGES ON SCHEMA public TO myapp_migrator;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO myapp_migrator;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO myapp_migrator;
```

Your application connects as `myapp_user`. Your migration scripts connect as `myapp_migrator`. If your application is compromised (SQL injection that somehow bypasses parameterization, or a dependency vulnerability), the attacker cannot `DROP TABLE`, `CREATE USER`, or access system catalogs.

### pg_hba.conf Basics

`pg_hba.conf` (Host-Based Authentication) controls who can connect to PostgreSQL and how they authenticate. It's the firewall for your database. Think of it as the equivalent of an API gateway's authentication middleware, but at the database level.

Each line specifies:

```
TYPE    DATABASE    USER           ADDRESS         METHOD
```

```conf
# Local socket connections (from the same machine)
local   all         postgres                       peer
local   all         all                            md5

# IPv4 connections
host    myapp       myapp_user     10.0.0.0/8      scram-sha-256
host    myapp       myapp_migrator 10.0.1.0/24     scram-sha-256

# Reject everything else
host    all         all            0.0.0.0/0       reject
```

Key methods:
- **`peer`** — Uses OS username (Unix sockets only). If your OS user is `postgres`, you connect as PG user `postgres`.
- **`md5`** — Password authentication with MD5 hashing. Legacy but still common.
- **`scram-sha-256`** — Modern password authentication. Use this. (PG 10+)
- **`cert`** — Client certificate authentication (mTLS). Most secure.
- **`reject`** — Deny connection.

In cloud-hosted PostgreSQL (RDS, Cloud SQL, etc.), `pg_hba.conf` is managed through security groups and network rules instead. The concepts are the same — restrict which IP ranges can connect.

> **What a senior engineer actually thinks about**
>
> I've audited applications where the production database user was the `postgres` superuser, the connection string was hardcoded in a committed `.env` file, SSL was disabled, and there was no firewall rule on the database. This is terrifyingly common, especially in startups moving fast. The fix takes 30 minutes: create a restricted user, move credentials to a secrets manager, enable SSL, and restrict network access. That 30 minutes prevents the kind of breach that ends companies.

---

## 9.9 Things That Will Bite You in Production

These are real issues I've seen cause incidents. Not theoretical risks — actual 2 AM pages.

### 1. Connection pool exhaustion

**What happens:** Your application stops responding. All requests hang for exactly `connectionTimeoutMillis` then fail. No errors in the database logs — PG is fine. Your app's connection pool is full because clients were checked out and never released.

**Why:** A code path calls `pool.connect()` but has a conditional return before `client.release()`. Under normal traffic, this leak is slow. Under a traffic spike, the leak rate exceeds the idle timeout, and the pool fills up.

**Prevention:** Always use the `withTransaction` helper. Never call `pool.connect()` directly in application code. Monitor `pool.waitingCount` and alert if it's non-zero.

### 2. BigInt surprise

**What happens:** `SELECT COUNT(*) FROM users` returns `{ count: '42' }` — the count is a **string**. Your frontend code does `response.count + 1` and gets `'421'`.

**Why:** PostgreSQL's `BIGINT` (int8) exceeds JavaScript's `Number.MAX_SAFE_INTEGER`. node-postgres returns BIGINT columns as strings to avoid precision loss. COUNT() returns BIGINT.

**Fix:** Cast in SQL (`SELECT COUNT(*)::int`) for values you know are small, or parse in application code (`parseInt(result.rows[0].count, 10)`), or configure the type parser as shown in the pool config section.

### 3. Idle transaction timeout

**What happens:** A long-running API handler opens a transaction, makes an external HTTP call, and the call takes 60 seconds. During those 60 seconds, the transaction holds locks and a connection. Under load, this cascades.

**Why:** Transactions should be as short as possible. External I/O (HTTP calls, file operations, email sending) should happen outside the transaction.

**Prevention:** Set `idle_in_transaction_session_timeout` on your PostgreSQL server (PG 9.6+):

```sql
ALTER SYSTEM SET idle_in_transaction_session_timeout = '30s';
```

### 4. Missing indexes on foreign keys

**What happens:** Deleting a user takes 30 seconds. Or a simple JOIN query does a sequential scan on a million-row table.

**Why:** PostgreSQL does NOT automatically create indexes on foreign key columns. If you have `posts.author_id` referencing `users.id`, there's no index on `author_id` unless you create one. When you delete a user, PG must check every row in `posts` to see if any reference the user.

**Prevention:** Create indexes on every foreign key column. Every single one.

### 5. Statement timeout not set

**What happens:** A malformed query (missing WHERE clause, bad join) scans the entire database. It runs for 20 minutes, consuming CPU and I/O, slowing every other query.

**Prevention:** Set `statement_timeout` at the pool level and per-query for known-fast queries:

```typescript
const pool = new Pool({
  // Default timeout for all queries
  statement_timeout: 30_000, // 30 seconds
});

// Override for specific queries that need more time
await pool.query({
  text: 'SELECT ... complex report query ...',
  values: [...],
  statement_timeout: 120_000, // 2 minutes for this specific report
});
```

### 6. ORM-generated N+1 queries

**What happens:** A page that loads 50 items runs 151 queries (1 for the list + 50 × 3 for relations). Each query is fast individually, but the aggregate latency is 500ms+ and the database connection is occupied the entire time.

**Why:** ORMs make it easy to load related data lazily. Prisma's `include` helps, but if you access a relation in a loop without preloading, you get N+1.

**Prevention:** Enable query logging in development. Set a budget: any endpoint running more than 10 queries is a bug. Use `include`/`with` for known relation patterns.

### 7. Migrations on large tables without CONCURRENTLY

**What happens:** A deploy runs a migration that adds an index. The migration takes 10 minutes. During those 10 minutes, all writes to the table block, all reads queue behind the writes, and the application returns 504 timeouts.

**Why:** `CREATE INDEX` acquires an `AccessShareLock` that conflicts with writes (specifically `ShareLock` acquisition blocks `RowExclusiveLock`). On a 50M-row table, this lock is held for the entire index build.

**Prevention:** Always use `CREATE INDEX CONCURRENTLY`. Never run `ALTER TABLE ... ADD COLUMN ... DEFAULT ...` on PG < 11 without a multi-step approach.

### 8. Not handling 40001 (serialization failure)

**What happens:** You use `SERIALIZABLE` isolation for correctness. Under concurrent load, some transactions fail with `40001`. Your application treats this as an unexpected error, logs it, and returns 500 to the user.

**Why:** Serialization failures are **expected behavior**, not errors. PostgreSQL's documentation says the application must retry.

**Prevention:** Wrap serializable transactions in the retry helper from section 9.5. Add metrics tracking the retry rate — a spike means you have a contention problem.

### 9. Password in the connection string logged in plaintext

**What happens:** Your application logs the connection string for debugging. The log aggregator (Datadog, CloudWatch) now contains your database password in plaintext, visible to everyone with log access.

**Prevention:** Never log connection strings. Parse the URL and redact the password before logging:

```typescript
function redactConnectionString(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return '[unparseable connection string]';
  }
}
```

### 10. TIMESTAMP vs TIMESTAMPTZ confusion

**What happens:** A user in Tokyo creates a record at 3 PM JST. Another user in New York sees the creation time as 3 PM — but they expect 1 AM EST (the correct conversion). The application stores `TIMESTAMP WITHOUT TIME ZONE`, which loses timezone information.

**Prevention:** Always use `TIMESTAMPTZ` (timestamp with time zone). Always set your connection's timezone to UTC. Let the frontend handle display conversion.

```sql
-- In your pool's connect event or connection options:
SET timezone = 'UTC';
```
