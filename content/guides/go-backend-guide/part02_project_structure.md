# Part 2 — Project Structure in a Real Company Codebase

> **Series:** The Definitive Go Backend Guide for Frontend Engineers
> **Prev:** [Part 1 — Go Fundamentals](./part01_go_fundamentals.md)
> **Next:** [Part 3 — Building REST APIs](./part03_rest_apis.md)

---

## Table of Contents

- [Why Go Project Structure Matters More Than Most Languages](#why-go-project-structure-matters-more-than-most-languages)
- [The Standard Layout — Explained File by File](#the-standard-layout--explained-file-by-file)
- [The `internal/` Package Rule](#the-internal-package-rule)
- [Mono-Repo vs Multi-Repo Patterns](#mono-repo-vs-multi-repo-patterns)
- [Dependency Injection Without a Framework (and with Wire)](#dependency-injection-without-a-framework-and-with-wire)
- [Configuration Structure (Viper, Env Vars, Config Structs)](#configuration-structure)
- [Full Annotated Production Service Directory Tree](#full-annotated-production-service-directory-tree)

---

## Why Go Project Structure Matters More Than Most Languages

In JavaScript/TypeScript, you have absolute freedom in how you organize files. The language doesn't care. Bundlers resolve imports regardless of file location.

In Go, **packages are the fundamental unit of encapsulation.** The directory structure IS the package structure. Every directory is a package, and packages define visibility boundaries:

- **Exported names** (capitalized: `User`, `CreateOrder`) are visible to other packages.
- **Unexported names** (lowercase: `validateEmail`, `dbConn`) are private to the package.

This means your directory structure directly determines your API boundaries, what code can access what, and how testable your code is. Getting it wrong early leads to circular dependencies and tight coupling that's painful to fix.

---

## The Standard Layout — Explained File by File

Here's what a production Go microservice looks like. This is based on the widely-adopted community standard (golang-standards/project-layout) with real-world adjustments:

```
order-service/
├── cmd/
│   └── server/
│       └── main.go              ← Entry point. Wires everything together.
├── internal/
│   ├── api/
│   │   ├── handler.go           ← HTTP handlers (controllers)
│   │   ├── middleware.go         ← Custom middleware
│   │   ├── router.go            ← Route definitions
│   │   ├── request.go           ← Request DTOs and validation
│   │   └── response.go          ← Response helpers and DTOs
│   ├── service/
│   │   ├── order_service.go     ← Business logic
│   │   └── order_service_test.go
│   ├── repository/
│   │   ├── order_repository.go  ← Interface definition
│   │   ├── postgres_order.go    ← PostgreSQL implementation
│   │   └── postgres_order_test.go
│   ├── model/
│   │   ├── order.go             ← Domain models / entities
│   │   └── errors.go            ← Domain error definitions
│   ├── config/
│   │   └── config.go            ← Config struct + loading
│   └── kafka/
│       ├── producer.go          ← Kafka producer
│       └── consumer.go          ← Kafka consumer
├── migrations/
│   ├── 000001_create_orders.up.sql
│   └── 000001_create_orders.down.sql
├── api/
│   └── openapi.yaml             ← OpenAPI / Swagger spec
├── proto/
│   └── order/
│       └── v1/
│           └── order.proto      ← gRPC protocol buffer definitions
├── scripts/
│   ├── migrate.sh               ← DB migration runner
│   └── seed.sh                  ← Test data seeder
├── deployments/
│   ├── Dockerfile
│   └── kubernetes/
│       ├── deployment.yaml
│       ├── service.yaml
│       └── configmap.yaml
├── go.mod                       ← Module definition (like package.json)
├── go.sum                       ← Dependency lock file (like package-lock.json)
├── Makefile                     ← Common commands (build, test, lint, migrate)
└── README.md
```

Let's walk through each directory:

### `cmd/` — Entry Points

```go
// cmd/server/main.go
// This file ONLY wires dependencies together and starts the server.
// No business logic. No database queries. Just construction and startup.

package main

import (
    "context"
    "log"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/jmoiron/sqlx"
    _ "github.com/lib/pq"
    "go.uber.org/zap"

    "github.com/yourcompany/order-service/internal/api"
    "github.com/yourcompany/order-service/internal/config"
    "github.com/yourcompany/order-service/internal/repository"
    "github.com/yourcompany/order-service/internal/service"
)

func main() {
    // Load configuration from environment variables
    cfg, err := config.Load()
    if err != nil {
        log.Fatalf("failed to load config: %v", err)
    }

    // Initialize structured logger
    logger, err := zap.NewProduction()
    if err != nil {
        log.Fatalf("failed to initialize logger: %v", err)
    }
    defer logger.Sync()

    // Connect to database
    db, err := sqlx.Connect("postgres", cfg.DatabaseURL)
    if err != nil {
        logger.Fatal("failed to connect to database", zap.Error(err))
    }
    defer db.Close()

    // Configure connection pool
    db.SetMaxOpenConns(cfg.DBMaxOpenConns)
    db.SetMaxIdleConns(cfg.DBMaxIdleConns)
    db.SetConnMaxLifetime(cfg.DBConnMaxLifetime)

    // Wire up dependencies — manual dependency injection
    orderRepo := repository.NewPostgresOrderRepository(db)
    orderSvc := service.NewOrderService(orderRepo, logger)
    router := api.NewRouter(orderSvc, logger)

    // Create HTTP server
    srv := &http.Server{
        Addr:         ":" + cfg.Port,
        Handler:      router,
        ReadTimeout:  15 * time.Second,
        WriteTimeout: 15 * time.Second,
        IdleTimeout:  60 * time.Second,
    }

    // Start server in a goroutine so we can handle shutdown
    go func() {
        logger.Info("starting server", zap.String("addr", srv.Addr))
        if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            logger.Fatal("server failed", zap.Error(err))
        }
    }()

    // Graceful shutdown — wait for interrupt signal
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
    <-quit // blocks until signal received

    logger.Info("shutting down server...")

    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := srv.Shutdown(ctx); err != nil {
        logger.Fatal("server forced to shutdown", zap.Error(err))
    }

    logger.Info("server stopped")
}
```

**Key insights:**

- `main.go` is the **composition root.** It's the only place where concrete implementations are created and wired together.
- Notice `defer db.Close()` — resources are cleaned up in reverse order when `main` returns.
- The graceful shutdown pattern is essential for production (Part 16 covers it in depth).

### `internal/` — Your Private Code

Everything under `internal/` is **inaccessible to external packages.** This is enforced by the Go compiler, not by convention. If your module is `github.com/yourcompany/order-service`, no other Go module can import anything from `github.com/yourcompany/order-service/internal/...`.

### `internal/model/` — Domain Models

```go
// internal/model/order.go

package model

import "time"

type Order struct {
    ID          string      `json:"id" db:"id"`
    UserID      string      `json:"user_id" db:"user_id"`
    Status      OrderStatus `json:"status" db:"status"`
    TotalAmount int64       `json:"total_amount" db:"total_amount"` // cents
    Currency    string      `json:"currency" db:"currency"`
    Items       []OrderItem `json:"items" db:"-"`                   // db:"-" means not a DB column
    CreatedAt   time.Time   `json:"created_at" db:"created_at"`
    UpdatedAt   time.Time   `json:"updated_at" db:"updated_at"`
}

type OrderItem struct {
    ID        string `json:"id" db:"id"`
    OrderID   string `json:"order_id" db:"order_id"`
    ProductID string `json:"product_id" db:"product_id"`
    Quantity  int    `json:"quantity" db:"quantity"`
    PriceEach int64  `json:"price_each" db:"price_each"` // cents
}

type OrderStatus string

const (
    OrderStatusPending   OrderStatus = "pending"
    OrderStatusConfirmed OrderStatus = "confirmed"
    OrderStatusCancelled OrderStatus = "cancelled"
)
```

### `internal/model/errors.go` — Domain Errors

```go
package model

import "errors"

var (
    ErrOrderNotFound       = errors.New("order not found")
    ErrInsufficientStock   = errors.New("insufficient stock")
    ErrInvalidOrderStatus  = errors.New("invalid order status transition")
    ErrDuplicateOrder      = errors.New("duplicate order")
)
```

### `internal/repository/` — Data Access Layer

```go
// internal/repository/order_repository.go — Interface

package repository

import (
    "context"

    "github.com/yourcompany/order-service/internal/model"
)

type OrderRepository interface {
    Create(ctx context.Context, order *model.Order) error
    GetByID(ctx context.Context, id string) (*model.Order, error)
    ListByUser(ctx context.Context, userID string, limit, offset int) ([]*model.Order, error)
    UpdateStatus(ctx context.Context, id string, status model.OrderStatus) error
}
```

### `internal/service/` — Business Logic

```go
// internal/service/order_service.go

package service

import (
    "context"
    "fmt"
    "time"

    "github.com/google/uuid"
    "go.uber.org/zap"

    "github.com/yourcompany/order-service/internal/model"
    "github.com/yourcompany/order-service/internal/repository"
)

type OrderService struct {
    repo   repository.OrderRepository
    logger *zap.Logger
}

func NewOrderService(repo repository.OrderRepository, logger *zap.Logger) *OrderService {
    return &OrderService{repo: repo, logger: logger}
}

func (s *OrderService) CreateOrder(ctx context.Context, userID string, items []model.OrderItem) (*model.Order, error) {
    var total int64
    for _, item := range items {
        total += item.PriceEach * int64(item.Quantity)
    }

    order := &model.Order{
        ID:          uuid.New().String(),
        UserID:      userID,
        Status:      model.OrderStatusPending,
        TotalAmount: total,
        Currency:    "USD",
        Items:       items,
        CreatedAt:   time.Now().UTC(),
        UpdatedAt:   time.Now().UTC(),
    }

    if err := s.repo.Create(ctx, order); err != nil {
        return nil, fmt.Errorf("create order: %w", err)
    }

    s.logger.Info("order created",
        zap.String("order_id", order.ID),
        zap.String("user_id", userID),
        zap.Int64("total_amount", total),
    )

    return order, nil
}
```

---

## The `internal/` Package Rule

This is the single most important structural decision in Go:

```
myservice/
├── internal/     ← ONLY code inside myservice/ can import from here
│   ├── service/  ← myservice/internal/service — private to this module
│   └── model/    ← myservice/internal/model — private to this module
└── pkg/          ← ANY Go module can import from here (public API)
    └── client/   ← myservice/pkg/client — intended for external consumers
```

The Go compiler enforces this. If another team tries to import `github.com/yourcompany/order-service/internal/model`, their code **will not compile.**

**Why this matters:**

- You can freely refactor anything under `internal/` without worrying about breaking other teams.
- Your public API surface is explicitly chosen (only what's under `pkg/`).
- In practice, most microservices have **nothing** under `pkg/` — they communicate via HTTP/gRPC, not by importing each other's packages.

---

## Mono-Repo vs Multi-Repo Patterns

### Multi-Repo (One Repo Per Service)

```
github.com/yourcompany/user-service/
github.com/yourcompany/order-service/
github.com/yourcompany/payment-service/
```

**Pros:** Independent deploy cycles, clear ownership boundaries, simpler CI/CD per service.
**Cons:** Sharing code requires publishing packages, cross-service changes require multiple PRs.

### Mono-Repo (All Services in One Repo)

```
github.com/yourcompany/backend/
├── services/
│   ├── user/
│   │   ├── cmd/server/main.go
│   │   └── internal/...
│   ├── order/
│   │   ├── cmd/server/main.go
│   │   └── internal/...
│   └── payment/
│       ├── cmd/server/main.go
│       └── internal/...
├── pkg/                          ← Shared libraries used by all services
│   ├── middleware/
│   ├── logging/
│   ├── httputil/
│   └── kafkautil/
├── proto/                        ← Shared proto definitions
└── go.mod                        ← Single module or go.work
```

**Pros:** Easy code sharing, atomic cross-service changes, consistent tooling.
**Cons:** Larger CI scope, need careful build tooling, everyone sees everything.

**What large companies actually do:** Most start with multi-repo. Companies with strong platform teams (like Google, Uber) use mono-repos with custom build tooling. Go supports mono-repos well via `go.work` (workspace mode).

---

## Dependency Injection Without a Framework (and with Wire)

### Manual DI (Most Common)

Go's approach to DI is simple: **pass dependencies as constructor arguments.** No magic, no framework, no annotations.

```go
func main() {
    // 1. Create infrastructure
    db := connectDB(cfg)
    cache := connectRedis(cfg)
    logger := newLogger(cfg)

    // 2. Create repositories (depend on infrastructure)
    userRepo := repository.NewPostgresUserRepo(db)
    orderRepo := repository.NewPostgresOrderRepo(db)

    // 3. Create services (depend on repositories)
    userSvc := service.NewUserService(userRepo, cache, logger)
    orderSvc := service.NewOrderService(orderRepo, userSvc, logger)

    // 4. Create handlers (depend on services)
    handler := api.NewHandler(userSvc, orderSvc, logger)

    // 5. Create router (depend on handlers)
    router := api.NewRouter(handler, logger)

    // The dependency graph is explicit and visible
}
```

This works well for small-to-medium services. When a service has 30+ dependencies, it gets verbose.

### Wire (Google's DI Code Generator)

Wire generates the constructor wiring code at compile time. You define "provider" functions and Wire figures out the dependency graph:

```go
// wire.go (build tag ensures this isn't compiled normally)
//go:build wireinject

package main

import "github.com/google/wire"

func InitializeServer(cfg *config.Config) (*http.Server, error) {
    wire.Build(
        database.NewConnection,        // provides *sqlx.DB
        repository.NewPostgresUserRepo, // provides repository.UserRepository
        repository.NewPostgresOrderRepo,
        service.NewUserService,
        service.NewOrderService,
        api.NewHandler,
        api.NewRouter,
        newHTTPServer,
    )
    return nil, nil // Wire replaces this with real code
}
```

Run `wire` and it generates `wire_gen.go` with all the wiring code.

---

## Configuration Structure

```go
// internal/config/config.go

package config

import (
    "fmt"
    "time"

    "github.com/spf13/viper"
)

type Config struct {
    Port              string        `mapstructure:"PORT"`
    Environment       string        `mapstructure:"ENVIRONMENT"`
    DatabaseURL       string        `mapstructure:"DATABASE_URL"`
    DBMaxOpenConns    int           `mapstructure:"DB_MAX_OPEN_CONNS"`
    DBMaxIdleConns    int           `mapstructure:"DB_MAX_IDLE_CONNS"`
    DBConnMaxLifetime time.Duration `mapstructure:"DB_CONN_MAX_LIFETIME"`
    RedisURL          string        `mapstructure:"REDIS_URL"`
    KafkaBrokers      []string      `mapstructure:"KAFKA_BROKERS"`
    JWTSecret         string        `mapstructure:"JWT_SECRET"`
    LogLevel          string        `mapstructure:"LOG_LEVEL"`
}

func Load() (*Config, error) {
    viper.SetDefault("PORT", "8080")
    viper.SetDefault("ENVIRONMENT", "development")
    viper.SetDefault("DB_MAX_OPEN_CONNS", 25)
    viper.SetDefault("DB_MAX_IDLE_CONNS", 5)
    viper.SetDefault("DB_CONN_MAX_LIFETIME", 5*time.Minute)
    viper.SetDefault("LOG_LEVEL", "info")

    viper.AutomaticEnv()

    var cfg Config
    if err := viper.Unmarshal(&cfg); err != nil {
        return nil, fmt.Errorf("unmarshal config: %w", err)
    }

    if err := cfg.validate(); err != nil {
        return nil, fmt.Errorf("validate config: %w", err)
    }

    return &cfg, nil
}

func (c *Config) validate() error {
    if c.DatabaseURL == "" {
        return fmt.Errorf("DATABASE_URL is required")
    }
    if c.JWTSecret == "" {
        return fmt.Errorf("JWT_SECRET is required")
    }
    return nil
}
```

---

## Full Annotated Production Service Directory Tree

```
order-service/
│
├── cmd/server/main.go           # Entry point — wires everything, starts server
│
├── internal/                    # Private to this module (compiler-enforced)
│   ├── api/                     # HTTP transport layer
│   │   ├── handler.go           # Request → Service → Response
│   │   ├── middleware.go        # Auth, logging, recovery, CORS
│   │   ├── router.go            # chi.NewRouter() with route definitions
│   │   ├── request.go           # CreateOrderRequest, UpdateOrderRequest structs
│   │   └── response.go          # JSON response helpers, error response format
│   │
│   ├── service/                 # Business logic (pure — no HTTP, no SQL)
│   │   ├── order_service.go     # CreateOrder, CancelOrder, GetOrder
│   │   └── order_service_test.go# Unit tests with mocked repository
│   │
│   ├── repository/              # Data access (SQL, cache)
│   │   ├── order_repository.go  # Interface definition
│   │   ├── postgres_order.go    # PostgreSQL implementation
│   │   └── postgres_order_test.go# Integration tests
│   │
│   ├── model/                   # Domain types, shared across layers
│   │   ├── order.go             # Order, OrderItem, OrderStatus
│   │   └── errors.go            # ErrNotFound, ErrInvalidStatus
│   │
│   ├── config/                  # Configuration loading + validation
│   │   └── config.go
│   │
│   └── kafka/                   # Async messaging
│       ├── producer.go          # Publishes order events
│       └── consumer.go          # Consumes events from other services
│
├── migrations/                  # SQL migration files (golang-migrate format)
│   ├── 000001_create_orders.up.sql
│   └── 000001_create_orders.down.sql
│
├── api/openapi.yaml             # API specification (source of truth for endpoints)
│
├── deployments/
│   ├── Dockerfile               # Multi-stage build
│   └── kubernetes/              # K8s manifests
│
├── Makefile                     # make build, make test, make lint, make migrate
├── go.mod
├── go.sum
└── README.md
```

### The Layering Rule

```
api/ (HTTP) ──depends on──▶ service/ (logic) ──depends on──▶ repository/ (data)
                                │
                                └──depends on──▶ model/ (types)
```

**Dependencies flow inward.** The service layer NEVER imports from `api/`. The repository NEVER imports from `service/`. The `model/` package has NO dependencies on any other internal package.

This is what makes the code testable: you can test the service with a mock repository, and test the handler with a mock service. No database, no HTTP server needed.

---

→ **Continued in [Part 3 — Building REST APIs in Go](./part03_rest_apis.md)**
