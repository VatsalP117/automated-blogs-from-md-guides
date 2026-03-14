# Part 9 — Configuration & Secrets Management

> **Series:** The Definitive Go Backend Guide for Frontend Engineers
> **Prev:** [Part 8 — Authentication & Authorization](./part08_auth.md)
> **Next:** [Part 10 — Logging, Observability & Tracing](./part10_observability.md)

---

## Table of Contents

- [12-Factor App Config Principles](#12-factor-app-config-principles)
- [Using Viper for Config Loading](#using-viper-for-config-loading)
- [Strongly-Typed Config Structs](#strongly-typed-config-structs)
- [Secrets Management](#secrets-management)
- [Config Validation at Startup (Fail Fast)](#config-validation-at-startup)
- [Full Production Config Setup](#full-production-config-setup)

---

## 12-Factor App Config Principles

The [12-factor app](https://12factor.net) methodology (used by virtually every cloud-native company) has clear rules about configuration:

1. **Config changes between environments** (dev/staging/prod). Code does not.
2. **Store config in environment variables** — not in code, not in checked-in files.
3. **Strict separation** between config and code. You should be able to open-source the codebase without exposing any credentials.

### What Is Config vs What Is Code

| Config (varies by environment) | Code (same everywhere) |
|---|---|
| Database URL | SQL queries |
| JWT secret key | JWT validation logic |
| Kafka broker addresses | Kafka consumer logic |
| Port number | Router definitions |
| Log level | Logging format |
| Feature flags | Feature implementation |
| API keys for third-party services | HTTP client code |

---

## Using Viper for Config Loading

Viper is the most popular config library for Go. It supports environment variables, config files, defaults, and more:

```go
package config

import (
    "fmt"
    "strings"
    "time"

    "github.com/spf13/viper"
)

type Config struct {
    // Server
    Port        string `mapstructure:"PORT"`
    Environment string `mapstructure:"ENVIRONMENT"` // development, staging, production

    // Database
    DatabaseURL       string        `mapstructure:"DATABASE_URL"`
    DBMaxOpenConns    int           `mapstructure:"DB_MAX_OPEN_CONNS"`
    DBMaxIdleConns    int           `mapstructure:"DB_MAX_IDLE_CONNS"`
    DBConnMaxLifetime time.Duration `mapstructure:"DB_CONN_MAX_LIFETIME"`

    // Redis
    RedisURL string `mapstructure:"REDIS_URL"`

    // Kafka
    KafkaBrokers       string `mapstructure:"KAFKA_BROKERS"`
    KafkaConsumerGroup string `mapstructure:"KAFKA_CONSUMER_GROUP"`

    // Auth
    JWTAccessSecret  string        `mapstructure:"JWT_ACCESS_SECRET"`
    JWTRefreshSecret string        `mapstructure:"JWT_REFRESH_SECRET"`
    JWTAccessTTL     time.Duration `mapstructure:"JWT_ACCESS_TTL"`
    JWTRefreshTTL    time.Duration `mapstructure:"JWT_REFRESH_TTL"`

    // Observability
    LogLevel   string `mapstructure:"LOG_LEVEL"`
    OTLPEndpoint string `mapstructure:"OTEL_EXPORTER_OTLP_ENDPOINT"`

    // External Services
    PaymentServiceURL   string `mapstructure:"PAYMENT_SERVICE_URL"`
    InventoryServiceURL string `mapstructure:"INVENTORY_SERVICE_URL"`

    // CORS
    AllowedOrigins string `mapstructure:"ALLOWED_ORIGINS"`
}

func (c Config) GetKafkaBrokers() []string {
    return strings.Split(c.KafkaBrokers, ",")
}

func (c Config) GetAllowedOrigins() []string {
    return strings.Split(c.AllowedOrigins, ",")
}

func (c Config) IsProduction() bool {
    return c.Environment == "production"
}

func Load() (*Config, error) {
    // Set defaults — these apply when env vars are not set
    viper.SetDefault("PORT", "8080")
    viper.SetDefault("ENVIRONMENT", "development")
    viper.SetDefault("DB_MAX_OPEN_CONNS", 25)
    viper.SetDefault("DB_MAX_IDLE_CONNS", 5)
    viper.SetDefault("DB_CONN_MAX_LIFETIME", 5*time.Minute)
    viper.SetDefault("LOG_LEVEL", "info")
    viper.SetDefault("JWT_ACCESS_TTL", 15*time.Minute)
    viper.SetDefault("JWT_REFRESH_TTL", 7*24*time.Hour)
    viper.SetDefault("KAFKA_CONSUMER_GROUP", "order-service")

    // Read from environment variables
    viper.AutomaticEnv()

    // Optionally read from a .env file in development
    viper.SetConfigName(".env")
    viper.SetConfigType("env")
    viper.AddConfigPath(".")
    // Ignore error if .env doesn't exist (it won't in production)
    _ = viper.ReadInConfig()

    var cfg Config
    if err := viper.Unmarshal(&cfg); err != nil {
        return nil, fmt.Errorf("unmarshal config: %w", err)
    }

    if err := cfg.validate(); err != nil {
        return nil, fmt.Errorf("invalid config: %w", err)
    }

    return &cfg, nil
}
```

---

## Strongly-Typed Config Structs

**Why this matters:** A strongly-typed config struct means your IDE gives you autocomplete, the compiler catches typos, and you can see all configuration in one place.

```go
// BAD — stringly typed, no compile-time safety
port := os.Getenv("PORT")
dbURL := os.Getenv("DATABASE_URL")
maxConns, _ := strconv.Atoi(os.Getenv("DB_MAX_OPEN_CONNS"))
// Typo in env var name? Runtime error. Missing value? Silent empty string.

// GOOD — typed struct with validation
cfg, err := config.Load()
if err != nil {
    log.Fatal(err) // fails fast with a clear error
}

db.SetMaxOpenConns(cfg.DBMaxOpenConns) // type-safe int
srv.Addr = ":" + cfg.Port               // guaranteed non-empty
```

---

## Secrets Management

### Rule #1: Secrets Never Go in Code

```go
// NEVER do this — this is a critical security violation
const jwtSecret = "my-super-secret-key"
const dbPassword = "p@ssw0rd"
```

### Where Secrets Live in Each Environment

| Environment | Where secrets are stored |
|---|---|
| **Local dev** | `.env` file (git-ignored) or shell `export` |
| **CI/CD** | Pipeline secrets (GitHub Actions secrets, GitLab CI variables) |
| **Staging/Prod (Kubernetes)** | Kubernetes Secrets (base64-encoded in etcd) |
| **Enterprise** | HashiCorp Vault, AWS Secrets Manager, GCP Secret Manager |

### Environment Variables in Practice

```bash
# .env (git-ignored — NEVER committed)
DATABASE_URL=postgres://user:pass@localhost:5432/orderdb?sslmode=disable
JWT_ACCESS_SECRET=dev-only-access-secret
JWT_REFRESH_SECRET=dev-only-refresh-secret
REDIS_URL=redis://localhost:6379
KAFKA_BROKERS=localhost:9092
```

```gitignore
# .gitignore
.env
*.pem
*.key
credentials.json
```

### Kubernetes Secrets

```yaml
# deployments/kubernetes/secret.yaml
# In practice, secrets are created via CI/CD or Vault — not checked into git
apiVersion: v1
kind: Secret
metadata:
  name: order-service-secrets
type: Opaque
stringData:
  DATABASE_URL: "postgres://user:pass@db-host:5432/orderdb?sslmode=require"
  JWT_ACCESS_SECRET: "production-access-secret-from-vault"
```

```yaml
# deployments/kubernetes/deployment.yaml (excerpt)
spec:
  containers:
    - name: order-service
      envFrom:
        - secretRef:
            name: order-service-secrets  # all keys become env vars
        - configMapRef:
            name: order-service-config   # non-secret config
```

---

## Config Validation at Startup

**Fail fast:** If the config is invalid, crash immediately with a clear error. Don't let the service start and fail mysteriously later.

```go
func (c *Config) validate() error {
    var errs []string

    // Required fields
    if c.DatabaseURL == "" {
        errs = append(errs, "DATABASE_URL is required")
    }
    if c.JWTAccessSecret == "" {
        errs = append(errs, "JWT_ACCESS_SECRET is required")
    }
    if c.JWTRefreshSecret == "" {
        errs = append(errs, "JWT_REFRESH_SECRET is required")
    }

    // Validate JWT secrets are different
    if c.JWTAccessSecret == c.JWTRefreshSecret && c.JWTAccessSecret != "" {
        errs = append(errs, "JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different")
    }

    // Validate ranges
    if c.DBMaxOpenConns < 1 || c.DBMaxOpenConns > 100 {
        errs = append(errs, "DB_MAX_OPEN_CONNS must be between 1 and 100")
    }

    // Validate environment
    validEnvs := map[string]bool{"development": true, "staging": true, "production": true}
    if !validEnvs[c.Environment] {
        errs = append(errs, fmt.Sprintf("ENVIRONMENT must be one of: development, staging, production (got: %s)", c.Environment))
    }

    // Production-specific validations
    if c.Environment == "production" {
        if c.LogLevel == "debug" {
            errs = append(errs, "LOG_LEVEL should not be 'debug' in production")
        }
        if c.KafkaBrokers == "" {
            errs = append(errs, "KAFKA_BROKERS is required in production")
        }
    }

    if len(errs) > 0 {
        return fmt.Errorf("config validation failed:\n  - %s", strings.Join(errs, "\n  - "))
    }
    return nil
}
```

**Sample output when validation fails:**

```
config validation failed:
  - DATABASE_URL is required
  - JWT_ACCESS_SECRET is required
  - JWT_REFRESH_SECRET is required
```

---

## Full Production Config Setup

### `main.go` — How config is loaded and used

```go
func main() {
    // 1. Load and validate config — fail fast if invalid
    cfg, err := config.Load()
    if err != nil {
        log.Fatalf("FATAL: config error: %v", err)
    }

    // 2. Initialize logger based on config
    logger := initLogger(cfg.LogLevel, cfg.IsProduction())
    defer logger.Sync()

    logger.Info("starting service",
        zap.String("environment", cfg.Environment),
        zap.String("port", cfg.Port),
    )

    // 3. Connect to database with config
    db, err := sqlx.Connect("postgres", cfg.DatabaseURL)
    if err != nil {
        logger.Fatal("database connection failed", zap.Error(err))
    }
    defer db.Close()
    db.SetMaxOpenConns(cfg.DBMaxOpenConns)
    db.SetMaxIdleConns(cfg.DBMaxIdleConns)
    db.SetConnMaxLifetime(cfg.DBConnMaxLifetime)

    // 4. Wire up services with config-derived dependencies
    tokenSvc := auth.NewTokenService(cfg.JWTAccessSecret, cfg.JWTRefreshSecret)
    orderRepo := repository.NewPostgresOrderRepository(db)
    orderSvc := service.NewOrderService(orderRepo, logger)

    // 5. Create router with config
    router := api.NewRouter(orderSvc, tokenSvc, logger, cfg)

    // 6. Start server
    srv := &http.Server{
        Addr:    ":" + cfg.Port,
        Handler: router,
    }
    // ... graceful shutdown (covered in Part 16)
}

func initLogger(level string, production bool) *zap.Logger {
    var cfg zap.Config
    if production {
        cfg = zap.NewProductionConfig()
    } else {
        cfg = zap.NewDevelopmentConfig()
    }

    switch level {
    case "debug":
        cfg.Level.SetLevel(zap.DebugLevel)
    case "info":
        cfg.Level.SetLevel(zap.InfoLevel)
    case "warn":
        cfg.Level.SetLevel(zap.WarnLevel)
    case "error":
        cfg.Level.SetLevel(zap.ErrorLevel)
    }

    logger, err := cfg.Build()
    if err != nil {
        log.Fatalf("failed to build logger: %v", err)
    }
    return logger
}
```

---

→ **Continued in [Part 10 — Logging, Observability & Tracing](./part10_observability.md)**
