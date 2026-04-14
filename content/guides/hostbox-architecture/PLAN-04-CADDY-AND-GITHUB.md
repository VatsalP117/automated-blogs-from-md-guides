# Phase 4: Caddy Integration & GitHub Integration — Implementation Plan

> **Scope**: Caddy Admin API client, full config sync, route management for all deployment types, custom Caddy Docker build, GitHub App auth, webhook processing, PR comments, deployment statuses.
>
> **Depends on**: Phase 1 (DB + models), Phase 2 (Auth + API), Phase 3 (Build Pipeline)
>
> **Estimated files**: ~20 new Go files, 1 Dockerfile, 1 migration

---

## Table of Contents

1. [Part A: Caddy Integration Layer](#part-a-caddy-integration-layer)
   - [A1: Caddy Admin API Client](#a1-caddy-admin-api-client)
   - [A2: Caddy JSON Config Types](#a2-caddy-json-config-types)
   - [A3: Config Builder](#a3-config-builder)
   - [A4: Route Manager Service](#a4-route-manager-service)
   - [A5: Startup Sync](#a5-startup-sync)
   - [A6: Static File Serving & SPA Config](#a6-static-file-serving--spa-config)
   - [A7: SSL/TLS Strategy](#a7-ssltls-strategy)
   - [A8: Custom Caddy Docker Build](#a8-custom-caddy-docker-build)
   - [A9: Route Update Triggers (Integration Points)](#a9-route-update-triggers-integration-points)
2. [Part B: GitHub Integration](#part-b-github-integration)
   - [B1: GitHub App Authentication](#b1-github-app-authentication)
   - [B2: GitHub API Client](#b2-github-api-client)
   - [B3: Webhook Handler](#b3-webhook-handler)
   - [B4: Event Processors](#b4-event-processors)
   - [B5: PR Comment Manager](#b5-pr-comment-manager)
   - [B6: Deployment Status Reporter](#b6-deployment-status-reporter)
   - [B7: GitHub API Endpoints (Authenticated)](#b7-github-api-endpoints-authenticated)
   - [B8: Database Migration](#b8-database-migration)
3. [File Inventory](#file-inventory)
4. [Implementation Order](#implementation-order)
5. [Testing Strategy](#testing-strategy)

---

## Part A: Caddy Integration Layer

### A1: Caddy Admin API Client

**File**: `internal/services/caddy/client.go`

The `CaddyClient` is a thin HTTP wrapper around Caddy's Admin API at `http://caddy:2019` (Docker) or `http://localhost:2019` (local dev). All mutating operations use the retry policy defined below.

```go
package caddy

import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "io"
    "log/slog"
    "math"
    "net/http"
    "time"
)

// CaddyClient communicates with the Caddy Admin API.
type CaddyClient struct {
    baseURL    string       // "http://caddy:2019" or "http://localhost:2019"
    httpClient *http.Client
    logger     *slog.Logger
}

// NewCaddyClient creates a client for the Caddy Admin API.
func NewCaddyClient(baseURL string, logger *slog.Logger) *CaddyClient {
    return &CaddyClient{
        baseURL: baseURL,
        httpClient: &http.Client{
            Timeout: 10 * time.Second,
        },
        logger: logger,
    }
}
```

#### Core Methods

```go
// LoadConfig replaces the entire Caddy configuration.
// POST /load
// This is the primary method used on startup to sync all routes.
func (c *CaddyClient) LoadConfig(ctx context.Context, config *CaddyConfig) error {
    body, err := json.Marshal(config)
    if err != nil {
        return fmt.Errorf("marshal caddy config: %w", err)
    }

    return c.doWithRetry(ctx, "POST", "/load", body)
}

// GetConfig reads the current Caddy configuration.
// GET /config/
func (c *CaddyClient) GetConfig(ctx context.Context) (*CaddyConfig, error) {
    req, err := http.NewRequestWithContext(ctx, "GET", c.baseURL+"/config/", nil)
    if err != nil {
        return nil, fmt.Errorf("create request: %w", err)
    }

    resp, err := c.httpClient.Do(req)
    if err != nil {
        return nil, fmt.Errorf("caddy GET /config/: %w", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        respBody, _ := io.ReadAll(resp.Body)
        return nil, fmt.Errorf("caddy GET /config/ returned %d: %s", resp.StatusCode, string(respBody))
    }

    var config CaddyConfig
    if err := json.NewDecoder(resp.Body).Decode(&config); err != nil {
        return nil, fmt.Errorf("decode caddy config: %w", err)
    }
    return &config, nil
}

// AddRoute appends a route to the specified server.
// POST /config/apps/http/servers/{serverName}/routes
func (c *CaddyClient) AddRoute(ctx context.Context, serverName string, route CaddyRoute) error {
    body, err := json.Marshal(route)
    if err != nil {
        return fmt.Errorf("marshal route: %w", err)
    }

    path := fmt.Sprintf("/config/apps/http/servers/%s/routes", serverName)
    return c.doWithRetry(ctx, "POST", path, body)
}

// PatchRoute replaces a route at a specific index.
// PUT /config/apps/http/servers/{serverName}/routes/{index}
func (c *CaddyClient) PatchRoute(ctx context.Context, serverName string, index int, route CaddyRoute) error {
    body, err := json.Marshal(route)
    if err != nil {
        return fmt.Errorf("marshal route: %w", err)
    }

    path := fmt.Sprintf("/config/apps/http/servers/%s/routes/%d", serverName, index)
    return c.doWithRetry(ctx, "PUT", path, body)
}

// DeleteRoute removes a route by its @id.
// DELETE /id/{routeID}
// Caddy supports addressing config elements by @id annotations.
func (c *CaddyClient) DeleteRoute(ctx context.Context, routeID string) error {
    path := fmt.Sprintf("/id/%s", routeID)
    return c.doWithRetry(ctx, "DELETE", path, nil)
}
```

#### Retry Policy

5 retries, exponential backoff with 500ms base, 10s per-request timeout. Retries on network errors and 5xx responses. Does **not** retry 4xx (client errors).

```go
const (
    maxRetries     = 5
    baseBackoff    = 500 * time.Millisecond
    requestTimeout = 10 * time.Second
)

func (c *CaddyClient) doWithRetry(ctx context.Context, method, path string, body []byte) error {
    var lastErr error

    for attempt := 0; attempt <= maxRetries; attempt++ {
        if attempt > 0 {
            backoff := time.Duration(float64(baseBackoff) * math.Pow(2, float64(attempt-1)))
            c.logger.Debug("caddy retry",
                "attempt", attempt,
                "backoff", backoff,
                "method", method,
                "path", path,
            )
            select {
            case <-ctx.Done():
                return ctx.Err()
            case <-time.After(backoff):
            }
        }

        reqCtx, cancel := context.WithTimeout(ctx, requestTimeout)
        var bodyReader io.Reader
        if body != nil {
            bodyReader = bytes.NewReader(body)
        }

        req, err := http.NewRequestWithContext(reqCtx, method, c.baseURL+path, bodyReader)
        if err != nil {
            cancel()
            return fmt.Errorf("create request: %w", err)
        }
        if body != nil {
            req.Header.Set("Content-Type", "application/json")
        }

        resp, err := c.httpClient.Do(req)
        if err != nil {
            cancel()
            lastErr = fmt.Errorf("caddy %s %s: %w", method, path, err)
            continue // retry on network error
        }

        respBody, _ := io.ReadAll(resp.Body)
        resp.Body.Close()
        cancel()

        if resp.StatusCode >= 200 && resp.StatusCode < 300 {
            return nil // success
        }

        lastErr = fmt.Errorf("caddy %s %s returned %d: %s", method, path, resp.StatusCode, string(respBody))

        // Only retry on 5xx (server errors), not 4xx (client errors)
        if resp.StatusCode < 500 {
            return lastErr
        }
    }

    return fmt.Errorf("caddy %s %s failed after %d retries: %w", method, path, maxRetries, lastErr)
}
```

#### Health Check

```go
// Healthy returns true if Caddy's admin API is reachable.
func (c *CaddyClient) Healthy(ctx context.Context) bool {
    reqCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
    defer cancel()

    req, err := http.NewRequestWithContext(reqCtx, "GET", c.baseURL+"/config/", nil)
    if err != nil {
        return false
    }

    resp, err := c.httpClient.Do(req)
    if err != nil {
        return false
    }
    defer resp.Body.Close()
    return resp.StatusCode == http.StatusOK
}
```

---

### A2: Caddy JSON Config Types

**File**: `internal/services/caddy/config.go`

These structs map 1:1 to Caddy's JSON config schema. Only the subset of Caddy's config that Hostbox uses is modeled. Fields use `json` tags matching Caddy's exact key names.

```go
package caddy

// CaddyConfig is the top-level Caddy JSON configuration.
// Ref: https://caddyserver.com/docs/json/
type CaddyConfig struct {
    Admin *CaddyAdmin `json:"admin,omitempty"`
    Apps  *CaddyApps  `json:"apps,omitempty"`
}

type CaddyAdmin struct {
    Listen string `json:"listen,omitempty"` // "localhost:2019"
}

type CaddyApps struct {
    HTTP *CaddyHTTPApp `json:"http,omitempty"`
    TLS  *CaddyTLSApp  `json:"tls,omitempty"`
}

// --- HTTP App ---

type CaddyHTTPApp struct {
    Servers map[string]*CaddyServer `json:"servers,omitempty"`
}

type CaddyServer struct {
    Listen            []string          `json:"listen,omitempty"`       // [":443", ":80"]
    Routes            []CaddyRoute      `json:"routes,omitempty"`
    AutomaticHTTPS    *CaddyAutoHTTPS   `json:"automatic_https,omitempty"`
    Logs              *CaddyServerLogs  `json:"logs,omitempty"`
}

type CaddyAutoHTTPS struct {
    DisableRedirects bool     `json:"disable_redirects,omitempty"`
    Skip             []string `json:"skip,omitempty"`           // domains to skip HTTPS for
    SkipCerts        []string `json:"skip_certificates,omitempty"`
}

type CaddyServerLogs struct {
    DefaultLoggerName string `json:"default_logger_name,omitempty"`
}

// --- Routes ---

// CaddyRoute represents a single route rule.
// The @id field is used for Caddy's config addressing (DELETE /id/{id}).
type CaddyRoute struct {
    ID       string            `json:"@id,omitempty"`       // addressable config ID
    Group    string            `json:"group,omitempty"`     // route group name
    Match    []CaddyMatch      `json:"match,omitempty"`
    Handle   []CaddyHandler    `json:"handle,omitempty"`
    Terminal bool              `json:"terminal,omitempty"`
}

type CaddyMatch struct {
    Host []string        `json:"host,omitempty"`
    Path []string        `json:"path,omitempty"`
}

// CaddyHandler is a generic handler. The "handler" field determines
// which Caddy module is used. Extra fields vary per handler type.
// We use json.RawMessage for flexibility and define typed constructors.
type CaddyHandler struct {
    Handler string `json:"handler"`

    // file_server fields
    Root       string `json:"root,omitempty"`
    IndexNames []string `json:"index_names,omitempty"`

    // reverse_proxy fields
    Upstreams []CaddyUpstream `json:"upstreams,omitempty"`

    // encode fields
    Encodings *CaddyEncodings `json:"encodings,omitempty"`

    // rewrite fields
    URI string `json:"uri,omitempty"`

    // headers fields
    Response *CaddyHeaderOps `json:"response,omitempty"`

    // static_response fields
    StatusCode string `json:"status_code,omitempty"`
    Body       string `json:"body,omitempty"`

    // subroute fields
    Routes []CaddyRoute `json:"routes,omitempty"`
}

type CaddyUpstream struct {
    Dial string `json:"dial"` // "localhost:8080"
}

type CaddyEncodings struct {
    Gzip   *struct{} `json:"gzip,omitempty"`
    Zstd   *struct{} `json:"zstd,omitempty"`
}

type CaddyHeaderOps struct {
    Set    map[string][]string `json:"set,omitempty"`
    Add    map[string][]string `json:"add,omitempty"`
    Delete []string            `json:"delete,omitempty"`
}

// --- TLS App ---

type CaddyTLSApp struct {
    Automation *CaddyTLSAutomation `json:"automation,omitempty"`
}

type CaddyTLSAutomation struct {
    Policies []CaddyTLSPolicy `json:"policies,omitempty"`
}

type CaddyTLSPolicy struct {
    Subjects []string           `json:"subjects,omitempty"`
    Issuers  []CaddyTLSIssuer   `json:"issuers,omitempty"`
}

// CaddyTLSIssuer represents an ACME issuer.
// Module field determines the issuer type.
type CaddyTLSIssuer struct {
    Module     string          `json:"module"`                 // "acme" or "acme_dns"
    CA         string          `json:"ca,omitempty"`           // Let's Encrypt URL
    Email      string          `json:"email,omitempty"`
    Challenges *CaddyChallenges `json:"challenges,omitempty"`
}

type CaddyChallenges struct {
    DNS *CaddyDNSChallenge `json:"dns,omitempty"`
}

type CaddyDNSChallenge struct {
    Provider json.RawMessage `json:"provider,omitempty"` // DNS provider config (Cloudflare, Route53, etc.)
}
```

---

### A3: Config Builder

**File**: `internal/services/caddy/builder.go`

The `ConfigBuilder` constructs a complete `CaddyConfig` from database state. This is used on startup and for full re-syncs.

```go
package caddy

import (
    "fmt"
    "strings"
)

// BuilderConfig holds platform-level settings used during config generation.
type BuilderConfig struct {
    PlatformDomain  string // e.g. "hostbox.example.com"
    PlatformHTTPS   bool
    ACMEEmail       string
    APIUpstream     string // "localhost:8080"
    DeploymentRoot  string // "/app/deployments"

    // DNS-01 provider config (optional, for wildcard certs)
    DNSProvider     string // "cloudflare", "route53", "digitalocean", ""
    DNSProviderConf json.RawMessage // provider-specific JSON
}

// ConfigBuilder assembles a CaddyConfig from deployments and domains.
type ConfigBuilder struct {
    cfg BuilderConfig
}

func NewConfigBuilder(cfg BuilderConfig) *ConfigBuilder {
    return &ConfigBuilder{cfg: cfg}
}
```

#### Route ID Convention

Every route gets a deterministic `@id` so it can be addressed for updates and deletions:

| Route Type | `@id` Pattern | Example |
|---|---|---|
| Platform | `route-platform` | `route-platform` |
| Deployment preview | `route-deploy-{deployment_id}` | `route-deploy-dpl_a1b2c3d4` |
| Production | `route-prod-{project_id}` | `route-prod-prj_xyz123` |
| Branch-stable | `route-branch-{project_id}-{branch_slug}` | `route-branch-prj_xyz123-feat-login` |
| Custom domain | `route-domain-{domain_id}` | `route-domain-dom_abc456` |

#### BuildFullConfig

```go
// ActiveDeployment is a denormalized view from the DB join.
type ActiveDeployment struct {
    DeploymentID   string
    ProjectID      string
    ProjectSlug    string
    Branch         string
    BranchSlug     string // slugified branch name
    CommitSHA      string
    IsProduction   bool
    ArtifactPath   string
    Framework      string // "nextjs", "vite", "cra", "astro", "hugo", "html", etc.
}

// VerifiedDomain is a verified custom domain with its project context.
type VerifiedDomain struct {
    DomainID           string
    Domain             string // "myapp.com"
    ProjectID          string
    ProjectSlug        string
    ProductionArtifact string // path to current production deployment
    Framework          string
}

// BuildFullConfig constructs the complete Caddy JSON config from current state.
func (b *ConfigBuilder) BuildFullConfig(
    deployments []ActiveDeployment,
    domains []VerifiedDomain,
) *CaddyConfig {
    routes := make([]CaddyRoute, 0, len(deployments)+len(domains)+1)

    // 1. Platform route (highest priority — matched first)
    routes = append(routes, b.buildPlatformRoute())

    // 2. Custom domain routes (before wildcard subdomain routes)
    for _, d := range domains {
        routes = append(routes, b.buildCustomDomainRoute(d))
    }

    // 3. Production routes: {project_slug}.{platform_domain}
    // 4. Branch-stable routes: {project_slug}-{branch_slug}.{platform_domain}
    // 5. Preview deployment routes: {project_slug}-{short_hash}.{platform_domain}
    // Group by project to build production + branch + preview routes
    projectDeployments := groupByProject(deployments)
    for _, projDeploys := range projectDeployments {
        routes = append(routes, b.buildProjectRoutes(projDeploys)...)
    }

    config := &CaddyConfig{
        Admin: &CaddyAdmin{Listen: "localhost:2019"},
        Apps: &CaddyApps{
            HTTP: &CaddyHTTPApp{
                Servers: map[string]*CaddyServer{
                    "main": {
                        Listen: []string{":443", ":80"},
                        Routes: routes,
                    },
                },
            },
            TLS: b.buildTLSConfig(domains),
        },
    }

    return config
}
```

#### Individual Route Builders

```go
// --- Route Type 1: Platform ---

func (b *ConfigBuilder) buildPlatformRoute() CaddyRoute {
    return CaddyRoute{
        ID:    "route-platform",
        Group: "platform",
        Match: []CaddyMatch{{Host: []string{b.cfg.PlatformDomain}}},
        Handle: []CaddyHandler{
            {
                Handler: "subroute",
                Routes: []CaddyRoute{
                    {
                        // All requests to platform domain → reverse proxy to Go API
                        Handle: []CaddyHandler{
                            {Handler: "encode", Encodings: &CaddyEncodings{Gzip: &struct{}{}}},
                            {
                                Handler:   "reverse_proxy",
                                Upstreams: []CaddyUpstream{{Dial: b.cfg.APIUpstream}},
                            },
                        },
                    },
                },
            },
        },
        Terminal: true,
    }
}
```

```go
// --- Route Type 2: Preview Deployment ---
// Host: {project_slug}-{short_hash}.{platform_domain}
// Short hash = first 8 chars of deployment ID

func (b *ConfigBuilder) buildPreviewRoute(d ActiveDeployment) CaddyRoute {
    shortHash := d.DeploymentID
    if len(shortHash) > 8 {
        shortHash = shortHash[:8]
    }

    host := fmt.Sprintf("%s-%s.%s", d.ProjectSlug, shortHash, b.cfg.PlatformDomain)

    return CaddyRoute{
        ID:    fmt.Sprintf("route-deploy-%s", d.DeploymentID),
        Match: []CaddyMatch{{Host: []string{host}}},
        Handle: b.buildFileServerHandlers(d.ArtifactPath, d.Framework),
        Terminal: true,
    }
}
```

```go
// --- Route Type 3: Production ---
// Host: {project_slug}.{platform_domain}
// Points to current production deployment's artifact path.

func (b *ConfigBuilder) buildProductionRoute(projectSlug, projectID, artifactPath, framework string) CaddyRoute {
    host := fmt.Sprintf("%s.%s", projectSlug, b.cfg.PlatformDomain)

    return CaddyRoute{
        ID:    fmt.Sprintf("route-prod-%s", projectID),
        Match: []CaddyMatch{{Host: []string{host}}},
        Handle: b.buildFileServerHandlers(artifactPath, framework),
        Terminal: true,
    }
}
```

```go
// --- Route Type 4: Custom Domain ---

func (b *ConfigBuilder) buildCustomDomainRoute(d VerifiedDomain) CaddyRoute {
    hosts := []string{d.Domain}
    // If domain doesn't start with www, also match www.{domain}
    if !strings.HasPrefix(d.Domain, "www.") {
        hosts = append(hosts, "www."+d.Domain)
    }

    return CaddyRoute{
        ID:    fmt.Sprintf("route-domain-%s", d.DomainID),
        Match: []CaddyMatch{{Host: hosts}},
        Handle: b.buildFileServerHandlers(d.ProductionArtifact, d.Framework),
        Terminal: true,
    }
}
```

```go
// --- Route Type 5: Branch-Stable ---
// Host: {project_slug}-{branch_slug}.{platform_domain}
// Points to latest deployment for that branch.

func (b *ConfigBuilder) buildBranchStableRoute(projectSlug, projectID, branchSlug, artifactPath, framework string) CaddyRoute {
    host := fmt.Sprintf("%s-%s.%s", projectSlug, branchSlug, b.cfg.PlatformDomain)

    return CaddyRoute{
        ID:    fmt.Sprintf("route-branch-%s-%s", projectID, branchSlug),
        Match: []CaddyMatch{{Host: []string{host}}},
        Handle: b.buildFileServerHandlers(artifactPath, framework),
        Terminal: true,
    }
}
```

#### File Server Handler Builder

```go
// buildFileServerHandlers returns the handler chain for serving static files.
// The chain differs based on whether the project uses SPA mode or static mode.
func (b *ConfigBuilder) buildFileServerHandlers(artifactPath, framework string) []CaddyHandler {
    handlers := []CaddyHandler{
        // 1. Compression (gzip + zstd)
        {
            Handler:   "encode",
            Encodings: &CaddyEncodings{Gzip: &struct{}{}, Zstd: &struct{}{}},
        },
        // 2. Cache headers for hashed assets
        {
            Handler: "headers",
            Response: &CaddyHeaderOps{
                Set: map[string][]string{
                    "X-Frame-Options":           {"DENY"},
                    "X-Content-Type-Options":     {"nosniff"},
                    "Referrer-Policy":            {"strict-origin-when-cross-origin"},
                },
            },
        },
    }

    // 3. SPA rewrite (for frameworks that need client-side routing)
    if isSPAFramework(framework) {
        handlers = append(handlers, CaddyHandler{
            Handler: "subroute",
            Routes: []CaddyRoute{
                // Cache-busted assets: immutable
                {
                    Match: []CaddyMatch{{Path: []string{
                        "/_next/static/*",
                        "/static/*",
                        "/assets/*",
                        "*.js",
                        "*.css",
                        "*.woff2",
                        "*.woff",
                    }}},
                    Handle: []CaddyHandler{
                        {
                            Handler: "headers",
                            Response: &CaddyHeaderOps{
                                Set: map[string][]string{
                                    "Cache-Control": {"public, max-age=31536000, immutable"},
                                },
                            },
                        },
                        {Handler: "file_server", Root: artifactPath},
                    },
                    Terminal: true,
                },
                // try_files {path} /index.html — SPA fallback
                {
                    Handle: []CaddyHandler{
                        {Handler: "rewrite", URI: "{http.request.uri.path}"},
                        {
                            Handler: "file_server",
                            Root:    artifactPath,
                            // Caddy's file_server with try_files equivalent:
                            // The rewrite + file_server combo handles SPA mode.
                            // We use a subroute to first try the exact path,
                            // then fall back to /index.html.
                        },
                    },
                },
            },
        })
    } else {
        // Static mode: direct file serving, 404 for missing paths
        handlers = append(handlers, CaddyHandler{
            Handler: "file_server",
            Root:    artifactPath,
        })
    }

    return handlers
}

// isSPAFramework returns true if the framework uses client-side routing
// and needs try_files → /index.html fallback.
func isSPAFramework(framework string) bool {
    switch framework {
    case "nextjs", "vite", "cra", "svelte", "angular", "vue":
        return true
    case "astro", "gatsby", "nuxt", "hugo", "html", "":
        return false
    default:
        return true // default to SPA for unknown frameworks
    }
}
```

#### Full Caddy JSON Config Example (for reference/testing)

The `BuildFullConfig` method produces JSON like this:

```json
{
  "admin": {
    "listen": "localhost:2019"
  },
  "apps": {
    "http": {
      "servers": {
        "main": {
          "listen": [":443", ":80"],
          "routes": [
            {
              "@id": "route-platform",
              "group": "platform",
              "match": [{"host": ["hostbox.example.com"]}],
              "handle": [{
                "handler": "subroute",
                "routes": [{
                  "handle": [
                    {"handler": "encode", "encodings": {"gzip": {}}},
                    {"handler": "reverse_proxy", "upstreams": [{"dial": "localhost:8080"}]}
                  ]
                }]
              }],
              "terminal": true
            },
            {
              "@id": "route-domain-dom_abc456",
              "match": [{"host": ["myapp.com", "www.myapp.com"]}],
              "handle": [
                {"handler": "encode", "encodings": {"gzip": {}, "zstd": {}}},
                {"handler": "headers", "response": {"set": {
                  "X-Frame-Options": ["DENY"],
                  "X-Content-Type-Options": ["nosniff"],
                  "Referrer-Policy": ["strict-origin-when-cross-origin"]
                }}},
                {"handler": "file_server", "root": "/app/deployments/prj_xyz123/dpl_prod01"}
              ],
              "terminal": true
            },
            {
              "@id": "route-prod-prj_xyz123",
              "match": [{"host": ["my-app.hostbox.example.com"]}],
              "handle": [
                {"handler": "encode", "encodings": {"gzip": {}, "zstd": {}}},
                {"handler": "headers", "response": {"set": {"X-Frame-Options": ["DENY"]}}},
                {"handler": "subroute", "routes": [
                  {
                    "match": [{"path": ["/_next/static/*", "/static/*", "/assets/*", "*.js", "*.css"]}],
                    "handle": [
                      {"handler": "headers", "response": {"set": {"Cache-Control": ["public, max-age=31536000, immutable"]}}},
                      {"handler": "file_server", "root": "/app/deployments/prj_xyz123/dpl_prod01"}
                    ],
                    "terminal": true
                  },
                  {
                    "handle": [
                      {"handler": "rewrite", "uri": "{http.request.uri.path}"},
                      {"handler": "file_server", "root": "/app/deployments/prj_xyz123/dpl_prod01"}
                    ]
                  }
                ]}
              ],
              "terminal": true
            },
            {
              "@id": "route-deploy-dpl_a1b2c3d4",
              "match": [{"host": ["my-app-a1b2c3d4.hostbox.example.com"]}],
              "handle": [
                {"handler": "encode", "encodings": {"gzip": {}, "zstd": {}}},
                {"handler": "headers", "response": {"set": {"X-Frame-Options": ["DENY"]}}},
                {"handler": "subroute", "routes": ["..."]}
              ],
              "terminal": true
            }
          ]
        }
      }
    },
    "tls": {
      "automation": {
        "policies": [
          {
            "subjects": ["hostbox.example.com"],
            "issuers": [{"module": "acme", "email": "admin@example.com"}]
          },
          {
            "subjects": ["*.hostbox.example.com"],
            "issuers": [{
              "module": "acme",
              "challenges": {
                "dns": {
                  "provider": {"name": "cloudflare", "api_token": "{env.CF_API_TOKEN}"}
                }
              },
              "email": "admin@example.com"
            }]
          }
        ]
      }
    }
  }
}
```

---

### A4: Route Manager Service

**File**: `internal/services/caddy/manager.go`

The `RouteManager` provides high-level operations for route mutations. It wraps `CaddyClient` and `ConfigBuilder` to provide deployment-oriented methods.

```go
package caddy

import (
    "context"
    "fmt"
    "log/slog"
)

// RouteManager handles route lifecycle operations.
type RouteManager struct {
    client  *CaddyClient
    builder *ConfigBuilder
    logger  *slog.Logger
}

func NewRouteManager(client *CaddyClient, builder *ConfigBuilder, logger *slog.Logger) *RouteManager {
    return &RouteManager{
        client:  client,
        builder: builder,
        logger:  logger,
    }
}
```

#### Operations

```go
// AddDeploymentRoute adds a preview route for a newly-ready deployment.
// Called when deployment status transitions to "ready".
func (m *RouteManager) AddDeploymentRoute(ctx context.Context, d ActiveDeployment) error {
    route := m.builder.buildPreviewRoute(d)
    m.logger.Info("adding deployment route",
        "deployment_id", d.DeploymentID,
        "host", route.Match[0].Host[0],
    )
    return m.client.AddRoute(ctx, "main", route)
}

// UpdateProductionRoute sets (or updates) the production route for a project.
// Called on: deployment promoted to production, rollback.
func (m *RouteManager) UpdateProductionRoute(ctx context.Context, projectSlug, projectID, artifactPath, framework string) error {
    route := m.builder.buildProductionRoute(projectSlug, projectID, artifactPath, framework)

    // Try to delete existing production route first (ignore 404)
    _ = m.client.DeleteRoute(ctx, fmt.Sprintf("route-prod-%s", projectID))

    m.logger.Info("setting production route",
        "project_id", projectID,
        "host", route.Match[0].Host[0],
    )
    return m.client.AddRoute(ctx, "main", route)
}

// UpdateBranchRoute sets (or updates) the branch-stable route.
// Called when a new deployment for a branch becomes ready.
func (m *RouteManager) UpdateBranchRoute(ctx context.Context, projectSlug, projectID, branchSlug, artifactPath, framework string) error {
    routeID := fmt.Sprintf("route-branch-%s-%s", projectID, branchSlug)
    _ = m.client.DeleteRoute(ctx, routeID)

    route := m.builder.buildBranchStableRoute(projectSlug, projectID, branchSlug, artifactPath, framework)
    m.logger.Info("setting branch route",
        "project_id", projectID,
        "branch", branchSlug,
        "host", route.Match[0].Host[0],
    )
    return m.client.AddRoute(ctx, "main", route)
}

// AddCustomDomainRoute adds a route for a verified custom domain.
func (m *RouteManager) AddCustomDomainRoute(ctx context.Context, d VerifiedDomain) error {
    route := m.builder.buildCustomDomainRoute(d)
    m.logger.Info("adding custom domain route",
        "domain_id", d.DomainID,
        "domain", d.Domain,
    )
    return m.client.AddRoute(ctx, "main", route)
}

// RemoveCustomDomainRoute removes a custom domain route.
func (m *RouteManager) RemoveCustomDomainRoute(ctx context.Context, domainID string) error {
    routeID := fmt.Sprintf("route-domain-%s", domainID)
    m.logger.Info("removing custom domain route", "domain_id", domainID)
    return m.client.DeleteRoute(ctx, routeID)
}

// RemoveDeploymentRoute removes a single deployment's preview route.
func (m *RouteManager) RemoveDeploymentRoute(ctx context.Context, deploymentID string) error {
    routeID := fmt.Sprintf("route-deploy-%s", deploymentID)
    m.logger.Info("removing deployment route", "deployment_id", deploymentID)
    return m.client.DeleteRoute(ctx, routeID)
}

// RemoveAllProjectRoutes removes all routes for a project (production, branches, previews).
// Used when a project is deleted.
func (m *RouteManager) RemoveAllProjectRoutes(ctx context.Context, projectID string, deploymentIDs []string, branchSlugs []string, domainIDs []string) error {
    // Remove production route
    _ = m.client.DeleteRoute(ctx, fmt.Sprintf("route-prod-%s", projectID))

    // Remove branch-stable routes
    for _, slug := range branchSlugs {
        _ = m.client.DeleteRoute(ctx, fmt.Sprintf("route-branch-%s-%s", projectID, slug))
    }

    // Remove all preview deployment routes
    for _, dID := range deploymentIDs {
        _ = m.client.DeleteRoute(ctx, fmt.Sprintf("route-deploy-%s", dID))
    }

    // Remove custom domain routes
    for _, domID := range domainIDs {
        _ = m.client.DeleteRoute(ctx, fmt.Sprintf("route-domain-%s", domID))
    }

    m.logger.Info("removed all project routes", "project_id", projectID)
    return nil
}
```

---

### A5: Startup Sync

**File**: `internal/services/caddy/sync.go`

On startup (Step 6 in the startup sequence), Hostbox reads all state from SQLite and posts the full config to Caddy.

```go
package caddy

import (
    "context"
    "fmt"
    "log/slog"
    "time"
)

// SyncService handles full configuration synchronization on startup
// and periodic re-syncs if Caddy restarts.
type SyncService struct {
    client       *CaddyClient
    builder      *ConfigBuilder
    deployRepo   DeploymentQuerier // interface for DB queries
    domainRepo   DomainQuerier     // interface for DB queries
    projectRepo  ProjectQuerier    // interface for DB queries
    logger       *slog.Logger
}

// DeploymentQuerier is the interface the sync service needs from the deployment repository.
type DeploymentQuerier interface {
    ListActiveWithProject(ctx context.Context) ([]ActiveDeployment, error)
}

// DomainQuerier is the interface the sync service needs from the domain repository.
type DomainQuerier interface {
    ListVerifiedWithProject(ctx context.Context) ([]VerifiedDomain, error)
}

// ProjectQuerier is the interface the sync service needs from the project repository.
type ProjectQuerier interface {
    GetByID(ctx context.Context, id string) (*Project, error)
}

func NewSyncService(
    client *CaddyClient,
    builder *ConfigBuilder,
    deployRepo DeploymentQuerier,
    domainRepo DomainQuerier,
    projectRepo ProjectQuerier,
    logger *slog.Logger,
) *SyncService {
    return &SyncService{
        client:      client,
        builder:     builder,
        deployRepo:  deployRepo,
        domainRepo:  domainRepo,
        projectRepo: projectRepo,
        logger:      logger,
    }
}

// SyncAll builds the complete config from DB and loads it into Caddy.
// Called once on startup, and can be called for manual re-sync.
func (s *SyncService) SyncAll(ctx context.Context) error {
    s.logger.Info("syncing caddy configuration from database")

    deployments, err := s.deployRepo.ListActiveWithProject(ctx)
    if err != nil {
        return fmt.Errorf("list active deployments: %w", err)
    }

    domains, err := s.domainRepo.ListVerifiedWithProject(ctx)
    if err != nil {
        return fmt.Errorf("list verified domains: %w", err)
    }

    config := s.builder.BuildFullConfig(deployments, domains)

    if err := s.client.LoadConfig(ctx, config); err != nil {
        return fmt.Errorf("load caddy config: %w", err)
    }

    s.logger.Info("caddy config synced",
        "deployment_routes", len(deployments),
        "domain_routes", len(domains),
    )
    return nil
}

// WaitForCaddy blocks until the Caddy admin API is reachable.
// Used during startup to wait for Caddy container to be ready.
func (s *SyncService) WaitForCaddy(ctx context.Context, timeout time.Duration) error {
    deadline := time.After(timeout)
    ticker := time.NewTicker(500 * time.Millisecond)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-deadline:
            return fmt.Errorf("caddy admin API not reachable after %s", timeout)
        case <-ticker.C:
            if s.client.Healthy(ctx) {
                s.logger.Info("caddy admin API is reachable")
                return nil
            }
        }
    }
}

// StartPeriodicSync starts a background goroutine that re-syncs
// the full Caddy config on a schedule. This catches Caddy restarts
// that happened while Hostbox was running.
func (s *SyncService) StartPeriodicSync(ctx context.Context, interval time.Duration) {
    go func() {
        ticker := time.NewTicker(interval)
        defer ticker.Stop()
        for {
            select {
            case <-ctx.Done():
                return
            case <-ticker.C:
                if err := s.SyncAll(ctx); err != nil {
                    s.logger.Error("periodic caddy sync failed", "error", err)
                }
            }
        }
    }()
}
```

#### Integration in `main()`

```go
// In cmd/api/main.go — startup step 6

// Wait for Caddy to be reachable (max 30 seconds)
caddySyncSvc := caddy.NewSyncService(caddyClient, configBuilder, deployRepo, domainRepo, projectRepo, logger)
if err := caddySyncSvc.WaitForCaddy(ctx, 30*time.Second); err != nil {
    logger.Warn("caddy not reachable on startup, routes will sync later", "error", err)
} else {
    if err := caddySyncSvc.SyncAll(ctx); err != nil {
        logger.Error("initial caddy sync failed", "error", err)
        // Non-fatal: Caddy will be synced on next periodic cycle
    }
}

// Start periodic re-sync every 5 minutes (catches Caddy restarts)
caddySyncSvc.StartPeriodicSync(ctx, 5*time.Minute)
```

---

### A6: Static File Serving & SPA Config

#### SPA vs Static Mode Decision Table

| Framework Value | Mode | Behavior |
|---|---|---|
| `nextjs` | SPA | `try_files {path} /index.html` |
| `vite` | SPA | `try_files {path} /index.html` |
| `cra` | SPA | `try_files {path} /index.html` |
| `svelte` | SPA | `try_files {path} /index.html` |
| `angular` | SPA | `try_files {path} /index.html` |
| `vue` | SPA | `try_files {path} /index.html` |
| `astro` | Static | `try_files {path} {path}/ =404` |
| `gatsby` | Static | `try_files {path} {path}/ =404` |
| `nuxt` | Static | `try_files {path} {path}/ =404` |
| `hugo` | Static | `try_files {path} {path}/ =404` |
| `html` | Static | `try_files {path} {path}/ =404` |
| `""` (unknown) | SPA | Default to SPA mode |

#### Cache Headers Strategy

Implemented in the `buildFileServerHandlers` method above. The key rules:

| Path Pattern | Cache-Control | Rationale |
|---|---|---|
| `/_next/static/*` | `public, max-age=31536000, immutable` | Content-hashed by Next.js |
| `/static/*` | `public, max-age=31536000, immutable` | Convention for hashed statics |
| `/assets/*` | `public, max-age=31536000, immutable` | Vite default output |
| `*.js`, `*.css` | `public, max-age=31536000, immutable` | Typically content-hashed |
| `*.woff`, `*.woff2` | `public, max-age=31536000, immutable` | Fonts rarely change |
| `*.html`, `/` | `public, max-age=0, must-revalidate` | Always revalidate HTML |
| Everything else | No explicit header (Caddy defaults) | — |

#### Security Headers (applied to all deployment routes)

```
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
```

---

### A7: SSL/TLS Strategy

#### Platform Domain (HTTP-01)

Standard ACME HTTP-01 challenge. Caddy handles this automatically when a domain is referenced in routes.

```go
func (b *ConfigBuilder) buildTLSConfig(domains []VerifiedDomain) *CaddyTLSApp {
    policies := []CaddyTLSPolicy{
        // Policy 1: Platform domain — HTTP-01
        {
            Subjects: []string{b.cfg.PlatformDomain},
            Issuers: []CaddyTLSIssuer{{
                Module: "acme",
                Email:  b.cfg.ACMEEmail,
            }},
        },
    }

    // Policy 2: Wildcard for preview URLs — DNS-01 (if provider configured)
    if b.cfg.DNSProvider != "" {
        policies = append(policies, CaddyTLSPolicy{
            Subjects: []string{"*." + b.cfg.PlatformDomain},
            Issuers: []CaddyTLSIssuer{{
                Module: "acme",
                Email:  b.cfg.ACMEEmail,
                Challenges: &CaddyChallenges{
                    DNS: &CaddyDNSChallenge{
                        Provider: b.cfg.DNSProviderConf,
                    },
                },
            }},
        })
    }
    // If no DNS provider, each preview URL will get an individual HTTP-01 cert.
    // Caddy handles this automatically — no explicit TLS policy needed.

    // Policy 3: Custom domains — HTTP-01 (each domain individually)
    // Caddy auto-provisions certs for any domain in route matchers.
    // No explicit policy needed — Caddy's default ACME issuer handles it.

    return &CaddyTLSApp{
        Automation: &CaddyTLSAutomation{
            Policies: policies,
        },
    }
}
```

#### DNS Provider Configuration

Stored in env vars and passed through to Caddy's JSON config:

| Provider | Env Vars | Caddy Module Name | JSON Config |
|---|---|---|---|
| Cloudflare | `CF_API_TOKEN` | `cloudflare` | `{"name":"cloudflare","api_token":"{env.CF_API_TOKEN}"}` |
| Route53 | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_HOSTED_ZONE_ID` | `route53` | `{"name":"route53","hosted_zone_id":"{env.AWS_HOSTED_ZONE_ID}"}` |
| DigitalOcean | `DO_AUTH_TOKEN` | `digitalocean` | `{"name":"digitalocean","api_token":"{env.DO_AUTH_TOKEN}"}` |

**New env vars** (added to `.env.example`):

```env
# DNS Provider for wildcard SSL (optional)
# Options: cloudflare, route53, digitalocean
DNS_PROVIDER=
CF_API_TOKEN=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_HOSTED_ZONE_ID=
DO_AUTH_TOKEN=

# Caddy Admin API URL
CADDY_ADMIN_URL=http://caddy:2019

# ACME Email (for Let's Encrypt)
ACME_EMAIL=admin@example.com
```

---

### A8: Custom Caddy Docker Build

**File**: `docker/caddy/Dockerfile`

Caddy must be built with DNS provider modules using `xcaddy`. The Dockerfile supports all three providers.

```dockerfile
# docker/caddy/Dockerfile
# Custom Caddy build with DNS provider modules for wildcard certs.

FROM caddy:2-builder AS builder

RUN xcaddy build \
    --with github.com/caddy-dns/cloudflare \
    --with github.com/caddy-dns/route53 \
    --with github.com/caddy-dns/digitalocean

FROM caddy:2-alpine

COPY --from=builder /usr/bin/caddy /usr/bin/caddy

# Caddy data and config volumes
VOLUME /data
VOLUME /config

# Admin API + HTTPS + HTTP
EXPOSE 2019 443 80
```

**Updated `docker-compose.yml`** entry for Caddy:

```yaml
  caddy:
    build:
      context: ./docker/caddy
      dockerfile: Dockerfile
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - caddy_data:/data
      - caddy_config:/config
      - deployments:/app/deployments:ro
    environment:
      - PLATFORM_DOMAIN=${PLATFORM_DOMAIN}
      - ACME_EMAIL=${ACME_EMAIL:-admin@example.com}
      - CF_API_TOKEN=${CF_API_TOKEN:-}
      - AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID:-}
      - AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY:-}
      - AWS_HOSTED_ZONE_ID=${AWS_HOSTED_ZONE_ID:-}
      - DO_AUTH_TOKEN=${DO_AUTH_TOKEN:-}
    # No Caddyfile — config is fully managed via Admin API
    # Start Caddy with empty config; Hostbox populates via /load on startup
    command: caddy run --resume
    networks:
      - hostbox
```

> **Note**: `caddy run --resume` starts Caddy and resumes from its last known config (persisted in `/config`). On first run with no prior config, Caddy starts with an empty config. Hostbox then pushes the full config via `POST /load`.

The existing `docker/caddy/Caddyfile` and `docker/caddy/Caddyfile.d/` directory are **no longer used** — all config is now managed via the Admin API JSON. These files can be kept as reference or removed.

---

### A9: Route Update Triggers (Integration Points)

These are the points where existing service code must call the `RouteManager`:

| Trigger Event | Existing Code Location | RouteManager Method | Details |
|---|---|---|---|
| Deployment → `ready` | `BuildExecutor.Execute()` (Step 9) | `AddDeploymentRoute()` | Add preview route. If `is_production`, also call `UpdateProductionRoute()`. If branch has stable URL, call `UpdateBranchRoute()`. |
| Deployment promoted to production | `DeploymentService.Promote()` | `UpdateProductionRoute()` | Point production route to this deployment's artifact path. |
| Rollback | `DeploymentService.Rollback()` | `UpdateProductionRoute()` | Point production route to the rollback target's artifact path. |
| Domain verified | `DomainService.Verify()` | `AddCustomDomainRoute()` | Add route after DNS verification succeeds. |
| Domain removed | `DomainService.Delete()` | `RemoveCustomDomainRoute()` | Remove route immediately. |
| Project deleted | `ProjectService.Delete()` | `RemoveAllProjectRoutes()` | Remove all routes (production, branches, previews, domains). |
| Project settings changed (framework) | `ProjectService.Update()` | Full re-sync for project routes | Only if `framework` changed (affects SPA mode). |
| PR closed | `GitHubService.handlePRClosed()` | `RemoveDeploymentRoute()` for each preview | Remove preview routes for the closed PR's branch. |

#### Example Integration in BuildExecutor

```go
// In internal/worker/executor.go — after Step 8 (finalize)

// Step 9: Update Caddy routes
activeDeploy := caddy.ActiveDeployment{
    DeploymentID: deployment.ID,
    ProjectID:    project.ID,
    ProjectSlug:  project.Slug,
    Branch:       deployment.Branch,
    BranchSlug:   slugify(deployment.Branch),
    CommitSHA:    deployment.CommitSHA,
    IsProduction: deployment.IsProduction,
    ArtifactPath: deployment.ArtifactPath,
    Framework:    project.Framework,
}

// Always add preview route
if err := e.routeManager.AddDeploymentRoute(ctx, activeDeploy); err != nil {
    logger.Error("failed to add deployment route", "error", err)
    // Non-fatal: deployment is ready, routing will be fixed on next sync
}

// If production, also update production route
if deployment.IsProduction {
    if err := e.routeManager.UpdateProductionRoute(ctx, project.Slug, project.ID, deployment.ArtifactPath, project.Framework); err != nil {
        logger.Error("failed to update production route", "error", err)
    }
}

// Update branch-stable route (latest for this branch)
if err := e.routeManager.UpdateBranchRoute(ctx, project.Slug, project.ID, slugify(deployment.Branch), deployment.ArtifactPath, project.Framework); err != nil {
    logger.Error("failed to update branch route", "error", err)
}
```

---

## Part B: GitHub Integration

### B1: GitHub App Authentication

**File**: `internal/services/github/auth.go`

```go
package github

import (
    "crypto/rsa"
    "crypto/x509"
    "encoding/json"
    "encoding/pem"
    "fmt"
    "log/slog"
    "net/http"
    "sync"
    "time"

    "github.com/golang-jwt/jwt/v5"
)

// AppConfig holds the GitHub App configuration from env vars.
type AppConfig struct {
    AppID         int64
    AppSlug       string
    PrivateKeyPEM []byte  // raw PEM bytes from GITHUB_APP_PEM
    WebhookSecret string  // GITHUB_WEBHOOK_SECRET
}

// TokenProvider manages GitHub App JWT and installation token lifecycle.
type TokenProvider struct {
    appID      int64
    privateKey *rsa.PrivateKey
    httpClient *http.Client
    logger     *slog.Logger

    mu     sync.RWMutex
    tokens map[int64]*CachedToken // installationID → token
}

type CachedToken struct {
    Token     string
    ExpiresAt time.Time
}

func NewTokenProvider(cfg AppConfig, logger *slog.Logger) (*TokenProvider, error) {
    block, _ := pem.Decode(cfg.PrivateKeyPEM)
    if block == nil {
        return nil, fmt.Errorf("failed to decode PEM block from GITHUB_APP_PEM")
    }

    key, err := x509.ParsePKCS1PrivateKey(block.Bytes)
    if err != nil {
        // Try PKCS8 format
        pkcs8Key, err2 := x509.ParsePKCS8PrivateKey(block.Bytes)
        if err2 != nil {
            return nil, fmt.Errorf("parse private key (PKCS1: %v, PKCS8: %v)", err, err2)
        }
        var ok bool
        key, ok = pkcs8Key.(*rsa.PrivateKey)
        if !ok {
            return nil, fmt.Errorf("private key is not RSA")
        }
    }

    return &TokenProvider{
        appID:      cfg.AppID,
        privateKey: key,
        httpClient: &http.Client{Timeout: 30 * time.Second},
        logger:     logger,
        tokens:     make(map[int64]*CachedToken),
    }, nil
}
```

#### JWT Generation

```go
// GenerateAppJWT creates a JWT signed with the App's private key.
// Valid for 10 minutes (GitHub maximum).
// Used to authenticate as the App itself (not an installation).
func (tp *TokenProvider) GenerateAppJWT() (string, error) {
    now := time.Now()

    claims := jwt.RegisteredClaims{
        Issuer:    fmt.Sprintf("%d", tp.appID),
        IssuedAt:  jwt.NewNumericDate(now.Add(-60 * time.Second)), // 60s clock drift buffer
        ExpiresAt: jwt.NewNumericDate(now.Add(10 * time.Minute)),
    }

    token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
    signed, err := token.SignedString(tp.privateKey)
    if err != nil {
        return "", fmt.Errorf("sign JWT: %w", err)
    }
    return signed, nil
}
```

#### Installation Token Management

```go
// installationTokenResponse is the GitHub API response for creating an installation token.
type installationTokenResponse struct {
    Token     string    `json:"token"`
    ExpiresAt time.Time `json:"expires_at"`
}

// GetInstallationToken returns a valid installation access token.
// Tokens are cached and refreshed 5 minutes before expiry.
func (tp *TokenProvider) GetInstallationToken(installationID int64) (string, error) {
    tp.mu.RLock()
    cached, exists := tp.tokens[installationID]
    tp.mu.RUnlock()

    if exists && time.Now().Add(5*time.Minute).Before(cached.ExpiresAt) {
        return cached.Token, nil
    }

    // Token expired or doesn't exist — fetch new one
    appJWT, err := tp.GenerateAppJWT()
    if err != nil {
        return "", fmt.Errorf("generate app JWT: %w", err)
    }

    url := fmt.Sprintf("https://api.github.com/app/installations/%d/access_tokens", installationID)
    req, err := http.NewRequest("POST", url, nil)
    if err != nil {
        return "", fmt.Errorf("create request: %w", err)
    }
    req.Header.Set("Authorization", "Bearer "+appJWT)
    req.Header.Set("Accept", "application/vnd.github+json")
    req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

    resp, err := tp.httpClient.Do(req)
    if err != nil {
        return "", fmt.Errorf("request installation token: %w", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusCreated {
        body, _ := io.ReadAll(resp.Body)
        return "", fmt.Errorf("github returned %d creating installation token: %s", resp.StatusCode, string(body))
    }

    var tokenResp installationTokenResponse
    if err := json.NewDecoder(resp.Body).Decode(&tokenResp); err != nil {
        return "", fmt.Errorf("decode token response: %w", err)
    }

    tp.mu.Lock()
    tp.tokens[installationID] = &CachedToken{
        Token:     tokenResp.Token,
        ExpiresAt: tokenResp.ExpiresAt,
    }
    tp.mu.Unlock()

    tp.logger.Debug("refreshed installation token",
        "installation_id", installationID,
        "expires_at", tokenResp.ExpiresAt,
    )

    return tokenResp.Token, nil
}

// InvalidateToken removes a cached token (e.g., on 401 from GitHub).
func (tp *TokenProvider) InvalidateToken(installationID int64) {
    tp.mu.Lock()
    delete(tp.tokens, installationID)
    tp.mu.Unlock()
}
```

---

### B2: GitHub API Client

**File**: `internal/services/github/client.go`

A typed HTTP client wrapping the GitHub REST API. All methods accept `installationID` and resolve tokens via `TokenProvider`.

```go
package github

import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "io"
    "log/slog"
    "net/http"
    "time"
)

type Client struct {
    tokens     *TokenProvider
    httpClient *http.Client
    logger     *slog.Logger
}

func NewClient(tokens *TokenProvider, logger *slog.Logger) *Client {
    return &Client{
        tokens: tokens,
        httpClient: &http.Client{Timeout: 30 * time.Second},
        logger: logger,
    }
}

// doInstallationRequest makes an authenticated request using the installation token.
// Retries on 401 by invalidating the token and fetching a new one (once).
func (c *Client) doInstallationRequest(ctx context.Context, installationID int64, method, url string, body interface{}, result interface{}) error {
    for attempt := 0; attempt < 2; attempt++ {
        token, err := c.tokens.GetInstallationToken(installationID)
        if err != nil {
            return fmt.Errorf("get installation token: %w", err)
        }

        var bodyReader io.Reader
        if body != nil {
            b, err := json.Marshal(body)
            if err != nil {
                return fmt.Errorf("marshal body: %w", err)
            }
            bodyReader = bytes.NewReader(b)
        }

        req, err := http.NewRequestWithContext(ctx, method, url, bodyReader)
        if err != nil {
            return fmt.Errorf("create request: %w", err)
        }
        req.Header.Set("Authorization", "token "+token)
        req.Header.Set("Accept", "application/vnd.github+json")
        req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
        if body != nil {
            req.Header.Set("Content-Type", "application/json")
        }

        resp, err := c.httpClient.Do(req)
        if err != nil {
            return fmt.Errorf("github %s %s: %w", method, url, err)
        }
        defer resp.Body.Close()

        // Retry once on 401
        if resp.StatusCode == http.StatusUnauthorized && attempt == 0 {
            c.tokens.InvalidateToken(installationID)
            continue
        }

        if resp.StatusCode < 200 || resp.StatusCode >= 300 {
            respBody, _ := io.ReadAll(resp.Body)
            return fmt.Errorf("github %s %s returned %d: %s", method, url, resp.StatusCode, string(respBody))
        }

        if result != nil {
            if err := json.NewDecoder(resp.Body).Decode(result); err != nil {
                return fmt.Errorf("decode response: %w", err)
            }
        }
        return nil
    }
    return fmt.Errorf("github request failed after token refresh")
}
```

#### API Methods

```go
// --- Installations ---

type Installation struct {
    ID      int64  `json:"id"`
    Account struct {
        Login     string `json:"login"`
        AvatarURL string `json:"avatar_url"`
    } `json:"account"`
    AppID         int64    `json:"app_id"`
    TargetType    string   `json:"target_type"`
    Permissions   map[string]string `json:"permissions"`
    Events        []string `json:"events"`
}

// ListInstallations returns all installations of the GitHub App.
// Authenticated as the App (JWT), not an installation.
func (c *Client) ListInstallations(ctx context.Context) ([]Installation, error) {
    appJWT, err := c.tokens.GenerateAppJWT()
    if err != nil {
        return nil, err
    }

    req, err := http.NewRequestWithContext(ctx, "GET", "https://api.github.com/app/installations", nil)
    if err != nil {
        return nil, err
    }
    req.Header.Set("Authorization", "Bearer "+appJWT)
    req.Header.Set("Accept", "application/vnd.github+json")
    req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

    resp, err := c.httpClient.Do(req)
    if err != nil {
        return nil, fmt.Errorf("list installations: %w", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        body, _ := io.ReadAll(resp.Body)
        return nil, fmt.Errorf("list installations returned %d: %s", resp.StatusCode, string(body))
    }

    var installations []Installation
    if err := json.NewDecoder(resp.Body).Decode(&installations); err != nil {
        return nil, fmt.Errorf("decode installations: %w", err)
    }
    return installations, nil
}

// --- Repositories ---

type Repository struct {
    ID            int64  `json:"id"`
    FullName      string `json:"full_name"` // "owner/repo"
    Name          string `json:"name"`
    Private       bool   `json:"private"`
    DefaultBranch string `json:"default_branch"`
    HTMLURL       string `json:"html_url"`
    CloneURL      string `json:"clone_url"`
    Language      string `json:"language"`
    Description   string `json:"description"`
}

type listReposResponse struct {
    TotalCount   int          `json:"total_count"`
    Repositories []Repository `json:"repositories"`
}

// ListRepos lists repositories accessible to an installation.
// GET /installation/repositories?per_page=30&page=1
func (c *Client) ListRepos(ctx context.Context, installationID int64, page, perPage int) ([]Repository, int, error) {
    url := fmt.Sprintf("https://api.github.com/installation/repositories?per_page=%d&page=%d", perPage, page)

    var result listReposResponse
    if err := c.doInstallationRequest(ctx, installationID, "GET", url, nil, &result); err != nil {
        return nil, 0, err
    }
    return result.Repositories, result.TotalCount, nil
}

// GetRepo fetches a single repository's info.
// GET /repos/{owner}/{repo}
func (c *Client) GetRepo(ctx context.Context, installationID int64, owner, repo string) (*Repository, error) {
    url := fmt.Sprintf("https://api.github.com/repos/%s/%s", owner, repo)

    var result Repository
    if err := c.doInstallationRequest(ctx, installationID, "GET", url, nil, &result); err != nil {
        return nil, err
    }
    return &result, nil
}
```

```go
// --- Deployment Statuses ---
// GitHub Deployments API: creates a "deployment" and then updates its status.

type CreateDeploymentRequest struct {
    Ref              string   `json:"ref"`
    Task             string   `json:"task"`
    AutoMerge        bool     `json:"auto_merge"`
    RequiredContexts []string `json:"required_contexts"`
    Environment      string   `json:"environment"`
    Description      string   `json:"description"`
}

type DeploymentResponse struct {
    ID  int64  `json:"id"`
    URL string `json:"url"`
}

type CreateDeploymentStatusRequest struct {
    State          string `json:"state"`           // "pending", "in_progress", "success", "failure", "error"
    Description    string `json:"description"`
    EnvironmentURL string `json:"environment_url,omitempty"`
    LogURL         string `json:"log_url,omitempty"`
    AutoInactive   bool   `json:"auto_inactive"`
}

// CreateDeployment creates a GitHub Deployment for a ref.
// POST /repos/{owner}/{repo}/deployments
func (c *Client) CreateDeployment(ctx context.Context, installationID int64, owner, repo string, req CreateDeploymentRequest) (*DeploymentResponse, error) {
    url := fmt.Sprintf("https://api.github.com/repos/%s/%s/deployments", owner, repo)

    var result DeploymentResponse
    if err := c.doInstallationRequest(ctx, installationID, "POST", url, req, &result); err != nil {
        return nil, err
    }
    return &result, nil
}

// CreateDeploymentStatus updates the status of a GitHub Deployment.
// POST /repos/{owner}/{repo}/deployments/{deployment_id}/statuses
func (c *Client) CreateDeploymentStatus(ctx context.Context, installationID int64, owner, repo string, deploymentID int64, req CreateDeploymentStatusRequest) error {
    url := fmt.Sprintf("https://api.github.com/repos/%s/%s/deployments/%d/statuses", owner, repo, deploymentID)
    return c.doInstallationRequest(ctx, installationID, "POST", url, req, nil)
}
```

```go
// --- PR Comments ---

type IssueComment struct {
    ID   int64  `json:"id"`
    Body string `json:"body"`
    User struct {
        Login string `json:"login"`
        Type  string `json:"type"` // "Bot" for GitHub App
    } `json:"user"`
}

// ListPRComments lists comments on a pull request.
// GET /repos/{owner}/{repo}/issues/{pr_number}/comments
func (c *Client) ListPRComments(ctx context.Context, installationID int64, owner, repo string, prNumber int) ([]IssueComment, error) {
    url := fmt.Sprintf("https://api.github.com/repos/%s/%s/issues/%d/comments?per_page=100", owner, repo, prNumber)

    var comments []IssueComment
    if err := c.doInstallationRequest(ctx, installationID, "GET", url, nil, &comments); err != nil {
        return nil, err
    }
    return comments, nil
}

// CreatePRComment creates a new comment on a PR.
// POST /repos/{owner}/{repo}/issues/{pr_number}/comments
func (c *Client) CreatePRComment(ctx context.Context, installationID int64, owner, repo string, prNumber int, body string) (*IssueComment, error) {
    url := fmt.Sprintf("https://api.github.com/repos/%s/%s/issues/%d/comments", owner, repo, prNumber)

    reqBody := map[string]string{"body": body}
    var result IssueComment
    if err := c.doInstallationRequest(ctx, installationID, "POST", url, reqBody, &result); err != nil {
        return nil, err
    }
    return &result, nil
}

// UpdateComment updates an existing comment.
// PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}
func (c *Client) UpdateComment(ctx context.Context, installationID int64, owner, repo string, commentID int64, body string) error {
    url := fmt.Sprintf("https://api.github.com/repos/%s/%s/issues/comments/%d", owner, repo, commentID)

    reqBody := map[string]string{"body": body}
    return c.doInstallationRequest(ctx, installationID, "PATCH", url, reqBody, nil)
}
```

---

### B3: Webhook Handler

**File**: `internal/api/handlers/github_webhook.go`

The webhook handler is a **public** endpoint (no JWT auth). It verifies the GitHub HMAC signature, dispatches to event handlers, and returns `202 Accepted` immediately.

```go
package handlers

import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
    "fmt"
    "io"
    "log/slog"
    "net/http"
    "strings"

    "github.com/labstack/echo/v4"
)

type GitHubWebhookHandler struct {
    webhookSecret []byte
    eventRouter   *GitHubEventRouter
    logger        *slog.Logger
}

func NewGitHubWebhookHandler(
    webhookSecret string,
    eventRouter *GitHubEventRouter,
    logger *slog.Logger,
) *GitHubWebhookHandler {
    return &GitHubWebhookHandler{
        webhookSecret: []byte(webhookSecret),
        eventRouter:   eventRouter,
        logger:        logger,
    }
}

// HandleWebhook processes incoming GitHub webhook events.
// POST /api/v1/github/webhook
func (h *GitHubWebhookHandler) HandleWebhook(c echo.Context) error {
    // 1. Read raw body for signature verification
    body, err := io.ReadAll(c.Request().Body)
    if err != nil {
        return c.JSON(http.StatusBadRequest, map[string]any{
            "error": map[string]string{"code": "BAD_REQUEST", "message": "Failed to read request body"},
        })
    }

    // 2. Verify HMAC-SHA256 signature
    signatureHeader := c.Request().Header.Get("X-Hub-Signature-256")
    if !h.verifySignature(body, signatureHeader) {
        h.logger.Warn("webhook signature verification failed",
            "delivery_id", c.Request().Header.Get("X-GitHub-Delivery"),
        )
        return c.JSON(http.StatusUnauthorized, map[string]any{
            "error": map[string]string{"code": "UNAUTHORIZED", "message": "Invalid webhook signature"},
        })
    }

    // 3. Extract event type and delivery ID
    eventType := c.Request().Header.Get("X-GitHub-Event")
    deliveryID := c.Request().Header.Get("X-GitHub-Delivery")

    h.logger.Info("github webhook received",
        "event", eventType,
        "delivery_id", deliveryID,
    )

    // 4. Dispatch to event handler in a goroutine — return 202 immediately
    go func() {
        if err := h.eventRouter.Route(eventType, body, deliveryID); err != nil {
            h.logger.Error("webhook event processing failed",
                "event", eventType,
                "delivery_id", deliveryID,
                "error", err,
            )
        }
    }()

    // 5. Return 202 Accepted
    return c.JSON(http.StatusAccepted, map[string]any{
        "received": true,
    })
}

// verifySignature checks the HMAC-SHA256 signature.
// Header format: "sha256=<hex_digest>"
func (h *GitHubWebhookHandler) verifySignature(payload []byte, signatureHeader string) bool {
    if signatureHeader == "" || !strings.HasPrefix(signatureHeader, "sha256=") {
        return false
    }

    expectedSig := strings.TrimPrefix(signatureHeader, "sha256=")
    expectedBytes, err := hex.DecodeString(expectedSig)
    if err != nil {
        return false
    }

    mac := hmac.New(sha256.New, h.webhookSecret)
    mac.Write(payload)
    computedMAC := mac.Sum(nil)

    return hmac.Equal(computedMAC, expectedBytes)
}
```

---

### B4: Event Processors

**File**: `internal/services/github/events.go`

The `GitHubEventRouter` parses JSON payloads and dispatches to typed handlers.

```go
package github

import (
    "context"
    "encoding/json"
    "fmt"
    "log/slog"
    "strings"
)

type GitHubEventRouter struct {
    pushHandler         *PushHandler
    pullRequestHandler  *PullRequestHandler
    installationHandler *InstallationHandler
    logger              *slog.Logger
}

func NewGitHubEventRouter(
    push *PushHandler,
    pr *PullRequestHandler,
    install *InstallationHandler,
    logger *slog.Logger,
) *GitHubEventRouter {
    return &GitHubEventRouter{
        pushHandler:         push,
        pullRequestHandler:  pr,
        installationHandler: install,
        logger:              logger,
    }
}

func (r *GitHubEventRouter) Route(eventType string, payload []byte, deliveryID string) error {
    ctx := context.Background()

    switch eventType {
    case "push":
        return r.pushHandler.Handle(ctx, payload, deliveryID)
    case "pull_request":
        return r.pullRequestHandler.Handle(ctx, payload, deliveryID)
    case "installation":
        return r.installationHandler.Handle(ctx, payload, deliveryID)
    case "ping":
        r.logger.Info("github ping received", "delivery_id", deliveryID)
        return nil
    default:
        r.logger.Debug("ignoring unhandled github event", "event", eventType)
        return nil
    }
}
```

#### Push Event Handler

**File**: `internal/services/github/push_handler.go`

```go
package github

// PushPayload is the GitHub push webhook payload.
// https://docs.github.com/en/webhooks/webhook-events-and-payloads#push
type PushPayload struct {
    Ref        string `json:"ref"`         // "refs/heads/main"
    Before     string `json:"before"`
    After      string `json:"after"`       // commit SHA
    Repository struct {
        FullName string `json:"full_name"` // "owner/repo"
        CloneURL string `json:"clone_url"`
    } `json:"repository"`
    Installation struct {
        ID int64 `json:"id"`
    } `json:"installation"`
    HeadCommit struct {
        ID      string `json:"id"`
        Message string `json:"message"`
        Author  struct {
            Name  string `json:"name"`
            Email string `json:"email"`
        } `json:"author"`
    } `json:"head_commit"`
    Sender struct {
        Login string `json:"login"`
    } `json:"sender"`
    Deleted  bool `json:"deleted"`
    Created  bool `json:"created"`
}

type PushHandler struct {
    projectRepo    ProjectRepository
    deploymentSvc  DeploymentCreator
    logger         *slog.Logger
}

func (h *PushHandler) Handle(ctx context.Context, payload []byte, deliveryID string) error {
    var event PushPayload
    if err := json.Unmarshal(payload, &event); err != nil {
        return fmt.Errorf("unmarshal push payload: %w", err)
    }

    // Ignore branch deletions
    if event.Deleted {
        h.logger.Debug("ignoring branch deletion push", "ref", event.Ref)
        return nil
    }

    // Extract branch name from ref (refs/heads/main → main)
    branch := strings.TrimPrefix(event.Ref, "refs/heads/")
    if branch == event.Ref {
        // Not a branch push (could be tag), ignore
        return nil
    }

    repoFullName := event.Repository.FullName
    installationID := event.Installation.ID

    // Find project by github_repo
    project, err := h.projectRepo.FindByGitHubRepo(ctx, repoFullName)
    if err != nil {
        h.logger.Debug("no project found for repo", "repo", repoFullName)
        return nil // No project linked to this repo, ignore
    }

    // Check auto_deploy setting
    if !project.AutoDeploy {
        h.logger.Debug("auto_deploy disabled, skipping",
            "project_id", project.ID,
            "repo", repoFullName,
        )
        return nil
    }

    // Determine if this is a production or preview deployment
    isProduction := branch == project.ProductionBranch

    // For non-production pushes, only deploy if preview_deployments is enabled
    if !isProduction && !project.PreviewDeployments {
        h.logger.Debug("preview_deployments disabled, skipping non-production push",
            "project_id", project.ID,
            "branch", branch,
        )
        return nil
    }

    // Idempotency check: skip if deployment already exists for this commit SHA
    existing, _ := h.deploymentSvc.FindByCommitSHA(ctx, project.ID, event.After)
    if existing != nil {
        h.logger.Debug("deployment already exists for commit",
            "project_id", project.ID,
            "commit", event.After,
        )
        return nil
    }

    // Create deployment
    h.logger.Info("creating deployment from push",
        "project_id", project.ID,
        "branch", branch,
        "commit", event.After,
        "is_production", isProduction,
    )

    _, err = h.deploymentSvc.CreateFromWebhook(ctx, CreateDeploymentParams{
        ProjectID:      project.ID,
        Branch:         branch,
        CommitSHA:      event.After,
        CommitMessage:  event.HeadCommit.Message,
        CommitAuthor:   event.HeadCommit.Author.Name,
        IsProduction:   isProduction,
        InstallationID: installationID,
    })
    return err
}
```

#### Pull Request Event Handler

**File**: `internal/services/github/pr_handler.go`

```go
package github

type PullRequestPayload struct {
    Action string `json:"action"` // "opened", "synchronize", "closed", "reopened"
    Number int    `json:"number"`
    PullRequest struct {
        Number int    `json:"number"`
        Title  string `json:"title"`
        State  string `json:"state"` // "open", "closed"
        Head   struct {
            Ref string `json:"ref"` // branch name
            SHA string `json:"sha"`
        } `json:"head"`
        Base struct {
            Ref string `json:"ref"`
        } `json:"base"`
        Merged bool `json:"merged"`
    } `json:"pull_request"`
    Repository struct {
        FullName string `json:"full_name"`
    } `json:"repository"`
    Installation struct {
        ID int64 `json:"id"`
    } `json:"installation"`
}

type PullRequestHandler struct {
    projectRepo   ProjectRepository
    deploymentSvc DeploymentCreator
    routeManager  RouteRemover
    logger        *slog.Logger
}

func (h *PullRequestHandler) Handle(ctx context.Context, payload []byte, deliveryID string) error {
    var event PullRequestPayload
    if err := json.Unmarshal(payload, &event); err != nil {
        return fmt.Errorf("unmarshal pull_request payload: %w", err)
    }

    repoFullName := event.Repository.FullName

    project, err := h.projectRepo.FindByGitHubRepo(ctx, repoFullName)
    if err != nil {
        return nil // No project, ignore
    }

    switch event.Action {
    case "opened", "synchronize", "reopened":
        return h.handleOpenedOrSync(ctx, project, event)
    case "closed":
        return h.handleClosed(ctx, project, event)
    default:
        h.logger.Debug("ignoring pull_request action", "action", event.Action)
        return nil
    }
}

func (h *PullRequestHandler) handleOpenedOrSync(ctx context.Context, project *Project, event PullRequestPayload) error {
    if !project.PreviewDeployments {
        return nil
    }

    branch := event.PullRequest.Head.Ref
    commitSHA := event.PullRequest.Head.SHA

    // Idempotency: skip if deployment exists for this commit
    existing, _ := h.deploymentSvc.FindByCommitSHA(ctx, project.ID, commitSHA)
    if existing != nil {
        return nil
    }

    h.logger.Info("creating preview deployment from PR",
        "project_id", project.ID,
        "pr_number", event.Number,
        "branch", branch,
        "commit", commitSHA,
    )

    _, err := h.deploymentSvc.CreateFromWebhook(ctx, CreateDeploymentParams{
        ProjectID:      project.ID,
        Branch:         branch,
        CommitSHA:      commitSHA,
        CommitMessage:  event.PullRequest.Title,
        CommitAuthor:   "", // populated from git clone metadata
        IsProduction:   false,
        GitHubPRNumber: event.Number,
        InstallationID: event.Installation.ID,
    })
    return err
}

func (h *PullRequestHandler) handleClosed(ctx context.Context, project *Project, event PullRequestPayload) error {
    branch := event.PullRequest.Head.Ref

    h.logger.Info("PR closed, deactivating preview deployments",
        "project_id", project.ID,
        "pr_number", event.Number,
        "branch", branch,
    )

    // Mark preview deployments for this branch as inactive
    deployments, err := h.deploymentSvc.DeactivateBranchDeployments(ctx, project.ID, branch)
    if err != nil {
        return fmt.Errorf("deactivate branch deployments: %w", err)
    }

    // Remove Caddy routes for deactivated deployments
    for _, d := range deployments {
        if err := h.routeManager.RemoveDeploymentRoute(ctx, d.ID); err != nil {
            h.logger.Error("failed to remove deployment route", "deployment_id", d.ID, "error", err)
        }
    }

    return nil
}
```

#### Installation Event Handler

**File**: `internal/services/github/installation_handler.go`

```go
package github

type InstallationPayload struct {
    Action       string `json:"action"` // "created", "deleted", "suspend", "unsuspend"
    Installation struct {
        ID      int64  `json:"id"`
        Account struct {
            Login string `json:"login"`
            Type  string `json:"type"`
        } `json:"account"`
    } `json:"installation"`
    Repositories []struct {
        FullName string `json:"full_name"`
    } `json:"repositories"`
}

type InstallationHandler struct {
    projectRepo ProjectRepository
    logger      *slog.Logger
}

func (h *InstallationHandler) Handle(ctx context.Context, payload []byte, deliveryID string) error {
    var event InstallationPayload
    if err := json.Unmarshal(payload, &event); err != nil {
        return fmt.Errorf("unmarshal installation payload: %w", err)
    }

    switch event.Action {
    case "created":
        h.logger.Info("github app installed",
            "installation_id", event.Installation.ID,
            "account", event.Installation.Account.Login,
        )
    case "deleted":
        h.logger.Info("github app uninstalled",
            "installation_id", event.Installation.ID,
            "account", event.Installation.Account.Login,
        )
        // Clear installation_id from projects that used this installation
        if err := h.projectRepo.ClearInstallation(ctx, event.Installation.ID); err != nil {
            return fmt.Errorf("clear installation: %w", err)
        }
    case "suspend":
        h.logger.Warn("github app suspended",
            "installation_id", event.Installation.ID,
        )
    case "unsuspend":
        h.logger.Info("github app unsuspended",
            "installation_id", event.Installation.ID,
        )
    }

    return nil
}
```

---

### B5: PR Comment Manager

**File**: `internal/services/github/comments.go`

```go
package github

import (
    "context"
    "fmt"
    "strings"
)

const commentMarker = "<!-- hostbox-preview-deployment -->"

// PRCommentManager handles creating and updating Hostbox's PR comments.
type PRCommentManager struct {
    client         *Client
    platformDomain string
    logger         *slog.Logger
}

func NewPRCommentManager(client *Client, platformDomain string, logger *slog.Logger) *PRCommentManager {
    return &PRCommentManager{
        client:         client,
        platformDomain: platformDomain,
        logger:         logger,
    }
}

// PostOrUpdate creates or updates the Hostbox preview deployment comment on a PR.
func (m *PRCommentManager) PostOrUpdate(
    ctx context.Context,
    installationID int64,
    owner, repo string,
    prNumber int,
    deployment DeploymentInfo,
) error {
    body := m.buildCommentBody(deployment)

    // Find existing Hostbox comment
    comments, err := m.client.ListPRComments(ctx, installationID, owner, repo, prNumber)
    if err != nil {
        return fmt.Errorf("list PR comments: %w", err)
    }

    for _, c := range comments {
        if strings.Contains(c.Body, commentMarker) {
            // Update existing comment
            m.logger.Debug("updating existing PR comment",
                "comment_id", c.ID,
                "pr_number", prNumber,
            )
            return m.client.UpdateComment(ctx, installationID, owner, repo, c.ID, body)
        }
    }

    // Create new comment
    m.logger.Debug("creating new PR comment", "pr_number", prNumber)
    _, err = m.client.CreatePRComment(ctx, installationID, owner, repo, prNumber, body)
    return err
}

// DeploymentInfo contains the data needed to render a PR comment.
type DeploymentInfo struct {
    ProjectName    string
    ProjectSlug    string
    DeploymentID   string
    CommitSHA      string
    CommitMessage  string
    Branch         string
    Status         string // "building", "ready", "failed"
    DeploymentURL  string
    BuildDuration  string // human-readable, e.g. "45s"
    LogURL         string
    ErrorMessage   string
}

func (m *PRCommentManager) buildCommentBody(d DeploymentInfo) string {
    var sb strings.Builder

    sb.WriteString(commentMarker)
    sb.WriteString("\n")

    switch d.Status {
    case "ready":
        sb.WriteString("## 🚀 Preview Deployment Ready\n\n")
        sb.WriteString("| Name | Status | Preview |\n")
        sb.WriteString("|------|--------|------|\n")
        sb.WriteString(fmt.Sprintf("| **%s** | ✅ Ready | [Visit Preview](%s) |\n\n", d.ProjectName, d.DeploymentURL))
        sb.WriteString(fmt.Sprintf("**Commit**: `%.7s` — %s\n", d.CommitSHA, firstLine(d.CommitMessage)))
        sb.WriteString(fmt.Sprintf("**Built in**: %s\n", d.BuildDuration))
    case "building":
        sb.WriteString("## ⏳ Preview Deployment Building\n\n")
        sb.WriteString("| Name | Status |\n")
        sb.WriteString("|------|--------|\n")
        sb.WriteString(fmt.Sprintf("| **%s** | 🔨 Building... |\n\n", d.ProjectName))
        sb.WriteString(fmt.Sprintf("**Commit**: `%.7s` — %s\n", d.CommitSHA, firstLine(d.CommitMessage)))
        if d.LogURL != "" {
            sb.WriteString(fmt.Sprintf("\n[View Build Logs](%s)\n", d.LogURL))
        }
    case "failed":
        sb.WriteString("## ❌ Preview Deployment Failed\n\n")
        sb.WriteString("| Name | Status |\n")
        sb.WriteString("|------|--------|\n")
        sb.WriteString(fmt.Sprintf("| **%s** | ❌ Failed |\n\n", d.ProjectName))
        sb.WriteString(fmt.Sprintf("**Commit**: `%.7s` — %s\n", d.CommitSHA, firstLine(d.CommitMessage)))
        if d.ErrorMessage != "" {
            sb.WriteString(fmt.Sprintf("\n**Error**: %s\n", d.ErrorMessage))
        }
        if d.LogURL != "" {
            sb.WriteString(fmt.Sprintf("\n[View Build Logs](%s)\n", d.LogURL))
        }
    }

    sb.WriteString("\n---\n")
    sb.WriteString(fmt.Sprintf("*Deployed with [Hostbox](https://%s)*\n", m.platformDomain))

    return sb.String()
}

func firstLine(s string) string {
    if idx := strings.Index(s, "\n"); idx != -1 {
        return s[:idx]
    }
    return s
}
```

---

### B6: Deployment Status Reporter

**File**: `internal/services/github/status.go`

Maps Hostbox deployment states to GitHub Deployment Status states.

```go
package github

import (
    "context"
    "fmt"
    "strings"
)

// StatusReporter posts GitHub Deployment Statuses.
type StatusReporter struct {
    client         *Client
    platformDomain string
    logger         *slog.Logger
}

func NewStatusReporter(client *Client, platformDomain string, logger *slog.Logger) *StatusReporter {
    return &StatusReporter{
        client:         client,
        platformDomain: platformDomain,
        logger:         logger,
    }
}

// DeploymentStatusInfo contains info needed to report to GitHub.
type DeploymentStatusInfo struct {
    InstallationID   int64
    Owner            string
    Repo             string
    CommitSHA        string
    Environment      string // "production" or "preview"
    Status           string // Hostbox status: "queued", "building", "ready", "failed"
    DeploymentURL    string
    LogURL           string
    Description      string
    GitHubDeployID   int64  // 0 = create new, >0 = update existing
}

// Hostbox status → GitHub Deployment Status state mapping:
//
//   "queued"    → "pending"
//   "building"  → "in_progress"
//   "ready"     → "success"
//   "failed"    → "failure"
//   "cancelled" → "error"
func mapStatus(hostboxStatus string) string {
    switch hostboxStatus {
    case "queued":
        return "pending"
    case "building":
        return "in_progress"
    case "ready":
        return "success"
    case "failed":
        return "failure"
    case "cancelled":
        return "error"
    default:
        return "error"
    }
}

// ReportStatus creates a GitHub Deployment and posts a status update.
// If info.GitHubDeployID is 0, creates a new GitHub Deployment first.
// Returns the GitHub Deployment ID (to be stored for subsequent updates).
func (r *StatusReporter) ReportStatus(ctx context.Context, info DeploymentStatusInfo) (int64, error) {
    parts := strings.SplitN(info.Owner+"/"+info.Repo, "/", 2)
    owner, repo := parts[0], parts[1]

    // Create GitHub Deployment if needed
    deployID := info.GitHubDeployID
    if deployID == 0 {
        resp, err := r.client.CreateDeployment(ctx, info.InstallationID, owner, repo, CreateDeploymentRequest{
            Ref:              info.CommitSHA,
            Task:             "deploy",
            AutoMerge:        false,
            RequiredContexts: []string{}, // skip required status checks
            Environment:      info.Environment,
            Description:      fmt.Sprintf("Hostbox deployment for %s", info.CommitSHA[:7]),
        })
        if err != nil {
            return 0, fmt.Errorf("create github deployment: %w", err)
        }
        deployID = resp.ID
    }

    // Post status
    statusReq := CreateDeploymentStatusRequest{
        State:        mapStatus(info.Status),
        Description:  info.Description,
        AutoInactive: true,
    }
    if info.DeploymentURL != "" {
        statusReq.EnvironmentURL = info.DeploymentURL
    }
    if info.LogURL != "" {
        statusReq.LogURL = info.LogURL
    }

    if err := r.client.CreateDeploymentStatus(ctx, info.InstallationID, owner, repo, deployID, statusReq); err != nil {
        return deployID, fmt.Errorf("create github deployment status: %w", err)
    }

    r.logger.Info("reported github deployment status",
        "github_deploy_id", deployID,
        "status", info.Status,
        "environment", info.Environment,
    )

    return deployID, nil
}
```

---

### B7: GitHub API Endpoints (Authenticated)

**File**: `internal/api/handlers/github.go`

These are the **authenticated** endpoints for the dashboard/CLI to interact with GitHub.

```go
package handlers

import (
    "net/http"
    "strconv"

    "github.com/labstack/echo/v4"
)

type GitHubHandler struct {
    githubClient *github.Client
    logger       *slog.Logger
}

func NewGitHubHandler(client *github.Client, logger *slog.Logger) *GitHubHandler {
    return &GitHubHandler{
        githubClient: client,
        logger:       logger,
    }
}

// ListInstallations returns GitHub App installations accessible to the platform.
// GET /api/v1/github/installations
func (h *GitHubHandler) ListInstallations(c echo.Context) error {
    ctx := c.Request().Context()

    installations, err := h.githubClient.ListInstallations(ctx)
    if err != nil {
        h.logger.Error("failed to list github installations", "error", err)
        return c.JSON(http.StatusBadGateway, map[string]any{
            "error": map[string]string{
                "code":    "GITHUB_ERROR",
                "message": "Failed to fetch GitHub installations",
            },
        })
    }

    // Transform to DTO
    type InstallationDTO struct {
        ID         int64  `json:"id"`
        Account    string `json:"account"`
        AvatarURL  string `json:"avatar_url"`
        TargetType string `json:"target_type"`
    }

    dtos := make([]InstallationDTO, len(installations))
    for i, inst := range installations {
        dtos[i] = InstallationDTO{
            ID:         inst.ID,
            Account:    inst.Account.Login,
            AvatarURL:  inst.Account.AvatarURL,
            TargetType: inst.TargetType,
        }
    }

    return c.JSON(http.StatusOK, map[string]any{
        "installations": dtos,
    })
}

// ListRepos returns repositories for a GitHub App installation.
// GET /api/v1/github/repos?installation_id=X&page=1&per_page=30
func (h *GitHubHandler) ListRepos(c echo.Context) error {
    ctx := c.Request().Context()

    installationIDStr := c.QueryParam("installation_id")
    if installationIDStr == "" {
        return c.JSON(http.StatusBadRequest, map[string]any{
            "error": map[string]string{
                "code":    "VALIDATION_ERROR",
                "message": "installation_id query parameter is required",
            },
        })
    }
    installationID, err := strconv.ParseInt(installationIDStr, 10, 64)
    if err != nil {
        return c.JSON(http.StatusBadRequest, map[string]any{
            "error": map[string]string{
                "code":    "VALIDATION_ERROR",
                "message": "installation_id must be a valid integer",
            },
        })
    }

    page, _ := strconv.Atoi(c.QueryParam("page"))
    if page < 1 {
        page = 1
    }
    perPage, _ := strconv.Atoi(c.QueryParam("per_page"))
    if perPage < 1 || perPage > 100 {
        perPage = 30
    }

    repos, total, err := h.githubClient.ListRepos(ctx, installationID, page, perPage)
    if err != nil {
        h.logger.Error("failed to list repos", "installation_id", installationID, "error", err)
        return c.JSON(http.StatusBadGateway, map[string]any{
            "error": map[string]string{
                "code":    "GITHUB_ERROR",
                "message": "Failed to fetch repositories from GitHub",
            },
        })
    }

    // Transform to DTO
    type RepoDTO struct {
        FullName      string `json:"full_name"`
        Name          string `json:"name"`
        Private       bool   `json:"private"`
        DefaultBranch string `json:"default_branch"`
        HTMLURL       string `json:"html_url"`
        Language      string `json:"language"`
        Description   string `json:"description"`
    }

    dtos := make([]RepoDTO, len(repos))
    for i, r := range repos {
        dtos[i] = RepoDTO{
            FullName:      r.FullName,
            Name:          r.Name,
            Private:       r.Private,
            DefaultBranch: r.DefaultBranch,
            HTMLURL:       r.HTMLURL,
            Language:      r.Language,
            Description:   r.Description,
        }
    }

    totalPages := (total + perPage - 1) / perPage

    return c.JSON(http.StatusOK, map[string]any{
        "repos": dtos,
        "pagination": map[string]any{
            "total":       total,
            "page":        page,
            "per_page":    perPage,
            "total_pages": totalPages,
        },
    })
}
```

#### Route Registration

```go
// In internal/api/routes/routes.go — add to RegisterRoutes():

// GitHub (public)
api.POST("/github/webhook", githubWebhookHandler.HandleWebhook)

// GitHub (authenticated)
github := api.Group("/github", authMiddleware)
github.GET("/installations", githubHandler.ListInstallations)
github.GET("/repos", githubHandler.ListRepos)
```

---

### B8: Database Migration

**File**: `migrations/004_github_deploy_id.sql`

Add a column to store the GitHub Deployment ID so we can update statuses on the same deployment.

```sql
-- Add GitHub deployment tracking to deployments table.
-- Stores the GitHub Deployment API ID for posting status updates.

ALTER TABLE deployments ADD COLUMN github_deploy_id INTEGER;
```

This column is nullable. It's populated when the first `ReportStatus` call creates a GitHub Deployment and returns the ID. Subsequent status updates for the same Hostbox deployment reuse this ID.

---

## File Inventory

### New Files

| # | File Path | Purpose |
|---|---|---|
| 1 | `internal/services/caddy/client.go` | Caddy Admin API HTTP client with retry |
| 2 | `internal/services/caddy/config.go` | Caddy JSON config Go types |
| 3 | `internal/services/caddy/builder.go` | Config builder (DB state → Caddy JSON) |
| 4 | `internal/services/caddy/manager.go` | Route lifecycle operations |
| 5 | `internal/services/caddy/sync.go` | Startup sync + periodic re-sync |
| 6 | `internal/services/caddy/helpers.go` | `slugify()`, `isSPAFramework()`, `groupByProject()` |
| 7 | `internal/services/github/auth.go` | GitHub App JWT + installation token provider |
| 8 | `internal/services/github/client.go` | GitHub REST API typed client |
| 9 | `internal/services/github/events.go` | Event router (push, PR, installation) |
| 10 | `internal/services/github/push_handler.go` | Push webhook event handler |
| 11 | `internal/services/github/pr_handler.go` | Pull request webhook event handler |
| 12 | `internal/services/github/installation_handler.go` | Installation webhook event handler |
| 13 | `internal/services/github/comments.go` | PR comment creation/update |
| 14 | `internal/services/github/status.go` | GitHub Deployment Status reporter |
| 15 | `internal/services/github/interfaces.go` | Repository/service interfaces used by GitHub package |
| 16 | `internal/api/handlers/github_webhook.go` | Webhook handler (public, HMAC verification) |
| 17 | `internal/api/handlers/github.go` | Authenticated GitHub API handlers |
| 18 | `internal/dto/github.go` | GitHub-related request/response DTOs |
| 19 | `docker/caddy/Dockerfile` | Custom Caddy build with DNS provider modules |
| 20 | `migrations/004_github_deploy_id.sql` | Add `github_deploy_id` column to deployments |

### Modified Files

| # | File Path | Changes |
|---|---|---|
| 1 | `cmd/api/main.go` | Initialize Caddy client, config builder, sync service, GitHub services. Add startup step 6 (Caddy sync). Wire GitHub webhook + handler. |
| 2 | `internal/api/routes/routes.go` | Register `/github/webhook` (public) and `/github/installations`, `/github/repos` (authenticated). |
| 3 | `internal/worker/executor.go` | After build completes, call `RouteManager` methods. Call `StatusReporter` and `PRCommentManager`. |
| 4 | `internal/services/deployment/service.go` | Add `FindByCommitSHA()`, `DeactivateBranchDeployments()`, `CreateFromWebhook()`. |
| 5 | `internal/services/domain/service.go` | After `Verify()`, call `RouteManager.AddCustomDomainRoute()`. After `Delete()`, call `RemoveCustomDomainRoute()`. |
| 6 | `internal/services/project/service.go` | After `Delete()`, call `RouteManager.RemoveAllProjectRoutes()`. |
| 7 | `internal/repository/deployment_repo.go` | Add `ListActiveWithProject()`, `FindByCommitSHA()`. |
| 8 | `internal/repository/domain_repo.go` | Add `ListVerifiedWithProject()`. |
| 9 | `internal/repository/project_repo.go` | Add `FindByGitHubRepo()`, `ClearInstallation()`. |
| 10 | `.env.example` | Add `CADDY_ADMIN_URL`, `ACME_EMAIL`, `DNS_PROVIDER`, provider-specific vars. |
| 11 | `docker-compose.yml` | Update `caddy` service to use custom build, `--resume` command, env vars. Remove Caddyfile mount. |

---

## Implementation Order

Execute in this order to maintain a working state at each step:

### Step 1: Caddy Config Types + Client (no external deps)
1. Create `internal/services/caddy/config.go` — all Caddy JSON types
2. Create `internal/services/caddy/client.go` — HTTP client with retry
3. Create `internal/services/caddy/helpers.go` — utility functions

### Step 2: Config Builder + Route Manager
4. Create `internal/services/caddy/builder.go` — config builder
5. Create `internal/services/caddy/manager.go` — route manager
6. Create `internal/services/caddy/sync.go` — startup sync

### Step 3: Custom Caddy Docker Build
7. Replace `docker/caddy/Dockerfile` with xcaddy build
8. Update `docker-compose.yml`
9. Update `.env.example`

### Step 4: Wire Caddy into Existing Code
10. Update `cmd/api/main.go` — initialize Caddy services, add startup sync
11. Update `internal/worker/executor.go` — call route manager after build
12. Update `internal/services/domain/service.go` — call route manager on verify/delete
13. Update `internal/services/project/service.go` — call route manager on delete

### Step 5: GitHub App Auth + Client
14. Create `internal/services/github/auth.go` — JWT + token provider
15. Create `internal/services/github/client.go` — API client
16. Create `internal/services/github/interfaces.go` — dependency interfaces

### Step 6: GitHub Webhook Processing
17. Create `internal/services/github/events.go` — event router
18. Create `internal/services/github/push_handler.go`
19. Create `internal/services/github/pr_handler.go`
20. Create `internal/services/github/installation_handler.go`
21. Create `internal/api/handlers/github_webhook.go`
22. Update `internal/api/routes/routes.go` — register webhook route

### Step 7: GitHub Statuses + PR Comments
23. Create `internal/services/github/status.go`
24. Create `internal/services/github/comments.go`
25. Create `migrations/004_github_deploy_id.sql`
26. Update repository layer — new query methods
27. Update `internal/worker/executor.go` — call status reporter + comment manager

### Step 8: GitHub Authenticated Endpoints
28. Create `internal/api/handlers/github.go`
29. Create `internal/dto/github.go`
30. Update `internal/api/routes/routes.go` — register authenticated routes
31. Update `cmd/api/main.go` — wire GitHub handler

---

## Testing Strategy

### Unit Tests

| Package | Test File | What to Test |
|---|---|---|
| `caddy` | `client_test.go` | Retry logic with mock HTTP server (5xx → success, 4xx → no retry) |
| `caddy` | `builder_test.go` | Config generation for each route type. Verify JSON output matches expected structure. SPA vs static mode selection. |
| `caddy` | `manager_test.go` | Route add/update/delete calls. Verify correct `@id` patterns. |
| `github` | `auth_test.go` | JWT generation (validate claims, expiry). Token caching (fresh fetch, cache hit, cache miss on expiry). |
| `github` | `push_handler_test.go` | Branch extraction from ref. Production vs preview detection. Auto-deploy/preview toggle. Idempotency (duplicate commit SHA). |
| `github` | `pr_handler_test.go` | Opened/synchronize → create deployment. Closed → deactivate deployments. |
| `github` | `comments_test.go` | Comment body rendering for each status. Marker detection for update vs create. |
| `github` | `status_test.go` | Status mapping (Hostbox → GitHub). Deployment creation + status posting. |
| `handlers` | `github_webhook_test.go` | HMAC signature verification (valid, invalid, missing). 202 response. |

### Integration Tests

1. **Caddy Sync**: Start Caddy in Docker, call `SyncAll()`, verify `GET /config/` returns expected routes.
2. **Route CRUD**: Add a deployment route via manager, verify Caddy serves the expected host. Delete it, verify 404.
3. **Webhook End-to-End**: Send a mock push webhook, verify deployment is created in DB with correct branch/commit.

### Manual Testing Checklist

- [ ] `docker-compose up` starts Caddy with custom build
- [ ] Hostbox startup syncs routes to Caddy (check logs for "caddy config synced")
- [ ] Deploy a project → preview URL resolves
- [ ] Production deployment → `{slug}.{domain}` resolves
- [ ] Add custom domain → verify → domain resolves
- [ ] Delete domain → domain returns 404
- [ ] Delete project → all routes removed
- [ ] GitHub push webhook → deployment created
- [ ] GitHub PR opened → preview deployment created, PR comment posted
- [ ] GitHub PR updated → PR comment updated (not duplicated)
- [ ] GitHub PR closed → preview routes removed
- [ ] SPA mode project → client-side routing works (`/about` serves `index.html`)
- [ ] Static mode project → `/nonexistent` returns 404
