# Part 1 — Go Fundamentals That Actually Matter in Backend

> **Series:** The Definitive Go Backend Guide for Frontend Engineers
> **Prev:** [Part 0 — Mindset Shift](./part00_mindset_shift.md)
> **Next:** [Part 2 — Project Structure](./part02_project_structure.md)

---

## Table of Contents

- [Interfaces — Decoupling, Mocking, and Testability](#interfaces--decoupling-mocking-and-testability)
- [Structs and Embedding — Go's Alternative to Inheritance](#structs-and-embedding--gos-alternative-to-inheritance)
- [Pointers — When, Why, and How They Cause Bugs](#pointers--when-why-and-how-they-cause-bugs)
- [Error Handling — The Go Philosophy](#error-handling--the-go-philosophy)
- [Defer, Panic, Recover — Real Use Cases](#defer-panic-recover--real-use-cases)
- [Init Functions and Package-Level Variables](#init-functions-and-package-level-variables)
- [Type Aliases and Custom Types](#type-aliases-and-custom-types)
- [Variadic Functions and the Functional Options Pattern](#variadic-functions-and-the-functional-options-pattern)

---

This part covers only the Go language features that appear **constantly** in real backend code. If you already know basic syntax, this section tells you **how and why** these features are used in production.

---

## Interfaces — Decoupling, Mocking, and Testability

### The Frontend Analogy

In TypeScript, you might define an interface to type-check an object:

```typescript
interface User {
  id: string;
  name: string;
}
```

In Go, interfaces serve a completely different purpose. They define **behavior**, not shape. And critically, they are **satisfied implicitly** — a type doesn't declare "I implement this interface." If it has the right methods, it implements it. Period.

### Why Interfaces Are Everywhere in Backend Go

In a real backend, you have layers:

```
Handler → Service → Repository → Database
```

The service layer depends on the repository layer. But you don't want the service to depend on **PostgreSQL specifically**. You want it to depend on **the concept of "something that can store and retrieve users."**

This is what interfaces give you.

### Real Production Example

```go
// repository.go — Define the contract (interface)
// This lives in the service layer or a shared package.
// It describes what the service NEEDS, not what the database PROVIDES.

type UserRepository interface {
    GetByID(ctx context.Context, id string) (*User, error)
    Create(ctx context.Context, user *User) error
    Update(ctx context.Context, user *User) error
    Delete(ctx context.Context, id string) error
    ListByOrganization(ctx context.Context, orgID string, limit, offset int) ([]*User, error)
}
```

```go
// postgres_repository.go — The real implementation

type postgresUserRepository struct {
    db *sqlx.DB // database connection pool
}

// No "implements" keyword. This struct satisfies UserRepository
// because it has all the required methods.

func NewPostgresUserRepository(db *sqlx.DB) UserRepository {
    return &postgresUserRepository{db: db}
}

func (r *postgresUserRepository) GetByID(ctx context.Context, id string) (*User, error) {
    var user User
    query := `SELECT id, email, name, created_at FROM users WHERE id = $1`
    err := r.db.GetContext(ctx, &user, query, id)
    if err != nil {
        return nil, fmt.Errorf("get user by id %s: %w", id, err)
    }
    return &user, nil
}

func (r *postgresUserRepository) Create(ctx context.Context, user *User) error {
    query := `INSERT INTO users (id, email, name, created_at) VALUES ($1, $2, $3, $4)`
    _, err := r.db.ExecContext(ctx, query, user.ID, user.Email, user.Name, user.CreatedAt)
    if err != nil {
        return fmt.Errorf("create user: %w", err)
    }
    return nil
}

// ... Update, Delete, ListByOrganization implemented similarly
```

```go
// service.go — The service depends on the interface, not the implementation

type UserService struct {
    repo   UserRepository     // interface — could be Postgres, could be a mock
    cache  CacheClient        // another interface
    logger *zap.Logger
}

func NewUserService(repo UserRepository, cache CacheClient, logger *zap.Logger) *UserService {
    return &UserService{repo: repo, cache: cache, logger: logger}
}

func (s *UserService) GetUser(ctx context.Context, id string) (*User, error) {
    // Try cache first
    user, err := s.cache.Get(ctx, "user:"+id)
    if err == nil && user != nil {
        return user, nil
    }

    // Fall back to database
    user, err = s.repo.GetByID(ctx, id)
    if err != nil {
        return nil, fmt.Errorf("get user %s: %w", id, err)
    }

    // Populate cache for next time (fire and forget — cache miss is not fatal)
    _ = s.cache.Set(ctx, "user:"+id, user, 5*time.Minute)

    return user, nil
}
```

```go
// service_test.go — In tests, you pass a mock that satisfies the same interface

type mockUserRepo struct {
    users map[string]*User
}

func (m *mockUserRepo) GetByID(ctx context.Context, id string) (*User, error) {
    user, ok := m.users[id]
    if !ok {
        return nil, fmt.Errorf("user not found")
    }
    return user, nil
}

// ... other methods return nil or dummy data

func TestGetUser(t *testing.T) {
    repo := &mockUserRepo{
        users: map[string]*User{
            "user-1": {ID: "user-1", Name: "Alice", Email: "alice@example.com"},
        },
    }
    svc := NewUserService(repo, &noopCache{}, zap.NewNop())

    user, err := svc.GetUser(context.Background(), "user-1")
    if err != nil {
        t.Fatalf("unexpected error: %v", err)
    }
    if user.Name != "Alice" {
        t.Errorf("expected Alice, got %s", user.Name)
    }
}
```

### The Key Rule: Define Interfaces Where They Are USED, Not Where They Are Implemented

In Java, you define the interface in the same package as the implementation. In Go, the convention is the opposite:

```
// YES — Interface defined by the consumer
package service
type UserRepository interface { ... }

// NO — Interface defined by the provider
package postgres
type UserRepository interface { ... }  // don't do this
```

This is called the **"accept interfaces, return structs"** principle.

### Common Mistake: Making Interfaces Too Big

```go
// BAD — This "god interface" is hard to mock and violates interface segregation
type Storage interface {
    GetUser(ctx context.Context, id string) (*User, error)
    CreateUser(ctx context.Context, user *User) error
    GetOrder(ctx context.Context, id string) (*Order, error)
    CreateOrder(ctx context.Context, order *Order) error
    GetProduct(ctx context.Context, id string) (*Product, error)
    // ... 20 more methods
}

// GOOD — Small, focused interfaces
type UserReader interface {
    GetByID(ctx context.Context, id string) (*User, error)
}
```

---

## Structs and Embedding — Go's Alternative to Inheritance

### No Classes, No Inheritance

Go has no classes and no inheritance. Instead, you compose behavior using **structs** and **embedding.** This feels foreign at first but produces cleaner, more maintainable code.

### Structs as Domain Models

Every entity in your backend is a struct:

```go
// models.go — Domain models with JSON and DB tags

type User struct {
    ID             string    `json:"id" db:"id"`
    Email          string    `json:"email" db:"email"`
    HashedPassword string    `json:"-" db:"hashed_password"`       // json:"-" hides from API responses
    Name           string    `json:"name" db:"name"`
    Role           Role      `json:"role" db:"role"`
    OrganizationID string    `json:"organization_id" db:"organization_id"`
    CreatedAt      time.Time `json:"created_at" db:"created_at"`
    UpdatedAt      time.Time `json:"updated_at" db:"updated_at"`
}

type Role string

const (
    RoleAdmin  Role = "admin"
    RoleMember Role = "member"
    RoleViewer Role = "viewer"
)
```

**Why struct tags matter:**

- `json:"id"` — controls how the field appears when serialized to JSON (your API response).
- `json:"-"` — **critical:** excludes the field from JSON. You never want to expose hashed passwords.
- `db:"id"` — used by `sqlx` to map database columns to struct fields.

### Embedding — Composition Over Inheritance

Embedding lets you include one struct inside another. The inner struct's fields and methods are "promoted" — you can access them directly.

```go
// Base model with common fields — every entity has these
type BaseModel struct {
    ID        string    `json:"id" db:"id"`
    CreatedAt time.Time `json:"created_at" db:"created_at"`
    UpdatedAt time.Time `json:"updated_at" db:"updated_at"`
}

// Order embeds BaseModel — gets ID, CreatedAt, UpdatedAt for free
type Order struct {
    BaseModel                          // embedded (no field name)
    UserID      string  `json:"user_id" db:"user_id"`
    Status      string  `json:"status" db:"status"`
    TotalAmount float64 `json:"total_amount" db:"total_amount"`
}

func main() {
    order := Order{
        BaseModel: BaseModel{
            ID:        "order-123",
            CreatedAt: time.Now(),
            UpdatedAt: time.Now(),
        },
        UserID:      "user-456",
        Status:      "pending",
        TotalAmount: 99.99,
    }

    // Access promoted fields directly
    fmt.Println(order.ID)        // "order-123" — no need for order.BaseModel.ID
    fmt.Println(order.CreatedAt) // works directly
}
```

### Embedding Interfaces (Advanced Pattern)

You can embed interfaces in structs. This is used in the **middleware pattern** and in the **decorator pattern:**

```go
// A logging wrapper around any UserRepository implementation
type loggingUserRepo struct {
    UserRepository            // embed the interface
    logger         *zap.Logger
}

func NewLoggingUserRepo(repo UserRepository, logger *zap.Logger) UserRepository {
    return &loggingUserRepo{UserRepository: repo, logger: logger}
}

// Override only the methods you want to add behavior to
func (r *loggingUserRepo) GetByID(ctx context.Context, id string) (*User, error) {
    r.logger.Info("getting user", zap.String("user_id", id))
    user, err := r.UserRepository.GetByID(ctx, id) // delegate to the wrapped repo
    if err != nil {
        r.logger.Error("failed to get user", zap.String("user_id", id), zap.Error(err))
    }
    return user, err
}
```

### Common Mistake: Over-Embedding

```go
// BAD — Embeds too much, unclear what this struct actually is
type SuperService struct {
    UserService
    OrderService
    PaymentService
    NotificationService
}
// Methods from all four services are promoted — collision risk, hard to read.

// GOOD — Use named fields when you need multiple dependencies
type OrderHandler struct {
    userSvc    *UserService
    orderSvc   *OrderService
    paymentSvc *PaymentService
}
```

---

## Pointers — When, Why, and How They Cause Bugs

### What Pointers Actually Are

A pointer is a variable that holds the **memory address** of another value. In frontend terms, think of it like a reference vs. a copy.

```go
// Value type — x and y are independent copies
x := 42
y := x
y = 100
fmt.Println(x) // still 42 — changing y didn't affect x

// Pointer type — p points to x's memory location
x := 42
p := &x     // p holds the ADDRESS of x
*p = 100    // dereference p and change the value at that address
fmt.Println(x) // now 100 — we changed x through the pointer
```

### When to Use Pointers in Backend Code

| Use Case | Pointer? | Why |
|---|---|---|
| **Struct passed to a function that should modify it** | Yes `*User` | Otherwise you modify a copy and the caller doesn't see the change |
| **Large structs** (many fields) | Yes `*User` | Avoids copying a large block of memory on every function call |
| **Optional/nullable values** (field may not be present) | Yes `*string` | A pointer can be `nil`, a value type cannot |
| **Method receivers on structs** | Usually yes `(u *User)` | Consistency + allows mutation |
| **Small value types** (int, string, bool) | No | Copying is cheap, pointers add indirection |
| **Slices, maps, channels** | No | These are already reference types internally |

### The Nil Pointer — The Most Common Backend Bug

```go
func (s *UserService) GetUser(ctx context.Context, id string) (*User, error) {
    user, err := s.repo.GetByID(ctx, id)
    if err != nil {
        return nil, err
    }
    return user, nil
}

// In the handler:
func (h *Handler) GetUser(w http.ResponseWriter, r *http.Request) {
    user, err := h.service.GetUser(r.Context(), chi.URLParam(r, "id"))
    if err != nil {
        respondError(w, http.StatusNotFound, "user not found")
        return // CRITICAL: must return here
    }

    // If you forget the return above, user is nil and this panics:
    // runtime error: invalid memory address or nil pointer dereference
    fmt.Println(user.Name)
}
```

**Rule of thumb:** After any function that returns `(*Something, error)`, **always** check the error **and return** before using the pointer.

### Pointer Receivers vs. Value Receivers

```go
// Value receiver — operates on a copy, cannot modify the original
func (u User) FullName() string {
    return u.FirstName + " " + u.LastName
}

// Pointer receiver — operates on the original, can modify it
func (u *User) SetEmail(email string) {
    u.Email = email // modifies the actual user, not a copy
}
```

**Convention in production code:** If any method on a type needs a pointer receiver, use pointer receivers for ALL methods on that type. This avoids confusion.

---

## Error Handling — The Go Philosophy

### No Exceptions. No Try/Catch. Explicit Errors Everywhere.

In JavaScript:

```javascript
try {
  const user = await getUser(id);
} catch (err) {
  console.error(err);
}
```

In Go, every function that can fail returns an error as its last return value:

```go
user, err := getUser(ctx, id)
if err != nil {
    // handle the error — you MUST do this
    return fmt.Errorf("failed to get user %s: %w", id, err)
}
```

This feels verbose at first. But it has a major advantage: **you can see every possible failure point by reading the code.** There are no hidden exceptions that might fly up from deep in the call stack.

### Wrapping Errors with Context

The most important error-handling pattern in production Go code:

```go
// BAD — raw error, no context about what failed
func (s *OrderService) CreateOrder(ctx context.Context, req CreateOrderRequest) (*Order, error) {
    user, err := s.userRepo.GetByID(ctx, req.UserID)
    if err != nil {
        return nil, err // if this says "connection refused" — you have no idea WHAT was being done
    }
    // ...
}

// GOOD — wrapped with context using %w
func (s *OrderService) CreateOrder(ctx context.Context, req CreateOrderRequest) (*Order, error) {
    user, err := s.userRepo.GetByID(ctx, req.UserID)
    if err != nil {
        // %w wraps the original error — preserving the chain for errors.Is/errors.As
        return nil, fmt.Errorf("create order: get user %s: %w", req.UserID, err)
    }

    if user.Balance < req.TotalAmount {
        // Sentinel error for expected business-logic failures
        return nil, ErrInsufficientBalance
    }

    order, err := s.orderRepo.Create(ctx, &Order{
        UserID: req.UserID,
        Amount: req.TotalAmount,
        Status: OrderStatusPending,
    })
    if err != nil {
        return nil, fmt.Errorf("create order: insert order: %w", err)
    }

    return order, nil
}
```

The resulting error chain looks like:

```
create order: get user user-123: connection refused
```

Now when this shows up in logs, you know exactly what was happening.

### Checking Error Types: `errors.Is` and `errors.As`

```go
import "errors"

// Sentinel errors — predefined, well-known errors
var (
    ErrNotFound            = errors.New("not found")
    ErrInsufficientBalance = errors.New("insufficient balance")
    ErrDuplicateEmail      = errors.New("duplicate email")
)

// Checking if an error in the chain matches a sentinel
if errors.Is(err, ErrNotFound) {
    // respond with 404
}

// Checking if an error in the chain is a specific type
var pgErr *pgconn.PgError
if errors.As(err, &pgErr) {
    if pgErr.Code == "23505" { // unique_violation
        return ErrDuplicateEmail
    }
}
```

### Common Mistake: Using `err.Error() == "some string"` for Comparison

```go
// BAD — fragile string comparison that breaks if the error message changes
if err.Error() == "not found" {
    // ...
}

// GOOD — use sentinel errors and errors.Is
if errors.Is(err, ErrNotFound) {
    // ...
}
```

---

## Defer, Panic, Recover — Real Use Cases

### `defer` — Cleanup That Always Runs

`defer` schedules a function call to run when the surrounding function returns. Think of it like `finally` in JavaScript, but it can be placed right after the resource is acquired.

```go
func (r *postgresUserRepo) GetByID(ctx context.Context, id string) (*User, error) {
    rows, err := r.db.QueryContext(ctx, `SELECT * FROM users WHERE id = $1`, id)
    if err != nil {
        return nil, err
    }
    defer rows.Close() // runs when GetByID returns, whether success or error

    // ... process rows
}
```

**Key use cases in backend code:**

```go
// 1. Closing database rows
rows, err := db.QueryContext(ctx, query)
if err != nil { return err }
defer rows.Close()

// 2. Releasing mutex locks
mu.Lock()
defer mu.Unlock()

// 3. Closing HTTP response bodies
resp, err := http.Get(url)
if err != nil { return err }
defer resp.Body.Close()

// 4. Closing files
f, err := os.Open(path)
if err != nil { return err }
defer f.Close()

// 5. Rolling back a transaction on error
tx, err := db.BeginTx(ctx, nil)
if err != nil { return err }
defer tx.Rollback() // no-op if tx.Commit() was called first
```

**Deferred calls execute in LIFO (last in, first out) order:**

```go
defer fmt.Println("first")
defer fmt.Println("second")
defer fmt.Println("third")
// Output: third, second, first
```

### `panic` and `recover` — Only for Truly Unrecoverable Situations

`panic` is like an unhandled exception — it crashes the program (or the goroutine). In backend code, **you almost never call `panic` directly.** Instead, you return errors.

The one place `recover` is used extensively is in **middleware** to catch panics and convert them to 500 responses instead of crashing the entire server:

```go
// Recovery middleware — every production Go service has this
func RecoveryMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        defer func() {
            if rec := recover(); rec != nil {
                // Log the panic with a stack trace for debugging
                logger.Error("panic recovered",
                    zap.Any("panic", rec),
                    zap.String("stack", string(debug.Stack())),
                    zap.String("path", r.URL.Path),
                )

                // Respond with 500 instead of crashing the server
                http.Error(w, "internal server error", http.StatusInternalServerError)
            }
        }()
        next.ServeHTTP(w, r)
    })
}
```

**When `panic` is acceptable:**

- Program startup: if config is invalid or a required dependency is unreachable, panic is fine because the program cannot function.
- Truly unreachable code (indicates a programmer bug, not a runtime condition).

---

## Init Functions and Package-Level Variables

### How `init()` Works

Every Go file can have an `init()` function that runs automatically when the package is loaded, before `main()`:

```go
package database

import "database/sql"

var db *sql.DB

func init() {
    var err error
    db, err = sql.Open("postgres", os.Getenv("DATABASE_URL"))
    if err != nil {
        panic("failed to connect to database: " + err.Error())
    }
}
```

### Why Large Codebases AVOID `init()`

While `init()` works, it has problems that bite you in large codebases:

1. **Implicit execution** — there's no way to tell when or in what order `init()` functions run across packages. This creates hidden dependencies.
2. **Untestable** — you can't control init behavior in tests. What if your test doesn't want a real database connection?
3. **Side effects at import time** — importing a package shouldn't change global state.

### What Companies Do Instead

```go
// BAD — init() with global state
package database

var db *sql.DB

func init() {
    db, _ = sql.Open("postgres", os.Getenv("DATABASE_URL"))
}

// GOOD — explicit construction in main()
package main

func main() {
    cfg := config.Load()

    db, err := sql.Open("postgres", cfg.DatabaseURL)
    if err != nil {
        log.Fatal("failed to connect to database", zap.Error(err))
    }
    defer db.Close()

    repo := postgres.NewUserRepository(db)
    svc := service.NewUserService(repo)
    handler := api.NewHandler(svc)

    // Everything is explicit — easy to test, easy to understand
}
```

### Acceptable Uses of `init()`

```go
// Registering database drivers — this is the standard pattern
import _ "github.com/lib/pq" // The blank import triggers pq's init() to register with database/sql

// Registering metric collectors
func init() {
    prometheus.MustRegister(requestDuration)
    prometheus.MustRegister(requestCount)
}
```

---

## Type Aliases and Custom Types

### Modeling Your Domain with Types

Go lets you create new types based on existing ones. This is used heavily to make code self-documenting and prevent bugs:

```go
// Custom types for domain concepts
type UserID string
type OrderID string
type Money int64 // store cents to avoid floating-point issues

// Now these are distinct types — you can't accidentally pass an OrderID where a UserID is expected
func GetUser(ctx context.Context, id UserID) (*User, error) { ... }
func GetOrder(ctx context.Context, id OrderID) (*Order, error) { ... }

// This won't compile — type safety catches the bug
user, err := GetUser(ctx, OrderID("order-123")) // compile error: cannot use OrderID as UserID
```

### Enum-Like Constants with String Types

Go doesn't have enums, but this pattern is used everywhere:

```go
type OrderStatus string

const (
    OrderStatusPending   OrderStatus = "pending"
    OrderStatusConfirmed OrderStatus = "confirmed"
    OrderStatusShipped   OrderStatus = "shipped"
    OrderStatusDelivered OrderStatus = "delivered"
    OrderStatusCancelled OrderStatus = "cancelled"
)

// You can add methods to custom types
func (s OrderStatus) IsTerminal() bool {
    return s == OrderStatusDelivered || s == OrderStatusCancelled
}

// Validation method
func (s OrderStatus) Valid() bool {
    switch s {
    case OrderStatusPending, OrderStatusConfirmed, OrderStatusShipped,
         OrderStatusDelivered, OrderStatusCancelled:
        return true
    default:
        return false
    }
}
```

---

## Variadic Functions and the Functional Options Pattern

### The Problem: Functions with Many Optional Parameters

Imagine you need to create an HTTP client with many configurable settings. In JavaScript, you'd pass an options object:

```javascript
const client = createClient({ timeout: 30, retries: 3, baseURL: "..." });
```

In Go, you can't have optional parameters. The **functional options pattern** solves this elegantly and is used in virtually every Go library and production codebase:

```go
// The server struct with many configurable fields
type Server struct {
    addr         string
    readTimeout  time.Duration
    writeTimeout time.Duration
    maxBodySize  int64
    logger       *zap.Logger
    tlsConfig    *tls.Config
}

// Option is a function that modifies the server configuration
type Option func(*Server)

// Each option is a function that returns an Option
func WithReadTimeout(d time.Duration) Option {
    return func(s *Server) {
        s.readTimeout = d
    }
}

func WithWriteTimeout(d time.Duration) Option {
    return func(s *Server) {
        s.writeTimeout = d
    }
}

func WithMaxBodySize(size int64) Option {
    return func(s *Server) {
        s.maxBodySize = size
    }
}

func WithLogger(logger *zap.Logger) Option {
    return func(s *Server) {
        s.logger = logger
    }
}

func WithTLS(cfg *tls.Config) Option {
    return func(s *Server) {
        s.tlsConfig = cfg
    }
}

// NewServer uses variadic options — callers only specify what they want to override
func NewServer(addr string, opts ...Option) *Server {
    // Start with sensible defaults
    srv := &Server{
        addr:         addr,
        readTimeout:  5 * time.Second,
        writeTimeout: 10 * time.Second,
        maxBodySize:  1 << 20, // 1 MB
        logger:       zap.NewNop(),
    }

    // Apply each option — overrides defaults
    for _, opt := range opts {
        opt(srv)
    }

    return srv
}

// Usage — clean, readable, extensible
func main() {
    srv := NewServer(":8080",
        WithReadTimeout(10*time.Second),
        WithLogger(logger),
        WithMaxBodySize(5<<20), // 5 MB
    )
}
```

### Why This Pattern Dominates

1. **Default values** — you get sane defaults without the caller specifying everything.
2. **Backward compatible** — adding a new option doesn't change the function signature.
3. **Self-documenting** — `WithReadTimeout(10*time.Second)` is more readable than positional arguments.
4. **Composable** — you can create preset option bundles:

```go
func ProductionDefaults() Option {
    return func(s *Server) {
        s.readTimeout = 30 * time.Second
        s.writeTimeout = 60 * time.Second
        s.maxBodySize = 10 << 20
    }
}

srv := NewServer(":8080", ProductionDefaults(), WithLogger(logger))
```

---

## Summary: What to Take Away

| Feature | Backend Use | Why It Matters |
|---|---|---|
| Interfaces | Decoupling layers, enabling mocks for testing | You'll define and implement these daily |
| Struct embedding | Composing models, decorators, middleware | Go's replacement for inheritance |
| Pointers | Passing large structs, nullable values, method receivers | Nil pointer dereference is the #1 runtime crash |
| Error handling | Every function call — `if err != nil` | The backbone of robust backend code |
| Defer | Cleanup: closing rows, releasing locks, rolling back txns | Prevents resource leaks |
| Custom types | Domain modeling, type-safe IDs, enums | Prevents entire classes of bugs |
| Functional options | Configuring clients, servers, and services | Standard pattern in every Go library |

---

→ **Continued in [Part 2 — Project Structure in a Real Company Codebase](./part02_project_structure.md)**
