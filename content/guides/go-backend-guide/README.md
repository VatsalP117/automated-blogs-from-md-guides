# The Definitive Go Backend Guide for Frontend Engineers

A comprehensive, production-grade guide for frontend developers who know basic Go syntax and want to confidently work in real company-grade backend codebases.

---

## Guide Index

### Foundations

| Part | Title | Topics |
|---|---|---|
| [Part 0](./part00_mindset_shift.md) | **Mindset Shift: Frontend → Backend** | Backend thinking, request lifecycle, owning a service, Go in the ecosystem |
| [Part 1](./part01_go_fundamentals.md) | **Go Fundamentals That Matter** | Interfaces, structs, pointers, error handling, defer, custom types, functional options |
| [Part 2](./part02_project_structure.md) | **Project Structure** | Standard layout, `internal/`, mono vs multi-repo, dependency injection, config |
| [Part 3](./part03_rest_apis.md) | **Building REST APIs** | net/http, Chi router, handlers, validation, pagination, file uploads |
| [Part 4](./part04_middleware.md) | **Middleware** | Request ID, logging, recovery, auth, rate limiting, CORS, timeout |
| [Part 5](./part05_context.md) | **Context** | Cancellation, timeouts, value propagation, context in DB/HTTP/goroutines |

### Data & Auth

| Part | Title | Topics |
|---|---|---|
| [Part 6](./part06_databases.md) | **Databases in Go** | database/sql, sqlx, sqlc, GORM, transactions, migrations, connection pooling |
| [Part 7](./part07_concurrency.md) | **Concurrency** | Goroutines, channels, WaitGroup, Mutex, errgroup, worker pools, data races |
| [Part 8](./part08_auth.md) | **Authentication & Authorization** | JWT, OAuth2, RBAC, API keys, auth middleware |
| [Part 9](./part09_config_secrets.md) | **Configuration & Secrets** | 12-factor app, Viper, typed config, secrets management, validation |

### Observability, Messaging & Testing

| Part | Title | Topics |
|---|---|---|
| [Part 10](./part10_observability.md) | **Logging, Observability & Tracing** | Zap, Prometheus metrics, OpenTelemetry, health checks |
| [Part 11](./part11_message_queues.md) | **Message Queues & Events** | Kafka producer/consumer, outbox pattern, dead letter queues |
| [Part 12](./part12_grpc.md) | **gRPC** | Protocol Buffers, server/client setup, interceptors, error handling |
| [Part 13](./part13_testing.md) | **Testing** | Unit tests, table-driven tests, mocking, integration tests, httptest |
| [Part 14](./part14_error_handling.md) | **Error Handling at Scale** | Domain errors, wrapping, error mapping, logging at the right layer |

### Production

| Part | Title | Topics |
|---|---|---|
| [Part 15](./part15_service_communication.md) | **Service-to-Service Communication** | HTTP clients, circuit breakers, retries, timeout budgets |
| [Part 16](./part16_deployment.md) | **Deployment & Production Readiness** | Docker, static binaries, graceful shutdown, Kubernetes, rolling deploys |
| [Part 17](./part17_code_review.md) | **Code Review & Contribution** | Reading codebases, review feedback, Go idioms, PR descriptions, debugging |
