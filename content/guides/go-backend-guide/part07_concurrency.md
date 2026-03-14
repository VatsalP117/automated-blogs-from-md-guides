# Part 7 — Concurrency in Go (For Backend Engineers)

> **Series:** The Definitive Go Backend Guide for Frontend Engineers
> **Prev:** [Part 6 — Databases](./part06_databases.md)
> **Next:** [Part 8 — Authentication & Authorization](./part08_auth.md)

---

## Table of Contents

- [Goroutines — What They Actually Are](#goroutines--what-they-actually-are)
- [When to Use Goroutines (And When Not To)](#when-to-use-goroutines-and-when-not-to)
- [Channels — Buffered, Unbuffered, Directional](#channels)
- [sync.WaitGroup — Coordinating Completion](#syncwaitgroup)
- [sync.Mutex and sync.RWMutex — Protecting Shared State](#syncmutex-and-syncrwmutex)
- [sync.Once — Lazy Initialization](#synconce)
- [errgroup — The Production Pattern](#errgroup--the-production-pattern)
- [Worker Pool Pattern](#worker-pool-pattern)
- [The select Statement](#the-select-statement)
- [Data Races — Detection and Prevention](#data-races)
- [Real Backend Use Cases](#real-backend-use-cases)
- [Full Example: Concurrent Job Processor](#full-example-concurrent-job-processor)

---

This is the most important section in the entire guide. Concurrency is what makes Go special for backend work, and it's where most bugs come from.

---

## Goroutines — What They Actually Are

### The Frontend Analogy

In JavaScript, you have one thread and an event loop. `async/await` lets you do I/O without blocking, but only one piece of JavaScript code executes at any given instant.

In Go, goroutines are **independently executing functions** that run concurrently — and on multi-core machines, **truly in parallel.** Multiple goroutines execute real code at the same instant on different CPU cores.

### Under the Hood

A goroutine is NOT an OS thread. It's a lightweight unit of execution managed by Go's runtime scheduler:

| | OS Thread | Goroutine |
|---|---|---|
| Memory | ~1-8 MB stack | ~2-8 KB stack (grows as needed) |
| Creation cost | Expensive (kernel call) | Cheap (runtime allocation) |
| Limit | Thousands | Millions |
| Scheduling | OS kernel | Go runtime (M:N scheduler) |

Go's scheduler multiplexes thousands of goroutines onto a small number of OS threads. When a goroutine blocks on I/O (network, disk, DB), the scheduler runs another goroutine on that thread. This is why Go can handle 100,000+ concurrent connections efficiently.

### Starting a Goroutine

```go
// Just add "go" before a function call
go processOrder(ctx, order)

// Anonymous function
go func() {
    result, err := fetchData(ctx, url)
    // ...
}()
```

**Critical:** When you launch a goroutine, the calling function does NOT wait for it. It continues immediately. If `main()` returns, all goroutines are killed — even if they haven't finished.

---

## When to Use Goroutines (And When Not To)

### When TO use goroutines in backend code:

1. **Parallel I/O** — fetching data from multiple sources simultaneously:

```go
// Fetch user profile, orders, and notifications in parallel
// instead of sequentially (3x faster)
g, ctx := errgroup.WithContext(ctx)

var user *User
var orders []*Order
var notifs []*Notification

g.Go(func() error {
    var err error
    user, err = userSvc.Get(ctx, userID)
    return err
})
g.Go(func() error {
    var err error
    orders, err = orderSvc.List(ctx, userID)
    return err
})
g.Go(func() error {
    var err error
    notifs, err = notifSvc.List(ctx, userID)
    return err
})

if err := g.Wait(); err != nil {
    return nil, err
}
```

2. **Background work** — fire-and-forget tasks that shouldn't delay the response:

```go
// Send email asynchronously — don't make the user wait for email delivery
go func() {
    bgCtx := context.Background()
    if err := emailSvc.Send(bgCtx, email); err != nil {
        logger.Error("failed to send email", zap.Error(err))
    }
}()
```

3. **Worker pools** — processing a queue of jobs with bounded concurrency.

4. **Periodic tasks** — health checks, cache warming, metric collection.

### When NOT to use goroutines:

1. **Simple sequential operations** — if step B depends on step A's result, don't parallelize them.
2. **CPU-bound work without I/O** — goroutines shine for I/O-bound work. For CPU-heavy computation, you're limited by your CPU core count anyway.
3. **When you don't know if it's safe** — if you can't guarantee the goroutine won't access shared state, don't launch it.

### The #1 Mistake: Fire-and-Forget Without Error Handling

```go
// BAD — error is silently lost
go processWebhook(ctx, event)

// GOOD — at minimum, log errors from background goroutines
go func() {
    if err := processWebhook(ctx, event); err != nil {
        logger.Error("webhook processing failed",
            zap.String("event_id", event.ID),
            zap.Error(err),
        )
    }
}()
```

---

## Channels

Channels are typed conduits for sending data between goroutines. Think of them as thread-safe queues.

### Unbuffered Channels (Synchronous)

```go
ch := make(chan string) // unbuffered — sender blocks until receiver is ready

go func() {
    ch <- "hello" // blocks here until someone reads from ch
}()

msg := <-ch // blocks here until someone writes to ch
fmt.Println(msg) // "hello"
```

Unbuffered channels force synchronization — the sender and receiver must be ready at the same time.

### Buffered Channels (Asynchronous up to capacity)

```go
ch := make(chan string, 3) // buffer size 3

ch <- "a" // doesn't block (buffer has space)
ch <- "b" // doesn't block
ch <- "c" // doesn't block
// ch <- "d" // WOULD block — buffer is full

msg := <-ch // "a" (FIFO)
```

### Directional Channels (Read-Only, Write-Only)

Used in function signatures to enforce usage:

```go
// Producer can only SEND to the channel
func produce(out chan<- string) {
    out <- "data"
}

// Consumer can only RECEIVE from the channel
func consume(in <-chan string) {
    msg := <-in
    fmt.Println(msg)
}
```

### Closing Channels

```go
ch := make(chan int, 5)
ch <- 1
ch <- 2
ch <- 3
close(ch) // signals that no more values will be sent

// Range over a channel — exits when channel is closed
for val := range ch {
    fmt.Println(val) // prints 1, 2, 3
}

// Check if channel is closed
val, ok := <-ch
if !ok {
    fmt.Println("channel closed")
}
```

**Rules:**

- Only the **sender** should close a channel (never the receiver).
- Sending on a closed channel **panics.**
- Receiving from a closed channel returns the zero value immediately.

---

## sync.WaitGroup

`WaitGroup` waits for a collection of goroutines to finish:

```go
func fetchAllUsers(ctx context.Context, ids []string) []*User {
    var (
        mu    sync.Mutex
        users []*User
        wg    sync.WaitGroup
    )

    for _, id := range ids {
        wg.Add(1) // increment counter BEFORE launching goroutine
        go func(userID string) {
            defer wg.Done() // decrement counter when goroutine finishes

            user, err := userRepo.GetByID(ctx, userID)
            if err != nil {
                return
            }

            mu.Lock()
            users = append(users, user)
            mu.Unlock()
        }(id) // pass id as argument to avoid closure capture bug
    }

    wg.Wait() // blocks until counter reaches 0
    return users
}
```

**Common mistake:** Forgetting to call `wg.Add(1)` before the goroutine, or calling it inside the goroutine (race condition).

---

## sync.Mutex and sync.RWMutex

When multiple goroutines access shared data, you need a lock to prevent data races.

### Mutex (Mutual Exclusion)

```go
type SafeCounter struct {
    mu    sync.Mutex
    count map[string]int
}

func (c *SafeCounter) Increment(key string) {
    c.mu.Lock()         // acquire lock — only one goroutine can hold it
    defer c.mu.Unlock() // release lock when function returns
    c.count[key]++
}

func (c *SafeCounter) Get(key string) int {
    c.mu.Lock()
    defer c.mu.Unlock()
    return c.count[key]
}
```

### RWMutex (Read-Write Mutex)

When reads vastly outnumber writes, `RWMutex` allows multiple concurrent readers:

```go
type Cache struct {
    mu   sync.RWMutex
    data map[string]interface{}
}

func (c *Cache) Get(key string) (interface{}, bool) {
    c.mu.RLock()         // read lock — multiple goroutines can hold this simultaneously
    defer c.mu.RUnlock()
    val, ok := c.data[key]
    return val, ok
}

func (c *Cache) Set(key string, value interface{}) {
    c.mu.Lock()          // write lock — exclusive, blocks all readers AND writers
    defer c.mu.Unlock()
    c.data[key] = value
}
```

---

## sync.Once

Guarantees a function executes exactly once, even if called from multiple goroutines. Used for lazy initialization:

```go
type DBConnection struct {
    once sync.Once
    db   *sqlx.DB
}

func (c *DBConnection) Get(dsn string) *sqlx.DB {
    c.once.Do(func() {
        // This runs exactly once, no matter how many goroutines call Get()
        db, err := sqlx.Connect("postgres", dsn)
        if err != nil {
            panic("failed to connect: " + err.Error())
        }
        c.db = db
    })
    return c.db
}
```

---

## errgroup — The Production Pattern

`errgroup` from `golang.org/x/sync/errgroup` is what you'll use in real services. It combines `WaitGroup` with error handling and context cancellation:

```go
import "golang.org/x/sync/errgroup"

func (s *DashboardService) GetDashboard(ctx context.Context, userID string) (*Dashboard, error) {
    // errgroup.WithContext returns a group and a derived context.
    // If ANY goroutine returns an error, the context is cancelled,
    // stopping all other goroutines.
    g, ctx := errgroup.WithContext(ctx)

    var (
        user    *User
        orders  []*Order
        balance *Balance
        notifs  []*Notification
    )

    g.Go(func() error {
        var err error
        user, err = s.userSvc.GetByID(ctx, userID)
        return err
    })

    g.Go(func() error {
        var err error
        orders, err = s.orderSvc.ListRecent(ctx, userID, 10)
        return err
    })

    g.Go(func() error {
        var err error
        balance, err = s.paymentSvc.GetBalance(ctx, userID)
        return err
    })

    g.Go(func() error {
        var err error
        notifs, err = s.notifSvc.ListUnread(ctx, userID)
        return err
    })

    // Wait for all goroutines to complete.
    // Returns the FIRST error encountered (others are cancelled via context).
    if err := g.Wait(); err != nil {
        return nil, fmt.Errorf("get dashboard: %w", err)
    }

    return &Dashboard{
        User:          user,
        RecentOrders:  orders,
        Balance:       balance,
        Notifications: notifs,
    }, nil
}
```

### errgroup with Concurrency Limit

```go
// Limit to 5 concurrent goroutines (e.g., don't overwhelm a downstream service)
g, ctx := errgroup.WithContext(ctx)
g.SetLimit(5)

for _, item := range items {
    item := item
    g.Go(func() error {
        return processItem(ctx, item)
    })
}

if err := g.Wait(); err != nil {
    return err
}
```

---

## Worker Pool Pattern

For processing a large number of jobs with bounded concurrency:

```go
func ProcessJobs(ctx context.Context, jobs []Job, workers int) error {
    jobCh := make(chan Job, len(jobs))

    // Fill the job channel
    for _, j := range jobs {
        jobCh <- j
    }
    close(jobCh) // signal no more jobs

    // Launch worker goroutines
    g, ctx := errgroup.WithContext(ctx)
    for i := 0; i < workers; i++ {
        g.Go(func() error {
            for job := range jobCh {
                select {
                case <-ctx.Done():
                    return ctx.Err()
                default:
                }

                if err := processJob(ctx, job); err != nil {
                    return fmt.Errorf("process job %s: %w", job.ID, err)
                }
            }
            return nil
        })
    }

    return g.Wait()
}
```

---

## The select Statement

`select` lets you wait on multiple channel operations simultaneously. It's like a `switch` for channels:

```go
func (w *Worker) Run(ctx context.Context) error {
    ticker := time.NewTicker(30 * time.Second) // periodic health check
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            // Context cancelled — clean shutdown
            return ctx.Err()

        case job := <-w.jobCh:
            // New job received — process it
            if err := w.process(ctx, job); err != nil {
                w.logger.Error("job failed", zap.Error(err))
            }

        case <-ticker.C:
            // Periodic tick — run health check
            w.healthCheck()
        }
    }
}
```

### Timeout Pattern with select

```go
func fetchWithTimeout(ctx context.Context, url string) ([]byte, error) {
    resultCh := make(chan []byte, 1)
    errCh := make(chan error, 1)

    go func() {
        data, err := fetch(ctx, url)
        if err != nil {
            errCh <- err
            return
        }
        resultCh <- data
    }()

    select {
    case data := <-resultCh:
        return data, nil
    case err := <-errCh:
        return nil, err
    case <-ctx.Done():
        return nil, ctx.Err()
    }
}
```

---

## Data Races

A data race occurs when two goroutines access the same variable concurrently, and at least one of the accesses is a write.

### Example of a Data Race

```go
// BUG — data race!
var counter int

for i := 0; i < 1000; i++ {
    go func() {
        counter++ // multiple goroutines read and write counter simultaneously
    }()
}
// counter will NOT be 1000 — it will be some unpredictable number
```

### Detecting Data Races

Go has a built-in race detector. Always use it in development and CI:

```bash
# Run tests with race detector
go test -race ./...

# Run program with race detector
go run -race main.go
```

The race detector will print a detailed report showing exactly which goroutines accessed the same memory and from which code lines.

### Fixing Data Races

**Option 1: Mutex**

```go
var (
    mu      sync.Mutex
    counter int
)

for i := 0; i < 1000; i++ {
    go func() {
        mu.Lock()
        counter++
        mu.Unlock()
    }()
}
```

**Option 2: Atomic operations (for simple counters)**

```go
var counter atomic.Int64

for i := 0; i < 1000; i++ {
    go func() {
        counter.Add(1)
    }()
}

fmt.Println(counter.Load()) // 1000
```

**Option 3: Channels (communicate by sharing, don't share by communicating)**

```go
counter := 0
ch := make(chan int, 1000)

for i := 0; i < 1000; i++ {
    go func() {
        ch <- 1
    }()
}

for i := 0; i < 1000; i++ {
    counter += <-ch
}
```

---

## Real Backend Use Cases

### Fan-Out API Calls

```go
// Enrich an order with data from multiple services
func (s *OrderService) EnrichOrder(ctx context.Context, order *Order) (*EnrichedOrder, error) {
    g, ctx := errgroup.WithContext(ctx)

    var product *Product
    var seller *Seller

    g.Go(func() error {
        var err error
        product, err = s.productClient.Get(ctx, order.ProductID)
        return err
    })

    g.Go(func() error {
        var err error
        seller, err = s.sellerClient.Get(ctx, order.SellerID)
        return err
    })

    if err := g.Wait(); err != nil {
        return nil, err
    }

    return &EnrichedOrder{
        Order:   order,
        Product: product,
        Seller:  seller,
    }, nil
}
```

### Background Cache Warming

```go
func (s *Service) WarmCache(ctx context.Context) {
    ticker := time.NewTicker(5 * time.Minute)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            products, err := s.repo.ListTopProducts(ctx, 100)
            if err != nil {
                s.logger.Error("cache warm failed", zap.Error(err))
                continue
            }
            for _, p := range products {
                s.cache.Set(ctx, "product:"+p.ID, p, 10*time.Minute)
            }
            s.logger.Info("cache warmed", zap.Int("products", len(products)))
        }
    }
}
```

---

## Full Example: Concurrent Job Processor

A production-grade worker that reads from a job queue and processes with bounded concurrency:

```go
package worker

import (
    "context"
    "fmt"
    "sync/atomic"
    "time"

    "go.uber.org/zap"
    "golang.org/x/sync/errgroup"
)

type Job struct {
    ID      string
    Payload []byte
}

type JobProcessor struct {
    queue      JobQueue          // interface for fetching jobs (Kafka, SQS, Redis, etc.)
    handler    func(context.Context, Job) error
    logger     *zap.Logger
    workers    int
    processed  atomic.Int64
    failed     atomic.Int64
}

func NewJobProcessor(queue JobQueue, handler func(context.Context, Job) error, workers int, logger *zap.Logger) *JobProcessor {
    return &JobProcessor{
        queue:   queue,
        handler: handler,
        logger:  logger,
        workers: workers,
    }
}

func (p *JobProcessor) Run(ctx context.Context) error {
    p.logger.Info("starting job processor", zap.Int("workers", p.workers))

    g, ctx := errgroup.WithContext(ctx)

    // Job channel — workers pull jobs from this
    jobCh := make(chan Job, p.workers*2) // buffer = 2x workers for smoother throughput

    // Producer: fetches jobs from the queue and sends to the channel
    g.Go(func() error {
        defer close(jobCh) // close channel when context is done → workers exit gracefully
        for {
            select {
            case <-ctx.Done():
                return nil
            default:
            }

            job, err := p.queue.Dequeue(ctx)
            if err != nil {
                p.logger.Warn("dequeue failed, retrying", zap.Error(err))
                time.Sleep(time.Second)
                continue
            }

            select {
            case jobCh <- job:
            case <-ctx.Done():
                return nil
            }
        }
    })

    // Workers: process jobs from the channel
    for i := 0; i < p.workers; i++ {
        workerID := i
        g.Go(func() error {
            p.logger.Info("worker started", zap.Int("worker_id", workerID))
            for job := range jobCh {
                start := time.Now()

                if err := p.handler(ctx, job); err != nil {
                    p.failed.Add(1)
                    p.logger.Error("job failed",
                        zap.String("job_id", job.ID),
                        zap.Int("worker_id", workerID),
                        zap.Error(err),
                        zap.Duration("duration", time.Since(start)),
                    )
                    continue // don't stop the worker on individual job failure
                }

                p.processed.Add(1)
                p.logger.Debug("job completed",
                    zap.String("job_id", job.ID),
                    zap.Duration("duration", time.Since(start)),
                )
            }
            return nil
        })
    }

    // Metrics reporter
    g.Go(func() error {
        ticker := time.NewTicker(10 * time.Second)
        defer ticker.Stop()
        for {
            select {
            case <-ctx.Done():
                return nil
            case <-ticker.C:
                p.logger.Info("processor stats",
                    zap.Int64("processed", p.processed.Load()),
                    zap.Int64("failed", p.failed.Load()),
                )
            }
        }
    })

    return g.Wait()
}

func (p *JobProcessor) Stats() (processed, failed int64) {
    return p.processed.Load(), p.failed.Load()
}
```

Usage in `main.go`:

```go
func main() {
    // ... setup config, logger, etc.

    processor := worker.NewJobProcessor(
        kafkaQueue,
        handleOrderEvent, // your job handler function
        10,               // 10 concurrent workers
        logger,
    )

    ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
    defer cancel()

    if err := processor.Run(ctx); err != nil {
        logger.Fatal("processor failed", zap.Error(err))
    }
}
```

---

→ **Continued in [Part 8 — Authentication & Authorization](./part08_auth.md)**
