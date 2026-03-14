# Part 15 — Service-to-Service Communication

> **Series:** The Definitive Go Backend Guide for Frontend Engineers
> **Prev:** [Part 14 — Error Handling at Scale](./part14_error_handling.md)
> **Next:** [Part 16 — Deployment & Production Readiness](./part16_deployment.md)

---

## Table of Contents

- [Why http.DefaultClient Is Dangerous](#why-httpdefaultclient-is-dangerous)
- [Building a Proper HTTP Client](#building-a-proper-http-client)
- [Circuit Breaker Pattern](#circuit-breaker-pattern)
- [Retry with Exponential Backoff](#retry-with-exponential-backoff)
- [Timeout Budgets](#timeout-budgets)
- [Service Discovery Basics](#service-discovery-basics)

---

## Why http.DefaultClient Is Dangerous

```go
// NEVER do this in production
resp, err := http.Get("https://api.example.com/data")
```

`http.DefaultClient` has **no timeout.** If the remote service hangs, your goroutine hangs forever, holding a connection and resources. Do this enough times and your service runs out of memory or file descriptors and crashes.

```go
// The default client is literally:
var DefaultClient = &http.Client{} // no timeout, no connection pool config
```

---

## Building a Proper HTTP Client

```go
package httpclient

import (
    "net"
    "net/http"
    "time"
)

func NewHTTPClient() *http.Client {
    transport := &http.Transport{
        // Connection pooling
        MaxIdleConns:        100,              // max idle connections across all hosts
        MaxIdleConnsPerHost: 10,               // max idle connections per host
        MaxConnsPerHost:     100,              // max total connections per host
        IdleConnTimeout:     90 * time.Second, // close idle connections after this

        // Timeouts for establishing connections
        DialContext: (&net.Dialer{
            Timeout:   5 * time.Second,  // TCP connection timeout
            KeepAlive: 30 * time.Second, // TCP keep-alive interval
        }).DialContext,

        TLSHandshakeTimeout:   5 * time.Second,
        ResponseHeaderTimeout: 10 * time.Second, // time to wait for response headers
    }

    return &http.Client{
        Timeout:   30 * time.Second, // overall request timeout (includes body read)
        Transport: transport,
    }
}
```

### A Typed Service Client

```go
package client

import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "net/http"
)

type UserServiceClient struct {
    baseURL    string
    httpClient *http.Client
}

func NewUserServiceClient(baseURL string, client *http.Client) *UserServiceClient {
    return &UserServiceClient{baseURL: baseURL, httpClient: client}
}

func (c *UserServiceClient) GetUser(ctx context.Context, userID string) (*User, error) {
    url := fmt.Sprintf("%s/api/v1/users/%s", c.baseURL, userID)

    req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
    if err != nil {
        return nil, fmt.Errorf("create request: %w", err)
    }
    req.Header.Set("Accept", "application/json")

    resp, err := c.httpClient.Do(req)
    if err != nil {
        return nil, fmt.Errorf("get user %s: %w", userID, err)
    }
    defer resp.Body.Close()

    if resp.StatusCode == http.StatusNotFound {
        return nil, ErrUserNotFound
    }
    if resp.StatusCode != http.StatusOK {
        return nil, fmt.Errorf("get user: unexpected status %d", resp.StatusCode)
    }

    var apiResp struct {
        Data User `json:"data"`
    }
    if err := json.NewDecoder(resp.Body).Decode(&apiResp); err != nil {
        return nil, fmt.Errorf("decode response: %w", err)
    }

    return &apiResp.Data, nil
}
```

---

## Circuit Breaker Pattern

### Why It Exists

If a downstream service is down, every request to it will fail and timeout. Without protection, your service spends all its time waiting on a dead service.

A circuit breaker **stops sending requests** to a failing service after a threshold, giving it time to recover:

```
State Machine:
  CLOSED  → (failures exceed threshold) → OPEN
  OPEN    → (after wait period)         → HALF-OPEN
  HALF-OPEN → (probe succeeds)         → CLOSED
  HALF-OPEN → (probe fails)            → OPEN
```

- **Closed:** Requests flow normally. Failures are counted.
- **Open:** All requests fail immediately (fast failure, no waiting).
- **Half-Open:** One probe request is sent. If it succeeds, close the circuit. If it fails, reopen.

### Using gobreaker

```go
package client

import (
    "fmt"
    "net/http"
    "time"

    "github.com/sony/gobreaker/v2"
)

type ResilientClient struct {
    httpClient *http.Client
    breaker    *gobreaker.CircuitBreaker[*http.Response]
}

func NewResilientClient(name string, httpClient *http.Client) *ResilientClient {
    cb := gobreaker.NewCircuitBreaker[*http.Response](gobreaker.Settings{
        Name:        name,
        MaxRequests: 3,                // max requests in half-open state
        Interval:    10 * time.Second, // reset failure count after this (in closed state)
        Timeout:     30 * time.Second, // how long to stay open before going half-open
        ReadyToTrip: func(counts gobreaker.Counts) bool {
            // Open the circuit if failure ratio > 50% and at least 5 requests
            return counts.Requests >= 5 && counts.ConsecutiveFailures >= 3
        },
        OnStateChange: func(name string, from, to gobreaker.State) {
            fmt.Printf("circuit breaker %s: %s → %s\n", name, from, to)
        },
    })

    return &ResilientClient{httpClient: httpClient, breaker: cb}
}

func (c *ResilientClient) Do(req *http.Request) (*http.Response, error) {
    resp, err := c.breaker.Execute(func() (*http.Response, error) {
        resp, err := c.httpClient.Do(req)
        if err != nil {
            return nil, err
        }
        // Treat 5xx as failures for circuit breaker purposes
        if resp.StatusCode >= 500 {
            return resp, fmt.Errorf("server error: %d", resp.StatusCode)
        }
        return resp, nil
    })
    return resp, err
}
```

---

## Retry with Exponential Backoff

Not every failure is permanent. Network blips, brief overloads, and deployment rollouts cause transient failures. Retries handle these:

```go
package retry

import (
    "context"
    "math"
    "math/rand"
    "time"
)

type Config struct {
    MaxRetries  int
    BaseDelay   time.Duration
    MaxDelay    time.Duration
    Retryable   func(error) bool // which errors should be retried?
}

func Do(ctx context.Context, cfg Config, fn func() error) error {
    var lastErr error

    for attempt := 0; attempt <= cfg.MaxRetries; attempt++ {
        lastErr = fn()
        if lastErr == nil {
            return nil // success
        }

        // Check if error is retryable
        if cfg.Retryable != nil && !cfg.Retryable(lastErr) {
            return lastErr // non-retryable error, stop immediately
        }

        if attempt == cfg.MaxRetries {
            break // last attempt, don't sleep
        }

        // Exponential backoff with jitter
        delay := time.Duration(float64(cfg.BaseDelay) * math.Pow(2, float64(attempt)))
        if delay > cfg.MaxDelay {
            delay = cfg.MaxDelay
        }
        // Add jitter (±25%) to prevent thundering herd
        jitter := time.Duration(rand.Float64()*0.5*float64(delay)) - delay/4
        delay += jitter

        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-time.After(delay):
            // continue to next attempt
        }
    }

    return fmt.Errorf("after %d retries: %w", cfg.MaxRetries, lastErr)
}
```

Usage:

```go
err := retry.Do(ctx, retry.Config{
    MaxRetries: 3,
    BaseDelay:  100 * time.Millisecond,
    MaxDelay:   2 * time.Second,
    Retryable: func(err error) bool {
        // Only retry on transient errors
        return isTransientError(err)
    },
}, func() error {
    return paymentClient.Charge(ctx, chargeReq)
})
```

---

## Timeout Budgets

In a call chain, each hop consumes part of the total timeout:

```
Client (30s timeout)
  → API Gateway (25s)
    → Order Service (20s)
      → Payment Service (10s)
        → Stripe API (5s)
```

**Rule:** Each layer should set a timeout **shorter** than its parent. The leaf service gets the tightest timeout.

```go
func (s *OrderService) CreateOrder(ctx context.Context, ...) (*Order, error) {
    // Parent gave us 20s. Allocate:
    // - 2s for user lookup
    // - 10s for payment
    // - 5s for DB write
    // - 3s buffer

    userCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
    defer cancel()
    user, err := s.userClient.Get(userCtx, userID)
    if err != nil {
        return nil, fmt.Errorf("get user: %w", err)
    }

    payCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
    defer cancel()
    charge, err := s.paymentClient.Charge(payCtx, chargeReq)
    if err != nil {
        return nil, fmt.Errorf("charge payment: %w", err)
    }

    dbCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()
    order, err := s.repo.Create(dbCtx, order)
    if err != nil {
        return nil, fmt.Errorf("insert order: %w", err)
    }

    return order, nil
}
```

---

## Service Discovery Basics

### How Services Find Each Other

In a microservice architecture, services need to know the addresses of other services. There are several approaches:

**1. DNS-based (most common in Kubernetes):**

```go
// In Kubernetes, each service gets a DNS name
client := NewUserServiceClient("http://user-service.default.svc.cluster.local:8080", httpClient)
```

Kubernetes DNS resolves `user-service` to the current set of pods running that service.

**2. Environment variables:**

```go
// Set by deployment config
userServiceURL := os.Getenv("USER_SERVICE_URL") // "http://user-service:8080"
client := NewUserServiceClient(userServiceURL, httpClient)
```

**3. Service registry (Consul, etcd):**

More complex. Services register themselves on startup and deregister on shutdown. Clients query the registry to find instances.

**What companies actually do:** Most use Kubernetes DNS for internal services. It's simple, requires no extra infrastructure, and works well for most cases.

---

→ **Continued in [Part 16 — Deployment & Production Readiness](./part16_deployment.md)**
