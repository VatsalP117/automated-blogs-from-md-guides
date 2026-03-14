# Part 4 — Middleware (The Backbone of Every Backend)

> **Series:** The Definitive Go Backend Guide for Frontend Engineers
> **Prev:** [Part 3 — Building REST APIs](./part03_rest_apis.md)
> **Next:** [Part 5 — Context](./part05_context.md)

---

## Table of Contents

- [What Middleware Is and How It Works](#what-middleware-is-and-how-it-works)
- [Writing Custom Middleware from Scratch](#writing-custom-middleware-from-scratch)
- [Middleware Chaining — Order Matters](#middleware-chaining--order-matters)
- [Request ID / Correlation ID Middleware](#request-id--correlation-id-middleware)
- [Structured Logging Middleware](#structured-logging-middleware)
- [Recovery Middleware](#recovery-middleware)
- [Authentication Middleware (JWT)](#authentication-middleware-jwt)
- [Rate Limiting Middleware](#rate-limiting-middleware)
- [CORS Middleware](#cors-middleware)
- [Timeout Middleware](#timeout-middleware)
- [How Middleware Uses Context](#how-middleware-uses-context)
- [Full Production Middleware Stack](#full-production-middleware-stack)

---

## What Middleware Is and How It Works

### The Frontend Analogy

If you've used Express.js, you've written middleware:

```javascript
app.use((req, res, next) => {
  console.log('Request received');
  next(); // pass to next handler
});
```

Go middleware works the same way conceptually: it wraps your handler and runs code **before** and/or **after** the handler executes.

### The Pattern

In Go, middleware is a function that takes an `http.Handler` and returns a new `http.Handler`:

```go
// This is the middleware signature you'll see everywhere
func MyMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Code here runs BEFORE the handler
        fmt.Println("before")

        next.ServeHTTP(w, r) // call the actual handler (or next middleware)

        // Code here runs AFTER the handler
        fmt.Println("after")
    })
}
```

### Visual Model

```
Request arrives
    │
    ▼
┌─ Middleware A (before) ─┐
│  ┌─ Middleware B (before) ─┐
│  │  ┌─ Middleware C (before) ─┐
│  │  │                         │
│  │  │    Your Handler         │  ← actual business logic
│  │  │                         │
│  │  └─ Middleware C (after) ──┘
│  └─ Middleware B (after) ──┘
└─ Middleware A (after) ──┘
    │
    ▼
Response sent
```

This is the "onion model" — each middleware wraps the next one. The request peels inward, the response builds outward.

---

## Writing Custom Middleware from Scratch

```go
// A middleware that adds a custom header to every response
func ServerVersionMiddleware(version string) func(http.Handler) http.Handler {
    // The outer function captures config (version)
    // The inner function is the actual middleware
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            w.Header().Set("X-Server-Version", version)
            next.ServeHTTP(w, r) // always call next unless you want to short-circuit
        })
    }
}

// Usage:
r.Use(ServerVersionMiddleware("1.2.3"))
```

### Middleware That Short-Circuits (Doesn't Call Next)

```go
// If the condition fails, we respond immediately without calling next
func RequireJSON(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if r.Method == http.MethodPost || r.Method == http.MethodPut {
            ct := r.Header.Get("Content-Type")
            if ct != "application/json" {
                http.Error(w, "Content-Type must be application/json", http.StatusUnsupportedMediaType)
                return // short-circuit — handler never runs
            }
        }
        next.ServeHTTP(w, r)
    })
}
```

---

## Middleware Chaining — Order Matters

```go
r := chi.NewRouter()

// Middleware executes in the ORDER they are added:
r.Use(RequestIDMiddleware)      // 1st: assigns request ID
r.Use(StructuredLoggerMiddleware) // 2nd: logs with request ID (needs it to exist)
r.Use(RecoveryMiddleware)       // 3rd: catches panics from everything below
r.Use(AuthMiddleware)           // 4th: validates JWT
r.Use(RateLimitMiddleware)      // 5th: rate limits authenticated requests
```

**Why order matters:**

- `RequestID` must come first so that every subsequent middleware and handler can reference it.
- `Logger` comes after RequestID so it can include the request ID in log entries.
- `Recovery` must wrap the auth and handler layers to catch any panics.
- `Auth` comes before rate limiting because you might want different rate limits per user.

---

## Request ID / Correlation ID Middleware

Every request gets a unique ID that follows it through all logs, service calls, and traces. This is how you debug issues in production.

```go
package api

import (
    "context"
    "net/http"

    "github.com/google/uuid"
)

type contextKey string

const requestIDKey contextKey = "request_id"

func RequestIDMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Check if the caller already sent a request ID (common in microservices)
        requestID := r.Header.Get("X-Request-ID")
        if requestID == "" {
            requestID = uuid.New().String()
        }

        // Store in context so every layer can access it
        ctx := context.WithValue(r.Context(), requestIDKey, requestID)

        // Set it on the response header so the caller can correlate
        w.Header().Set("X-Request-ID", requestID)

        // Pass the enriched context to the next handler
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// Helper to extract request ID from context (used by other code)
func RequestIDFromContext(ctx context.Context) string {
    if id, ok := ctx.Value(requestIDKey).(string); ok {
        return id
    }
    return "unknown"
}
```

---

## Structured Logging Middleware

Logs every request with method, path, status code, duration, and request ID:

```go
package api

import (
    "net/http"
    "time"

    "go.uber.org/zap"
)

// responseWriter wraps http.ResponseWriter to capture the status code
type responseWriter struct {
    http.ResponseWriter
    statusCode int
    written    bool
}

func newResponseWriter(w http.ResponseWriter) *responseWriter {
    return &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}
}

func (rw *responseWriter) WriteHeader(code int) {
    if !rw.written {
        rw.statusCode = code
        rw.written = true
    }
    rw.ResponseWriter.WriteHeader(code)
}

func NewStructuredLogger(logger *zap.Logger) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            start := time.Now()
            wrapped := newResponseWriter(w)

            // Run the handler
            next.ServeHTTP(wrapped, r)

            // Log after the handler completes
            duration := time.Since(start)
            logger.Info("http request",
                zap.String("method", r.Method),
                zap.String("path", r.URL.Path),
                zap.Int("status", wrapped.statusCode),
                zap.Duration("duration", duration),
                zap.String("request_id", RequestIDFromContext(r.Context())),
                zap.String("remote_addr", r.RemoteAddr),
                zap.String("user_agent", r.UserAgent()),
            )
        })
    }
}
```

---

## Recovery Middleware

Catches panics from handlers and returns 500 instead of crashing:

```go
package api

import (
    "net/http"
    "runtime/debug"

    "go.uber.org/zap"
)

func RecoveryMiddleware(logger *zap.Logger) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            defer func() {
                if rec := recover(); rec != nil {
                    // Log the panic with full stack trace
                    logger.Error("panic recovered",
                        zap.Any("panic_value", rec),
                        zap.String("stack", string(debug.Stack())),
                        zap.String("request_id", RequestIDFromContext(r.Context())),
                        zap.String("method", r.Method),
                        zap.String("path", r.URL.Path),
                    )

                    // Return 500 to the client — generic message to avoid leaking internals
                    http.Error(w, `{"error":{"code":"INTERNAL_ERROR","message":"internal server error"}}`,
                        http.StatusInternalServerError)
                }
            }()
            next.ServeHTTP(w, r)
        })
    }
}
```

---

## Authentication Middleware (JWT)

```go
package api

import (
    "context"
    "net/http"
    "strings"

    "github.com/golang-jwt/jwt/v5"
)

const userIDContextKey contextKey = "user_id"
const userRoleContextKey contextKey = "user_role"

func AuthMiddleware(jwtSecret string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // 1. Extract token from Authorization header
            authHeader := r.Header.Get("Authorization")
            if authHeader == "" {
                respondError(w, http.StatusUnauthorized, "MISSING_TOKEN", "authorization header is required")
                return
            }

            // Expected format: "Bearer <token>"
            parts := strings.SplitN(authHeader, " ", 2)
            if len(parts) != 2 || parts[0] != "Bearer" {
                respondError(w, http.StatusUnauthorized, "INVALID_TOKEN", "invalid authorization header format")
                return
            }
            tokenString := parts[1]

            // 2. Parse and validate the token
            token, err := jwt.Parse(tokenString, func(token *jwt.Token) (interface{}, error) {
                // Verify signing method to prevent algorithm confusion attacks
                if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
                    return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
                }
                return []byte(jwtSecret), nil
            })

            if err != nil || !token.Valid {
                respondError(w, http.StatusUnauthorized, "INVALID_TOKEN", "token is invalid or expired")
                return
            }

            // 3. Extract claims
            claims, ok := token.Claims.(jwt.MapClaims)
            if !ok {
                respondError(w, http.StatusUnauthorized, "INVALID_TOKEN", "invalid token claims")
                return
            }

            userID, _ := claims["sub"].(string)
            role, _ := claims["role"].(string)

            // 4. Store user info in context for downstream handlers
            ctx := context.WithValue(r.Context(), userIDContextKey, userID)
            ctx = context.WithValue(ctx, userRoleContextKey, role)

            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

// Helpers to extract auth info from context
func UserIDFromContext(ctx context.Context) string {
    if id, ok := ctx.Value(userIDContextKey).(string); ok {
        return id
    }
    return ""
}

func UserRoleFromContext(ctx context.Context) string {
    if role, ok := ctx.Value(userRoleContextKey).(string); ok {
        return role
    }
    return ""
}
```

---

## Rate Limiting Middleware

```go
package api

import (
    "net/http"
    "sync"

    "golang.org/x/time/rate"
)

// Per-IP rate limiter using a map of token-bucket limiters
type ipRateLimiter struct {
    mu       sync.RWMutex
    limiters map[string]*rate.Limiter
    rate     rate.Limit
    burst    int
}

func newIPRateLimiter(r rate.Limit, burst int) *ipRateLimiter {
    return &ipRateLimiter{
        limiters: make(map[string]*rate.Limiter),
        rate:     r,
        burst:    burst,
    }
}

func (l *ipRateLimiter) getLimiter(ip string) *rate.Limiter {
    l.mu.RLock()
    limiter, exists := l.limiters[ip]
    l.mu.RUnlock()

    if exists {
        return limiter
    }

    l.mu.Lock()
    defer l.mu.Unlock()

    // Double-check after acquiring write lock
    if limiter, exists = l.limiters[ip]; exists {
        return limiter
    }

    limiter = rate.NewLimiter(l.rate, l.burst)
    l.limiters[ip] = limiter
    return limiter
}

func RateLimitMiddleware(rps float64, burst int) func(http.Handler) http.Handler {
    limiter := newIPRateLimiter(rate.Limit(rps), burst)

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            ip := r.RemoteAddr

            if !limiter.getLimiter(ip).Allow() {
                w.Header().Set("Retry-After", "1")
                respondError(w, http.StatusTooManyRequests, "RATE_LIMITED", "too many requests")
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}
```

---

## CORS Middleware

```go
package api

import "net/http"

func CORSMiddleware(allowedOrigins []string) func(http.Handler) http.Handler {
    originSet := make(map[string]bool)
    for _, o := range allowedOrigins {
        originSet[o] = true
    }

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            origin := r.Header.Get("Origin")

            if originSet[origin] {
                w.Header().Set("Access-Control-Allow-Origin", origin)
                w.Header().Set("Vary", "Origin")
            }

            w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
            w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Request-ID")
            w.Header().Set("Access-Control-Max-Age", "86400")

            // Handle preflight
            if r.Method == http.MethodOptions {
                w.WriteHeader(http.StatusNoContent)
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}
```

---

## Timeout Middleware

Prevents slow requests from consuming resources indefinitely:

```go
package api

import (
    "context"
    "net/http"
    "time"
)

func TimeoutMiddleware(timeout time.Duration) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            ctx, cancel := context.WithTimeout(r.Context(), timeout)
            defer cancel()

            // Replace the request's context with the timeout-aware one
            r = r.WithContext(ctx)

            // Channel to signal handler completion
            done := make(chan struct{})

            go func() {
                next.ServeHTTP(w, r)
                close(done)
            }()

            select {
            case <-done:
                // Handler finished normally
            case <-ctx.Done():
                // Timeout exceeded
                http.Error(w, `{"error":{"code":"TIMEOUT","message":"request timed out"}}`,
                    http.StatusGatewayTimeout)
            }
        })
    }
}
```

---

## How Middleware Uses Context

Context is the **glue** between middleware layers. Each middleware enriches the context, and downstream code reads from it:

```
RequestID middleware → stores request_id in context
         │
Logger middleware   → reads request_id from context, adds to log fields
         │
Auth middleware     → stores user_id and role in context
         │
Handler            → reads user_id from context to know who's making the request
         │
Service            → reads context for timeout/cancellation
         │
Repository         → passes context to DB queries for timeout propagation
```

---

## Full Production Middleware Stack

```go
func NewRouter(orderSvc *service.OrderService, logger *zap.Logger, cfg *config.Config) http.Handler {
    r := chi.NewRouter()

    // === Global middleware stack (order matters!) ===

    // 1. Request ID — must be first so all subsequent logs include it
    r.Use(RequestIDMiddleware)

    // 2. Real IP — extract real client IP from proxy headers
    r.Use(middleware.RealIP)

    // 3. Structured logger — logs every request with timing
    r.Use(NewStructuredLogger(logger))

    // 4. Recovery — catch panics, log them, return 500
    r.Use(RecoveryMiddleware(logger))

    // 5. CORS — must come before auth for preflight to work
    r.Use(CORSMiddleware(cfg.AllowedOrigins))

    // 6. Global timeout — no request should take longer than 30s
    r.Use(middleware.Timeout(30 * time.Second))

    // === Public routes (no auth) ===
    r.Get("/health", healthCheck)
    r.Get("/ready", readinessCheck)
    r.Handle("/metrics", promhttp.Handler())

    // === Authenticated routes ===
    r.Group(func(r chi.Router) {
        r.Use(AuthMiddleware(cfg.JWTSecret))
        r.Use(RateLimitMiddleware(100, 10)) // 100 req/s per IP, burst of 10

        r.Route("/api/v1", func(r chi.Router) {
            r.Route("/orders", func(r chi.Router) {
                r.Get("/", NewOrderHandler(orderSvc).List)
                r.Post("/", NewOrderHandler(orderSvc).Create)
                r.Get("/{orderID}", NewOrderHandler(orderSvc).Get)
                r.Post("/{orderID}/cancel", NewOrderHandler(orderSvc).Cancel)
            })
        })
    })

    // === Admin routes (auth + admin role required) ===
    r.Group(func(r chi.Router) {
        r.Use(AuthMiddleware(cfg.JWTSecret))
        r.Use(RequireRole("admin"))

        r.Route("/admin", func(r chi.Router) {
            r.Get("/users", adminListUsers)
        })
    })

    return r
}

// RequireRole middleware checks the user's role from context
func RequireRole(requiredRole string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            role := UserRoleFromContext(r.Context())
            if role != requiredRole {
                respondError(w, http.StatusForbidden, "FORBIDDEN", "insufficient permissions")
                return
            }
            next.ServeHTTP(w, r)
        })
    }
}
```

---

→ **Continued in [Part 5 — Context](./part05_context.md)**
