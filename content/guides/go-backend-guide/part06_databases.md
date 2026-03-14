# Part 6 — Databases in Go

> **Series:** The Definitive Go Backend Guide for Frontend Engineers
> **Prev:** [Part 5 — Context](./part05_context.md)
> **Next:** [Part 7 — Concurrency](./part07_concurrency.md)

---

## Table of Contents

- [6A — Raw SQL with database/sql and sqlx](#6a--raw-sql-with-databasesql-and-sqlx)
- [6B — Query Builder: sqlc](#6b--query-builder-sqlc)
- [6C — ORM: GORM](#6c--orm-gorm)
- [6D — Connection Pooling & Performance](#6d--connection-pooling--performance)
- [6E — Full Repository Layer Example](#6e--full-repository-layer-example)

---

## 6A — Raw SQL with database/sql and sqlx

### How `database/sql` Works

Go's standard library includes `database/sql`, a database-agnostic interface. It doesn't contain any database drivers — you import a driver separately, and it registers itself:

```go
import (
    "database/sql"
    _ "github.com/lib/pq" // PostgreSQL driver — blank import registers the driver
)

func main() {
    // sql.Open doesn't actually connect — it prepares the connection pool
    db, err := sql.Open("postgres", "postgres://user:pass@localhost:5432/mydb?sslmode=disable")
    if err != nil {
        log.Fatal(err)
    }
    defer db.Close()

    // Ping actually connects and verifies the database is reachable
    if err := db.Ping(); err != nil {
        log.Fatal("database unreachable:", err)
    }
}
```

**Key concept:** `sql.DB` is NOT a single connection. It is a **connection pool** that manages multiple connections automatically. You create it once and share it across your entire application.

### Basic Queries with `database/sql`

```go
// Query a single row
var user struct {
    ID    string
    Email string
    Name  string
}

err := db.QueryRowContext(ctx,
    `SELECT id, email, name FROM users WHERE id = $1`, userID,
).Scan(&user.ID, &user.Email, &user.Name)

if err == sql.ErrNoRows {
    return nil, ErrUserNotFound
}
if err != nil {
    return nil, fmt.Errorf("query user: %w", err)
}
```

**The problem:** With `database/sql`, you must manually `Scan` each column into each field. This is tedious and error-prone for large structs.

### Why Companies Use `sqlx`

`sqlx` extends `database/sql` with automatic struct scanning. It maps database columns to struct fields using `db` tags:

```go
import "github.com/jmoiron/sqlx"

type User struct {
    ID             string    `db:"id"`
    Email          string    `db:"email"`
    Name           string    `db:"name"`
    HashedPassword string    `db:"hashed_password"`
    CreatedAt      time.Time `db:"created_at"`
}

// Get a single row — maps columns to struct fields automatically
func (r *repo) GetByID(ctx context.Context, id string) (*User, error) {
    var user User
    err := r.db.GetContext(ctx, &user,
        `SELECT id, email, name, hashed_password, created_at FROM users WHERE id = $1`, id)
    if err == sql.ErrNoRows {
        return nil, ErrUserNotFound
    }
    if err != nil {
        return nil, fmt.Errorf("get user %s: %w", id, err)
    }
    return &user, nil
}

// Get multiple rows
func (r *repo) ListByOrg(ctx context.Context, orgID string, limit, offset int) ([]*User, error) {
    var users []*User
    err := r.db.SelectContext(ctx, &users,
        `SELECT id, email, name, created_at FROM users 
         WHERE organization_id = $1 
         ORDER BY created_at DESC 
         LIMIT $2 OFFSET $3`,
        orgID, limit, offset)
    if err != nil {
        return nil, fmt.Errorf("list users for org %s: %w", orgID, err)
    }
    return users, nil
}

// Insert
func (r *repo) Create(ctx context.Context, user *User) error {
    _, err := r.db.ExecContext(ctx,
        `INSERT INTO users (id, email, name, hashed_password, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        user.ID, user.Email, user.Name, user.HashedPassword, user.CreatedAt)
    if err != nil {
        return fmt.Errorf("insert user: %w", err)
    }
    return nil
}
```

### Named Queries with `sqlx`

```go
// Instead of positional $1, $2, use named parameters
func (r *repo) Create(ctx context.Context, user *User) error {
    _, err := r.db.NamedExecContext(ctx,
        `INSERT INTO users (id, email, name, hashed_password, created_at)
         VALUES (:id, :email, :name, :hashed_password, :created_at)`, user)
    if err != nil {
        return fmt.Errorf("insert user: %w", err)
    }
    return nil
}
```

### Transactions

Transactions ensure multiple operations succeed or fail atomically:

```go
func (r *repo) CreateOrderWithItems(ctx context.Context, order *Order, items []OrderItem) error {
    // Begin transaction
    tx, err := r.db.BeginTxx(ctx, nil)
    if err != nil {
        return fmt.Errorf("begin tx: %w", err)
    }
    // Defer rollback — this is a no-op if Commit() is called first
    defer tx.Rollback()

    // Insert order
    _, err = tx.ExecContext(ctx,
        `INSERT INTO orders (id, user_id, status, total_amount, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        order.ID, order.UserID, order.Status, order.TotalAmount, order.CreatedAt)
    if err != nil {
        return fmt.Errorf("insert order: %w", err)
    }

    // Insert each order item
    for _, item := range items {
        _, err = tx.ExecContext(ctx,
            `INSERT INTO order_items (id, order_id, product_id, quantity, price_each)
             VALUES ($1, $2, $3, $4, $5)`,
            item.ID, order.ID, item.ProductID, item.Quantity, item.PriceEach)
        if err != nil {
            return fmt.Errorf("insert order item: %w", err)
        }
    }

    // Deduct inventory
    for _, item := range items {
        result, err := tx.ExecContext(ctx,
            `UPDATE products SET stock = stock - $1 
             WHERE id = $2 AND stock >= $1`,
            item.Quantity, item.ProductID)
        if err != nil {
            return fmt.Errorf("deduct stock: %w", err)
        }
        rows, _ := result.RowsAffected()
        if rows == 0 {
            return ErrInsufficientStock // triggers rollback via defer
        }
    }

    // Commit — if this succeeds, defer Rollback() becomes a no-op
    if err := tx.Commit(); err != nil {
        return fmt.Errorf("commit tx: %w", err)
    }
    return nil
}
```

### Database Migrations with golang-migrate

Migrations are versioned SQL files that evolve your schema:

```sql
-- migrations/000001_create_users.up.sql
CREATE TABLE users (
    id          VARCHAR(36) PRIMARY KEY,
    email       VARCHAR(255) UNIQUE NOT NULL,
    name        VARCHAR(100) NOT NULL,
    hashed_password VARCHAR(255) NOT NULL,
    organization_id VARCHAR(36) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users (email);
CREATE INDEX idx_users_organization_id ON users (organization_id);
```

```sql
-- migrations/000001_create_users.down.sql
DROP TABLE IF EXISTS users;
```

```sql
-- migrations/000002_create_orders.up.sql
CREATE TABLE orders (
    id          VARCHAR(36) PRIMARY KEY,
    user_id     VARCHAR(36) NOT NULL REFERENCES users(id),
    status      VARCHAR(20) NOT NULL DEFAULT 'pending',
    total_amount BIGINT NOT NULL,
    currency    VARCHAR(3) NOT NULL DEFAULT 'USD',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_orders_user_id ON orders (user_id);
CREATE INDEX idx_orders_status ON orders (status);
```

```bash
# Run migrations
migrate -path migrations -database "$DATABASE_URL" up

# Rollback last migration
migrate -path migrations -database "$DATABASE_URL" down 1

# Create a new migration
migrate create -ext sql -dir migrations -seq add_order_items
```

---

## 6B — Query Builder: sqlc

### What sqlc Does

`sqlc` takes a radically different approach: you write SQL, and it generates type-safe Go code. No runtime reflection, no struct tag magic.

**Workflow:**

```
Write SQL queries → Run sqlc generate → Get type-safe Go functions
```

### Configuration

```yaml
# sqlc.yaml
version: "2"
sql:
  - engine: "postgresql"
    queries: "queries/"
    schema: "migrations/"
    gen:
      go:
        package: "db"
        out: "internal/db"
        sql_package: "pgx/v5"
        emit_json_tags: true
        emit_prepared_queries: false
```

### Write SQL

```sql
-- queries/users.sql

-- name: GetUserByID :one
SELECT id, email, name, created_at
FROM users
WHERE id = $1;

-- name: ListUsersByOrg :many
SELECT id, email, name, created_at
FROM users
WHERE organization_id = $1
ORDER BY created_at DESC
LIMIT $2 OFFSET $3;

-- name: CreateUser :one
INSERT INTO users (id, email, name, hashed_password, organization_id, created_at)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING id, email, name, created_at;

-- name: UpdateUserEmail :exec
UPDATE users SET email = $2, updated_at = NOW() WHERE id = $1;

-- name: DeleteUser :exec
DELETE FROM users WHERE id = $1;
```

### Generated Code (what sqlc produces)

```go
// internal/db/users.sql.go — AUTO-GENERATED by sqlc

type GetUserByIDParams struct {
    ID string
}

type GetUserByIDRow struct {
    ID        string    `json:"id"`
    Email     string    `json:"email"`
    Name      string    `json:"name"`
    CreatedAt time.Time `json:"created_at"`
}

func (q *Queries) GetUserByID(ctx context.Context, id string) (GetUserByIDRow, error) {
    row := q.db.QueryRow(ctx, getUserByID, id)
    var i GetUserByIDRow
    err := row.Scan(&i.ID, &i.Email, &i.Name, &i.CreatedAt)
    return i, err
}
```

### Why Large Codebases Love sqlc

1. **Compile-time safety** — if your SQL is wrong, `sqlc generate` fails. You don't find out at runtime.
2. **No runtime reflection** — faster than sqlx and GORM.
3. **SQL is the source of truth** — no ORM magic hiding what queries actually run.
4. **Easy to review** — PR reviewers see the actual SQL, not abstracted method chains.

---

## 6C — ORM: GORM

### When GORM Makes Sense

GORM is Go's most popular ORM. It's useful for rapid prototyping and CRUD-heavy services where you want to write less SQL.

```go
import "gorm.io/gorm"

type User struct {
    ID        string    `gorm:"primaryKey;type:varchar(36)"`
    Email     string    `gorm:"uniqueIndex;type:varchar(255);not null"`
    Name      string    `gorm:"type:varchar(100);not null"`
    Orders    []Order   `gorm:"foreignKey:UserID"` // has-many relationship
    CreatedAt time.Time
    UpdatedAt time.Time
}

type Order struct {
    ID          string `gorm:"primaryKey;type:varchar(36)"`
    UserID      string `gorm:"type:varchar(36);not null;index"`
    Status      string `gorm:"type:varchar(20);not null;default:'pending'"`
    TotalAmount int64  `gorm:"not null"`
    CreatedAt   time.Time
    UpdatedAt   time.Time
}

// CRUD operations
func (r *gormRepo) Create(ctx context.Context, user *User) error {
    return r.db.WithContext(ctx).Create(user).Error
}

func (r *gormRepo) GetByID(ctx context.Context, id string) (*User, error) {
    var user User
    err := r.db.WithContext(ctx).First(&user, "id = ?", id).Error
    if errors.Is(err, gorm.ErrRecordNotFound) {
        return nil, ErrUserNotFound
    }
    return &user, err
}

func (r *gormRepo) ListWithOrders(ctx context.Context, orgID string) ([]User, error) {
    var users []User
    err := r.db.WithContext(ctx).
        Preload("Orders").                  // eager-load orders
        Where("organization_id = ?", orgID).
        Order("created_at DESC").
        Find(&users).Error
    return users, err
}
```

### Common GORM Traps

1. **N+1 queries** — Without `Preload`, accessing `user.Orders` triggers a separate query for each user.
2. **Silent failures** — GORM's `Update` doesn't error when no rows match. Check `RowsAffected`.
3. **Automatic migrations** — `db.AutoMigrate(&User{})` is fine for development but never use in production. Use proper migration files.
4. **Hidden queries** — GORM generates SQL you can't see without enabling debug logging. In production, surprise queries cause performance issues.

---

## 6D — Connection Pooling & Performance

### Configuring the Connection Pool

```go
db, _ := sqlx.Connect("postgres", databaseURL)

// Maximum number of open connections to the database.
// Too high: overwhelms the database.
// Too low: requests queue up waiting for connections.
// Rule of thumb: start with 25, tune based on load testing.
db.SetMaxOpenConns(25)

// Maximum number of idle connections kept in the pool.
// These are connections ready to be reused without the overhead of establishing a new one.
db.SetMaxIdleConns(5)

// Maximum time a connection can be reused.
// Prevents using stale connections (e.g., after DB failover).
db.SetConnMaxLifetime(5 * time.Minute)

// Maximum time a connection can sit idle before being closed.
db.SetConnMaxIdleTime(1 * time.Minute)
```

### Connection Pool Exhaustion

This is a common production outage cause. All connections are in use, and new queries block indefinitely:

**Symptoms:**

- Requests start timing out.
- Logs show "context deadline exceeded" on DB queries.
- DB shows many open connections from your service.

**Causes:**

- Not closing `sql.Rows` after iterating (connection is held until rows are closed).
- Long-running transactions holding connections.
- Missing context timeouts on queries (queries run forever, holding connections).
- `MaxOpenConns` set too low for the traffic.

**Prevention:**

```go
// ALWAYS close rows
rows, err := db.QueryContext(ctx, query)
if err != nil { return err }
defer rows.Close() // CRITICAL — releases the connection back to the pool

// ALWAYS use context with timeouts
ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
defer cancel()
row := db.QueryRowContext(ctx, query, args...)

// ALWAYS defer rollback on transactions
tx, _ := db.BeginTx(ctx, nil)
defer tx.Rollback()
```

---

## 6E — Full Repository Layer Example

```go
// internal/repository/order_repository.go

package repository

import (
    "context"

    "github.com/yourcompany/order-service/internal/model"
)

type OrderRepository interface {
    Create(ctx context.Context, order *model.Order, items []model.OrderItem) error
    GetByID(ctx context.Context, id string) (*model.Order, error)
    ListByUser(ctx context.Context, userID string, limit, offset int) ([]*model.Order, int, error)
    UpdateStatus(ctx context.Context, id string, status model.OrderStatus) error
}
```

```go
// internal/repository/postgres_order.go

package repository

import (
    "context"
    "database/sql"
    "fmt"

    "github.com/jmoiron/sqlx"
    "github.com/yourcompany/order-service/internal/model"
)

type postgresOrderRepo struct {
    db *sqlx.DB
}

func NewPostgresOrderRepository(db *sqlx.DB) OrderRepository {
    return &postgresOrderRepo{db: db}
}

func (r *postgresOrderRepo) GetByID(ctx context.Context, id string) (*model.Order, error) {
    var order model.Order
    err := r.db.GetContext(ctx, &order,
        `SELECT id, user_id, status, total_amount, currency, created_at, updated_at 
         FROM orders WHERE id = $1`, id)
    if err == sql.ErrNoRows {
        return nil, model.ErrOrderNotFound
    }
    if err != nil {
        return nil, fmt.Errorf("get order %s: %w", id, err)
    }

    // Load order items
    var items []model.OrderItem
    err = r.db.SelectContext(ctx, &items,
        `SELECT id, order_id, product_id, quantity, price_each 
         FROM order_items WHERE order_id = $1`, id)
    if err != nil {
        return nil, fmt.Errorf("get order items for %s: %w", id, err)
    }
    order.Items = items

    return &order, nil
}

func (r *postgresOrderRepo) ListByUser(ctx context.Context, userID string, limit, offset int) ([]*model.Order, int, error) {
    // Get total count for pagination metadata
    var total int
    err := r.db.GetContext(ctx, &total,
        `SELECT COUNT(*) FROM orders WHERE user_id = $1`, userID)
    if err != nil {
        return nil, 0, fmt.Errorf("count orders: %w", err)
    }

    var orders []*model.Order
    err = r.db.SelectContext(ctx, &orders,
        `SELECT id, user_id, status, total_amount, currency, created_at, updated_at 
         FROM orders WHERE user_id = $1 
         ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        userID, limit, offset)
    if err != nil {
        return nil, 0, fmt.Errorf("list orders: %w", err)
    }

    return orders, total, nil
}

func (r *postgresOrderRepo) Create(ctx context.Context, order *model.Order, items []model.OrderItem) error {
    tx, err := r.db.BeginTxx(ctx, nil)
    if err != nil {
        return fmt.Errorf("begin tx: %w", err)
    }
    defer tx.Rollback()

    _, err = tx.ExecContext(ctx,
        `INSERT INTO orders (id, user_id, status, total_amount, currency, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        order.ID, order.UserID, order.Status, order.TotalAmount,
        order.Currency, order.CreatedAt, order.UpdatedAt)
    if err != nil {
        return fmt.Errorf("insert order: %w", err)
    }

    for _, item := range items {
        _, err = tx.ExecContext(ctx,
            `INSERT INTO order_items (id, order_id, product_id, quantity, price_each)
             VALUES ($1, $2, $3, $4, $5)`,
            item.ID, order.ID, item.ProductID, item.Quantity, item.PriceEach)
        if err != nil {
            return fmt.Errorf("insert order item: %w", err)
        }
    }

    if err := tx.Commit(); err != nil {
        return fmt.Errorf("commit tx: %w", err)
    }
    return nil
}

func (r *postgresOrderRepo) UpdateStatus(ctx context.Context, id string, status model.OrderStatus) error {
    result, err := r.db.ExecContext(ctx,
        `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2`,
        status, id)
    if err != nil {
        return fmt.Errorf("update order status: %w", err)
    }

    rows, _ := result.RowsAffected()
    if rows == 0 {
        return model.ErrOrderNotFound
    }
    return nil
}
```

---

→ **Continued in [Part 7 — Concurrency in Go](./part07_concurrency.md)**
