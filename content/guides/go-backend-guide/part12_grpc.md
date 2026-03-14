# Part 12 — gRPC in Go

> **Series:** The Definitive Go Backend Guide for Frontend Engineers
> **Prev:** [Part 11 — Message Queues](./part11_message_queues.md)
> **Next:** [Part 13 — Testing in Go Backend](./part13_testing.md)

---

## Table of Contents

- [What gRPC Is and Why Companies Use It](#what-grpc-is-and-why-companies-use-it)
- [Protocol Buffers — Writing .proto Files](#protocol-buffers)
- [Unary vs Streaming RPCs](#unary-vs-streaming-rpcs)
- [gRPC Server Setup](#grpc-server-setup)
- [gRPC Client Setup](#grpc-client-setup)
- [gRPC Interceptors (Middleware)](#grpc-interceptors)
- [Error Handling in gRPC](#error-handling-in-grpc)
- [gRPC vs REST — When to Use Which](#grpc-vs-rest)
- [Full Example](#full-example)

---

## What gRPC Is and Why Companies Use It

### The Frontend Analogy

You know REST — you send JSON over HTTP. gRPC is an alternative: you send **binary-encoded protocol buffers** over **HTTP/2.**

**Why companies use gRPC for internal service communication:**

| Feature | REST | gRPC |
|---|---|---|
| **Encoding** | JSON (text, slow to parse) | Protobuf (binary, 5-10x faster) |
| **Transport** | HTTP/1.1 (one request per connection) | HTTP/2 (multiplexed, many requests per connection) |
| **Contract** | OpenAPI spec (optional, often outdated) | `.proto` file (required, code-generated) |
| **Streaming** | Hacky (SSE, WebSocket) | Native (bidirectional streaming) |
| **Code generation** | Optional | Built-in (generate server stubs + client SDK) |

**Rule of thumb:** REST for external APIs (browser, mobile). gRPC for internal service-to-service calls.

---

## Protocol Buffers

Proto files define your API contract. The `protoc` compiler generates Go code from them.

```protobuf
// proto/order/v1/order.proto

syntax = "proto3";

package order.v1;

option go_package = "github.com/yourcompany/order-service/gen/order/v1;orderv1";

import "google/protobuf/timestamp.proto";

// The service definition — like a REST controller but strongly typed
service OrderService {
    rpc CreateOrder(CreateOrderRequest) returns (CreateOrderResponse);
    rpc GetOrder(GetOrderRequest) returns (GetOrderResponse);
    rpc ListOrders(ListOrdersRequest) returns (ListOrdersResponse);
    rpc CancelOrder(CancelOrderRequest) returns (CancelOrderResponse);
}

// Messages — like JSON request/response bodies but with typed fields
message CreateOrderRequest {
    string user_id = 1;
    repeated OrderItem items = 2;
}

message CreateOrderResponse {
    Order order = 1;
}

message GetOrderRequest {
    string order_id = 1;
}

message GetOrderResponse {
    Order order = 1;
}

message ListOrdersRequest {
    string user_id = 1;
    int32 page_size = 2;
    string page_token = 3;
}

message ListOrdersResponse {
    repeated Order orders = 1;
    string next_page_token = 2;
    int32 total_count = 3;
}

message CancelOrderRequest {
    string order_id = 1;
}

message CancelOrderResponse {
    Order order = 1;
}

message Order {
    string id = 1;
    string user_id = 2;
    OrderStatus status = 3;
    int64 total_amount = 4;
    string currency = 5;
    repeated OrderItem items = 6;
    google.protobuf.Timestamp created_at = 7;
}

message OrderItem {
    string product_id = 1;
    int32 quantity = 2;
    int64 price_each = 3;
}

enum OrderStatus {
    ORDER_STATUS_UNSPECIFIED = 0;
    ORDER_STATUS_PENDING = 1;
    ORDER_STATUS_CONFIRMED = 2;
    ORDER_STATUS_SHIPPED = 3;
    ORDER_STATUS_DELIVERED = 4;
    ORDER_STATUS_CANCELLED = 5;
}
```

### Generating Go Code

```bash
# Install protoc plugins
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest

# Generate Go code from proto files
protoc --go_out=. --go_opt=paths=source_relative \
       --go-grpc_out=. --go-grpc_opt=paths=source_relative \
       proto/order/v1/order.proto
```

This generates two files:

- `order.pb.go` — message types (structs)
- `order_grpc.pb.go` — server interface + client SDK

---

## Unary vs Streaming RPCs

| Type | Description | Use Case |
|---|---|---|
| **Unary** | One request, one response | Most API calls (CRUD) |
| **Server streaming** | One request, stream of responses | Real-time updates, large data export |
| **Client streaming** | Stream of requests, one response | File upload, batch processing |
| **Bidirectional** | Stream both ways | Chat, real-time collaboration |

Most backend work uses **unary RPCs.** Streaming is used for specific use cases like log tailing or real-time feeds.

---

## gRPC Server Setup

```go
package main

import (
    "context"
    "fmt"
    "net"

    "go.uber.org/zap"
    "google.golang.org/grpc"
    "google.golang.org/grpc/reflection"

    orderv1 "github.com/yourcompany/order-service/gen/order/v1"
    "github.com/yourcompany/order-service/internal/service"
)

// grpcOrderServer implements the generated OrderServiceServer interface
type grpcOrderServer struct {
    orderv1.UnimplementedOrderServiceServer // embed for forward compatibility
    svc *service.OrderService
}

func (s *grpcOrderServer) CreateOrder(ctx context.Context, req *orderv1.CreateOrderRequest) (*orderv1.CreateOrderResponse, error) {
    // Convert proto request to domain model
    items := make([]model.OrderItem, len(req.Items))
    for i, item := range req.Items {
        items[i] = model.OrderItem{
            ProductID: item.ProductId,
            Quantity:  int(item.Quantity),
            PriceEach: item.PriceEach,
        }
    }

    order, err := s.svc.CreateOrder(ctx, req.UserId, items)
    if err != nil {
        return nil, toGRPCError(err) // convert domain error to gRPC status
    }

    return &orderv1.CreateOrderResponse{
        Order: toProtoOrder(order),
    }, nil
}

func (s *grpcOrderServer) GetOrder(ctx context.Context, req *orderv1.GetOrderRequest) (*orderv1.GetOrderResponse, error) {
    order, err := s.svc.GetOrder(ctx, req.OrderId)
    if err != nil {
        return nil, toGRPCError(err)
    }

    return &orderv1.GetOrderResponse{
        Order: toProtoOrder(order),
    }, nil
}

func main() {
    // ... setup config, logger, db, services

    // Create gRPC server with interceptors (middleware)
    grpcServer := grpc.NewServer(
        grpc.ChainUnaryInterceptor(
            loggingInterceptor(logger),
            recoveryInterceptor(logger),
            authInterceptor(tokenSvc),
        ),
    )

    // Register our service implementation
    orderv1.RegisterOrderServiceServer(grpcServer, &grpcOrderServer{svc: orderSvc})

    // Enable reflection for debugging tools like grpcurl
    reflection.Register(grpcServer)

    // Listen on TCP
    lis, err := net.Listen("tcp", ":50051")
    if err != nil {
        logger.Fatal("failed to listen", zap.Error(err))
    }

    logger.Info("gRPC server starting", zap.String("addr", ":50051"))
    if err := grpcServer.Serve(lis); err != nil {
        logger.Fatal("gRPC server failed", zap.Error(err))
    }
}
```

---

## gRPC Client Setup

```go
package client

import (
    "context"
    "fmt"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"

    orderv1 "github.com/yourcompany/order-service/gen/order/v1"
)

type OrderClient struct {
    client orderv1.OrderServiceClient
    conn   *grpc.ClientConn
}

func NewOrderClient(addr string) (*OrderClient, error) {
    conn, err := grpc.NewClient(addr,
        grpc.WithTransportCredentials(insecure.NewCredentials()), // use TLS in production
        grpc.WithDefaultCallOptions(
            grpc.MaxCallRecvMsgSize(10*1024*1024), // 10MB max message
        ),
    )
    if err != nil {
        return nil, fmt.Errorf("connect to order service: %w", err)
    }

    return &OrderClient{
        client: orderv1.NewOrderServiceClient(conn),
        conn:   conn,
    }, nil
}

func (c *OrderClient) GetOrder(ctx context.Context, orderID string) (*orderv1.Order, error) {
    ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    resp, err := c.client.GetOrder(ctx, &orderv1.GetOrderRequest{
        OrderId: orderID,
    })
    if err != nil {
        return nil, fmt.Errorf("get order: %w", err)
    }

    return resp.Order, nil
}

func (c *OrderClient) Close() error {
    return c.conn.Close()
}
```

---

## gRPC Interceptors

Interceptors are gRPC's version of middleware:

```go
// Logging interceptor
func loggingInterceptor(logger *zap.Logger) grpc.UnaryServerInterceptor {
    return func(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (interface{}, error) {
        start := time.Now()

        resp, err := handler(ctx, req)

        logger.Info("grpc request",
            zap.String("method", info.FullMethod),
            zap.Duration("duration", time.Since(start)),
            zap.Error(err),
        )

        return resp, err
    }
}

// Recovery interceptor
func recoveryInterceptor(logger *zap.Logger) grpc.UnaryServerInterceptor {
    return func(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (resp interface{}, err error) {
        defer func() {
            if r := recover(); r != nil {
                logger.Error("grpc panic",
                    zap.Any("panic", r),
                    zap.String("method", info.FullMethod),
                )
                err = status.Errorf(codes.Internal, "internal server error")
            }
        }()
        return handler(ctx, req)
    }
}

// Auth interceptor
func authInterceptor(tokenSvc *auth.TokenService) grpc.UnaryServerInterceptor {
    return func(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (interface{}, error) {
        // Skip auth for health check and reflection
        if info.FullMethod == "/grpc.health.v1.Health/Check" {
            return handler(ctx, req)
        }

        md, ok := metadata.FromIncomingContext(ctx)
        if !ok {
            return nil, status.Errorf(codes.Unauthenticated, "missing metadata")
        }

        tokens := md.Get("authorization")
        if len(tokens) == 0 {
            return nil, status.Errorf(codes.Unauthenticated, "missing authorization")
        }

        tokenStr := strings.TrimPrefix(tokens[0], "Bearer ")
        claims, err := tokenSvc.ValidateAccessToken(tokenStr)
        if err != nil {
            return nil, status.Errorf(codes.Unauthenticated, "invalid token")
        }

        ctx = context.WithValue(ctx, userIDKey, claims.Subject)
        return handler(ctx, req)
    }
}
```

---

## Error Handling in gRPC

gRPC uses its own status codes (not HTTP status codes):

```go
import (
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

func toGRPCError(err error) error {
    switch {
    case errors.Is(err, model.ErrOrderNotFound):
        return status.Error(codes.NotFound, "order not found")
    case errors.Is(err, model.ErrInsufficientStock):
        return status.Error(codes.FailedPrecondition, "insufficient stock")
    case errors.Is(err, model.ErrInvalidOrderStatus):
        return status.Error(codes.FailedPrecondition, "invalid order status")
    default:
        return status.Error(codes.Internal, "internal error")
    }
}
```

| gRPC Code | HTTP Equivalent | When to Use |
|---|---|---|
| `OK` | 200 | Success |
| `NotFound` | 404 | Resource doesn't exist |
| `InvalidArgument` | 400 | Bad input |
| `FailedPrecondition` | 409 | Business rule violation |
| `Unauthenticated` | 401 | Missing/invalid auth |
| `PermissionDenied` | 403 | Not authorized |
| `Internal` | 500 | Unexpected server error |
| `DeadlineExceeded` | 504 | Timeout |
| `Unavailable` | 503 | Service temporarily unavailable (retry) |

---

## gRPC vs REST

| Factor | Use REST | Use gRPC |
|---|---|---|
| **External clients** (browser, mobile) | Yes | No (needs proxy) |
| **Internal service-to-service** | Possible | Preferred |
| **High throughput** | Fine | Better (binary, HTTP/2) |
| **Streaming data** | Awkward | Native |
| **API contract enforcement** | Optional (OpenAPI) | Mandatory (proto) |
| **Browser debugging** | Easy (curl, browser) | Harder (need grpcurl) |

**What companies do:** REST for the public API that frontends consume. gRPC between internal services.

---

## Full Example

Testing with `grpcurl`:

```bash
# List available services
grpcurl -plaintext localhost:50051 list

# Describe a service
grpcurl -plaintext localhost:50051 describe order.v1.OrderService

# Call a method
grpcurl -plaintext -d '{"order_id": "order-123"}' \
  localhost:50051 order.v1.OrderService/GetOrder
```

---

→ **Continued in [Part 13 — Testing in Go Backend](./part13_testing.md)**
