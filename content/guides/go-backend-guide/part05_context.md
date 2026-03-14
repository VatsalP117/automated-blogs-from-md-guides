# Part 5 — Context (`context.Context`) — The Most Misunderstood Concept

> **Series:** The Definitive Go Backend Guide for Frontend Engineers
> **Prev:** [Part 4 — Middleware](./part04_middleware.md)
> **Next:** [Part 6 — Databases in Go](./part06_databases.md)

---

## Table of Contents

- [What Context Actually Is and Why It Exists](#what-context-actually-is-and-why-it-exists)
- [How Context Flows Through a Request](#how-context-flows-through-a-request)
- [WithCancel, WithTimeout, WithDeadline](#withcancel-withtimeout-withdeadline)
- [Storing and Retrieving Values from Context](#storing-and-retrieving-values-from-context)
- [How Cancellation Propagates](#how-cancellation-propagates)
- [Context in Database Queries, HTTP Clients, and Goroutines](#context-in-database-queries-http-clients-and-goroutines)
- [Common Mistakes](#common-mistakes)
- [Full End-to-End Example](#full-end-to-end-example)

---

## What Context Actually Is and Why It Exists

### The Frontend Analogy

Imagine you're fetching data in a React component. The user navigates away before the fetch completes. You use an `AbortController` to cancel the request:

```javascript
const controller = new AbortController();
fetch('/api/data', { signal: controller.signal });
// User navigates away:
controller.abort();
```

Go's `context.Context` is a more powerful, universal version of this idea. It's a value that carries:

1. **Cancellation signals** — "stop working, the caller doesn't need the result anymore"
2. **Deadlines/timeouts** — "you have 5 seconds to finish"
3. **Request-scoped values** — "this request is from user X with request ID Y"

### Why It Exists

In a backend, a single HTTP request triggers a chain of operations:

```
HTTP Handler → Service → DB Query → External API Call → Kafka Publish
```

If the client disconnects (closes their browser), **all of this work becomes pointless.** Without context, each layer would continue working, wasting CPU, holding DB connections, and waiting for network calls that no one will read.

Context lets the cancellation signal propagate from the HTTP layer all the way down to the database query. When the client disconnects, everything stops.

### The Interface

```go
type Context interface {
    Deadline() (deadline time.Time, ok bool)  // when will this context expire?
    Done() <-chan struct{}                     // channel that closes when context is cancelled
    Err() error                               // why was the context cancelled?
    Value(key interface{}) interface{}         // retrieve a stored value
}
```

---

## How Context Flows Through a Request

Context is the **first parameter** of every function in a Go backend. This is not optional — it's a strict convention:

```go
// EVERY layer takes context as its first parameter

// Handler layer
func (h *OrderHandler) Create(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context() // context comes from the HTTP request
    order, err := h.service.CreateOrder(ctx, req)
    // ...
}

// Service layer
func (s *OrderService) CreateOrder(ctx context.Context, req CreateOrderRequest) (*Order, error) {
    user, err := s.userRepo.GetByID(ctx, req.UserID) // pass context to repository
    // ...
    err = s.orderRepo.Create(ctx, order) // pass context to repository
    // ...
    err = s.eventPublisher.Publish(ctx, event) // pass context to Kafka
    return order, nil
}

// Repository layer
func (r *postgresOrderRepo) Create(ctx context.Context, order *Order) error {
    _, err := r.db.ExecContext(ctx, query, args...) // pass context to database driver
    return err
}
```

The context originates at the HTTP server (Go's `net/http` creates one per request) and flows down through every function call. If the HTTP request is cancelled (client disconnect, timeout), the context's `Done()` channel closes, and every layer that checks it can stop work.

---

## WithCancel, WithTimeout, WithDeadline

### `context.WithCancel`

Creates a child context that can be manually cancelled:

```go
func (s *Service) ProcessBatch(ctx context.Context, items []Item) error {
    // Create a cancellable child context
    ctx, cancel := context.WithCancel(ctx)
    defer cancel() // ALWAYS defer cancel to free resources

    for _, item := range items {
        select {
        case <-ctx.Done():
            // Parent was cancelled (e.g., server shutting down)
            return ctx.Err()
        default:
            if err := s.processItem(ctx, item); err != nil {
                cancel() // cancel remaining work on first error
                return err
            }
        }
    }
    return nil
}
```

### `context.WithTimeout`

The most commonly used variant — creates a context that automatically cancels after a duration:

```go
func (s *Service) GetUserWithTimeout(ctx context.Context, id string) (*User, error) {
    // This operation must complete within 3 seconds
    ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
    defer cancel() // ALWAYS defer cancel — even if timeout hasn't fired

    return s.repo.GetByID(ctx, id)
    // If the DB query takes longer than 3 seconds, ctx.Done() closes,
    // and the database driver cancels the query.
}
```

### `context.WithDeadline`

Like `WithTimeout` but with an absolute time:

```go
// "Finish by 2:00 PM" vs "Finish within 3 seconds"
deadline := time.Date(2024, 1, 1, 14, 0, 0, 0, time.UTC)
ctx, cancel := context.WithDeadline(ctx, deadline)
defer cancel()
```

### The Timeout Hierarchy

In a real request, timeouts nest:

```go
// HTTP server timeout: 30 seconds (outermost)
srv := &http.Server{
    ReadTimeout:  15 * time.Second,
    WriteTimeout: 30 * time.Second,
}

// Middleware timeout: 25 seconds (within server timeout)
r.Use(middleware.Timeout(25 * time.Second))

// Service-level timeout: 5 seconds for a specific operation
func (s *Service) CreateOrder(ctx context.Context, ...) {
    ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    // DB query timeout: 2 seconds (tightest)
    user, err := s.userRepo.GetByID(ctx, userID) // inherits 5s timeout
}
```

The **tightest timeout wins.** If the parent context expires at 25s but you set a child timeout of 5s, the child expires at 5s.

---

## Storing and Retrieving Values from Context

### How It Works

```go
type contextKey string

const (
    requestIDKey contextKey = "request_id"
    userIDKey    contextKey = "user_id"
)

// Store a value
ctx = context.WithValue(ctx, requestIDKey, "req-abc-123")

// Retrieve a value
requestID, ok := ctx.Value(requestIDKey).(string)
if !ok {
    requestID = "unknown"
}
```

### When TO Use Context Values

- **Request-scoped metadata** that flows through the entire call chain:
  - Request ID / Correlation ID
  - Authenticated user ID
  - Trace ID (for distributed tracing)
  - Locale / language preference

### When NOT TO Use Context Values

- **Function parameters.** If a function needs a user ID to do its job, make it a parameter:

```go
// BAD — hiding dependencies in context
func (s *Service) CreateOrder(ctx context.Context) (*Order, error) {
    userID := ctx.Value(userIDKey).(string) // surprise dependency!
    // ...
}

// GOOD — explicit parameter
func (s *Service) CreateOrder(ctx context.Context, userID string) (*Order, error) {
    // ...
}
```

- **Struct fields, configuration, or dependencies** — these should be injected via constructors, not context.

**Rule of thumb:** Context values are for **metadata about the request** (who, when, trace), not for **data the function needs to do its job.**

### Using Custom Types as Keys

Always use unexported custom types as context keys to prevent collisions:

```go
// BAD — string keys can collide between packages
ctx = context.WithValue(ctx, "user_id", "123")

// GOOD — package-scoped type prevents collisions
type contextKey string
const userIDKey contextKey = "user_id"
ctx = context.WithValue(ctx, userIDKey, "123")
```

---

## How Cancellation Propagates

When a context is cancelled, all of its children are cancelled too:

```
context.Background()
    └── HTTP request context (cancelled when client disconnects)
        └── Timeout context (25s)
            └── Service context (5s timeout)
                ├── DB query context  ← cancelled when parent times out
                └── HTTP client call  ← cancelled when parent times out
```

**Cancellation is cooperative.** The context doesn't magically kill goroutines. Code must check the context:

```go
// The database driver checks ctx.Done() internally:
rows, err := db.QueryContext(ctx, query, args...)
// If ctx is cancelled, QueryContext returns immediately with ctx.Err()

// For your own long-running work, check manually:
func processItems(ctx context.Context, items []Item) error {
    for _, item := range items {
        // Check if context was cancelled before processing each item
        select {
        case <-ctx.Done():
            return ctx.Err() // returns context.Canceled or context.DeadlineExceeded
        default:
        }

        if err := process(ctx, item); err != nil {
            return err
        }
    }
    return nil
}
```

---

## Context in Database Queries, HTTP Clients, and Goroutines

### Database Queries

```go
// ALWAYS use the Context variants of database methods
// These allow the query to be cancelled if the context expires

// Good — context-aware
row := db.QueryRowContext(ctx, "SELECT * FROM users WHERE id = $1", id)
_, err := db.ExecContext(ctx, "INSERT INTO orders ...", args...)

// Bad — ignores context, query runs even if client disconnected
row := db.QueryRow("SELECT * FROM users WHERE id = $1", id)
```

### HTTP Client Calls

```go
func (c *PaymentClient) Charge(ctx context.Context, req ChargeRequest) (*ChargeResponse, error) {
    body, _ := json.Marshal(req)

    // Create request WITH context — if ctx is cancelled, the HTTP call is aborted
    httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/charge", bytes.NewReader(body))
    if err != nil {
        return nil, fmt.Errorf("create request: %w", err)
    }
    httpReq.Header.Set("Content-Type", "application/json")

    resp, err := c.httpClient.Do(httpReq)
    if err != nil {
        return nil, fmt.Errorf("payment charge: %w", err)
    }
    defer resp.Body.Close()

    // ... decode response
}
```

### Goroutines

When spawning goroutines, be careful about context lifetime:

```go
// BAD — goroutine outlives the request context
func (h *Handler) CreateOrder(w http.ResponseWriter, r *http.Request) {
    order, _ := h.svc.CreateOrder(r.Context(), req)

    // This goroutine uses the request context, but the HTTP handler
    // will return (and the context will be cancelled) before the email is sent!
    go h.emailSvc.SendConfirmation(r.Context(), order) // BUG: context cancelled too soon

    respondJSON(w, http.StatusCreated, order)
}

// GOOD — use a detached context for background work
func (h *Handler) CreateOrder(w http.ResponseWriter, r *http.Request) {
    order, _ := h.svc.CreateOrder(r.Context(), req)

    // Create a new context not tied to the request lifecycle
    bgCtx := context.WithoutCancel(r.Context()) // Go 1.21+
    // Or for older Go: bgCtx := context.Background()
    go h.emailSvc.SendConfirmation(bgCtx, order)

    respondJSON(w, http.StatusCreated, order)
}
```

---

## Common Mistakes

### 1. Forgetting `defer cancel()`

```go
// BAD — leaks a goroutine and timer inside the context package
ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
// forgot defer cancel() — resource leak!

// GOOD — always defer cancel
ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
defer cancel()
```

### 2. Storing Too Much in Context

```go
// BAD — using context as a general-purpose bag
ctx = context.WithValue(ctx, "db", db)
ctx = context.WithValue(ctx, "config", config)
ctx = context.WithValue(ctx, "order", order)
// This hides dependencies and makes code impossible to understand
```

### 3. Ignoring Context in Long Operations

```go
// BAD — loops without checking context
for _, item := range thousandsOfItems {
    process(item) // if context was cancelled, this runs uselessly for minutes
}

// GOOD — check context periodically
for _, item := range thousandsOfItems {
    if ctx.Err() != nil {
        return ctx.Err()
    }
    process(ctx, item)
}
```

### 4. Wrong Timeout Placement

```go
// BAD — timeout inside a loop creates a new timeout for each iteration
for _, id := range userIDs {
    ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
    user, _ := repo.GetByID(ctx, id) // each gets 5s — total could be N*5s
    cancel()
}

// GOOD — single timeout for the entire batch operation
ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
defer cancel()
for _, id := range userIDs {
    user, _ := repo.GetByID(ctx, id) // all share the 10s budget
}
```

---

## Full End-to-End Example

Showing context flowing from HTTP request through every layer:

```go
// === Handler ===
func (h *OrderHandler) Create(w http.ResponseWriter, r *http.Request) {
    // r.Context() carries: request ID (from middleware), user ID (from auth middleware),
    // timeout (from timeout middleware), cancellation (from net/http if client disconnects)
    ctx := r.Context()

    var req CreateOrderRequest
    if err := decodeJSON(r, &req); err != nil {
        respondError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
        return
    }

    userID := UserIDFromContext(ctx) // extracted from context (set by auth middleware)

    order, err := h.svc.CreateOrder(ctx, userID, req)
    if err != nil {
        handleError(w, err)
        return
    }

    respondJSON(w, http.StatusCreated, order)
}

// === Service ===
func (s *OrderService) CreateOrder(ctx context.Context, userID string, req CreateOrderRequest) (*Order, error) {
    // Add a tighter timeout for the DB-heavy part of this operation
    ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
    defer cancel()

    // Each of these calls receives the context and will abort if it expires
    user, err := s.userRepo.GetByID(ctx, userID)
    if err != nil {
        return nil, fmt.Errorf("get user: %w", err)
    }

    // Verify stock for all items (parallel with context)
    g, ctx := errgroup.WithContext(ctx)
    for _, item := range req.Items {
        item := item
        g.Go(func() error {
            stock, err := s.inventoryClient.CheckStock(ctx, item.ProductID)
            if err != nil {
                return fmt.Errorf("check stock for %s: %w", item.ProductID, err)
            }
            if stock < item.Quantity {
                return model.ErrInsufficientStock
            }
            return nil
        })
    }
    if err := g.Wait(); err != nil {
        return nil, err
    }

    // Create the order in the database
    order, err := s.orderRepo.Create(ctx, &Order{UserID: userID, Items: req.Items})
    if err != nil {
        return nil, fmt.Errorf("create order: %w", err)
    }

    return order, nil
}

// === Repository ===
func (r *postgresOrderRepo) Create(ctx context.Context, order *Order) (*Order, error) {
    // The context is passed to the database driver — if it expires,
    // the query is cancelled at the database level
    _, err := r.db.ExecContext(ctx,
        `INSERT INTO orders (id, user_id, status, created_at) VALUES ($1, $2, $3, $4)`,
        order.ID, order.UserID, order.Status, order.CreatedAt,
    )
    if err != nil {
        return nil, fmt.Errorf("insert order: %w", err)
    }
    return order, nil
}

// === External HTTP Client ===
func (c *InventoryClient) CheckStock(ctx context.Context, productID string) (int, error) {
    // Context flows into the HTTP request — if parent context is cancelled,
    // this HTTP call is aborted immediately
    req, err := http.NewRequestWithContext(ctx, http.MethodGet,
        fmt.Sprintf("%s/products/%s/stock", c.baseURL, productID), nil)
    if err != nil {
        return 0, err
    }

    resp, err := c.httpClient.Do(req)
    if err != nil {
        return 0, fmt.Errorf("check stock: %w", err)
    }
    defer resp.Body.Close()

    var result struct{ Quantity int }
    json.NewDecoder(resp.Body).Decode(&result)
    return result.Quantity, nil
}
```

In this example, if the user closes their browser:

1. The HTTP server cancels the request context.
2. The service's `errgroup` notices and stops spawning goroutines.
3. Any in-flight DB queries are cancelled.
4. Any in-flight HTTP calls to the inventory service are cancelled.
5. Resources are freed across the entire call chain.

This is the power of context.

---

→ **Continued in [Part 6 — Databases in Go](./part06_databases.md)**
