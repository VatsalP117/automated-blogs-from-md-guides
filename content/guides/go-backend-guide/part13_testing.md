# Part 13 — Testing in Go Backend

> **Series:** The Definitive Go Backend Guide for Frontend Engineers
> **Prev:** [Part 12 — gRPC](./part12_grpc.md)
> **Next:** [Part 14 — Error Handling at Scale](./part14_error_handling.md)

---

## Table of Contents

- [13A — Unit Testing](#13a--unit-testing)
- [13B — Integration Testing](#13b--integration-testing)
- [13C — HTTP Handler Testing](#13c--http-handler-testing)
- [13D — Testing Patterns in Large Codebases](#13d--testing-patterns-in-large-codebases)

---

## 13A — Unit Testing

### Go's Built-In Testing Package

Go has testing built into the language. No framework needed for basic tests.

```go
// math.go
package math

func Add(a, b int) int {
    return a + b
}
```

```go
// math_test.go — test files end in _test.go (Go convention, compiler-enforced)
package math

import "testing"

func TestAdd(t *testing.T) {
    result := Add(2, 3)
    if result != 5 {
        t.Errorf("Add(2, 3) = %d, want 5", result)
    }
}
```

```bash
go test ./...              # run all tests
go test -v ./...           # verbose output
go test -race ./...        # with data race detection (always use in CI)
go test -count=1 ./...     # disable test caching
go test -run TestAdd ./... # run only tests matching pattern
```

### Table-Driven Tests — The Go Standard

This is THE pattern for writing tests in Go. Every reviewer expects it:

```go
func TestOrderService_CreateOrder(t *testing.T) {
    tests := []struct {
        name        string
        userID      string
        items       []OrderItem
        setupMock   func(*mockOrderRepo)
        wantErr     error
        wantStatus  OrderStatus
    }{
        {
            name:   "success with single item",
            userID: "user-1",
            items: []OrderItem{
                {ProductID: "prod-1", Quantity: 2, PriceEach: 1000},
            },
            setupMock: func(m *mockOrderRepo) {
                m.createErr = nil // success
            },
            wantErr:    nil,
            wantStatus: OrderStatusPending,
        },
        {
            name:   "success with multiple items",
            userID: "user-1",
            items: []OrderItem{
                {ProductID: "prod-1", Quantity: 1, PriceEach: 1000},
                {ProductID: "prod-2", Quantity: 3, PriceEach: 500},
            },
            setupMock: func(m *mockOrderRepo) {
                m.createErr = nil
            },
            wantErr:    nil,
            wantStatus: OrderStatusPending,
        },
        {
            name:   "empty items returns error",
            userID: "user-1",
            items:  []OrderItem{},
            setupMock: func(m *mockOrderRepo) {},
            wantErr: ErrEmptyOrder,
        },
        {
            name:   "database error propagates",
            userID: "user-1",
            items: []OrderItem{
                {ProductID: "prod-1", Quantity: 1, PriceEach: 1000},
            },
            setupMock: func(m *mockOrderRepo) {
                m.createErr = fmt.Errorf("connection refused")
            },
            wantErr: fmt.Errorf("connection refused"),
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            // Arrange
            repo := &mockOrderRepo{}
            tt.setupMock(repo)
            svc := NewOrderService(repo, zap.NewNop())

            // Act
            order, err := svc.CreateOrder(context.Background(), tt.userID, tt.items)

            // Assert
            if tt.wantErr != nil {
                if err == nil {
                    t.Fatalf("expected error, got nil")
                }
                if !errors.Is(err, tt.wantErr) && !strings.Contains(err.Error(), tt.wantErr.Error()) {
                    t.Fatalf("expected error containing %q, got %q", tt.wantErr, err)
                }
                return
            }

            if err != nil {
                t.Fatalf("unexpected error: %v", err)
            }
            if order.Status != tt.wantStatus {
                t.Errorf("status = %s, want %s", order.Status, tt.wantStatus)
            }
        })
    }
}
```

### Mocking with Interfaces (No Framework Needed)

Because the service depends on an interface (not a concrete type), we can pass a mock:

```go
// Mock that satisfies the OrderRepository interface
type mockOrderRepo struct {
    orders    map[string]*Order
    createErr error
}

func (m *mockOrderRepo) Create(ctx context.Context, order *Order, items []OrderItem) error {
    if m.createErr != nil {
        return m.createErr
    }
    if m.orders == nil {
        m.orders = make(map[string]*Order)
    }
    m.orders[order.ID] = order
    return nil
}

func (m *mockOrderRepo) GetByID(ctx context.Context, id string) (*Order, error) {
    order, ok := m.orders[id]
    if !ok {
        return nil, ErrOrderNotFound
    }
    return order, nil
}

func (m *mockOrderRepo) ListByUser(ctx context.Context, userID string, limit, offset int) ([]*Order, int, error) {
    var result []*Order
    for _, o := range m.orders {
        if o.UserID == userID {
            result = append(result, o)
        }
    }
    return result, len(result), nil
}

func (m *mockOrderRepo) UpdateStatus(ctx context.Context, id string, status OrderStatus) error {
    order, ok := m.orders[id]
    if !ok {
        return ErrOrderNotFound
    }
    order.Status = status
    return nil
}
```

### Using Testify for Assertions

The `testify` library reduces assertion boilerplate:

```go
import (
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestCreateOrder(t *testing.T) {
    repo := &mockOrderRepo{}
    svc := NewOrderService(repo, zap.NewNop())

    order, err := svc.CreateOrder(context.Background(), "user-1", items)

    // require stops the test immediately on failure (use for preconditions)
    require.NoError(t, err)
    require.NotNil(t, order)

    // assert logs the failure but continues the test (use for checks)
    assert.Equal(t, "user-1", order.UserID)
    assert.Equal(t, OrderStatusPending, order.Status)
    assert.Len(t, order.Items, 2)
    assert.Greater(t, order.TotalAmount, int64(0))
}
```

---

## 13B — Integration Testing

### Testing with a Real Database Using testcontainers-go

Integration tests use real infrastructure (Postgres, Redis) spun up in Docker:

```go
package repository_test

import (
    "context"
    "testing"
    "time"

    "github.com/jmoiron/sqlx"
    _ "github.com/lib/pq"
    "github.com/stretchr/testify/require"
    "github.com/testcontainers/testcontainers-go"
    "github.com/testcontainers/testcontainers-go/modules/postgres"
    "github.com/testcontainers/testcontainers-go/wait"

    "github.com/yourcompany/order-service/internal/repository"
)

func setupTestDB(t *testing.T) *sqlx.DB {
    t.Helper()
    ctx := context.Background()

    // Start a real PostgreSQL container
    pgContainer, err := postgres.Run(ctx, "postgres:16",
        postgres.WithDatabase("testdb"),
        postgres.WithUsername("test"),
        postgres.WithPassword("test"),
        testcontainers.WithWaitStrategy(
            wait.ForLog("database system is ready to accept connections").
                WithOccurrence(2).
                WithStartupTimeout(30*time.Second),
        ),
    )
    require.NoError(t, err)

    // Clean up container when test finishes
    t.Cleanup(func() {
        require.NoError(t, pgContainer.Terminate(ctx))
    })

    connStr, err := pgContainer.ConnectionString(ctx, "sslmode=disable")
    require.NoError(t, err)

    db, err := sqlx.Connect("postgres", connStr)
    require.NoError(t, err)

    // Run migrations
    runMigrations(t, db)

    return db
}

func runMigrations(t *testing.T, db *sqlx.DB) {
    t.Helper()
    // Apply schema
    _, err := db.Exec(`
        CREATE TABLE IF NOT EXISTS orders (
            id VARCHAR(36) PRIMARY KEY,
            user_id VARCHAR(36) NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'pending',
            total_amount BIGINT NOT NULL,
            currency VARCHAR(3) NOT NULL DEFAULT 'USD',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `)
    require.NoError(t, err)
}

func TestPostgresOrderRepo_Create(t *testing.T) {
    db := setupTestDB(t)
    repo := repository.NewPostgresOrderRepository(db)
    ctx := context.Background()

    order := &model.Order{
        ID:          "order-1",
        UserID:      "user-1",
        Status:      model.OrderStatusPending,
        TotalAmount: 5000,
        Currency:    "USD",
        CreatedAt:   time.Now().UTC(),
        UpdatedAt:   time.Now().UTC(),
    }

    // Create
    err := repo.Create(ctx, order, nil)
    require.NoError(t, err)

    // Read back
    got, err := repo.GetByID(ctx, "order-1")
    require.NoError(t, err)
    assert.Equal(t, "order-1", got.ID)
    assert.Equal(t, "user-1", got.UserID)
    assert.Equal(t, int64(5000), got.TotalAmount)
}

func TestPostgresOrderRepo_UpdateStatus(t *testing.T) {
    db := setupTestDB(t)
    repo := repository.NewPostgresOrderRepository(db)
    ctx := context.Background()

    // Seed data
    order := &model.Order{
        ID: "order-1", UserID: "user-1", Status: model.OrderStatusPending,
        TotalAmount: 5000, Currency: "USD",
        CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
    }
    require.NoError(t, repo.Create(ctx, order, nil))

    // Update status
    err := repo.UpdateStatus(ctx, "order-1", model.OrderStatusConfirmed)
    require.NoError(t, err)

    // Verify
    got, err := repo.GetByID(ctx, "order-1")
    require.NoError(t, err)
    assert.Equal(t, model.OrderStatusConfirmed, got.Status)
}

func TestPostgresOrderRepo_GetByID_NotFound(t *testing.T) {
    db := setupTestDB(t)
    repo := repository.NewPostgresOrderRepository(db)

    _, err := repo.GetByID(context.Background(), "nonexistent")
    assert.ErrorIs(t, err, model.ErrOrderNotFound)
}
```

---

## 13C — HTTP Handler Testing

Go's `httptest` package lets you test handlers without starting a real server:

```go
package api_test

import (
    "bytes"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"

    "github.com/go-chi/chi/v5"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"

    "github.com/yourcompany/order-service/internal/api"
)

func TestCreateOrder_Success(t *testing.T) {
    // Setup mock service
    mockSvc := &mockOrderService{
        createFunc: func(ctx context.Context, userID string, items []model.OrderItem) (*model.Order, error) {
            return &model.Order{
                ID:          "order-123",
                UserID:      userID,
                Status:      model.OrderStatusPending,
                TotalAmount: 2000,
            }, nil
        },
    }

    handler := api.NewOrderHandler(mockSvc)

    // Build request
    body := `{"items": [{"product_id": "prod-1", "quantity": 2}]}`
    req := httptest.NewRequest(http.MethodPost, "/api/v1/orders", bytes.NewBufferString(body))
    req.Header.Set("Content-Type", "application/json")

    // Add auth context (normally set by middleware)
    ctx := context.WithValue(req.Context(), api.UserIDContextKey, "user-1")
    req = req.WithContext(ctx)

    // Execute
    rr := httptest.NewRecorder()
    handler.Create(rr, req)

    // Assert
    assert.Equal(t, http.StatusCreated, rr.Code)

    var resp api.APIResponse
    err := json.Unmarshal(rr.Body.Bytes(), &resp)
    require.NoError(t, err)
    assert.NotNil(t, resp.Data)
}

func TestCreateOrder_BadRequest(t *testing.T) {
    handler := api.NewOrderHandler(&mockOrderService{})

    req := httptest.NewRequest(http.MethodPost, "/api/v1/orders", bytes.NewBufferString(`invalid json`))
    req.Header.Set("Content-Type", "application/json")

    rr := httptest.NewRecorder()
    handler.Create(rr, req)

    assert.Equal(t, http.StatusBadRequest, rr.Code)
}

// Test the full router including middleware and path params
func TestGetOrder_FullRouter(t *testing.T) {
    mockSvc := &mockOrderService{
        getFunc: func(ctx context.Context, id string) (*model.Order, error) {
            if id == "order-123" {
                return &model.Order{ID: "order-123", UserID: "user-1"}, nil
            }
            return nil, model.ErrOrderNotFound
        },
    }

    // Build full router with chi
    r := chi.NewRouter()
    handler := api.NewOrderHandler(mockSvc)
    r.Get("/api/v1/orders/{orderID}", handler.Get)

    // Test found
    req := httptest.NewRequest(http.MethodGet, "/api/v1/orders/order-123", nil)
    rr := httptest.NewRecorder()
    r.ServeHTTP(rr, req)
    assert.Equal(t, http.StatusOK, rr.Code)

    // Test not found
    req = httptest.NewRequest(http.MethodGet, "/api/v1/orders/nonexistent", nil)
    rr = httptest.NewRecorder()
    r.ServeHTTP(rr, req)
    assert.Equal(t, http.StatusNotFound, rr.Code)
}
```

---

## 13D — Testing Patterns in Large Codebases

### Test Helpers

```go
// testutil/helpers.go
package testutil

import "testing"

func MustJSON(t *testing.T, v interface{}) string {
    t.Helper() // marks this as a helper — errors report caller's line number
    b, err := json.Marshal(v)
    if err != nil {
        t.Fatalf("marshal json: %v", err)
    }
    return string(b)
}

func NewTestOrder(overrides ...func(*model.Order)) *model.Order {
    order := &model.Order{
        ID:          "test-order-" + uuid.New().String()[:8],
        UserID:      "test-user-1",
        Status:      model.OrderStatusPending,
        TotalAmount: 5000,
        Currency:    "USD",
        CreatedAt:   time.Now().UTC(),
        UpdatedAt:   time.Now().UTC(),
    }
    for _, fn := range overrides {
        fn(order)
    }
    return order
}
```

### Parallel Tests

```go
func TestOrderService(t *testing.T) {
    t.Parallel() // run this test in parallel with other parallel tests

    t.Run("create", func(t *testing.T) {
        t.Parallel() // subtests can also run in parallel
        // ...
    })

    t.Run("cancel", func(t *testing.T) {
        t.Parallel()
        // ...
    })
}
```

### What to Test and What Not to Test

| Test | Worth It? |
|---|---|
| Service business logic | **Yes** — this is where bugs hide |
| Input validation | **Yes** — boundary conditions matter |
| Error mapping (domain → HTTP) | **Yes** — wrong status codes confuse frontend |
| Repository with real DB | **Yes** — SQL bugs are common |
| Simple getter/setter methods | **No** — no logic to test |
| Third-party library wrappers | **No** — trust the library |
| Exact log messages | **No** — logs change often, testing them is brittle |

### Code Coverage

```bash
go test -coverprofile=coverage.out ./...
go tool cover -html=coverage.out  # opens interactive HTML report
go tool cover -func=coverage.out  # prints per-function coverage
```

**What coverage means:** 80% coverage means 80% of your code lines were executed during tests. It does NOT mean 80% of scenarios are covered. A test that calls every function without asserting anything gives 100% coverage and catches zero bugs.

**Target:** Most companies aim for 60-80% coverage on backend services, with higher coverage on critical paths (payment processing, auth).

---

→ **Continued in [Part 14 — Error Handling at Scale](./part14_error_handling.md)**
