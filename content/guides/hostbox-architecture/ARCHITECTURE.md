# Hostbox — Technical Architecture

> End-to-end deep dive into every subsystem, data path, and integration point.

---

## Table of Contents

1. [High-Level System Design](#1-high-level-system-design)
2. [Process Model & Lifecycle](#2-process-model--lifecycle)
3. [Database Layer (SQLite)](#3-database-layer-sqlite)
4. [API Server Internals](#4-api-server-internals)
5. [Authentication & Session Architecture](#5-authentication--session-architecture)
6. [Build Pipeline Architecture](#6-build-pipeline-architecture)
7. [Caddy Integration Layer](#7-caddy-integration-layer)
8. [GitHub Integration Architecture](#8-github-integration-architecture)
9. [Log Streaming Architecture](#9-log-streaming-architecture)
10. [Environment Variable Encryption](#10-environment-variable-encryption)
11. [Notification System](#11-notification-system)
12. [Garbage Collection & Disk Management](#12-garbage-collection--disk-management)
13. [Embedded Web Dashboard](#13-embedded-web-dashboard)
14. [CLI Architecture](#14-cli-architecture)
15. [Docker & Container Strategy](#15-docker--container-strategy)
16. [Networking & DNS](#16-networking--dns)
17. [Error Handling & Resilience](#17-error-handling--resilience)
18. [Observability](#18-observability)
19. [Security Architecture](#19-security-architecture)
20. [Deployment & Upgrade Strategy](#20-deployment--upgrade-strategy)

---

## 1. High-Level System Design

### 1.1 Runtime Topology

In production, Hostbox runs as exactly **two OS-level processes** inside Docker containers on a single VPS:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Host OS (Ubuntu/Debian)                                                 │
│                                                                         │
│  Docker Engine                                                          │
│  ┌────────────────────────────────────────────┐  ┌───────────────────┐  │
│  │ Container: hostbox                          │  │ Container: caddy  │  │
│  │                                             │  │                   │  │
│  │  ┌─────────────────────────────────────┐    │  │  Caddy Server     │  │
│  │  │  Go Binary (single process)         │    │  │  :80 / :443       │  │
│  │  │                                     │    │  │                   │  │
│  │  │  main goroutine                     │    │  │  Admin API :2019  │  │
│  │  │    ├── HTTP Server (:8080)          │    │  │                   │  │
│  │  │    │    ├── API routes /api/v1/*    │    │  │  Routes:          │  │
│  │  │    │    ├── Dashboard static files  │    │  │  *.domain → files │  │
│  │  │    │    ├── SSE log streams         │    │  │  domain → :8080   │  │
│  │  │    │    └── GitHub webhook receiver │    │  └───────────────────┘  │
│  │  │    │                                │    │          ↕               │
│  │  │    ├── Build Worker Pool            │    │   Caddy Admin API       │
│  │  │    │    ├── Job dispatcher          │    │   localhost:2019        │
│  │  │    │    ├── Worker goroutine(s)     │    │                         │
│  │  │    │    └── Docker SDK client       │    │                         │
│  │  │    │                                │    │                         │
│  │  │    ├── Background Schedulers        │    │                         │
│  │  │    │    ├── Garbage collector       │    │                         │
│  │  │    │    ├── Session cleaner         │    │                         │
│  │  │    │    └── Domain re-verifier      │    │                         │
│  │  │    │                                │    │                         │
│  │  │    └── SQLite (in-process)          │    │                         │
│  │  │         └── /app/data/hostbox.db    │    │                         │
│  │  └─────────────────────────────────────┘    │                         │
│  └────────────────────────────────────────────┘                         │
│                                                                         │
│  Shared Volumes:                                                        │
│    /app/deployments/  ← Caddy reads (ro), Hostbox writes                │
│    /app/data/         ← SQLite DB (Hostbox only)                        │
│    /app/logs/         ← Build logs (Hostbox only)                       │
│    /cache/            ← node_modules cache (Hostbox only)               │
│    /var/run/docker.sock ← Hostbox uses to spawn build containers        │
│                                                                         │
│  Ephemeral Containers (created/destroyed per build):                    │
│    build-{deployment_id}  ← node:20-slim with resource limits           │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Inter-Process Communication

| From | To | Protocol | Purpose |
|------|----|----------|---------|
| Browser/CLI | Caddy | HTTPS (:443) | All external traffic |
| Caddy | Hostbox API | HTTP (localhost:8080) | Reverse proxy for `/api/*` and dashboard |
| Caddy | Filesystem | Direct read | Serve deployment artifacts |
| Hostbox | Caddy Admin API | HTTP (localhost:2019) | Dynamic route updates |
| Hostbox | Docker Engine | Unix socket | Create/destroy build containers |
| Hostbox | GitHub API | HTTPS | Clone repos, post statuses, PR comments |
| GitHub | Hostbox (via Caddy) | HTTPS webhook | Push/PR events |

### 1.3 Data Storage Layout

```
/app/
├── data/
│   └── hostbox.db             # SQLite database (WAL mode)
│   └── hostbox.db-wal         # Write-ahead log
│   └── hostbox.db-shm         # Shared memory file
├── deployments/
│   └── {project_id}/
│       └── {deployment_id}/   # Static build output
│           ├── index.html
│           ├── assets/
│           └── ...
├── logs/
│   └── {deployment_id}.log    # Build log (plain text)
└── tmp/
    └── clone-{deployment_id}/ # Temporary: git clone destination (deleted after build)

/cache/
└── {project_id}/
    ├── node_modules/          # Cached node_modules (Docker volume)
    └── build-cache/           # Framework cache (.next/cache, etc.)
```

---

## 2. Process Model & Lifecycle

### 2.1 Startup Sequence

```
main()
 │
 ├── 1. Load configuration (.env / environment variables)
 │      └── Validate required keys (PLATFORM_DOMAIN, JWT_SECRET, ENCRYPTION_KEY)
 │      └── Apply defaults for optional keys
 │
 ├── 2. Initialize SQLite connection
 │      └── Open /app/data/hostbox.db
 │      └── Enable WAL mode: PRAGMA journal_mode=WAL
 │      └── Set busy timeout: PRAGMA busy_timeout=5000
 │      └── Enable foreign keys: PRAGMA foreign_keys=ON
 │      └── Run pending migrations (embedded in binary)
 │
 ├── 3. Initialize service layer
 │      └── AuthService (JWT signing key, bcrypt)
 │      └── ProjectService (framework detector)
 │      └── DeploymentService
 │      └── BuildService (Docker client init)
 │      └── DomainService
 │      └── EnvVarService (encryption key init)
 │      └── GitHubService (App private key, webhook secret)
 │      └── NotificationService
 │      └── CleanupService
 │
 ├── 4. Initialize build worker pool
 │      └── Start N worker goroutines (default: 1)
 │      └── Recover any deployments stuck in "building" state → mark "failed"
 │      └── Process any deployments in "queued" state
 │
 ├── 5. Initialize background schedulers
 │      └── Garbage collector: every 6 hours
 │      └── Session cleaner: every 1 hour
 │      └── Domain re-verifier: every 24 hours
 │
 ├── 6. Sync Caddy configuration
 │      └── Read all active deployments + domains from DB
 │      └── Build complete Caddy JSON config
 │      └── POST to Caddy Admin API /load
 │
 ├── 7. Start HTTP server (:8080)
 │      └── Register all API routes
 │      └── Mount embedded static files for dashboard
 │      └── Begin accepting connections
 │
 └── 8. Block on signal (SIGINT/SIGTERM)
        └── On signal → graceful shutdown
```

### 2.2 Graceful Shutdown

```
Signal received (SIGINT/SIGTERM)
 │
 ├── 1. Stop accepting new HTTP connections
 ├── 2. Stop accepting new build jobs (close job channel)
 ├── 3. Wait for in-progress builds to complete (with 60s timeout)
 │      └── If timeout: kill running Docker containers
 ├── 4. Drain pending SSE connections
 ├── 5. Close SQLite connection (flush WAL)
 └── 6. Exit(0)
```

### 2.3 Crash Recovery

On startup, the worker pool performs crash recovery:

```go
// Find deployments stuck in 'building' state (server crashed mid-build)
stuck := repo.FindDeploymentsByStatus("building")
for _, d := range stuck {
    d.Status = "failed"
    d.ErrorMessage = "Build interrupted by server restart"
    repo.UpdateDeployment(d)
    
    // Clean up any orphaned Docker container
    docker.RemoveContainer("build-" + d.ID)
}
```

---

## 3. Database Layer (SQLite)

### 3.1 Connection Configuration

```go
db, _ := sql.Open("sqlite3", "file:/app/data/hostbox.db?_journal_mode=WAL&_busy_timeout=5000&_foreign_keys=ON&_synchronous=NORMAL")
db.SetMaxOpenConns(1)      // SQLite handles one writer at a time
db.SetMaxIdleConns(1)
db.SetConnMaxLifetime(0)   // Keep connection open forever
```

**Key decisions**:
- `MaxOpenConns=1`: SQLite supports only one writer. Multiple readers are fine in WAL mode, but Go's `database/sql` pool must serialize writes.
- `_synchronous=NORMAL`: Balance between safety and performance. In WAL mode, NORMAL is safe against data loss on application crash (but not power loss — for that, use FULL).
- All writes go through a single connection → no write contention.
- Reads are concurrent and never blocked by writes in WAL mode.

### 3.2 Migration System

Migrations are embedded in the Go binary using `embed.FS`:

```go
//go:embed migrations/*.sql
var migrationsFS embed.FS
```

Migration runner on startup:
1. Create `_migrations` table if not exists
2. Read all `*.sql` files from embedded FS, sorted by name
3. For each migration not yet applied:
   - Begin transaction
   - Execute SQL
   - Record in `_migrations` table
   - Commit

```sql
CREATE TABLE IF NOT EXISTS _migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
```

### 3.3 Repository Pattern

Each table has a dedicated repository struct with typed methods:

```go
type DeploymentRepository struct {
    db *sql.DB
}

func (r *DeploymentRepository) Create(d *models.Deployment) error { ... }
func (r *DeploymentRepository) GetByID(id string) (*models.Deployment, error) { ... }
func (r *DeploymentRepository) ListByProject(projectID string, page, perPage int) ([]models.Deployment, int, error) { ... }
func (r *DeploymentRepository) UpdateStatus(id, status string) error { ... }
func (r *DeploymentRepository) FindQueuedOrBuilding(projectID, branch string) (*models.Deployment, error) { ... }
```

All queries use parameterized statements. No raw string concatenation.

### 3.4 Transaction Handling

For operations that touch multiple tables (e.g., creating a project + initial settings):

```go
func (s *ProjectService) CreateProject(ctx context.Context, req dto.CreateProjectRequest) (*models.Project, error) {
    tx, _ := s.db.BeginTx(ctx, nil)
    defer tx.Rollback()

    project := &models.Project{ /* ... */ }
    if err := s.projectRepo.CreateTx(tx, project); err != nil {
        return nil, err
    }
    
    s.activityRepo.LogTx(tx, "project.created", "project", project.ID, nil)
    
    return project, tx.Commit()
}
```

---

## 4. API Server Internals

### 4.1 Framework: Echo v4

Echo is chosen for its performance, minimal allocations, and middleware ecosystem. The server is structured as:

```
Echo instance
 ├── Global Middleware (applied to all routes)
 │    ├── Recovery (panic → 500)
 │    ├── RequestID (X-Request-ID header)
 │    ├── Logger (structured JSON logs)
 │    ├── CORS (platform domain only)
 │    ├── Security headers (CSP, HSTS, etc.)
 │    └── Rate limiter (token bucket per IP)
 │
 ├── Public Routes (no auth)
 │    ├── GET  /api/v1/health
 │    ├── GET  /api/v1/setup/status
 │    ├── POST /api/v1/setup
 │    ├── POST /api/v1/auth/login
 │    ├── POST /api/v1/auth/register
 │    ├── POST /api/v1/auth/refresh
 │    ├── POST /api/v1/auth/forgot-password
 │    ├── POST /api/v1/auth/reset-password
 │    ├── POST /api/v1/auth/verify-email
 │    └── POST /api/v1/github/webhook
 │
 ├── Authenticated Routes (JWT middleware)
 │    ├── /api/v1/auth/me, /logout, /logout-all
 │    ├── /api/v1/projects/*
 │    ├── /api/v1/deployments/*
 │    ├── /api/v1/domains/*
 │    ├── /api/v1/env-vars/*
 │    ├── /api/v1/notifications/*
 │    └── /api/v1/github/repos, /installations
 │
 ├── Admin Routes (JWT + admin check middleware)
 │    ├── GET  /api/v1/admin/stats
 │    ├── GET  /api/v1/admin/activity
 │    ├── GET  /api/v1/admin/users
 │    └── POST /api/v1/admin/settings
 │
 └── Static Files (embedded dashboard)
      └── /* → embed.FS (index.html fallback for SPA routing)
```

### 4.2 Request Flow

```
Incoming HTTP request
 │
 ├── Echo Router matches route
 ├── Middleware chain executes (recovery → requestID → logger → cors → rateLimit)
 │
 ├── [If authenticated route] JWT Middleware:
 │    ├── Extract Bearer token from Authorization header
 │    ├── Validate JWT signature + expiry
 │    ├── Extract user_id from claims
 │    ├── Load user from DB (cached in request context)
 │    └── Set user in echo.Context
 │
 ├── Handler function:
 │    ├── Bind request body (JSON → DTO struct with validation tags)
 │    ├── Validate (echo's validator using go-playground/validator)
 │    ├── Call service method
 │    ├── Service calls repository (DB operations)
 │    ├── Log activity (if mutating operation)
 │    └── Return JSON response
 │
 └── Response sent (JSON with appropriate status code)
```

### 4.3 Request Validation

Using `go-playground/validator` for struct validation:

```go
type CreateProjectRequest struct {
    Name            string  `json:"name" validate:"required,min=1,max=100"`
    GitHubRepo      *string `json:"github_repo" validate:"omitempty,github_repo"`
    BuildCommand    *string `json:"build_command" validate:"omitempty,max=500"`
    InstallCommand  *string `json:"install_command" validate:"omitempty,max=500"`
    OutputDirectory *string `json:"output_directory" validate:"omitempty,max=255"`
    RootDirectory   *string `json:"root_directory" validate:"omitempty,max=255"`
    NodeVersion     *string `json:"node_version" validate:"omitempty,oneof=18 20 22"`
}
```

Custom validators registered:
- `github_repo`: matches `owner/repo` format
- `slug`: lowercase alphanumeric + hyphens
- `domain`: valid domain name format

### 4.4 Error Handling Pattern

All service errors are typed:

```go
type AppError struct {
    Code    string      `json:"code"`
    Message string      `json:"message"`
    Status  int         `json:"-"`
    Details []FieldError `json:"details,omitempty"`
}

// Usage in handlers:
func (h *ProjectHandler) Create(c echo.Context) error {
    project, err := h.service.Create(ctx, req)
    if err != nil {
        var appErr *AppError
        if errors.As(err, &appErr) {
            return c.JSON(appErr.Status, map[string]any{"error": appErr})
        }
        return c.JSON(500, map[string]any{"error": ErrInternal})
    }
    return c.JSON(201, map[string]any{"project": project})
}
```

### 4.5 Rate Limiter Architecture

Token bucket rate limiter per IP, implemented as middleware:

```go
type RateLimiter struct {
    buckets sync.Map  // map[string]*TokenBucket
    rate    int       // tokens per minute
    burst   int       // max burst size
}
```

Different limits for different route groups:
- Auth routes (`/auth/*`): 10 req/min per IP
- API routes: 100 req/min per authenticated user
- Webhook route: 500 req/min (GitHub can burst)

Stale buckets are cleaned up every 10 minutes to avoid memory leaks.

---

## 5. Authentication & Session Architecture

### 5.1 Token Flow

```
┌─────────────┐                  ┌─────────────┐
│   Client    │                  │   Hostbox   │
│ (Browser)   │                  │   API       │
└──────┬──────┘                  └──────┬──────┘
       │                                │
       │  POST /auth/login              │
       │  {email, password}             │
       │──────────────────────────────►│
       │                                │
       │                         Verify password (bcrypt)
       │                         Generate access_token (JWT, 15min)
       │                         Generate refresh_token (random, 7 days)
       │                         Store SHA-256(refresh_token) in sessions table
       │                                │
       │  200 OK                        │
       │  Body: {user, access_token}    │
       │  Set-Cookie: hostbox_refresh=  │
       │    {token}; HttpOnly; Secure;  │
       │    SameSite=Strict; Path=/     │
       │    api/v1/auth; Max-Age=7d     │
       │◄──────────────────────────────│
       │                                │
       │  GET /api/v1/projects          │
       │  Authorization: Bearer {at}    │
       │──────────────────────────────►│
       │                         Validate JWT signature + expiry
       │  200 OK {projects}             │
       │◄──────────────────────────────│
       │                                │
       │  [15min later: access_token    │
       │   expires]                     │
       │                                │
       │  POST /auth/refresh            │
       │  Cookie: hostbox_refresh={rt}  │
       │──────────────────────────────►│
       │                         Lookup SHA-256(rt) in sessions
       │                         Verify not expired
       │                         Generate new access_token
       │                         (Optional: rotate refresh token)
       │  200 OK {access_token}         │
       │◄──────────────────────────────│
```

### 5.2 JWT Structure

```json
{
  "header": {
    "alg": "HS256",
    "typ": "JWT"
  },
  "payload": {
    "sub": "user_nanoid_123",      // user ID
    "email": "user@example.com",
    "admin": true,
    "iat": 1705334400,             // issued at
    "exp": 1705335300              // expires (15 min)
  }
}
```

Signed with HMAC-SHA256 using `JWT_SECRET`.

### 5.3 Session Table Design

```
sessions table:
┌─────────┬──────────────────────┬───────────────┬────────────┐
│ id      │ refresh_token_hash   │ user_agent    │ expires_at │
├─────────┼──────────────────────┼───────────────┼────────────┤
│ sess_01 │ sha256(token_abc...) │ Chrome/120... │ 2024-01-22 │
│ sess_02 │ sha256(token_def...) │ hostbox-cli/1 │ 2024-01-22 │
└─────────┴──────────────────────┴───────────────┴────────────┘
```

- **Why hash the refresh token?** If the DB is compromised, raw tokens can't be extracted.
- **Multiple sessions**: A user can be logged in from browser AND CLI simultaneously.
- **Session cleanup**: Background goroutine deletes expired sessions every hour.

---

## 6. Build Pipeline Architecture

### 6.1 Overall Pipeline

```
Webhook/Manual Trigger
         │
         ▼
┌─────────────────┐
│ Deployment      │  Created in DB with status='queued'
│ Record Created  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Job Queue       │  In-memory channel + SQLite backup
│ (buffered chan)  │
└────────┬────────┘
         │ Worker picks up job
         ▼
┌─────────────────────────────────────────────────────────┐
│ Build Executor                                          │
│                                                          │
│  1. Clone ──► 2. Detect ──► 3. Container ──► 4. Build   │
│                                                          │
│  ┌──────────────────────────────────────────┐            │
│  │ Step 1: Clone Repository                 │            │
│  │ git clone --depth=1 --branch={branch}    │            │
│  │ Using GitHub App installation token      │            │
│  │ Destination: /app/tmp/clone-{deploy_id}/ │            │
│  └──────────────────────────────────────────┘            │
│                                                          │
│  ┌──────────────────────────────────────────┐            │
│  │ Step 2: Detect Framework                 │            │
│  │ Read package.json from cloned source     │            │
│  │ Identify: framework, pkg manager, cmds   │            │
│  │ Merge with project overrides             │            │
│  └──────────────────────────────────────────┘            │
│                                                          │
│  ┌──────────────────────────────────────────┐            │
│  │ Step 3: Create Docker Container          │            │
│  │ Image: node:{version}-slim               │            │
│  │ Mounts: source + cache volumes           │            │
│  │ Env vars: scoped + built-in              │            │
│  │ Limits: memory, CPU, PID, timeout        │            │
│  │ Security: no-new-privileges, cap-drop    │            │
│  └──────────────────────────────────────────┘            │
│                                                          │
│  ┌──────────────────────────────────────────┐            │
│  │ Step 4: Execute Build                    │            │
│  │ Run install command → stream stdout/err  │            │
│  │ Run build command → stream stdout/err    │            │
│  │ Copy output dir to artifact path         │            │
│  │ Record artifact size                     │            │
│  └──────────────────────────────────────────┘            │
│                                                          │
└─────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────┐
│ Post-Build      │
│ ├── Update DB   │  status → ready/failed
│ ├── Update Caddy│  Add/update route via Admin API
│ ├── GitHub API  │  Deployment status + PR comment
│ ├── Notify      │  Discord/Slack/webhook
│ └── Cleanup     │  Remove container + clone dir
└─────────────────┘
```

### 6.2 Worker Pool Design

```go
type WorkerPool struct {
    jobs       chan string          // deployment IDs
    maxWorkers int
    wg         sync.WaitGroup
    ctx        context.Context
    cancel     context.CancelFunc
    executor   *BuildExecutor
}

func (p *WorkerPool) Start() {
    for i := 0; i < p.maxWorkers; i++ {
        p.wg.Add(1)
        go p.worker(i)
    }
}

func (p *WorkerPool) worker(id int) {
    defer p.wg.Done()
    for {
        select {
        case <-p.ctx.Done():
            return
        case deploymentID := <-p.jobs:
            p.executor.Execute(p.ctx, deploymentID)
        }
    }
}

func (p *WorkerPool) Enqueue(deploymentID string) {
    p.jobs <- deploymentID
}

func (p *WorkerPool) Shutdown() {
    p.cancel()
    p.wg.Wait()
}
```

### 6.3 Deployment Deduplication

```go
func (s *DeploymentService) CreateDeployment(projectID, branch, commitSHA string) (*Deployment, error) {
    // Cancel any existing queued/building deployment for same project+branch
    existing, _ := s.repo.FindQueuedOrBuilding(projectID, branch)
    if existing != nil {
        s.repo.UpdateStatus(existing.ID, "cancelled")
        // If building, also kill the Docker container
        if existing.Status == "building" {
            s.docker.StopContainer("build-" + existing.ID)
        }
    }
    
    // Create new deployment
    deployment := &models.Deployment{
        ID:        nanoid.New(),
        ProjectID: projectID,
        Branch:    branch,
        CommitSHA: commitSHA,
        Status:    "queued",
        // ...
    }
    s.repo.Create(deployment)
    s.workerPool.Enqueue(deployment.ID)
    return deployment, nil
}
```

### 6.4 Build Container Lifecycle

```go
func (e *BuildExecutor) Execute(ctx context.Context, deploymentID string) {
    deployment := e.repo.GetByID(deploymentID)
    project := e.projectRepo.GetByID(deployment.ProjectID)
    
    // Open log file
    logFile := e.openLogFile(deploymentID)
    defer logFile.Close()
    logger := NewBuildLogger(logFile, e.sseHub, deploymentID)
    
    e.repo.UpdateStatus(deploymentID, "building")
    startTime := time.Now()

    // Step 1: Clone
    logger.Info("Cloning repository...")
    cloneDir, err := e.cloneRepo(ctx, project, deployment)
    if err != nil {
        e.fail(deployment, "Clone failed: "+err.Error(), logger)
        return
    }
    defer os.RemoveAll(cloneDir)

    // Step 2: Detect framework
    logger.Info("Detecting framework...")
    fw := e.detectFramework(cloneDir, project)
    logger.Infof("Detected: %s (node %s, %s)", fw.Name, fw.NodeVersion, fw.PackageManager)

    // Step 3: Resolve environment variables
    envVars := e.resolveEnvVars(project, deployment)

    // Step 4: Create container
    containerID, err := e.createBuildContainer(ctx, fw, cloneDir, project, envVars)
    if err != nil {
        e.fail(deployment, "Container creation failed: "+err.Error(), logger)
        return
    }
    defer e.docker.RemoveContainer(containerID)

    // Step 5: Run install
    logger.Infof("Running: %s", fw.InstallCommand)
    if err := e.execInContainer(ctx, containerID, fw.InstallCommand, logger); err != nil {
        e.fail(deployment, "Install failed: "+err.Error(), logger)
        return
    }

    // Step 6: Run build
    logger.Infof("Running: %s", fw.BuildCommand)
    if err := e.execInContainer(ctx, containerID, fw.BuildCommand, logger); err != nil {
        e.fail(deployment, "Build failed: "+err.Error(), logger)
        return
    }

    // Step 7: Copy output
    logger.Info("Copying build output...")
    artifactPath := filepath.Join("/app/deployments", project.ID, deployment.ID)
    size, err := e.copyOutput(ctx, containerID, fw.OutputDir, artifactPath)
    if err != nil {
        e.fail(deployment, "Output copy failed: "+err.Error(), logger)
        return
    }

    // Step 8: Finalize
    duration := time.Since(startTime)
    deployment.Status = "ready"
    deployment.ArtifactPath = artifactPath
    deployment.ArtifactSizeBytes = size
    deployment.BuildDurationMs = duration.Milliseconds()
    deployment.DeploymentURL = e.generateURL(project, deployment)
    e.repo.Update(deployment)

    // Step 9: Update Caddy
    e.caddy.AddRoute(project, deployment)

    // Step 10: Post-build actions
    e.github.PostDeploymentStatus(project, deployment, "success")
    e.github.PostOrUpdatePRComment(project, deployment)
    e.notifications.Send(project, deployment, "deploy_success")

    logger.Infof("✅ Deployment ready! (%s) → %s", duration.Round(time.Second), deployment.DeploymentURL)
}
```

### 6.5 Build Cancellation

Builds can be cancelled from the API or by deduplication:

```go
func (e *BuildExecutor) cancelBuild(deploymentID string) {
    // Signal the executor's context
    e.cancelFuncs[deploymentID]()  // cancel context for this build
    
    // Force-stop the Docker container (2s grace period)
    e.docker.StopContainer("build-"+deploymentID, 2*time.Second)
}
```

The executor checks `ctx.Err()` between build steps and after each Docker exec.

---

## 7. Caddy Integration Layer

### 7.1 Admin API Client

```go
type CaddyClient struct {
    baseURL    string  // http://localhost:2019 (or caddy:2019 in Docker)
    httpClient *http.Client
}

func (c *CaddyClient) LoadConfig(config CaddyConfig) error {
    body, _ := json.Marshal(config)
    req, _ := http.NewRequest("POST", c.baseURL+"/load", bytes.NewReader(body))
    req.Header.Set("Content-Type", "application/json")
    resp, err := c.httpClient.Do(req)
    // ...
}

func (c *CaddyClient) AddRoute(route CaddyRoute) error { ... }
func (c *CaddyClient) RemoveRoute(routeID string) error { ... }
func (c *CaddyClient) GetConfig() (*CaddyConfig, error) { ... }
```

### 7.2 Route Lifecycle

**On deployment ready**:
```
1. Build Caddy route JSON for the deployment
2. POST /config/apps/http/servers/deployments/routes
3. If custom domain exists, update that route to point to new artifact
```

**On rollback**:
```
1. Find existing route for the project's production domain / custom domains
2. PATCH route to point to the rollback target's artifact path
3. Zero downtime — Caddy applies immediately
```

**On project/deployment deletion**:
```
1. DELETE /config/apps/http/servers/deployments/routes/{route_id}
```

**On Hostbox startup**:
```
1. Read ALL active deployments + domains from SQLite
2. Build complete Caddy JSON config
3. POST /load (replaces entire Caddy config)
```

### 7.3 Config State Reconciliation

Caddy's config is treated as **ephemeral** — Hostbox is the source of truth. If Caddy restarts, Hostbox regenerates the entire config on its next health check cycle.

```go
func (s *CaddySyncService) SyncAll() error {
    config := s.buildFullConfig()
    return s.caddy.LoadConfig(config)
}

func (s *CaddySyncService) buildFullConfig() CaddyConfig {
    deployments := s.deployRepo.ListActive()
    domains := s.domainRepo.ListVerified()
    
    routes := []CaddyRoute{}
    
    // Platform domain route (API + dashboard)
    routes = append(routes, s.platformRoute())
    
    // Preview deployment routes
    for _, d := range deployments {
        routes = append(routes, s.deploymentRoute(d))
    }
    
    // Custom domain routes
    for _, d := range domains {
        routes = append(routes, s.customDomainRoute(d))
    }
    
    return CaddyConfig{
        Apps: CaddyApps{
            HTTP: CaddyHTTP{
                Servers: map[string]CaddyServer{
                    "main": {Listen: []string{":443", ":80"}, Routes: routes},
                },
            },
        },
    }
}
```

---

## 8. GitHub Integration Architecture

### 8.1 Authentication with GitHub

Hostbox uses a **GitHub App** (not OAuth App). This provides:
- Installation-level access (per repo, not per user)
- Webhook delivery
- Higher API rate limits

**Token flow**:
```
GitHub App Private Key (PEM)
         │
         ▼
Generate JWT (signed with PEM, valid 10 min)
         │
         ▼
POST /app/installations/{installation_id}/access_tokens
         │
         ▼
Installation Access Token (valid 1 hour)
         │
         ▼
Use for: git clone, API calls (statuses, comments, repos list)
```

Tokens are cached in-memory with expiry tracking:
```go
type GitHubTokenCache struct {
    mu     sync.RWMutex
    tokens map[int64]*CachedToken  // installation_id → token
}

type CachedToken struct {
    Token     string
    ExpiresAt time.Time
}
```

### 8.2 Webhook Processing Pipeline

```
POST /api/v1/github/webhook
 │
 ├── 1. Read body (save raw bytes for signature verification)
 ├── 2. Verify HMAC-SHA256 signature (X-Hub-Signature-256 header)
 │      └── If invalid → 401 Unauthorized
 ├── 3. Parse X-GitHub-Event header
 ├── 4. Dispatch to handler by event type:
 │      ├── "push" → handlePush()
 │      ├── "pull_request" → handlePullRequest()
 │      └── "installation" → handleInstallation()
 ├── 5. Return 202 Accepted (processing happens async)
 └── 6. Handler runs in goroutine:
        ├── Look up project by github_repo + installation_id
        ├── Check auto_deploy / preview_deployments settings
        ├── Create deployment record
        └── Enqueue build job
```

### 8.3 PR Comment Management

To avoid duplicate comments, Hostbox uses a marker to find and update its own comment:

```go
const commentMarker = "<!-- hostbox-preview-deployment -->"

func (g *GitHubService) PostOrUpdatePRComment(project *Project, deployment *Deployment) {
    if deployment.GitHubPRNumber == 0 {
        return
    }
    
    body := g.buildCommentBody(project, deployment)
    
    // Find existing Hostbox comment on this PR
    comments := g.listPRComments(project.GitHubRepo, deployment.GitHubPRNumber)
    for _, c := range comments {
        if strings.Contains(c.Body, commentMarker) {
            g.updateComment(project.GitHubRepo, c.ID, body)
            return
        }
    }
    
    // No existing comment — create new one
    g.createComment(project.GitHubRepo, deployment.GitHubPRNumber, body)
}
```

---

## 9. Log Streaming Architecture

### 9.1 Overview

Build logs flow through three layers simultaneously:

```
Docker Container stdout/stderr
         │
         ▼
┌─────────────────┐
│  BuildLogger    │  (multiplexer)
│                  │
│  ├── File Writer │ → /app/logs/{deployment_id}.log
│  ├── SSE Hub     │ → Connected browser/CLI clients
│  └── Metrics     │ → Line count, size tracking
└─────────────────┘
```

### 9.2 SSE Hub Design

```go
type SSEHub struct {
    mu          sync.RWMutex
    subscribers map[string]map[chan SSEEvent]struct{}  // deploymentID → set of channels
}

func (h *SSEHub) Subscribe(deploymentID string) (<-chan SSEEvent, func()) {
    ch := make(chan SSEEvent, 100)  // Buffered to prevent slow clients from blocking
    h.mu.Lock()
    if h.subscribers[deploymentID] == nil {
        h.subscribers[deploymentID] = make(map[chan SSEEvent]struct{})
    }
    h.subscribers[deploymentID][ch] = struct{}{}
    h.mu.Unlock()
    
    unsubscribe := func() {
        h.mu.Lock()
        delete(h.subscribers[deploymentID], ch)
        close(ch)
        h.mu.Unlock()
    }
    return ch, unsubscribe
}

func (h *SSEHub) Publish(deploymentID string, event SSEEvent) {
    h.mu.RLock()
    defer h.mu.RUnlock()
    for ch := range h.subscribers[deploymentID] {
        select {
        case ch <- event:
        default:
            // Drop event for slow clients rather than blocking build
        }
    }
}
```

### 9.3 SSE HTTP Handler

```go
func (h *DeploymentHandler) StreamLogs(c echo.Context) error {
    deploymentID := c.Param("id")
    
    c.Response().Header().Set("Content-Type", "text/event-stream")
    c.Response().Header().Set("Cache-Control", "no-cache")
    c.Response().Header().Set("Connection", "keep-alive")
    c.Response().WriteHeader(200)
    
    // First: send existing log lines (for reconnection)
    lastEventID := c.Request().Header.Get("Last-Event-ID")
    existingLines := h.logService.ReadFromOffset(deploymentID, lastEventID)
    for _, line := range existingLines {
        fmt.Fprintf(c.Response(), "id: %d\nevent: log\ndata: %s\n\n", line.Number, line.JSON())
        c.Response().Flush()
    }
    
    // Then: subscribe to live events
    events, unsubscribe := h.sseHub.Subscribe(deploymentID)
    defer unsubscribe()
    
    for {
        select {
        case <-c.Request().Context().Done():
            return nil  // Client disconnected
        case event, ok := <-events:
            if !ok {
                return nil  // Channel closed (build complete)
            }
            fmt.Fprintf(c.Response(), "id: %d\nevent: %s\ndata: %s\n\n", event.ID, event.Type, event.Data)
            c.Response().Flush()
        }
    }
}
```

---

## 10. Environment Variable Encryption

### 10.1 Encryption Flow

```
User provides: KEY=my_api_secret
                        │
                        ▼
                Generate random 12-byte nonce
                        │
                        ▼
         ┌──────────────────────────┐
         │  AES-256-GCM Encrypt     │
         │  Key: ENCRYPTION_KEY     │
         │  Nonce: random 12 bytes  │
         │  Plaintext: value bytes  │
         │  AAD: project_id + key   │  ← Binds ciphertext to this project+key
         └──────────────────────────┘
                        │
                        ▼
         Store: nonce || ciphertext || tag  (as BLOB in env_vars.encrypted_value)
```

### 10.2 Implementation

```go
type Encryptor struct {
    key []byte  // 32 bytes from ENCRYPTION_KEY
}

func (e *Encryptor) Encrypt(plaintext []byte, aad []byte) ([]byte, error) {
    block, _ := aes.NewCipher(e.key)
    gcm, _ := cipher.NewGCM(block)
    
    nonce := make([]byte, gcm.NonceSize())
    io.ReadFull(rand.Reader, nonce)
    
    ciphertext := gcm.Seal(nonce, nonce, plaintext, aad)
    return ciphertext, nil
}

func (e *Encryptor) Decrypt(data []byte, aad []byte) ([]byte, error) {
    block, _ := aes.NewCipher(e.key)
    gcm, _ := cipher.NewGCM(block)
    
    nonceSize := gcm.NonceSize()
    nonce, ciphertext := data[:nonceSize], data[nonceSize:]
    
    return gcm.Open(nil, nonce, ciphertext, aad)
}
```

### 10.3 AAD (Additional Authenticated Data)

The AAD is `project_id + ":" + key_name`. This prevents an attacker who gains DB access from copying encrypted values between projects or keys — the decryption would fail because the AAD wouldn't match.

---

## 11. Notification System

### 11.1 Architecture

```go
type NotificationService struct {
    repo    *NotificationRepository
    clients map[string]NotificationClient  // "discord", "slack", "webhook"
}

type NotificationClient interface {
    Send(ctx context.Context, webhookURL string, payload NotificationPayload) error
}
```

### 11.2 Event Flow

```
Deployment completes (success/failure)
         │
         ▼
NotificationService.Dispatch(project, deployment, eventType)
         │
         ├── Query notification_configs for project (+ global configs)
         ├── Filter by event type
         └── For each matching config:
              └── goroutine: client.Send(webhookURL, payload)
                  └── Retry with backoff (max 3 attempts)
                  └── Log failures but don't block
```

### 11.3 Discord Webhook Format

```json
{
  "embeds": [{
    "title": "✅ Deployment Ready — my-app",
    "description": "Branch: `feat/login` | Commit: `a1b2c3d`",
    "url": "https://my-app-a1b2c3d4.hostbox.example.com",
    "color": 3066993,
    "fields": [
      {"name": "Duration", "value": "45s", "inline": true},
      {"name": "Status", "value": "Ready", "inline": true}
    ],
    "timestamp": "2024-01-15T10:30:46Z"
  }]
}
```

---

## 12. Garbage Collection & Disk Management

### 12.1 GC Scheduler

```go
type GarbageCollector struct {
    deployRepo *DeploymentRepository
    projectRepo *ProjectRepository
    settings   *SettingsService
}

func (gc *GarbageCollector) Start(ctx context.Context) {
    ticker := time.NewTicker(6 * time.Hour)
    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            gc.collectArtifacts()
            gc.collectLogs()
            gc.collectCaches()
            gc.collectDockerResources()
        }
    }
}
```

### 12.2 Artifact Collection Algorithm

```
For each project:
  1. Get all deployments ordered by created_at DESC
  2. Identify "protected" deployments:
     - Current production deployment
     - Latest deployment per active preview branch
  3. From remaining deployments:
     - Keep the most recent N (max_deployments_per_project)
     - Delete any older than M days (artifact_retention_days)
  4. For each deployment to delete:
     - Remove artifact directory: rm -rf /app/deployments/{project_id}/{deployment_id}/
     - Remove log file: rm /app/logs/{deployment_id}.log
     - Update deployment record: set artifact_path=NULL, log_path=NULL
     - (Keep DB record for history)
```

### 12.3 Disk Usage Monitoring

```go
func (gc *GarbageCollector) GetDiskUsage() DiskUsage {
    // System-level
    stat := syscall.Statfs("/app")
    total := stat.Blocks * uint64(stat.Bsize)
    free := stat.Bfree * uint64(stat.Bsize)
    
    // Per-project
    projects := gc.projectRepo.ListAll()
    projectUsage := map[string]int64{}
    for _, p := range projects {
        size := dirSize("/app/deployments/" + p.ID)
        projectUsage[p.ID] = size
    }
    
    return DiskUsage{Total: total, Free: free, Projects: projectUsage}
}
```

---

## 13. Embedded Web Dashboard

### 13.1 Build-Time Embedding

```go
//go:embed web/dist/*
var webDistFS embed.FS

func mountDashboard(e *echo.Echo) {
    // Serve static files from embedded FS
    assetHandler := http.FileServer(http.FS(webDistFS))
    
    // SPA fallback: any non-API, non-asset route → index.html
    e.GET("/*", echo.WrapHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        path := r.URL.Path
        
        // Try to serve the exact file
        if _, err := webDistFS.Open("web/dist" + path); err == nil {
            assetHandler.ServeHTTP(w, r)
            return
        }
        
        // Fallback to index.html for SPA routing
        r.URL.Path = "/"
        assetHandler.ServeHTTP(w, r)
    })))
}
```

### 13.2 Build Pipeline (Development → Production)

```
Development:
  Vite dev server (:3000) → proxies /api/* to Go server (:8080)
  
Production build:
  1. cd web && npm run build          → web/dist/
  2. go build -o hostbox cmd/api/     → embeds web/dist/ via embed.FS
  3. Single binary contains both API + dashboard
```

### 13.3 API Client (Frontend)

```typescript
// web/src/lib/api.ts
class HostboxAPI {
    private baseURL = '/api/v1';
    private token: string | null = null;

    async request<T>(method: string, path: string, body?: any): Promise<T> {
        const resp = await fetch(this.baseURL + path, {
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(this.token && { 'Authorization': `Bearer ${this.token}` }),
            },
            body: body ? JSON.stringify(body) : undefined,
            credentials: 'include',  // For refresh token cookie
        });
        
        if (resp.status === 401) {
            // Try refresh
            const refreshed = await this.refresh();
            if (refreshed) return this.request(method, path, body);
            throw new UnauthorizedError();
        }
        
        if (!resp.ok) {
            const error = await resp.json();
            throw new APIError(error);
        }
        
        return resp.json();
    }
}
```

---

## 14. CLI Architecture

### 14.1 Structure

```
cmd/cli/main.go
 └── root command (hostbox)
      ├── login     → auth.LoginCmd
      ├── logout    → auth.LogoutCmd
      ├── whoami    → auth.WhoamiCmd
      ├── projects  → project.ListCmd
      │    └── create → project.CreateCmd
      ├── link      → project.LinkCmd
      ├── open      → project.OpenCmd
      ├── deploy    → deploy.DeployCmd
      ├── status    → deploy.StatusCmd
      ├── logs      → deploy.LogsCmd
      ├── rollback  → deploy.RollbackCmd
      ├── domains   → domain.ListCmd
      │    ├── add    → domain.AddCmd
      │    ├── remove → domain.RemoveCmd
      │    └── verify → domain.VerifyCmd
      ├── env       → envvar.ListCmd
      │    ├── set    → envvar.SetCmd
      │    ├── delete → envvar.DeleteCmd
      │    ├── import → envvar.ImportCmd
      │    └── export → envvar.ExportCmd
      └── admin     → admin.RootCmd
           ├── reset-password → admin.ResetPasswordCmd
           ├── backup         → admin.BackupCmd
           └── update         → admin.UpdateCmd
```

### 14.2 API Client

The CLI uses the same REST API as the dashboard. Authentication token is stored in OS keyring (via `zalando/go-keyring`) with file fallback.

---

## 15. Docker & Container Strategy

### 15.1 Hostbox Dockerfile (Multi-Stage)

```dockerfile
# Stage 1: Build web dashboard
FROM node:20-slim AS web-builder
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# Stage 2: Build Go binary
FROM golang:1.22-alpine AS go-builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web-builder /web/dist ./web/dist
RUN CGO_ENABLED=1 go build -o hostbox ./cmd/api/

# Stage 3: Production image
FROM alpine:3.19
RUN apk add --no-cache ca-certificates git sqlite-libs
COPY --from=go-builder /app/hostbox /usr/local/bin/hostbox
COPY --from=go-builder /app/migrations /app/migrations
EXPOSE 8080
CMD ["hostbox"]
```

Note: `CGO_ENABLED=1` is required for SQLite (`mattn/go-sqlite3`).

### 15.2 Build Container Creation (via Docker SDK)

```go
func (d *DockerService) CreateBuildContainer(opts BuildContainerOpts) (string, error) {
    config := &container.Config{
        Image: "node:" + opts.NodeVersion + "-slim",
        Env:   opts.EnvVars,
        WorkingDir: "/app",
        Labels: map[string]string{
            "hostbox.deployment": opts.DeploymentID,
            "hostbox.managed":    "true",
        },
    }
    
    hostConfig := &container.HostConfig{
        Resources: container.Resources{
            Memory:    int64(opts.MemoryMB) * 1024 * 1024,
            NanoCPUs:  int64(opts.CPUs * 1e9),
            PidsLimit: &opts.PIDLimit,
            Ulimits: []*units.Ulimit{
                {Name: "nofile", Soft: 1024, Hard: 1024},
            },
        },
        SecurityOpt: []string{"no-new-privileges"},
        CapDrop:     []string{"ALL"},
        ReadonlyRootfs: true,
        Tmpfs: map[string]string{
            "/tmp": "size=512m",
        },
        Binds: []string{
            opts.SourceDir + ":/app/src:ro",
            opts.CacheVolume + ":/app/node_modules",
            opts.BuildCacheVolume + ":/app/.build-cache",
        },
    }
    
    resp, err := d.client.ContainerCreate(ctx, config, hostConfig, nil, nil, "build-"+opts.DeploymentID)
    return resp.ID, err
}
```

---

## 16. Networking & DNS

### 16.1 DNS Requirements

```
Required DNS records (user configures at their registrar):

A     hostbox.example.com     →  VPS_IP
A     *.hostbox.example.com   →  VPS_IP     (wildcard for preview URLs)

For custom domains:
A     myapp.com               →  VPS_IP
CNAME www.myapp.com           →  myapp.com
```

### 16.2 Domain Verification

```go
func (s *DomainService) Verify(domain *models.Domain) error {
    serverIP := s.getServerIP()
    
    // Check A record
    ips, err := net.LookupHost(domain.Domain)
    if err != nil {
        return ErrDNSNotResolvable
    }
    
    found := false
    for _, ip := range ips {
        if ip == serverIP {
            found = true
            break
        }
    }
    
    if !found {
        return ErrDNSNotPointingToServer
    }
    
    domain.Verified = true
    domain.VerifiedAt = time.Now()
    return s.repo.Update(domain)
}
```

---

## 17. Error Handling & Resilience

### 17.1 Failure Modes & Recovery

| Failure | Impact | Recovery |
|---------|--------|----------|
| Hostbox process crash | Builds in progress fail | Auto-restart (Docker), crash recovery marks stuck builds as failed |
| Caddy crash | All traffic fails | Auto-restart (Docker), Hostbox resync on Caddy startup |
| SQLite corruption | All data lost | Backup restore, WAL mode minimizes corruption risk |
| Docker daemon crash | Builds fail | Auto-restart, orphaned containers cleaned on next GC |
| Disk full | Builds fail, Caddy may fail | GC runs emergency cleanup, alerts in dashboard |
| GitHub API outage | Webhooks delayed, clone fails | GitHub retries webhooks, builds retry clone 3x |
| OOM kill | Container killed by kernel | Docker restart policy, reduce build memory limit |

### 17.2 Retry Policies

| Operation | Max Retries | Backoff | Timeout |
|-----------|-------------|---------|---------|
| GitHub API calls | 3 | Exponential (1s, 2s, 4s) | 30s |
| Git clone | 3 | Linear (5s) | 120s |
| Caddy Admin API | 5 | Exponential (500ms) | 10s |
| Notification webhooks | 3 | Exponential (1s, 2s, 4s) | 10s |
| DNS lookup (verification) | 1 | N/A | 10s |

---

## 18. Observability

### 18.1 Structured Logging

All logs use structured JSON via Go's `slog`:

```json
{
  "time": "2024-01-15T10:30:01Z",
  "level": "INFO",
  "msg": "deployment.created",
  "request_id": "req_abc123",
  "user_id": "usr_xyz",
  "project_id": "prj_123",
  "deployment_id": "dpl_456",
  "branch": "main",
  "commit_sha": "a1b2c3d4"
}
```

Log levels: `DEBUG`, `INFO`, `WARN`, `ERROR`

### 18.2 Key Metrics (Internal)

Tracked in-memory (no external metrics system):

| Metric | Type | Purpose |
|--------|------|---------|
| `builds_total` | Counter | Total builds started |
| `builds_active` | Gauge | Currently running builds |
| `builds_duration_ms` | Histogram | Build time distribution |
| `api_requests_total` | Counter | HTTP requests by route + status |
| `disk_usage_bytes` | Gauge | By category (artifacts, logs, cache) |
| `queue_depth` | Gauge | Pending build jobs |

Exposed via `GET /api/v1/admin/stats` (not Prometheus format — keeping it simple).

---

## 19. Security Architecture

### 19.1 Defense in Depth

```
Layer 1: Network
├── Caddy enforces HTTPS (auto-redirect)
├── HSTS headers
└── Only ports 80, 443 exposed

Layer 2: Application
├── JWT authentication on all API routes
├── Rate limiting per IP and per user
├── CORS restricted to platform domain
├── Input validation on all endpoints
└── CSRF protection (SameSite=Strict cookies)

Layer 3: Data
├── Passwords: bcrypt cost 12
├── Secrets: AES-256-GCM encryption at rest
├── Refresh tokens: SHA-256 hashed in DB
├── No raw secrets in logs (scrubbing)
└── File permissions (0600 for sensitive files)

Layer 4: Build Isolation
├── Unprivileged containers (no --privileged)
├── All capabilities dropped (--cap-drop=ALL)
├── Read-only root filesystem
├── PID limits (256)
├── Memory limits (512MB default)
├── CPU limits (1 core default)
├── No Docker socket access
└── No-new-privileges security option
```

### 19.2 Webhook Security

```go
func verifyWebhookSignature(payload []byte, signature string, secret string) bool {
    mac := hmac.New(sha256.New, []byte(secret))
    mac.Write(payload)
    expected := "sha256=" + hex.EncodeToString(mac.Sum(nil))
    return hmac.Equal([]byte(expected), []byte(signature))
}
```

---

## 20. Deployment & Upgrade Strategy

### 20.1 Zero-Downtime Updates

```
1. Pull new Docker images
2. docker compose up -d --no-deps hostbox
   └── Docker replaces the container
   └── New binary starts, runs migrations
   └── Syncs Caddy config
   └── Health check passes → old container removed
3. docker compose up -d --no-deps caddy (if Caddy image updated)
```

During the ~5 second restart window:
- Caddy continues serving static files (uninterrupted)
- API requests get 502 briefly
- In-progress builds are marked as failed (crash recovery)
- Build queue is preserved in SQLite

### 20.2 Migration Safety

All migrations are:
- **Additive**: New tables, new columns with defaults (never remove columns in same release)
- **Idempotent**: Running the same migration twice is safe
- **Backward compatible**: Old code can work with new schema during rolling update

### 20.3 Rollback

If an update causes issues:
```bash
# Revert to previous image
docker compose up -d --no-deps hostbox  # with previous image tag
```

Database migrations are never destructive, so rollback is safe.
