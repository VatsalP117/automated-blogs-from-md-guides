# Part 17 — Code Review & Contribution Patterns

> **Series:** The Definitive Go Backend Guide for Frontend Engineers
> **Prev:** [Part 16 — Deployment & Production Readiness](./part16_deployment.md)
> **Next:** — (End of Guide)

---

## Table of Contents

- [How to Read an Unfamiliar Go Codebase](#how-to-read-an-unfamiliar-go-codebase)
- [Common Go Code Review Feedback](#common-go-code-review-feedback)
- [Go Idioms Every Reviewer Expects](#go-idioms-every-reviewer-expects)
- [How to Write a PR Description for a Backend Change](#how-to-write-a-pr-description)
- [How to Trace a Bug in a Service You've Never Seen](#how-to-trace-a-bug)

---

## How to Read an Unfamiliar Go Codebase

When you join a team and need to understand their Go service, follow this order:

### Step 1: Read `cmd/server/main.go`

This is the entry point. It shows you:

- What dependencies exist (database, Kafka, Redis, external services).
- How they're wired together.
- What the startup sequence looks like.

```go
// main.go tells you the entire architecture at a glance:
func main() {
    cfg := config.Load()
    db := connectDB(cfg)       // ← "this service uses a database"
    redis := connectRedis(cfg) // ← "this service uses Redis"
    kafka := connectKafka(cfg) // ← "this service produces/consumes Kafka"

    userRepo := repository.NewPostgresUserRepo(db)
    orderRepo := repository.NewPostgresOrderRepo(db)
    userSvc := service.NewUserService(userRepo, redis)
    orderSvc := service.NewOrderService(orderRepo, userSvc, kafka)
    // ← "OrderService depends on UserService and Kafka"

    router := api.NewRouter(userSvc, orderSvc)
    // ← "now I'll go read NewRouter to see the API endpoints"
}
```

### Step 2: Read `internal/api/router.go`

This shows you every endpoint the service exposes:

```go
r.Route("/api/v1", func(r chi.Router) {
    r.Get("/users", userHandler.List)          // ← endpoint 1
    r.Post("/orders", orderHandler.Create)     // ← endpoint 2
    r.Post("/orders/{id}/cancel", orderHandler.Cancel)  // ← endpoint 3
})
```

Now you have a map of the entire API surface.

### Step 3: Pick One Endpoint and Read Vertically

Choose the endpoint most relevant to your task. Read from top to bottom:

```
Router → Handler → Service → Repository → SQL
```

This gives you the full picture of how one request flows through all layers.

### Step 4: Read the Migrations

`migrations/` tells you the database schema — what tables exist, what indexes are defined, and how the schema evolved over time.

### Step 5: Read the Tests

Tests are documentation. They show you:

- What inputs the system accepts.
- What outputs it produces.
- What edge cases the team cares about.

### Cheat Sheet

| Want to know... | Look at... |
|---|---|
| What this service does | `README.md`, `cmd/server/main.go` |
| What endpoints exist | `internal/api/router.go` |
| What the data model looks like | `internal/model/` |
| How data is stored | `internal/repository/`, `migrations/` |
| What business rules exist | `internal/service/` |
| What errors can happen | `internal/model/errors.go` |
| How the service talks to others | `internal/client/`, Kafka producer/consumer |
| What config is needed | `internal/config/config.go` |

---

## Common Go Code Review Feedback

These are the comments you'll see most often on your PRs:

### 1. "Please handle this error"

```go
// Reviewer will flag this immediately
result, _ := db.ExecContext(ctx, query, args...) // ignored error!

// Fix: always handle errors
result, err := db.ExecContext(ctx, query, args...)
if err != nil {
    return fmt.Errorf("execute query: %w", err)
}
```

### 2. "Don't use naked returns"

```go
// BAD — unclear what's being returned
func getUser() (user *User, err error) {
    // ...
    return // what is returned? have to read the whole function to know
}

// GOOD — explicit
func getUser() (*User, error) {
    // ...
    return user, nil
}
```

### 3. "Wrap the error with context"

```go
// BAD — raw error, no context
if err != nil {
    return err
}

// GOOD — context about what failed
if err != nil {
    return fmt.Errorf("create order for user %s: %w", userID, err)
}
```

### 4. "Use context-aware methods"

```go
// BAD
db.Query(query, args...)
http.Get(url)

// GOOD
db.QueryContext(ctx, query, args...)
http.NewRequestWithContext(ctx, method, url, body)
```

### 5. "This should be an interface"

```go
// BAD — service directly depends on concrete Postgres repo
type OrderService struct {
    repo *PostgresOrderRepo  // concrete type — can't mock in tests
}

// GOOD — depends on interface
type OrderService struct {
    repo OrderRepository  // interface — testable, swappable
}
```

### 6. "Close this resource"

```go
// BAD — rows are never closed, connection leaks
rows, err := db.QueryContext(ctx, query)
for rows.Next() { ... }

// GOOD
rows, err := db.QueryContext(ctx, query)
if err != nil { return err }
defer rows.Close()
```

### 7. "Don't expose internal errors to the client"

```go
// BAD — leaks database error details
respondError(w, 500, err.Error())
// Response: {"error": "pq: duplicate key value violates unique constraint \"users_email_key\""}

// GOOD — generic message to client, detailed error in logs
logger.Error("create user failed", zap.Error(err))
respondError(w, 500, "INTERNAL_ERROR", "an unexpected error occurred")
```

### 8. "This struct should be unexported"

```go
// BAD — exported types that are only used within the package
type helperData struct { ... } // should start with lowercase if package-private

// Convention: only export what external packages need
```

---

## Go Idioms Every Reviewer Expects

### Accept Interfaces, Return Structs

```go
// Constructor accepts interface (flexible), returns concrete type (useful)
func NewOrderService(repo OrderRepository) *OrderService {
    return &OrderService{repo: repo}
}
```

### Errors Are Values, Not Strings

```go
// Check with errors.Is, not string comparison
if errors.Is(err, ErrNotFound) { ... }

// NOT
if err.Error() == "not found" { ... }
```

### Zero Values Are Useful

```go
// In Go, the zero value of a type is usable:
var mu sync.Mutex // ready to use, no initialization needed
var buf bytes.Buffer // ready to use
var wg sync.WaitGroup // ready to use
```

### Early Return

```go
// BAD — deep nesting
func process(order *Order) error {
    if order != nil {
        if order.Status == "pending" {
            if len(order.Items) > 0 {
                // actual logic buried 3 levels deep
            }
        }
    }
}

// GOOD — guard clauses, early return
func process(order *Order) error {
    if order == nil {
        return fmt.Errorf("order is nil")
    }
    if order.Status != "pending" {
        return fmt.Errorf("order not pending")
    }
    if len(order.Items) == 0 {
        return fmt.Errorf("order has no items")
    }

    // actual logic at the top level
}
```

### Naming Conventions

```go
// Short variable names for short scope
for i, v := range items { ... }     // i, v are fine
if err := doSomething(); err != nil  // err is standard

// Descriptive names for wider scope
type OrderService struct { ... }     // full words
func (s *OrderService) CreateOrder   // receiver is single letter of type

// Interfaces end in -er for single-method interfaces
type Reader interface { Read(p []byte) (int, error) }
type Stringer interface { String() string }

// Multi-method interfaces describe capability
type OrderRepository interface { ... }
```

---

## How to Write a PR Description

A good backend PR description:

```markdown
## What

Add order cancellation endpoint (POST /api/v1/orders/{id}/cancel)

## Why

Users currently can't cancel pending orders through the API.
Ticket: JIRA-1234

## Changes

- **Handler**: Added `CancelOrder` handler with input validation
- **Service**: Added cancellation logic — only pending orders can be cancelled
- **Repository**: Added `UpdateStatus` method
- **Migration**: Added index on `orders.status` for query performance
- **Tests**: Unit tests for service logic, integration test for handler

## API

```
POST /api/v1/orders/{id}/cancel
Authorization: Bearer <token>

Response 200:
{
  "data": {
    "id": "order-123",
    "status": "cancelled",
    ...
  }
}

Response 409 (order not cancellable):
{
  "error": {
    "code": "INVALID_STATUS",
    "message": "order cannot be cancelled in current status"
  }
}
```

## Migration

```sql
CREATE INDEX idx_orders_status ON orders (status);
```

Backwards compatible — index only, no schema change.

## Testing

- [x] Unit tests for CancelOrder service method
- [x] Handler test for success and error cases
- [x] Tested manually against local DB
- [x] `go test -race ./...` passes

## Rollback

Safe to rollback — the new endpoint simply won't exist. Index can be
dropped separately if needed.
```

---

## How to Trace a Bug

When you get a bug report for a service you've never seen:

### Step 1: Get the Request ID

Every production request has a request ID (from the middleware in Part 4). Ask for it, or find it in the error report.

### Step 2: Search Logs

```bash
# In your log aggregator (Datadog, Kibana, etc.)
# Search: request_id:"req-abc-123"
```

This shows you every log line from that request — across all layers (handler, service, repository).

### Step 3: Read the Error Chain

The logs will show something like:

```
level=error msg="request failed" request_id=req-abc-123
  error="cancel order: update status: pq: deadlock detected"
```

Read right to left: `pq: deadlock detected` → `update status` → `cancel order`. The database had a deadlock when the service tried to update the order status during cancellation.

### Step 4: Find the Code Path

Search for "cancel order" in the codebase. You'll find the service method. Read the code to understand what SQL it runs and under what conditions.

### Step 5: Reproduce

Write a test that triggers the same condition:

```go
func TestCancelOrder_ConcurrentCancellation(t *testing.T) {
    // Two goroutines try to cancel the same order simultaneously
    // This should reproduce the deadlock
}
```

### Step 6: Fix and Verify

Fix the bug (add proper locking, retry on deadlock, etc.), verify the test passes, deploy to staging, confirm the fix.

### Debugging Toolkit

| Tool | Use |
|---|---|
| Log aggregator (Datadog, ELK) | Search by request ID, user ID, error pattern |
| `go test -race ./...` | Detect data races |
| `pprof` (built into Go) | CPU and memory profiling |
| `grpcurl` | Test gRPC endpoints manually |
| `curl` | Test HTTP endpoints manually |
| SQL client (pgcli, DataGrip) | Inspect database state directly |
| Kafka UI (Conduktor, AKHQ) | Inspect messages in topics |
| Grafana + Prometheus | Check latency, error rate, throughput dashboards |
| Jaeger / Zipkin | View distributed traces across services |

---

## Congratulations

You've completed the entire guide. Here's what you now understand:

| Part | What You Learned |
|---|---|
| 0 | How to think like a backend engineer |
| 1 | Go features that matter in production |
| 2 | How real services are structured |
| 3 | Building REST APIs with Chi |
| 4 | Middleware — the backbone of every service |
| 5 | Context — request lifecycle management |
| 6 | Databases — raw SQL, sqlx, sqlc, GORM, connection pooling |
| 7 | Concurrency — goroutines, channels, mutexes, worker pools |
| 8 | Authentication and authorization |
| 9 | Configuration and secrets management |
| 10 | Logging, metrics, tracing, health checks |
| 11 | Kafka, message queues, outbox pattern |
| 12 | gRPC for internal service communication |
| 13 | Testing at every level |
| 14 | Error handling that scales |
| 15 | Service-to-service communication with resilience |
| 16 | Docker, Kubernetes, graceful shutdown |
| 17 | Code review and debugging in production |

The gap between "I know Go syntax" and "I can work on a production backend" is now bridged. The next step is to apply these patterns in a real codebase — and the best way to learn is by reading, running, and modifying existing production code.

---

**End of Guide**
