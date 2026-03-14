# Part 0 — Mindset Shift: Frontend → Backend

> **Series:** The Definitive Go Backend Guide for Frontend Engineers
> **Prev:** —
> **Next:** [Part 1 — Go Fundamentals That Matter in Backend](./part01_go_fundamentals.md)

---

## Table of Contents

- [How Backend Thinking Differs from Frontend Thinking](#how-backend-thinking-differs-from-frontend-thinking)
- [Request Lifecycle from a Backend Perspective](#request-lifecycle-from-a-backend-perspective)
- [What "Owning a Service" Means in a Company](#what-owning-a-service-means-in-a-company)
- [How Go Fits into a Modern Backend Ecosystem](#how-go-fits-into-a-modern-backend-ecosystem)
- [What a Typical Day of Backend Contribution Looks Like](#what-a-typical-day-of-backend-contribution-looks-like)

---

## How Backend Thinking Differs from Frontend Thinking

As a frontend developer, your mental model revolves around **the user and the screen.** You think in terms of components, state, renders, and user interactions. The unit of work is a visual outcome — "when the user clicks this button, the modal opens and the data loads."

Backend thinking is fundamentally different. Here is how:

### 1. You Think in Requests, Not Renders

In frontend, the lifecycle is: **event → state change → re-render.**

In backend, the lifecycle is: **request arrives → validate → process → persist → respond.**

Every single thing your backend does is in service of processing an incoming request (HTTP, gRPC, or a message from a queue) and producing an output (a response, a side effect, or a message published elsewhere). There is no DOM. There is no "current state of the screen." Each request is an isolated unit of work.

### 2. Statefulness vs. Statelessness

In frontend, state is everywhere. You maintain the user's session, form data, navigation history, cached API responses, and UI state — all in memory.

In backend, **your server is stateless.** Each request arrives fresh. You don't remember the last request from the same user unless you explicitly look them up from a database or cache. This is a deliberate design choice — it's what lets you run 50 copies of your server behind a load balancer.

```
Frontend mental model:
  User opens app → state accumulates → user navigates → state evolves

Backend mental model:
  Request arrives → look up everything needed → do work → respond → forget everything
```

### 3. Failure Is Not an Edge Case — It Is the Default

On the frontend, if something fails, you show an error toast or a retry button. The blast radius is one user's screen.

On the backend, failure is your primary concern. At scale:

- The database will be slow sometimes.
- The downstream service you depend on will timeout.
- A Kafka message will be duplicated.
- The deploy will happen while requests are in-flight.
- Two requests will try to update the same row simultaneously.

Your code must handle all of this gracefully. **Writing the happy path is 30% of the work. Writing the error handling, retry logic, and fallback behavior is 70%.**

### 4. You Are Writing Code That Runs Unsupervised

Your frontend runs on the user's device under the user's eyes. If something is weird, they can see it.

Your backend runs on servers in a data center. It processes thousands of requests per second with no one watching. The only way you know something is wrong is through **logs, metrics, and alerts.** This is why observability is not optional — it's a core feature of every backend service.

### 5. Concurrency Is Not Optional

On the frontend, concurrency means "I have a few async API calls happening at once." In practice, JavaScript's single-threaded model with the event loop handles this for you.

On the backend, concurrency means "200 requests just arrived in the same millisecond and they all need to read and write shared resources." You must explicitly think about:

- Which data is shared between goroutines?
- Can two requests step on each other?
- What happens if one request is slow — does it block others?

Go makes concurrency easy to start (just add `go` before a function call) and hard to get right. Part 7 covers this deeply.

### 6. You Serve Multiple Consumers, Not One User

A frontend app serves one user at a time. A backend service serves:

- The web frontend
- The mobile app
- Internal admin tools
- Other backend services
- Background job processors
- Third-party integrations via webhooks

Your API contract matters. Changing a response field can break five different consumers.

---

## Request Lifecycle from a Backend Perspective

When a frontend `fetch()` call fires, here is what happens on the server — step by step. Understanding this complete picture is essential.

```
Client sends HTTP request
        │
        ▼
┌─────────────────────────────┐
│  Load Balancer (e.g. nginx) │  ← Picks one of N server instances
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│  TLS Termination            │  ← Decrypts HTTPS → HTTP
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│  Go HTTP Server (net/http)  │  ← Accepts TCP connection, parses HTTP
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│  Middleware Stack            │  ← RequestID → Logger → Auth → RateLimit → Timeout
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│  Router (e.g. chi)          │  ← Matches URL path to handler function
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│  Handler                    │  ← Parses request body, validates input
│    │                        │
│    ├─ Calls Service Layer   │  ← Business logic lives here
│    │    │                   │
│    │    ├─ Calls Repository │  ← SQL queries, DB transactions
│    │    │    │              │
│    │    │    └─ Database    │  ← PostgreSQL, MySQL, etc.
│    │    │                   │
│    │    ├─ Calls Cache      │  ← Redis for hot data
│    │    │                   │
│    │    └─ Calls External   │  ← Other microservices, third-party APIs
│    │       Service          │
│    │                        │
│    └─ Writes Response       │  ← JSON body + status code + headers
└─────────────────────────────┘
               │
               ▼
        Response sent back to client
```

### Let's trace a concrete example

Imagine the frontend calls `POST /api/v1/orders` to create an order.

**Step 1: Connection.** The Go HTTP server (running in your process) accepts the TCP connection. Go's `net/http` package spawns a new goroutine for every incoming request — this is why Go handles high concurrency natively.

**Step 2: Middleware.** Before your handler even sees the request, it passes through a stack of middleware. Each middleware can inspect the request, modify the context, short-circuit with an error response, or let it pass through:

```go
// Middleware wraps your handler — each one runs in order
// Request → [RequestID] → [Logger] → [Auth] → [Recovery] → [Your Handler]
```

**Step 3: Routing.** The router matches `POST /api/v1/orders` to the `CreateOrder` handler function.

**Step 4: Handler.** Your handler:

1. Reads and decodes the JSON request body.
2. Validates the input (are all required fields present? is the quantity positive?).
3. Calls the service layer with the validated data.

**Step 5: Service layer.** This is where business logic lives:

1. Check if the user has sufficient balance.
2. Check if the product is in stock.
3. Calculate the price with discounts and tax.
4. Open a database transaction.
5. Insert the order row, update the inventory, deduct the balance.
6. Commit the transaction.
7. Publish an "order.created" event to Kafka.

**Step 6: Response.** The handler takes the result from the service, formats it as JSON, and sends it back with a `201 Created` status code.

**Step 7: Logging.** The logging middleware records the request duration, status code, and correlation ID for observability.

All of this happens in **one goroutine** (unless the service layer explicitly spawns additional ones), typically in **under 100 milliseconds.**

---

## What "Owning a Service" Means in a Company

In a company with microservices, teams "own" services. As a backend engineer, you might own the **Order Service**, the **User Service**, or the **Notification Service.** Ownership means:

### You Are Responsible for Everything About It

| Area | What it means |
|---|---|
| **Correctness** | The business logic does what it should |
| **Reliability** | The service stays up and handles failures gracefully |
| **Performance** | Requests complete within SLA (e.g., p99 < 200ms) |
| **Observability** | You can answer "what happened?" from logs and dashboards, not guessing |
| **Data integrity** | The database never ends up in an inconsistent state |
| **Security** | Auth, input validation, and secrets are handled properly |
| **API contract** | Other teams can rely on your API not breaking without notice |
| **On-call** | When it breaks at 2 AM, you (or your team) fix it |

### What "Owning" Looks Like Day-to-Day

- You monitor dashboards showing latency, error rates, and throughput.
- You respond to alerts when error rates spike.
- You plan and execute database migrations.
- You coordinate with consuming teams before changing API contracts.
- You write RFCs (design docs) before building major features.
- You review PRs from teammates touching your service.
- You run load tests before launching features that change traffic patterns.

This is a fundamentally different kind of responsibility than frontend work, where you typically own a feature or a UI area and can see the result immediately.

---

## How Go Fits into a Modern Backend Ecosystem

### Why Companies Choose Go for Backend Services

Go was created at Google specifically for the kind of work that backend services do. Its design choices make more sense when you understand the problems it solves:

| Go Feature | Problem It Solves |
|---|---|
| **Goroutines** (lightweight concurrency) | A server handling 10,000 simultaneous connections without 10,000 OS threads |
| **Fast compilation** | Large codebases at Google took 45+ minutes to compile in C++. Go compiles in seconds. |
| **Static binary** | Deploy one file, no runtime dependencies, no "it works on my machine" |
| **Garbage collection** (low-latency) | Memory safety without manual management, with pauses short enough for servers |
| **Opinionated simplicity** | 50 engineers working on the same codebase write code that looks the same |
| **Standard library** | HTTP server, JSON, crypto, SQL — all built in, no framework wars |

### Where Go Sits in a Typical Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    API Gateway                           │
│              (Kong, Ambassador, Envoy)                   │
└──────────┬──────────────────┬───────────────┬───────────┘
           │                  │               │
     ┌─────▼─────┐    ┌──────▼──────┐  ┌─────▼──────┐
     │ User Svc  │    │ Order Svc   │  │ Payment Svc│  ← Go services
     │   (Go)    │    │   (Go)      │  │   (Go)     │
     └─────┬─────┘    └──────┬──────┘  └─────┬──────┘
           │                  │               │
     ┌─────▼─────┐    ┌──────▼──────┐  ┌─────▼──────┐
     │ PostgreSQL │    │ PostgreSQL  │  │  Stripe    │
     └───────────┘    └──────┬──────┘  └────────────┘
                             │
                      ┌──────▼──────┐
                      │   Kafka     │  ← Async communication
                      └──────┬──────┘
                             │
                      ┌──────▼──────┐
                      │ Notif. Svc  │
                      │   (Go)      │
                      └─────────────┘
```

Go is the **dominant language** for:

- REST and gRPC microservices
- CLI tools (kubectl, terraform, docker — all written in Go)
- Infrastructure software (Kubernetes, Prometheus, Consul — all Go)
- High-throughput data pipeline workers

Go is **not typically used** for:

- Machine learning (Python dominates)
- Heavy data science / analytics (Python, Spark)
- Mobile or frontend (obviously)

### Go vs. What You Might Have Seen

| If you know... | Go comparison |
|---|---|
| Node.js/Express | Go has similar HTTP patterns but with real concurrency (goroutines vs event loop) and static typing |
| Python/Django | Go is much faster, has no ORM by default, and favors explicit over magic |
| Java/Spring | Go is simpler, compiles faster, uses less memory, but lacks the mature enterprise framework ecosystem |

---

## What a Typical Day of Backend Contribution Looks Like

Here is what a realistic day looks like for a backend engineer working on a Go service at a company:

### Morning

1. **Check dashboards.** Open Grafana. Look at error rates, latency p50/p95/p99, and traffic volume for your service. Is anything unusual?

2. **Check alerts.** Any PagerDuty or Slack alerts from overnight? If something fired, investigate before starting new work.

3. **Review PRs.** Read through pull requests from teammates. A backend PR review typically involves:
   - Reading the SQL migrations
   - Checking error handling and edge cases
   - Verifying the API contract
   - Looking for missing tests
   - Thinking about concurrency implications

### Mid-Day

4. **Pick up a ticket.** Your task might be:
   - "Add a `cancel` endpoint to the Order Service"
   - "Fix a bug where duplicate Kafka messages cause double charges"
   - "Add a new field to the User API response"
   - "Implement a rate limiter for the public API"

5. **Write the code.** A typical change touches:
   - **Handler** — new endpoint or modified endpoint
   - **Service** — business logic for the new behavior
   - **Repository** — new SQL query or modified query
   - **Migration** — new column or table in the database
   - **Tests** — unit tests for the service, integration tests for the handler
   - **Proto file** — if changing a gRPC API

6. **Run tests locally.** `go test ./...` — all tests pass. Run `go vet` and `golangci-lint` to catch issues.

### Afternoon

7. **Open a PR.** Write a clear description: what changed, why, how to test it, any migration steps.

8. **Respond to review comments.** Fix suggestions, explain decisions, push updates.

9. **Deploy to staging.** Merge to main, CI runs, Docker image builds, Kubernetes rolls out the new version.

10. **Verify in staging.** Hit the new endpoint, check logs, confirm metrics look normal.

11. **Deploy to production.** After staging looks good, promote to prod. Monitor for 15-30 minutes.

### The Key Difference from Frontend Work

In frontend, you see results instantly — the button changes color, the modal opens, the data appears.

In backend, you see results through:

- HTTP status codes and response bodies
- Log lines in your terminal or log aggregator
- Metrics on a dashboard
- Database rows in a SQL client
- Messages appearing in a Kafka topic

You are flying by instruments, not by looking out the window. Getting comfortable with this is the single biggest mindset shift.

---

## Summary: The Mental Model

| Frontend | Backend |
|---|---|
| Visual output | Data output |
| State lives in memory (browser) | State lives in databases and caches |
| One user at a time | Thousands of concurrent users |
| Failures are visible | Failures are invisible without observability |
| Components and renders | Requests and responses |
| Event-driven (user clicks) | Request-driven (HTTP/gRPC/Kafka) |
| `npm start` → see it in browser | `go run main.go` → hit it with curl |
| Ship fast, fix in real-time | Ship carefully, hard to roll back data changes |

Now that you have the mental model, let's build the skills.

---

→ **Continued in [Part 1 — Go Fundamentals That Matter in Backend](./part01_go_fundamentals.md)**
