# Phase 1: Foundation & Core Infrastructure

> **Scope**: Project scaffolding, configuration, database, models, repositories, DTOs, error handling, logging, utilities, HTTP server bootstrap, and health check endpoint.
>
> **Outcome**: A running Go binary that connects to SQLite, runs migrations, exposes `GET /api/v1/health`, and has a fully tested foundation layer ready for feature development.
>
> **Estimated files**: ~55 files (including tests)

---

## Table of Contents

1. [Third-Party Dependencies](#1-third-party-dependencies)
2. [Implementation Steps](#2-implementation-steps)
   - [Step 1: Go Module & Project Scaffolding](#step-1-go-module--project-scaffolding)
   - [Step 2: Configuration Loading](#step-2-configuration-loading)
   - [Step 3: Logger Setup](#step-3-logger-setup)
   - [Step 4: Custom Error Types](#step-4-custom-error-types)
   - [Step 5: Nanoid Utility](#step-5-nanoid-utility)
   - [Step 6: Encryption Utility](#step-6-encryption-utility)
   - [Step 7: SQLite Database Setup](#step-7-sqlite-database-setup)
   - [Step 8: Migration System](#step-8-migration-system)
   - [Step 9: Database Schema (Migrations)](#step-9-database-schema-migrations)
   - [Step 10: Model Structs](#step-10-model-structs)
   - [Step 11: DTO Structs](#step-11-dto-structs)
   - [Step 12: Repository Layer](#step-12-repository-layer)
   - [Step 13: HTTP Server Bootstrap](#step-13-http-server-bootstrap)
   - [Step 14: Health Check Endpoint](#step-14-health-check-endpoint)
   - [Step 15: Main Entrypoint Wiring](#step-15-main-entrypoint-wiring)
3. [File Manifest](#3-file-manifest)
4. [Testing Strategy](#4-testing-strategy)
5. [Definition of Done](#5-definition-of-done)

---

## 1. Third-Party Dependencies

### Direct Dependencies

| Module | Version | Purpose |
|--------|---------|---------|
| `github.com/labstack/echo/v4` | v4.12+ | HTTP framework |
| `github.com/mattn/go-sqlite3` | v1.14+ | SQLite driver (CGO) |
| `github.com/go-playground/validator/v10` | v10.22+ | Struct validation |
| `github.com/golang-jwt/jwt/v5` | v5.2+ | JWT tokens (used in later phases, declared now) |
| `github.com/matoous/go-nanoid/v2` | v2.1+ | Nanoid generation |

### Standard Library (no install needed)

| Package | Purpose |
|---------|---------|
| `log/slog` | Structured JSON logging |
| `crypto/aes` | AES-256-GCM encryption |
| `crypto/cipher` | GCM cipher mode |
| `crypto/rand` | Secure random nonce generation |
| `crypto/sha256` | Key derivation / hashing |
| `database/sql` | Database interface |
| `embed` | Embed migration SQL files |
| `encoding/hex` | Hex encoding for encrypted output |
| `os` | Environment variable reading |
| `time` | Timestamps |
| `strings`, `fmt`, `errors` | General utilities |

### Dev/Test Dependencies

| Module | Purpose |
|--------|---------|
| `github.com/stretchr/testify` (optional) | Test assertions — or use stdlib `testing` only |

> **Decision**: Use stdlib `testing` only for Phase 1 to keep dependencies minimal. We can add testify later if desired.

---

## 2. Implementation Steps

### Step 1: Go Module & Project Scaffolding

**Goal**: Initialize the Go module and create the directory tree.

#### Files to Create

```
go.mod                          # Module declaration
cmd/api/main.go                 # API server entrypoint (placeholder)
internal/config/config.go       # Configuration struct + loader
internal/config/config_test.go
internal/database/sqlite.go     # SQLite connection + pragmas
internal/database/sqlite_test.go
internal/database/migrate.go    # Migration runner
internal/database/migrate_test.go
internal/models/models.go       # All model structs
internal/dto/dto.go             # All DTO structs (later split if needed)
internal/dto/validation.go      # Custom validator setup
internal/repository/repository.go        # Repository interface registry
internal/repository/user.go
internal/repository/user_test.go
internal/repository/session.go
internal/repository/session_test.go
internal/repository/project.go
internal/repository/project_test.go
internal/repository/deployment.go
internal/repository/deployment_test.go
internal/repository/domain.go
internal/repository/domain_test.go
internal/repository/envvar.go
internal/repository/envvar_test.go
internal/repository/notification.go
internal/repository/notification_test.go
internal/repository/activity.go
internal/repository/activity_test.go
internal/repository/settings.go
internal/repository/settings_test.go
internal/api/server.go          # Echo server bootstrap
internal/api/server_test.go
internal/api/handlers/health.go # Health check handler
internal/api/handlers/health_test.go
internal/api/middleware/logger.go     # Request logging middleware
internal/api/middleware/recovery.go   # Panic recovery
internal/api/middleware/requestid.go  # Request ID injection
internal/api/routes/routes.go        # Route registration
internal/errors/errors.go       # Custom error types
internal/errors/errors_test.go
internal/logger/logger.go       # slog setup
internal/logger/logger_test.go
internal/util/nanoid.go         # Nanoid generation
internal/util/nanoid_test.go
internal/util/encryption.go     # AES-256-GCM encryption
internal/util/encryption_test.go
migrations/001_initial.sql      # Full initial schema
```

#### Commands

```bash
cd /Users/vatsalpatel/Desktop/Projects/hostbox
go mod init github.com/vatsalpatel/hostbox
go get github.com/labstack/echo/v4
go get github.com/mattn/go-sqlite3
go get github.com/go-playground/validator/v10
go get github.com/golang-jwt/jwt/v5
go get github.com/matoous/go-nanoid/v2
go mod tidy
```

#### go.mod (expected)

```go
module github.com/vatsalpatel/hostbox

go 1.23

require (
    github.com/labstack/echo/v4 v4.12.0
    github.com/mattn/go-sqlite3 v1.14.24
    github.com/go-playground/validator/v10 v10.22.1
    github.com/golang-jwt/jwt/v5 v5.2.1
    github.com/matoous/go-nanoid/v2 v2.1.0
)
```

---

### Step 2: Configuration Loading

**File**: `internal/config/config.go`

**Goal**: Load all configuration from environment variables with sensible defaults. Validate required fields.

#### Config Struct

```go
package config

import (
    "errors"
    "fmt"
    "os"
    "strconv"
    "time"
)

type Config struct {
    // Server
    Host string // default: "0.0.0.0"
    Port int    // default: 8080

    // Database
    DatabasePath string // default: "/app/data/hostbox.db"

    // Security
    JWTSecret     string        // REQUIRED (min 32 chars)
    EncryptionKey string        // REQUIRED (exactly 32 bytes hex-encoded = 64 hex chars)
    AccessTokenTTL  time.Duration // default: 15m
    RefreshTokenTTL time.Duration // default: 168h (7 days)

    // Platform
    PlatformDomain string // REQUIRED (e.g., "hostbox.example.com")
    PlatformHTTPS  bool   // default: true
    PlatformName   string // default: "Hostbox"

    // GitHub App
    GitHubAppID         int64
    GitHubAppSlug       string
    GitHubAppPEM        string
    GitHubWebhookSecret string

    // SMTP (all optional)
    SMTPHost     string
    SMTPPort     int
    SMTPUser     string
    SMTPPass     string
    EmailFrom    string

    // Logging
    LogLevel  string // default: "info" (debug, info, warn, error)
    LogFormat string // default: "json" (json, text)

    // Paths
    DeploymentsDir string // default: "/app/deployments"
    LogsDir        string // default: "/app/logs"
    CacheDir       string // default: "/cache"

    // Caddy
    CaddyAdminURL string // default: "http://localhost:2019"

    // Limits
    MaxConcurrentBuilds int // default: 1
    MaxProjects         int // default: 50
}
```

#### Key Functions

```go
// Load reads configuration from environment variables and applies defaults.
// Returns an error if required fields are missing or invalid.
func Load() (*Config, error)

// getEnv reads an env var with a fallback default.
func getEnv(key, fallback string) string

// getEnvInt reads an env var as int with a fallback default.
func getEnvInt(key string, fallback int) int

// getEnvBool reads an env var as bool with a fallback default.
func getEnvBool(key string, fallback bool) bool

// getEnvDuration reads an env var as time.Duration with a fallback default.
func getEnvDuration(key string, fallback time.Duration) time.Duration

// Validate checks that all required fields are present and well-formed.
func (c *Config) Validate() error
```

#### Validation Rules

- `JWTSecret`: must be ≥ 32 characters
- `EncryptionKey`: must be exactly 64 hex characters (32 bytes when decoded)
- `PlatformDomain`: must not be empty, must not include protocol prefix
- `Port`: must be 1–65535
- `LogLevel`: must be one of `debug`, `info`, `warn`, `error`
- `DatabasePath`: must not be empty

#### Environment Variable Mapping

| Env Var | Config Field | Default |
|---------|-------------|---------|
| `HOST` | Host | `0.0.0.0` |
| `PORT` | Port | `8080` |
| `DATABASE_PATH` | DatabasePath | `/app/data/hostbox.db` |
| `JWT_SECRET` | JWTSecret | — (required) |
| `ENCRYPTION_KEY` | EncryptionKey | — (required) |
| `ACCESS_TOKEN_TTL` | AccessTokenTTL | `15m` |
| `REFRESH_TOKEN_TTL` | RefreshTokenTTL | `168h` |
| `PLATFORM_DOMAIN` | PlatformDomain | — (required) |
| `PLATFORM_HTTPS` | PlatformHTTPS | `true` |
| `PLATFORM_NAME` | PlatformName | `Hostbox` |
| `GITHUB_APP_ID` | GitHubAppID | `0` |
| `GITHUB_APP_SLUG` | GitHubAppSlug | `""` |
| `GITHUB_APP_PEM` | GitHubAppPEM | `""` |
| `GITHUB_WEBHOOK_SECRET` | GitHubWebhookSecret | `""` |
| `SMTP_HOST` | SMTPHost | `""` |
| `SMTP_PORT` | SMTPPort | `587` |
| `SMTP_USER` | SMTPUser | `""` |
| `SMTP_PASS` | SMTPPass | `""` |
| `EMAIL_FROM` | EmailFrom | `""` |
| `LOG_LEVEL` | LogLevel | `info` |
| `LOG_FORMAT` | LogFormat | `json` |
| `DEPLOYMENTS_DIR` | DeploymentsDir | `/app/deployments` |
| `LOGS_DIR` | LogsDir | `/app/logs` |
| `CACHE_DIR` | CacheDir | `/cache` |
| `CADDY_ADMIN_URL` | CaddyAdminURL | `http://localhost:2019` |
| `MAX_CONCURRENT_BUILDS` | MaxConcurrentBuilds | `1` |
| `MAX_PROJECTS` | MaxProjects | `50` |

#### Tests (`internal/config/config_test.go`)

- Test defaults are applied when no env vars set (except required ones)
- Test required fields cause error when missing
- Test validation rejects short JWT secret
- Test validation rejects bad encryption key
- Test all type conversions (int, bool, duration)

---

### Step 3: Logger Setup

**File**: `internal/logger/logger.go`

**Goal**: Configure `log/slog` with JSON output and dynamic log level.

#### Key Functions

```go
package logger

import (
    "log/slog"
    "os"
)

// Setup initializes the global slog logger.
// level: "debug", "info", "warn", "error"
// format: "json" or "text"
func Setup(level string, format string) *slog.Logger

// parseLevel converts a string log level to slog.Level.
func parseLevel(level string) slog.Level
```

#### Implementation Details

- Default output: `os.Stdout`
- JSON format uses `slog.NewJSONHandler`
- Text format uses `slog.NewTextHandler`
- Sets the logger as the default via `slog.SetDefault()`
- Returns the logger instance for dependency injection

#### Example Log Output (JSON)

```json
{"time":"2024-01-15T10:30:01Z","level":"INFO","msg":"server started","port":8080,"version":"1.0.0"}
{"time":"2024-01-15T10:30:02Z","level":"INFO","msg":"database connected","path":"/app/data/hostbox.db","wal_mode":true}
```

---

### Step 4: Custom Error Types

**File**: `internal/errors/errors.go`

**Goal**: Define `AppError` type used throughout the application for consistent API error responses.

#### Types

```go
package errors

import "net/http"

// Error codes (used in API responses)
const (
    CodeValidation   = "VALIDATION_ERROR"
    CodeUnauthorized = "UNAUTHORIZED"
    CodeForbidden    = "FORBIDDEN"
    CodeNotFound     = "NOT_FOUND"
    CodeConflict     = "CONFLICT"
    CodeRateLimited  = "RATE_LIMITED"
    CodeSetupRequired = "SETUP_REQUIRED"
    CodeInternal     = "INTERNAL_ERROR"
)

// FieldError represents a validation error on a specific field.
type FieldError struct {
    Field   string `json:"field"`
    Message string `json:"message"`
}

// AppError is the application's standard error type.
type AppError struct {
    Code       string       `json:"code"`
    Message    string       `json:"message"`
    Status     int          `json:"-"` // HTTP status code (not serialized)
    Details    []FieldError `json:"details,omitempty"`
    Internal   error        `json:"-"` // Wrapped internal error (not serialized)
}

// Error implements the error interface.
func (e *AppError) Error() string

// Unwrap returns the internal error for errors.Is / errors.As chains.
func (e *AppError) Unwrap() error

// --- Constructor functions ---

// NewValidationError creates a 400 error with field-level details.
func NewValidationError(message string, details []FieldError) *AppError

// NewUnauthorized creates a 401 error.
func NewUnauthorized(message string) *AppError

// NewForbidden creates a 403 error.
func NewForbidden(message string) *AppError

// NewNotFound creates a 404 error.
func NewNotFound(resource string) *AppError

// NewConflict creates a 409 error.
func NewConflict(message string) *AppError

// NewRateLimited creates a 429 error.
func NewRateLimited() *AppError

// NewSetupRequired creates a 503 error.
func NewSetupRequired() *AppError

// NewInternal creates a 500 error, wrapping the underlying cause.
func NewInternal(err error) *AppError

// ErrorResponse is the JSON envelope sent to clients.
type ErrorResponse struct {
    Error *AppError `json:"error"`
}
```

#### Tests (`internal/errors/errors_test.go`)

- Each constructor produces correct Code, Status, Message
- `Error()` returns a readable string
- `Unwrap()` returns internal error
- `AppError` satisfies `error` interface
- `errors.As` works with `*AppError`

---

### Step 5: Nanoid Utility

**File**: `internal/util/nanoid.go`

**Goal**: Centralize ID generation so all IDs are consistent.

#### Functions

```go
package util

import gonanoid "github.com/matoous/go-nanoid/v2"

const (
    // DefaultIDLength is the standard length for all entity IDs.
    DefaultIDLength = 21

    // ShortIDLength is used for deployment short hashes in preview URLs.
    ShortIDLength = 8
)

// NewID generates a nanoid of default length (21 chars).
// Uses the default alphabet: A-Za-z0-9_-
func NewID() string

// NewShortID generates a short nanoid (8 chars) for preview URL slugs.
func NewShortID() string
```

#### Tests (`internal/util/nanoid_test.go`)

- `NewID()` returns string of length 21
- `NewShortID()` returns string of length 8
- Generated IDs are URL-safe (only alphanumeric, `-`, `_`)
- Two calls produce different IDs (uniqueness smoke test)

---

### Step 6: Encryption Utility

**File**: `internal/util/encryption.go`

**Goal**: Encrypt/decrypt environment variable values using AES-256-GCM.

#### Functions

```go
package util

import (
    "crypto/aes"
    "crypto/cipher"
    "crypto/rand"
    "encoding/hex"
    "errors"
    "io"
)

// Encrypt encrypts plaintext using AES-256-GCM with the given hex-encoded key.
// Returns the hex-encoded ciphertext (nonce + ciphertext + tag).
// The nonce is prepended to the ciphertext for storage.
func Encrypt(plaintext string, hexKey string) (string, error)

// Decrypt decrypts a hex-encoded ciphertext using AES-256-GCM with the given hex-encoded key.
// Expects the nonce to be prepended to the ciphertext (as produced by Encrypt).
func Decrypt(ciphertextHex string, hexKey string) (string, error)

// deriveAESBlock creates an AES cipher block from a hex-encoded 32-byte key.
func deriveAESBlock(hexKey string) (cipher.Block, error)
```

#### Implementation Details

- Key: 32 bytes (64 hex chars) — decoded from hex
- Nonce: 12 bytes, generated via `crypto/rand`
- Output format: `hex(nonce + aesGCM.Seal(...))`
- Decryption extracts the first 12 bytes as nonce, remainder as ciphertext+tag

#### Tests (`internal/util/encryption_test.go`)

- Round-trip: encrypt then decrypt returns original plaintext
- Decrypt with wrong key returns error
- Decrypt with corrupted ciphertext returns error
- Decrypt with truncated input returns error
- Key must be exactly 64 hex chars (32 bytes)
- Empty plaintext encrypts and decrypts correctly
- Unicode plaintext works
- Two encryptions of the same plaintext produce different ciphertexts (unique nonce)

---

### Step 7: SQLite Database Setup

**File**: `internal/database/sqlite.go`

**Goal**: Open SQLite connection with WAL mode and recommended pragmas for performance/safety.

#### Functions

```go
package database

import (
    "database/sql"
    "fmt"
    "log/slog"

    _ "github.com/mattn/go-sqlite3"
)

// Open creates a new SQLite connection with WAL mode and recommended pragmas.
// path is the filesystem path to the database file (e.g., "/app/data/hostbox.db").
// It creates the parent directory if it doesn't exist.
func Open(path string) (*sql.DB, error)

// applyPragmas sets WAL mode and performance/safety pragmas.
func applyPragmas(db *sql.DB) error

// Close gracefully closes the database connection.
// Should be called via defer in main.
func Close(db *sql.DB) error
```

#### Pragmas (applied on every connection)

```sql
PRAGMA journal_mode = WAL;           -- Write-Ahead Logging for concurrent reads
PRAGMA busy_timeout = 5000;          -- Wait up to 5s for locks instead of failing
PRAGMA synchronous = NORMAL;         -- Good balance of safety and speed with WAL
PRAGMA cache_size = -20000;          -- 20MB page cache (negative = KB)
PRAGMA foreign_keys = ON;            -- Enforce foreign key constraints
PRAGMA temp_store = MEMORY;          -- Store temp tables in memory
PRAGMA mmap_size = 268435456;        -- 256MB memory-mapped I/O
```

#### Connection String

```
file:{path}?_journal_mode=WAL&_busy_timeout=5000&_foreign_keys=on
```

> **Note**: Some pragmas can be set via DSN query params, but we explicitly run them all via `applyPragmas` to be clear and ensure they're applied.

#### Pool Settings

```go
db.SetMaxOpenConns(1)       // SQLite only supports 1 writer; WAL allows concurrent reads via separate conns
db.SetMaxIdleConns(2)
db.SetConnMaxLifetime(0)    // No max lifetime
```

> **Important**: `MaxOpenConns(1)` prevents "database is locked" errors in WAL mode with a single writer. Reads can proceed concurrently through SQLite's WAL mechanism, but Go's `database/sql` pool serializes calls.

#### Tests (`internal/database/sqlite_test.go`)

- Opens a temporary in-memory database (`:memory:`)
- WAL mode is confirmed (`PRAGMA journal_mode` returns `wal` — note: in-memory DBs may return `memory`; test with temp file)
- Foreign keys are enabled (`PRAGMA foreign_keys` returns `1`)
- Basic read/write works
- Database file is created on disk if path specified

---

### Step 8: Migration System

**File**: `internal/database/migrate.go`

**Goal**: Embedded SQL migration runner with version tracking.

#### Schema Tracking Table

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    filename TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
```

#### Functions

```go
package database

import (
    "database/sql"
    "embed"
    "fmt"
    "log/slog"
    "sort"
    "strconv"
    "strings"
)

//go:embed ../../migrations/*.sql
// Note: The actual embed path will be in the package that does the embedding.
// We pass the FS in from cmd/api/main.go or a dedicated embed package.

// Migrate runs all pending SQL migrations in order.
// migrations is an embed.FS containing SQL files named like "001_initial.sql".
// Each file is executed in a transaction. Already-applied migrations are skipped.
func Migrate(db *sql.DB, migrations embed.FS) error

// getCurrentVersion returns the highest applied migration version, or 0 if none.
func getCurrentVersion(db *sql.DB) (int, error)

// parseMigrationVersion extracts the version number from a filename like "001_initial.sql".
func parseMigrationVersion(filename string) (int, error)

// ensureMigrationsTable creates the schema_migrations table if it doesn't exist.
func ensureMigrationsTable(db *sql.DB) error
```

#### Migration File Convention

- Files in `migrations/` directory
- Named: `{NNN}_{description}.sql` (e.g., `001_initial.sql`)
- NNN is zero-padded 3-digit version number
- Each file is run in a single transaction
- Files are executed in numeric order
- Already-applied versions (tracked in `schema_migrations`) are skipped

#### Embedding Strategy

The `embed.FS` is declared in a dedicated file close to the migrations directory, then passed down:

**File**: `internal/database/embed.go`

```go
package database

import "embed"

//go:embed migrations/*.sql
var MigrationsFS embed.FS
```

> **Alternative**: Since `//go:embed` paths are relative to the Go source file, and `internal/database/` is far from `migrations/`, we embed from `cmd/api/main.go` (which is at the project root level) and pass the `embed.FS` to `Migrate()`.

**Chosen approach**: Embed from a top-level package.

**File**: `migrations/embed.go`

```go
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
```

This keeps the embed declaration co-located with the SQL files. `internal/database/migrate.go` accepts `embed.FS` as a parameter.

#### Tests (`internal/database/migrate_test.go`)

- Applies migrations to a fresh database
- Running twice is idempotent (no errors, no duplicate applications)
- Migrations run in version order
- `schema_migrations` table records each applied migration
- Invalid SQL in a migration causes error and rolls back that migration

---

### Step 9: Database Schema (Migrations)

**File**: `migrations/001_initial.sql`

**Goal**: Create all tables from the spec in a single initial migration.

```sql
-- 001_initial.sql
-- Hostbox initial schema

-- Users
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0,
    email_verified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Sessions (refresh tokens)
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash TEXT NOT NULL,
    user_agent TEXT,
    ip_address TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

-- Projects
CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    github_repo TEXT,
    github_installation_id INTEGER,
    production_branch TEXT NOT NULL DEFAULT 'main',
    framework TEXT,
    build_command TEXT,
    install_command TEXT,
    output_directory TEXT,
    root_directory TEXT DEFAULT '/',
    node_version TEXT DEFAULT '20',
    auto_deploy INTEGER NOT NULL DEFAULT 1,
    preview_deployments INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX idx_projects_owner_id ON projects(owner_id);
CREATE INDEX idx_projects_github_repo ON projects(github_repo);

-- Deployments
CREATE TABLE deployments (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    commit_sha TEXT NOT NULL,
    commit_message TEXT,
    commit_author TEXT,
    branch TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    is_production INTEGER NOT NULL DEFAULT 0,
    deployment_url TEXT,
    artifact_path TEXT,
    artifact_size_bytes INTEGER,
    log_path TEXT,
    error_message TEXT,
    is_rollback INTEGER NOT NULL DEFAULT 0,
    rollback_source_id TEXT REFERENCES deployments(id),
    github_pr_number INTEGER,
    build_duration_ms INTEGER,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX idx_deployments_project_id ON deployments(project_id);
CREATE INDEX idx_deployments_project_status ON deployments(project_id, status);
CREATE INDEX idx_deployments_project_branch ON deployments(project_id, branch);
CREATE INDEX idx_deployments_created_at ON deployments(created_at);

-- Custom domains
CREATE TABLE domains (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    domain TEXT UNIQUE NOT NULL,
    verified INTEGER NOT NULL DEFAULT 0,
    verified_at TEXT,
    last_checked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX idx_domains_project_id ON domains(project_id);

-- Environment variables
CREATE TABLE env_vars (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    encrypted_value BLOB NOT NULL,
    is_secret INTEGER NOT NULL DEFAULT 0,
    scope TEXT NOT NULL DEFAULT 'all',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE(project_id, key, scope)
);
CREATE INDEX idx_env_vars_project_id ON env_vars(project_id);

-- Notification configurations
CREATE TABLE notification_configs (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    webhook_url TEXT NOT NULL,
    events TEXT NOT NULL DEFAULT 'all',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Activity log
CREATE TABLE activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX idx_activity_log_created_at ON activity_log(created_at);
CREATE INDEX idx_activity_log_resource ON activity_log(resource_type, resource_id);

-- Platform settings (key-value store)
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Default settings
INSERT INTO settings (key, value) VALUES
    ('setup_complete', 'false'),
    ('registration_enabled', 'false'),
    ('max_projects', '50'),
    ('max_deployments_per_project', '20'),
    ('artifact_retention_days', '30'),
    ('max_concurrent_builds', '1');
```

> **Note**: SQLite uses `INTEGER` for booleans (0/1). The Go model layer maps these to `bool`.

---

### Step 10: Model Structs

**File**: `internal/models/models.go`

**Goal**: Define Go structs that map 1:1 to database tables. These are internal types used by the repository and service layers.

```go
package models

import "time"

// --- User ---

type User struct {
    ID            string    `db:"id"`
    Email         string    `db:"email"`
    PasswordHash  string    `db:"password_hash"`
    DisplayName   *string   `db:"display_name"`    // nullable
    IsAdmin       bool      `db:"is_admin"`
    EmailVerified bool      `db:"email_verified"`
    CreatedAt     time.Time `db:"created_at"`
    UpdatedAt     time.Time `db:"updated_at"`
}

// --- Session ---

type Session struct {
    ID               string    `db:"id"`
    UserID           string    `db:"user_id"`
    RefreshTokenHash string    `db:"refresh_token_hash"`
    UserAgent        *string   `db:"user_agent"`       // nullable
    IPAddress        *string   `db:"ip_address"`       // nullable
    ExpiresAt        time.Time `db:"expires_at"`
    CreatedAt        time.Time `db:"created_at"`
}

// --- Project ---

type Project struct {
    ID                     string    `db:"id"`
    OwnerID                string    `db:"owner_id"`
    Name                   string    `db:"name"`
    Slug                   string    `db:"slug"`
    GitHubRepo             *string   `db:"github_repo"`              // nullable
    GitHubInstallationID   *int64    `db:"github_installation_id"`   // nullable
    ProductionBranch       string    `db:"production_branch"`
    Framework              *string   `db:"framework"`                // nullable
    BuildCommand           *string   `db:"build_command"`            // nullable
    InstallCommand         *string   `db:"install_command"`          // nullable
    OutputDirectory        *string   `db:"output_directory"`         // nullable
    RootDirectory          string    `db:"root_directory"`
    NodeVersion            string    `db:"node_version"`
    AutoDeploy             bool      `db:"auto_deploy"`
    PreviewDeployments     bool      `db:"preview_deployments"`
    CreatedAt              time.Time `db:"created_at"`
    UpdatedAt              time.Time `db:"updated_at"`
}

// --- Deployment ---

// DeploymentStatus represents the state of a deployment.
type DeploymentStatus string

const (
    DeploymentStatusQueued    DeploymentStatus = "queued"
    DeploymentStatusBuilding  DeploymentStatus = "building"
    DeploymentStatusReady     DeploymentStatus = "ready"
    DeploymentStatusFailed    DeploymentStatus = "failed"
    DeploymentStatusCancelled DeploymentStatus = "cancelled"
)

type Deployment struct {
    ID                string           `db:"id"`
    ProjectID         string           `db:"project_id"`
    CommitSHA         string           `db:"commit_sha"`
    CommitMessage     *string          `db:"commit_message"`         // nullable
    CommitAuthor      *string          `db:"commit_author"`          // nullable
    Branch            string           `db:"branch"`
    Status            DeploymentStatus `db:"status"`
    IsProduction      bool             `db:"is_production"`
    DeploymentURL     *string          `db:"deployment_url"`         // nullable
    ArtifactPath      *string          `db:"artifact_path"`          // nullable
    ArtifactSizeBytes *int64           `db:"artifact_size_bytes"`    // nullable
    LogPath           *string          `db:"log_path"`               // nullable
    ErrorMessage      *string          `db:"error_message"`          // nullable
    IsRollback        bool             `db:"is_rollback"`
    RollbackSourceID  *string          `db:"rollback_source_id"`     // nullable
    GitHubPRNumber    *int             `db:"github_pr_number"`       // nullable
    BuildDurationMs   *int64           `db:"build_duration_ms"`      // nullable
    StartedAt         *time.Time       `db:"started_at"`             // nullable
    CompletedAt       *time.Time       `db:"completed_at"`           // nullable
    CreatedAt         time.Time        `db:"created_at"`
}

// --- Domain ---

type Domain struct {
    ID            string     `db:"id"`
    ProjectID     string     `db:"project_id"`
    Domain        string     `db:"domain"`
    Verified      bool       `db:"verified"`
    VerifiedAt    *time.Time `db:"verified_at"`      // nullable
    LastCheckedAt *time.Time `db:"last_checked_at"`  // nullable
    CreatedAt     time.Time  `db:"created_at"`
}

// --- EnvVar ---

type EnvVar struct {
    ID             string    `db:"id"`
    ProjectID      string    `db:"project_id"`
    Key            string    `db:"key"`
    EncryptedValue []byte    `db:"encrypted_value"`
    IsSecret       bool      `db:"is_secret"`
    Scope          string    `db:"scope"`    // "all", "preview", "production"
    CreatedAt      time.Time `db:"created_at"`
    UpdatedAt      time.Time `db:"updated_at"`
}

// --- NotificationConfig ---

type NotificationConfig struct {
    ID         string    `db:"id"`
    ProjectID  *string   `db:"project_id"`   // nullable (NULL = global)
    Channel    string    `db:"channel"`       // "discord", "slack", "webhook"
    WebhookURL string    `db:"webhook_url"`
    Events     string    `db:"events"`        // comma-separated or "all"
    Enabled    bool      `db:"enabled"`
    CreatedAt  time.Time `db:"created_at"`
}

// --- ActivityLog ---

type ActivityLog struct {
    ID           int64     `db:"id"`            // AUTOINCREMENT
    UserID       *string   `db:"user_id"`       // nullable
    Action       string    `db:"action"`        // e.g., "deployment.created"
    ResourceType string    `db:"resource_type"` // e.g., "project"
    ResourceID   *string   `db:"resource_id"`   // nullable
    Metadata     *string   `db:"metadata"`      // JSON string, nullable
    CreatedAt    time.Time `db:"created_at"`
}

// --- Setting ---

type Setting struct {
    Key       string    `db:"key"`
    Value     string    `db:"value"`
    UpdatedAt time.Time `db:"updated_at"`
}
```

#### Time Parsing Note

SQLite stores timestamps as ISO 8601 text (`2024-01-15T10:30:01Z`). The repository layer must parse these with `time.Parse(time.RFC3339, ...)` when scanning rows. A helper function will be provided:

```go
// internal/models/helpers.go

// ParseTime parses an ISO 8601 timestamp string from SQLite.
func ParseTime(s string) (time.Time, error)

// FormatTime formats a time.Time as ISO 8601 for SQLite storage.
func FormatTime(t time.Time) string

// NullableString converts a *string to sql.NullString for queries.
func NullableString(s *string) sql.NullString

// NullableInt64 converts a *int64 to sql.NullInt64 for queries.
func NullableInt64(n *int64) sql.NullInt64

// NullableTime converts a *time.Time to sql.NullString for queries.
func NullableTime(t *time.Time) sql.NullString
```

---

### Step 11: DTO Structs

**File**: `internal/dto/dto.go`

**Goal**: Define request/response types with `validate` tags. These are the JSON shapes exposed via the API.

**File**: `internal/dto/validation.go`

**Goal**: Initialize `go-playground/validator` with custom validations.

#### Validation Setup

```go
package dto

import (
    "github.com/go-playground/validator/v10"
)

// NewValidator creates and configures a validator instance with custom rules.
func NewValidator() *validator.Validate

// ValidateStruct validates a struct and returns []FieldError if invalid.
func ValidateStruct(v *validator.Validate, s interface{}) []apperrors.FieldError

// Custom tag: "slug" — lowercase alphanumeric with hyphens, 1-63 chars
// Custom tag: "domain_name" — valid domain format
```

#### Request DTOs

```go
// --- Pagination ---

type PaginationQuery struct {
    Page    int `query:"page" validate:"omitempty,min=1"`
    PerPage int `query:"per_page" validate:"omitempty,min=1,max=100"`
}

// DefaultPage returns the page with defaults applied.
func (p PaginationQuery) PageOrDefault() int   // default: 1
func (p PaginationQuery) PerPageOrDefault() int // default: 20

// PaginationResponse is included in all list responses.
type PaginationResponse struct {
    Total      int `json:"total"`
    Page       int `json:"page"`
    PerPage    int `json:"per_page"`
    TotalPages int `json:"total_pages"`
}

// --- Auth ---

type RegisterRequest struct {
    Email       string  `json:"email" validate:"required,email,max=255"`
    Password    string  `json:"password" validate:"required,min=8,max=128"`
    DisplayName *string `json:"display_name" validate:"omitempty,min=1,max=100"`
}

type LoginRequest struct {
    Email    string `json:"email" validate:"required,email"`
    Password string `json:"password" validate:"required"`
}

type ForgotPasswordRequest struct {
    Email string `json:"email" validate:"required,email"`
}

type ResetPasswordRequest struct {
    Token       string `json:"token" validate:"required"`
    NewPassword string `json:"new_password" validate:"required,min=8,max=128"`
}

type UpdateProfileRequest struct {
    DisplayName *string `json:"display_name" validate:"omitempty,min=1,max=100"`
    Email       *string `json:"email" validate:"omitempty,email,max=255"`
}

type ChangePasswordRequest struct {
    CurrentPassword string `json:"current_password" validate:"required"`
    NewPassword     string `json:"new_password" validate:"required,min=8,max=128"`
}

// --- Projects ---

type CreateProjectRequest struct {
    Name            string  `json:"name" validate:"required,min=1,max=100"`
    GitHubRepo      *string `json:"github_repo" validate:"omitempty,max=200"`
    BuildCommand    *string `json:"build_command" validate:"omitempty,max=500"`
    InstallCommand  *string `json:"install_command" validate:"omitempty,max=500"`
    OutputDirectory *string `json:"output_directory" validate:"omitempty,max=200"`
    RootDirectory   *string `json:"root_directory" validate:"omitempty,max=200"`
    NodeVersion     *string `json:"node_version" validate:"omitempty,oneof=18 20 22"`
}

type UpdateProjectRequest struct {
    Name               *string `json:"name" validate:"omitempty,min=1,max=100"`
    BuildCommand       *string `json:"build_command" validate:"omitempty,max=500"`
    InstallCommand     *string `json:"install_command" validate:"omitempty,max=500"`
    OutputDirectory    *string `json:"output_directory" validate:"omitempty,max=200"`
    RootDirectory      *string `json:"root_directory" validate:"omitempty,max=200"`
    NodeVersion        *string `json:"node_version" validate:"omitempty,oneof=18 20 22"`
    ProductionBranch   *string `json:"production_branch" validate:"omitempty,min=1,max=200"`
    AutoDeploy         *bool   `json:"auto_deploy"`
    PreviewDeployments *bool   `json:"preview_deployments"`
}

// --- Deployments ---

type CreateDeploymentRequest struct {
    Branch    *string `json:"branch" validate:"omitempty,min=1,max=200"`
    CommitSHA *string `json:"commit_sha" validate:"omitempty,len=40"`
}

type ListDeploymentsQuery struct {
    PaginationQuery
    Status *string `query:"status" validate:"omitempty,oneof=queued building ready failed cancelled"`
    Branch *string `query:"branch" validate:"omitempty,min=1"`
}

// --- Domains ---

type CreateDomainRequest struct {
    Domain string `json:"domain" validate:"required,fqdn,max=253"`
}

// --- Env Vars ---

type CreateEnvVarRequest struct {
    Key      string  `json:"key" validate:"required,min=1,max=255"`
    Value    string  `json:"value" validate:"required"`
    IsSecret *bool   `json:"is_secret"`
    Scope    *string `json:"scope" validate:"omitempty,oneof=all preview production"`
}

type BulkEnvVarRequest struct {
    EnvVars []CreateEnvVarRequest `json:"env_vars" validate:"required,min=1,dive"`
}

type UpdateEnvVarRequest struct {
    Value    *string `json:"value"`
    IsSecret *bool   `json:"is_secret"`
    Scope    *string `json:"scope" validate:"omitempty,oneof=all preview production"`
}

// --- Notifications ---

type CreateNotificationRequest struct {
    Channel    string  `json:"channel" validate:"required,oneof=discord slack webhook"`
    WebhookURL string  `json:"webhook_url" validate:"required,url,max=500"`
    Events     *string `json:"events" validate:"omitempty,max=500"`
}

type UpdateNotificationRequest struct {
    WebhookURL *string `json:"webhook_url" validate:"omitempty,url,max=500"`
    Events     *string `json:"events" validate:"omitempty,max=500"`
    Enabled    *bool   `json:"enabled"`
}

// --- Admin ---

type UpdateSettingsRequest struct {
    RegistrationEnabled *bool `json:"registration_enabled"`
    MaxProjects         *int  `json:"max_projects" validate:"omitempty,min=1,max=10000"`
    MaxConcurrentBuilds *int  `json:"max_concurrent_builds" validate:"omitempty,min=1,max=10"`
    ArtifactRetentionDays *int `json:"artifact_retention_days" validate:"omitempty,min=1,max=365"`
}
```

#### Response DTOs

```go
// --- Generic ---

type SuccessResponse struct {
    Success bool `json:"success"`
}

// --- User ---

type UserResponse struct {
    ID            string  `json:"id"`
    Email         string  `json:"email"`
    DisplayName   *string `json:"display_name,omitempty"`
    IsAdmin       bool    `json:"is_admin"`
    EmailVerified bool    `json:"email_verified"`
    CreatedAt     string  `json:"created_at"`
    UpdatedAt     string  `json:"updated_at"`
}

type AuthResponse struct {
    User        UserResponse `json:"user"`
    AccessToken string       `json:"access_token"`
}

// --- Project ---

type ProjectResponse struct {
    ID                 string  `json:"id"`
    OwnerID            string  `json:"owner_id"`
    Name               string  `json:"name"`
    Slug               string  `json:"slug"`
    GitHubRepo         *string `json:"github_repo,omitempty"`
    ProductionBranch   string  `json:"production_branch"`
    Framework          *string `json:"framework,omitempty"`
    BuildCommand       *string `json:"build_command,omitempty"`
    InstallCommand     *string `json:"install_command,omitempty"`
    OutputDirectory    *string `json:"output_directory,omitempty"`
    RootDirectory      string  `json:"root_directory"`
    NodeVersion        string  `json:"node_version"`
    AutoDeploy         bool    `json:"auto_deploy"`
    PreviewDeployments bool    `json:"preview_deployments"`
    CreatedAt          string  `json:"created_at"`
    UpdatedAt          string  `json:"updated_at"`
}

type ProjectListResponse struct {
    Projects   []ProjectResponse  `json:"projects"`
    Pagination PaginationResponse `json:"pagination"`
}

// --- Deployment ---

type DeploymentResponse struct {
    ID                string  `json:"id"`
    ProjectID         string  `json:"project_id"`
    CommitSHA         string  `json:"commit_sha"`
    CommitMessage     *string `json:"commit_message,omitempty"`
    CommitAuthor      *string `json:"commit_author,omitempty"`
    Branch            string  `json:"branch"`
    Status            string  `json:"status"`
    IsProduction      bool    `json:"is_production"`
    DeploymentURL     *string `json:"deployment_url,omitempty"`
    ArtifactSizeBytes *int64  `json:"artifact_size_bytes,omitempty"`
    ErrorMessage      *string `json:"error_message,omitempty"`
    IsRollback        bool    `json:"is_rollback"`
    RollbackSourceID  *string `json:"rollback_source_id,omitempty"`
    GitHubPRNumber    *int    `json:"github_pr_number,omitempty"`
    BuildDurationMs   *int64  `json:"build_duration_ms,omitempty"`
    StartedAt         *string `json:"started_at,omitempty"`
    CompletedAt       *string `json:"completed_at,omitempty"`
    CreatedAt         string  `json:"created_at"`
}

type DeploymentListResponse struct {
    Deployments []DeploymentResponse `json:"deployments"`
    Pagination  PaginationResponse   `json:"pagination"`
}

// --- Domain ---

type DomainResponse struct {
    ID            string  `json:"id"`
    ProjectID     string  `json:"project_id"`
    Domain        string  `json:"domain"`
    Verified      bool    `json:"verified"`
    VerifiedAt    *string `json:"verified_at,omitempty"`
    LastCheckedAt *string `json:"last_checked_at,omitempty"`
    CreatedAt     string  `json:"created_at"`
}

// --- EnvVar ---

type EnvVarResponse struct {
    ID        string `json:"id"`
    ProjectID string `json:"project_id"`
    Key       string `json:"key"`
    Value     string `json:"value"`       // "••••••••" for secrets
    IsSecret  bool   `json:"is_secret"`
    Scope     string `json:"scope"`
    CreatedAt string `json:"created_at"`
    UpdatedAt string `json:"updated_at"`
}

// --- Notification ---

type NotificationConfigResponse struct {
    ID        string  `json:"id"`
    ProjectID *string `json:"project_id,omitempty"`
    Channel   string  `json:"channel"`
    Events    string  `json:"events"`
    Enabled   bool    `json:"enabled"`
    CreatedAt string  `json:"created_at"`
}

// --- Activity ---

type ActivityLogResponse struct {
    ID           int64   `json:"id"`
    UserID       *string `json:"user_id,omitempty"`
    Action       string  `json:"action"`
    ResourceType string  `json:"resource_type"`
    ResourceID   *string `json:"resource_id,omitempty"`
    Metadata     *string `json:"metadata,omitempty"`
    CreatedAt    string  `json:"created_at"`
}

type ActivityListResponse struct {
    Activities []ActivityLogResponse `json:"activities"`
    Pagination PaginationResponse    `json:"pagination"`
}

// --- Health ---

type HealthResponse struct {
    Status        string `json:"status"`
    Version       string `json:"version"`
    UptimeSeconds int64  `json:"uptime_seconds"`
}

// --- Settings ---

type SettingsResponse struct {
    SetupComplete       string `json:"setup_complete"`
    RegistrationEnabled string `json:"registration_enabled"`
    MaxProjects         string `json:"max_projects"`
    MaxDeploymentsPerProject string `json:"max_deployments_per_project"`
    ArtifactRetentionDays    string `json:"artifact_retention_days"`
    MaxConcurrentBuilds      string `json:"max_concurrent_builds"`
}
```

---

### Step 12: Repository Layer

**File structure**: One file per entity in `internal/repository/`

**Pattern**: Each repository is a struct that holds `*sql.DB` and exposes CRUD methods. A top-level `Repositories` struct aggregates all repos for dependency injection.

#### Repository Registry

**File**: `internal/repository/repository.go`

```go
package repository

import "database/sql"

// Repositories holds all repository instances.
// Passed as a single dependency to the service layer.
type Repositories struct {
    User         *UserRepository
    Session      *SessionRepository
    Project      *ProjectRepository
    Deployment   *DeploymentRepository
    Domain       *DomainRepository
    EnvVar       *EnvVarRepository
    Notification *NotificationRepository
    Activity     *ActivityRepository
    Settings     *SettingsRepository
}

// New creates all repository instances from a database connection.
func New(db *sql.DB) *Repositories
```

#### User Repository (`internal/repository/user.go`)

```go
type UserRepository struct {
    db *sql.DB
}

func NewUserRepository(db *sql.DB) *UserRepository

func (r *UserRepository) Create(ctx context.Context, user *models.User) error
func (r *UserRepository) GetByID(ctx context.Context, id string) (*models.User, error)
func (r *UserRepository) GetByEmail(ctx context.Context, email string) (*models.User, error)
func (r *UserRepository) Update(ctx context.Context, user *models.User) error
func (r *UserRepository) Delete(ctx context.Context, id string) error
func (r *UserRepository) List(ctx context.Context, page, perPage int) ([]models.User, int, error)
func (r *UserRepository) Count(ctx context.Context) (int, error)
func (r *UserRepository) UpdatePassword(ctx context.Context, id string, passwordHash string) error

// scanUser is a private helper that scans a *sql.Row or *sql.Rows into a models.User.
```

#### Session Repository (`internal/repository/session.go`)

```go
type SessionRepository struct {
    db *sql.DB
}

func NewSessionRepository(db *sql.DB) *SessionRepository

func (r *SessionRepository) Create(ctx context.Context, session *models.Session) error
func (r *SessionRepository) GetByID(ctx context.Context, id string) (*models.Session, error)
func (r *SessionRepository) DeleteByID(ctx context.Context, id string) error
func (r *SessionRepository) DeleteByUserID(ctx context.Context, userID string) (int64, error)
func (r *SessionRepository) DeleteExpired(ctx context.Context) (int64, error)
func (r *SessionRepository) ListByUserID(ctx context.Context, userID string) ([]models.Session, error)
```

#### Project Repository (`internal/repository/project.go`)

```go
type ProjectRepository struct {
    db *sql.DB
}

func NewProjectRepository(db *sql.DB) *ProjectRepository

func (r *ProjectRepository) Create(ctx context.Context, project *models.Project) error
func (r *ProjectRepository) GetByID(ctx context.Context, id string) (*models.Project, error)
func (r *ProjectRepository) GetBySlug(ctx context.Context, slug string) (*models.Project, error)
func (r *ProjectRepository) GetByGitHubRepo(ctx context.Context, repo string) (*models.Project, error)
func (r *ProjectRepository) Update(ctx context.Context, project *models.Project) error
func (r *ProjectRepository) Delete(ctx context.Context, id string) error
func (r *ProjectRepository) ListByOwner(ctx context.Context, ownerID string, page, perPage int, search string) ([]models.Project, int, error)
func (r *ProjectRepository) Count(ctx context.Context) (int, error)
func (r *ProjectRepository) CountByOwner(ctx context.Context, ownerID string) (int, error)
```

#### Deployment Repository (`internal/repository/deployment.go`)

```go
type DeploymentRepository struct {
    db *sql.DB
}

func NewDeploymentRepository(db *sql.DB) *DeploymentRepository

func (r *DeploymentRepository) Create(ctx context.Context, deployment *models.Deployment) error
func (r *DeploymentRepository) GetByID(ctx context.Context, id string) (*models.Deployment, error)
func (r *DeploymentRepository) Update(ctx context.Context, deployment *models.Deployment) error
func (r *DeploymentRepository) UpdateStatus(ctx context.Context, id string, status models.DeploymentStatus, errorMsg *string) error
func (r *DeploymentRepository) ListByProject(ctx context.Context, projectID string, page, perPage int, status, branch *string) ([]models.Deployment, int, error)
func (r *DeploymentRepository) GetLatestByProjectAndBranch(ctx context.Context, projectID, branch string) (*models.Deployment, error)
func (r *DeploymentRepository) GetActiveByProjectAndBranch(ctx context.Context, projectID, branch string) (*models.Deployment, error)
func (r *DeploymentRepository) CountByProject(ctx context.Context, projectID string) (int, error)
func (r *DeploymentRepository) CancelQueuedByProjectAndBranch(ctx context.Context, projectID, branch string) (int64, error)
```

#### Domain Repository (`internal/repository/domain.go`)

```go
type DomainRepository struct {
    db *sql.DB
}

func NewDomainRepository(db *sql.DB) *DomainRepository

func (r *DomainRepository) Create(ctx context.Context, domain *models.Domain) error
func (r *DomainRepository) GetByID(ctx context.Context, id string) (*models.Domain, error)
func (r *DomainRepository) GetByDomain(ctx context.Context, domain string) (*models.Domain, error)
func (r *DomainRepository) Delete(ctx context.Context, id string) error
func (r *DomainRepository) ListByProject(ctx context.Context, projectID string) ([]models.Domain, error)
func (r *DomainRepository) UpdateVerification(ctx context.Context, id string, verified bool, verifiedAt *time.Time) error
func (r *DomainRepository) UpdateLastChecked(ctx context.Context, id string, lastCheckedAt time.Time) error
func (r *DomainRepository) ListUnverified(ctx context.Context) ([]models.Domain, error)
```

#### EnvVar Repository (`internal/repository/envvar.go`)

```go
type EnvVarRepository struct {
    db *sql.DB
}

func NewEnvVarRepository(db *sql.DB) *EnvVarRepository

func (r *EnvVarRepository) Create(ctx context.Context, envVar *models.EnvVar) error
func (r *EnvVarRepository) GetByID(ctx context.Context, id string) (*models.EnvVar, error)
func (r *EnvVarRepository) Update(ctx context.Context, envVar *models.EnvVar) error
func (r *EnvVarRepository) Delete(ctx context.Context, id string) error
func (r *EnvVarRepository) ListByProject(ctx context.Context, projectID string) ([]models.EnvVar, error)
func (r *EnvVarRepository) ListByProjectAndScope(ctx context.Context, projectID string, scope string) ([]models.EnvVar, error)
func (r *EnvVarRepository) GetByProjectKeyScope(ctx context.Context, projectID, key, scope string) (*models.EnvVar, error)
func (r *EnvVarRepository) Upsert(ctx context.Context, envVar *models.EnvVar) error
```

#### Notification Repository (`internal/repository/notification.go`)

```go
type NotificationRepository struct {
    db *sql.DB
}

func NewNotificationRepository(db *sql.DB) *NotificationRepository

func (r *NotificationRepository) Create(ctx context.Context, config *models.NotificationConfig) error
func (r *NotificationRepository) GetByID(ctx context.Context, id string) (*models.NotificationConfig, error)
func (r *NotificationRepository) Update(ctx context.Context, config *models.NotificationConfig) error
func (r *NotificationRepository) Delete(ctx context.Context, id string) error
func (r *NotificationRepository) ListByProject(ctx context.Context, projectID string) ([]models.NotificationConfig, error)
func (r *NotificationRepository) ListGlobal(ctx context.Context) ([]models.NotificationConfig, error)
```

#### Activity Repository (`internal/repository/activity.go`)

```go
type ActivityRepository struct {
    db *sql.DB
}

func NewActivityRepository(db *sql.DB) *ActivityRepository

func (r *ActivityRepository) Create(ctx context.Context, entry *models.ActivityLog) error
func (r *ActivityRepository) List(ctx context.Context, page, perPage int, action, resourceType *string) ([]models.ActivityLog, int, error)
func (r *ActivityRepository) ListByResource(ctx context.Context, resourceType, resourceID string, page, perPage int) ([]models.ActivityLog, int, error)
```

#### Settings Repository (`internal/repository/settings.go`)

```go
type SettingsRepository struct {
    db *sql.DB
}

func NewSettingsRepository(db *sql.DB) *SettingsRepository

func (r *SettingsRepository) Get(ctx context.Context, key string) (string, error)
func (r *SettingsRepository) Set(ctx context.Context, key, value string) error
func (r *SettingsRepository) GetAll(ctx context.Context) (map[string]string, error)
func (r *SettingsRepository) GetBool(ctx context.Context, key string) (bool, error)
func (r *SettingsRepository) GetInt(ctx context.Context, key string) (int, error)
```

#### Repository Test Strategy

Each repository gets its own `_test.go` file. Tests:

1. Create an in-memory or temp-file SQLite database
2. Run migrations to set up schema
3. Test each method:
   - **Create**: insert and verify
   - **GetByID**: found vs. not found
   - **Update**: modify and verify change
   - **Delete**: delete and verify gone
   - **List**: pagination, filtering, count
4. Test foreign key constraints (e.g., deleting a user cascades projects)
5. Test unique constraints (e.g., duplicate email, duplicate slug)

#### Test Helper

**File**: `internal/repository/testhelper_test.go`

```go
// setupTestDB creates a temporary SQLite database with migrations applied.
// Returns the *sql.DB and a cleanup function.
func setupTestDB(t *testing.T) *sql.DB
```

---

### Step 13: HTTP Server Bootstrap

**File**: `internal/api/server.go`

**Goal**: Create and configure the Echo instance with middleware, error handling, and graceful shutdown.

```go
package api

import (
    "context"
    "database/sql"
    "fmt"
    "log/slog"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/labstack/echo/v4"
    echomiddleware "github.com/labstack/echo/v4/middleware"
    "github.com/go-playground/validator/v10"

    "github.com/vatsalpatel/hostbox/internal/config"
    "github.com/vatsalpatel/hostbox/internal/repository"
)

// Server holds the Echo instance and dependencies.
type Server struct {
    Echo       *echo.Echo
    Config     *config.Config
    DB         *sql.DB
    Repos      *repository.Repositories
    Validator  *validator.Validate
    Logger     *slog.Logger
    startTime  time.Time
}

// NewServer creates and configures the Echo HTTP server.
func NewServer(cfg *config.Config, db *sql.DB, repos *repository.Repositories, logger *slog.Logger) *Server

// Start begins listening for HTTP requests. Blocks until shutdown signal.
func (s *Server) Start() error

// Shutdown gracefully stops the server with a timeout.
func (s *Server) Shutdown(ctx context.Context) error
```

#### Middleware Stack (order matters)

```go
// Applied to all routes in order:
1. middleware.RequestID()     // Inject X-Request-ID header
2. middleware.Logger()        // slog-based request logging
3. middleware.Recovery()      // Panic recovery → 500 JSON error
4. echo.MiddlewareCORS()     // CORS (platform domain only)
5. echo.MiddlewareSecure()   // Security headers
```

#### Custom Error Handler

```go
// customErrorHandler converts Echo errors and AppErrors into consistent JSON responses.
func customErrorHandler(err error, c echo.Context)
```

Logic:
1. If error is `*AppError` → serialize as `{"error": {...}}`
2. If error is `*echo.HTTPError` → wrap in `AppError`
3. Otherwise → wrap as `INTERNAL_ERROR` (log the original error, return generic message)

#### Custom Validator Binding

```go
// echoValidator wraps go-playground/validator to satisfy echo.Validator interface.
type echoValidator struct {
    validator *validator.Validate
}

func (ev *echoValidator) Validate(i interface{}) error
```

#### Middleware Files

**File**: `internal/api/middleware/requestid.go`

```go
package middleware

// RequestID returns middleware that injects a unique request ID.
// Uses X-Request-ID from request header if present, otherwise generates a nanoid.
func RequestID() echo.MiddlewareFunc
```

**File**: `internal/api/middleware/logger.go`

```go
package middleware

// Logger returns middleware that logs each request with slog.
// Log fields: method, path, status, latency_ms, request_id, ip, user_agent
func Logger(logger *slog.Logger) echo.MiddlewareFunc
```

**File**: `internal/api/middleware/recovery.go`

```go
package middleware

// Recovery returns middleware that recovers from panics and returns a 500 JSON error.
// Logs the stack trace at ERROR level.
func Recovery(logger *slog.Logger) echo.MiddlewareFunc
```

---

### Step 14: Health Check Endpoint

**File**: `internal/api/handlers/health.go`

```go
package handlers

import (
    "net/http"
    "time"

    "github.com/labstack/echo/v4"
    "github.com/vatsalpatel/hostbox/internal/dto"
)

// HealthHandler handles the GET /api/v1/health endpoint.
type HealthHandler struct {
    startTime time.Time
    db        *sql.DB
}

func NewHealthHandler(startTime time.Time, db *sql.DB) *HealthHandler

// Health returns server health status.
// GET /api/v1/health
// Response: { "status": "ok", "version": "1.0.0", "uptime_seconds": 12345 }
func (h *HealthHandler) Health(c echo.Context) error
```

#### Implementation

- `status`: `"ok"` if SQLite is reachable (ping), `"degraded"` otherwise
- `version`: hardcoded constant (or from build ldflags)
- `uptime_seconds`: `time.Since(startTime).Seconds()`
- Also runs `db.PingContext(ctx)` to verify database connectivity

#### Route Registration

**File**: `internal/api/routes/routes.go`

```go
package routes

import (
    "github.com/labstack/echo/v4"
    "github.com/vatsalpatel/hostbox/internal/api/handlers"
)

// Register sets up all API routes on the Echo instance.
func Register(e *echo.Echo, health *handlers.HealthHandler) {
    api := e.Group("/api/v1")

    // Public routes (no auth)
    api.GET("/health", health.Health)

    // Future: auth routes, project routes, etc.
}
```

#### Version Constant

**File**: `internal/version/version.go`

```go
package version

// These are set at build time via ldflags:
//   go build -ldflags "-X github.com/vatsalpatel/hostbox/internal/version.Version=1.0.0"
var (
    Version   = "dev"
    GitCommit = "unknown"
    BuildTime = "unknown"
)
```

---

### Step 15: Main Entrypoint Wiring

**File**: `cmd/api/main.go`

**Goal**: Wire everything together: config → logger → database → migrations → repositories → server → start.

```go
package main

import (
    "log"
    "log/slog"
    "os"

    "github.com/vatsalpatel/hostbox/internal/api"
    "github.com/vatsalpatel/hostbox/internal/api/handlers"
    "github.com/vatsalpatel/hostbox/internal/api/routes"
    "github.com/vatsalpatel/hostbox/internal/config"
    "github.com/vatsalpatel/hostbox/internal/database"
    "github.com/vatsalpatel/hostbox/internal/logger"
    "github.com/vatsalpatel/hostbox/internal/repository"
    "github.com/vatsalpatel/hostbox/migrations"
)

func main() {
    // 1. Load configuration
    cfg, err := config.Load()
    if err != nil {
        log.Fatalf("failed to load config: %v", err)
    }

    // 2. Setup logger
    l := logger.Setup(cfg.LogLevel, cfg.LogFormat)
    slog.SetDefault(l)

    // 3. Open database
    db, err := database.Open(cfg.DatabasePath)
    if err != nil {
        l.Error("failed to open database", "error", err)
        os.Exit(1)
    }
    defer database.Close(db)

    // 4. Run migrations
    if err := database.Migrate(db, migrations.FS); err != nil {
        l.Error("failed to run migrations", "error", err)
        os.Exit(1)
    }

    // 5. Initialize repositories
    repos := repository.New(db)

    // 6. Create and start server
    srv := api.NewServer(cfg, db, repos, l)

    // 7. Register routes
    healthHandler := handlers.NewHealthHandler(srv.StartTime(), db)
    routes.Register(srv.Echo, healthHandler)

    // 8. Start server (blocks until shutdown signal)
    if err := srv.Start(); err != nil {
        l.Error("server error", "error", err)
        os.Exit(1)
    }
}
```

#### Startup Log Output

```
{"time":"2024-01-15T10:30:00Z","level":"INFO","msg":"loading configuration"}
{"time":"2024-01-15T10:30:00Z","level":"INFO","msg":"database connected","path":"/app/data/hostbox.db"}
{"time":"2024-01-15T10:30:00Z","level":"INFO","msg":"migrations applied","count":1}
{"time":"2024-01-15T10:30:00Z","level":"INFO","msg":"server starting","host":"0.0.0.0","port":8080,"version":"dev"}
```

#### Graceful Shutdown

The server listens for `SIGINT` and `SIGTERM`, then:
1. Stops accepting new connections
2. Waits up to 10 seconds for in-flight requests to finish
3. Closes the database connection
4. Exits cleanly

---

## 3. File Manifest

### New Files (55 total)

| # | Path | Purpose |
|---|------|---------|
| 1 | `go.mod` | Go module definition |
| 2 | `go.sum` | Dependency checksums (auto-generated) |
| 3 | `cmd/api/main.go` | API server entrypoint |
| 4 | `internal/config/config.go` | Configuration loading |
| 5 | `internal/config/config_test.go` | Config tests |
| 6 | `internal/logger/logger.go` | slog setup |
| 7 | `internal/logger/logger_test.go` | Logger tests |
| 8 | `internal/errors/errors.go` | Custom error types |
| 9 | `internal/errors/errors_test.go` | Error type tests |
| 10 | `internal/util/nanoid.go` | ID generation |
| 11 | `internal/util/nanoid_test.go` | Nanoid tests |
| 12 | `internal/util/encryption.go` | AES-256-GCM encryption |
| 13 | `internal/util/encryption_test.go` | Encryption tests |
| 14 | `internal/database/sqlite.go` | SQLite connection + pragmas |
| 15 | `internal/database/sqlite_test.go` | Database connection tests |
| 16 | `internal/database/migrate.go` | Migration runner |
| 17 | `internal/database/migrate_test.go` | Migration tests |
| 18 | `migrations/001_initial.sql` | Full initial database schema |
| 19 | `migrations/embed.go` | Embeds SQL files into binary |
| 20 | `internal/models/models.go` | All model structs |
| 21 | `internal/models/helpers.go` | Time parsing, nullable helpers |
| 22 | `internal/dto/dto.go` | All request/response DTOs |
| 23 | `internal/dto/validation.go` | Validator setup + custom rules |
| 24 | `internal/repository/repository.go` | Repository registry |
| 25 | `internal/repository/user.go` | User CRUD |
| 26 | `internal/repository/user_test.go` | User repo tests |
| 27 | `internal/repository/session.go` | Session CRUD |
| 28 | `internal/repository/session_test.go` | Session repo tests |
| 29 | `internal/repository/project.go` | Project CRUD |
| 30 | `internal/repository/project_test.go` | Project repo tests |
| 31 | `internal/repository/deployment.go` | Deployment CRUD |
| 32 | `internal/repository/deployment_test.go` | Deployment repo tests |
| 33 | `internal/repository/domain.go` | Domain CRUD |
| 34 | `internal/repository/domain_test.go` | Domain repo tests |
| 35 | `internal/repository/envvar.go` | EnvVar CRUD |
| 36 | `internal/repository/envvar_test.go` | EnvVar repo tests |
| 37 | `internal/repository/notification.go` | Notification CRUD |
| 38 | `internal/repository/notification_test.go` | Notification repo tests |
| 39 | `internal/repository/activity.go` | Activity log CRUD |
| 40 | `internal/repository/activity_test.go` | Activity repo tests |
| 41 | `internal/repository/settings.go` | Settings CRUD |
| 42 | `internal/repository/settings_test.go` | Settings repo tests |
| 43 | `internal/repository/testhelper_test.go` | Shared test setup helper |
| 44 | `internal/api/server.go` | Echo server setup + graceful shutdown |
| 45 | `internal/api/server_test.go` | Server tests |
| 46 | `internal/api/handlers/health.go` | Health check handler |
| 47 | `internal/api/handlers/health_test.go` | Health handler tests |
| 48 | `internal/api/middleware/requestid.go` | Request ID middleware |
| 49 | `internal/api/middleware/logger.go` | Request logging middleware |
| 50 | `internal/api/middleware/recovery.go` | Panic recovery middleware |
| 51 | `internal/api/routes/routes.go` | Route registration |
| 52 | `internal/version/version.go` | Version info (ldflags) |

### Modified Files

| # | Path | Change |
|---|------|--------|
| 1 | `.env.example` | Update to match new env var names (remove PostgreSQL, add SQLite path, encryption key) |

### Directories to Create

```
internal/config/
internal/logger/
internal/errors/
internal/util/
internal/database/
internal/api/handlers/
internal/api/middleware/
internal/api/routes/
internal/version/
```

> Note: `internal/models/`, `internal/dto/`, `internal/repository/` already exist (empty).

---

## 4. Testing Strategy

### Unit Tests

| Package | Test File | What's Tested |
|---------|-----------|---------------|
| `config` | `config_test.go` | Env var loading, defaults, validation |
| `logger` | `logger_test.go` | Log level parsing, handler creation |
| `errors` | `errors_test.go` | Error constructors, Error() string, Unwrap() |
| `util` | `nanoid_test.go` | ID length, uniqueness, URL safety |
| `util` | `encryption_test.go` | Encrypt/decrypt round-trip, wrong key, corruption |
| `database` | `sqlite_test.go` | Connection, pragmas, WAL mode |
| `database` | `migrate_test.go` | Migration ordering, idempotency, error handling |

### Integration Tests

| Package | Test File | What's Tested |
|---------|-----------|---------------|
| `repository` | `user_test.go` | Full CRUD against real SQLite |
| `repository` | `session_test.go` | Session lifecycle, expiry cleanup |
| `repository` | `project_test.go` | CRUD, slug uniqueness, cascade delete |
| `repository` | `deployment_test.go` | Status updates, listing with filters |
| `repository` | `domain_test.go` | CRUD, verification updates |
| `repository` | `envvar_test.go` | CRUD, upsert, scope filtering |
| `repository` | `notification_test.go` | CRUD, global vs. project-scoped |
| `repository` | `activity_test.go` | Log creation, listing with filters |
| `repository` | `settings_test.go` | Get/Set, default values from migration |
| `handlers` | `health_test.go` | HTTP 200, JSON body shape, uptime > 0 |

### Running Tests

```bash
# All tests
go test ./...

# With verbose output
go test -v ./...

# Specific package
go test -v ./internal/repository/...

# With race detector (recommended for CI)
go test -race ./...

# With coverage
go test -coverprofile=coverage.out ./...
go tool cover -html=coverage.out
```

### Test Conventions

- Use `t.TempDir()` for any file-based SQLite databases
- Use `t.Parallel()` where safe (not for tests sharing the same DB)
- Each repository test file uses `setupTestDB(t)` from `testhelper_test.go`
- No external dependencies needed (no Docker, no network)
- All tests must pass with `CGO_ENABLED=1` (required for go-sqlite3)

---

## 5. Definition of Done

Phase 1 is complete when **all** of the following are true:

### Build & Run
- [ ] `go build ./cmd/api` compiles without errors
- [ ] Binary starts and listens on configured port
- [ ] Server shuts down gracefully on SIGINT/SIGTERM
- [ ] Startup logs appear in structured JSON format

### Database
- [ ] SQLite database file is created at the configured path
- [ ] WAL mode is enabled (confirmed via PRAGMA query)
- [ ] All pragmas are applied (foreign_keys, busy_timeout, etc.)
- [ ] Migration system creates `schema_migrations` table
- [ ] `001_initial.sql` runs successfully and creates all 9 tables
- [ ] Running migrations a second time is a no-op (idempotent)
- [ ] Default settings are seeded into the `settings` table

### Health Check
- [ ] `GET /api/v1/health` returns `200 OK` with JSON body
- [ ] Response includes `status`, `version`, and `uptime_seconds`
- [ ] `status` is `"ok"` when database is healthy

### Error Handling
- [ ] Invalid routes return `404` as JSON `{"error": {"code": "NOT_FOUND", ...}}`
- [ ] Server panics are caught and return `500` as JSON
- [ ] All error responses follow the `{"error": {...}}` envelope

### Middleware
- [ ] Every response includes `X-Request-ID` header
- [ ] Request logs include method, path, status, latency, request_id

### Code Quality
- [ ] `go vet ./...` passes
- [ ] `go test ./...` passes (all tests green)
- [ ] `go test -race ./...` passes (no race conditions)
- [ ] No hardcoded secrets or credentials
- [ ] All SQL uses parameterized queries (no string concatenation)

### Encryption
- [ ] Encrypt/decrypt round-trip works with test data
- [ ] Wrong key produces an error, not corrupted data
- [ ] Unique nonces per encryption (two encryptions of same plaintext differ)

### Configuration
- [ ] Missing required env vars produce clear error messages
- [ ] All defaults work correctly when optional vars are unset
- [ ] Invalid values (bad port, short JWT secret) produce validation errors

---

## Appendix: Implementation Order & Dependencies

```
Step 1:  Go Module Setup           ← no dependencies
Step 2:  Config Loading            ← no dependencies
Step 3:  Logger Setup              ← no dependencies
Step 4:  Custom Error Types        ← no dependencies
Step 5:  Nanoid Utility            ← go-nanoid
Step 6:  Encryption Utility        ← crypto stdlib
Step 7:  SQLite Database Setup     ← go-sqlite3
Step 8:  Migration System          ← Step 7
Step 9:  Schema Migration File     ← Step 8
Step 10: Model Structs             ← no dependencies
Step 11: DTO Structs               ← go-playground/validator, Step 4
Step 12: Repository Layer          ← Steps 7, 8, 9, 10
Step 13: HTTP Server Bootstrap     ← echo, Steps 2, 3, 4, 11, 12
Step 14: Health Check Endpoint     ← Steps 7, 13
Step 15: Main Entrypoint           ← ALL previous steps
```

Steps 2–6 can be implemented in parallel (no inter-dependencies).
Steps 7–9 are sequential.
Steps 10–11 can be done in parallel with Steps 7–9.
Step 12 depends on Steps 7–10.
Steps 13–15 are sequential and depend on everything above.
