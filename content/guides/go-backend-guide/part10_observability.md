# Part 10 — Logging, Observability & Tracing

> **Series:** The Definitive Go Backend Guide for Frontend Engineers
> **Prev:** [Part 9 — Configuration & Secrets](./part09_config_secrets.md)
> **Next:** [Part 11 — Message Queues & Event-Driven Patterns](./part11_message_queues.md)

---

## Table of Contents

- [10A — Structured Logging](#10a--structured-logging)
- [10B — Metrics with Prometheus](#10b--metrics-with-prometheus)
- [10C — Distributed Tracing with OpenTelemetry](#10c--distributed-tracing-with-opentelemetry)
- [10D — Health Checks](#10d--health-checks)

---

## 10A — Structured Logging

### Why `fmt.Println` Is Never Used in Production

`fmt.Println("user created: " + userID)` produces:

```
user created: user-123
```

This is unparseable. Log aggregators (Datadog, Splunk, ELK) can't filter or search by user ID, can't separate it from the message, and can't correlate it with other events.

**Structured logging** outputs JSON with discrete fields:

```json
{"level":"info","ts":1700000000.123,"msg":"user created","user_id":"user-123","request_id":"req-abc","duration_ms":45}
```

Now you can query: "show me all logs for user-123" or "show me all requests slower than 100ms."

### Zap vs Zerolog

| | Zap | Zerolog |
|---|---|---|
| **Creator** | Uber | Community |
| **Performance** | Extremely fast (zero-allocation) | Extremely fast (zero-allocation) |
| **API** | `logger.Info("msg", zap.String("key", "val"))` | `log.Info().Str("key", "val").Msg("msg")` |
| **Adoption** | Very high | High |

Both are excellent. This guide uses Zap because it's slightly more common in production codebases.

### Setting Up Zap

```go
package logging

import (
    "go.uber.org/zap"
    "go.uber.org/zap/zapcore"
)

func NewLogger(level string, production bool) (*zap.Logger, error) {
    var config zap.Config

    if production {
        config = zap.NewProductionConfig()
        config.EncoderConfig.TimeKey = "timestamp"
        config.EncoderConfig.EncodeTime = zapcore.ISO8601TimeEncoder
    } else {
        config = zap.NewDevelopmentConfig()
        config.EncoderConfig.EncodeLevel = zapcore.CapitalColorLevelEncoder // colored output in terminal
    }

    switch level {
    case "debug":
        config.Level.SetLevel(zap.DebugLevel)
    case "warn":
        config.Level.SetLevel(zap.WarnLevel)
    case "error":
        config.Level.SetLevel(zap.ErrorLevel)
    default:
        config.Level.SetLevel(zap.InfoLevel)
    }

    return config.Build()
}
```

### Log Levels and When to Use Each

| Level | When to Use | Example |
|---|---|---|
| **Debug** | Detailed info for diagnosing issues. Never in production. | `Loaded 42 items from cache` |
| **Info** | Normal operations worth recording. | `Order created`, `Server started` |
| **Warn** | Something unexpected that the system handled. | `Retrying failed request`, `Cache miss` |
| **Error** | Something failed that needs attention. | `Database query failed`, `External API returned 500` |
| **Fatal** | Unrecoverable error — logs then calls `os.Exit(1)`. | `Config validation failed`, `Cannot connect to DB` |

### Logging in the Service Layer

```go
func (s *OrderService) CreateOrder(ctx context.Context, userID string, req CreateOrderRequest) (*Order, error) {
    requestID := middleware.RequestIDFromContext(ctx)

    s.logger.Info("creating order",
        zap.String("request_id", requestID),
        zap.String("user_id", userID),
        zap.Int("item_count", len(req.Items)),
    )

    order, err := s.repo.Create(ctx, order)
    if err != nil {
        s.logger.Error("failed to create order",
            zap.String("request_id", requestID),
            zap.String("user_id", userID),
            zap.Error(err),
        )
        return nil, fmt.Errorf("create order: %w", err)
    }

    s.logger.Info("order created successfully",
        zap.String("request_id", requestID),
        zap.String("order_id", order.ID),
        zap.Int64("total_amount", order.TotalAmount),
    )

    return order, nil
}
```

### Using a Request-Scoped Logger

Instead of manually adding `request_id` to every log call, create a logger that already has it:

```go
func NewStructuredLoggerMiddleware(logger *zap.Logger) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            requestID := RequestIDFromContext(r.Context())

            // Create a logger with pre-set fields
            reqLogger := logger.With(
                zap.String("request_id", requestID),
                zap.String("method", r.Method),
                zap.String("path", r.URL.Path),
            )

            // Store it in context so all downstream code uses it
            ctx := context.WithValue(r.Context(), loggerKey, reqLogger)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

func LoggerFromContext(ctx context.Context) *zap.Logger {
    if logger, ok := ctx.Value(loggerKey).(*zap.Logger); ok {
        return logger
    }
    return zap.NewNop()
}
```

---

## 10B — Metrics with Prometheus

### What Metrics Are

Metrics are numerical time-series data that tell you how your service is performing:

- **Latency:** How long do requests take? (p50, p95, p99)
- **Traffic:** How many requests per second?
- **Errors:** What percentage of requests fail?
- **Saturation:** How close are you to capacity? (CPU, memory, connection pool)

These are the **Four Golden Signals** (from Google's SRE book).

### Prometheus Integration

```go
package metrics

import (
    "net/http"
    "strconv"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
    httpRequestsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "http_requests_total",
            Help: "Total number of HTTP requests",
        },
        []string{"method", "path", "status"},
    )

    httpRequestDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "http_request_duration_seconds",
            Help:    "HTTP request duration in seconds",
            Buckets: []float64{.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10},
        },
        []string{"method", "path"},
    )

    dbQueryDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "db_query_duration_seconds",
            Help:    "Database query duration in seconds",
            Buckets: []float64{.001, .005, .01, .025, .05, .1, .25, .5, 1},
        },
        []string{"query_name"},
    )

    activeConnections = promauto.NewGauge(
        prometheus.GaugeOpts{
            Name: "db_active_connections",
            Help: "Number of active database connections",
        },
    )
)

// MetricsMiddleware records request count and duration
func MetricsMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        wrapped := newResponseWriter(w)

        next.ServeHTTP(wrapped, r)

        duration := time.Since(start).Seconds()
        status := strconv.Itoa(wrapped.statusCode)

        httpRequestsTotal.WithLabelValues(r.Method, r.URL.Path, status).Inc()
        httpRequestDuration.WithLabelValues(r.Method, r.URL.Path).Observe(duration)
    })
}

// Handler exposes metrics for Prometheus to scrape
func Handler() http.Handler {
    return promhttp.Handler()
}

// Instrument a DB query
func ObserveDBQuery(queryName string, start time.Time) {
    dbQueryDuration.WithLabelValues(queryName).Observe(time.Since(start).Seconds())
}
```

Usage in repository:

```go
func (r *repo) GetByID(ctx context.Context, id string) (*User, error) {
    defer metrics.ObserveDBQuery("get_user_by_id", time.Now())

    var user User
    err := r.db.GetContext(ctx, &user, `SELECT * FROM users WHERE id = $1`, id)
    return &user, err
}
```

### Exposing Metrics Endpoint

```go
// In router setup:
r.Handle("/metrics", metrics.Handler()) // Prometheus scrapes this endpoint
```

---

## 10C — Distributed Tracing with OpenTelemetry

### Why Tracing Matters

In a microservice architecture, a single user request might touch 5 services. When something is slow, which service is the bottleneck?

A **trace** follows a request across all services. Each service adds a **span** (a timed operation) to the trace. The result is a waterfall view showing exactly where time is spent.

```
Trace: create-order (total: 250ms)
├── order-service: handler          [0ms  - 250ms]
│   ├── order-service: validate     [5ms  -  10ms]
│   ├── user-service: get-user      [10ms -  60ms]  ← gRPC call to another service
│   ├── inventory-service: check    [60ms - 120ms]  ← gRPC call
│   ├── order-service: db-insert    [120ms - 180ms] ← SQL query
│   └── kafka: publish-event        [180ms - 200ms]
```

### OpenTelemetry Setup

```go
package tracing

import (
    "context"
    "fmt"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.21.0"
)

func InitTracer(ctx context.Context, serviceName, otlpEndpoint string) (func(context.Context) error, error) {
    exporter, err := otlptracegrpc.New(ctx,
        otlptracegrpc.WithEndpoint(otlpEndpoint),
        otlptracegrpc.WithInsecure(),
    )
    if err != nil {
        return nil, fmt.Errorf("create exporter: %w", err)
    }

    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName(serviceName),
            semconv.ServiceVersion("1.0.0"),
        ),
    )
    if err != nil {
        return nil, fmt.Errorf("create resource: %w", err)
    }

    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter),
        sdktrace.WithResource(res),
        sdktrace.WithSampler(sdktrace.AlwaysSample()), // sample everything in dev
    )

    otel.SetTracerProvider(tp)
    otel.SetTextMapPropagator(propagation.TraceContext{})

    return tp.Shutdown, nil
}
```

### Adding Spans to Your Code

```go
import "go.opentelemetry.io/otel"

var tracer = otel.Tracer("order-service")

func (s *OrderService) CreateOrder(ctx context.Context, userID string, req CreateOrderRequest) (*Order, error) {
    ctx, span := tracer.Start(ctx, "OrderService.CreateOrder")
    defer span.End()

    span.SetAttributes(
        attribute.String("user_id", userID),
        attribute.Int("item_count", len(req.Items)),
    )

    // Each sub-call creates a child span
    user, err := s.getUser(ctx, userID)
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        return nil, err
    }

    // ... more operations, each creating spans
    return order, nil
}

func (s *OrderService) getUser(ctx context.Context, userID string) (*User, error) {
    ctx, span := tracer.Start(ctx, "OrderService.getUser")
    defer span.End()

    return s.userRepo.GetByID(ctx, userID)
}
```

---

## 10D — Health Checks

### Why Kubernetes Needs Them

Kubernetes uses two types of probes to manage your service:

- **Liveness probe** (`/health`): Is the process alive? If not, restart it.
- **Readiness probe** (`/ready`): Can it handle traffic? If not, remove it from the load balancer.

```go
type HealthChecker struct {
    db    *sqlx.DB
    redis *redis.Client
}

func (h *HealthChecker) Health(w http.ResponseWriter, r *http.Request) {
    // Liveness: just check that the process is responsive
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusOK)
    json.NewEncoder(w).Encode(map[string]string{"status": "alive"})
}

func (h *HealthChecker) Ready(w http.ResponseWriter, r *http.Request) {
    ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
    defer cancel()

    checks := map[string]string{}
    healthy := true

    // Check database
    if err := h.db.PingContext(ctx); err != nil {
        checks["database"] = "unhealthy: " + err.Error()
        healthy = false
    } else {
        checks["database"] = "healthy"
    }

    // Check Redis
    if h.redis != nil {
        if err := h.redis.Ping(ctx).Err(); err != nil {
            checks["redis"] = "unhealthy: " + err.Error()
            healthy = false
        } else {
            checks["redis"] = "healthy"
        }
    }

    status := http.StatusOK
    if !healthy {
        status = http.StatusServiceUnavailable
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    json.NewEncoder(w).Encode(map[string]interface{}{
        "status": map[bool]string{true: "ready", false: "not_ready"}[healthy],
        "checks": checks,
    })
}
```

### Kubernetes Probe Configuration

```yaml
spec:
  containers:
    - name: order-service
      livenessProbe:
        httpGet:
          path: /health
          port: 8080
        initialDelaySeconds: 5
        periodSeconds: 10
      readinessProbe:
        httpGet:
          path: /ready
          port: 8080
        initialDelaySeconds: 5
        periodSeconds: 5
```

---

→ **Continued in [Part 11 — Message Queues & Event-Driven Patterns](./part11_message_queues.md)**
