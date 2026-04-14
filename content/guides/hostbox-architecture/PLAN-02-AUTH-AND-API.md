# Phase 2: Authentication & Core API — Implementation Plan

> **Status**: Ready for implementation
> **Depends on**: Phase 1 (Foundation) — DB, models, repos, config, logger, crypto utils, HTTP server shell
> **Outcome**: Fully authenticated API with JWT auth, middleware stack, CRUD endpoints, rate limiting, and first-run setup

---

## Table of Contents

1. [Overview](#1-overview)
2. [File Inventory](#2-file-inventory)
3. [Step 1 — JWT & Token Utilities](#3-step-1--jwt--token-utilities)
4. [Step 2 — Auth Service](#4-step-2--auth-service)
5. [Step 3 — Auth Middleware](#5-step-3--auth-middleware)
6. [Step 4 — Security Middleware Stack](#6-step-4--security-middleware-stack)
7. [Step 5 — Auth Handlers & Routes](#7-step-5--auth-handlers--routes)
8. [Step 6 — First-Run Setup](#8-step-6--first-run-setup)
9. [Step 7 — Core CRUD Handlers](#9-step-7--core-crud-handlers)
10. [Step 8 — Admin Endpoints](#10-step-8--admin-endpoints)
11. [Step 9 — Request/Response DTOs](#11-step-9--requestresponse-dtos)
12. [Step 10 — Route Registration & Middleware Chain](#12-step-10--route-registration--middleware-chain)
13. [Step 11 — Error Handling](#13-step-11--error-handling)
14. [Step 12 — Testing](#14-step-12--testing)
15. [Definition of Done](#15-definition-of-done)

---

## 1. Overview

Phase 2 builds the authentication layer and all core API endpoints on top of the Phase 1 foundation (database, models, repositories, config, logger, crypto utilities, and the bare Echo server shell).

### What Phase 1 Already Provides

| Layer | Files | What's There |
|-------|-------|-------------|
| Config | `internal/config/config.go` | `Config` struct, env loading (`PLATFORM_DOMAIN`, `JWT_SECRET`, `ENCRYPTION_KEY`, `DATABASE_PATH`, SMTP, etc.) |
| Logger | `internal/logger/logger.go` | Structured JSON logger (zerolog), `InitLogger(level)`, request-scoped context |
| Database | `internal/repository/db.go` | SQLite connection (WAL mode, `MaxOpenConns=1`), migration runner |
| Models | `internal/models/*.go` | Go structs for `User`, `Session`, `Project`, `Deployment`, `Domain`, `EnvVar`, `NotificationConfig`, `ActivityLog`, `Setting` |
| Repositories | `internal/repository/*.go` | `UserRepo`, `SessionRepo`, `ProjectRepo`, `DeploymentRepo`, `DomainRepo`, `EnvVarRepo`, `ActivityLogRepo`, `SettingsRepo` with standard CRUD + list/pagination |
| Crypto | `internal/crypto/*.go` | `HashPassword`, `VerifyPassword` (bcrypt cost 12), `Encrypt`/`Decrypt` (AES-256-GCM), `GenerateToken` (crypto/rand), `GenerateNanoid` |
| Server Shell | `internal/api/server.go` | Echo instance creation, graceful shutdown, port binding |
| Migrations | `migrations/001_initial.sql` | Full schema for all 10 tables + indexes + default settings |

### What Phase 2 Adds

```
Authentication      → JWT signing/validation, login/register/refresh/logout flows
Auth Middleware      → Bearer token extraction, user context injection, admin check
Security Middleware  → Rate limiter, CORS, security headers, request ID, recovery
Auth Handlers        → 11 auth endpoints, 2 setup endpoints
CRUD Handlers        → Projects, Deployments, Domains, EnvVars, Admin
DTOs                 → ~30 request/response structs with validation tags
Route Registration   → Full route tree with middleware groups
Error Handling       → Typed AppError, global error handler, validation error mapping
Tests                → Unit tests for auth logic, integration tests for all endpoints
```

---

## 2. File Inventory

Every file created or modified in Phase 2, with full paths:

### New Files (24 files)

```
internal/
├── api/
│   ├── handlers/
│   │   ├── auth.go                  # Auth endpoints (login, register, refresh, logout, etc.)
│   │   ├── setup.go                 # First-run setup endpoints
│   │   ├── projects.go              # Project CRUD endpoints
│   │   ├── deployments.go           # Deployment list/get/create endpoints
│   │   ├── domains.go               # Domain CRUD + verify endpoints
│   │   ├── env_vars.go              # Environment variable CRUD endpoints
│   │   ├── admin.go                 # Admin stats, activity, settings endpoints
│   │   └── health.go                # GET /health (may already exist from Phase 1)
│   ├── middleware/
│   │   ├── auth.go                  # JWT extraction + validation + user context
│   │   ├── admin.go                 # Admin-only access check
│   │   ├── ratelimiter.go           # Token bucket rate limiter per IP/user
│   │   ├── cors.go                  # CORS restricted to PLATFORM_DOMAIN
│   │   ├── security_headers.go      # CSP, HSTS, X-Frame-Options, etc.
│   │   ├── request_id.go            # X-Request-ID generation
│   │   ├── recovery.go              # Panic recovery → JSON 500
│   │   └── logger.go                # Structured request/response logging
│   ├── routes/
│   │   └── routes.go                # Full route registration with groups
│   └── errors.go                    # AppError type, error codes, global error handler
├── dto/
│   ├── auth.go                      # Auth request/response DTOs
│   ├── projects.go                  # Project request/response DTOs
│   ├── deployments.go               # Deployment request/response DTOs
│   ├── domains.go                   # Domain request/response DTOs
│   ├── env_vars.go                  # EnvVar request/response DTOs
│   ├── admin.go                     # Admin request/response DTOs
│   ├── pagination.go                # Shared pagination types
│   └── validator.go                 # Custom validator registration
└── services/
    └── auth.go                      # AuthService (JWT, sessions, password reset)
```

### Test Files (8 files)

```
internal/
├── api/
│   ├── handlers/
│   │   ├── auth_test.go
│   │   ├── setup_test.go
│   │   ├── projects_test.go
│   │   ├── deployments_test.go
│   │   └── admin_test.go
│   └── middleware/
│       ├── auth_test.go
│       └── ratelimiter_test.go
└── services/
    └── auth_test.go
```

### Modified Files (2 files)

```
internal/api/server.go               # Wire up routes, middleware, validator, error handler
go.mod                                # Add new dependencies (if needed)
```

---

## 3. Step 1 — JWT & Token Utilities

### File: `internal/services/auth.go`

The JWT logic lives inside the AuthService. Phase 1's `internal/crypto/` already provides `GenerateToken(n int) string` (random bytes, base64url-encoded) and bcrypt helpers. The AuthService wraps these with JWT-specific logic.

### JWT Claims Structure

```go
// internal/services/auth.go

type JWTClaims struct {
    jwt.RegisteredClaims
    Email string `json:"email"`
    Admin bool   `json:"admin"`
}
```

**Fields**:
- `sub` (Subject) → user ID (nanoid), set via `RegisteredClaims.Subject`
- `email` → user's email address
- `admin` → boolean admin flag
- `iat` (IssuedAt) → `time.Now()`
- `exp` (ExpiresAt) → `time.Now().Add(15 * time.Minute)`

### Key Functions

```go
// GenerateAccessToken creates a signed HS256 JWT
// Returns: signed token string, error
func (s *AuthService) GenerateAccessToken(user *models.User) (string, error)

// ValidateAccessToken parses and validates a JWT string
// Returns: parsed claims, error (expired, invalid signature, malformed)
func (s *AuthService) ValidateAccessToken(tokenString string) (*JWTClaims, error)

// GenerateRefreshToken creates a random 32-byte token (base64url-encoded)
// Returns: raw token string (for cookie), SHA-256 hash (for DB storage)
func (s *AuthService) GenerateRefreshToken() (rawToken string, tokenHash string, error)
```

### Token Specifications

| Property | Access Token | Refresh Token |
|----------|-------------|---------------|
| Algorithm | HS256 | N/A (random bytes) |
| Length | Variable (JWT) | 32 bytes → base64url (43 chars) |
| Expiry | 15 minutes | 7 days |
| Storage (client) | Memory (JS variable) | httpOnly cookie |
| Storage (server) | Stateless (not stored) | SHA-256 hash in `sessions` table |
| Transport | `Authorization: Bearer <token>` | `Cookie: hostbox_refresh=<token>` |

### Refresh Token Cookie Specification

```go
cookie := &http.Cookie{
    Name:     "hostbox_refresh",
    Value:    rawRefreshToken,
    Path:     "/api/v1/auth",
    HttpOnly: true,
    Secure:   true,                    // HTTPS only
    SameSite: http.SameSiteStrictMode, // CSRF protection
    MaxAge:   7 * 24 * 60 * 60,        // 7 days in seconds
}
```

> **Note**: In development mode (`PLATFORM_HTTPS=false`), set `Secure: false` so cookies work over HTTP on localhost.

---

## 4. Step 2 — Auth Service

### File: `internal/services/auth.go`

### Struct Definition

```go
type AuthService struct {
    userRepo    repository.UserRepository
    sessionRepo repository.SessionRepository
    settingsRepo repository.SettingsRepository
    activityRepo repository.ActivityLogRepository
    jwtSecret   []byte
    config      *config.Config
    logger      *logger.Logger
}

func NewAuthService(
    userRepo    repository.UserRepository,
    sessionRepo repository.SessionRepository,
    settingsRepo repository.SettingsRepository,
    activityRepo repository.ActivityLogRepository,
    cfg         *config.Config,
    log         *logger.Logger,
) *AuthService
```

### Method Signatures

```go
// Register creates a new user account.
// - Checks if registration is enabled (settings: registration_enabled)
// - Validates email uniqueness
// - Hashes password with bcrypt cost 12
// - If SMTP not configured, auto-sets email_verified=true
// - Creates user in DB
// - Creates session (access + refresh tokens)
// - Logs activity: "user.registered"
// Returns: user, accessToken, rawRefreshToken, error
func (s *AuthService) Register(ctx context.Context, req *dto.RegisterRequest, userAgent, ip string) (*models.User, string, string, error)

// Login authenticates by email+password.
// - Looks up user by email
// - Verifies bcrypt hash
// - Creates new session in sessions table
// - Generates access token (JWT) + refresh token (random)
// - Logs activity: "user.login"
// Returns: user, accessToken, rawRefreshToken, error
func (s *AuthService) Login(ctx context.Context, req *dto.LoginRequest, userAgent, ip string) (*models.User, string, string, error)

// Refresh validates a refresh token and issues a new access token.
// - Computes SHA-256 of the raw refresh token
// - Looks up session by token hash
// - Verifies session not expired
// - Loads user from session.user_id
// - Generates new access token
// Returns: accessToken, error
func (s *AuthService) Refresh(ctx context.Context, rawRefreshToken string) (string, error)

// Logout invalidates a single session by deleting it from the sessions table.
// - Computes SHA-256 of the raw refresh token
// - Deletes session matching that hash
// - Logs activity: "user.logout"
func (s *AuthService) Logout(ctx context.Context, rawRefreshToken string) error

// LogoutAll invalidates all sessions for a user.
// - Deletes all rows in sessions where user_id = given ID
// - Logs activity: "user.logout_all"
// Returns: number of sessions revoked, error
func (s *AuthService) LogoutAll(ctx context.Context, userID string) (int, error)

// GetCurrentUser returns the user for the given ID (from JWT claims).
func (s *AuthService) GetCurrentUser(ctx context.Context, userID string) (*models.User, error)

// UpdateProfile updates the current user's display_name and/or email.
// - If email changes, requires current_password confirmation
// - Resets email_verified=false if email changes and SMTP configured
func (s *AuthService) UpdateProfile(ctx context.Context, userID string, req *dto.UpdateProfileRequest) (*models.User, error)

// ChangePassword updates the user's password.
// - Verifies current_password against stored hash
// - Hashes new_password with bcrypt cost 12
// - Updates password_hash in users table
// - Optionally: invalidate all other sessions (security best practice)
func (s *AuthService) ChangePassword(ctx context.Context, userID string, req *dto.ChangePasswordRequest) error

// ForgotPassword initiates password reset flow.
// - Looks up user by email (if not found, return nil error — prevent email enumeration)
// - Generates reset token (random 32 bytes), stores SHA-256 hash in users table
//   (add reset_token_hash and reset_token_expires_at columns, or use a separate table)
// - If SMTP configured: sends reset email with link
// - Logs activity: "user.forgot_password"
func (s *AuthService) ForgotPassword(ctx context.Context, email string) error

// ResetPassword completes password reset.
// - Validates reset token (hash lookup + expiry check)
// - Updates password_hash
// - Clears reset token
// - Invalidates all existing sessions (force re-login)
// - Logs activity: "user.reset_password"
func (s *AuthService) ResetPassword(ctx context.Context, req *dto.ResetPasswordRequest) error

// VerifyEmail confirms a user's email address.
// - Validates verification token
// - Sets email_verified=true
// - Clears verification token
func (s *AuthService) VerifyEmail(ctx context.Context, token string) error

// CleanupExpiredSessions deletes all sessions where expires_at < now.
// Called by a background goroutine every hour.
// Returns: count of deleted sessions
func (s *AuthService) CleanupExpiredSessions(ctx context.Context) (int, error)
```

### Implementation Notes

**Password Reset Token Storage**: Add two columns to the `users` table (via a Phase 2 migration `migrations/002_password_reset.sql`):

```sql
-- migrations/002_password_reset.sql
ALTER TABLE users ADD COLUMN reset_token_hash TEXT;
ALTER TABLE users ADD COLUMN reset_token_expires_at TEXT;
ALTER TABLE users ADD COLUMN email_verification_token_hash TEXT;
```

**Session Cleanup Goroutine**: Started from `server.go` during server initialization:

```go
go func() {
    ticker := time.NewTicker(1 * time.Hour)
    defer ticker.Stop()
    for {
        select {
        case <-ticker.C:
            count, _ := authService.CleanupExpiredSessions(context.Background())
            if count > 0 {
                logger.Info("cleaned up expired sessions", "count", count)
            }
        case <-ctx.Done():
            return
        }
    }
}()
```

---

## 5. Step 3 — Auth Middleware

### File: `internal/api/middleware/auth.go`

### Context Key

```go
type contextKey string

const (
    UserContextKey contextKey = "user"
)
```

### JWT Auth Middleware

```go
// JWTAuth returns Echo middleware that:
// 1. Extracts Bearer token from Authorization header
// 2. Validates JWT signature (HS256) and expiry
// 3. Extracts claims (sub, email, admin)
// 4. Loads user from DB by claims.Subject (user ID)
// 5. Injects *models.User into echo.Context via c.Set("user", user)
//
// On failure: returns 401 JSON error
//
// Header format: Authorization: Bearer <token>
func JWTAuth(authService *services.AuthService) echo.MiddlewareFunc
```

**Request flow**:
```
Request with "Authorization: Bearer eyJhbG..."
  │
  ├─ Extract token after "Bearer "
  ├─ Call authService.ValidateAccessToken(token) → claims, err
  │   ├─ err != nil → 401 {"error": {"code": "UNAUTHORIZED", "message": "Invalid or expired token"}}
  │   └─ err == nil → continue
  ├─ Call authService.GetCurrentUser(ctx, claims.Subject) → user, err
  │   ├─ err != nil → 401 {"error": {"code": "UNAUTHORIZED", "message": "User not found"}}
  │   └─ err == nil → continue
  ├─ c.Set("user", user)
  └─ next(c)
```

### File: `internal/api/middleware/admin.go`

```go
// RequireAdmin returns Echo middleware that:
// 1. Reads user from context (set by JWTAuth middleware — MUST come after JWTAuth)
// 2. Checks user.IsAdmin == true
// 3. If not admin: returns 403 JSON error
func RequireAdmin() echo.MiddlewareFunc
```

### Helper: Extract User from Context

```go
// GetUser extracts the authenticated user from the Echo context.
// Returns nil if no user is set (i.e., unauthenticated route).
// Used by handlers: user := middleware.GetUser(c)
func GetUser(c echo.Context) *models.User {
    u, ok := c.Get("user").(*models.User)
    if !ok {
        return nil
    }
    return u
}
```

---

## 6. Step 4 — Security Middleware Stack

### 6.1 Rate Limiter

#### File: `internal/api/middleware/ratelimiter.go`

```go
// TokenBucket implements a per-key token bucket rate limiter.
type TokenBucket struct {
    tokens     float64
    maxTokens  float64
    refillRate float64   // tokens per second
    lastRefill time.Time
    mu         sync.Mutex
}

// RateLimiterConfig holds settings for a rate limiter instance.
type RateLimiterConfig struct {
    Rate  int // requests per minute
    Burst int // max burst size (usually same as Rate)
}

// RateLimiter stores token buckets per key (IP or user ID).
type RateLimiter struct {
    buckets sync.Map // map[string]*TokenBucket
    config  RateLimiterConfig
}

// NewRateLimiter creates a rate limiter with the given config.
func NewRateLimiter(cfg RateLimiterConfig) *RateLimiter

// Allow checks if a request from the given key is allowed.
// Returns: allowed bool, remaining int, resetTime time.Time
func (rl *RateLimiter) Allow(key string) (bool, int, time.Time)

// RateLimit returns Echo middleware using the given RateLimiter.
// Key extraction: keyFunc(c echo.Context) string
//
// On rate limit exceeded: returns 429 with:
//   {"error": {"code": "RATE_LIMITED", "message": "Too many requests"}}
// Headers set on EVERY response:
//   X-RateLimit-Limit: 10
//   X-RateLimit-Remaining: 7
//   X-RateLimit-Reset: 1705335300 (Unix timestamp)
func RateLimit(limiter *RateLimiter, keyFunc func(echo.Context) string) echo.MiddlewareFunc

// IPKeyFunc extracts the client IP for rate limiting.
// Uses c.RealIP() (respects X-Forwarded-For behind reverse proxy).
func IPKeyFunc(c echo.Context) string

// UserKeyFunc extracts the authenticated user ID for rate limiting.
// Falls back to IP if no user in context.
func UserKeyFunc(c echo.Context) string
```

**Rate limit tiers** (instantiated in route registration):

| Route Group | Key | Rate | Burst |
|-------------|-----|------|-------|
| `/api/v1/auth/*` | Client IP | 10 req/min | 10 |
| `/api/v1/*` (authenticated) | User ID | 100 req/min | 100 |
| `/api/v1/github/webhook` | Client IP | 500 req/min | 500 |

**Stale bucket cleanup**: A background goroutine runs every 10 minutes, iterating `sync.Map` and deleting buckets that haven't been accessed in 10+ minutes.

### 6.2 CORS

#### File: `internal/api/middleware/cors.go`

```go
// CORS returns Echo middleware that restricts cross-origin requests to the platform domain.
//
// Allowed origin: https://{PLATFORM_DOMAIN} (or http:// if PLATFORM_HTTPS=false)
// Allowed methods: GET, POST, PATCH, PUT, DELETE, OPTIONS
// Allowed headers: Authorization, Content-Type, X-Request-ID
// Exposed headers: X-Request-ID, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset
// Max age: 86400 (24 hours)
// Credentials: true (needed for httpOnly cookie)
//
// NO wildcard origins. Requests from other origins get no Access-Control-Allow-Origin header.
func CORS(platformDomain string, useHTTPS bool) echo.MiddlewareFunc
```

**Example response headers**:
```
Access-Control-Allow-Origin: https://hostbox.example.com
Access-Control-Allow-Methods: GET, POST, PATCH, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Authorization, Content-Type, X-Request-ID
Access-Control-Allow-Credentials: true
Access-Control-Expose-Headers: X-Request-ID, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset
Access-Control-Max-Age: 86400
```

### 6.3 Security Headers

#### File: `internal/api/middleware/security_headers.go`

```go
// SecurityHeaders returns Echo middleware that sets security headers on all responses.
func SecurityHeaders() echo.MiddlewareFunc
```

**Headers applied**:

```
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'
```

> **Note**: The CSP may need adjustment for the embedded dashboard (e.g., if Vite injects inline scripts during development). This is the production default.

### 6.4 Request ID

#### File: `internal/api/middleware/request_id.go`

```go
// RequestID returns Echo middleware that:
// 1. Reads X-Request-ID from incoming request header (if present, reuse it)
// 2. If absent, generates a new nanoid (21 chars)
// 3. Sets X-Request-ID on the response header
// 4. Stores the request ID in echo.Context for use by logger and handlers
func RequestID() echo.MiddlewareFunc
```

### 6.5 Recovery

#### File: `internal/api/middleware/recovery.go`

```go
// Recovery returns Echo middleware that catches panics and returns a 500 JSON error.
//
// On panic:
// 1. Logs the panic with stack trace at ERROR level
// 2. Returns: {"error": {"code": "INTERNAL_ERROR", "message": "Internal server error"}}
// 3. Does NOT leak stack traces to the client
func Recovery(log *logger.Logger) echo.MiddlewareFunc
```

### 6.6 Request Logger

#### File: `internal/api/middleware/logger.go`

```go
// RequestLogger returns Echo middleware that logs each request/response as structured JSON.
//
// Log fields:
//   method, path, status, latency_ms, ip, user_agent, request_id, user_id (if authenticated),
//   bytes_in, bytes_out, error (if any)
//
// Log level:
//   - 5xx → ERROR
//   - 4xx → WARN
//   - 2xx/3xx → INFO
func RequestLogger(log *logger.Logger) echo.MiddlewareFunc
```

**Example log entry**:
```json
{
  "level": "info",
  "time": "2024-01-15T10:30:00Z",
  "method": "POST",
  "path": "/api/v1/auth/login",
  "status": 200,
  "latency_ms": 127,
  "ip": "192.168.1.1",
  "user_agent": "Mozilla/5.0...",
  "request_id": "abc123xyz",
  "bytes_in": 52,
  "bytes_out": 341
}
```

---

## 7. Step 5 — Auth Handlers & Routes

### File: `internal/api/handlers/auth.go`

### Struct

```go
type AuthHandler struct {
    authService *services.AuthService
    logger      *logger.Logger
}

func NewAuthHandler(authService *services.AuthService, log *logger.Logger) *AuthHandler
```

### Handler Methods

#### POST /api/v1/auth/register

```go
func (h *AuthHandler) Register(c echo.Context) error
```

**Request**:
```json
{
  "email": "user@example.com",
  "password": "securepass123",
  "display_name": "Jane Doe"
}
```

**Response (201)**:
```json
{
  "user": {
    "id": "u_abc123",
    "email": "user@example.com",
    "display_name": "Jane Doe",
    "is_admin": false,
    "email_verified": true,
    "created_at": "2024-01-15T10:30:00Z"
  },
  "access_token": "eyJhbGciOiJIUzI1NiIs..."
}
```

**Set-Cookie**: `hostbox_refresh=<token>; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`

**Error cases**:
- 400: validation error (missing fields, invalid email, password < 8 chars)
- 403: registration disabled (`{"error": {"code": "FORBIDDEN", "message": "Registration is disabled"}}`)
- 409: email already exists (`{"error": {"code": "CONFLICT", "message": "Email already registered"}}`)
- 503: setup not complete (`{"error": {"code": "SETUP_REQUIRED", "message": "Platform setup required"}}`)

#### POST /api/v1/auth/login

```go
func (h *AuthHandler) Login(c echo.Context) error
```

**Request**:
```json
{
  "email": "user@example.com",
  "password": "securepass123"
}
```

**Response (200)**:
```json
{
  "user": {
    "id": "u_abc123",
    "email": "user@example.com",
    "display_name": "Jane Doe",
    "is_admin": true,
    "email_verified": true,
    "created_at": "2024-01-15T10:30:00Z"
  },
  "access_token": "eyJhbGciOiJIUzI1NiIs..."
}
```

**Set-Cookie**: `hostbox_refresh=<token>; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`

**Error cases**:
- 400: validation error (missing fields)
- 401: invalid credentials (`{"error": {"code": "UNAUTHORIZED", "message": "Invalid email or password"}}`)
  - **Security**: same error for "email not found" and "wrong password" — no email enumeration
- 503: setup not complete

#### POST /api/v1/auth/refresh

```go
func (h *AuthHandler) Refresh(c echo.Context) error
```

**Request**: No body. Reads `hostbox_refresh` cookie automatically.

**Response (200)**:
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIs..."
}
```

**Error cases**:
- 401: missing cookie, invalid token, expired session

#### POST /api/v1/auth/logout

```go
func (h *AuthHandler) Logout(c echo.Context) error
```

**Request**: No body. Reads `hostbox_refresh` cookie. Requires valid access token (authenticated route).

**Response (200)**:
```json
{
  "success": true
}
```

**Clears Cookie**: `hostbox_refresh=; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict; Max-Age=0`

#### POST /api/v1/auth/logout-all

```go
func (h *AuthHandler) LogoutAll(c echo.Context) error
```

**Request**: No body. Requires valid access token.

**Response (200)**:
```json
{
  "success": true,
  "sessions_revoked": 3
}
```

**Clears Cookie**: same as logout.

#### GET /api/v1/auth/me

```go
func (h *AuthHandler) Me(c echo.Context) error
```

**Request**: No body. Requires valid access token.

**Response (200)**:
```json
{
  "user": {
    "id": "u_abc123",
    "email": "user@example.com",
    "display_name": "Jane Doe",
    "is_admin": true,
    "email_verified": true,
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T10:30:00Z"
  }
}
```

#### PATCH /api/v1/auth/me

```go
func (h *AuthHandler) UpdateProfile(c echo.Context) error
```

**Request**:
```json
{
  "display_name": "Jane D.",
  "email": "new@example.com",
  "current_password": "securepass123"
}
```

> `current_password` is required only if `email` is being changed.

**Response (200)**: Updated user object.

#### PUT /api/v1/auth/me/password

```go
func (h *AuthHandler) ChangePassword(c echo.Context) error
```

**Request**:
```json
{
  "current_password": "oldpass123",
  "new_password": "newsecurepass456"
}
```

**Response (200)**:
```json
{
  "success": true
}
```

**Error cases**:
- 400: new password too short
- 401: current password incorrect

#### POST /api/v1/auth/forgot-password

```go
func (h *AuthHandler) ForgotPassword(c echo.Context) error
```

**Request**:
```json
{
  "email": "user@example.com"
}
```

**Response (200)** — ALWAYS returns success, even if email not found (prevents enumeration):
```json
{
  "success": true,
  "message": "If an account with that email exists, a password reset link has been sent."
}
```

**Implementation**:
1. Look up user by email
2. If found AND SMTP configured: generate reset token, store hash, send email
3. If found AND no SMTP: log warning ("SMTP not configured, use CLI: hostbox admin reset-password")
4. If not found: do nothing, return success

#### POST /api/v1/auth/reset-password

```go
func (h *AuthHandler) ResetPassword(c echo.Context) error
```

**Request**:
```json
{
  "token": "base64url-encoded-reset-token",
  "new_password": "newsecurepass456"
}
```

**Response (200)**:
```json
{
  "success": true
}
```

**Error cases**:
- 400: invalid/expired token, password too short

#### POST /api/v1/auth/verify-email

```go
func (h *AuthHandler) VerifyEmail(c echo.Context) error
```

**Request**:
```json
{
  "token": "base64url-encoded-verification-token"
}
```

**Response (200)**:
```json
{
  "success": true
}
```

---

## 8. Step 6 — First-Run Setup

### File: `internal/api/handlers/setup.go`

### Struct

```go
type SetupHandler struct {
    authService    *services.AuthService
    settingsRepo   repository.SettingsRepository
    logger         *logger.Logger
}

func NewSetupHandler(
    authService  *services.AuthService,
    settingsRepo repository.SettingsRepository,
    log          *logger.Logger,
) *SetupHandler
```

### Handlers

#### GET /api/v1/setup/status

```go
func (h *SetupHandler) Status(c echo.Context) error
```

**Response (200)**:
```json
{
  "setup_required": true
}
```

**Logic**: Read `setup_complete` from settings table. If `"false"`, setup is required.

#### POST /api/v1/setup

```go
func (h *SetupHandler) Setup(c echo.Context) error
```

**Request**:
```json
{
  "email": "admin@example.com",
  "password": "secureadminpass",
  "display_name": "Admin User",
  "platform_domain": "hostbox.example.com"
}
```

**Response (201)**:
```json
{
  "user": {
    "id": "u_abc123",
    "email": "admin@example.com",
    "display_name": "Admin User",
    "is_admin": true,
    "email_verified": true,
    "created_at": "2024-01-15T10:30:00Z"
  },
  "access_token": "eyJhbGciOiJIUzI1NiIs..."
}
```

**Set-Cookie**: refresh token (same as login).

**Implementation**:
1. Check `setup_complete != "true"` — if already set up, return 403
2. Validate request body
3. Create user with `is_admin=true`, `email_verified=true`
4. Set settings: `setup_complete=true`, `registration_enabled=false`
5. Optionally update `platform_domain` setting
6. Generate access + refresh tokens
7. Log activity: `"system.setup_complete"`

**Error cases**:
- 403: setup already complete
- 400: validation errors

### Setup Guard Middleware

A lightweight check added to auth routes (register, login) to return 503 if setup is not complete:

```go
// RequireSetupComplete returns middleware that checks if initial setup is done.
// If not: returns 503 {"error": {"code": "SETUP_REQUIRED", "message": "Platform setup required"}}
// This prevents login/register from being called before the admin sets up the platform.
func RequireSetupComplete(settingsRepo repository.SettingsRepository) echo.MiddlewareFunc
```

---

## 9. Step 7 — Core CRUD Handlers

### 9.1 Projects

#### File: `internal/api/handlers/projects.go`

```go
type ProjectHandler struct {
    projectRepo  repository.ProjectRepository
    activityRepo repository.ActivityLogRepository
    logger       *logger.Logger
}

func NewProjectHandler(
    projectRepo  repository.ProjectRepository,
    activityRepo repository.ActivityLogRepository,
    log          *logger.Logger,
) *ProjectHandler
```

**Endpoints**:

| Method | Path | Handler | Auth | Notes |
|--------|------|---------|------|-------|
| POST | `/api/v1/projects` | `Create` | ✅ | Create new project |
| GET | `/api/v1/projects` | `List` | ✅ | List user's projects (paginated) |
| GET | `/api/v1/projects/:id` | `Get` | ✅ | Get project by ID |
| PATCH | `/api/v1/projects/:id` | `Update` | ✅ | Update project settings |
| DELETE | `/api/v1/projects/:id` | ✅ | Delete project (cascade) |

**Ownership check**: All project endpoints verify `project.OwnerID == currentUser.ID` (or user is admin). Implemented as a helper:

```go
func (h *ProjectHandler) getOwnedProject(c echo.Context) (*models.Project, error) {
    user := middleware.GetUser(c)
    project, err := h.projectRepo.GetByID(ctx, c.Param("id"))
    if err != nil { return nil, ErrNotFound }
    if project.OwnerID != user.ID && !user.IsAdmin {
        return nil, ErrForbidden
    }
    return project, nil
}
```

#### POST /api/v1/projects — Request/Response

**Request**:
```json
{
  "name": "My Portfolio",
  "github_repo": "janedoe/portfolio",
  "build_command": "npm run build",
  "install_command": "npm install",
  "output_directory": "dist",
  "root_directory": "/",
  "node_version": "20"
}
```

**Response (201)**:
```json
{
  "project": {
    "id": "p_xK9mQ2",
    "owner_id": "u_abc123",
    "name": "My Portfolio",
    "slug": "my-portfolio",
    "github_repo": "janedoe/portfolio",
    "production_branch": "main",
    "framework": null,
    "build_command": "npm run build",
    "install_command": "npm install",
    "output_directory": "dist",
    "root_directory": "/",
    "node_version": "20",
    "auto_deploy": true,
    "preview_deployments": true,
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T10:30:00Z"
  }
}
```

#### GET /api/v1/projects — Paginated List

**Request**: `GET /api/v1/projects?page=1&per_page=20&search=portfolio`

**Response (200)**:
```json
{
  "data": [
    {
      "id": "p_xK9mQ2",
      "name": "My Portfolio",
      "slug": "my-portfolio",
      "github_repo": "janedoe/portfolio",
      "framework": "vite",
      "created_at": "2024-01-15T10:30:00Z",
      "updated_at": "2024-01-15T10:30:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "per_page": 20,
    "total": 1,
    "total_pages": 1
  }
}
```

### 9.2 Deployments

#### File: `internal/api/handlers/deployments.go`

```go
type DeploymentHandler struct {
    deploymentRepo repository.DeploymentRepository
    projectRepo    repository.ProjectRepository
    activityRepo   repository.ActivityLogRepository
    logger         *logger.Logger
}

func NewDeploymentHandler(
    deploymentRepo repository.DeploymentRepository,
    projectRepo    repository.ProjectRepository,
    activityRepo   repository.ActivityLogRepository,
    log            *logger.Logger,
) *DeploymentHandler
```

**Endpoints**:

| Method | Path | Handler | Auth | Notes |
|--------|------|---------|------|-------|
| GET | `/api/v1/projects/:projectId/deployments` | `ListByProject` | ✅ | Paginated, filterable by status/branch |
| POST | `/api/v1/projects/:projectId/deployments` | `Create` | ✅ | Trigger manual deployment |
| GET | `/api/v1/deployments/:id` | `Get` | ✅ | Get deployment details |

> Note: `POST /deployments/:id/cancel`, `POST /deployments/:id/rollback`, and log endpoints are Phase 3 (Build System). Phase 2 creates the handler stubs and returns 501 Not Implemented.

#### POST /api/v1/projects/:projectId/deployments — Request/Response

**Request**:
```json
{
  "branch": "main",
  "commit_sha": "abc1234"
}
```

**Response (201)**:
```json
{
  "deployment": {
    "id": "d_zY8nR3",
    "project_id": "p_xK9mQ2",
    "commit_sha": "abc1234",
    "branch": "main",
    "status": "queued",
    "is_production": true,
    "created_at": "2024-01-15T10:35:00Z"
  }
}
```

#### GET /api/v1/projects/:projectId/deployments — Paginated List

**Request**: `GET /api/v1/projects/p_xK9mQ2/deployments?page=1&per_page=20&status=ready&branch=main`

**Response (200)**:
```json
{
  "data": [
    {
      "id": "d_zY8nR3",
      "project_id": "p_xK9mQ2",
      "commit_sha": "abc1234",
      "commit_message": "Update homepage",
      "branch": "main",
      "status": "ready",
      "is_production": true,
      "deployment_url": "https://my-portfolio-d_zY8nR3.hostbox.example.com",
      "build_duration_ms": 67000,
      "created_at": "2024-01-15T10:35:00Z",
      "completed_at": "2024-01-15T10:36:07Z"
    }
  ],
  "pagination": {
    "page": 1,
    "per_page": 20,
    "total": 12,
    "total_pages": 1
  }
}
```

### 9.3 Domains

#### File: `internal/api/handlers/domains.go`

```go
type DomainHandler struct {
    domainRepo   repository.DomainRepository
    projectRepo  repository.ProjectRepository
    activityRepo repository.ActivityLogRepository
    logger       *logger.Logger
}

func NewDomainHandler(
    domainRepo   repository.DomainRepository,
    projectRepo  repository.ProjectRepository,
    activityRepo repository.ActivityLogRepository,
    log          *logger.Logger,
) *DomainHandler
```

**Endpoints**:

| Method | Path | Handler | Auth | Notes |
|--------|------|---------|------|-------|
| POST | `/api/v1/projects/:projectId/domains` | `Create` | ✅ | Add custom domain |
| GET | `/api/v1/projects/:projectId/domains` | `ListByProject` | ✅ | List project domains |
| DELETE | `/api/v1/domains/:id` | `Delete` | ✅ | Remove domain |
| POST | `/api/v1/domains/:id/verify` | `Verify` | ✅ | Check DNS + trigger SSL |

#### POST /api/v1/projects/:projectId/domains — Request/Response

**Request**:
```json
{
  "domain": "portfolio.janedoe.com"
}
```

**Response (201)**:
```json
{
  "domain": {
    "id": "dm_aB3cD4",
    "project_id": "p_xK9mQ2",
    "domain": "portfolio.janedoe.com",
    "verified": false,
    "created_at": "2024-01-15T11:00:00Z"
  },
  "dns_instructions": {
    "type": "CNAME",
    "name": "portfolio",
    "value": "hostbox.example.com",
    "alternative": {
      "type": "A",
      "name": "@",
      "value": "203.0.113.1"
    }
  }
}
```

### 9.4 Environment Variables

#### File: `internal/api/handlers/env_vars.go`

```go
type EnvVarHandler struct {
    envVarRepo   repository.EnvVarRepository
    projectRepo  repository.ProjectRepository
    activityRepo repository.ActivityLogRepository
    logger       *logger.Logger
}

func NewEnvVarHandler(
    envVarRepo   repository.EnvVarRepository,
    projectRepo  repository.ProjectRepository,
    activityRepo repository.ActivityLogRepository,
    log          *logger.Logger,
) *EnvVarHandler
```

**Endpoints**:

| Method | Path | Handler | Auth | Notes |
|--------|------|---------|------|-------|
| POST | `/api/v1/projects/:projectId/env-vars` | `Create` | ✅ | Add env var |
| GET | `/api/v1/projects/:projectId/env-vars` | `ListByProject` | ✅ | List env vars (secrets masked) |
| POST | `/api/v1/projects/:projectId/env-vars/bulk` | `BulkCreate` | ✅ | Bulk import (.env paste) |
| PATCH | `/api/v1/env-vars/:id` | `Update` | ✅ | Update env var |
| DELETE | `/api/v1/env-vars/:id` | `Delete` | ✅ | Delete env var |

#### GET /api/v1/projects/:projectId/env-vars — Response

```json
{
  "data": [
    {
      "id": "ev_xY1z",
      "project_id": "p_xK9mQ2",
      "key": "API_KEY",
      "value": "••••••••",
      "is_secret": true,
      "scope": "all",
      "created_at": "2024-01-15T10:30:00Z",
      "updated_at": "2024-01-15T10:30:00Z"
    },
    {
      "id": "ev_aB2c",
      "project_id": "p_xK9mQ2",
      "key": "NODE_ENV",
      "value": "production",
      "is_secret": false,
      "scope": "production",
      "created_at": "2024-01-15T10:30:00Z",
      "updated_at": "2024-01-15T10:30:00Z"
    }
  ]
}
```

> **Note**: `is_secret=true` values are ALWAYS returned as `"••••••••"`, never the real value. Non-secret values are returned in plaintext.

---

## 10. Step 8 — Admin Endpoints

### File: `internal/api/handlers/admin.go`

```go
type AdminHandler struct {
    userRepo       repository.UserRepository
    projectRepo    repository.ProjectRepository
    deploymentRepo repository.DeploymentRepository
    activityRepo   repository.ActivityLogRepository
    settingsRepo   repository.SettingsRepository
    logger         *logger.Logger
}

func NewAdminHandler(
    userRepo       repository.UserRepository,
    projectRepo    repository.ProjectRepository,
    deploymentRepo repository.DeploymentRepository,
    activityRepo   repository.ActivityLogRepository,
    settingsRepo   repository.SettingsRepository,
    log            *logger.Logger,
) *AdminHandler
```

**Endpoints**:

| Method | Path | Handler | Auth | Admin | Notes |
|--------|------|---------|------|-------|-------|
| GET | `/api/v1/admin/stats` | `Stats` | ✅ | ✅ | System overview |
| GET | `/api/v1/admin/activity` | `Activity` | ✅ | ✅ | Activity log (paginated) |
| GET | `/api/v1/admin/users` | `Users` | ✅ | ✅ | All users |
| GET | `/api/v1/admin/settings` | `GetSettings` | ✅ | ✅ | Current settings |
| PUT | `/api/v1/admin/settings` | `UpdateSettings` | ✅ | ✅ | Update settings |

#### GET /api/v1/admin/stats — Response

```json
{
  "project_count": 12,
  "deployment_count": 156,
  "active_builds": 1,
  "user_count": 3,
  "disk_usage": {
    "deployments_bytes": 524288000,
    "logs_bytes": 10485760,
    "database_bytes": 2097152,
    "total_bytes": 536870912
  },
  "uptime_seconds": 86400
}
```

#### GET /api/v1/admin/activity — Request/Response

**Request**: `GET /api/v1/admin/activity?page=1&per_page=50&action=deployment.created&resource_type=deployment`

**Response (200)**:
```json
{
  "data": [
    {
      "id": 42,
      "user_id": "u_abc123",
      "action": "deployment.created",
      "resource_type": "deployment",
      "resource_id": "d_zY8nR3",
      "metadata": "{\"project_id\": \"p_xK9mQ2\", \"branch\": \"main\"}",
      "created_at": "2024-01-15T10:35:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "per_page": 50,
    "total": 156,
    "total_pages": 4
  }
}
```

#### PUT /api/v1/admin/settings — Request/Response

**Request**:
```json
{
  "registration_enabled": true,
  "max_projects": 100,
  "max_concurrent_builds": 2,
  "artifact_retention_days": 60
}
```

**Response (200)**:
```json
{
  "settings": {
    "setup_complete": "true",
    "registration_enabled": "true",
    "max_projects": "100",
    "max_deployments_per_project": "20",
    "artifact_retention_days": "60",
    "max_concurrent_builds": "2"
  }
}
```

---

## 11. Step 9 — Request/Response DTOs

### File: `internal/dto/auth.go`

```go
package dto

// --- Auth Requests ---

type RegisterRequest struct {
    Email       string `json:"email" validate:"required,email,max=255"`
    Password    string `json:"password" validate:"required,min=8,max=128"`
    DisplayName string `json:"display_name" validate:"omitempty,max=100"`
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

type VerifyEmailRequest struct {
    Token string `json:"token" validate:"required"`
}

type UpdateProfileRequest struct {
    DisplayName     *string `json:"display_name" validate:"omitempty,max=100"`
    Email           *string `json:"email" validate:"omitempty,email,max=255"`
    CurrentPassword *string `json:"current_password" validate:"omitempty"`
}

type ChangePasswordRequest struct {
    CurrentPassword string `json:"current_password" validate:"required"`
    NewPassword     string `json:"new_password" validate:"required,min=8,max=128"`
}

// --- Auth Responses ---

type AuthResponse struct {
    User        UserResponse `json:"user"`
    AccessToken string       `json:"access_token"`
}

type UserResponse struct {
    ID            string `json:"id"`
    Email         string `json:"email"`
    DisplayName   string `json:"display_name"`
    IsAdmin       bool   `json:"is_admin"`
    EmailVerified bool   `json:"email_verified"`
    CreatedAt     string `json:"created_at"`
    UpdatedAt     string `json:"updated_at,omitempty"`
}

type TokenResponse struct {
    AccessToken string `json:"access_token"`
}

type SuccessResponse struct {
    Success bool   `json:"success"`
    Message string `json:"message,omitempty"`
}

type LogoutAllResponse struct {
    Success         bool `json:"success"`
    SessionsRevoked int  `json:"sessions_revoked"`
}
```

### File: `internal/dto/projects.go`

```go
package dto

type CreateProjectRequest struct {
    Name            string  `json:"name" validate:"required,min=1,max=100"`
    GitHubRepo      *string `json:"github_repo" validate:"omitempty,github_repo"`
    BuildCommand    *string `json:"build_command" validate:"omitempty,max=500"`
    InstallCommand  *string `json:"install_command" validate:"omitempty,max=500"`
    OutputDirectory *string `json:"output_directory" validate:"omitempty,max=255"`
    RootDirectory   *string `json:"root_directory" validate:"omitempty,max=255"`
    NodeVersion     *string `json:"node_version" validate:"omitempty,oneof=18 20 22"`
}

type UpdateProjectRequest struct {
    Name                *string `json:"name" validate:"omitempty,min=1,max=100"`
    BuildCommand        *string `json:"build_command" validate:"omitempty,max=500"`
    InstallCommand      *string `json:"install_command" validate:"omitempty,max=500"`
    OutputDirectory     *string `json:"output_directory" validate:"omitempty,max=255"`
    RootDirectory       *string `json:"root_directory" validate:"omitempty,max=255"`
    NodeVersion         *string `json:"node_version" validate:"omitempty,oneof=18 20 22"`
    ProductionBranch    *string `json:"production_branch" validate:"omitempty,max=255"`
    AutoDeploy          *bool   `json:"auto_deploy"`
    PreviewDeployments  *bool   `json:"preview_deployments"`
}

type ProjectResponse struct {
    ID                  string  `json:"id"`
    OwnerID             string  `json:"owner_id"`
    Name                string  `json:"name"`
    Slug                string  `json:"slug"`
    GitHubRepo          *string `json:"github_repo"`
    ProductionBranch    string  `json:"production_branch"`
    Framework           *string `json:"framework"`
    BuildCommand        *string `json:"build_command"`
    InstallCommand      *string `json:"install_command"`
    OutputDirectory     *string `json:"output_directory"`
    RootDirectory       *string `json:"root_directory"`
    NodeVersion         string  `json:"node_version"`
    AutoDeploy          bool    `json:"auto_deploy"`
    PreviewDeployments  bool    `json:"preview_deployments"`
    CreatedAt           string  `json:"created_at"`
    UpdatedAt           string  `json:"updated_at"`
}
```

### File: `internal/dto/deployments.go`

```go
package dto

type CreateDeploymentRequest struct {
    Branch    *string `json:"branch" validate:"omitempty,max=255"`
    CommitSHA *string `json:"commit_sha" validate:"omitempty,max=40"`
}

type DeploymentResponse struct {
    ID              string  `json:"id"`
    ProjectID       string  `json:"project_id"`
    CommitSHA       string  `json:"commit_sha"`
    CommitMessage   *string `json:"commit_message"`
    CommitAuthor    *string `json:"commit_author"`
    Branch          string  `json:"branch"`
    Status          string  `json:"status"`
    IsProduction    bool    `json:"is_production"`
    DeploymentURL   *string `json:"deployment_url"`
    ArtifactSize    *int64  `json:"artifact_size_bytes"`
    ErrorMessage    *string `json:"error_message"`
    BuildDurationMs *int64  `json:"build_duration_ms"`
    StartedAt       *string `json:"started_at"`
    CompletedAt     *string `json:"completed_at"`
    CreatedAt       string  `json:"created_at"`
}

type DeploymentListFilters struct {
    Status string `query:"status" validate:"omitempty,oneof=queued building ready failed cancelled"`
    Branch string `query:"branch" validate:"omitempty,max=255"`
}
```

### File: `internal/dto/domains.go`

```go
package dto

type CreateDomainRequest struct {
    Domain string `json:"domain" validate:"required,fqdn,max=255"`
}

type DomainResponse struct {
    ID            string  `json:"id"`
    ProjectID     string  `json:"project_id"`
    Domain        string  `json:"domain"`
    Verified      bool    `json:"verified"`
    VerifiedAt    *string `json:"verified_at"`
    LastCheckedAt *string `json:"last_checked_at"`
    CreatedAt     string  `json:"created_at"`
}

type DNSInstructions struct {
    Type  string `json:"type"`
    Name  string `json:"name"`
    Value string `json:"value"`
}

type CreateDomainResponse struct {
    Domain          DomainResponse `json:"domain"`
    DNSInstructions DNSInstructions `json:"dns_instructions"`
}
```

### File: `internal/dto/env_vars.go`

```go
package dto

type CreateEnvVarRequest struct {
    Key      string `json:"key" validate:"required,min=1,max=255,env_key"`
    Value    string `json:"value" validate:"required,max=65535"`
    IsSecret *bool  `json:"is_secret"`
    Scope    string `json:"scope" validate:"omitempty,oneof=all preview production"`
}

type BulkCreateEnvVarRequest struct {
    EnvVars []CreateEnvVarRequest `json:"env_vars" validate:"required,min=1,dive"`
}

type UpdateEnvVarRequest struct {
    Value    *string `json:"value" validate:"omitempty,max=65535"`
    IsSecret *bool   `json:"is_secret"`
    Scope    *string `json:"scope" validate:"omitempty,oneof=all preview production"`
}

type EnvVarResponse struct {
    ID        string `json:"id"`
    ProjectID string `json:"project_id"`
    Key       string `json:"key"`
    Value     string `json:"value"`
    IsSecret  bool   `json:"is_secret"`
    Scope     string `json:"scope"`
    CreatedAt string `json:"created_at"`
    UpdatedAt string `json:"updated_at"`
}

type BulkCreateEnvVarResponse struct {
    EnvVars []EnvVarResponse `json:"env_vars"`
    Created int              `json:"created"`
    Updated int              `json:"updated"`
}
```

### File: `internal/dto/admin.go`

```go
package dto

type SetupRequest struct {
    Email          string `json:"email" validate:"required,email,max=255"`
    Password       string `json:"password" validate:"required,min=8,max=128"`
    DisplayName    string `json:"display_name" validate:"omitempty,max=100"`
    PlatformDomain string `json:"platform_domain" validate:"omitempty,fqdn,max=255"`
}

type SetupStatusResponse struct {
    SetupRequired bool `json:"setup_required"`
}

type AdminStatsResponse struct {
    ProjectCount    int64             `json:"project_count"`
    DeploymentCount int64             `json:"deployment_count"`
    ActiveBuilds    int64             `json:"active_builds"`
    UserCount       int64             `json:"user_count"`
    DiskUsage       DiskUsageResponse `json:"disk_usage"`
    UptimeSeconds   int64             `json:"uptime_seconds"`
}

type DiskUsageResponse struct {
    DeploymentsBytes int64 `json:"deployments_bytes"`
    LogsBytes        int64 `json:"logs_bytes"`
    DatabaseBytes    int64 `json:"database_bytes"`
    TotalBytes       int64 `json:"total_bytes"`
}

type UpdateSettingsRequest struct {
    RegistrationEnabled    *bool  `json:"registration_enabled"`
    MaxProjects            *int   `json:"max_projects" validate:"omitempty,min=1,max=10000"`
    MaxDeploymentsPerProject *int `json:"max_deployments_per_project" validate:"omitempty,min=1,max=1000"`
    MaxConcurrentBuilds    *int   `json:"max_concurrent_builds" validate:"omitempty,min=1,max=10"`
    ArtifactRetentionDays  *int   `json:"artifact_retention_days" validate:"omitempty,min=1,max=365"`
}

type SettingsResponse struct {
    Settings map[string]string `json:"settings"`
}
```

### File: `internal/dto/pagination.go`

```go
package dto

// PaginationParams are extracted from query parameters.
type PaginationParams struct {
    Page    int `query:"page" validate:"omitempty,min=1"`
    PerPage int `query:"per_page" validate:"omitempty,min=1,max=100"`
}

// Defaults applies default values if not set.
func (p *PaginationParams) Defaults() {
    if p.Page < 1 {
        p.Page = 1
    }
    if p.PerPage < 1 || p.PerPage > 100 {
        p.PerPage = 20
    }
}

// Offset returns the SQL OFFSET value.
func (p *PaginationParams) Offset() int {
    return (p.Page - 1) * p.PerPage
}

// PaginationResponse is included in all paginated API responses.
type PaginationResponse struct {
    Page       int `json:"page"`
    PerPage    int `json:"per_page"`
    Total      int `json:"total"`
    TotalPages int `json:"total_pages"`
}

// NewPaginationResponse calculates total_pages from total count.
func NewPaginationResponse(page, perPage, total int) PaginationResponse {
    totalPages := total / perPage
    if total%perPage > 0 {
        totalPages++
    }
    return PaginationResponse{
        Page:       page,
        PerPage:    perPage,
        Total:      total,
        TotalPages: totalPages,
    }
}

// PaginatedResponse wraps data with pagination metadata.
type PaginatedResponse struct {
    Data       interface{}        `json:"data"`
    Pagination PaginationResponse `json:"pagination"`
}
```

### File: `internal/dto/validator.go`

```go
package dto

import (
    "regexp"
    "github.com/go-playground/validator/v10"
)

// NewValidator creates a validator instance with custom rules registered.
func NewValidator() *validator.Validate {
    v := validator.New()

    // github_repo: matches "owner/repo" format
    v.RegisterValidation("github_repo", func(fl validator.FieldLevel) bool {
        matched, _ := regexp.MatchString(`^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$`, fl.Field().String())
        return matched
    })

    // env_key: valid environment variable name (uppercase letters, digits, underscores)
    v.RegisterValidation("env_key", func(fl validator.FieldLevel) bool {
        matched, _ := regexp.MatchString(`^[A-Za-z_][A-Za-z0-9_]*$`, fl.Field().String())
        return matched
    })

    return v
}

// CustomValidator wraps go-playground/validator for Echo's Validator interface.
type CustomValidator struct {
    Validator *validator.Validate
}

// Validate implements echo.Validator.
func (cv *CustomValidator) Validate(i interface{}) error {
    return cv.Validator.Struct(i)
}
```

---

## 12. Step 10 — Route Registration & Middleware Chain

### File: `internal/api/routes/routes.go`

```go
package routes

func Register(
    e *echo.Echo,
    cfg *config.Config,
    log *logger.Logger,
    authService *services.AuthService,
    settingsRepo repository.SettingsRepository,
    // ... other repos/services
    authHandler       *handlers.AuthHandler,
    setupHandler      *handlers.SetupHandler,
    projectHandler    *handlers.ProjectHandler,
    deploymentHandler *handlers.DeploymentHandler,
    domainHandler     *handlers.DomainHandler,
    envVarHandler     *handlers.EnvVarHandler,
    adminHandler      *handlers.AdminHandler,
    healthHandler     *handlers.HealthHandler,
)
```

### Complete Middleware Chain (order matters)

```
Echo Instance
│
├── Global Middleware (applied to ALL routes, in this order):
│   1. middleware.Recovery(log)              ← catches panics first
│   2. middleware.RequestID()                ← generates/propagates X-Request-ID
│   3. middleware.RequestLogger(log)         ← logs every request with request ID
│   4. middleware.CORS(cfg.Platform.Domain, cfg.Platform.HTTPS)
│   5. middleware.SecurityHeaders()          ← CSP, HSTS, X-Frame-Options, etc.
│
├── Custom Error Handler:
│   e.HTTPErrorHandler = errors.GlobalErrorHandler(log)
│
├── Validator:
│   e.Validator = &dto.CustomValidator{Validator: dto.NewValidator()}
│
├── Route Groups:
│   │
│   ├── /api/v1 (base group)
│   │   │
│   │   ├── Public (no auth, auth-rate-limit: 10/min per IP)
│   │   │   ├── GET  /health                        → healthHandler.Health
│   │   │   ├── GET  /setup/status                   → setupHandler.Status
│   │   │   ├── POST /setup                          → setupHandler.Setup
│   │   │   ├── POST /auth/register                  → authHandler.Register
│   │   │   ├── POST /auth/login                     → authHandler.Login
│   │   │   ├── POST /auth/refresh                   → authHandler.Refresh
│   │   │   ├── POST /auth/forgot-password           → authHandler.ForgotPassword
│   │   │   ├── POST /auth/reset-password            → authHandler.ResetPassword
│   │   │   └── POST /auth/verify-email              → authHandler.VerifyEmail
│   │   │
│   │   ├── Authenticated (JWT middleware, api-rate-limit: 100/min per user)
│   │   │   │
│   │   │   ├── Auth (user management)
│   │   │   │   ├── GET    /auth/me                  → authHandler.Me
│   │   │   │   ├── PATCH  /auth/me                  → authHandler.UpdateProfile
│   │   │   │   ├── PUT    /auth/me/password          → authHandler.ChangePassword
│   │   │   │   ├── POST   /auth/logout              → authHandler.Logout
│   │   │   │   └── POST   /auth/logout-all          → authHandler.LogoutAll
│   │   │   │
│   │   │   ├── Projects
│   │   │   │   ├── POST   /projects                 → projectHandler.Create
│   │   │   │   ├── GET    /projects                 → projectHandler.List
│   │   │   │   ├── GET    /projects/:id             → projectHandler.Get
│   │   │   │   ├── PATCH  /projects/:id             → projectHandler.Update
│   │   │   │   └── DELETE /projects/:id             → projectHandler.Delete
│   │   │   │
│   │   │   ├── Deployments
│   │   │   │   ├── GET    /projects/:projectId/deployments → deploymentHandler.ListByProject
│   │   │   │   ├── POST   /projects/:projectId/deployments → deploymentHandler.Create
│   │   │   │   └── GET    /deployments/:id          → deploymentHandler.Get
│   │   │   │
│   │   │   ├── Domains
│   │   │   │   ├── POST   /projects/:projectId/domains → domainHandler.Create
│   │   │   │   ├── GET    /projects/:projectId/domains → domainHandler.ListByProject
│   │   │   │   ├── DELETE /domains/:id              → domainHandler.Delete
│   │   │   │   └── POST   /domains/:id/verify       → domainHandler.Verify
│   │   │   │
│   │   │   └── Environment Variables
│   │   │       ├── POST   /projects/:projectId/env-vars      → envVarHandler.Create
│   │   │       ├── GET    /projects/:projectId/env-vars      → envVarHandler.ListByProject
│   │   │       ├── POST   /projects/:projectId/env-vars/bulk → envVarHandler.BulkCreate
│   │   │       ├── PATCH  /env-vars/:id             → envVarHandler.Update
│   │   │       └── DELETE /env-vars/:id             → envVarHandler.Delete
│   │   │
│   │   └── Admin (JWT + Admin middleware)
│   │       ├── GET    /admin/stats                  → adminHandler.Stats
│   │       ├── GET    /admin/activity               → adminHandler.Activity
│   │       ├── GET    /admin/users                  → adminHandler.Users
│   │       ├── GET    /admin/settings               → adminHandler.GetSettings
│   │       └── PUT    /admin/settings               → adminHandler.UpdateSettings
│   │
│   └── Webhook (separate rate limit: 500/min per IP, no auth)
│       └── POST /api/v1/github/webhook              → (stub, Phase 3)
│
└── Static Files (SPA fallback, Phase 4)
    └── /* → embed.FS
```

### Route Registration Code Structure

```go
func Register(e *echo.Echo, ...) {
    // --- Global Middleware ---
    e.Use(middleware.Recovery(log))
    e.Use(middleware.RequestID())
    e.Use(middleware.RequestLogger(log))
    e.Use(middleware.CORS(cfg.Platform.Domain, cfg.Platform.HTTPS))
    e.Use(middleware.SecurityHeaders())

    // --- Error Handler ---
    e.HTTPErrorHandler = errors.GlobalErrorHandler(log)

    // --- Validator ---
    e.Validator = &dto.CustomValidator{Validator: dto.NewValidator()}

    // --- Rate Limiters ---
    authLimiter := middleware.NewRateLimiter(middleware.RateLimiterConfig{Rate: 10, Burst: 10})
    apiLimiter := middleware.NewRateLimiter(middleware.RateLimiterConfig{Rate: 100, Burst: 100})
    webhookLimiter := middleware.NewRateLimiter(middleware.RateLimiterConfig{Rate: 500, Burst: 500})

    // --- Base Group ---
    api := e.Group("/api/v1")

    // --- Public Routes ---
    pub := api.Group("")
    pub.Use(middleware.RateLimit(authLimiter, middleware.IPKeyFunc))

    pub.GET("/health", healthHandler.Health)
    pub.GET("/setup/status", setupHandler.Status)
    pub.POST("/setup", setupHandler.Setup)
    pub.POST("/auth/register", authHandler.Register)
    pub.POST("/auth/login", authHandler.Login)
    pub.POST("/auth/refresh", authHandler.Refresh)
    pub.POST("/auth/forgot-password", authHandler.ForgotPassword)
    pub.POST("/auth/reset-password", authHandler.ResetPassword)
    pub.POST("/auth/verify-email", authHandler.VerifyEmail)

    // --- Authenticated Routes ---
    authed := api.Group("")
    authed.Use(middleware.JWTAuth(authService))
    authed.Use(middleware.RateLimit(apiLimiter, middleware.UserKeyFunc))

    // Auth management
    authed.GET("/auth/me", authHandler.Me)
    authed.PATCH("/auth/me", authHandler.UpdateProfile)
    authed.PUT("/auth/me/password", authHandler.ChangePassword)
    authed.POST("/auth/logout", authHandler.Logout)
    authed.POST("/auth/logout-all", authHandler.LogoutAll)

    // Projects
    authed.POST("/projects", projectHandler.Create)
    authed.GET("/projects", projectHandler.List)
    authed.GET("/projects/:id", projectHandler.Get)
    authed.PATCH("/projects/:id", projectHandler.Update)
    authed.DELETE("/projects/:id", projectHandler.Delete)

    // Deployments
    authed.GET("/projects/:projectId/deployments", deploymentHandler.ListByProject)
    authed.POST("/projects/:projectId/deployments", deploymentHandler.Create)
    authed.GET("/deployments/:id", deploymentHandler.Get)

    // Domains
    authed.POST("/projects/:projectId/domains", domainHandler.Create)
    authed.GET("/projects/:projectId/domains", domainHandler.ListByProject)
    authed.DELETE("/domains/:id", domainHandler.Delete)
    authed.POST("/domains/:id/verify", domainHandler.Verify)

    // Env Vars
    authed.POST("/projects/:projectId/env-vars", envVarHandler.Create)
    authed.GET("/projects/:projectId/env-vars", envVarHandler.ListByProject)
    authed.POST("/projects/:projectId/env-vars/bulk", envVarHandler.BulkCreate)
    authed.PATCH("/env-vars/:id", envVarHandler.Update)
    authed.DELETE("/env-vars/:id", envVarHandler.Delete)

    // --- Admin Routes ---
    admin := api.Group("/admin")
    admin.Use(middleware.JWTAuth(authService))
    admin.Use(middleware.RequireAdmin())
    admin.Use(middleware.RateLimit(apiLimiter, middleware.UserKeyFunc))

    admin.GET("/stats", adminHandler.Stats)
    admin.GET("/activity", adminHandler.Activity)
    admin.GET("/users", adminHandler.Users)
    admin.GET("/settings", adminHandler.GetSettings)
    admin.PUT("/settings", adminHandler.UpdateSettings)

    // --- Webhook Route (stub for Phase 3) ---
    webhook := api.Group("")
    webhook.Use(middleware.RateLimit(webhookLimiter, middleware.IPKeyFunc))
    // webhook.POST("/github/webhook", githubHandler.HandleWebhook)
}
```

---

## 13. Step 11 — Error Handling

### File: `internal/api/errors.go`

```go
package api

// AppError is the standard error type returned by all service methods.
type AppError struct {
    Code    string       `json:"code"`
    Message string       `json:"message"`
    Status  int          `json:"-"` // HTTP status code (not serialized)
    Details []FieldError `json:"details,omitempty"`
}

type FieldError struct {
    Field   string `json:"field"`
    Message string `json:"message"`
}

func (e *AppError) Error() string {
    return e.Message
}

// --- Pre-defined Errors ---

var (
    ErrValidation     = &AppError{Code: "VALIDATION_ERROR", Message: "Invalid input", Status: 400}
    ErrUnauthorized   = &AppError{Code: "UNAUTHORIZED", Message: "Authentication required", Status: 401}
    ErrInvalidCreds   = &AppError{Code: "UNAUTHORIZED", Message: "Invalid email or password", Status: 401}
    ErrTokenExpired   = &AppError{Code: "UNAUTHORIZED", Message: "Token expired", Status: 401}
    ErrForbidden      = &AppError{Code: "FORBIDDEN", Message: "Insufficient permissions", Status: 403}
    ErrNotFound       = &AppError{Code: "NOT_FOUND", Message: "Resource not found", Status: 404}
    ErrConflict       = &AppError{Code: "CONFLICT", Message: "Resource already exists", Status: 409}
    ErrRateLimited    = &AppError{Code: "RATE_LIMITED", Message: "Too many requests", Status: 429}
    ErrSetupRequired  = &AppError{Code: "SETUP_REQUIRED", Message: "Platform setup required", Status: 503}
    ErrInternal       = &AppError{Code: "INTERNAL_ERROR", Message: "Internal server error", Status: 500}
    ErrRegDisabled    = &AppError{Code: "FORBIDDEN", Message: "Registration is disabled", Status: 403}
)

// NewValidationError creates a validation error with field-level details.
func NewValidationError(details []FieldError) *AppError {
    return &AppError{
        Code:    "VALIDATION_ERROR",
        Message: "Invalid input",
        Status:  400,
        Details: details,
    }
}

// --- Global Error Handler ---

// GlobalErrorHandler is assigned to e.HTTPErrorHandler.
// It normalizes all errors (Echo errors, AppErrors, validation errors) into the standard format:
//
//   {"error": {"code": "...", "message": "...", "details": [...]}}
//
// Handles:
// - *AppError → direct serialization
// - *echo.HTTPError → map to closest error code
// - validator.ValidationErrors → map to FieldError details
// - Any other error → 500 INTERNAL_ERROR (never expose internal details)
func GlobalErrorHandler(log *logger.Logger) func(err error, c echo.Context) {
    return func(err error, c echo.Context) {
        // ... implementation
    }
}
```

### Validation Error Mapping

When `go-playground/validator` returns errors, they are mapped to `FieldError` structs:

```go
// Example: validator returns errors for email and password fields
// Input that triggers this:
//   {"email": "not-an-email", "password": "short"}
//
// Mapped output:
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid input",
    "details": [
      {"field": "email", "message": "Must be a valid email address"},
      {"field": "password", "message": "Must be at least 8 characters"}
    ]
  }
}
```

**Validation tag → human-readable message mapping**:

| Tag | Message Template |
|-----|-----------------|
| `required` | `{field} is required` |
| `email` | `Must be a valid email address` |
| `min` | `Must be at least {param} characters` |
| `max` | `Must be at most {param} characters` |
| `oneof` | `Must be one of: {param}` |
| `fqdn` | `Must be a valid domain name` |
| `github_repo` | `Must be in owner/repo format` |

---

## 14. Step 12 — Testing

### Testing Strategy

| Layer | Type | Coverage Target | Tools |
|-------|------|----------------|-------|
| Auth Service | Unit | 90%+ | `testing`, `testify/assert` |
| Middleware | Unit | 85%+ | `testing`, `httptest`, `echo.NewContext` |
| Handlers | Integration | 80%+ | `testing`, `httptest`, in-memory SQLite |
| Full API | Integration | Key flows | `testing`, `httptest`, full middleware stack |

### Test Database Strategy

Each test suite creates a fresh in-memory SQLite database with migrations applied:

```go
func setupTestDB(t *testing.T) *sql.DB {
    db, err := sql.Open("sqlite3", ":memory:?_journal_mode=WAL")
    require.NoError(t, err)
    // Run migrations
    err = repository.RunMigrations(db)
    require.NoError(t, err)
    t.Cleanup(func() { db.Close() })
    return db
}
```

### File: `internal/services/auth_test.go`

**Unit tests for auth service** (24 tests):

```go
// JWT Generation & Validation
func TestGenerateAccessToken_ValidClaims(t *testing.T)
func TestGenerateAccessToken_ContainsEmail(t *testing.T)
func TestGenerateAccessToken_ContainsAdminFlag(t *testing.T)
func TestValidateAccessToken_ValidToken(t *testing.T)
func TestValidateAccessToken_ExpiredToken(t *testing.T)
func TestValidateAccessToken_InvalidSignature(t *testing.T)
func TestValidateAccessToken_MalformedToken(t *testing.T)

// Refresh Token
func TestGenerateRefreshToken_UniqueTokens(t *testing.T)
func TestGenerateRefreshToken_HashMatchesRaw(t *testing.T)

// Register
func TestRegister_Success(t *testing.T)
func TestRegister_DuplicateEmail(t *testing.T)
func TestRegister_RegistrationDisabled(t *testing.T)
func TestRegister_AutoVerifiesWithoutSMTP(t *testing.T)

// Login
func TestLogin_Success(t *testing.T)
func TestLogin_WrongPassword(t *testing.T)
func TestLogin_EmailNotFound(t *testing.T)
func TestLogin_CreatesSession(t *testing.T)

// Refresh
func TestRefresh_ValidToken(t *testing.T)
func TestRefresh_ExpiredSession(t *testing.T)
func TestRefresh_InvalidToken(t *testing.T)

// Logout
func TestLogout_RemovesSession(t *testing.T)
func TestLogoutAll_RemovesAllSessions(t *testing.T)

// Cleanup
func TestCleanupExpiredSessions_RemovesExpired(t *testing.T)
func TestCleanupExpiredSessions_KeepsActive(t *testing.T)
```

### File: `internal/api/middleware/auth_test.go`

**Unit tests for auth middleware** (8 tests):

```go
func TestJWTAuth_ValidToken(t *testing.T)
func TestJWTAuth_MissingHeader(t *testing.T)
func TestJWTAuth_InvalidFormat(t *testing.T)
func TestJWTAuth_ExpiredToken(t *testing.T)
func TestJWTAuth_UserNotFound(t *testing.T)
func TestJWTAuth_SetsUserInContext(t *testing.T)
func TestRequireAdmin_AdminUser(t *testing.T)
func TestRequireAdmin_NonAdminUser(t *testing.T)
```

### File: `internal/api/middleware/ratelimiter_test.go`

**Unit tests for rate limiter** (6 tests):

```go
func TestTokenBucket_AllowsWithinRate(t *testing.T)
func TestTokenBucket_BlocksOverRate(t *testing.T)
func TestTokenBucket_RefillsOverTime(t *testing.T)
func TestRateLimit_SetsHeaders(t *testing.T)
func TestRateLimit_Returns429OnExceed(t *testing.T)
func TestRateLimit_DifferentKeysIndependent(t *testing.T)
```

### File: `internal/api/handlers/auth_test.go`

**Integration tests for auth endpoints** (18 tests):

```go
// Setup helper: creates full Echo app with middleware, in-memory DB
func setupAuthTestServer(t *testing.T) (*echo.Echo, *services.AuthService)

// Register
func TestRegisterEndpoint_Success(t *testing.T)
func TestRegisterEndpoint_ValidationError(t *testing.T)
func TestRegisterEndpoint_DuplicateEmail(t *testing.T)
func TestRegisterEndpoint_SetsCookie(t *testing.T)
func TestRegisterEndpoint_DisabledRegistration(t *testing.T)

// Login
func TestLoginEndpoint_Success(t *testing.T)
func TestLoginEndpoint_InvalidCredentials(t *testing.T)
func TestLoginEndpoint_SetsCookie(t *testing.T)

// Refresh
func TestRefreshEndpoint_ValidCookie(t *testing.T)
func TestRefreshEndpoint_MissingCookie(t *testing.T)
func TestRefreshEndpoint_ExpiredSession(t *testing.T)

// Logout
func TestLogoutEndpoint_ClearsCookie(t *testing.T)
func TestLogoutEndpoint_InvalidatesSession(t *testing.T)
func TestLogoutAllEndpoint_InvalidatesAllSessions(t *testing.T)

// Me
func TestMeEndpoint_ReturnsCurrentUser(t *testing.T)
func TestMeEndpoint_Unauthenticated(t *testing.T)

// Password
func TestChangePasswordEndpoint_Success(t *testing.T)
func TestChangePasswordEndpoint_WrongCurrentPassword(t *testing.T)
```

### File: `internal/api/handlers/setup_test.go`

**Integration tests for setup** (6 tests):

```go
func TestSetupStatus_NotComplete(t *testing.T)
func TestSetupStatus_Complete(t *testing.T)
func TestSetup_CreatesAdminUser(t *testing.T)
func TestSetup_SetsRegistrationDisabled(t *testing.T)
func TestSetup_ReturnsTokens(t *testing.T)
func TestSetup_BlockedAfterComplete(t *testing.T)
```

### File: `internal/api/handlers/projects_test.go`

**Integration tests for projects** (10 tests):

```go
func TestCreateProject_Success(t *testing.T)
func TestCreateProject_ValidationError(t *testing.T)
func TestCreateProject_GeneratesSlug(t *testing.T)
func TestListProjects_Paginated(t *testing.T)
func TestListProjects_Search(t *testing.T)
func TestListProjects_OnlyOwnProjects(t *testing.T)
func TestGetProject_Success(t *testing.T)
func TestGetProject_NotOwner(t *testing.T)
func TestUpdateProject_Success(t *testing.T)
func TestDeleteProject_Success(t *testing.T)
```

### File: `internal/api/handlers/admin_test.go`

**Integration tests for admin** (6 tests):

```go
func TestAdminStats_AsAdmin(t *testing.T)
func TestAdminStats_AsNonAdmin(t *testing.T)
func TestAdminActivity_Paginated(t *testing.T)
func TestAdminSettings_GetSettings(t *testing.T)
func TestAdminSettings_UpdateSettings(t *testing.T)
func TestAdminUsers_ListAll(t *testing.T)
```

### File: `internal/api/handlers/deployments_test.go`

**Integration tests for deployments** (5 tests):

```go
func TestCreateDeployment_Success(t *testing.T)
func TestListDeployments_Paginated(t *testing.T)
func TestListDeployments_FilterByStatus(t *testing.T)
func TestGetDeployment_Success(t *testing.T)
func TestGetDeployment_NotOwner(t *testing.T)
```

### Running Tests

```bash
# All tests
go test ./internal/... -v -count=1

# Auth service unit tests only
go test ./internal/services/ -v -run TestLogin

# Integration tests only
go test ./internal/api/handlers/ -v -count=1

# With coverage
go test ./internal/... -coverprofile=coverage.out
go tool cover -html=coverage.out
```

---

## 15. Definition of Done

### Functional Requirements

- [ ] **Setup flow**: `GET /setup/status` returns `setup_required: true` on fresh install; `POST /setup` creates admin user, returns tokens, flips `setup_complete` to `"true"`. Subsequent calls to `POST /setup` return 403.
- [ ] **Register**: Creates user, returns access token + sets refresh cookie. Blocked when `registration_enabled=false`. Returns 409 on duplicate email.
- [ ] **Login**: Returns access token + refresh cookie for valid credentials. Returns 401 for wrong password or unknown email (same error message).
- [ ] **Refresh**: Reads `hostbox_refresh` cookie, validates against hashed sessions table, returns new access token. Returns 401 for invalid/expired token.
- [ ] **Logout**: Deletes session from DB, clears cookie. Logout-all deletes all user sessions.
- [ ] **Auth middleware**: Extracts Bearer token, validates JWT, injects user into context. Returns 401 for missing/invalid/expired token.
- [ ] **Admin middleware**: Checks `user.IsAdmin`. Returns 403 for non-admin users.
- [ ] **Project CRUD**: Create (with slug generation), list (paginated, owner-scoped), get, update, delete (with ownership check).
- [ ] **Deployment CRUD**: Create (inserts into DB with status=queued), list (paginated, filterable), get (with ownership check).
- [ ] **Domain CRUD**: Create (returns DNS instructions), list, delete, verify (stub that checks DNS).
- [ ] **EnvVar CRUD**: Create, list (secrets masked), bulk create, update, delete.
- [ ] **Admin endpoints**: Stats (counts + disk usage), activity log (paginated), users list, settings get/update.
- [ ] **Password reset**: Forgot-password sends email (if SMTP) or logs warning. Reset-password validates token + updates password.
- [ ] **Email verification**: Verify-email validates token + sets `email_verified=true`.

### Non-Functional Requirements

- [ ] **Rate limiting**: Auth endpoints ≤ 10/min per IP. API endpoints ≤ 100/min per user. Headers (`X-RateLimit-*`) set on every response.
- [ ] **CORS**: Only `PLATFORM_DOMAIN` origin allowed. Credentials enabled. No wildcards.
- [ ] **Security headers**: HSTS, CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy on all responses.
- [ ] **Request ID**: `X-Request-ID` generated (or forwarded) on every request/response.
- [ ] **Error format**: All errors follow `{"error": {"code": "...", "message": "...", "details": [...]}}`. No stack traces leaked.
- [ ] **Pagination**: All list endpoints return `{"data": [...], "pagination": {page, per_page, total, total_pages}}`.
- [ ] **Session cleanup**: Background goroutine deletes expired sessions every hour.

### Testing Requirements

- [ ] Auth service unit tests pass (24 tests)
- [ ] Middleware unit tests pass (14 tests)
- [ ] Handler integration tests pass (45 tests)
- [ ] `go vet ./...` — no issues
- [ ] `go build ./cmd/api` — compiles cleanly
- [ ] No race conditions: `go test -race ./internal/...`

### Code Quality

- [ ] All handler methods follow: bind → validate → service call → JSON response pattern
- [ ] No raw SQL string concatenation (parameterized queries only)
- [ ] Sensitive data never logged (passwords, tokens, secrets)
- [ ] Refresh tokens stored as SHA-256 hashes (never raw in DB)
- [ ] No `fmt.Println` — structured logging only

---

## Appendix A: Migration File

### `migrations/002_password_reset.sql`

```sql
-- Password reset tokens
ALTER TABLE users ADD COLUMN reset_token_hash TEXT;
ALTER TABLE users ADD COLUMN reset_token_expires_at TEXT;

-- Email verification tokens
ALTER TABLE users ADD COLUMN email_verification_token_hash TEXT;
ALTER TABLE users ADD COLUMN email_verification_token_expires_at TEXT;
```

---

## Appendix B: Go Dependencies

Phase 2 uses these packages (most should already be in `go.mod` from Phase 1):

```
github.com/labstack/echo/v4              # HTTP framework
github.com/golang-jwt/jwt/v5             # JWT signing/validation
github.com/go-playground/validator/v10   # Struct validation
golang.org/x/crypto                      # bcrypt (already in Phase 1)
github.com/stretchr/testify              # Test assertions
github.com/mattn/go-sqlite3              # SQLite driver (already in Phase 1)
```

If not already present, add with:
```bash
go get github.com/golang-jwt/jwt/v5
go get github.com/go-playground/validator/v10
go get github.com/stretchr/testify
```

---

## Appendix C: Implementation Order

Execute steps in this order to minimize blocked work:

```
Step 1:  JWT & Token Utilities        (no dependencies)
Step 2:  Auth Service                  (depends on Step 1 + Phase 1 repos)
Step 3:  Auth Middleware               (depends on Step 2)
Step 4:  Security Middleware Stack     (no dependencies, parallel with Steps 1-3)
Step 5:  Auth Handlers                 (depends on Steps 2, 3)
Step 6:  First-Run Setup               (depends on Steps 2, 5)
Step 7:  Core CRUD Handlers            (depends on Step 3 + Phase 1 repos)
Step 8:  Admin Endpoints               (depends on Steps 3, 4 middleware)
Step 9:  DTOs                          (parallel with Steps 5-8, needed before handlers compile)
Step 10: Route Registration            (depends on ALL handlers + ALL middleware)
Step 11: Error Handling                (parallel, but needed before handlers compile)
Step 12: Tests                         (after each step, not batched at end)
```

**Parallelizable**:
- Steps 1-3 (auth core) can be built in parallel with Step 4 (security middleware)
- Step 9 (DTOs) and Step 11 (errors) should be written first or alongside their consumers
- Tests should be written with each step (TDD or immediately after)

**Estimated effort**: ~2,500-3,000 lines of Go code + ~1,500 lines of tests.
