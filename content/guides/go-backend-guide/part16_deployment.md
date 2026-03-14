# Part 16 — Deployment & Production Readiness

> **Series:** The Definitive Go Backend Guide for Frontend Engineers
> **Prev:** [Part 15 — Service-to-Service Communication](./part15_service_communication.md)
> **Next:** [Part 17 — Code Review & Contribution Patterns](./part17_code_review.md)

---

## Table of Contents

- [Production Dockerfile (Multi-Stage Build)](#production-dockerfile)
- [Building Lean, Static Go Binaries](#building-lean-static-go-binaries)
- [Graceful Shutdown](#graceful-shutdown)
- [Signal Handling](#signal-handling)
- [Kubernetes Basics for a Go Service](#kubernetes-basics-for-a-go-service)
- [Liveness vs Readiness Probes](#liveness-vs-readiness-probes)
- [Rolling Deployments and Zero-Downtime Releases](#rolling-deployments)
- [Environment Parity](#environment-parity)

---

## Production Dockerfile

A multi-stage Dockerfile keeps your production image tiny (often < 20MB):

```dockerfile
# Stage 1: Build
FROM golang:1.22-alpine AS builder

# Install build dependencies
RUN apk add --no-cache git ca-certificates

WORKDIR /app

# Copy go.mod and go.sum first — Docker layer caching means these layers
# are reused if dependencies haven't changed (much faster rebuilds)
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build a statically linked binary
# CGO_ENABLED=0: no C dependencies — the binary runs on any Linux
# -ldflags="-s -w": strip debug symbols — smaller binary
# -o /app/server: output path
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -ldflags="-s -w" -o /app/server ./cmd/server

# Stage 2: Production image
FROM alpine:3.19

# Add CA certificates (needed for HTTPS calls to external services)
RUN apk --no-cache add ca-certificates tzdata

# Create non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy ONLY the binary from the builder stage
COPY --from=builder /app/server .

# Copy migrations if needed
COPY --from=builder /app/migrations ./migrations

# Run as non-root
USER appuser

# Expose the application port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://localhost:8080/health || exit 1

# Run the binary
ENTRYPOINT ["/app/server"]
```

**Result:** Your Go binary is ~15MB. The entire Docker image is ~25MB (compare to a Node.js image which is typically 200MB+).

---

## Building Lean, Static Go Binaries

```bash
# Standard build
go build -o server ./cmd/server
# Result: ~15MB binary, dynamically linked to system libc

# Production build — static, stripped
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -ldflags="-s -w" -o server ./cmd/server
# Result: ~10MB binary, runs on ANY Linux (including scratch/distroless Docker images)

# Inject version info at build time
go build -ldflags="-s -w \
  -X main.version=$(git describe --tags) \
  -X main.commit=$(git rev-parse HEAD) \
  -X main.buildDate=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  -o server ./cmd/server
```

```go
// Access build-time variables in code
var (
    version   = "dev"
    commit    = "unknown"
    buildDate = "unknown"
)

func main() {
    logger.Info("starting service",
        zap.String("version", version),
        zap.String("commit", commit),
        zap.String("build_date", buildDate),
    )
}
```

---

## Graceful Shutdown

When Kubernetes sends `SIGTERM` to your pod (during a deploy or scale-down), you need to:

1. Stop accepting new connections.
2. Finish processing in-flight requests.
3. Close database connections and flush buffers.
4. Exit cleanly.

```go
package main

import (
    "context"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "go.uber.org/zap"
)

func main() {
    logger, _ := zap.NewProduction()
    defer logger.Sync()

    // ... setup config, db, services, router ...

    srv := &http.Server{
        Addr:         ":8080",
        Handler:      router,
        ReadTimeout:  15 * time.Second,
        WriteTimeout: 30 * time.Second,
        IdleTimeout:  60 * time.Second,
    }

    // Channel to listen for errors from the server
    serverErrors := make(chan error, 1)

    // Start server in background
    go func() {
        logger.Info("server starting", zap.String("addr", srv.Addr))
        serverErrors <- srv.ListenAndServe()
    }()

    // Channel to listen for OS signals
    shutdown := make(chan os.Signal, 1)
    signal.Notify(shutdown, syscall.SIGINT, syscall.SIGTERM)

    // Block until we receive a signal or server error
    select {
    case err := <-serverErrors:
        if err != nil && err != http.ErrServerClosed {
            logger.Fatal("server error", zap.Error(err))
        }

    case sig := <-shutdown:
        logger.Info("shutdown signal received", zap.String("signal", sig.String()))

        // Give in-flight requests time to complete
        ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
        defer cancel()

        // Shutdown gracefully — stops accepting new connections,
        // waits for in-flight requests to finish
        if err := srv.Shutdown(ctx); err != nil {
            logger.Error("graceful shutdown failed, forcing", zap.Error(err))
            srv.Close() // force close
        }

        // Close other resources
        logger.Info("closing database connection")
        db.Close()

        logger.Info("flushing Kafka producer")
        kafkaProducer.Close()

        logger.Info("shutdown complete")
    }
}
```

### What Happens During Graceful Shutdown

```
1. Kubernetes sends SIGTERM
2. Your service stops accepting NEW connections
3. Kubernetes removes your pod from the load balancer (takes a few seconds)
4. In-flight requests continue to be processed
5. After all requests complete (or after 30s timeout), the server exits
6. Database connections, Kafka producers, etc. are closed
7. Process exits with code 0
```

**Important:** Kubernetes waits `terminationGracePeriodSeconds` (default: 30s) before sending `SIGKILL`. Make sure your shutdown timeout is shorter than this.

---

## Signal Handling

| Signal | When Sent | What to Do |
|---|---|---|
| `SIGTERM` | Kubernetes pod termination, `docker stop` | Graceful shutdown |
| `SIGINT` | Ctrl+C in terminal | Graceful shutdown |
| `SIGKILL` | Kubernetes after grace period | Can't catch — process dies immediately |

---

## Kubernetes Basics for a Go Service

### Deployment

```yaml
# deployments/kubernetes/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
  labels:
    app: order-service
spec:
  replicas: 3                    # run 3 instances for high availability
  strategy:
    type: RollingUpdate          # zero-downtime deployments
    rollingUpdate:
      maxUnavailable: 1          # at most 1 pod down during update
      maxSurge: 1                # at most 1 extra pod during update
  selector:
    matchLabels:
      app: order-service
  template:
    metadata:
      labels:
        app: order-service
    spec:
      terminationGracePeriodSeconds: 60  # give 60s for graceful shutdown
      containers:
        - name: order-service
          image: yourregistry/order-service:v1.2.3
          ports:
            - containerPort: 8080
          envFrom:
            - configMapRef:
                name: order-service-config
            - secretRef:
                name: order-service-secrets
          resources:
            requests:
              cpu: 100m           # minimum CPU (0.1 cores)
              memory: 128Mi       # minimum memory
            limits:
              cpu: 500m           # maximum CPU (0.5 cores)
              memory: 512Mi       # maximum memory — OOMKilled if exceeded
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /ready
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 5
            failureThreshold: 2
```

### Service (Internal Load Balancer)

```yaml
apiVersion: v1
kind: Service
metadata:
  name: order-service
spec:
  selector:
    app: order-service
  ports:
    - port: 8080
      targetPort: 8080
  type: ClusterIP    # internal only — other services access via order-service:8080
```

### ConfigMap (Non-Secret Config)

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: order-service-config
data:
  PORT: "8080"
  ENVIRONMENT: "production"
  LOG_LEVEL: "info"
  DB_MAX_OPEN_CONNS: "25"
  KAFKA_CONSUMER_GROUP: "order-service"
```

---

## Liveness vs Readiness Probes

| Probe | Question | Failure Action |
|---|---|---|
| **Liveness** | "Is the process alive and not stuck?" | **Restart** the pod |
| **Readiness** | "Can it handle traffic right now?" | **Remove** from load balancer (don't restart) |

**Liveness:** should be lightweight (just return 200). A deadlocked process that can't respond gets restarted.

**Readiness:** should check dependencies (DB, Redis). A pod that can't reach the database is temporarily removed from traffic until it recovers.

---

## Rolling Deployments

When you push a new version:

```
1. Kubernetes creates 1 new pod with the new image
2. New pod passes readiness check → added to load balancer
3. Kubernetes terminates 1 old pod (SIGTERM → graceful shutdown)
4. Repeat until all pods are running the new version
```

**Zero downtime** because there are always healthy pods serving traffic during the transition.

---

## Environment Parity

Keep dev, staging, and production as similar as possible:

```
# docker-compose.yml for local development
services:
  order-service:
    build: .
    ports:
      - "8080:8080"
    environment:
      - DATABASE_URL=postgres://user:pass@postgres:5432/orderdb?sslmode=disable
      - KAFKA_BROKERS=kafka:9092
      - REDIS_URL=redis://redis:6379
      - JWT_ACCESS_SECRET=dev-secret
      - ENVIRONMENT=development
    depends_on:
      - postgres
      - kafka
      - redis

  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: user
      POSTGRES_PASSWORD: pass
      POSTGRES_DB: orderdb
    ports:
      - "5432:5432"

  kafka:
    image: confluentinc/cp-kafka:7.5.0
    ports:
      - "9092:9092"
    environment:
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_LISTENERS: PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:29093
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:29093
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
```

```bash
# Start everything locally
docker compose up -d

# Run migrations
make migrate-up

# Start the service
make run
```

**Goal:** `docker compose up` gives you an environment identical to production (same DB, same Kafka, same Redis). No more "works on my machine."

---

→ **Continued in [Part 17 — Code Review & Contribution Patterns](./part17_code_review.md)**
