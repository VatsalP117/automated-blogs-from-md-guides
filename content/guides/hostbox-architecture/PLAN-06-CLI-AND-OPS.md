# Phase 6: CLI Tool & Operations — Implementation Plan

> **Status:** Planning
> **Depends on:** Phases 1–5 (Backend, Auth, Build Pipeline, Caddy, GitHub, Dashboard)
> **Deliverables:** `hostbox-cli` binary, background schedulers, notification system, backup/restore, self-update, install script

---

## Table of Contents

1. [Overview](#1-overview)
2. [Part A — CLI Tool (`cmd/cli/`)](#2-part-a--cli-tool-cmdcli)
3. [Part B — Background Schedulers](#3-part-b--background-schedulers)
4. [Part C — Notification System](#4-part-c--notification-system)
5. [Part D — Backup & Restore](#5-part-d--backup--restore)
6. [Part E — Self-Update](#6-part-e--self-update)
7. [Part F — Install Script](#7-part-f--install-script)
8. [Testing Strategy](#8-testing-strategy)
9. [Implementation Order](#9-implementation-order)

---

## 1. Overview

Phase 6 completes the Hostbox v1 feature set by adding:

- **CLI Tool** — A separate Go binary (`hostbox-cli`) built with Cobra, providing terminal-based workflows for authentication, project management, deployments, domains, env vars, and admin operations.
- **Background Schedulers** — Goroutines in the main binary for garbage collection, session cleanup, and domain re-verification.
- **Notification System** — Pluggable notification clients (Discord, Slack, generic webhook) with retry logic.
- **Backup & Restore** — SQLite online backup via `VACUUM INTO`, with retention and optional Litestream integration.
- **Self-Update** — GitHub releases-based update mechanism for Docker deployments.
- **Install Script** — One-line VPS installer (`curl -fsSL https://get.hostbox.dev | bash`).

### Architecture Alignment

The CLI communicates exclusively through the existing REST API (`/api/v1/*`). It stores credentials in OS keyring (via `zalando/go-keyring`) with file fallback. Background schedulers, notifications, and backup/restore are added to the main `hostbox` binary alongside the existing API server and build worker.

```
┌──────────────────────────────────────────────────────────────────┐
│ Developer Machine                                                │
│                                                                  │
│  hostbox-cli (separate binary)                                   │
│    ├── Config: ~/.config/hostbox/config.json                     │
│    ├── Credentials: OS keyring or config file                    │
│    ├── Project link: .hostbox.json (in project root)             │
│    └── Communicates via HTTPS → Hostbox API                      │
│                                                                  │
│  .hostbox.json (per-project)                                     │
│    { "project_id": "xxx", "server_url": "https://..." }         │
└──────────────────────────────────────────────────────────────────┘
          │
          ▼ HTTPS
┌──────────────────────────────────────────────────────────────────┐
│ VPS: hostbox binary                                              │
│  ├── API Server (:8080) ← handles CLI requests                  │
│  ├── Build Worker Pool                                           │
│  ├── Background Schedulers (NEW)                                 │
│  │   ├── GarbageCollector (every 6h)                             │
│  │   ├── SessionCleaner (every 1h)                               │
│  │   └── DomainReVerifier (every 24h)                            │
│  ├── NotificationService (NEW)                                   │
│  │   ├── DiscordClient                                           │
│  │   ├── SlackClient                                             │
│  │   └── WebhookClient                                           │
│  └── BackupService (NEW)                                         │
└──────────────────────────────────────────────────────────────────┘
```

---

## 2. Part A — CLI Tool (`cmd/cli/`)

### 2.1 New Dependencies

Add to `go.mod`:

```
github.com/spf13/cobra          v1.8.0    # CLI framework
github.com/spf13/viper          v1.18.0   # Config file handling (optional, Cobra compatible)
github.com/zalando/go-keyring   v0.2.4    # OS keyring (macOS Keychain, GNOME Keyring, Windows Credential Manager)
github.com/briandowns/spinner   v1.23.0   # Terminal spinners for long operations
github.com/fatih/color          v1.16.0   # Colored terminal output
github.com/r3labs/sse/v2        v2.10.0   # SSE client for log streaming
```

### 2.2 File Structure

```
cmd/cli/
├── main.go                     # Entrypoint, root command setup
├── internal/
│   ├── config/
│   │   ├── config.go           # Config loading/saving (~/.config/hostbox/config.json)
│   │   └── keyring.go          # OS keyring integration with file fallback
│   ├── client/
│   │   ├── client.go           # HTTP client (base URL, auth headers, error handling)
│   │   ├── auth.go             # Auth API calls (login, refresh, whoami)
│   │   ├── projects.go         # Project API calls
│   │   ├── deployments.go      # Deployment API calls
│   │   ├── domains.go          # Domain API calls
│   │   ├── envvars.go          # Env var API calls
│   │   ├── admin.go            # Admin API calls
│   │   └── sse.go              # SSE client for log streaming
│   ├── link/
│   │   └── link.go             # .hostbox.json read/write/discover
│   └── output/
│       ├── table.go            # Table formatting (tabwriter)
│       ├── json.go             # JSON output mode
│       └── format.go           # Colors, spinners, status icons
├── cmd/
│   ├── root.go                 # Root command + global flags
│   ├── login.go                # hostbox login
│   ├── logout.go               # hostbox logout
│   ├── whoami.go               # hostbox whoami
│   ├── projects.go             # hostbox projects (list)
│   ├── project_create.go       # hostbox project create
│   ├── link.go                 # hostbox link
│   ├── open.go                 # hostbox open
│   ├── deploy.go               # hostbox deploy
│   ├── status.go               # hostbox status
│   ├── logs.go                 # hostbox logs
│   ├── rollback.go             # hostbox rollback
│   ├── domains.go              # hostbox domains (list, add, remove, verify)
│   ├── env.go                  # hostbox env (list, set, delete, import, export)
│   └── admin.go                # hostbox admin (backup, restore, update, reset-password)
```

### 2.3 Root Command & Global Flags

**File: `cmd/cli/cmd/root.go`**

```go
package cmd

import (
    "fmt"
    "os"

    "github.com/spf13/cobra"
)

var (
    flagJSON       bool   // --json: output as JSON instead of table
    flagServer     string // --server: override server URL
    flagToken      string // --token: override auth token
    flagNoColor    bool   // --no-color: disable colored output
    flagProject    string // --project: override project ID (skip .hostbox.json)
    flagVerbose    bool   // --verbose / -v: verbose output
)

var rootCmd = &cobra.Command{
    Use:   "hostbox",
    Short: "Hostbox CLI — deploy frontend apps to your own server",
    Long: `Hostbox is a self-hosted deployment platform for frontend applications.
Use this CLI to manage projects, trigger deployments, configure domains,
and administer your Hostbox instance.

Documentation: https://docs.hostbox.dev
Dashboard:     Run 'hostbox open' to open your project dashboard`,
    Version: "0.0.0-dev", // Replaced at build time via ldflags
    PersistentPreRun: func(cmd *cobra.Command, args []string) {
        // Initialize config, apply env var overrides
    },
    SilenceUsage:  true,
    SilenceErrors: true,
}

func Execute() {
    if err := rootCmd.Execute(); err != nil {
        fmt.Fprintln(os.Stderr, err)
        os.Exit(1)
    }
}

func init() {
    rootCmd.PersistentFlags().BoolVar(&flagJSON, "json", false, "Output as JSON")
    rootCmd.PersistentFlags().StringVar(&flagServer, "server", "", "Hostbox server URL (overrides config)")
    rootCmd.PersistentFlags().StringVar(&flagToken, "token", "", "Auth token (overrides stored credentials)")
    rootCmd.PersistentFlags().BoolVar(&flagNoColor, "no-color", false, "Disable colored output")
    rootCmd.PersistentFlags().StringVar(&flagProject, "project", "", "Project ID (overrides .hostbox.json)")
    rootCmd.PersistentFlags().BoolVarP(&flagVerbose, "verbose", "v", false, "Verbose output")

    // Register all subcommands
    rootCmd.AddCommand(loginCmd)
    rootCmd.AddCommand(logoutCmd)
    rootCmd.AddCommand(whoamiCmd)
    rootCmd.AddCommand(projectsCmd)
    rootCmd.AddCommand(linkCmd)
    rootCmd.AddCommand(openCmd)
    rootCmd.AddCommand(deployCmd)
    rootCmd.AddCommand(statusCmd)
    rootCmd.AddCommand(logsCmd)
    rootCmd.AddCommand(rollbackCmd)
    rootCmd.AddCommand(domainsCmd)
    rootCmd.AddCommand(envCmd)
    rootCmd.AddCommand(adminCmd)
}
```

**Build command** (version injected via `ldflags`):

```bash
go build -ldflags "-X cmd/cli/cmd.Version=1.0.0 -X cmd/cli/cmd.CommitSHA=$(git rev-parse --short HEAD)" \
    -o hostbox ./cmd/cli/
```

### 2.4 Configuration System

**File: `cmd/cli/internal/config/config.go`**

Config file location: `~/.config/hostbox/config.json`

```go
type Config struct {
    ServerURL   string `json:"server_url"`            // e.g. "https://hostbox.example.com"
    AccessToken string `json:"access_token,omitempty"` // Only used as fallback when keyring unavailable
    UserEmail   string `json:"user_email,omitempty"`   // Cached for display (hostbox whoami)
    UserID      string `json:"user_id,omitempty"`      // Cached for display
}
```

**Config resolution order** (highest priority first):

| Priority | Source                        | Fields                    |
|----------|-------------------------------|---------------------------|
| 1        | CLI flags                     | `--server`, `--token`     |
| 2        | Environment variables         | `HOSTBOX_SERVER`, `HOSTBOX_TOKEN` |
| 3        | OS keyring                    | `access_token`            |
| 4        | Config file                   | `server_url`, `access_token` (fallback) |

**Environment variables** (for CI/CD):

```bash
export HOSTBOX_SERVER="https://hostbox.example.com"
export HOSTBOX_TOKEN="eyJhbGciOiJIUzI1NiIs..."
```

**File: `cmd/cli/internal/config/keyring.go`**

```go
const (
    keyringService = "hostbox-cli"
    keyringUser    = "access_token"
)

func StoreToken(token string) error {
    err := keyring.Set(keyringService, keyringUser, token)
    if err != nil {
        // Keyring unavailable (headless server, CI) — fall back to config file
        return storeTokenToFile(token)
    }
    return nil
}

func GetToken() (string, error) {
    token, err := keyring.Get(keyringService, keyringUser)
    if err != nil {
        // Try file fallback
        return getTokenFromFile()
    }
    return token, nil
}

func DeleteToken() error {
    _ = keyring.Delete(keyringService, keyringUser)
    return deleteTokenFromFile()
}
```

Config file permissions: `0600` (owner read/write only).
Config directory created with `0700` on first run.

### 2.5 HTTP Client

**File: `cmd/cli/internal/client/client.go`**

```go
type Client struct {
    BaseURL    string
    Token      string
    HTTPClient *http.Client
    UserAgent  string // "hostbox-cli/1.0.0"
}

// APIError matches the server's error response format
type APIError struct {
    Code    string       `json:"code"`
    Message string       `json:"message"`
    Details []FieldError `json:"details,omitempty"`
}

type APIResponse[T any] struct {
    Data       T          `json:"-"`       // Unmarshaled from top-level key
    Pagination *Pagination `json:"pagination,omitempty"`
}

type Pagination struct {
    Total      int `json:"total"`
    Page       int `json:"page"`
    PerPage    int `json:"per_page"`
    TotalPages int `json:"total_pages"`
}

func (c *Client) Do(method, path string, body any, result any) error {
    // 1. Build request URL (c.BaseURL + "/api/v1" + path)
    // 2. Marshal body to JSON (if non-nil)
    // 3. Set headers: Content-Type, Authorization: Bearer {token}, User-Agent
    // 4. Execute request
    // 5. If 401: attempt token refresh, retry once
    // 6. If non-2xx: parse error body, return typed APIError
    // 7. Unmarshal response body into result
}

func (c *Client) Get(path string, result any) error {
    return c.Do("GET", path, nil, result)
}

func (c *Client) Post(path string, body any, result any) error {
    return c.Do("POST", path, body, result)
}

func (c *Client) Patch(path string, body any, result any) error {
    return c.Do("PATCH", path, body, result)
}

func (c *Client) Delete(path string, result any) error {
    return c.Do("DELETE", path, nil, result)
}
```

### 2.6 Project Linking

**File: `cmd/cli/internal/link/link.go`**

`.hostbox.json` file format:

```json
{
  "project_id": "prj_a1b2c3d4",
  "server_url": "https://hostbox.example.com"
}
```

```go
const LinkFileName = ".hostbox.json"

type ProjectLink struct {
    ProjectID string `json:"project_id"`
    ServerURL string `json:"server_url"`
}

// Discover walks up from cwd looking for .hostbox.json
func Discover() (*ProjectLink, error) {
    dir, _ := os.Getwd()
    for {
        path := filepath.Join(dir, LinkFileName)
        if _, err := os.Stat(path); err == nil {
            data, _ := os.ReadFile(path)
            var link ProjectLink
            json.Unmarshal(data, &link)
            return &link, nil
        }
        parent := filepath.Dir(dir)
        if parent == dir {
            return nil, fmt.Errorf("no %s found (run 'hostbox link' first)", LinkFileName)
        }
        dir = parent
    }
}

// Write creates .hostbox.json in the current directory
func Write(link *ProjectLink) error {
    data, _ := json.MarshalIndent(link, "", "  ")
    return os.WriteFile(LinkFileName, append(data, '\n'), 0644)
}
```

### 2.7 Output Formatting

**File: `cmd/cli/internal/output/format.go`**

```go
// Status icons (used in table and text output)
const (
    IconSuccess  = "✓"  // Green
    IconFailure  = "✗"  // Red
    IconWarning  = "!"  // Yellow
    IconInfo     = "•"  // Blue
    IconBuilding = "◉"  // Yellow, animated in spinner mode
    IconQueued   = "○"  // Gray
)

// StatusColor maps deployment statuses to colors
var StatusColor = map[string]*color.Color{
    "ready":     color.New(color.FgGreen),
    "building":  color.New(color.FgYellow),
    "queued":    color.New(color.FgWhite),
    "failed":    color.New(color.FgRed),
    "cancelled": color.New(color.FgHiBlack),
}

func PrintSuccess(msg string) {
    color.Green("%s %s", IconSuccess, msg)
}

func PrintError(msg string) {
    color.Red("%s %s", IconFailure, msg)
}

func PrintWarning(msg string) {
    color.Yellow("%s %s", IconWarning, msg)
}

func PrintInfo(msg string) {
    color.Blue("%s %s", IconInfo, msg)
}
```

**File: `cmd/cli/internal/output/table.go`**

```go
func PrintTable(headers []string, rows [][]string) {
    w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
    // Print header in bold
    bold := color.New(color.Bold)
    bold.Fprintf(w, "%s\n", strings.Join(headers, "\t"))
    // Print separator
    fmt.Fprintln(w, strings.Repeat("─", 60))
    // Print rows
    for _, row := range rows {
        fmt.Fprintln(w, strings.Join(row, "\t"))
    }
    w.Flush()
}
```

**File: `cmd/cli/internal/output/json.go`**

```go
func PrintJSON(data any) {
    enc := json.NewEncoder(os.Stdout)
    enc.SetIndent("", "  ")
    enc.Encode(data)
}
```

### 2.8 Command Definitions

---

#### 2.8.1 `hostbox login`

```go
var loginCmd = &cobra.Command{
    Use:   "login",
    Short: "Authenticate with a Hostbox server",
    Long: `Log in to a Hostbox server. You will be prompted for the server URL,
email, and password. Alternatively, use --token for non-interactive login (CI/CD).`,
    RunE: runLogin,
}

func init() {
    loginCmd.Flags().String("token", "", "API token for non-interactive login (CI/CD)")
    loginCmd.Flags().String("server", "", "Server URL (e.g., https://hostbox.example.com)")
}
```

**Flow:**

1. If `--token` provided (CI/CD mode):
   - Store token (keyring or file)
   - Call `GET /api/v1/auth/me` to validate
   - Print: `✓ Logged in as user@example.com on https://hostbox.example.com`

2. If interactive:
   - Prompt: `Server URL:` (default from config or env)
   - Prompt: `Email:`
   - Prompt: `Password:` (hidden input)
   - Call `POST /api/v1/auth/login` with `{ email, password }`
   - Store access token in keyring
   - Store server URL and user info in config file
   - Print: `✓ Logged in as user@example.com`

**Output (success):**

```
✓ Logged in as alice@example.com on https://hostbox.example.com
```

**Output (`--json`):**

```json
{
  "user": {
    "id": "usr_abc123",
    "email": "alice@example.com",
    "display_name": "Alice",
    "is_admin": true
  },
  "server_url": "https://hostbox.example.com"
}
```

---

#### 2.8.2 `hostbox logout`

```go
var logoutCmd = &cobra.Command{
    Use:   "logout",
    Short: "Clear stored credentials",
    Long:  "Remove stored authentication credentials for the current server.",
    RunE:  runLogout,
}

func init() {
    logoutCmd.Flags().Bool("all", false, "Revoke all sessions on the server (logout everywhere)")
}
```

**Flow:**

1. If `--all`: call `POST /api/v1/auth/logout-all`
2. Else: call `POST /api/v1/auth/logout`
3. Delete token from keyring/file
4. Clear user info from config (keep server_url)

**Output:**

```
✓ Logged out from https://hostbox.example.com
```

---

#### 2.8.3 `hostbox whoami`

```go
var whoamiCmd = &cobra.Command{
    Use:   "whoami",
    Short: "Show current user and server",
    RunE:  runWhoami,
}
```

**Flow:**

1. Call `GET /api/v1/auth/me`
2. Print user info + server URL

**Output (table):**

```
Email:    alice@example.com
Name:     Alice
Role:     admin
Server:   https://hostbox.example.com
```

**Output (`--json`):**

```json
{
  "user": {
    "id": "usr_abc123",
    "email": "alice@example.com",
    "display_name": "Alice",
    "is_admin": true
  },
  "server_url": "https://hostbox.example.com"
}
```

---

#### 2.8.4 `hostbox projects`

```go
var projectsCmd = &cobra.Command{
    Use:     "projects",
    Aliases: []string{"ls"},
    Short:   "List all projects",
    RunE:    runProjectsList,
}

func init() {
    projectsCmd.Flags().Int("page", 1, "Page number")
    projectsCmd.Flags().Int("per-page", 20, "Results per page")
    projectsCmd.Flags().String("search", "", "Search by name")

    // Subcommand
    projectsCmd.AddCommand(projectCreateCmd)
}
```

**API Call:** `GET /api/v1/projects?page=1&per_page=20&search=`

**Output (table):**

```
NAME            SLUG            FRAMEWORK   REPO                    LAST DEPLOY
─────────────────────────────────────────────────────────────────────────────────
My App          my-app          nextjs      owner/my-app            2m ago (✓ ready)
Dashboard       dashboard       vite        owner/dashboard         1h ago (✓ ready)
Blog            blog            astro       owner/blog              3d ago (✗ failed)
```

**Output (`--json`):**

```json
{
  "projects": [
    {
      "id": "prj_abc",
      "name": "My App",
      "slug": "my-app",
      "framework": "nextjs",
      "github_repo": "owner/my-app",
      "production_branch": "main",
      "created_at": "2024-01-15T10:30:00Z"
    }
  ],
  "pagination": { "total": 3, "page": 1, "per_page": 20, "total_pages": 1 }
}
```

---

#### 2.8.5 `hostbox project create`

```go
var projectCreateCmd = &cobra.Command{
    Use:   "create",
    Short: "Create a new project interactively",
    RunE:  runProjectCreate,
}

func init() {
    projectCreateCmd.Flags().String("name", "", "Project name")
    projectCreateCmd.Flags().String("repo", "", "GitHub repository (owner/repo)")
    projectCreateCmd.Flags().String("framework", "", "Framework override (nextjs, vite, astro, cra, gatsby, nuxt, sveltekit, hugo, static)")
    projectCreateCmd.Flags().String("build-command", "", "Custom build command")
    projectCreateCmd.Flags().String("install-command", "", "Custom install command")
    projectCreateCmd.Flags().String("output-dir", "", "Custom output directory")
    projectCreateCmd.Flags().String("root-dir", "", "Root directory (for monorepos)")
    projectCreateCmd.Flags().String("node-version", "", "Node.js version (18, 20, 22)")
    projectCreateCmd.Flags().String("branch", "main", "Production branch")
}
```

**Flow (interactive, if flags not provided):**

1. Prompt: `Project name:` → auto-generate slug
2. Fetch GitHub installations: `GET /api/v1/github/installations`
3. If installations exist, fetch repos: `GET /api/v1/github/repos?installation_id=X`
4. Prompt: repo selection (searchable list)
5. Auto-detect framework from repo
6. Prompt: confirm detected settings or override
7. Call `POST /api/v1/projects`
8. Optionally run `hostbox link` for current directory

**Output:**

```
✓ Project "My App" created successfully!

  Slug:       my-app
  Framework:  Next.js (auto-detected)
  Repository: owner/my-app
  Branch:     main

  Dashboard:  https://hostbox.example.com/projects/my-app

Link this directory? (y/N): y
✓ Linked to project "my-app"
```

---

#### 2.8.6 `hostbox link`

```go
var linkCmd = &cobra.Command{
    Use:   "link",
    Short: "Link current directory to a Hostbox project",
    Long:  "Creates a .hostbox.json file in the current directory, linking it to a project.",
    RunE:  runLink,
}

func init() {
    linkCmd.Flags().String("project", "", "Project ID or slug to link (skip interactive selection)")
}
```

**Flow:**

1. If `--project` provided: validate project exists via API
2. Else: fetch projects list, prompt user to select one
3. Write `.hostbox.json` to current directory
4. Add `.hostbox.json` to `.gitignore` if not already present (prompt user)

**Output:**

```
Select a project:
  ❯ my-app (owner/my-app)
    dashboard (owner/dashboard)
    blog (owner/blog)

✓ Linked to project "my-app"
  Created .hostbox.json
```

---

#### 2.8.7 `hostbox open`

```go
var openCmd = &cobra.Command{
    Use:   "open",
    Short: "Open project dashboard in browser",
    RunE:  runOpen,
}

func init() {
    openCmd.Flags().Bool("deployment", false, "Open latest deployment URL instead of dashboard")
}
```

**Flow:**

1. Resolve project from `.hostbox.json` (or `--project` flag)
2. Build URL: `{server_url}/projects/{slug}`
3. If `--deployment`: fetch latest deployment URL
4. Open URL with `xdg-open` (Linux), `open` (macOS), `start` (Windows)

**Output:**

```
✓ Opening https://hostbox.example.com/projects/my-app in browser...
```

---

#### 2.8.8 `hostbox deploy`

```go
var deployCmd = &cobra.Command{
    Use:   "deploy",
    Short: "Trigger a deployment for the linked project",
    Long: `Trigger a new deployment and optionally follow the build logs.
By default deploys the current git branch.`,
    RunE: runDeploy,
}

func init() {
    deployCmd.Flags().String("branch", "", "Branch to deploy (default: current git branch)")
    deployCmd.Flags().String("commit", "", "Specific commit SHA to deploy")
    deployCmd.Flags().Bool("prod", false, "Force production deployment")
    deployCmd.Flags().Bool("no-follow", false, "Don't follow build logs after triggering")
}
```

**Flow:**

1. Resolve project from `.hostbox.json`
2. Detect current git branch (`git rev-parse --abbrev-ref HEAD`) if `--branch` not given
3. Call `POST /api/v1/projects/{id}/deployments` with `{ branch, commit_sha? }`
4. Print deployment created info
5. Unless `--no-follow`: stream build logs via SSE (see §2.10)
6. On completion: print deployment URL or error

**Output (with log streaming):**

```
✓ Deployment triggered for my-app (branch: feat/login)

  Deployment:  dpl_x1y2z3
  Branch:      feat/login
  Commit:      a1b2c3d (feat: add login page)

▶ Cloning repository...
▶ Detected framework: Next.js
▶ Node.js version: 20
▶ Package manager: pnpm
▶ Running: pnpm install
  added 1234 packages in 12s
▶ Running: pnpm run build
  ✓ Compiled successfully
  ✓ Generating static pages (24/24)
  ✓ Finalizing page optimization
▶ Build complete (30.2s)
▶ Output: 4.2 MB (23 files)

✓ Deployment ready!
  URL: https://my-app-x1y2z3a4.hostbox.example.com
  Duration: 45s
```

---

#### 2.8.9 `hostbox status`

```go
var statusCmd = &cobra.Command{
    Use:   "status",
    Short: "Show current deployment status",
    RunE:  runStatus,
}

func init() {
    statusCmd.Flags().String("deployment", "", "Specific deployment ID (default: latest)")
}
```

**API Call:** `GET /api/v1/projects/{id}/deployments?per_page=1` (latest) or `GET /api/v1/deployments/{id}`

**Output (table):**

```
Project:      my-app
Deployment:   dpl_x1y2z3
Status:       ✓ ready
Branch:       main
Commit:       a1b2c3d — "feat: add login page"
Author:       Alice
URL:          https://my-app-x1y2z3a4.hostbox.example.com
Duration:     45s
Created:      2 minutes ago
```

**Output (`--json`):**

```json
{
  "deployment": {
    "id": "dpl_x1y2z3",
    "project_id": "prj_abc",
    "status": "ready",
    "branch": "main",
    "commit_sha": "a1b2c3d4e5f6",
    "commit_message": "feat: add login page",
    "commit_author": "Alice",
    "deployment_url": "https://my-app-x1y2z3a4.hostbox.example.com",
    "build_duration_ms": 45000,
    "artifact_size_bytes": 4404019,
    "is_production": true,
    "created_at": "2024-01-15T10:30:00Z",
    "completed_at": "2024-01-15T10:30:45Z"
  }
}
```

---

#### 2.8.10 `hostbox logs`

```go
var logsCmd = &cobra.Command{
    Use:   "logs [deployment-id]",
    Short: "Stream or view build logs",
    Long: `View build logs for a deployment. If no deployment ID is given,
shows logs for the latest deployment. For active builds, logs stream in real-time.`,
    Args: cobra.MaximumNArgs(1),
    RunE: runLogs,
}

func init() {
    logsCmd.Flags().BoolP("follow", "f", false, "Follow log output (stream in real-time)")
    logsCmd.Flags().Int("tail", 0, "Number of lines to show from the end (0 = all)")
    logsCmd.Flags().Bool("no-color", false, "Strip ANSI colors from output")
}
```

**Flow:**

1. If deployment ID provided: use it. Else: fetch latest deployment for project.
2. If deployment is `building` or `queued` (or `--follow`): connect to SSE stream
3. Else: fetch static logs via `GET /api/v1/deployments/{id}/logs`

**SSE streaming** (see §2.10 for details)

**Output (static):**

```
[10:30:01] ▶ Cloning repository...
[10:30:03] ▶ Detected framework: Next.js
[10:30:03] ▶ Running: pnpm install
[10:30:15]   added 1234 packages in 12s
[10:30:15] ▶ Running: pnpm run build
[10:30:45] ✓ Build complete (30.2s)
[10:30:45] ▶ Output: 4.2 MB (23 files)
[10:30:46] ✓ Deployment ready!
```

---

#### 2.8.11 `hostbox rollback`

```go
var rollbackCmd = &cobra.Command{
    Use:   "rollback [deployment-id]",
    Short: "Rollback to a previous deployment",
    Long: `Rollback the production deployment to a previous successful build.
If no deployment ID is given, rolls back to the previous production deployment.`,
    Args: cobra.MaximumNArgs(1),
    RunE: runRollback,
}

func init() {
    rollbackCmd.Flags().Bool("last", false, "Rollback to the previous production deployment")
    rollbackCmd.Flags().BoolP("yes", "y", false, "Skip confirmation prompt")
}
```

**Flow:**

1. If `--last`: fetch the second-most-recent production deployment
2. If deployment ID provided: use it
3. Show confirmation prompt (unless `--yes`):
   ```
   Rollback my-app production to deployment dpl_abc123?
     Commit: a1b2c3d — "previous feature"
     Created: 2 days ago

   Continue? (y/N):
   ```
4. Call `POST /api/v1/deployments/{id}/rollback`
5. Print result

**Output:**

```
✓ Rolled back my-app to deployment dpl_abc123
  URL: https://my-app.hostbox.example.com
  Commit: a1b2c3d — "previous feature"
  Note: Rollback is instant (no rebuild required)
```

---

#### 2.8.12 `hostbox domains`

```go
var domainsCmd = &cobra.Command{
    Use:     "domains",
    Aliases: []string{"domain"},
    Short:   "Manage custom domains",
    RunE:    runDomainsList, // Default: list
}

var domainsAddCmd = &cobra.Command{
    Use:   "add <domain>",
    Short: "Add a custom domain",
    Args:  cobra.ExactArgs(1),
    RunE:  runDomainsAdd,
}

var domainsRemoveCmd = &cobra.Command{
    Use:     "remove <domain>",
    Aliases: []string{"rm"},
    Short:   "Remove a custom domain",
    Args:    cobra.ExactArgs(1),
    RunE:    runDomainsRemove,
}

var domainsVerifyCmd = &cobra.Command{
    Use:   "verify <domain>",
    Short: "Verify domain DNS configuration",
    Args:  cobra.ExactArgs(1),
    RunE:  runDomainsVerify,
}

func init() {
    domainsCmd.AddCommand(domainsAddCmd)
    domainsCmd.AddCommand(domainsRemoveCmd)
    domainsCmd.AddCommand(domainsVerifyCmd)

    domainsRemoveCmd.Flags().BoolP("yes", "y", false, "Skip confirmation")
}
```

**`hostbox domains` (list) output:**

```
DOMAIN                  STATUS      VERIFIED AT      SSL
───────────────────────────────────────────────────────────
myapp.com               ✓ verified  2024-01-10       ✓ active
www.myapp.com           ✓ verified  2024-01-10       ✓ active
staging.myapp.com       ✗ pending   —                —
```

**`hostbox domains add` output:**

```
✓ Domain "blog.myapp.com" added to project "my-app"

Configure your DNS with one of the following:

  A Record:     blog.myapp.com  →  203.0.113.1
  CNAME Record: blog.myapp.com  →  my-app.hostbox.example.com

Then run: hostbox domains verify blog.myapp.com
```

**`hostbox domains verify` output (success):**

```
✓ Domain "blog.myapp.com" verified!
  SSL certificate will be provisioned automatically.
```

**`hostbox domains verify` output (failure):**

```
✗ Domain "blog.myapp.com" verification failed

  Expected DNS to resolve to: 203.0.113.1
  Current resolution:          198.51.100.5

  Please update your DNS records and try again.
  DNS changes can take up to 48 hours to propagate.
```

---

#### 2.8.13 `hostbox env`

```go
var envCmd = &cobra.Command{
    Use:     "env",
    Aliases: []string{"envvars"},
    Short:   "Manage environment variables",
    RunE:    runEnvList, // Default: list
}

var envSetCmd = &cobra.Command{
    Use:   "set <KEY=VALUE> [KEY2=VALUE2...]",
    Short: "Set one or more environment variables",
    Args:  cobra.MinimumNArgs(1),
    RunE:  runEnvSet,
}

var envDeleteCmd = &cobra.Command{
    Use:     "delete <KEY> [KEY2...]",
    Aliases: []string{"rm", "unset"},
    Short:   "Delete environment variables",
    Args:    cobra.MinimumNArgs(1),
    RunE:    runEnvDelete,
}

var envImportCmd = &cobra.Command{
    Use:   "import <file>",
    Short: "Import environment variables from a .env file",
    Args:  cobra.ExactArgs(1),
    RunE:  runEnvImport,
}

var envExportCmd = &cobra.Command{
    Use:   "export",
    Short: "Export environment variables to stdout (non-secret only)",
    RunE:  runEnvExport,
}

func init() {
    envCmd.AddCommand(envSetCmd)
    envCmd.AddCommand(envDeleteCmd)
    envCmd.AddCommand(envImportCmd)
    envCmd.AddCommand(envExportCmd)

    envSetCmd.Flags().Bool("secret", false, "Mark as secret (write-only)")
    envSetCmd.Flags().String("scope", "all", "Scope: all, preview, production")

    envImportCmd.Flags().Bool("secret", false, "Mark all imported vars as secret")
    envImportCmd.Flags().String("scope", "all", "Scope for all imported vars")
    envImportCmd.Flags().Bool("overwrite", false, "Overwrite existing variables")

    envExportCmd.Flags().String("scope", "", "Filter by scope")
}
```

**`hostbox env` (list) output:**

```
KEY                SCOPE        SECRET    VALUE
──────────────────────────────────────────────────────────
API_KEY            all          yes       ••••••••
DATABASE_URL       production   yes       ••••••••
NEXT_PUBLIC_URL    all          no        https://myapp.com
ANALYTICS_ID       production   no        UA-12345678
DEBUG              preview      no        true
```

**`hostbox env set` flow:**

```bash
# Single variable
hostbox env set API_KEY=sk_live_abc123 --secret

# Multiple variables
hostbox env set DATABASE_URL=postgres://... REDIS_URL=redis://... --scope=production

# Output:
# ✓ Set API_KEY (scope: all, secret: yes)
```

**`hostbox env import` flow:**

```bash
hostbox env import .env.production --scope=production --overwrite
```

```
Importing environment variables from .env.production...

  ✓ Set DATABASE_URL (new)
  ✓ Set REDIS_URL (new)
  ✓ Set API_KEY (updated)
  • Skipped EXISTING_VAR (use --overwrite to replace)

Summary: 2 created, 1 updated, 1 skipped
```

**`hostbox env export` output:**

```bash
# Exported from Hostbox — project: my-app
# Secret variables are excluded
NEXT_PUBLIC_URL=https://myapp.com
ANALYTICS_ID=UA-12345678
DEBUG=true
```

---

#### 2.8.14 `hostbox admin backup`

```go
var adminCmd = &cobra.Command{
    Use:   "admin",
    Short: "Administrative commands (admin users only)",
}

var adminBackupCmd = &cobra.Command{
    Use:   "backup",
    Short: "Create a database backup",
    RunE:  runAdminBackup,
}

func init() {
    adminCmd.AddCommand(adminBackupCmd)
    adminCmd.AddCommand(adminRestoreCmd)
    adminCmd.AddCommand(adminUpdateCmd)
    adminCmd.AddCommand(adminResetPasswordCmd)

    adminBackupCmd.Flags().String("output", "", "Output path for backup file (default: server-side /app/data/backups/)")
    adminBackupCmd.Flags().Bool("compress", true, "Compress backup with gzip")
    adminBackupCmd.Flags().Bool("download", false, "Download backup to local machine")
}
```

**API endpoint needed (new):** `POST /api/v1/admin/backup`

```
POST /api/v1/admin/backup
Body: { "compress": true }
Response: {
  "backup": {
    "filename": "hostbox-20240115-103046.db.gz",
    "size_bytes": 524288,
    "path": "/app/data/backups/hostbox-20240115-103046.db.gz"
  }
}
```

**Output:**

```
✓ Backup created successfully!

  File:     hostbox-20240115-103046.db.gz
  Size:     512 KB
  Location: /app/data/backups/hostbox-20240115-103046.db.gz
```

---

#### 2.8.15 `hostbox admin restore`

```go
var adminRestoreCmd = &cobra.Command{
    Use:   "restore --file <backup-file>",
    Short: "Restore database from backup",
    RunE:  runAdminRestore,
}

func init() {
    adminRestoreCmd.Flags().String("file", "", "Backup file path (required)")
    adminRestoreCmd.MarkFlagRequired("file")
    adminRestoreCmd.Flags().BoolP("yes", "y", false, "Skip confirmation prompt")
}
```

**API endpoint needed (new):** `POST /api/v1/admin/restore`

**Flow:**

1. Prompt confirmation (destructive operation):
   ```
   ⚠ WARNING: This will replace the current database with the backup.
   All data created since the backup will be lost.

   Backup file: hostbox-20240115-103046.db.gz

   Are you sure? Type 'yes' to confirm:
   ```
2. Upload backup file to server (or provide server-side path)
3. Server: stop accepting requests, replace DB, run migrations, restart

**Output:**

```
✓ Database restored from hostbox-20240115-103046.db.gz
  Migrations applied: 2 (from version 005 to 007)
  Server restarted successfully
```

---

#### 2.8.16 `hostbox admin update`

```go
var adminUpdateCmd = &cobra.Command{
    Use:   "update",
    Short: "Update Hostbox to the latest version",
    RunE:  runAdminUpdate,
}

func init() {
    adminUpdateCmd.Flags().String("version", "", "Specific version to update to (default: latest)")
    adminUpdateCmd.Flags().Bool("check", false, "Only check for updates, don't install")
    adminUpdateCmd.Flags().BoolP("yes", "y", false, "Skip confirmation prompt")
}
```

**API endpoint needed (new):** `POST /api/v1/admin/update`

**Flow:**

1. Call GitHub API: `GET https://api.github.com/repos/hostbox/hostbox/releases/latest`
2. Compare with current version
3. If up-to-date: `✓ Already running latest version (v1.2.3)`
4. If update available:
   ```
   Update available: v1.2.3 → v1.3.0

   Changes:
     • New framework support: Remix
     • Build cache improvements
     • Bug fixes

   Continue? (y/N):
   ```
5. Execute update (server-side):
   - `docker compose pull`
   - `docker compose up -d`
   - Wait for health check
   - Rollback if health check fails

**Output:**

```
✓ Updated Hostbox from v1.2.3 to v1.3.0
  Server restarted successfully
  Health check: OK
```

---

#### 2.8.17 `hostbox admin reset-password`

```go
var adminResetPasswordCmd = &cobra.Command{
    Use:   "reset-password <email>",
    Short: "Reset a user's password",
    Args:  cobra.ExactArgs(1),
    RunE:  runAdminResetPassword,
}
```

**API endpoint needed (new):** `POST /api/v1/admin/reset-password`

```
POST /api/v1/admin/reset-password
Body: { "email": "user@example.com", "new_password": "..." }
Response: { "success": true }
```

**Flow:**

1. Prompt for new password (hidden input, with confirmation)
2. Call API
3. Print result

**Output:**

```
New password for user@example.com: ********
Confirm password: ********

✓ Password reset for user@example.com
```

---

### 2.9 New API Endpoints Required

These endpoints must be added to the API server to support CLI operations:

| Method | Path                           | Purpose                        | Auth     |
|--------|--------------------------------|--------------------------------|----------|
| POST   | `/api/v1/admin/backup`         | Create database backup         | Admin    |
| POST   | `/api/v1/admin/restore`        | Restore database from backup   | Admin    |
| POST   | `/api/v1/admin/update`         | Trigger self-update            | Admin    |
| GET    | `/api/v1/admin/update/check`   | Check for available updates    | Admin    |
| POST   | `/api/v1/admin/reset-password` | Reset user password            | Admin    |

### 2.10 SSE Log Streaming (Client-Side)

**File: `cmd/cli/internal/client/sse.go`**

```go
type LogStreamHandler struct {
    client    *Client
    noColor   bool
}

func (h *LogStreamHandler) Stream(deploymentID string) error {
    url := fmt.Sprintf("%s/api/v1/deployments/%s/logs/stream", h.client.BaseURL, deploymentID)

    req, _ := http.NewRequest("GET", url, nil)
    req.Header.Set("Authorization", "Bearer "+h.client.Token)
    req.Header.Set("Accept", "text/event-stream")
    req.Header.Set("Cache-Control", "no-cache")

    resp, err := h.client.HTTPClient.Do(req)
    if err != nil {
        return fmt.Errorf("failed to connect to log stream: %w", err)
    }
    defer resp.Body.Close()

    scanner := bufio.NewScanner(resp.Body)
    var eventType string

    for scanner.Scan() {
        line := scanner.Text()

        if strings.HasPrefix(line, "event: ") {
            eventType = strings.TrimPrefix(line, "event: ")
            continue
        }

        if strings.HasPrefix(line, "data: ") {
            data := strings.TrimPrefix(line, "data: ")
            h.handleEvent(eventType, data)

            if eventType == "complete" || eventType == "error" {
                return nil
            }
            continue
        }
    }

    return scanner.Err()
}

func (h *LogStreamHandler) handleEvent(eventType, data string) {
    switch eventType {
    case "log":
        var logEvent struct {
            Line      int    `json:"line"`
            Message   string `json:"message"`
            Timestamp string `json:"timestamp"`
        }
        json.Unmarshal([]byte(data), &logEvent)

        msg := logEvent.Message
        if h.noColor {
            msg = stripANSI(msg)
        }
        fmt.Println(msg)

    case "status":
        var statusEvent struct {
            Status string `json:"status"`
            Phase  string `json:"phase"`
        }
        json.Unmarshal([]byte(data), &statusEvent)
        output.PrintInfo(statusEvent.Phase)

    case "error":
        var errorEvent struct {
            Message string `json:"message"`
        }
        json.Unmarshal([]byte(data), &errorEvent)
        output.PrintError(errorEvent.Message)

    case "complete":
        var completeEvent struct {
            Status     string `json:"status"`
            DurationMs int64  `json:"duration_ms"`
            URL        string `json:"url"`
        }
        json.Unmarshal([]byte(data), &completeEvent)

        if completeEvent.Status == "ready" {
            duration := time.Duration(completeEvent.DurationMs) * time.Millisecond
            output.PrintSuccess(fmt.Sprintf("Deployment ready! (%s)", duration.Round(time.Second)))
            output.PrintInfo(fmt.Sprintf("URL: %s", completeEvent.URL))
        } else {
            output.PrintError("Deployment failed")
        }
    }
}

// stripANSI removes ANSI escape codes for --no-color mode
func stripANSI(s string) string {
    re := regexp.MustCompile(`\x1b\[[0-9;]*m`)
    return re.ReplaceAllString(s, "")
}
```

**SSE reconnection logic:**

```go
func (h *LogStreamHandler) StreamWithRetry(deploymentID string, maxRetries int) error {
    var lastEventID string
    for attempt := 0; attempt <= maxRetries; attempt++ {
        err := h.streamFrom(deploymentID, lastEventID)
        if err == nil {
            return nil // Stream completed normally
        }
        if attempt < maxRetries {
            backoff := time.Duration(1<<attempt) * time.Second
            time.Sleep(backoff)
        }
    }
    return fmt.Errorf("log stream disconnected after %d retries", maxRetries)
}
```

---

## 3. Part B — Background Schedulers

All schedulers run as goroutines in the main `hostbox` binary, started during the process lifecycle (step 5 in ARCHITECTURE.md §2.1).

### 3.1 Scheduler Manager

**File: `internal/services/scheduler/manager.go`**

```go
type SchedulerManager struct {
    gc              *GarbageCollector
    sessionCleaner  *SessionCleaner
    domainVerifier  *DomainReVerifier
    logger          *slog.Logger
}

func (m *SchedulerManager) Start(ctx context.Context) {
    go m.gc.Run(ctx)
    go m.sessionCleaner.Run(ctx)
    go m.domainVerifier.Run(ctx)
    m.logger.Info("background schedulers started",
        "gc_interval", "6h",
        "session_cleanup_interval", "1h",
        "domain_reverify_interval", "24h",
    )
}
```

### 3.2 Garbage Collector

**File: `internal/services/cleanup/gc.go`**

**Interval:** Every 6 hours
**Also triggered:** On startup, or manually via `POST /api/v1/admin/gc` (admin endpoint)

```go
type GarbageCollector struct {
    deployRepo  *repository.DeploymentRepository
    projectRepo *repository.ProjectRepository
    settings    *SettingsService
    docker      *platform.DockerService
    logger      *slog.Logger
}

func (gc *GarbageCollector) Run(ctx context.Context) {
    // Run immediately on startup
    gc.collect(ctx)

    ticker := time.NewTicker(6 * time.Hour)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            gc.logger.Info("garbage collector stopped")
            return
        case <-ticker.C:
            gc.collect(ctx)
        }
    }
}

func (gc *GarbageCollector) collect(ctx context.Context) {
    gc.logger.Info("garbage collection started")
    start := time.Now()

    artifactsRemoved := gc.collectArtifacts(ctx)
    logsRemoved := gc.collectLogs(ctx)
    cachesRemoved := gc.collectCaches(ctx)
    dockerCleaned := gc.collectDockerResources(ctx)

    gc.logger.Info("garbage collection completed",
        "duration", time.Since(start).Round(time.Millisecond),
        "artifacts_removed", artifactsRemoved,
        "logs_removed", logsRemoved,
        "caches_removed", cachesRemoved,
        "docker_cleaned", dockerCleaned,
    )
}
```

#### 3.2.1 Artifact Cleanup

```go
func (gc *GarbageCollector) collectArtifacts(ctx context.Context) int {
    maxDeployments := gc.settings.GetInt("max_deployments_per_project", 10)
    retentionDays := gc.settings.GetInt("artifact_retention_days", 30)
    cutoff := time.Now().AddDate(0, 0, -retentionDays)
    removed := 0

    projects, _ := gc.projectRepo.ListAll(ctx)

    for _, project := range projects {
        // Get all deployments for project, ordered by created_at DESC
        deployments, _ := gc.deployRepo.ListAllByProject(ctx, project.ID)

        // Identify protected deployments
        protected := map[string]bool{}

        // 1. Current production deployment (latest ready + is_production)
        for _, d := range deployments {
            if d.Status == "ready" && d.IsProduction {
                protected[d.ID] = true
                break
            }
        }

        // 2. Latest deployment per active branch (with artifact)
        seenBranches := map[string]bool{}
        for _, d := range deployments {
            if d.Status == "ready" && !seenBranches[d.Branch] && d.ArtifactPath != "" {
                protected[d.ID] = true
                seenBranches[d.Branch] = true
            }
        }

        // 3. From remaining, keep most recent N
        kept := 0
        for _, d := range deployments {
            if protected[d.ID] {
                continue
            }
            if d.ArtifactPath == "" {
                continue // Already cleaned
            }

            kept++
            if kept <= maxDeployments {
                continue // Within retention count
            }

            // Check age-based retention
            createdAt, _ := time.Parse(time.RFC3339, d.CreatedAt)
            if createdAt.After(cutoff) && kept <= maxDeployments*2 {
                continue // Within age retention and reasonable count
            }

            // DELETE artifact directory
            os.RemoveAll(d.ArtifactPath)

            // DELETE log file
            if d.LogPath != "" {
                os.Remove(d.LogPath)
            }

            // UPDATE DB: clear paths but keep record for history
            gc.deployRepo.ClearArtifact(ctx, d.ID)
            removed++
        }
    }

    return removed
}
```

**SQL for `ClearArtifact`:**

```sql
UPDATE deployments
SET artifact_path = NULL, log_path = NULL
WHERE id = ?;
```

#### 3.2.2 Docker Cleanup

```go
func (gc *GarbageCollector) collectDockerResources(ctx context.Context) int {
    cleaned := 0

    // 1. Remove stopped containers with hostbox.managed label
    containers, _ := gc.docker.ListContainers(ctx, filters.NewArgs(
        filters.Arg("label", "hostbox.managed=true"),
        filters.Arg("status", "exited"),
    ))
    for _, c := range containers {
        gc.docker.RemoveContainer(ctx, c.ID)
        cleaned++
    }

    // 2. Remove dangling images
    images, _ := gc.docker.ListImages(ctx, filters.NewArgs(
        filters.Arg("dangling", "true"),
    ))
    for _, img := range images {
        gc.docker.RemoveImage(ctx, img.ID)
        cleaned++
    }

    // 3. Prune unused build cache (older than 7 days)
    gc.docker.BuildCachePrune(ctx, filters.NewArgs(
        filters.Arg("until", "168h"),
    ))

    return cleaned
}
```

#### 3.2.3 Log Cleanup

```go
func (gc *GarbageCollector) collectLogs(ctx context.Context) int {
    // Find orphaned log files — files on disk with no matching deployment.log_path
    logDir := "/app/logs"
    entries, _ := os.ReadDir(logDir)
    removed := 0

    for _, entry := range entries {
        if entry.IsDir() {
            continue
        }
        deploymentID := strings.TrimSuffix(entry.Name(), ".log")
        exists, _ := gc.deployRepo.HasLogPath(ctx, deploymentID)
        if !exists {
            os.Remove(filepath.Join(logDir, entry.Name()))
            removed++
        }
    }

    return removed
}
```

**SQL for `HasLogPath`:**

```sql
SELECT EXISTS(SELECT 1 FROM deployments WHERE id = ? AND log_path IS NOT NULL);
```

#### 3.2.4 Cache Cleanup

```go
func (gc *GarbageCollector) collectCaches(ctx context.Context) int {
    // Remove cache volumes for deleted projects
    volumes, _ := gc.docker.ListVolumes(ctx, filters.NewArgs(
        filters.Arg("label", "hostbox.cache=true"),
    ))
    removed := 0

    for _, vol := range volumes {
        projectID := vol.Labels["hostbox.project"]
        exists, _ := gc.projectRepo.Exists(ctx, projectID)
        if !exists {
            gc.docker.RemoveVolume(ctx, vol.Name)
            removed++
        }
    }

    return removed
}
```

### 3.3 Session Cleaner

**File: `internal/services/cleanup/session_cleaner.go`**

**Interval:** Every 1 hour

```go
type SessionCleaner struct {
    db     *sql.DB
    logger *slog.Logger
}

func (sc *SessionCleaner) Run(ctx context.Context) {
    ticker := time.NewTicker(1 * time.Hour)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            sc.clean(ctx)
        }
    }
}

func (sc *SessionCleaner) clean(ctx context.Context) {
    result, err := sc.db.ExecContext(ctx,
        "DELETE FROM sessions WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now')")
    if err != nil {
        sc.logger.Error("session cleanup failed", "error", err)
        return
    }
    count, _ := result.RowsAffected()
    if count > 0 {
        sc.logger.Info("expired sessions cleaned", "count", count)
    }
}
```

### 3.4 Domain Re-Verifier

**File: `internal/services/cleanup/domain_reverifier.go`**

**Interval:** Every 24 hours

```go
const domainGracePeriodDays = 7

type DomainReVerifier struct {
    domainRepo *repository.DomainRepository
    domainSvc  *domain.DomainService
    logger     *slog.Logger
}

func (rv *DomainReVerifier) Run(ctx context.Context) {
    ticker := time.NewTicker(24 * time.Hour)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            rv.reverify(ctx)
        }
    }
}

func (rv *DomainReVerifier) reverify(ctx context.Context) {
    domains, _ := rv.domainRepo.ListVerified(ctx)
    rv.logger.Info("domain re-verification started", "count", len(domains))

    for _, d := range domains {
        err := rv.domainSvc.CheckDNS(ctx, d.Domain)
        now := time.Now().UTC().Format(time.RFC3339)

        if err != nil {
            rv.logger.Warn("domain DNS check failed",
                "domain", d.Domain,
                "project_id", d.ProjectID,
                "error", err,
            )

            // Check if within grace period
            verifiedAt, _ := time.Parse(time.RFC3339, d.VerifiedAt)
            if time.Since(verifiedAt) > domainGracePeriodDays*24*time.Hour {
                // Grace period expired: mark as unverified
                rv.domainRepo.UpdateVerification(ctx, d.ID, false, now)
                rv.logger.Warn("domain marked unverified (grace period expired)",
                    "domain", d.Domain,
                )
                // NOTE: Do NOT remove Caddy route yet — admin should review
            }
            // Within grace period: log warning only, keep verified status
        } else {
            // DNS still valid, update last_checked_at
            rv.domainRepo.UpdateLastChecked(ctx, d.ID, now)
        }
    }
}
```

**SQL for `UpdateVerification`:**

```sql
UPDATE domains SET verified = ?, last_checked_at = ? WHERE id = ?;
```

**SQL for `UpdateLastChecked`:**

```sql
UPDATE domains SET last_checked_at = ? WHERE id = ?;
```

---

## 4. Part C — Notification System

### 4.1 Architecture

**File: `internal/services/notification/service.go`**

```go
type NotificationService struct {
    repo    *repository.NotificationRepository
    clients map[string]NotificationClient
    logger  *slog.Logger
}

type NotificationClient interface {
    Send(ctx context.Context, webhookURL string, payload NotificationPayload) error
}

type NotificationPayload struct {
    Event       string            `json:"event"`        // "deploy_success", "deploy_failure", etc.
    Project     ProjectInfo       `json:"project"`
    Deployment  *DeploymentInfo   `json:"deployment,omitempty"`
    Domain      *DomainInfo       `json:"domain,omitempty"`
    Timestamp   string            `json:"timestamp"`
    ServerURL   string            `json:"server_url"`
}

type ProjectInfo struct {
    ID   string `json:"id"`
    Name string `json:"name"`
    Slug string `json:"slug"`
}

type DeploymentInfo struct {
    ID              string `json:"id"`
    Status          string `json:"status"`
    Branch          string `json:"branch"`
    CommitSHA       string `json:"commit_sha"`
    CommitMessage   string `json:"commit_message"`
    CommitAuthor    string `json:"commit_author"`
    DeploymentURL   string `json:"deployment_url"`
    DashboardURL    string `json:"dashboard_url"`
    BuildDurationMs int64  `json:"build_duration_ms"`
    IsProduction    bool   `json:"is_production"`
    ErrorMessage    string `json:"error_message,omitempty"`
}

type DomainInfo struct {
    ID       string `json:"id"`
    Domain   string `json:"domain"`
    Verified bool   `json:"verified"`
}
```

### 4.2 Event Dispatch

```go
// Supported events
const (
    EventDeploySuccess    = "deploy_success"
    EventDeployFailure    = "deploy_failure"
    EventDomainVerified   = "domain_verified"
    EventDomainUnverified = "domain_unverified"
)

func (s *NotificationService) Dispatch(ctx context.Context, event string, payload NotificationPayload) {
    payload.Event = event
    payload.Timestamp = time.Now().UTC().Format(time.RFC3339)

    // Fetch matching notification configs (project-level + global)
    configs, _ := s.repo.FindByProjectAndEvent(ctx, payload.Project.ID, event)
    globalConfigs, _ := s.repo.FindGlobalByEvent(ctx, event)
    configs = append(configs, globalConfigs...)

    for _, cfg := range configs {
        if !cfg.Enabled {
            continue
        }

        client, ok := s.clients[cfg.Channel]
        if !ok {
            s.logger.Error("unknown notification channel", "channel", cfg.Channel)
            continue
        }

        // Fire-and-forget with retry (don't block the caller)
        go s.sendWithRetry(ctx, client, cfg.WebhookURL, payload, 3)
    }
}

func (s *NotificationService) sendWithRetry(
    ctx context.Context,
    client NotificationClient,
    webhookURL string,
    payload NotificationPayload,
    maxRetries int,
) {
    for attempt := 0; attempt <= maxRetries; attempt++ {
        err := client.Send(ctx, webhookURL, payload)
        if err == nil {
            return
        }

        s.logger.Warn("notification send failed",
            "attempt", attempt+1,
            "max_retries", maxRetries,
            "error", err,
        )

        if attempt < maxRetries {
            backoff := time.Duration(1<<attempt) * time.Second // 1s, 2s, 4s
            select {
            case <-ctx.Done():
                return
            case <-time.After(backoff):
            }
        }
    }

    s.logger.Error("notification permanently failed after retries",
        "event", payload.Event,
        "project", payload.Project.Slug,
    )
}
```

**SQL for `FindByProjectAndEvent`:**

```sql
SELECT id, project_id, channel, webhook_url, events, enabled
FROM notification_configs
WHERE project_id = ? AND enabled = TRUE
  AND (events = 'all' OR events LIKE '%' || ? || '%');
```

**SQL for `FindGlobalByEvent`:**

```sql
SELECT id, project_id, channel, webhook_url, events, enabled
FROM notification_configs
WHERE project_id IS NULL AND enabled = TRUE
  AND (events = 'all' OR events LIKE '%' || ? || '%');
```

### 4.3 Discord Client

**File: `internal/services/notification/discord.go`**

```go
type DiscordClient struct {
    httpClient *http.Client
}

func (c *DiscordClient) Send(ctx context.Context, webhookURL string, payload NotificationPayload) error {
    embed := c.buildEmbed(payload)

    body := map[string]any{
        "embeds": []any{embed},
    }

    data, _ := json.Marshal(body)
    req, _ := http.NewRequestWithContext(ctx, "POST", webhookURL, bytes.NewReader(data))
    req.Header.Set("Content-Type", "application/json")

    resp, err := c.httpClient.Do(req)
    if err != nil {
        return err
    }
    defer resp.Body.Close()

    if resp.StatusCode >= 400 {
        return fmt.Errorf("discord webhook returned %d", resp.StatusCode)
    }
    return nil
}
```

**Discord embed colors:**

| Event              | Color   | Hex       |
|--------------------|---------|-----------|
| deploy_success     | Green   | `#2ECC71` (3066993)  |
| deploy_failure     | Red     | `#E74C3C` (15158332) |
| domain_verified    | Blue    | `#3498DB` (3447003)  |
| domain_unverified  | Orange  | `#E67E22` (15105570) |

**Full Discord payload (`deploy_success`):**

```json
{
  "embeds": [{
    "title": "✅ Deployment Ready — My App",
    "description": "Branch: `feat/login` | Commit: `a1b2c3d`\nfeat: add login page",
    "url": "https://my-app-a1b2c3d4.hostbox.example.com",
    "color": 3066993,
    "fields": [
      { "name": "Duration", "value": "45s", "inline": true },
      { "name": "Status", "value": "Ready", "inline": true },
      { "name": "URL", "value": "[Open Preview](https://my-app-a1b2c3d4.hostbox.example.com)", "inline": false }
    ],
    "timestamp": "2024-01-15T10:30:46Z"
  }]
}
```

**Full Discord payload (`deploy_failure`):**

```json
{
  "embeds": [{
    "title": "❌ Deployment Failed — My App",
    "description": "Branch: `feat/login` | Commit: `a1b2c3d`\nfeat: add login page",
    "url": "https://hostbox.example.com/projects/my-app/deployments/dpl_x1y2z3",
    "color": 15158332,
    "fields": [
      { "name": "Error", "value": "Build failed: Module not found: 'react-dom'", "inline": false },
      { "name": "Logs", "value": "[View Logs](https://hostbox.example.com/projects/my-app/deployments/dpl_x1y2z3)", "inline": false }
    ],
    "timestamp": "2024-01-15T10:31:15Z"
  }]
}
```

**Full Discord payload (`domain_verified`):**

```json
{
  "embeds": [{
    "title": "🌐 Domain Verified — myapp.com",
    "description": "Domain `myapp.com` has been verified for project **My App**.\nSSL certificate will be provisioned automatically.",
    "color": 3447003,
    "timestamp": "2024-01-15T14:22:00Z"
  }]
}
```

**Full Discord payload (`domain_unverified`):**

```json
{
  "embeds": [{
    "title": "⚠️ Domain Unverified — myapp.com",
    "description": "Domain `myapp.com` for project **My App** failed DNS verification.\nPlease check your DNS configuration.",
    "color": 15105570,
    "timestamp": "2024-01-16T14:22:00Z"
  }]
}
```

### 4.4 Slack Client

**File: `internal/services/notification/slack.go`**

```go
type SlackClient struct {
    httpClient *http.Client
}

func (c *SlackClient) Send(ctx context.Context, webhookURL string, payload NotificationPayload) error {
    blocks := c.buildBlocks(payload)

    body := map[string]any{
        "blocks": blocks,
    }

    data, _ := json.Marshal(body)
    req, _ := http.NewRequestWithContext(ctx, "POST", webhookURL, bytes.NewReader(data))
    req.Header.Set("Content-Type", "application/json")

    resp, err := c.httpClient.Do(req)
    if err != nil {
        return err
    }
    defer resp.Body.Close()

    if resp.StatusCode != 200 {
        return fmt.Errorf("slack webhook returned %d", resp.StatusCode)
    }
    return nil
}
```

**Slack Block Kit payload (`deploy_success`):**

```json
{
  "blocks": [
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "✅ Deployment Ready — My App", "emoji": true }
    },
    {
      "type": "section",
      "fields": [
        { "type": "mrkdwn", "text": "*Branch:*\n`feat/login`" },
        { "type": "mrkdwn", "text": "*Status:*\nReady" },
        { "type": "mrkdwn", "text": "*Commit:*\n`a1b2c3d` — feat: add login page" },
        { "type": "mrkdwn", "text": "*Duration:*\n45s" }
      ]
    },
    {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "Open Preview" },
          "url": "https://my-app-a1b2c3d4.hostbox.example.com"
        },
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "View Dashboard" },
          "url": "https://hostbox.example.com/projects/my-app/deployments/dpl_x1y2z3"
        }
      ]
    },
    {
      "type": "context",
      "elements": [
        { "type": "mrkdwn", "text": "Hostbox • <https://hostbox.example.com|Dashboard>" }
      ]
    }
  ]
}
```

**Slack Block Kit payload (`deploy_failure`):**

```json
{
  "blocks": [
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "❌ Deployment Failed — My App", "emoji": true }
    },
    {
      "type": "section",
      "fields": [
        { "type": "mrkdwn", "text": "*Branch:*\n`feat/login`" },
        { "type": "mrkdwn", "text": "*Commit:*\n`a1b2c3d`" }
      ]
    },
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "*Error:*\n```Build failed: Module not found: 'react-dom'```" }
    },
    {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "View Logs" },
          "url": "https://hostbox.example.com/projects/my-app/deployments/dpl_x1y2z3",
          "style": "danger"
        }
      ]
    },
    {
      "type": "context",
      "elements": [
        { "type": "mrkdwn", "text": "Hostbox • <https://hostbox.example.com|Dashboard>" }
      ]
    }
  ]
}
```

### 4.5 Generic Webhook Client

**File: `internal/services/notification/webhook.go`**

```go
type WebhookClient struct {
    httpClient *http.Client
}

func (c *WebhookClient) Send(ctx context.Context, webhookURL string, payload NotificationPayload) error {
    data, _ := json.Marshal(payload)
    req, _ := http.NewRequestWithContext(ctx, "POST", webhookURL, bytes.NewReader(data))
    req.Header.Set("Content-Type", "application/json")
    req.Header.Set("User-Agent", "Hostbox-Webhook/1.0")
    req.Header.Set("X-Hostbox-Event", payload.Event)

    resp, err := c.httpClient.Do(req)
    if err != nil {
        return err
    }
    defer resp.Body.Close()

    if resp.StatusCode >= 400 {
        return fmt.Errorf("webhook returned %d", resp.StatusCode)
    }
    return nil
}
```

**Generic webhook payload (`deploy_success`):**

```json
{
  "event": "deploy_success",
  "project": {
    "id": "prj_abc123",
    "name": "My App",
    "slug": "my-app"
  },
  "deployment": {
    "id": "dpl_x1y2z3",
    "status": "ready",
    "branch": "feat/login",
    "commit_sha": "a1b2c3d4e5f6",
    "commit_message": "feat: add login page",
    "commit_author": "Alice",
    "deployment_url": "https://my-app-a1b2c3d4.hostbox.example.com",
    "dashboard_url": "https://hostbox.example.com/projects/my-app/deployments/dpl_x1y2z3",
    "build_duration_ms": 45000,
    "is_production": false,
    "error_message": ""
  },
  "domain": null,
  "timestamp": "2024-01-15T10:30:46Z",
  "server_url": "https://hostbox.example.com"
}
```

**Generic webhook payload (`domain_verified`):**

```json
{
  "event": "domain_verified",
  "project": {
    "id": "prj_abc123",
    "name": "My App",
    "slug": "my-app"
  },
  "deployment": null,
  "domain": {
    "id": "dom_xyz789",
    "domain": "myapp.com",
    "verified": true
  },
  "timestamp": "2024-01-15T14:22:00Z",
  "server_url": "https://hostbox.example.com"
}
```

### 4.6 Service Initialization

```go
func NewNotificationService(repo *repository.NotificationRepository, logger *slog.Logger) *NotificationService {
    httpClient := &http.Client{Timeout: 10 * time.Second}

    return &NotificationService{
        repo: repo,
        clients: map[string]NotificationClient{
            "discord": &DiscordClient{httpClient: httpClient},
            "slack":   &SlackClient{httpClient: httpClient},
            "webhook": &WebhookClient{httpClient: httpClient},
        },
        logger: logger,
    }
}
```

---

## 5. Part D — Backup & Restore

### 5.1 Backup Service

**File: `internal/services/backup/service.go`**

```go
type BackupService struct {
    db         *sql.DB
    backupDir  string // /app/data/backups/
    maxBackups int    // Default: 5
    logger     *slog.Logger
}

type BackupResult struct {
    Filename  string `json:"filename"`
    Path      string `json:"path"`
    SizeBytes int64  `json:"size_bytes"`
}

func (s *BackupService) CreateBackup(ctx context.Context, compress bool) (*BackupResult, error) {
    os.MkdirAll(s.backupDir, 0700)

    timestamp := time.Now().Format("20060102-150405")
    filename := fmt.Sprintf("hostbox-%s.db", timestamp)
    destPath := filepath.Join(s.backupDir, filename)

    // SQLite online backup — safe while database is in use (WAL mode)
    _, err := s.db.ExecContext(ctx, fmt.Sprintf("VACUUM INTO '%s'", destPath))
    if err != nil {
        return nil, fmt.Errorf("backup failed: %w", err)
    }

    var finalPath string
    var size int64

    if compress {
        gzPath := destPath + ".gz"
        if err := gzipFile(destPath, gzPath); err != nil {
            return nil, fmt.Errorf("compression failed: %w", err)
        }
        os.Remove(destPath) // Remove uncompressed version
        finalPath = gzPath
        fi, _ := os.Stat(gzPath)
        size = fi.Size()
        filename += ".gz"
    } else {
        finalPath = destPath
        fi, _ := os.Stat(destPath)
        size = fi.Size()
    }

    // Enforce retention: keep only last N backups
    s.enforceRetention()

    s.logger.Info("backup created",
        "path", finalPath,
        "size_bytes", size,
        "compressed", compress,
    )

    return &BackupResult{
        Filename:  filename,
        Path:      finalPath,
        SizeBytes: size,
    }, nil
}
```

**Retention enforcement:**

```go
func (s *BackupService) enforceRetention() {
    entries, _ := os.ReadDir(s.backupDir)

    // Filter to hostbox backup files
    var backups []os.DirEntry
    for _, e := range entries {
        if strings.HasPrefix(e.Name(), "hostbox-") && !e.IsDir() {
            backups = append(backups, e)
        }
    }

    // Sort by name descending (timestamp-based, newest first)
    sort.Slice(backups, func(i, j int) bool {
        return backups[i].Name() > backups[j].Name()
    })

    // Remove excess backups beyond maxBackups
    for i := s.maxBackups; i < len(backups); i++ {
        path := filepath.Join(s.backupDir, backups[i].Name())
        os.Remove(path)
        s.logger.Info("old backup removed", "path", path)
    }
}
```

**gzip helper:**

```go
func gzipFile(src, dst string) error {
    in, err := os.Open(src)
    if err != nil {
        return err
    }
    defer in.Close()

    out, err := os.Create(dst)
    if err != nil {
        return err
    }
    defer out.Close()

    gw := gzip.NewWriter(out)
    defer gw.Close()

    _, err = io.Copy(gw, in)
    return err
}
```

### 5.2 Restore Service

```go
func (s *BackupService) Restore(ctx context.Context, backupPath string) error {
    // 1. Validate backup file exists and is a valid SQLite database
    if err := s.validateBackup(backupPath); err != nil {
        return fmt.Errorf("invalid backup file: %w", err)
    }

    // 2. Decompress if gzipped
    dbPath := backupPath
    if strings.HasSuffix(backupPath, ".gz") {
        dbPath = strings.TrimSuffix(backupPath, ".gz") + ".restore-tmp"
        if err := gunzipFile(backupPath, dbPath); err != nil {
            return fmt.Errorf("decompression failed: %w", err)
        }
        defer os.Remove(dbPath)
    }

    // 3. Close current DB connection
    s.db.Close()

    // 4. Create safety backup of current database
    currentDB := "/app/data/hostbox.db"
    safetyBackup := currentDB + ".pre-restore"
    copyFile(currentDB, safetyBackup)

    // 5. Replace database file
    if err := copyFile(dbPath, currentDB); err != nil {
        // Restore safety backup on failure
        copyFile(safetyBackup, currentDB)
        return fmt.Errorf("database replacement failed: %w", err)
    }

    // 6. Remove stale WAL/SHM files from old database
    os.Remove(currentDB + "-wal")
    os.Remove(currentDB + "-shm")

    // 7. Server will restart after restore (triggered by caller)
    //    On restart: DB reopens, migrations run, Caddy resyncs

    s.logger.Info("database restored", "from", backupPath)
    return nil
}

func (s *BackupService) validateBackup(path string) error {
    actualPath := path
    // If gzipped, we need to decompress to validate
    if strings.HasSuffix(path, ".gz") {
        actualPath = path + ".validate-tmp"
        if err := gunzipFile(path, actualPath); err != nil {
            return err
        }
        defer os.Remove(actualPath)
    }

    // Open as SQLite and check it has the _migrations table
    db, err := sql.Open("sqlite3", actualPath+"?mode=ro")
    if err != nil {
        return err
    }
    defer db.Close()

    var count int
    err = db.QueryRow("SELECT COUNT(*) FROM _migrations").Scan(&count)
    if err != nil {
        return fmt.Errorf("not a valid Hostbox database: %w", err)
    }
    return nil
}
```

### 5.3 API Endpoints

**File: `internal/api/handlers/admin_backup.go`**

```go
// POST /api/v1/admin/backup
func (h *AdminHandler) CreateBackup(c echo.Context) error {
    var req struct {
        Compress bool `json:"compress"`
    }
    c.Bind(&req)

    result, err := h.backupService.CreateBackup(c.Request().Context(), req.Compress)
    if err != nil {
        return c.JSON(500, map[string]any{"error": map[string]string{
            "code": "BACKUP_FAILED", "message": err.Error(),
        }})
    }

    return c.JSON(200, map[string]any{"backup": result})
}

// POST /api/v1/admin/restore
func (h *AdminHandler) RestoreBackup(c echo.Context) error {
    var req struct {
        Path string `json:"path"` // Server-side path to backup file
    }
    c.Bind(&req)

    if err := h.backupService.Restore(c.Request().Context(), req.Path); err != nil {
        return c.JSON(500, map[string]any{"error": map[string]string{
            "code": "RESTORE_FAILED", "message": err.Error(),
        }})
    }

    // Signal the server to restart (graceful shutdown + re-init)
    go func() {
        time.Sleep(1 * time.Second)
        syscall.Kill(syscall.Getpid(), syscall.SIGTERM)
    }()

    return c.JSON(200, map[string]any{
        "success": true,
        "message": "Database restored. Server restarting...",
    })
}
```

### 5.4 Optional: Litestream Integration (Post-v1)

For continuous replication to S3-compatible storage (Backblaze B2, MinIO, AWS S3):

**litestream.yml:**

```yaml
dbs:
  - path: /app/data/hostbox.db
    replicas:
      - type: s3
        bucket: my-bucket
        path: hostbox/db
        retention: 720h   # 30 days
        sync-interval: 60s
```

This is documented for future reference. Not required for v1.

---

## 6. Part E — Self-Update

### 6.1 Update Service

**File: `internal/services/admin/update.go`**

```go
type UpdateService struct {
    currentVersion string // Set at build time via ldflags
    githubRepo     string // "hostbox/hostbox"
    httpClient     *http.Client
    logger         *slog.Logger
}

type UpdateCheck struct {
    CurrentVersion  string `json:"current_version"`
    LatestVersion   string `json:"latest_version"`
    UpdateAvailable bool   `json:"update_available"`
    ReleaseURL      string `json:"release_url"`
    ReleaseNotes    string `json:"release_notes"`
    PublishedAt     string `json:"published_at"`
}

func (s *UpdateService) Check(ctx context.Context) (*UpdateCheck, error) {
    url := fmt.Sprintf("https://api.github.com/repos/%s/releases/latest", s.githubRepo)
    req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
    req.Header.Set("Accept", "application/vnd.github+json")
    req.Header.Set("User-Agent", "Hostbox/"+s.currentVersion)

    resp, err := s.httpClient.Do(req)
    if err != nil {
        return nil, fmt.Errorf("failed to check for updates: %w", err)
    }
    defer resp.Body.Close()

    var release struct {
        TagName     string `json:"tag_name"`
        Body        string `json:"body"`
        HTMLURL     string `json:"html_url"`
        PublishedAt string `json:"published_at"`
    }
    json.NewDecoder(resp.Body).Decode(&release)

    latest := strings.TrimPrefix(release.TagName, "v")
    current := strings.TrimPrefix(s.currentVersion, "v")

    return &UpdateCheck{
        CurrentVersion:  s.currentVersion,
        LatestVersion:   release.TagName,
        UpdateAvailable: semverGreater(latest, current),
        ReleaseURL:      release.HTMLURL,
        ReleaseNotes:    release.Body,
        PublishedAt:     release.PublishedAt,
    }, nil
}

// semverGreater returns true if a > b (both in "major.minor.patch" format)
func semverGreater(a, b string) bool {
    partsA := strings.Split(a, ".")
    partsB := strings.Split(b, ".")
    for i := 0; i < 3; i++ {
        va, _ := strconv.Atoi(safeIndex(partsA, i))
        vb, _ := strconv.Atoi(safeIndex(partsB, i))
        if va > vb {
            return true
        }
        if va < vb {
            return false
        }
    }
    return false
}
```

### 6.2 Update Execution

```go
func (s *UpdateService) Execute(ctx context.Context, targetVersion string) error {
    s.logger.Info("starting update", "from", s.currentVersion, "to", targetVersion)

    // 1. Pull new Docker images
    s.logger.Info("pulling new images...")
    if err := s.runCommand(ctx, "docker", "compose", "pull"); err != nil {
        return fmt.Errorf("failed to pull images: %w", err)
    }

    // 2. Recreate containers with new images
    s.logger.Info("updating containers...")
    if err := s.runCommand(ctx, "docker", "compose", "up", "-d", "--no-deps", "hostbox"); err != nil {
        return fmt.Errorf("failed to update containers: %w", err)
    }

    // 3. Wait for health check (up to 60 seconds)
    s.logger.Info("waiting for health check...")
    if err := s.waitForHealth(ctx, 60*time.Second); err != nil {
        // Rollback on failure
        s.logger.Error("health check failed, rolling back", "error", err)
        s.runCommand(ctx, "docker", "compose", "rollback")
        return fmt.Errorf("update failed (rolled back): %w", err)
    }

    s.logger.Info("update completed successfully", "version", targetVersion)
    return nil
}

func (s *UpdateService) waitForHealth(ctx context.Context, timeout time.Duration) error {
    deadline := time.Now().Add(timeout)
    healthURL := "http://localhost:8080/api/v1/health"

    for time.Now().Before(deadline) {
        resp, err := s.httpClient.Get(healthURL)
        if err == nil && resp.StatusCode == 200 {
            resp.Body.Close()
            return nil
        }
        if resp != nil {
            resp.Body.Close()
        }
        time.Sleep(2 * time.Second)
    }

    return fmt.Errorf("health check timed out after %s", timeout)
}

func (s *UpdateService) runCommand(ctx context.Context, name string, args ...string) error {
    cmd := exec.CommandContext(ctx, name, args...)
    cmd.Dir = "/opt/hostbox"
    output, err := cmd.CombinedOutput()
    if err != nil {
        return fmt.Errorf("%s: %s", err, string(output))
    }
    return nil
}
```

### 6.3 API Endpoints

```go
// GET /api/v1/admin/update/check
func (h *AdminHandler) CheckUpdate(c echo.Context) error {
    check, err := h.updateService.Check(c.Request().Context())
    if err != nil {
        return c.JSON(500, map[string]any{"error": map[string]string{
            "code": "UPDATE_CHECK_FAILED", "message": err.Error(),
        }})
    }
    return c.JSON(200, map[string]any{"update": check})
}

// POST /api/v1/admin/update
func (h *AdminHandler) ExecuteUpdate(c echo.Context) error {
    var req struct {
        Version string `json:"version"` // Empty = latest
    }
    c.Bind(&req)

    // Run update in background (server will restart)
    go func() {
        ctx := context.Background()
        if err := h.updateService.Execute(ctx, req.Version); err != nil {
            h.logger.Error("update failed", "error", err)
        }
    }()

    return c.JSON(202, map[string]any{
        "message": "Update started. Server will restart shortly.",
    })
}
```

---

## 7. Part F — Install Script

### 7.1 Overview

**Script location:** `scripts/install.sh`
**Served at:** `https://get.hostbox.dev` (or GitHub raw URL)
**Usage:** `curl -fsSL https://get.hostbox.dev | bash`

### 7.2 Install Script Flow

```
main()
 │
 ├── 1. detect_os()
 │      └── Check /etc/os-release
 │      └── Require Ubuntu 22+ or Debian 12+
 │      └── Warn on untested OS, proceed anyway
 │
 ├── 2. check_prerequisites()
 │      └── Check for: docker, docker compose, curl, git
 │      └── Record missing packages
 │
 ├── 3. install_prerequisites() [if any missing]
 │      └── docker → curl -fsSL https://get.docker.com | sh
 │      └── docker-compose-plugin → apt-get install
 │      └── curl, git → apt-get install
 │
 ├── 4. setup_directory()
 │      └── Create /opt/hostbox/
 │      └── Create /opt/hostbox/data/backups/
 │      └── Create /opt/hostbox/deployments/
 │      └── Create /opt/hostbox/logs/
 │      └── Set ownership to current user
 │
 ├── 5. download_files()
 │      └── Download docker-compose.yml → /opt/hostbox/
 │      └── Download .env.example → /opt/hostbox/
 │
 ├── 6. configure() [interactive prompts]
 │      └── Prompt: Domain (e.g., hostbox.example.com)
 │      └── Prompt: Email for SSL (Let's Encrypt)
 │      └── Prompt: DNS provider (cloudflare/route53/digitalocean/none)
 │
 ├── 7. generate_secrets()
 │      └── JWT_SECRET=$(openssl rand -hex 32)
 │      └── ENCRYPTION_KEY=$(openssl rand -hex 32)
 │      └── WEBHOOK_SECRET=$(openssl rand -hex 32)
 │
 ├── 8. generate_env()
 │      └── Write .env from collected values + secrets
 │      └── chmod 600 .env
 │      └── Include DNS provider-specific vars if applicable
 │
 ├── 9. start_hostbox()
 │      └── docker compose pull
 │      └── docker compose up -d
 │
 ├── 10. wait_for_health()
 │       └── Poll http://localhost:8080/api/v1/health (max 30 attempts, 2s interval)
 │
 └── 11. print_success()
         └── Print dashboard URL
         └── Print DNS setup instructions (with detected server IP)
         └── Print next steps (create admin account, configure GitHub App)
         └── Print useful commands (logs, stop, update, backup)
```

### 7.3 Generated .env File Template

```bash
# Hostbox Configuration
# Generated by install script on 2024-01-15T10:30:00Z

# Platform
PLATFORM_DOMAIN=hostbox.example.com
PLATFORM_HTTPS=true
PLATFORM_NAME=Hostbox

# Authentication
JWT_SECRET=<generated-64-char-hex>
ENCRYPTION_KEY=<generated-64-char-hex>

# Database
DATABASE_URL=file:/app/data/hostbox.db

# GitHub App (configure after installation via setup wizard)
GITHUB_APP_ID=
GITHUB_APP_SLUG=
GITHUB_APP_PEM=
GITHUB_WEBHOOK_SECRET=<generated-64-char-hex>

# SSL / ACME
ACME_EMAIL=admin@example.com

# DNS Provider (for wildcard SSL — optional)
# DNS_PROVIDER=cloudflare
# CLOUDFLARE_API_TOKEN=

# Logging
LOG_LEVEL=info

# SMTP (optional — for email verification)
# SMTP_HOST=
# SMTP_PORT=587
# SMTP_USER=
# SMTP_PASS=
# EMAIL_FROM=
```

### 7.4 CLI Install Script

Separate script for installing the CLI binary on developer machines:

**File: `scripts/install-cli.sh`**
**Usage:** `curl -fsSL https://get.hostbox.dev/cli | bash`

**Flow:**

1. Detect OS (`uname -s`): linux / darwin
2. Detect architecture (`uname -m`): amd64 / arm64
3. Fetch latest release version from GitHub API
4. Download tarball: `hostbox-cli-{os}-{arch}.tar.gz`
5. Extract to `/usr/local/bin/hostbox`
6. Print success message

**Output:**

```
✓ hostbox-cli v1.0.0 installed to /usr/local/bin/hostbox
  Run 'hostbox login' to get started
```

---

## 8. Testing Strategy

### 8.1 CLI Tests

| Area                | Test Type   | Details                                                    |
|---------------------|-------------|-----------------------------------------------------------|
| Config load/save    | Unit        | Test config file read/write, env var override, precedence  |
| Keyring fallback    | Unit        | Test keyring failure → file fallback                       |
| Project link        | Unit        | Test `.hostbox.json` write/discover/walk-up                |
| HTTP client         | Unit        | Test request building, auth header, error parsing          |
| SSE parser          | Unit        | Test event parsing, reconnection logic                     |
| Output formatting   | Unit        | Test table rendering, JSON output, color stripping         |
| Command execution   | Integration | Test full command flow against mock HTTP server            |
| .env parser         | Unit        | Test `env import` parsing of .env files (comments, quotes) |

### 8.2 Scheduler Tests

| Area                     | Test Type   | Details                                              |
|--------------------------|-------------|------------------------------------------------------|
| GC artifact selection    | Unit        | Test protected deployment identification              |
| GC retention logic       | Unit        | Test count-based and age-based cleanup decisions      |
| GC Docker cleanup        | Integration | Test container/image/volume pruning with mock Docker  |
| Session cleaner SQL      | Unit        | Test expired session deletion query                   |
| Domain re-verifier       | Unit        | Test grace period logic, verified/unverified transitions |
| Scheduler lifecycle      | Unit        | Test start/stop, context cancellation                 |

### 8.3 Notification Tests

| Area                  | Test Type   | Details                                               |
|-----------------------|-------------|-------------------------------------------------------|
| Discord payload       | Unit        | Test embed generation for each event type              |
| Slack payload         | Unit        | Test Block Kit generation for each event type          |
| Webhook payload       | Unit        | Test generic JSON payload structure                    |
| Retry logic           | Unit        | Test exponential backoff, max retries                  |
| Dispatch routing      | Integration | Test event → config matching → client selection        |
| HTTP failure handling | Unit        | Test 4xx/5xx response handling, timeouts               |

### 8.4 Backup Tests

| Area              | Test Type   | Details                                                   |
|-------------------|-------------|-----------------------------------------------------------|
| Backup creation   | Integration | Test VACUUM INTO, gzip, file output                       |
| Backup validation | Unit        | Test valid/invalid SQLite file detection                   |
| Retention         | Unit        | Test max backups enforcement (keep 5, delete older)        |
| Restore flow      | Integration | Test full restore cycle (backup → modify → restore → verify) |
| Gzip round-trip   | Unit        | Test compress → decompress produces identical file          |

---

## 9. Implementation Order

### Phase 6A: CLI Foundation (Week 1)

1. **CLI scaffolding** — Root command, global flags, `main.go` entrypoint
2. **Config system** — `config.go`, `keyring.go`, env var support
3. **HTTP client** — `client.go` with auth, error handling, token refresh
4. **Output formatting** — `table.go`, `json.go`, `format.go`
5. **Auth commands** — `login`, `logout`, `whoami`
6. **Project link** — `link.go` with directory walk-up discovery

### Phase 6B: CLI Project & Deployment Commands (Week 2)

7. **Project commands** — `projects`, `project create`, `link`, `open`
8. **Deploy command** — `deploy` with basic output
9. **SSE streaming** — `sse.go` client for log streaming
10. **Log streaming** — `logs` command with SSE integration
11. **Status & rollback** — `status`, `rollback` commands

### Phase 6C: CLI Domain, Env, Admin Commands (Week 3)

12. **Domain commands** — `domains list/add/remove/verify`
13. **Env commands** — `env list/set/delete/import/export`
14. **Admin commands** — `admin backup/restore/update/reset-password`
15. **New API endpoints** — Backup, restore, update check, update execute, reset-password handlers

### Phase 6D: Background Schedulers (Week 4)

16. **Scheduler manager** — Start/stop lifecycle, integration with main binary startup
17. **Garbage collector** — Artifact, log, cache, Docker cleanup
18. **Session cleaner** — Expired session deletion
19. **Domain re-verifier** — DNS re-check with grace period

### Phase 6E: Notifications & Install Script (Week 5)

20. **Notification service** — Dispatch engine, retry logic
21. **Discord client** — Embed formatting for all event types
22. **Slack client** — Block Kit formatting for all event types
23. **Webhook client** — Generic JSON payload
24. **Integration** — Hook notifications into build pipeline post-build step
25. **Install script** — `scripts/install.sh` (VPS installer)
26. **CLI install script** — `scripts/install-cli.sh` (developer machine)

### Phase 6F: Polish & Testing (Week 6)

27. **CLI binary builds** — Cross-compilation for linux/darwin, amd64/arm64
28. **Integration tests** — End-to-end CLI test suite against mock server
29. **Documentation** — CLI `--help` text, README updates, man page generation
30. **Self-update** — GitHub releases integration, health-check verification

---

## Appendix A: New Migration (Optional)

If backup metadata tracking is desired:

**File: `migrations/006_backup_metadata.sql`**

```sql
-- Track backup history
CREATE TABLE IF NOT EXISTS backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
```

## Appendix B: Complete CLI Command Tree

```
hostbox
├── login                      # Authenticate with server
│   ├── --token <token>        # Non-interactive (CI/CD)
│   └── --server <url>         # Server URL override
├── logout                     # Clear credentials
│   └── --all                  # Revoke all server sessions
├── whoami                     # Show current user + server
├── projects                   # List all projects
│   ├── --page <n>
│   ├── --per-page <n>
│   ├── --search <query>
│   └── create                 # Create new project
│       ├── --name <name>
│       ├── --repo <owner/repo>
│       ├── --framework <fw>
│       ├── --build-command <cmd>
│       ├── --install-command <cmd>
│       ├── --output-dir <dir>
│       ├── --root-dir <dir>
│       ├── --node-version <ver>
│       └── --branch <branch>
├── link                       # Link cwd to a project
│   └── --project <id>
├── open                       # Open dashboard in browser
│   └── --deployment           # Open latest deployment URL
├── deploy                     # Trigger deployment
│   ├── --branch <branch>
│   ├── --commit <sha>
│   ├── --prod
│   └── --no-follow
├── status                     # Show deployment status
│   └── --deployment <id>
├── logs [deployment-id]       # View/stream build logs
│   ├── -f, --follow
│   ├── --tail <n>
│   └── --no-color
├── rollback [deployment-id]   # Rollback production
│   ├── --last
│   └── -y, --yes
├── domains                    # List domains
│   ├── add <domain>           # Add custom domain
│   ├── remove <domain>        # Remove custom domain
│   │   └── -y, --yes
│   └── verify <domain>        # Verify domain DNS
├── env                        # List env vars
│   ├── set <K=V...>           # Set env var(s)
│   │   ├── --secret
│   │   └── --scope <scope>
│   ├── delete <KEY...>        # Delete env var(s)
│   ├── import <file>          # Import from .env file
│   │   ├── --secret
│   │   ├── --scope <scope>
│   │   └── --overwrite
│   └── export                 # Export to stdout
│       └── --scope <scope>
└── admin                      # Admin commands
    ├── backup                 # Create database backup
    │   ├── --output <path>
    │   ├── --compress
    │   └── --download
    ├── restore                # Restore from backup
    │   ├── --file <path>      # (required)
    │   └── -y, --yes
    ├── update                 # Self-update Hostbox
    │   ├── --version <ver>
    │   ├── --check
    │   └── -y, --yes
    └── reset-password <email> # Reset user password

Global Flags (all commands):
    --json                     # JSON output
    --server <url>             # Server URL override
    --token <token>            # Auth token override
    --project <id>             # Project ID override
    --no-color                 # Disable colors
    -v, --verbose              # Verbose output
```
