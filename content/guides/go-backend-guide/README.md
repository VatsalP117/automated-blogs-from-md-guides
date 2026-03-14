# The Definitive Go Backend Guide for Frontend Engineers

A comprehensive, production-grade guide for frontend developers who know basic Go syntax and want to confidently work in real company-grade backend codebases.

---

## Guide Index

### Foundations

| Part | Title | Topics |
|---|---|---|
| Part 0 | **Mindset Shift: Frontend → Backend** | Backend thinking, request lifecycle, owning a service, Go in the ecosystem |
| Part 1 | **Go Fundamentals That Matter** | Interfaces, structs, pointers, error handling, defer, custom types, functional options |
| Part 2 | **Project Structure** | Standard layout, `internal/`, mono vs multi-repo, dependency injection, config |
| Part 3 | **Building REST APIs** | net/http, Chi router, handlers, validation, pagination, file uploads |
| Part 4 | **Middleware** | Request ID, logging, recovery, auth, rate limiting, CORS, timeout |
| Part 5 | **Context** | Cancellation, timeouts, value propagation, context in DB/HTTP/goroutines |

### Data & Auth

| Part | Title | Topics |
|---|---|---|
| Part 6 | **Databases in Go** | database/sql, sqlx, sqlc, GORM, transactions, migrations, connection pooling |
| Part 7 | **Concurrency** | Goroutines, channels, WaitGroup, Mutex, errgroup, worker pools, data races |
| Part 8 | **Authentication & Authorization** | JWT, OAuth2, RBAC, API keys, auth middleware |
| Part 9 | **Configuration & Secrets** | 12-factor app, Viper, typed config, secrets management, validation |

### Observability, Messaging & Testing

| Part | Title | Topics |
|---|---|---|
| Part 10 | **Logging, Observability & Tracing** | Zap, Prometheus metrics, OpenTelemetry, health checks |
| Part 11 | **Message Queues & Events** | Kafka producer/consumer, outbox pattern, dead letter queues |
| Part 12 | **gRPC** | Protocol Buffers, server/client setup, interceptors, error handling |
| Part 13 | **Testing** | Unit tests, table-driven tests, mocking, integration tests, httptest |
| Part 14 | **Error Handling at Scale** | Domain errors, wrapping, error mapping, logging at the right layer |

### Production

| Part | Title | Topics |
|---|---|---|
| Part 15 | **Service-to-Service Communication** | HTTP clients, circuit breakers, retries, timeout budgets |
| Part 16 | **Deployment & Production Readiness** | Docker, static binaries, graceful shutdown, Kubernetes, rolling deploys |
| Part 17 | **Code Review & Contribution** | Reading codebases, review feedback, Go idioms, PR descriptions, debugging |
