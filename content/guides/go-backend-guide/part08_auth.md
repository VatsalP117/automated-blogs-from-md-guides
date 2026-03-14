# Part 8 — Authentication & Authorization

> **Series:** The Definitive Go Backend Guide for Frontend Engineers
> **Prev:** [Part 7 — Concurrency](./part07_concurrency.md)
> **Next:** [Part 9 — Configuration & Secrets](./part09_config_secrets.md)

---

## Table of Contents

- [8A — JWT Authentication](#8a--jwt-authentication)
- [8B — OAuth2 & SSO](#8b--oauth2--sso)
- [8C — Authorization (RBAC & Policy-Based)](#8c--authorization)
- [8D — API Keys](#8d--api-keys)
- [8E — Full Auth Middleware Stack](#8e--full-auth-middleware-stack)

---

## 8A — JWT Authentication

### How JWT Actually Works

A JWT (JSON Web Token) is a compact, self-contained token that carries information about the user. It has three parts separated by dots:

```
eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyIsInJvbGUiOiJhZG1pbiIsImV4cCI6MTcwMH0.signature
│                     │                                                                   │
└── Header (base64)   └── Payload (base64)                                                └── Signature
```

**Header:** Algorithm used to sign the token (e.g., HS256, RS256).
**Payload:** Claims — data about the user (user ID, role, expiration).
**Signature:** Cryptographic proof that the token hasn't been tampered with.

**Why JWTs are used:** The server can verify a JWT without hitting a database. The signature proves the token was created by the server (or someone with the secret key). This makes authentication stateless.

### Generating and Signing JWTs

```go
package auth

import (
    "fmt"
    "time"

    "github.com/golang-jwt/jwt/v5"
)

type TokenPair struct {
    AccessToken  string `json:"access_token"`
    RefreshToken string `json:"refresh_token"`
    ExpiresAt    int64  `json:"expires_at"`
}

type Claims struct {
    jwt.RegisteredClaims
    Role   string `json:"role"`
    OrgID  string `json:"org_id"`
}

type TokenService struct {
    accessSecret  []byte
    refreshSecret []byte
    accessTTL     time.Duration
    refreshTTL    time.Duration
}

func NewTokenService(accessSecret, refreshSecret string) *TokenService {
    return &TokenService{
        accessSecret:  []byte(accessSecret),
        refreshSecret: []byte(refreshSecret),
        accessTTL:     15 * time.Minute,  // short-lived
        refreshTTL:    7 * 24 * time.Hour, // long-lived
    }
}

func (s *TokenService) GenerateTokenPair(userID, role, orgID string) (*TokenPair, error) {
    now := time.Now()

    // Access token — short-lived, carries user info for API requests
    accessClaims := Claims{
        RegisteredClaims: jwt.RegisteredClaims{
            Subject:   userID,
            IssuedAt:  jwt.NewNumericDate(now),
            ExpiresAt: jwt.NewNumericDate(now.Add(s.accessTTL)),
            Issuer:    "order-service",
        },
        Role:  role,
        OrgID: orgID,
    }

    accessToken := jwt.NewWithClaims(jwt.SigningMethodHS256, accessClaims)
    accessStr, err := accessToken.SignedString(s.accessSecret)
    if err != nil {
        return nil, fmt.Errorf("sign access token: %w", err)
    }

    // Refresh token — long-lived, used only to get new access tokens
    refreshClaims := jwt.RegisteredClaims{
        Subject:   userID,
        IssuedAt:  jwt.NewNumericDate(now),
        ExpiresAt: jwt.NewNumericDate(now.Add(s.refreshTTL)),
        Issuer:    "order-service",
    }

    refreshToken := jwt.NewWithClaims(jwt.SigningMethodHS256, refreshClaims)
    refreshStr, err := refreshToken.SignedString(s.refreshSecret)
    if err != nil {
        return nil, fmt.Errorf("sign refresh token: %w", err)
    }

    return &TokenPair{
        AccessToken:  accessStr,
        RefreshToken: refreshStr,
        ExpiresAt:    now.Add(s.accessTTL).Unix(),
    }, nil
}
```

### Validating JWTs in Middleware

```go
func (s *TokenService) ValidateAccessToken(tokenString string) (*Claims, error) {
    token, err := jwt.ParseWithClaims(tokenString, &Claims{}, func(token *jwt.Token) (interface{}, error) {
        // CRITICAL: Verify the signing algorithm to prevent alg:none attacks
        if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
            return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
        }
        return s.accessSecret, nil
    })

    if err != nil {
        return nil, fmt.Errorf("parse token: %w", err)
    }

    claims, ok := token.Claims.(*Claims)
    if !ok || !token.Valid {
        return nil, fmt.Errorf("invalid token claims")
    }

    return claims, nil
}
```

### Access Token vs Refresh Token Flow

```
1. User logs in with email/password
   → Server validates credentials
   → Server returns { access_token (15min), refresh_token (7 days) }

2. Frontend stores tokens
   → access_token in memory (NOT localStorage for XSS protection)
   → refresh_token in httpOnly cookie

3. Frontend makes API requests
   → Authorization: Bearer <access_token>

4. Access token expires (15 min)
   → Frontend gets 401
   → Frontend calls POST /auth/refresh with refresh_token
   → Server validates refresh_token, issues new access_token
   → Frontend retries original request

5. Refresh token expires (7 days)
   → User must log in again
```

### Login Endpoint

```go
func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
    var req struct {
        Email    string `json:"email" validate:"required,email"`
        Password string `json:"password" validate:"required"`
    }

    if err := decodeJSON(r, &req); err != nil {
        respondError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
        return
    }

    // Look up user by email
    user, err := h.userRepo.GetByEmail(r.Context(), req.Email)
    if err != nil {
        // Use the same error message for "not found" and "wrong password"
        // to prevent email enumeration attacks
        respondError(w, http.StatusUnauthorized, "INVALID_CREDENTIALS", "invalid email or password")
        return
    }

    // Verify password using bcrypt
    if err := bcrypt.CompareHashAndPassword([]byte(user.HashedPassword), []byte(req.Password)); err != nil {
        respondError(w, http.StatusUnauthorized, "INVALID_CREDENTIALS", "invalid email or password")
        return
    }

    // Generate token pair
    tokens, err := h.tokenSvc.GenerateTokenPair(user.ID, string(user.Role), user.OrganizationID)
    if err != nil {
        respondError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to generate tokens")
        return
    }

    respondJSON(w, http.StatusOK, tokens)
}
```

### JWT Pitfalls

1. **`alg: none` attack** — an attacker modifies the JWT header to `alg: none` and removes the signature. Always verify the algorithm in your validation function (shown above).
2. **Storing sensitive data in JWT** — the payload is base64-encoded, NOT encrypted. Anyone can decode it. Never put passwords, credit card numbers, or secrets in a JWT.
3. **Not checking expiration** — the `jwt` library handles this automatically, but make sure you're not ignoring validation errors.
4. **Using the same secret for access and refresh tokens** — use different secrets so a leaked access token can't be used to generate new tokens.

---

## 8B — OAuth2 & SSO

### OAuth2 Authorization Code Flow

```
1. User clicks "Login with Google" on your frontend
2. Frontend redirects to Google's auth page
3. User logs in with Google, grants permission
4. Google redirects back to your callback URL with an authorization code
5. Your BACKEND exchanges the code for access + ID tokens (server-to-server)
6. Your backend creates a session/JWT for the user
```

```go
package auth

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"

    "golang.org/x/oauth2"
    "golang.org/x/oauth2/google"
)

type OAuthService struct {
    config   *oauth2.Config
    tokenSvc *TokenService
    userRepo UserRepository
}

func NewOAuthService(clientID, clientSecret, redirectURL string, tokenSvc *TokenService, userRepo UserRepository) *OAuthService {
    return &OAuthService{
        config: &oauth2.Config{
            ClientID:     clientID,
            ClientSecret: clientSecret,
            RedirectURL:  redirectURL,
            Scopes:       []string{"openid", "email", "profile"},
            Endpoint:     google.Endpoint,
        },
        tokenSvc: tokenSvc,
        userRepo: userRepo,
    }
}

// Step 1: Generate the URL to redirect the user to Google
func (s *OAuthService) GetAuthURL(state string) string {
    return s.config.AuthCodeURL(state, oauth2.AccessTypeOffline)
}

// Step 2: Handle the callback from Google
func (s *OAuthService) HandleCallback(ctx context.Context, code string) (*TokenPair, error) {
    // Exchange the authorization code for tokens (server-to-server call to Google)
    oauthToken, err := s.config.Exchange(ctx, code)
    if err != nil {
        return nil, fmt.Errorf("exchange code: %w", err)
    }

    // Use the access token to get user info from Google
    client := s.config.Client(ctx, oauthToken)
    resp, err := client.Get("https://www.googleapis.com/oauth2/v2/userinfo")
    if err != nil {
        return nil, fmt.Errorf("get user info: %w", err)
    }
    defer resp.Body.Close()

    var googleUser struct {
        ID    string `json:"id"`
        Email string `json:"email"`
        Name  string `json:"name"`
    }
    if err := json.NewDecoder(resp.Body).Decode(&googleUser); err != nil {
        return nil, fmt.Errorf("decode user info: %w", err)
    }

    // Find or create user in our database
    user, err := s.userRepo.GetByEmail(ctx, googleUser.Email)
    if err != nil {
        // New user — create account
        user = &User{
            ID:    uuid.New().String(),
            Email: googleUser.Email,
            Name:  googleUser.Name,
            Role:  RoleMember,
        }
        if err := s.userRepo.Create(ctx, user); err != nil {
            return nil, fmt.Errorf("create user: %w", err)
        }
    }

    // Generate our own JWT token pair
    return s.tokenSvc.GenerateTokenPair(user.ID, string(user.Role), user.OrganizationID)
}
```

---

## 8C — Authorization

Authentication answers "who are you?" Authorization answers "what are you allowed to do?"

### RBAC (Role-Based Access Control)

```go
// Define permissions per role
var rolePermissions = map[Role][]string{
    RoleAdmin:  {"users:read", "users:write", "users:delete", "orders:read", "orders:write", "orders:delete", "admin:access"},
    RoleMember: {"users:read", "orders:read", "orders:write"},
    RoleViewer: {"users:read", "orders:read"},
}

func HasPermission(role Role, permission string) bool {
    permissions, ok := rolePermissions[role]
    if !ok {
        return false
    }
    for _, p := range permissions {
        if p == permission {
            return true
        }
    }
    return false
}

// Middleware that checks a specific permission
func RequirePermission(permission string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            role := Role(UserRoleFromContext(r.Context()))

            if !HasPermission(role, permission) {
                respondError(w, http.StatusForbidden, "FORBIDDEN",
                    fmt.Sprintf("permission %s is required", permission))
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}

// Usage in router
r.Route("/api/v1/users", func(r chi.Router) {
    r.With(RequirePermission("users:read")).Get("/", userHandler.List)
    r.With(RequirePermission("users:write")).Post("/", userHandler.Create)
    r.With(RequirePermission("users:delete")).Delete("/{id}", userHandler.Delete)
})
```

### Resource-Level Authorization

RBAC checks "can this role do this action?" but not "can this user access THIS specific resource?"

```go
// Check that the user owns the order they're trying to cancel
func (h *OrderHandler) Cancel(w http.ResponseWriter, r *http.Request) {
    userID := UserIDFromContext(r.Context())
    orderID := chi.URLParam(r, "orderID")

    order, err := h.svc.GetOrder(r.Context(), orderID)
    if err != nil {
        handleError(w, err)
        return
    }

    // Resource-level auth: only the order owner (or admin) can cancel
    role := Role(UserRoleFromContext(r.Context()))
    if order.UserID != userID && role != RoleAdmin {
        respondError(w, http.StatusForbidden, "FORBIDDEN", "you can only cancel your own orders")
        return
    }

    // ... proceed with cancellation
}
```

---

## 8D — API Keys

For server-to-server or third-party integrations:

```go
package auth

import (
    "crypto/rand"
    "crypto/sha256"
    "encoding/hex"
    "fmt"
)

// GenerateAPIKey creates a new API key.
// Returns the raw key (shown to user once) and the hash (stored in DB).
func GenerateAPIKey() (raw string, hashed string, err error) {
    bytes := make([]byte, 32)
    if _, err := rand.Read(bytes); err != nil {
        return "", "", fmt.Errorf("generate random bytes: %w", err)
    }

    raw = hex.EncodeToString(bytes) // this is what the user sees

    hash := sha256.Sum256([]byte(raw))
    hashed = hex.EncodeToString(hash[:]) // this is what we store

    return raw, hashed, nil
}

// ValidateAPIKey checks an incoming API key against the stored hash
func ValidateAPIKey(raw, storedHash string) bool {
    hash := sha256.Sum256([]byte(raw))
    computedHash := hex.EncodeToString(hash[:])
    return computedHash == storedHash
}
```

```go
// API key auth middleware
func APIKeyMiddleware(apiKeyRepo APIKeyRepository) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            key := r.Header.Get("X-API-Key")
            if key == "" {
                respondError(w, http.StatusUnauthorized, "MISSING_API_KEY", "X-API-Key header is required")
                return
            }

            // Hash the incoming key and look up in DB
            hash := sha256.Sum256([]byte(key))
            hashedKey := hex.EncodeToString(hash[:])

            apiKey, err := apiKeyRepo.GetByHash(r.Context(), hashedKey)
            if err != nil {
                respondError(w, http.StatusUnauthorized, "INVALID_API_KEY", "invalid API key")
                return
            }

            // Store the API key owner in context
            ctx := context.WithValue(r.Context(), userIDContextKey, apiKey.OwnerID)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}
```

---

## 8E — Full Auth Middleware Stack

Combining JWT and API Key auth, with the ability to use either:

```go
func FlexibleAuthMiddleware(tokenSvc *TokenService, apiKeyRepo APIKeyRepository) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Try JWT first (Authorization: Bearer <token>)
            if authHeader := r.Header.Get("Authorization"); authHeader != "" {
                parts := strings.SplitN(authHeader, " ", 2)
                if len(parts) == 2 && parts[0] == "Bearer" {
                    claims, err := tokenSvc.ValidateAccessToken(parts[1])
                    if err != nil {
                        respondError(w, http.StatusUnauthorized, "INVALID_TOKEN", "invalid or expired token")
                        return
                    }

                    ctx := context.WithValue(r.Context(), userIDContextKey, claims.Subject)
                    ctx = context.WithValue(ctx, userRoleContextKey, claims.Role)
                    next.ServeHTTP(w, r.WithContext(ctx))
                    return
                }
            }

            // Try API Key (X-API-Key header)
            if apiKey := r.Header.Get("X-API-Key"); apiKey != "" {
                hash := sha256.Sum256([]byte(apiKey))
                hashedKey := hex.EncodeToString(hash[:])

                key, err := apiKeyRepo.GetByHash(r.Context(), hashedKey)
                if err != nil {
                    respondError(w, http.StatusUnauthorized, "INVALID_API_KEY", "invalid API key")
                    return
                }

                ctx := context.WithValue(r.Context(), userIDContextKey, key.OwnerID)
                ctx = context.WithValue(ctx, userRoleContextKey, string(key.Role))
                next.ServeHTTP(w, r.WithContext(ctx))
                return
            }

            respondError(w, http.StatusUnauthorized, "MISSING_AUTH", "authentication required")
        })
    }
}
```

---

→ **Continued in [Part 9 — Configuration & Secrets](./part09_config_secrets.md)**
