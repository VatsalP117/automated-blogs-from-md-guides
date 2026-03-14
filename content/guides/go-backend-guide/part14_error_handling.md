# Part 14 — Error Handling at Scale

> **Series:** The Definitive Go Backend Guide for Frontend Engineers
> **Prev:** [Part 13 — Testing](./part13_testing.md)
> **Next:** [Part 15 — Service-to-Service Communication](./part15_service_communication.md)

---

## Table of Contents

- [Go's Error Philosophy vs Exceptions](#gos-error-philosophy-vs-exceptions)
- [Defining Domain Errors](#defining-domain-errors)
- [Wrapping Errors with Context](#wrapping-errors-with-context)
- [Translating Errors to HTTP Responses](#translating-errors-to-http-responses)
- [Logging Errors at the Right Layer](#logging-errors-at-the-right-layer)
- [Panic vs Error](#panic-vs-error)
- [Full Production Error Handling System](#full-production-error-handling-system)

---

## Go's Error Philosophy vs Exceptions

In JavaScript/Java/Python, errors fly through the stack via exceptions. You write `try/catch` at some boundary and hope you catch the right thing.

In Go, errors are **values.** Every function that can fail returns an error as its last return value. You handle it immediately or propagate it explicitly. There is no hidden control flow.

```go
// JavaScript — error can fly from ANY nested call
try {
    const order = await createOrder(data);
} catch (err) {
    // Which function failed? createOrder? Something inside it?
    // What kind of error? Network? Validation? DB? Who knows.
}

// Go — every failure point is visible
user, err := s.userRepo.GetByID(ctx, userID)
if err != nil {
    return nil, fmt.Errorf("create order: get user: %w", err)
}

product, err := s.productRepo.GetByID(ctx, productID)
if err != nil {
    return nil, fmt.Errorf("create order: get product: %w", err)
}

// You can SEE every place something can go wrong by reading the code top to bottom.
```

---

## Defining Domain Errors

### Sentinel Errors

Predefined error values for well-known failure cases:

```go
// internal/model/errors.go

package model

import "errors"

// Sentinel errors — predefined, named errors for expected business failures.
// These are used with errors.Is() to match specific failure cases.

var (
    ErrNotFound            = errors.New("not found")
    ErrOrderNotFound       = errors.New("order not found")
    ErrUserNotFound        = errors.New("user not found")
    ErrProductNotFound     = errors.New("product not found")

    ErrDuplicateEmail      = errors.New("duplicate email")
    ErrDuplicateOrder      = errors.New("duplicate order")

    ErrInsufficientBalance = errors.New("insufficient balance")
    ErrInsufficientStock   = errors.New("insufficient stock")

    ErrInvalidOrderStatus  = errors.New("invalid order status transition")
    ErrOrderAlreadyCancelled = errors.New("order already cancelled")

    ErrUnauthorized        = errors.New("unauthorized")
    ErrForbidden           = errors.New("forbidden")
)
```

### Custom Error Types

When you need to carry additional data with the error:

```go
// ValidationError carries details about which fields failed validation
type ValidationError struct {
    Field   string
    Message string
}

type ValidationErrors []ValidationError

func (e ValidationErrors) Error() string {
    msgs := make([]string, len(e))
    for i, ve := range e {
        msgs[i] = fmt.Sprintf("%s: %s", ve.Field, ve.Message)
    }
    return strings.Join(msgs, "; ")
}

// Usage:
func validateCreateOrderRequest(req CreateOrderRequest) error {
    var errs ValidationErrors

    if len(req.Items) == 0 {
        errs = append(errs, ValidationError{Field: "items", Message: "at least one item is required"})
    }
    for i, item := range req.Items {
        if item.Quantity < 1 {
            errs = append(errs, ValidationError{
                Field:   fmt.Sprintf("items[%d].quantity", i),
                Message: "must be at least 1",
            })
        }
    }

    if len(errs) > 0 {
        return errs
    }
    return nil
}
```

---

## Wrapping Errors with Context

The `%w` verb in `fmt.Errorf` wraps an error, preserving the chain for `errors.Is` and `errors.As`:

```go
// Each layer adds context about what it was doing when the error occurred

// Repository layer
func (r *repo) GetByID(ctx context.Context, id string) (*Order, error) {
    var order Order
    err := r.db.GetContext(ctx, &order, `SELECT * FROM orders WHERE id = $1`, id)
    if err == sql.ErrNoRows {
        return nil, model.ErrOrderNotFound // return sentinel, don't wrap
    }
    if err != nil {
        return nil, fmt.Errorf("query order %s: %w", id, err) // wrap with context
    }
    return &order, nil
}

// Service layer
func (s *svc) CancelOrder(ctx context.Context, orderID string) (*Order, error) {
    order, err := s.repo.GetByID(ctx, orderID)
    if err != nil {
        return nil, fmt.Errorf("cancel order: %w", err) // adds "cancel order:" prefix
    }

    if order.Status == model.OrderStatusCancelled {
        return nil, model.ErrOrderAlreadyCancelled
    }

    // ...
}
```

The resulting error chain:

```
cancel order: query order ord-123: connection refused
```

You can still check the original cause:

```go
if errors.Is(err, model.ErrOrderNotFound) {
    // handle not found
}
```

---

## Translating Errors to HTTP Responses

The handler layer is responsible for mapping domain errors to appropriate HTTP responses. This is the **error mapping layer:**

```go
// internal/api/errors.go

package api

import (
    "errors"
    "net/http"

    "github.com/yourcompany/order-service/internal/model"
)

type errorMapping struct {
    status  int
    code    string
    message string
}

// Map domain errors to HTTP responses
var errorMap = map[error]errorMapping{
    model.ErrOrderNotFound:       {http.StatusNotFound, "ORDER_NOT_FOUND", "order not found"},
    model.ErrUserNotFound:        {http.StatusNotFound, "USER_NOT_FOUND", "user not found"},
    model.ErrProductNotFound:     {http.StatusNotFound, "PRODUCT_NOT_FOUND", "product not found"},
    model.ErrDuplicateEmail:      {http.StatusConflict, "DUPLICATE_EMAIL", "email already in use"},
    model.ErrInsufficientBalance: {http.StatusConflict, "INSUFFICIENT_BALANCE", "insufficient account balance"},
    model.ErrInsufficientStock:   {http.StatusConflict, "INSUFFICIENT_STOCK", "product out of stock"},
    model.ErrInvalidOrderStatus:  {http.StatusConflict, "INVALID_STATUS", "invalid order status transition"},
    model.ErrUnauthorized:        {http.StatusUnauthorized, "UNAUTHORIZED", "authentication required"},
    model.ErrForbidden:           {http.StatusForbidden, "FORBIDDEN", "insufficient permissions"},
}

func handleError(w http.ResponseWriter, err error) {
    // Check for validation errors first
    var validationErrs model.ValidationErrors
    if errors.As(err, &validationErrs) {
        respondError(w, http.StatusBadRequest, "VALIDATION_ERROR", validationErrs.Error())
        return
    }

    // Check the error map
    for sentinel, mapping := range errorMap {
        if errors.Is(err, sentinel) {
            respondError(w, mapping.status, mapping.code, mapping.message)
            return
        }
    }

    // Unknown error — return 500 with a generic message.
    // NEVER expose internal error details to the client.
    respondError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "an unexpected error occurred")
}
```

Usage in handlers becomes clean:

```go
func (h *OrderHandler) Cancel(w http.ResponseWriter, r *http.Request) {
    orderID := chi.URLParam(r, "orderID")

    order, err := h.svc.CancelOrder(r.Context(), orderID)
    if err != nil {
        handleError(w, err) // one-liner error handling
        return
    }

    respondJSON(w, http.StatusOK, order)
}
```

---

## Logging Errors at the Right Layer

**Rule: Log errors once, at the boundary.** Don't log in the repository AND the service AND the handler — that creates duplicate log entries that make debugging harder.

```go
// BAD — error logged three times for one failure
func (r *repo) GetByID(ctx context.Context, id string) (*Order, error) {
    err := r.db.GetContext(ctx, &order, query, id)
    if err != nil {
        log.Error("db query failed", err) // log #1
        return nil, err
    }
}

func (s *svc) GetOrder(ctx context.Context, id string) (*Order, error) {
    order, err := s.repo.GetByID(ctx, id)
    if err != nil {
        log.Error("failed to get order", err) // log #2 (duplicate!)
        return nil, err
    }
}

func (h *handler) GetOrder(w http.ResponseWriter, r *http.Request) {
    order, err := h.svc.GetOrder(ctx, id)
    if err != nil {
        log.Error("handler error", err) // log #3 (duplicate!)
        respondError(w, 500, "error")
    }
}

// GOOD — wrap at each layer, log ONCE at the boundary (handler or middleware)
func (r *repo) GetByID(ctx context.Context, id string) (*Order, error) {
    err := r.db.GetContext(ctx, &order, query, id)
    if err != nil {
        return nil, fmt.Errorf("query order %s: %w", id, err) // wrap, don't log
    }
}

func (s *svc) GetOrder(ctx context.Context, id string) (*Order, error) {
    order, err := s.repo.GetByID(ctx, id)
    if err != nil {
        return nil, fmt.Errorf("get order: %w", err) // wrap, don't log
    }
}

// Log once at the handler or in the logging middleware
func (h *handler) GetOrder(w http.ResponseWriter, r *http.Request) {
    order, err := h.svc.GetOrder(r.Context(), id)
    if err != nil {
        // Log the full error chain (with all context from wrapping)
        h.logger.Error("request failed",
            zap.String("request_id", RequestIDFromContext(r.Context())),
            zap.Error(err),
        )
        handleError(w, err)
    }
}
```

---

## Panic vs Error

| | `error` | `panic` |
|---|---|---|
| **When** | Expected failures (DB down, user not found, validation) | Programmer bugs (nil dereference, index out of range) |
| **Recovery** | Handled by caller with `if err != nil` | Caught by `recover()` in middleware |
| **Frequency** | Used constantly (every function) | Used almost never |
| **In production** | Normal operation | Should never happen; if it does, investigate |

**Rules:**

- Functions should return `error`, not panic.
- Only panic for truly unreachable code or startup failures.
- Always have a recovery middleware to catch unexpected panics.

---

## Full Production Error Handling System

Putting it all together — the complete error flow:

```go
// 1. Define domain errors (internal/model/errors.go)
var ErrOrderNotFound = errors.New("order not found")

// 2. Repository wraps DB errors
func (r *repo) GetByID(ctx context.Context, id string) (*Order, error) {
    // ...
    if err == sql.ErrNoRows {
        return nil, ErrOrderNotFound
    }
    return nil, fmt.Errorf("query order: %w", err)
}

// 3. Service wraps with business context
func (s *svc) CancelOrder(ctx context.Context, id string) (*Order, error) {
    order, err := s.repo.GetByID(ctx, id)
    if err != nil {
        return nil, fmt.Errorf("cancel order %s: %w", id, err)
    }
    // ...
}

// 4. Handler maps to HTTP, logs once
func (h *handler) CancelOrder(w http.ResponseWriter, r *http.Request) {
    order, err := h.svc.CancelOrder(r.Context(), chi.URLParam(r, "orderID"))
    if err != nil {
        logger := LoggerFromContext(r.Context())
        if !errors.Is(err, ErrOrderNotFound) {
            // Only log unexpected errors — 404s are normal
            logger.Error("cancel order failed", zap.Error(err))
        }
        handleError(w, err)
        return
    }
    respondJSON(w, http.StatusOK, order)
}

// 5. Recovery middleware catches panics
// (from Part 4)

// 6. Logging middleware records request outcome
// (from Part 4)
```

**Result:** Clean separation of concerns. Each layer does one job. Errors carry full context. Logs are not duplicated. HTTP responses are consistent.

---

→ **Continued in [Part 15 — Service-to-Service Communication](./part15_service_communication.md)**
