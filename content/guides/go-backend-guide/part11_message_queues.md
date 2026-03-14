# Part 11 — Message Queues & Event-Driven Patterns

> **Series:** The Definitive Go Backend Guide for Frontend Engineers
> **Prev:** [Part 10 — Observability](./part10_observability.md)
> **Next:** [Part 12 — gRPC in Go](./part12_grpc.md)

---

## Table of Contents

- [11A — Concepts](#11a--concepts)
- [11B — Kafka in Go](#11b--kafka-in-go)
- [11C — Patterns (Outbox, Event Sourcing, CQRS)](#11c--patterns)
- [11D — Full Example: DB Write + Event Publish](#11d--full-example)

---

## 11A — Concepts

### Why Message Queues Exist

In synchronous communication (HTTP/gRPC), Service A calls Service B and waits for a response. If Service B is slow or down, Service A is stuck.

Message queues decouple producers from consumers:

```
Synchronous:  OrderService --HTTP--> NotificationService (blocks until response)

Asynchronous: OrderService --publish--> [Kafka Topic] --consume--> NotificationService
              (returns immediately)                      (processes at its own pace)
```

**Benefits:**

- **Decoupling** — the producer doesn't know or care who consumes the message.
- **Reliability** — messages are persisted. If the consumer is down, messages wait.
- **Scalability** — add more consumers to handle higher throughput.
- **Buffering** — absorb traffic spikes without overwhelming downstream services.

### Key Kafka Concepts

| Concept | Explanation |
|---|---|
| **Topic** | A named feed of messages (e.g., `order.created`, `user.updated`) |
| **Partition** | A topic is split into partitions for parallelism. Each partition is an ordered, append-only log. |
| **Producer** | Writes messages to a topic |
| **Consumer** | Reads messages from a topic |
| **Consumer Group** | A group of consumers that share the work. Each partition is assigned to one consumer in the group. |
| **Offset** | The position of a message in a partition. Consumers track their offset to know where they left off. |

### Delivery Guarantees

| Guarantee | Meaning | How |
|---|---|---|
| **At-most-once** | Message might be lost, never duplicated | Commit offset before processing |
| **At-least-once** | Message never lost, might be duplicated | Commit offset after processing (most common) |
| **Exactly-once** | Never lost, never duplicated | Kafka transactions + idempotent consumers (complex) |

**Most production systems use at-least-once delivery** and make consumers **idempotent** (processing the same message twice has the same effect as processing it once).

---

## 11B — Kafka in Go

### Using `confluent-kafka-go` (librdkafka-based, production-grade)

#### Producer

```go
package kafka

import (
    "context"
    "encoding/json"
    "fmt"

    "github.com/confluentinc/confluent-kafka-go/v2/kafka"
    "go.uber.org/zap"
)

type Producer struct {
    producer *kafka.Producer
    logger   *zap.Logger
}

func NewProducer(brokers string, logger *zap.Logger) (*Producer, error) {
    p, err := kafka.NewProducer(&kafka.ConfigMap{
        "bootstrap.servers":   brokers,
        "acks":                "all",   // wait for all replicas to acknowledge
        "retries":             3,
        "retry.backoff.ms":    100,
        "enable.idempotence":  true,    // prevent duplicate messages on retry
        "compression.type":    "snappy",
    })
    if err != nil {
        return nil, fmt.Errorf("create producer: %w", err)
    }

    prod := &Producer{producer: p, logger: logger}

    // Handle delivery reports in the background
    go prod.handleDeliveryReports()

    return prod, nil
}

func (p *Producer) handleDeliveryReports() {
    for e := range p.producer.Events() {
        switch ev := e.(type) {
        case *kafka.Message:
            if ev.TopicPartition.Error != nil {
                p.logger.Error("message delivery failed",
                    zap.String("topic", *ev.TopicPartition.Topic),
                    zap.Error(ev.TopicPartition.Error),
                )
            }
        }
    }
}

type Event struct {
    Type      string      `json:"type"`
    Timestamp int64       `json:"timestamp"`
    Data      interface{} `json:"data"`
}

func (p *Producer) Publish(ctx context.Context, topic string, key string, event Event) error {
    payload, err := json.Marshal(event)
    if err != nil {
        return fmt.Errorf("marshal event: %w", err)
    }

    msg := &kafka.Message{
        TopicPartition: kafka.TopicPartition{
            Topic:     &topic,
            Partition: kafka.PartitionAny,
        },
        Key:   []byte(key),   // same key → same partition → ordering guarantee
        Value: payload,
    }

    err = p.producer.Produce(msg, nil)
    if err != nil {
        return fmt.Errorf("produce message: %w", err)
    }

    return nil
}

func (p *Producer) Close() {
    p.producer.Flush(5000) // wait up to 5s for pending messages
    p.producer.Close()
}
```

#### Consumer

```go
package kafka

import (
    "context"
    "encoding/json"
    "fmt"

    "github.com/confluentinc/confluent-kafka-go/v2/kafka"
    "go.uber.org/zap"
)

type MessageHandler func(ctx context.Context, msg *kafka.Message) error

type Consumer struct {
    consumer *kafka.Consumer
    handler  MessageHandler
    logger   *zap.Logger
}

func NewConsumer(brokers, group string, topics []string, handler MessageHandler, logger *zap.Logger) (*Consumer, error) {
    c, err := kafka.NewConsumer(&kafka.ConfigMap{
        "bootstrap.servers":  brokers,
        "group.id":           group,
        "auto.offset.reset":  "earliest", // start from beginning if no committed offset
        "enable.auto.commit": false,       // manual commit for at-least-once delivery
    })
    if err != nil {
        return nil, fmt.Errorf("create consumer: %w", err)
    }

    if err := c.SubscribeTopics(topics, nil); err != nil {
        return nil, fmt.Errorf("subscribe topics: %w", err)
    }

    return &Consumer{consumer: c, handler: handler, logger: logger}, nil
}

func (c *Consumer) Run(ctx context.Context) error {
    c.logger.Info("consumer started")

    for {
        select {
        case <-ctx.Done():
            c.logger.Info("consumer shutting down")
            c.consumer.Close()
            return nil
        default:
        }

        // Poll for messages with a 100ms timeout
        ev := c.consumer.Poll(100)
        if ev == nil {
            continue
        }

        switch e := ev.(type) {
        case *kafka.Message:
            c.logger.Debug("received message",
                zap.String("topic", *e.TopicPartition.Topic),
                zap.Int32("partition", e.TopicPartition.Partition),
                zap.Int64("offset", int64(e.TopicPartition.Offset)),
            )

            // Process the message
            if err := c.handler(ctx, e); err != nil {
                c.logger.Error("message processing failed",
                    zap.String("topic", *e.TopicPartition.Topic),
                    zap.Int64("offset", int64(e.TopicPartition.Offset)),
                    zap.Error(err),
                )
                // Don't commit — message will be redelivered
                continue
            }

            // Commit offset AFTER successful processing (at-least-once)
            _, err := c.consumer.CommitMessage(e)
            if err != nil {
                c.logger.Error("offset commit failed", zap.Error(err))
            }

        case kafka.Error:
            c.logger.Error("kafka error", zap.Error(e))
        }
    }
}
```

### Handling Poison Pill Messages

A "poison pill" is a message that always fails processing (malformed data, bug in handler). Without handling, it blocks the partition forever:

```go
func (c *Consumer) RunWithDeadLetter(ctx context.Context, maxRetries int, dlqTopic string) error {
    for {
        select {
        case <-ctx.Done():
            c.consumer.Close()
            return nil
        default:
        }

        ev := c.consumer.Poll(100)
        if ev == nil {
            continue
        }

        msg, ok := ev.(*kafka.Message)
        if !ok {
            continue
        }

        retryCount := getRetryCount(msg.Headers)

        if err := c.handler(ctx, msg); err != nil {
            if retryCount >= maxRetries {
                // Send to dead letter queue for manual inspection
                c.logger.Error("sending to DLQ after max retries",
                    zap.Int("retries", retryCount),
                    zap.Error(err),
                )
                c.publishToDLQ(ctx, dlqTopic, msg, err)
                c.consumer.CommitMessage(msg) // commit to move past it
                continue
            }

            // Retry by not committing — message will be redelivered
            c.logger.Warn("retrying message",
                zap.Int("retry", retryCount+1),
                zap.Error(err),
            )
            continue
        }

        c.consumer.CommitMessage(msg)
    }
}
```

---

## 11C — Patterns

### The Outbox Pattern

**Problem:** You need to update the database AND publish an event atomically. If you write to the DB and then Kafka fails, you have an inconsistent state.

**Solution:** Write the event to an "outbox" table in the same database transaction. A separate process reads the outbox and publishes to Kafka.

```go
// Step 1: Write order AND outbox event in one transaction
func (r *repo) CreateOrderWithEvent(ctx context.Context, order *Order, event *OutboxEvent) error {
    tx, err := r.db.BeginTxx(ctx, nil)
    if err != nil {
        return err
    }
    defer tx.Rollback()

    // Insert the order
    _, err = tx.ExecContext(ctx,
        `INSERT INTO orders (id, user_id, status, total_amount) VALUES ($1, $2, $3, $4)`,
        order.ID, order.UserID, order.Status, order.TotalAmount)
    if err != nil {
        return fmt.Errorf("insert order: %w", err)
    }

    // Insert the event into the outbox table (same transaction!)
    _, err = tx.ExecContext(ctx,
        `INSERT INTO outbox (id, topic, key, payload, created_at) VALUES ($1, $2, $3, $4, $5)`,
        event.ID, event.Topic, event.Key, event.Payload, event.CreatedAt)
    if err != nil {
        return fmt.Errorf("insert outbox event: %w", err)
    }

    return tx.Commit()
    // Both succeed or both fail — atomic!
}

// Step 2: Background worker reads outbox and publishes
func (w *OutboxWorker) Run(ctx context.Context) error {
    ticker := time.NewTicker(500 * time.Millisecond)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return nil
        case <-ticker.C:
            events, err := w.repo.GetUnpublishedEvents(ctx, 100)
            if err != nil {
                w.logger.Error("fetch outbox events", zap.Error(err))
                continue
            }

            for _, event := range events {
                if err := w.producer.Publish(ctx, event.Topic, event.Key, event.Payload); err != nil {
                    w.logger.Error("publish outbox event", zap.Error(err))
                    break
                }
                // Mark as published
                w.repo.MarkEventPublished(ctx, event.ID)
            }
        }
    }
}
```

```sql
-- Outbox table
CREATE TABLE outbox (
    id          VARCHAR(36) PRIMARY KEY,
    topic       VARCHAR(255) NOT NULL,
    key         VARCHAR(255) NOT NULL,
    payload     JSONB NOT NULL,
    published   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_outbox_unpublished ON outbox (published, created_at) WHERE published = FALSE;
```

---

## 11D — Full Example

A service that atomically creates an order and publishes an event:

```go
func (s *OrderService) CreateOrder(ctx context.Context, userID string, items []OrderItem) (*Order, error) {
    order := &Order{
        ID:        uuid.New().String(),
        UserID:    userID,
        Status:    OrderStatusPending,
        Items:     items,
        CreatedAt: time.Now().UTC(),
    }

    event := &OutboxEvent{
        ID:        uuid.New().String(),
        Topic:     "order.created",
        Key:       order.ID,
        Payload:   mustMarshal(OrderCreatedEvent{OrderID: order.ID, UserID: userID, Items: items}),
        CreatedAt: time.Now().UTC(),
    }

    // Atomic: order + event in one transaction
    if err := s.repo.CreateOrderWithEvent(ctx, order, event); err != nil {
        return nil, fmt.Errorf("create order: %w", err)
    }

    s.logger.Info("order created", zap.String("order_id", order.ID))
    return order, nil
}
```

---

→ **Continued in [Part 12 — gRPC in Go](./part12_grpc.md)**
