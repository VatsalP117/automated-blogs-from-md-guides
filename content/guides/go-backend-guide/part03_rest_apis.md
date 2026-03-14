# Part 3 — Building REST APIs in Go

> **Series:** The Definitive Go Backend Guide for Frontend Engineers
> **Prev:** [Part 2 — Project Structure](./part02_project_structure.md)
> **Next:** [Part 4 — Middleware](./part04_middleware.md)

---

## Table of Contents

- [net/http Deep Dive — How It Actually Works](#nethttp-deep-dive)
- [Why Companies Use Routers (Chi, Gin, Echo)](#why-companies-use-routers)
- [Full REST API with Chi](#full-rest-api-with-chi)
- [Request Validation](#request-validation)
- [API Versioning](#api-versioning)
- [Pagination Patterns](#pagination-patterns)
- [File Uploads](#file-uploads)
- [Full Working Multi-Resource API Example](#full-working-multi-resource-api-example)

---

## net/http Deep Dive

### The Frontend Analogy

In Express.js, you write: `app.get('/users', handler)`. Go's `net/http` is similar in concept but lower-level. There's no framework — the standard library gives you everything.

### How It Works Under the Hood

```go
package main

import (
    "encoding/json"
    "net/http"
)

func main() {
    // http.HandleFunc registers a handler for a URL pattern.
    // When a request matches "/health", Go calls this function.
    http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
        // w is the ResponseWriter — you write the HTTP response to it
        // r is the Request — it contains method, URL, headers, body, context
        w.Header().Set("Content-Type", "application/json")
        w.WriteHeader(http.StatusOK)
        json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
    })

    // ListenAndServe starts the HTTP server.
    // For EVERY incoming request, Go spawns a new goroutine.
    // This means your server handles thousands of concurrent requests natively.
    http.ListenAndServe(":8080", nil)
}
```

**Critical detail:** `net/http` spawns **one goroutine per request.** This is fundamentally different from Node.js (single-threaded event loop). In Go, 10,000 simultaneous requests means 10,000 goroutines running in parallel — and goroutines are lightweight enough to handle this.

### The `http.Handler` Interface

This is the most important interface in Go web development:

```go
type Handler interface {
    ServeHTTP(ResponseWriter, *Request)
}
```

Any type that implements `ServeHTTP` can handle HTTP requests. This simplicity is what makes middleware, routers, and the entire Go HTTP ecosystem work.

```go
// A struct that implements http.Handler
type healthHandler struct{}

func (h *healthHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
    w.Write([]byte(`{"status":"ok"}`))
}

// Register it
http.Handle("/health", &healthHandler{})
```

### Why `net/http` Alone Isn't Enough

The standard library's router (called `DefaultServeMux`) has limitations:

- No path parameters (`/users/{id}` doesn't work).
- No method-based routing (can't distinguish `GET /users` from `POST /users`).
- No route grouping (can't apply middleware to a group of routes).
- No middleware chaining.

This is why every production Go service uses a third-party router.

---

## Why Companies Use Routers

### The Big Three: Chi, Gin, Echo

| Router | Style | Performance | Ecosystem | Used By |
|---|---|---|---|---|
| **Chi** | `net/http` compatible | Fast | Minimal, composable | Cloudflare, Heroku |
| **Gin** | Custom context | Fastest | Rich (built-in validation, binding) | Many startups |
| **Echo** | Custom context | Fast | Rich | Various companies |

### Which to Learn

**Chi** is the recommended choice for this guide and for most serious codebases because:

1. It's **100% compatible with `net/http`** — handlers are `http.HandlerFunc`, not custom types. This means all standard library middleware works.
2. It's lightweight — a router, not a framework. You compose what you need.
3. It's the most "Go-idiomatic" — doesn't introduce custom abstractions.

**Gin** is popular but uses a custom `gin.Context` instead of `http.ResponseWriter` + `*http.Request`. This means you can't use standard `net/http` middleware without adapters.

---

## Full REST API with Chi

### Router Setup and Grouping

```go
// internal/api/router.go

package api

import (
    "net/http"
    "time"

    "github.com/go-chi/chi/v5"
    "github.com/go-chi/chi/v5/middleware"
    "go.uber.org/zap"

    "github.com/yourcompany/order-service/internal/service"
)

func NewRouter(orderSvc *service.OrderService, userSvc *service.UserService, logger *zap.Logger) http.Handler {
    r := chi.NewRouter()

    // Global middleware — applied to every request
    r.Use(middleware.RequestID)      // Injects X-Request-Id header
    r.Use(middleware.RealIP)         // Extracts real IP from X-Forwarded-For
    r.Use(NewStructuredLogger(logger)) // Custom structured logging middleware
    r.Use(middleware.Recoverer)      // Catches panics, returns 500
    r.Use(middleware.Timeout(30 * time.Second)) // Request timeout

    // Public routes — no auth required
    r.Get("/health", healthCheck)
    r.Get("/ready", readinessCheck)

    // API v1 routes — grouped with auth middleware
    r.Route("/api/v1", func(r chi.Router) {
        r.Use(AuthMiddleware) // All /api/v1/* routes require authentication

        // User routes
        r.Route("/users", func(r chi.Router) {
            r.Get("/", NewUserHandler(userSvc).List)       // GET /api/v1/users
            r.Post("/", NewUserHandler(userSvc).Create)    // POST /api/v1/users

            r.Route("/{userID}", func(r chi.Router) {
                r.Get("/", NewUserHandler(userSvc).Get)    // GET /api/v1/users/{userID}
                r.Put("/", NewUserHandler(userSvc).Update) // PUT /api/v1/users/{userID}
                r.Delete("/", NewUserHandler(userSvc).Delete) // DELETE /api/v1/users/{userID}
            })
        })

        // Order routes
        r.Route("/orders", func(r chi.Router) {
            r.Get("/", NewOrderHandler(orderSvc).List)
            r.Post("/", NewOrderHandler(orderSvc).Create)

            r.Route("/{orderID}", func(r chi.Router) {
                r.Get("/", NewOrderHandler(orderSvc).Get)
                r.Post("/cancel", NewOrderHandler(orderSvc).Cancel)
            })
        })
    })

    return r
}

func healthCheck(w http.ResponseWriter, r *http.Request) {
    respondJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func readinessCheck(w http.ResponseWriter, r *http.Request) {
    respondJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}
```

### Response Helpers — Consistent JSON Structure

```go
// internal/api/response.go

package api

import (
    "encoding/json"
    "net/http"
)

// Every API response follows this structure for consistency.
// Frontend developers love this because they always know the shape.

type APIResponse struct {
    Data    interface{} `json:"data,omitempty"`
    Error   *APIError   `json:"error,omitempty"`
    Meta    *Meta       `json:"meta,omitempty"`
}

type APIError struct {
    Code    string `json:"code"`
    Message string `json:"message"`
}

type Meta struct {
    Page       int  `json:"page,omitempty"`
    PerPage    int  `json:"per_page,omitempty"`
    Total      int  `json:"total,omitempty"`
    HasMore    bool `json:"has_more,omitempty"`
    NextCursor string `json:"next_cursor,omitempty"`
}

func respondJSON(w http.ResponseWriter, status int, data interface{}) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)

    resp := APIResponse{Data: data}
    json.NewEncoder(w).Encode(resp)
}

func respondError(w http.ResponseWriter, status int, code, message string) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)

    resp := APIResponse{
        Error: &APIError{Code: code, Message: message},
    }
    json.NewEncoder(w).Encode(resp)
}

func respondList(w http.ResponseWriter, status int, data interface{}, meta *Meta) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)

    resp := APIResponse{Data: data, Meta: meta}
    json.NewEncoder(w).Encode(resp)
}
```

### Request Body Parsing and Path Params

```go
// internal/api/request.go

package api

import (
    "encoding/json"
    "fmt"
    "net/http"
)

// Request DTOs — separate from domain models.
// These represent what the API accepts, not what the database stores.

type CreateOrderRequest struct {
    Items []CreateOrderItemRequest `json:"items" validate:"required,min=1,dive"`
}

type CreateOrderItemRequest struct {
    ProductID string `json:"product_id" validate:"required"`
    Quantity  int    `json:"quantity" validate:"required,min=1,max=100"`
}

// decodeJSON reads and decodes the request body into the target struct.
// It enforces that the body is JSON and has a reasonable size limit.
func decodeJSON(r *http.Request, dst interface{}) error {
    // Limit request body to 1MB to prevent abuse
    r.Body = http.MaxBytesReader(nil, r.Body, 1<<20)

    decoder := json.NewDecoder(r.Body)
    decoder.DisallowUnknownFields() // reject unexpected fields

    if err := decoder.Decode(dst); err != nil {
        return fmt.Errorf("invalid JSON: %w", err)
    }
    return nil
}
```

### The Handler — Tying It All Together

```go
// internal/api/handler.go

package api

import (
    "errors"
    "net/http"

    "github.com/go-chi/chi/v5"

    "github.com/yourcompany/order-service/internal/model"
    "github.com/yourcompany/order-service/internal/service"
)

type OrderHandler struct {
    svc *service.OrderService
}

func NewOrderHandler(svc *service.OrderService) *OrderHandler {
    return &OrderHandler{svc: svc}
}

// Create handles POST /api/v1/orders
func (h *OrderHandler) Create(w http.ResponseWriter, r *http.Request) {
    // 1. Decode request body
    var req CreateOrderRequest
    if err := decodeJSON(r, &req); err != nil {
        respondError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
        return
    }

    // 2. Validate (covered in detail below)
    if err := validate.Struct(req); err != nil {
        respondError(w, http.StatusBadRequest, "VALIDATION_ERROR", formatValidationErrors(err))
        return
    }

    // 3. Extract authenticated user from context (set by auth middleware)
    userID := UserIDFromContext(r.Context())

    // 4. Convert request DTO to domain model
    items := make([]model.OrderItem, len(req.Items))
    for i, item := range req.Items {
        items[i] = model.OrderItem{
            ProductID: item.ProductID,
            Quantity:  item.Quantity,
        }
    }

    // 5. Call service layer
    order, err := h.svc.CreateOrder(r.Context(), userID, items)
    if err != nil {
        // 6. Map domain errors to HTTP responses
        switch {
        case errors.Is(err, model.ErrInsufficientStock):
            respondError(w, http.StatusConflict, "INSUFFICIENT_STOCK", "one or more items are out of stock")
        default:
            respondError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to create order")
        }
        return
    }

    // 7. Respond with the created resource
    respondJSON(w, http.StatusCreated, order)
}

// Get handles GET /api/v1/orders/{orderID}
func (h *OrderHandler) Get(w http.ResponseWriter, r *http.Request) {
    orderID := chi.URLParam(r, "orderID") // extract path parameter

    order, err := h.svc.GetOrder(r.Context(), orderID)
    if err != nil {
        if errors.Is(err, model.ErrOrderNotFound) {
            respondError(w, http.StatusNotFound, "NOT_FOUND", "order not found")
            return
        }
        respondError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to get order")
        return
    }

    respondJSON(w, http.StatusOK, order)
}

// List handles GET /api/v1/orders?page=1&per_page=20
func (h *OrderHandler) List(w http.ResponseWriter, r *http.Request) {
    userID := UserIDFromContext(r.Context())

    page, perPage := parsePagination(r)

    orders, total, err := h.svc.ListOrders(r.Context(), userID, perPage, (page-1)*perPage)
    if err != nil {
        respondError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to list orders")
        return
    }

    respondList(w, http.StatusOK, orders, &Meta{
        Page:    page,
        PerPage: perPage,
        Total:   total,
        HasMore: page*perPage < total,
    })
}

// Cancel handles POST /api/v1/orders/{orderID}/cancel
func (h *OrderHandler) Cancel(w http.ResponseWriter, r *http.Request) {
    orderID := chi.URLParam(r, "orderID")

    order, err := h.svc.CancelOrder(r.Context(), orderID)
    if err != nil {
        switch {
        case errors.Is(err, model.ErrOrderNotFound):
            respondError(w, http.StatusNotFound, "NOT_FOUND", "order not found")
        case errors.Is(err, model.ErrInvalidOrderStatus):
            respondError(w, http.StatusConflict, "INVALID_STATUS", "order cannot be cancelled in current status")
        default:
            respondError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to cancel order")
        }
        return
    }

    respondJSON(w, http.StatusOK, order)
}
```

### Status Codes — When to Use Each

| Status Code | When | Example |
|---|---|---|
| `200 OK` | Successful GET, PUT, PATCH | Get user, update user |
| `201 Created` | Successful POST that creates a resource | Create order |
| `204 No Content` | Successful DELETE | Delete user |
| `400 Bad Request` | Invalid input (malformed JSON, validation errors) | Missing required field |
| `401 Unauthorized` | Missing or invalid authentication | No JWT, expired JWT |
| `403 Forbidden` | Authenticated but not authorized | User tries to access admin endpoint |
| `404 Not Found` | Resource doesn't exist | Get order with invalid ID |
| `409 Conflict` | Business rule violation | Duplicate email, insufficient stock |
| `422 Unprocessable Entity` | Syntactically valid but semantically wrong | Valid JSON but email format is wrong |
| `429 Too Many Requests` | Rate limit exceeded | Too many API calls |
| `500 Internal Server Error` | Unexpected server failure | Database down, nil pointer |

---

## Request Validation

### Using `go-playground/validator`

This is the standard validation library used in production Go services:

```go
package api

import (
    "fmt"
    "strings"

    "github.com/go-playground/validator/v10"
)

// Single global validator instance — thread-safe, reusable
var validate = validator.New()

type CreateUserRequest struct {
    Email     string `json:"email" validate:"required,email,max=255"`
    Name      string `json:"name" validate:"required,min=2,max=100"`
    Password  string `json:"password" validate:"required,min=8,max=72"`
    Role      string `json:"role" validate:"required,oneof=admin member viewer"`
}

func formatValidationErrors(err error) string {
    var messages []string

    // validator returns a slice of FieldError
    for _, e := range err.(validator.ValidationErrors) {
        switch e.Tag() {
        case "required":
            messages = append(messages, fmt.Sprintf("%s is required", e.Field()))
        case "email":
            messages = append(messages, fmt.Sprintf("%s must be a valid email", e.Field()))
        case "min":
            messages = append(messages, fmt.Sprintf("%s must be at least %s characters", e.Field(), e.Param()))
        case "max":
            messages = append(messages, fmt.Sprintf("%s must be at most %s characters", e.Field(), e.Param()))
        case "oneof":
            messages = append(messages, fmt.Sprintf("%s must be one of: %s", e.Field(), e.Param()))
        default:
            messages = append(messages, fmt.Sprintf("%s failed validation: %s", e.Field(), e.Tag()))
        }
    }

    return strings.Join(messages, "; ")
}
```

---

## API Versioning

```go
// Version via URL prefix — the simplest and most common approach
r.Route("/api/v1", func(r chi.Router) {
    r.Get("/users", v1UserHandler.List)
})

r.Route("/api/v2", func(r chi.Router) {
    // v2 might return a different response shape
    r.Get("/users", v2UserHandler.List)
})
```

**What companies actually do:**

- URL prefix versioning (`/v1/`, `/v2/`) is the most common because it's explicit and easy to route.
- Header versioning (`Accept: application/vnd.api+json;version=2`) exists but is rare.
- Most companies only maintain 2 versions at most and deprecate old ones aggressively.

---

## Pagination Patterns

### Offset-Based Pagination (Simple)

```go
// GET /api/v1/orders?page=2&per_page=20

func parsePagination(r *http.Request) (page, perPage int) {
    page = 1
    perPage = 20

    if p := r.URL.Query().Get("page"); p != "" {
        if parsed, err := strconv.Atoi(p); err == nil && parsed > 0 {
            page = parsed
        }
    }

    if pp := r.URL.Query().Get("per_page"); pp != "" {
        if parsed, err := strconv.Atoi(pp); err == nil && parsed > 0 && parsed <= 100 {
            perPage = parsed
        }
    }

    return page, perPage
}

// SQL: SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3
```

**Problem:** Offset pagination gets slower as the page number grows because the DB still scans all skipped rows.

### Cursor-Based Pagination (Production-Grade)

```go
// GET /api/v1/orders?cursor=eyJpZCI6Im9yZGVyLTEyMyJ9&limit=20

type CursorPagination struct {
    Cursor string `json:"cursor"` // base64-encoded last item identifier
    Limit  int    `json:"limit"`
}

func parseCursorPagination(r *http.Request) CursorPagination {
    limit := 20
    if l := r.URL.Query().Get("limit"); l != "" {
        if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 && parsed <= 100 {
            limit = parsed
        }
    }

    return CursorPagination{
        Cursor: r.URL.Query().Get("cursor"),
        Limit:  limit,
    }
}

// SQL: SELECT * FROM orders WHERE user_id = $1 AND created_at < $2
//      ORDER BY created_at DESC LIMIT $3
// $2 = decoded cursor (timestamp of last item from previous page)
```

**Why cursor is better:** It uses an indexed column (like `created_at`) to seek directly to the right position — performance is constant regardless of "page number."

---

## File Uploads

```go
func (h *Handler) UploadAvatar(w http.ResponseWriter, r *http.Request) {
    // Limit total upload size to 10MB
    r.Body = http.MaxBytesReader(w, r.Body, 10<<20)

    // Parse the multipart form
    if err := r.ParseMultipartForm(10 << 20); err != nil {
        respondError(w, http.StatusBadRequest, "FILE_TOO_LARGE", "max file size is 10MB")
        return
    }

    file, header, err := r.FormFile("avatar")
    if err != nil {
        respondError(w, http.StatusBadRequest, "MISSING_FILE", "avatar file is required")
        return
    }
    defer file.Close()

    // Validate file type by reading the first 512 bytes (magic bytes)
    buff := make([]byte, 512)
    if _, err := file.Read(buff); err != nil {
        respondError(w, http.StatusBadRequest, "INVALID_FILE", "could not read file")
        return
    }

    contentType := http.DetectContentType(buff)
    allowedTypes := map[string]bool{
        "image/jpeg": true,
        "image/png":  true,
        "image/webp": true,
    }
    if !allowedTypes[contentType] {
        respondError(w, http.StatusBadRequest, "INVALID_TYPE", "only JPEG, PNG, and WebP are allowed")
        return
    }

    // Reset reader position after reading magic bytes
    if _, err := file.Seek(0, 0); err != nil {
        respondError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to process file")
        return
    }

    // Generate a safe filename using UUID — NEVER use user-provided filenames
    ext := filepath.Ext(header.Filename)
    safeFilename := uuid.New().String() + ext

    // In production: upload to S3/GCS, not local filesystem
    // objectURL, err := h.storage.Upload(r.Context(), safeFilename, file, contentType)

    respondJSON(w, http.StatusOK, map[string]string{
        "filename": safeFilename,
        "size":     fmt.Sprintf("%d", header.Size),
    })
}
```

---

## Full Working Multi-Resource API Example

Here's a `Makefile` tying it all together, which is what you'd use to develop locally:

```makefile
.PHONY: build run test lint migrate

build:
	go build -o bin/server ./cmd/server

run:
	go run ./cmd/server

test:
	go test -v -race -count=1 ./...

lint:
	golangci-lint run ./...

migrate-up:
	migrate -path migrations -database "$(DATABASE_URL)" up

migrate-down:
	migrate -path migrations -database "$(DATABASE_URL)" down 1

migrate-create:
	migrate create -ext sql -dir migrations -seq $(name)
```

**Running the service locally:**

```bash
# Set required environment variables
export DATABASE_URL="postgres://user:pass@localhost:5432/orderdb?sslmode=disable"
export JWT_SECRET="dev-secret-do-not-use-in-production"
export PORT=8080

# Run migrations
make migrate-up

# Start the server
make run

# Test it
curl http://localhost:8080/health
curl -X POST http://localhost:8080/api/v1/orders \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"items": [{"product_id": "prod-1", "quantity": 2}]}'
```

---

→ **Continued in [Part 4 — Middleware](./part04_middleware.md)**
