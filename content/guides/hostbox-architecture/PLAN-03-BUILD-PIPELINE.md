# Phase 3: Build Pipeline & Deployment Engine — Implementation Plan

> **Status**: Planning
> **Depends on**: Phase 1 (Database, Config, Models) + Phase 2 (Auth, API, Projects, Repos)
> **Estimated effort**: 8–12 days
> **Key deliverable**: A working build pipeline that clones repos, detects frameworks, builds in Docker containers, streams logs via SSE, and serves static artifacts.

---

## Table of Contents

1. [Overview & Goals](#1-overview--goals)
2. [New Dependencies](#2-new-dependencies)
3. [Database Migration](#3-database-migration)
4. [Configuration Additions](#4-configuration-additions)
5. [File & Package Layout](#5-file--package-layout)
6. [Framework & Package Manager Detection](#6-framework--package-manager-detection)
7. [Docker Client Wrapper](#7-docker-client-wrapper)
8. [Build Logger & SSE Hub](#8-build-logger--sse-hub)
9. [Build Executor](#9-build-executor)
10. [Worker Pool](#10-worker-pool)
11. [Deployment Service](#11-deployment-service)
12. [API Handlers & Routes](#12-api-handlers--routes)
13. [DTOs](#13-dtos)
14. [URL Generation](#14-url-generation)
15. [Build Caching Strategy](#15-build-caching-strategy)
16. [Error Handling & Resilience](#16-error-handling--resilience)
17. [Startup Integration](#17-startup-integration)
18. [Graceful Shutdown Integration](#18-graceful-shutdown-integration)
19. [Testing Strategy](#19-testing-strategy)
20. [Implementation Order](#20-implementation-order)
21. [Acceptance Criteria](#21-acceptance-criteria)

---

## 1. Overview & Goals

Phase 3 transforms Hostbox from a project-management shell into a real deployment platform. After this phase, a user can:

1. Trigger a deployment (manual via API — webhook integration is Phase 4).
2. Watch the build stream in real time via SSE.
3. Cancel an in-flight build.
4. Access the deployed static site at a generated URL.
5. Redeploy, rollback, or promote a preview deployment.

### What this phase does NOT include

- GitHub webhook handler (Phase 4)
- Caddy route management (Phase 5)
- Custom domains (Phase 5)
- Notifications (Phase 6)
- GitHub Deployment Status / PR comments (Phase 4)
- Web dashboard UI (Phase 7)
- CLI commands (Phase 7)

Where post-build steps reference Caddy or GitHub, the executor will call **stub interfaces** that log a TODO and return nil. This lets Phase 4/5 plug in without modifying the build pipeline.

---

## 2. New Dependencies

Add to `go.mod`:

```
github.com/docker/docker         v27.x    // Docker Engine SDK
github.com/docker/go-connections v0.5.0   // Docker connection helpers
github.com/opencontainers/image-spec v1.1.0
```

These are the only new external dependencies. The git clone step uses `os/exec` to call the `git` binary (already available in the Hostbox container image via `apk add git`).

---

## 3. Database Migration

### File: `migrations/003_deployments_cache.sql`

This migration adds the `lock_file_hash` column to `projects` for cache invalidation tracking. The `deployments` table already exists from Phase 1 migration.

```sql
-- Track lock file hash for build cache invalidation
ALTER TABLE projects ADD COLUMN lock_file_hash TEXT DEFAULT '';

-- Track the previous node_version and package_manager for cache invalidation
ALTER TABLE projects ADD COLUMN detected_package_manager TEXT DEFAULT '';

-- Index for finding active production deployment per project
CREATE INDEX IF NOT EXISTS idx_deployments_production
    ON deployments(project_id, is_production, status)
    WHERE is_production = TRUE AND status = 'ready';

-- Index for deduplication queries (find queued/building for project+branch)
CREATE INDEX IF NOT EXISTS idx_deployments_dedup
    ON deployments(project_id, branch, status)
    WHERE status IN ('queued', 'building');
```

### Why these additions

| Column / Index | Purpose |
|---|---|
| `projects.lock_file_hash` | SHA-256 of the lock file content; when it changes, the node_modules cache volume is invalidated |
| `projects.detected_package_manager` | Tracks last-used package manager; a change triggers cache invalidation |
| `idx_deployments_production` | Fast lookup of the current live production deployment for a project |
| `idx_deployments_dedup` | Fast deduplication query: "is there already a queued/building deploy for this project+branch?" |

---

## 4. Configuration Additions

### File: `internal/config/config.go` (extend existing)

Add the following fields to the existing `Config` struct:

```go
// Build pipeline configuration
type BuildConfig struct {
    MaxConcurrentBuilds int           `env:"MAX_CONCURRENT_BUILDS" envDefault:"1"`
    BuildTimeoutMinutes int           `env:"BUILD_TIMEOUT_MINUTES" envDefault:"15"`
    CloneTimeoutSeconds int           `env:"CLONE_TIMEOUT_SECONDS" envDefault:"120"`
    CloneMaxRetries     int           `env:"CLONE_MAX_RETRIES"     envDefault:"3"`
    CloneRetryDelaySec  int           `env:"CLONE_RETRY_DELAY_SEC" envDefault:"5"`
    DefaultNodeVersion  string        `env:"DEFAULT_NODE_VERSION"  envDefault:"20"`
    DefaultMemoryMB     int64         `env:"BUILD_MEMORY_MB"       envDefault:"512"`
    DefaultCPUs         float64       `env:"BUILD_CPUS"            envDefault:"1.0"`
    PIDLimit            int64         `env:"BUILD_PID_LIMIT"       envDefault:"256"`
    MaxLogFileSizeBytes int64         `env:"MAX_LOG_FILE_SIZE"     envDefault:"5242880"` // 5MB
    ShutdownTimeoutSec  int           `env:"SHUTDOWN_TIMEOUT_SEC"  envDefault:"60"`
    JobChannelBuffer    int           `env:"JOB_CHANNEL_BUFFER"    envDefault:"100"`

    // Paths (defaults match Docker deployment layout)
    CloneBaseDir      string `env:"CLONE_BASE_DIR"       envDefault:"/app/tmp"`
    DeploymentBaseDir string `env:"DEPLOYMENT_BASE_DIR"  envDefault:"/app/deployments"`
    LogBaseDir        string `env:"LOG_BASE_DIR"         envDefault:"/app/logs"`
}
```

### .env.example additions

```env
# Build Pipeline
MAX_CONCURRENT_BUILDS=1
BUILD_TIMEOUT_MINUTES=15
BUILD_MEMORY_MB=512
BUILD_CPUS=1.0
DEFAULT_NODE_VERSION=20
```

---

## 5. File & Package Layout

All new files for Phase 3. Files marked with ★ are the core of this phase.

```
internal/
├── platform/
│   ├── docker/
│   │   └── docker.go              ★ Docker SDK wrapper (container CRUD, exec, copy)
│   └── detect/
│       ├── framework.go           ★ Framework detection from package.json
│       ├── framework_test.go        Unit tests for detection
│       ├── packagemanager.go      ★ Package manager detection from lock files
│       └── packagemanager_test.go   Unit tests for PM detection
│
├── worker/
│   ├── pool.go                    ★ Bounded goroutine worker pool
│   ├── pool_test.go                 Unit tests for pool
│   ├── executor.go                ★ Build executor (6-step pipeline)
│   ├── executor_test.go             Integration tests for executor
│   ├── logger.go                  ★ BuildLogger multiplexer (file + SSE)
│   ├── logger_test.go               Unit tests for logger
│   ├── sse.go                     ★ SSEHub pub/sub for live log streaming
│   └── sse_test.go                  Unit tests for SSE hub
│
├── services/
│   └── deployment/
│       ├── service.go             ★ DeploymentService (create, cancel, rollback, promote)
│       └── service_test.go          Unit tests for deployment service
│
├── repository/
│   └── deployment.go              ★ DeploymentRepository (extend with new queries)
│
├── api/
│   └── handlers/
│       └── deployment.go          ★ HTTP handlers for deployment endpoints
│
├── dto/
│   └── deployment.go              ★ Request/Response DTOs for deployment API
│
└── models/
    └── deployment.go                (already exists from Phase 1; no changes needed)
```

---

## 6. Framework & Package Manager Detection

### 6.1 File: `internal/platform/detect/framework.go`

```go
package detect

import (
    "encoding/json"
    "os"
    "path/filepath"
)

// Framework holds the detected build configuration for a project.
type Framework struct {
    Name           string // "nextjs", "vite", "cra", "astro", "gatsby", "nuxt", "sveltekit", "hugo", "static", "unknown"
    DisplayName    string // "Next.js", "Vite", etc.
    BuildCommand   string // "npm run build", "npm run generate", etc.
    OutputDirectory string // "out", "dist", "build", "public", ".output/public", "."
    ServingMode    string // "spa" or "static"
}

// PackageJSON represents the subset of package.json fields we need.
type PackageJSON struct {
    Name            string            `json:"name"`
    Dependencies    map[string]string `json:"dependencies"`
    DevDependencies map[string]string `json:"devDependencies"`
    Engines         struct {
        Node string `json:"node"`
    } `json:"engines"`
}

// knownFrameworks is checked in priority order (first match wins).
// Order matters: next before react-scripts because a Next.js project
// also has "react" in dependencies.
var knownFrameworks = []struct {
    Dep         string
    DevDep      bool   // if true, check devDependencies instead of dependencies
    Framework   Framework
}{
    {
        Dep: "next",
        Framework: Framework{
            Name:            "nextjs",
            DisplayName:     "Next.js",
            BuildCommand:    "npm run build",
            OutputDirectory: "out",
            ServingMode:     "static",
        },
    },
    {
        Dep: "react-scripts",
        Framework: Framework{
            Name:            "cra",
            DisplayName:     "Create React App",
            BuildCommand:    "npm run build",
            OutputDirectory: "build",
            ServingMode:     "spa",
        },
    },
    {
        Dep:    "vite",
        DevDep: true,
        Framework: Framework{
            Name:            "vite",
            DisplayName:     "Vite",
            BuildCommand:    "npm run build",
            OutputDirectory: "dist",
            ServingMode:     "spa",
        },
    },
    {
        Dep: "astro",
        Framework: Framework{
            Name:            "astro",
            DisplayName:     "Astro",
            BuildCommand:    "npm run build",
            OutputDirectory: "dist",
            ServingMode:     "static",
        },
    },
    {
        Dep: "gatsby",
        Framework: Framework{
            Name:            "gatsby",
            DisplayName:     "Gatsby",
            BuildCommand:    "npm run build",
            OutputDirectory: "public",
            ServingMode:     "static",
        },
    },
    {
        Dep: "nuxt",
        Framework: Framework{
            Name:            "nuxt",
            DisplayName:     "Nuxt 3",
            BuildCommand:    "npm run generate",
            OutputDirectory: ".output/public",
            ServingMode:     "static",
        },
    },
    {
        Dep: "@sveltejs/kit",
        Framework: Framework{
            Name:            "sveltekit",
            DisplayName:     "SvelteKit",
            BuildCommand:    "npm run build",
            OutputDirectory: "build",
            ServingMode:     "spa",
        },
    },
}

// DetectFramework reads package.json from sourceDir and returns the detected framework.
// If project-level overrides are provided, they take priority.
func DetectFramework(sourceDir string) (Framework, *PackageJSON, error) {
    pkgPath := filepath.Join(sourceDir, "package.json")

    // Check for Hugo first (no package.json needed)
    if isHugoProject(sourceDir) {
        return Framework{
            Name:            "hugo",
            DisplayName:     "Hugo",
            BuildCommand:    "hugo --minify",
            OutputDirectory: "public",
            ServingMode:     "static",
        }, nil, nil
    }

    // Try to read package.json
    data, err := os.ReadFile(pkgPath)
    if err != nil {
        // No package.json → check for index.html (plain static site)
        if _, err2 := os.Stat(filepath.Join(sourceDir, "index.html")); err2 == nil {
            return Framework{
                Name:            "static",
                DisplayName:     "Static HTML",
                BuildCommand:    "",
                OutputDirectory: ".",
                ServingMode:     "static",
            }, nil, nil
        }
        return Framework{}, nil, fmt.Errorf("no package.json or index.html found: %w", err)
    }

    var pkg PackageJSON
    if err := json.Unmarshal(data, &pkg); err != nil {
        return Framework{}, nil, fmt.Errorf("invalid package.json: %w", err)
    }

    // Merge deps + devDeps for lookup
    allDeps := make(map[string]string)
    for k, v := range pkg.Dependencies {
        allDeps[k] = v
    }
    for k, v := range pkg.DevDependencies {
        allDeps[k] = v
    }

    // Check known frameworks in priority order
    for _, kf := range knownFrameworks {
        if kf.DevDep {
            if _, ok := pkg.DevDependencies[kf.Dep]; ok {
                return kf.Framework, &pkg, nil
            }
        } else {
            if _, ok := allDeps[kf.Dep]; ok {
                return kf.Framework, &pkg, nil
            }
        }
    }

    // Fallback: unknown Node.js project
    return Framework{
        Name:            "unknown",
        DisplayName:     "Node.js",
        BuildCommand:    "npm run build",
        OutputDirectory: "dist",
        ServingMode:     "spa",
    }, &pkg, nil
}

// isHugoProject checks for Hugo config files.
func isHugoProject(dir string) bool {
    hugoConfigs := []string{"hugo.toml", "hugo.yaml", "hugo.json", "config.toml", "config.yaml", "config.json"}
    for _, f := range hugoConfigs {
        if _, err := os.Stat(filepath.Join(dir, f)); err == nil {
            return true
        }
    }
    return false
}

// DetectNodeVersion extracts the Node.js version from package.json engines.node.
// Returns the default version if not specified or unparseable.
// Parses ranges like ">=18", "^20", "20.x", "20" → extracts major version.
func DetectNodeVersion(pkg *PackageJSON, defaultVersion string) string {
    if pkg == nil || pkg.Engines.Node == "" {
        return defaultVersion
    }

    // Extract major version number from the engines.node string.
    // Supports: "20", "20.x", ">=18", "^20.0.0", "~18.17.0"
    re := regexp.MustCompile(`(\d+)`)
    match := re.FindString(pkg.Engines.Node)
    if match == "" {
        return defaultVersion
    }

    major, err := strconv.Atoi(match)
    if err != nil || major < 16 || major > 22 {
        return defaultVersion
    }

    return match
}

// ApplyOverrides merges project-level overrides into the detected framework config.
// Non-empty override fields replace the auto-detected values.
func ApplyOverrides(fw Framework, buildCmd, installCmd, outputDir string) Framework {
    if buildCmd != "" {
        fw.BuildCommand = buildCmd
    }
    if outputDir != "" {
        fw.OutputDirectory = outputDir
    }
    // installCmd is handled separately in the executor since it depends on
    // the package manager. The override replaces the full install command.
    return fw
}
```

### 6.2 File: `internal/platform/detect/packagemanager.go`

```go
package detect

import (
    "os"
    "path/filepath"
)

// PackageManager holds the detected package manager and its install command.
type PackageManager struct {
    Name           string // "pnpm", "yarn", "bun", "npm"
    InstallCommand string // Full install command with flags
    LockFile       string // Name of the lock file used for detection
}

// Lock files checked in priority order.
var lockFileOrder = []struct {
    File    string
    Manager PackageManager
}{
    {
        File: "pnpm-lock.yaml",
        Manager: PackageManager{
            Name:           "pnpm",
            InstallCommand: "pnpm install --frozen-lockfile",
            LockFile:       "pnpm-lock.yaml",
        },
    },
    {
        File: "yarn.lock",
        Manager: PackageManager{
            Name:           "yarn",
            InstallCommand: "yarn install --frozen-lockfile",
            LockFile:       "yarn.lock",
        },
    },
    {
        File: "bun.lockb",
        Manager: PackageManager{
            Name:           "bun",
            InstallCommand: "bun install --frozen-lockfile",
            LockFile:       "bun.lockb",
        },
    },
    {
        File: "package-lock.json",
        Manager: PackageManager{
            Name:           "npm",
            InstallCommand: "npm ci",
            LockFile:       "package-lock.json",
        },
    },
}

// DetectPackageManager examines lock files in sourceDir to determine the package manager.
// Falls back to npm if no lock file is found.
func DetectPackageManager(sourceDir string) PackageManager {
    for _, lf := range lockFileOrder {
        if _, err := os.Stat(filepath.Join(sourceDir, lf.File)); err == nil {
            return lf.Manager
        }
    }

    // Fallback: npm with plain install (no lock file found)
    return PackageManager{
        Name:           "npm",
        InstallCommand: "npm install",
        LockFile:       "",
    }
}

// HashLockFile reads the lock file and returns its SHA-256 hex digest.
// Returns "" if the lock file doesn't exist or can't be read.
func HashLockFile(sourceDir string, lockFileName string) string {
    if lockFileName == "" {
        return ""
    }
    data, err := os.ReadFile(filepath.Join(sourceDir, lockFileName))
    if err != nil {
        return ""
    }
    h := sha256.Sum256(data)
    return hex.EncodeToString(h[:])
}
```

### 6.3 Key Design Decisions

| Decision | Rationale |
|---|---|
| Priority-ordered list instead of map | Detection order matters (e.g., Next.js projects also have `react`) |
| Vite checked in devDependencies | Vite is almost always a devDependency |
| Hugo checked before package.json | Hugo projects may not have package.json at all |
| Static HTML as final fallback | If there's an `index.html`, serve it directly |
| Lock file hash for cache invalidation | Cheapest way to detect dependency changes |

---

## 7. Docker Client Wrapper

### File: `internal/platform/docker/docker.go`

This wraps the Docker Engine SDK into a focused interface for build container operations.

```go
package docker

import (
    "context"
    "fmt"
    "io"
    "time"

    "github.com/docker/docker/api/types"
    "github.com/docker/docker/api/types/container"
    "github.com/docker/docker/api/types/mount"
    "github.com/docker/docker/api/types/network"
    "github.com/docker/docker/client"
    "github.com/docker/docker/pkg/stdcopy"
    "github.com/docker/go-units"
)

// Client wraps the Docker Engine SDK for build operations.
type Client struct {
    cli *client.Client
}

// NewClient creates a Docker client from the default environment
// (DOCKER_HOST or /var/run/docker.sock).
func NewClient() (*Client, error) {
    cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
    if err != nil {
        return nil, fmt.Errorf("docker client init: %w", err)
    }
    // Verify connectivity
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()
    if _, err := cli.Ping(ctx); err != nil {
        return nil, fmt.Errorf("docker ping failed: %w", err)
    }
    return &Client{cli: cli}, nil
}

// Close releases the Docker client resources.
func (c *Client) Close() error {
    return c.cli.Close()
}

// BuildContainerOpts configures a build container.
type BuildContainerOpts struct {
    DeploymentID string
    NodeVersion  string
    SourceDir    string            // Host path to cloned source
    OutputDir    string            // Host path for build output
    CacheVolume  string            // Named volume for node_modules
    BuildCache   string            // Named volume for framework build cache
    EnvVars      []string          // KEY=VALUE format
    MemoryBytes  int64             // Memory limit in bytes
    NanoCPUs     int64             // CPU limit in nano-CPUs (1e9 = 1 core)
    PIDLimit     int64
    WorkDir      string            // Working directory inside container (default: /app/src)
}

// CreateBuildContainer creates a stopped container configured for builds.
// Returns the container ID.
func (c *Client) CreateBuildContainer(ctx context.Context, opts BuildContainerOpts) (string, error) {
    image := "node:" + opts.NodeVersion + "-slim"

    // Ensure image exists locally
    if err := c.ensureImage(ctx, image); err != nil {
        return "", fmt.Errorf("ensure image %s: %w", image, err)
    }

    workDir := opts.WorkDir
    if workDir == "" {
        workDir = "/app/src"
    }

    pidLimit := opts.PIDLimit
    config := &container.Config{
        Image:      image,
        Env:        opts.EnvVars,
        WorkingDir: workDir,
        Labels: map[string]string{
            "hostbox.deployment": opts.DeploymentID,
            "hostbox.managed":    "true",
        },
        // Keep container alive — we'll exec commands into it
        Cmd:       []string{"sleep", "infinity"},
        Tty:       false,
        OpenStdin: false,
    }

    hostConfig := &container.HostConfig{
        Resources: container.Resources{
            Memory:    opts.MemoryBytes,
            NanoCPUs:  opts.NanoCPUs,
            PidsLimit: &pidLimit,
            Ulimits: []*units.Ulimit{
                {Name: "nofile", Soft: 1024, Hard: 1024},
            },
        },
        SecurityOpt: []string{"no-new-privileges"},
        CapDrop:     []string{"ALL"},
        ReadonlyRootfs: true,
        Tmpfs: map[string]string{
            "/tmp": "rw,noexec,nosuid,size=512m",
        },
        Mounts: []mount.Mount{
            {
                Type:     mount.TypeBind,
                Source:   opts.SourceDir,
                Target:   "/app/src",
                ReadOnly: true,
            },
            {
                Type:   mount.TypeVolume,
                Source: opts.CacheVolume,
                Target: "/app/node_modules",
            },
            {
                Type:   mount.TypeVolume,
                Source: opts.BuildCache,
                Target: "/app/.build-cache",
            },
            {
                Type:     mount.TypeBind,
                Source:   opts.OutputDir,
                Target:   "/app/output",
                ReadOnly: false,
            },
        },
    }

    resp, err := c.cli.ContainerCreate(ctx, config, hostConfig, nil, nil, "build-"+opts.DeploymentID)
    if err != nil {
        return "", fmt.Errorf("container create: %w", err)
    }

    // Start the container
    if err := c.cli.ContainerStart(ctx, resp.ID, container.StartOptions{}); err != nil {
        // Clean up the created-but-not-started container
        _ = c.cli.ContainerRemove(ctx, resp.ID, container.RemoveOptions{Force: true})
        return "", fmt.Errorf("container start: %w", err)
    }

    return resp.ID, nil
}

// ExecCommand runs a shell command inside a running container.
// stdout and stderr are written to the provided writers.
// Returns an error if the command exits with a non-zero code.
func (c *Client) ExecCommand(ctx context.Context, containerID string, cmd string, stdout, stderr io.Writer) error {
    execConfig := container.ExecOptions{
        Cmd:          []string{"sh", "-c", cmd},
        AttachStdout: true,
        AttachStderr: true,
    }

    execResp, err := c.cli.ContainerExecCreate(ctx, containerID, execConfig)
    if err != nil {
        return fmt.Errorf("exec create: %w", err)
    }

    attachResp, err := c.cli.ContainerExecAttach(ctx, execResp.ID, container.ExecAttachOptions{})
    if err != nil {
        return fmt.Errorf("exec attach: %w", err)
    }
    defer attachResp.Close()

    // Demultiplex stdout/stderr from the Docker stream
    if _, err := stdcopy.StdCopy(stdout, stderr, attachResp.Reader); err != nil {
        return fmt.Errorf("exec stream: %w", err)
    }

    // Check exit code
    inspectResp, err := c.cli.ContainerExecInspect(ctx, execResp.ID)
    if err != nil {
        return fmt.Errorf("exec inspect: %w", err)
    }
    if inspectResp.ExitCode != 0 {
        return fmt.Errorf("command exited with code %d", inspectResp.ExitCode)
    }

    return nil
}

// StopContainer stops a container with the given grace period, then kills it.
func (c *Client) StopContainer(ctx context.Context, containerID string, gracePeriod time.Duration) error {
    timeout := int(gracePeriod.Seconds())
    stopOpts := container.StopOptions{Timeout: &timeout}
    return c.cli.ContainerStop(ctx, containerID, stopOpts)
}

// RemoveContainer force-removes a container by ID or name.
func (c *Client) RemoveContainer(ctx context.Context, nameOrID string) error {
    return c.cli.ContainerRemove(ctx, nameOrID, container.RemoveOptions{
        Force:         true,
        RemoveVolumes: false, // Keep cache volumes
    })
}

// RemoveContainerByName removes a container by its name (e.g., "build-{deploymentID}").
// Silently succeeds if the container doesn't exist.
func (c *Client) RemoveContainerByName(ctx context.Context, name string) {
    _ = c.cli.ContainerRemove(ctx, name, container.RemoveOptions{Force: true})
}

// CopyFromContainer copies a directory from the container to the host.
// Returns the total size in bytes of the copied content.
func (c *Client) CopyFromContainer(ctx context.Context, containerID, srcPath, destPath string) (int64, error) {
    reader, stat, err := c.cli.CopyFromContainer(ctx, containerID, srcPath)
    if err != nil {
        return 0, fmt.Errorf("copy from container %s:%s: %w", containerID, srcPath, err)
    }
    defer reader.Close()

    // The Docker API returns a tar archive. Extract it to destPath.
    if err := extractTar(reader, destPath); err != nil {
        return 0, fmt.Errorf("extract tar to %s: %w", destPath, err)
    }

    return stat.Size, nil
}

// RemoveVolume removes a named Docker volume.
func (c *Client) RemoveVolume(ctx context.Context, name string) error {
    return c.cli.VolumeRemove(ctx, name, true)
}

// ListManagedContainers returns all containers with the "hostbox.managed=true" label.
func (c *Client) ListManagedContainers(ctx context.Context) ([]types.Container, error) {
    return c.cli.ContainerList(ctx, container.ListOptions{
        All: true,
        Filters: filters.NewArgs(
            filters.Arg("label", "hostbox.managed=true"),
        ),
    })
}

// ensureImage pulls the image if it doesn't exist locally.
func (c *Client) ensureImage(ctx context.Context, image string) error {
    _, _, err := c.cli.ImageInspectWithRaw(ctx, image)
    if err == nil {
        return nil // Image exists
    }

    reader, err := c.cli.ImagePull(ctx, "docker.io/library/"+image, types.ImagePullOptions{})
    if err != nil {
        return err
    }
    defer reader.Close()
    // Drain the reader to complete the pull
    _, _ = io.Copy(io.Discard, reader)
    return nil
}

// extractTar extracts a tar archive from reader into destDir.
func extractTar(reader io.Reader, destDir string) error {
    tr := tar.NewReader(reader)
    for {
        header, err := tr.Next()
        if err == io.EOF {
            break
        }
        if err != nil {
            return err
        }

        target := filepath.Join(destDir, header.Name)

        // Prevent path traversal
        if !strings.HasPrefix(filepath.Clean(target), filepath.Clean(destDir)) {
            return fmt.Errorf("invalid tar entry: %s", header.Name)
        }

        switch header.Typeflag {
        case tar.TypeDir:
            if err := os.MkdirAll(target, 0755); err != nil {
                return err
            }
        case tar.TypeReg:
            if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
                return err
            }
            f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(header.Mode))
            if err != nil {
                return err
            }
            if _, err := io.Copy(f, tr); err != nil {
                f.Close()
                return err
            }
            f.Close()
        }
    }
    return nil
}
```

### 7.1 Docker Interface (for testing)

```go
// File: internal/platform/docker/interface.go

package docker

import (
    "context"
    "io"
    "time"

    "github.com/docker/docker/api/types"
)

// DockerClient is the interface used by the build executor.
// The real Client implements it; tests use a mock.
type DockerClient interface {
    CreateBuildContainer(ctx context.Context, opts BuildContainerOpts) (string, error)
    ExecCommand(ctx context.Context, containerID string, cmd string, stdout, stderr io.Writer) error
    StopContainer(ctx context.Context, containerID string, gracePeriod time.Duration) error
    RemoveContainer(ctx context.Context, nameOrID string) error
    RemoveContainerByName(ctx context.Context, name string)
    CopyFromContainer(ctx context.Context, containerID, srcPath, destPath string) (int64, error)
    RemoveVolume(ctx context.Context, name string) error
    ListManagedContainers(ctx context.Context) ([]types.Container, error)
    Close() error
}
```

---

## 8. Build Logger & SSE Hub

### 8.1 File: `internal/worker/sse.go`

```go
package worker

import (
    "encoding/json"
    "sync"
    "time"
)

// SSEEventType categorizes SSE events.
type SSEEventType string

const (
    SSEEventLog    SSEEventType = "log"
    SSEEventStatus SSEEventType = "status"
    SSEEventDone   SSEEventType = "done"
)

// SSEEvent is a single server-sent event.
type SSEEvent struct {
    ID        int64        `json:"id"`
    Type      SSEEventType `json:"type"`
    Data      string       `json:"data"`
    Timestamp time.Time    `json:"timestamp"`
}

// SSEHub manages per-deployment pub/sub channels for live log streaming.
type SSEHub struct {
    mu          sync.RWMutex
    subscribers map[string]map[chan SSEEvent]struct{}
    eventID     map[string]int64 // per-deployment monotonic event counter
}

// NewSSEHub creates an initialized SSE hub.
func NewSSEHub() *SSEHub {
    return &SSEHub{
        subscribers: make(map[string]map[chan SSEEvent]struct{}),
        eventID:     make(map[string]int64),
    }
}

// Subscribe returns a buffered channel of SSE events for the given deployment
// and an unsubscribe function that MUST be called when done.
func (h *SSEHub) Subscribe(deploymentID string) (<-chan SSEEvent, func()) {
    ch := make(chan SSEEvent, 100)

    h.mu.Lock()
    if h.subscribers[deploymentID] == nil {
        h.subscribers[deploymentID] = make(map[chan SSEEvent]struct{})
    }
    h.subscribers[deploymentID][ch] = struct{}{}
    h.mu.Unlock()

    unsubscribe := func() {
        h.mu.Lock()
        delete(h.subscribers[deploymentID], ch)
        if len(h.subscribers[deploymentID]) == 0 {
            delete(h.subscribers, deploymentID)
        }
        close(ch)
        h.mu.Unlock()
    }

    return ch, unsubscribe
}

// Publish sends an event to all subscribers of the given deployment.
// Slow clients that have a full buffer will have events dropped (non-blocking send).
func (h *SSEHub) Publish(deploymentID string, eventType SSEEventType, data string) {
    h.mu.Lock()
    h.eventID[deploymentID]++
    id := h.eventID[deploymentID]
    h.mu.Unlock()

    event := SSEEvent{
        ID:        id,
        Type:      eventType,
        Data:      data,
        Timestamp: time.Now().UTC(),
    }

    h.mu.RLock()
    defer h.mu.RUnlock()

    for ch := range h.subscribers[deploymentID] {
        select {
        case ch <- event:
        default:
            // Drop event for slow client — never block the build goroutine
        }
    }
}

// PublishJSON marshals data to JSON and publishes it.
func (h *SSEHub) PublishJSON(deploymentID string, eventType SSEEventType, v interface{}) {
    data, _ := json.Marshal(v)
    h.Publish(deploymentID, eventType, string(data))
}

// Cleanup removes all state for a deployment (call after build completes).
func (h *SSEHub) Cleanup(deploymentID string) {
    h.mu.Lock()
    defer h.mu.Unlock()
    delete(h.eventID, deploymentID)
    // Note: don't close subscriber channels here — the SSE handler
    // will get a "done" event and unsubscribe itself.
}
```

### 8.2 File: `internal/worker/logger.go`

```go
package worker

import (
    "fmt"
    "io"
    "os"
    "sync"
    "time"
)

// LogLevel represents a build log severity.
type LogLevel string

const (
    LogInfo  LogLevel = "INFO"
    LogWarn  LogLevel = "WARN"
    LogError LogLevel = "ERROR"
    LogDebug LogLevel = "DEBUG"
)

// BuildLogger multiplexes build output to a log file and the SSE hub simultaneously.
type BuildLogger struct {
    deploymentID   string
    file           *os.File
    sseHub         *SSEHub
    maxSize        int64
    currentSize    int64
    mu             sync.Mutex
}

// NewBuildLogger creates a logger that writes to both file and SSE.
//
// logPath: absolute path to the log file (e.g., /app/logs/{deployment_id}.log)
// maxSize: maximum log file size in bytes (5MB default). Older lines are NOT
//          truncated mid-build; the limit is checked before each write and
//          new writes are skipped (with a final "log truncated" message) if exceeded.
func NewBuildLogger(logPath string, sseHub *SSEHub, deploymentID string, maxSize int64) (*BuildLogger, error) {
    if err := os.MkdirAll(filepath.Dir(logPath), 0755); err != nil {
        return nil, fmt.Errorf("create log dir: %w", err)
    }

    f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0640)
    if err != nil {
        return nil, fmt.Errorf("open log file: %w", err)
    }

    return &BuildLogger{
        deploymentID: deploymentID,
        file:         f,
        sseHub:       sseHub,
        maxSize:      maxSize,
    }, nil
}

// Info logs an informational message.
func (l *BuildLogger) Info(msg string) {
    l.write(LogInfo, msg)
}

// Infof logs a formatted informational message.
func (l *BuildLogger) Infof(format string, args ...interface{}) {
    l.write(LogInfo, fmt.Sprintf(format, args...))
}

// Warn logs a warning message.
func (l *BuildLogger) Warn(msg string) {
    l.write(LogWarn, msg)
}

// Error logs an error message.
func (l *BuildLogger) Error(msg string) {
    l.write(LogError, msg)
}

// Errorf logs a formatted error message.
func (l *BuildLogger) Errorf(format string, args ...interface{}) {
    l.write(LogError, fmt.Sprintf(format, args...))
}

// write is the internal method that writes to both file and SSE hub.
func (l *BuildLogger) write(level LogLevel, msg string) {
    l.mu.Lock()
    defer l.mu.Unlock()

    timestamp := time.Now().UTC().Format("2006-01-02 15:04:05")
    line := fmt.Sprintf("[%s] [%s] %s\n", timestamp, level, msg)

    // Write to file (check size limit)
    lineBytes := int64(len(line))
    if l.currentSize+lineBytes <= l.maxSize {
        _, _ = l.file.WriteString(line)
        l.currentSize += lineBytes
    } else if l.currentSize < l.maxSize {
        // Write a truncation notice as the last line
        truncMsg := fmt.Sprintf("[%s] [WARN] Log output truncated (exceeded %d bytes)\n", timestamp, l.maxSize)
        _, _ = l.file.WriteString(truncMsg)
        l.currentSize = l.maxSize // Prevent further writes
    }

    // Always publish to SSE (even if file is truncated — live viewers still see everything)
    l.sseHub.Publish(l.deploymentID, SSEEventLog, line)
}

// StreamWriter returns an io.Writer that writes each line to the logger.
// Used to capture Docker exec stdout/stderr output.
func (l *BuildLogger) StreamWriter(level LogLevel) io.Writer {
    return &logWriter{logger: l, level: level}
}

// Close flushes and closes the log file.
func (l *BuildLogger) Close() error {
    return l.file.Close()
}

// logWriter adapts BuildLogger to the io.Writer interface.
// It buffers partial lines and flushes on newline.
type logWriter struct {
    logger *BuildLogger
    level  LogLevel
    buf    []byte
}

func (w *logWriter) Write(p []byte) (n int, err error) {
    w.buf = append(w.buf, p...)
    for {
        idx := bytes.IndexByte(w.buf, '\n')
        if idx < 0 {
            break
        }
        line := string(w.buf[:idx])
        w.buf = w.buf[idx+1:]
        if line != "" {
            w.logger.write(w.level, line)
        }
    }
    return len(p), nil
}
```

---

## 9. Build Executor

### File: `internal/worker/executor.go`

This is the core build logic — the heart of Phase 3.

```go
package worker

import (
    "context"
    "crypto/sha256"
    "encoding/hex"
    "fmt"
    "os"
    "os/exec"
    "path/filepath"
    "strings"
    "sync"
    "time"

    "hostbox/internal/config"
    "hostbox/internal/models"
    "hostbox/internal/platform/detect"
    dockerpkg "hostbox/internal/platform/docker"
    "hostbox/internal/repository"
)

// PostBuildHook is called after a successful build.
// Phase 4/5 will provide real implementations (Caddy route, GitHub status, notifications).
type PostBuildHook interface {
    OnBuildSuccess(ctx context.Context, project *models.Project, deployment *models.Deployment) error
    OnBuildFailure(ctx context.Context, project *models.Project, deployment *models.Deployment, buildErr error) error
}

// noopPostBuildHook is the default stub for phases that aren't implemented yet.
type noopPostBuildHook struct{}

func (n *noopPostBuildHook) OnBuildSuccess(_ context.Context, _ *models.Project, _ *models.Deployment) error {
    return nil
}
func (n *noopPostBuildHook) OnBuildFailure(_ context.Context, _ *models.Project, _ *models.Deployment, _ error) error {
    return nil
}

// BuildExecutor runs the 6-step build pipeline for a single deployment.
type BuildExecutor struct {
    cfg            *config.BuildConfig
    docker         dockerpkg.DockerClient
    deploymentRepo *repository.DeploymentRepository
    projectRepo    *repository.ProjectRepository
    envVarRepo     *repository.EnvVarRepository
    sseHub         *SSEHub
    postBuild      PostBuildHook
    platformDomain string

    // Cancellation tracking: deploymentID → cancel function
    mu         sync.Mutex
    cancelFns  map[string]context.CancelFunc
}

// NewBuildExecutor creates an executor with all required dependencies.
func NewBuildExecutor(
    cfg *config.BuildConfig,
    docker dockerpkg.DockerClient,
    deploymentRepo *repository.DeploymentRepository,
    projectRepo *repository.ProjectRepository,
    envVarRepo *repository.EnvVarRepository,
    sseHub *SSEHub,
    platformDomain string,
) *BuildExecutor {
    return &BuildExecutor{
        cfg:            cfg,
        docker:         docker,
        deploymentRepo: deploymentRepo,
        projectRepo:    projectRepo,
        envVarRepo:     envVarRepo,
        sseHub:         sseHub,
        postBuild:      &noopPostBuildHook{},
        platformDomain: platformDomain,
        cancelFns:      make(map[string]context.CancelFunc),
    }
}

// SetPostBuildHook allows Phase 4/5 to register callbacks.
func (e *BuildExecutor) SetPostBuildHook(hook PostBuildHook) {
    e.postBuild = hook
}

// Execute runs the full build pipeline for a deployment.
// This is called by the worker pool goroutine.
func (e *BuildExecutor) Execute(parentCtx context.Context, deploymentID string) {
    // Create a cancellable context with the build timeout
    timeout := time.Duration(e.cfg.BuildTimeoutMinutes) * time.Minute
    ctx, cancel := context.WithTimeout(parentCtx, timeout)
    defer cancel()

    // Register the cancel function for external cancellation
    e.mu.Lock()
    e.cancelFns[deploymentID] = cancel
    e.mu.Unlock()
    defer func() {
        e.mu.Lock()
        delete(e.cancelFns, deploymentID)
        e.mu.Unlock()
    }()

    // Load deployment and project from DB
    deployment, err := e.deploymentRepo.GetByID(deploymentID)
    if err != nil {
        slog.Error("executor: deployment not found", "id", deploymentID, "err", err)
        return
    }
    project, err := e.projectRepo.GetByID(deployment.ProjectID)
    if err != nil {
        slog.Error("executor: project not found", "id", deployment.ProjectID, "err", err)
        return
    }

    // Open build logger
    logPath := filepath.Join(e.cfg.LogBaseDir, deploymentID+".log")
    logger, err := NewBuildLogger(logPath, e.sseHub, deploymentID, e.cfg.MaxLogFileSizeBytes)
    if err != nil {
        slog.Error("executor: failed to create logger", "err", err)
        e.failDeployment(deployment, "Internal error: failed to create build logger")
        return
    }
    defer logger.Close()

    // Update status to building
    now := time.Now().UTC()
    deployment.Status = "building"
    deployment.StartedAt = &now
    deployment.LogPath = logPath
    if err := e.deploymentRepo.Update(deployment); err != nil {
        logger.Errorf("Failed to update status: %v", err)
        return
    }
    e.sseHub.PublishJSON(deploymentID, SSEEventStatus, map[string]string{"status": "building"})

    startTime := time.Now()

    // === STEP 1: Clone Repository ===
    logger.Info("▶ Cloning repository...")
    cloneDir, err := e.stepClone(ctx, project, deployment, logger)
    if err != nil {
        e.handleFailure(ctx, deployment, project, logger, "Clone failed: "+err.Error())
        return
    }
    defer os.RemoveAll(cloneDir)

    // Resolve source directory (monorepo support)
    sourceDir := cloneDir
    if project.RootDirectory != "" && project.RootDirectory != "/" {
        sourceDir = filepath.Join(cloneDir, strings.TrimPrefix(project.RootDirectory, "/"))
        if _, err := os.Stat(sourceDir); err != nil {
            e.handleFailure(ctx, deployment, project, logger,
                fmt.Sprintf("Root directory %q not found in repository", project.RootDirectory))
            return
        }
    }

    // === STEP 2: Detect Framework ===
    logger.Info("▶ Detecting framework...")
    fw, pkg, err := detect.DetectFramework(sourceDir)
    if err != nil {
        e.handleFailure(ctx, deployment, project, logger, "Framework detection failed: "+err.Error())
        return
    }

    // Apply project-level overrides
    fw = detect.ApplyOverrides(fw, project.BuildCommand, "", project.OutputDirectory)

    // Detect package manager
    pm := detect.DetectPackageManager(sourceDir)
    installCmd := pm.InstallCommand
    if project.InstallCommand != "" {
        installCmd = project.InstallCommand
    }

    // Detect Node version
    nodeVersion := detect.DetectNodeVersion(pkg, e.cfg.DefaultNodeVersion)
    if project.NodeVersion != "" {
        nodeVersion = project.NodeVersion
    }

    logger.Infof("  Framework: %s", fw.DisplayName)
    logger.Infof("  Node.js: %s", nodeVersion)
    logger.Infof("  Package manager: %s", pm.Name)
    logger.Infof("  Build command: %s", fw.BuildCommand)
    logger.Infof("  Output directory: %s", fw.OutputDirectory)

    // Check context before expensive Docker operations
    if ctx.Err() != nil {
        e.handleFailure(ctx, deployment, project, logger, "Build cancelled")
        return
    }

    // === Cache invalidation check ===
    lockHash := detect.HashLockFile(sourceDir, pm.LockFile)
    cacheInvalidated := e.shouldInvalidateCache(project, nodeVersion, pm.Name, lockHash)
    if cacheInvalidated {
        logger.Info("  ⚠ Cache invalidated (dependency changes detected)")
        e.invalidateCache(ctx, project.ID)
    }

    // Update project metadata for future cache checks
    e.projectRepo.UpdateBuildMeta(project.ID, pm.Name, lockHash)

    // === STEP 3: Create Docker Container ===
    logger.Info("▶ Creating build container...")
    outputDir := filepath.Join(e.cfg.DeploymentBaseDir, project.ID, deploymentID)
    if err := os.MkdirAll(outputDir, 0755); err != nil {
        e.handleFailure(ctx, deployment, project, logger, "Failed to create output directory: "+err.Error())
        return
    }

    envVars := e.resolveEnvVars(project, deployment)

    containerID, err := e.docker.CreateBuildContainer(ctx, dockerpkg.BuildContainerOpts{
        DeploymentID: deploymentID,
        NodeVersion:  nodeVersion,
        SourceDir:    sourceDir,
        OutputDir:    outputDir,
        CacheVolume:  fmt.Sprintf("cache-%s-modules", project.ID),
        BuildCache:   fmt.Sprintf("cache-%s-build", project.ID),
        EnvVars:      envVars,
        MemoryBytes:  e.cfg.DefaultMemoryMB * 1024 * 1024,
        NanoCPUs:     int64(e.cfg.DefaultCPUs * 1e9),
        PIDLimit:     e.cfg.PIDLimit,
    })
    if err != nil {
        e.handleFailure(ctx, deployment, project, logger, "Container creation failed: "+err.Error())
        return
    }
    defer func() {
        e.docker.RemoveContainer(context.Background(), containerID)
    }()

    // === STEP 4: Execute install + build commands ===
    if fw.Name != "static" && fw.Name != "hugo" {
        // Run install command
        if installCmd != "" {
            logger.Infof("▶ Running: %s", installCmd)
            if err := e.execInContainer(ctx, containerID, installCmd, logger); err != nil {
                e.handleFailure(ctx, deployment, project, logger, "Install failed: "+err.Error())
                return
            }
        }

        // Run build command
        if fw.BuildCommand != "" {
            logger.Infof("▶ Running: %s", fw.BuildCommand)
            if err := e.execInContainer(ctx, containerID, fw.BuildCommand, logger); err != nil {
                e.handleFailure(ctx, deployment, project, logger, "Build failed: "+err.Error())
                return
            }
        }
    } else if fw.Name == "hugo" {
        // Hugo builds don't need npm install
        logger.Infof("▶ Running: %s", fw.BuildCommand)
        if err := e.execInContainer(ctx, containerID, fw.BuildCommand, logger); err != nil {
            e.handleFailure(ctx, deployment, project, logger, "Build failed: "+err.Error())
            return
        }
    }
    // For "static" framework: no install or build needed

    // Check context between steps
    if ctx.Err() != nil {
        e.handleFailure(ctx, deployment, project, logger, "Build cancelled")
        return
    }

    // === STEP 5: Copy build output ===
    logger.Info("▶ Copying build output...")
    var artifactSize int64

    if fw.Name == "static" && fw.OutputDirectory == "." {
        // For plain static sites, copy the entire source to output
        artifactSize, err = copyDir(sourceDir, outputDir)
    } else {
        // Copy the framework's output directory from the container
        containerOutputPath := filepath.Join("/app/src", fw.OutputDirectory)
        artifactSize, err = e.docker.CopyFromContainer(ctx, containerID, containerOutputPath, outputDir)
    }

    if err != nil {
        e.handleFailure(ctx, deployment, project, logger, "Output copy failed: "+err.Error())
        return
    }

    // Verify output contains at least one file
    if isEmpty, _ := isDirEmpty(outputDir); isEmpty {
        e.handleFailure(ctx, deployment, project, logger,
            fmt.Sprintf("Build output directory %q is empty — check your build command and output directory setting", fw.OutputDirectory))
        return
    }

    // === STEP 6: Finalize deployment ===
    duration := time.Since(startTime)
    deploymentURL := generateDeploymentURL(project, deployment, e.platformDomain)

    completedAt := time.Now().UTC()
    deployment.Status = "ready"
    deployment.ArtifactPath = outputDir
    deployment.ArtifactSizeBytes = artifactSize
    deployment.BuildDurationMs = int(duration.Milliseconds())
    deployment.DeploymentURL = deploymentURL
    deployment.CompletedAt = &completedAt

    if err := e.deploymentRepo.Update(deployment); err != nil {
        logger.Errorf("Failed to update deployment record: %v", err)
    }

    logger.Infof("▶ Build complete (%s)", duration.Round(time.Second))
    logger.Infof("  Artifact size: %s", humanizeBytes(artifactSize))
    logger.Infof("  URL: %s", deploymentURL)
    logger.Info("✅ Deployment ready!")

    // Publish done event
    e.sseHub.PublishJSON(deploymentID, SSEEventDone, map[string]interface{}{
        "status":       "ready",
        "duration_ms":  duration.Milliseconds(),
        "url":          deploymentURL,
        "artifact_size": artifactSize,
    })

    // Post-build hooks (Caddy, GitHub, notifications — stubs in Phase 3)
    if err := e.postBuild.OnBuildSuccess(ctx, project, deployment); err != nil {
        logger.Warnf("Post-build hook error: %v", err)
    }
}

// CancelBuild cancels an in-flight build by deployment ID.
func (e *BuildExecutor) CancelBuild(deploymentID string) {
    e.mu.Lock()
    cancelFn, ok := e.cancelFns[deploymentID]
    e.mu.Unlock()

    if ok {
        cancelFn()
    }

    // Also force-stop the Docker container (2s grace period)
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()
    e.docker.StopContainer(ctx, "build-"+deploymentID, 2*time.Second)
}
```

### 9.1 Helper Methods on BuildExecutor

```go
// stepClone performs Step 1: Git clone with retries.
func (e *BuildExecutor) stepClone(
    ctx context.Context,
    project *models.Project,
    deployment *models.Deployment,
    logger *BuildLogger,
) (string, error) {
    cloneDir := filepath.Join(e.cfg.CloneBaseDir, "clone-"+deployment.ID)
    if err := os.MkdirAll(cloneDir, 0755); err != nil {
        return "", fmt.Errorf("mkdir clone dir: %w", err)
    }

    // Build clone URL
    // For GitHub App: https://x-access-token:{token}@github.com/{owner}/{repo}.git
    // Token acquisition is handled by the GitHub service (Phase 4).
    // For Phase 3 (manual deploys), we use HTTPS without auth for public repos
    // or a PAT configured in env vars.
    cloneURL := fmt.Sprintf("https://github.com/%s.git", project.GithubRepo)

    cloneTimeout := time.Duration(e.cfg.CloneTimeoutSeconds) * time.Second
    maxRetries := e.cfg.CloneMaxRetries
    retryDelay := time.Duration(e.cfg.CloneRetryDelaySec) * time.Second

    var lastErr error
    for attempt := 1; attempt <= maxRetries; attempt++ {
        if attempt > 1 {
            logger.Infof("  Retry %d/%d (waiting %s)...", attempt, maxRetries, retryDelay)
            select {
            case <-ctx.Done():
                return "", ctx.Err()
            case <-time.After(retryDelay):
            }
            // Clean up partial clone
            os.RemoveAll(cloneDir)
            os.MkdirAll(cloneDir, 0755)
        }

        cloneCtx, cloneCancel := context.WithTimeout(ctx, cloneTimeout)

        args := []string{
            "clone",
            "--depth=1",
            "--single-branch",
            "--branch", deployment.Branch,
            cloneURL,
            cloneDir,
        }

        cmd := exec.CommandContext(cloneCtx, "git", args...)
        cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")

        output, err := cmd.CombinedOutput()
        cloneCancel()

        if err == nil {
            logger.Infof("  Cloned %s@%s", project.GithubRepo, deployment.Branch)
            return cloneDir, nil
        }

        lastErr = fmt.Errorf("git clone (attempt %d): %w\n%s", attempt, err, string(output))
        logger.Warnf("  Clone attempt %d failed: %v", attempt, err)
    }

    return "", lastErr
}

// execInContainer runs a command in the build container, streaming output to the logger.
func (e *BuildExecutor) execInContainer(
    ctx context.Context,
    containerID string,
    cmd string,
    logger *BuildLogger,
) error {
    stdout := logger.StreamWriter(LogInfo)
    stderr := logger.StreamWriter(LogError)
    return e.docker.ExecCommand(ctx, containerID, cmd, stdout, stderr)
}

// resolveEnvVars builds the full list of environment variables for the build container.
func (e *BuildExecutor) resolveEnvVars(project *models.Project, deployment *models.Deployment) []string {
    vars := []string{
        "CI=true",
        "HOSTBOX=1",
        "NODE_ENV=production",
        "HOSTBOX_PROJECT_ID=" + project.ID,
        "HOSTBOX_PROJECT_NAME=" + project.Name,
        "HOSTBOX_DEPLOYMENT_ID=" + deployment.ID,
        "HOSTBOX_BRANCH=" + deployment.Branch,
        "HOSTBOX_COMMIT_SHA=" + deployment.CommitSHA,
    }

    if deployment.IsProduction {
        vars = append(vars, "HOSTBOX_IS_PREVIEW=false")
    } else {
        vars = append(vars, "HOSTBOX_IS_PREVIEW=true")
    }

    // Load project-scoped env vars from DB
    scope := "preview"
    if deployment.IsProduction {
        scope = "production"
    }
    projectVars, err := e.envVarRepo.GetDecryptedForBuild(project.ID, scope)
    if err != nil {
        slog.Warn("Failed to load project env vars", "project_id", project.ID, "err", err)
    }
    for _, v := range projectVars {
        vars = append(vars, v.Key+"="+v.DecryptedValue)
    }

    return vars
}

// shouldInvalidateCache determines if the build cache should be cleared.
func (e *BuildExecutor) shouldInvalidateCache(project *models.Project, nodeVersion, pkgManager, lockHash string) bool {
    if project.NodeVersion != nodeVersion && project.NodeVersion != "" {
        return true
    }
    if project.DetectedPackageManager != pkgManager && project.DetectedPackageManager != "" {
        return true
    }
    if project.LockFileHash != lockHash && project.LockFileHash != "" {
        return true
    }
    return false
}

// invalidateCache removes the Docker cache volumes for a project.
func (e *BuildExecutor) invalidateCache(ctx context.Context, projectID string) {
    _ = e.docker.RemoveVolume(ctx, fmt.Sprintf("cache-%s-modules", projectID))
    _ = e.docker.RemoveVolume(ctx, fmt.Sprintf("cache-%s-build", projectID))
}

// handleFailure updates the deployment to failed status and notifies.
func (e *BuildExecutor) handleFailure(
    ctx context.Context,
    deployment *models.Deployment,
    project *models.Project,
    logger *BuildLogger,
    errMsg string,
) {
    logger.Errorf("❌ %s", errMsg)

    completedAt := time.Now().UTC()
    deployment.Status = "failed"
    deployment.ErrorMessage = errMsg
    deployment.CompletedAt = &completedAt
    _ = e.deploymentRepo.Update(deployment)

    e.sseHub.PublishJSON(deployment.ID, SSEEventDone, map[string]interface{}{
        "status":  "failed",
        "message": errMsg,
    })

    _ = e.postBuild.OnBuildFailure(ctx, project, deployment, fmt.Errorf("%s", errMsg))
}

// failDeployment is a simpler failure path used when we don't have a logger yet.
func (e *BuildExecutor) failDeployment(deployment *models.Deployment, errMsg string) {
    completedAt := time.Now().UTC()
    deployment.Status = "failed"
    deployment.ErrorMessage = errMsg
    deployment.CompletedAt = &completedAt
    _ = e.deploymentRepo.Update(deployment)
}
```

### 9.2 Utility Functions

```go
// File: internal/worker/util.go

package worker

import (
    "fmt"
    "io/fs"
    "os"
    "path/filepath"
)

// generateDeploymentURL creates the URL for a deployment.
//
// Production:     {project_slug}.{platform_domain}
// Preview:        {project_slug}-{short_commit_sha}.{platform_domain}
// Branch-stable:  {project_slug}-{branch_slug}.{platform_domain}
func generateDeploymentURL(project *models.Project, deployment *models.Deployment, platformDomain string) string {
    scheme := "https"

    if deployment.IsProduction {
        return fmt.Sprintf("%s://%s.%s", scheme, project.Slug, platformDomain)
    }

    // Preview URL uses first 8 chars of commit SHA
    shortSHA := deployment.CommitSHA
    if len(shortSHA) > 8 {
        shortSHA = shortSHA[:8]
    }

    return fmt.Sprintf("%s://%s-%s.%s", scheme, project.Slug, shortSHA, platformDomain)
}

// generateBranchStableURL creates a branch-stable URL.
func generateBranchStableURL(project *models.Project, branch, platformDomain string) string {
    branchSlug := slugify(branch)
    return fmt.Sprintf("https://%s-%s.%s", project.Slug, branchSlug, platformDomain)
}

// slugify converts a branch name to a URL-safe slug.
// e.g., "feat/login-page" → "feat-login-page"
func slugify(s string) string {
    s = strings.ToLower(s)
    s = strings.Map(func(r rune) rune {
        if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
            return r
        }
        return '-'
    }, s)
    // Collapse multiple hyphens
    for strings.Contains(s, "--") {
        s = strings.ReplaceAll(s, "--", "-")
    }
    s = strings.Trim(s, "-")
    // Limit length to keep URLs reasonable
    if len(s) > 40 {
        s = s[:40]
    }
    return s
}

// copyDir recursively copies src to dst. Returns total bytes copied.
func copyDir(src, dst string) (int64, error) {
    var totalSize int64
    return totalSize, filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
        if err != nil {
            return err
        }

        relPath, _ := filepath.Rel(src, path)
        targetPath := filepath.Join(dst, relPath)

        if d.IsDir() {
            return os.MkdirAll(targetPath, 0755)
        }

        data, err := os.ReadFile(path)
        if err != nil {
            return err
        }
        totalSize += int64(len(data))
        return os.WriteFile(targetPath, data, 0644)
    })
}

// isDirEmpty checks if a directory has zero files (recursive).
func isDirEmpty(dir string) (bool, error) {
    entries, err := os.ReadDir(dir)
    if err != nil {
        return true, err
    }
    return len(entries) == 0, nil
}

// humanizeBytes formats bytes into a human-readable string.
func humanizeBytes(b int64) string {
    const (
        KB = 1024
        MB = KB * 1024
        GB = MB * 1024
    )
    switch {
    case b >= GB:
        return fmt.Sprintf("%.1f GB", float64(b)/float64(GB))
    case b >= MB:
        return fmt.Sprintf("%.1f MB", float64(b)/float64(MB))
    case b >= KB:
        return fmt.Sprintf("%.1f KB", float64(b)/float64(KB))
    default:
        return fmt.Sprintf("%d B", b)
    }
}
```

---

## 10. Worker Pool

### File: `internal/worker/pool.go`

```go
package worker

import (
    "context"
    "log/slog"
    "sync"
    "time"

    dockerpkg "hostbox/internal/platform/docker"
    "hostbox/internal/repository"
)

// Pool is a bounded goroutine worker pool that processes deployment build jobs.
type Pool struct {
    jobs       chan string // deployment IDs
    maxWorkers int
    wg         sync.WaitGroup
    ctx        context.Context
    cancel     context.CancelFunc
    executor   *BuildExecutor
    deployRepo *repository.DeploymentRepository
    docker     dockerpkg.DockerClient
}

// NewPool creates a worker pool. Call Start() to begin processing.
func NewPool(
    maxWorkers int,
    bufferSize int,
    executor *BuildExecutor,
    deployRepo *repository.DeploymentRepository,
    docker dockerpkg.DockerClient,
) *Pool {
    ctx, cancel := context.WithCancel(context.Background())
    return &Pool{
        jobs:       make(chan string, bufferSize),
        maxWorkers: maxWorkers,
        ctx:        ctx,
        cancel:     cancel,
        executor:   executor,
        deployRepo: deployRepo,
        docker:     docker,
    }
}

// Start launches worker goroutines and performs crash recovery.
func (p *Pool) Start() error {
    // Crash recovery: mark stuck "building" deployments as failed
    if err := p.recoverCrashedBuilds(); err != nil {
        slog.Error("worker pool: crash recovery failed", "err", err)
        // Non-fatal: continue starting workers
    }

    // Clean up orphaned build containers
    p.cleanOrphanedContainers()

    // Start worker goroutines
    for i := 0; i < p.maxWorkers; i++ {
        p.wg.Add(1)
        go p.worker(i)
    }
    slog.Info("worker pool started", "workers", p.maxWorkers)

    // Re-enqueue any deployments in "queued" state (they were queued before crash)
    p.reEnqueuePending()

    return nil
}

// worker is the main loop for a single worker goroutine.
func (p *Pool) worker(id int) {
    defer p.wg.Done()
    slog.Debug("worker started", "worker_id", id)

    for {
        select {
        case <-p.ctx.Done():
            slog.Debug("worker stopping", "worker_id", id)
            return
        case deploymentID, ok := <-p.jobs:
            if !ok {
                return // Channel closed
            }
            slog.Info("worker picked up job", "worker_id", id, "deployment_id", deploymentID)
            p.executor.Execute(p.ctx, deploymentID)
        }
    }
}

// Enqueue adds a deployment ID to the job queue.
// Returns immediately. If the queue is full, it blocks until space is available.
func (p *Pool) Enqueue(deploymentID string) {
    select {
    case p.jobs <- deploymentID:
        slog.Debug("job enqueued", "deployment_id", deploymentID)
    case <-p.ctx.Done():
        slog.Warn("pool shutdown: dropping job", "deployment_id", deploymentID)
    }
}

// Shutdown gracefully stops the worker pool.
//
// 1. Signals workers to stop accepting new jobs (cancel context)
// 2. Waits up to `timeout` for in-progress builds to complete
// 3. If timeout exceeded: force-kills running Docker containers
func (p *Pool) Shutdown(timeout time.Duration) {
    slog.Info("worker pool shutting down", "timeout", timeout)

    // Stop accepting new jobs
    p.cancel()

    // Wait for in-progress builds with timeout
    done := make(chan struct{})
    go func() {
        p.wg.Wait()
        close(done)
    }()

    select {
    case <-done:
        slog.Info("worker pool: all builds completed")
    case <-time.After(timeout):
        slog.Warn("worker pool: shutdown timeout, force-killing containers")
        p.forceKillContainers()
    }

    close(p.jobs)
}

// recoverCrashedBuilds marks any deployment stuck in "building" as "failed".
func (p *Pool) recoverCrashedBuilds() error {
    stuck, err := p.deployRepo.FindByStatus("building")
    if err != nil {
        return err
    }

    for _, d := range stuck {
        slog.Warn("recovering stuck build", "deployment_id", d.ID)
        now := time.Now().UTC()
        d.Status = "failed"
        d.ErrorMessage = "Build interrupted by server restart"
        d.CompletedAt = &now
        if err := p.deployRepo.Update(&d); err != nil {
            slog.Error("failed to mark deployment as failed", "id", d.ID, "err", err)
        }
    }

    if len(stuck) > 0 {
        slog.Info("crash recovery complete", "recovered", len(stuck))
    }
    return nil
}

// cleanOrphanedContainers removes any Docker containers with the "hostbox.managed" label
// that are left over from a previous run.
func (p *Pool) cleanOrphanedContainers() {
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    containers, err := p.docker.ListManagedContainers(ctx)
    if err != nil {
        slog.Warn("failed to list managed containers", "err", err)
        return
    }

    for _, c := range containers {
        slog.Info("removing orphaned container", "id", c.ID[:12], "name", c.Names)
        p.docker.RemoveContainer(ctx, c.ID)
    }
}

// reEnqueuePending loads queued deployments from DB and feeds them into the job channel.
func (p *Pool) reEnqueuePending() {
    queued, err := p.deployRepo.FindByStatus("queued")
    if err != nil {
        slog.Error("failed to load queued deployments", "err", err)
        return
    }

    for _, d := range queued {
        slog.Info("re-enqueuing pending deployment", "deployment_id", d.ID)
        p.Enqueue(d.ID)
    }
}

// forceKillContainers stops all hostbox-managed containers (called on shutdown timeout).
func (p *Pool) forceKillContainers() {
    ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()

    containers, err := p.docker.ListManagedContainers(ctx)
    if err != nil {
        return
    }
    for _, c := range containers {
        _ = p.docker.StopContainer(ctx, c.ID, 2*time.Second)
        p.docker.RemoveContainer(ctx, c.ID)
    }
}
```

---

## 11. Deployment Service

### File: `internal/services/deployment/service.go`

The DeploymentService orchestrates the creation, cancellation, and lifecycle management of deployments. It sits between the API handlers and the worker pool.

```go
package deployment

import (
    "context"
    "fmt"
    "time"

    "hostbox/internal/models"
    "hostbox/internal/repository"
    "hostbox/internal/worker"
)

type Service struct {
    deployRepo *repository.DeploymentRepository
    projectRepo *repository.ProjectRepository
    pool        *worker.Pool
    executor    *worker.BuildExecutor
    platformDomain string
}

func NewService(
    deployRepo *repository.DeploymentRepository,
    projectRepo *repository.ProjectRepository,
    pool *worker.Pool,
    executor *worker.BuildExecutor,
    platformDomain string,
) *Service {
    return &Service{
        deployRepo:     deployRepo,
        projectRepo:    projectRepo,
        pool:           pool,
        executor:       executor,
        platformDomain: platformDomain,
    }
}

// TriggerDeployment creates a new deployment and enqueues it for building.
// Handles deduplication: cancels existing queued/building deployments for same project+branch.
func (s *Service) TriggerDeployment(ctx context.Context, req TriggerRequest) (*models.Deployment, error) {
    project, err := s.projectRepo.GetByID(req.ProjectID)
    if err != nil {
        return nil, fmt.Errorf("project not found: %w", err)
    }

    // Determine if this is a production deployment
    isProduction := req.Branch == project.ProductionBranch

    // Deduplication: cancel any existing queued/building deploy for this project+branch
    existing, _ := s.deployRepo.FindQueuedOrBuilding(req.ProjectID, req.Branch)
    if existing != nil {
        s.cancelDeployment(ctx, existing)
    }

    // Create deployment record
    deployment := &models.Deployment{
        ID:            nanoid.New(),
        ProjectID:     req.ProjectID,
        CommitSHA:     req.CommitSHA,
        CommitMessage: req.CommitMessage,
        CommitAuthor:  req.CommitAuthor,
        Branch:        req.Branch,
        Status:        "queued",
        IsProduction:  isProduction,
        GithubPRNumber: req.PRNumber,
        CreatedAt:     time.Now().UTC(),
    }

    if err := s.deployRepo.Create(deployment); err != nil {
        return nil, fmt.Errorf("create deployment: %w", err)
    }

    // Enqueue for building
    s.pool.Enqueue(deployment.ID)

    return deployment, nil
}

// CancelDeployment cancels a queued or building deployment.
func (s *Service) CancelDeployment(ctx context.Context, deploymentID string) (*models.Deployment, error) {
    deployment, err := s.deployRepo.GetByID(deploymentID)
    if err != nil {
        return nil, fmt.Errorf("deployment not found: %w", err)
    }

    if deployment.Status != "queued" && deployment.Status != "building" {
        return nil, fmt.Errorf("cannot cancel deployment in %q status", deployment.Status)
    }

    s.cancelDeployment(ctx, deployment)
    return deployment, nil
}

// cancelDeployment performs the actual cancellation (shared by dedup and explicit cancel).
func (s *Service) cancelDeployment(ctx context.Context, deployment *models.Deployment) {
    if deployment.Status == "building" {
        s.executor.CancelBuild(deployment.ID)
    }

    now := time.Now().UTC()
    deployment.Status = "cancelled"
    deployment.CompletedAt = &now
    _ = s.deployRepo.Update(deployment)
}

// GetDeployment returns a single deployment by ID.
func (s *Service) GetDeployment(ctx context.Context, id string) (*models.Deployment, error) {
    return s.deployRepo.GetByID(id)
}

// ListDeployments returns paginated deployments for a project.
func (s *Service) ListDeployments(ctx context.Context, projectID string, opts ListOpts) ([]models.Deployment, int, error) {
    return s.deployRepo.ListByProject(projectID, opts.Page, opts.PerPage, opts.Status, opts.Branch)
}

// Rollback creates a new deployment that points to a previous deployment's artifacts.
// No rebuild required — it's instant.
func (s *Service) Rollback(ctx context.Context, projectID, targetDeploymentID string) (*models.Deployment, error) {
    target, err := s.deployRepo.GetByID(targetDeploymentID)
    if err != nil {
        return nil, fmt.Errorf("target deployment not found: %w", err)
    }
    if target.Status != "ready" {
        return nil, fmt.Errorf("cannot rollback to deployment in %q status", target.Status)
    }
    if target.ProjectID != projectID {
        return nil, fmt.Errorf("deployment does not belong to this project")
    }

    project, err := s.projectRepo.GetByID(projectID)
    if err != nil {
        return nil, fmt.Errorf("project not found: %w", err)
    }

    now := time.Now().UTC()
    deployment := &models.Deployment{
        ID:                nanoid.New(),
        ProjectID:         projectID,
        CommitSHA:         target.CommitSHA,
        CommitMessage:     target.CommitMessage,
        CommitAuthor:      target.CommitAuthor,
        Branch:            target.Branch,
        Status:            "ready",
        IsProduction:      true,
        ArtifactPath:      target.ArtifactPath,
        ArtifactSizeBytes: target.ArtifactSizeBytes,
        DeploymentURL:     generateDeploymentURL(project, target, s.platformDomain),
        IsRollback:        true,
        RollbackSourceID:  &target.ID,
        CompletedAt:       &now,
        CreatedAt:         now,
    }

    if err := s.deployRepo.Create(deployment); err != nil {
        return nil, fmt.Errorf("create rollback deployment: %w", err)
    }

    // TODO (Phase 5): Update Caddy routes to point to this deployment

    return deployment, nil
}

// Promote makes a preview deployment the new production deployment.
// Creates a new deployment record marked as production pointing to the same artifacts.
func (s *Service) Promote(ctx context.Context, projectID, deploymentID string) (*models.Deployment, error) {
    source, err := s.deployRepo.GetByID(deploymentID)
    if err != nil {
        return nil, fmt.Errorf("deployment not found: %w", err)
    }
    if source.Status != "ready" {
        return nil, fmt.Errorf("cannot promote deployment in %q status", source.Status)
    }
    if source.ProjectID != projectID {
        return nil, fmt.Errorf("deployment does not belong to this project")
    }

    project, err := s.projectRepo.GetByID(projectID)
    if err != nil {
        return nil, fmt.Errorf("project not found: %w", err)
    }

    now := time.Now().UTC()
    promoted := &models.Deployment{
        ID:                nanoid.New(),
        ProjectID:         projectID,
        CommitSHA:         source.CommitSHA,
        CommitMessage:     source.CommitMessage,
        CommitAuthor:      source.CommitAuthor,
        Branch:            project.ProductionBranch,
        Status:            "ready",
        IsProduction:      true,
        ArtifactPath:      source.ArtifactPath,
        ArtifactSizeBytes: source.ArtifactSizeBytes,
        DeploymentURL:     fmt.Sprintf("https://%s.%s", project.Slug, s.platformDomain),
        CompletedAt:       &now,
        CreatedAt:         now,
    }

    if err := s.deployRepo.Create(promoted); err != nil {
        return nil, fmt.Errorf("create promoted deployment: %w", err)
    }

    // TODO (Phase 5): Update Caddy routes

    return promoted, nil
}

// Redeploy triggers a new build using the same branch and latest commit.
func (s *Service) Redeploy(ctx context.Context, projectID string) (*models.Deployment, error) {
    // Find the latest production deployment
    latest, err := s.deployRepo.FindLatestReady(projectID, true)
    if err != nil {
        return nil, fmt.Errorf("no previous production deployment found: %w", err)
    }

    return s.TriggerDeployment(ctx, TriggerRequest{
        ProjectID:     projectID,
        Branch:        latest.Branch,
        CommitSHA:     latest.CommitSHA,
        CommitMessage: latest.CommitMessage,
        CommitAuthor:  latest.CommitAuthor,
    })
}
```

### 11.1 Supporting Types

```go
// File: internal/services/deployment/types.go

package deployment

// TriggerRequest holds the data needed to trigger a deployment.
type TriggerRequest struct {
    ProjectID     string
    Branch        string
    CommitSHA     string
    CommitMessage string
    CommitAuthor  string
    PRNumber      *int
}

// ListOpts configures list queries.
type ListOpts struct {
    Page    int
    PerPage int
    Status  string // filter by status (empty = all)
    Branch  string // filter by branch (empty = all)
}
```

---

## 12. API Handlers & Routes

### File: `internal/api/handlers/deployment.go`

```go
package handlers

import (
    "fmt"
    "io"
    "net/http"
    "os"
    "strconv"

    "github.com/labstack/echo/v4"

    deploysvc "hostbox/internal/services/deployment"
    "hostbox/internal/worker"
)

type DeploymentHandler struct {
    service *deploysvc.Service
    sseHub  *worker.SSEHub
    logDir  string
}

func NewDeploymentHandler(svc *deploysvc.Service, sseHub *worker.SSEHub, logDir string) *DeploymentHandler {
    return &DeploymentHandler{service: svc, sseHub: sseHub, logDir: logDir}
}

// POST /api/v1/projects/:id/deployments
func (h *DeploymentHandler) TriggerDeploy(c echo.Context) error {
    projectID := c.Param("id")
    var req dto.TriggerDeployRequest
    if err := c.Bind(&req); err != nil {
        return echo.NewHTTPError(http.StatusBadRequest, "invalid request body")
    }
    if err := c.Validate(req); err != nil {
        return echo.NewHTTPError(http.StatusBadRequest, err.Error())
    }

    deployment, err := h.service.TriggerDeployment(c.Request().Context(), deploysvc.TriggerRequest{
        ProjectID:     projectID,
        Branch:        req.Branch,
        CommitSHA:     req.CommitSHA,
        CommitMessage: req.CommitMessage,
        CommitAuthor:  req.CommitAuthor,
    })
    if err != nil {
        return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
    }

    return c.JSON(http.StatusAccepted, dto.DeploymentResponse{Deployment: toDeploymentDTO(deployment)})
}

// GET /api/v1/deployments/:id
func (h *DeploymentHandler) GetDeployment(c echo.Context) error {
    id := c.Param("id")
    deployment, err := h.service.GetDeployment(c.Request().Context(), id)
    if err != nil {
        return echo.NewHTTPError(http.StatusNotFound, "deployment not found")
    }
    return c.JSON(http.StatusOK, dto.DeploymentResponse{Deployment: toDeploymentDTO(deployment)})
}

// GET /api/v1/projects/:id/deployments
func (h *DeploymentHandler) ListDeployments(c echo.Context) error {
    projectID := c.Param("id")
    page, _ := strconv.Atoi(c.QueryParam("page"))
    perPage, _ := strconv.Atoi(c.QueryParam("per_page"))
    if page < 1 { page = 1 }
    if perPage < 1 || perPage > 100 { perPage = 20 }

    deployments, total, err := h.service.ListDeployments(c.Request().Context(), projectID, deploysvc.ListOpts{
        Page:    page,
        PerPage: perPage,
        Status:  c.QueryParam("status"),
        Branch:  c.QueryParam("branch"),
    })
    if err != nil {
        return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
    }

    dtos := make([]dto.DeploymentDTO, len(deployments))
    for i, d := range deployments {
        dtos[i] = toDeploymentDTO(&d)
    }

    return c.JSON(http.StatusOK, dto.DeploymentListResponse{
        Deployments: dtos,
        Pagination:  dto.Pagination{Total: total, Page: page, PerPage: perPage, TotalPages: (total + perPage - 1) / perPage},
    })
}

// GET /api/v1/deployments/:id/logs
func (h *DeploymentHandler) GetLogs(c echo.Context) error {
    id := c.Param("id")
    deployment, err := h.service.GetDeployment(c.Request().Context(), id)
    if err != nil {
        return echo.NewHTTPError(http.StatusNotFound, "deployment not found")
    }

    logPath := deployment.LogPath
    if logPath == "" {
        logPath = filepath.Join(h.logDir, id+".log")
    }

    data, err := os.ReadFile(logPath)
    if err != nil {
        if os.IsNotExist(err) {
            return c.JSON(http.StatusOK, dto.LogResponse{Lines: []string{}, TotalLines: 0})
        }
        return echo.NewHTTPError(http.StatusInternalServerError, "failed to read logs")
    }

    lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")

    // Apply offset/limit
    offset, _ := strconv.Atoi(c.QueryParam("offset"))
    limit, _ := strconv.Atoi(c.QueryParam("limit"))
    if limit <= 0 || limit > 5000 { limit = 1000 }
    if offset < 0 { offset = 0 }

    total := len(lines)
    end := offset + limit
    if end > total { end = total }
    if offset >= total { offset = total }

    return c.JSON(http.StatusOK, dto.LogResponse{
        Lines:      lines[offset:end],
        TotalLines: total,
        HasMore:    end < total,
    })
}

// GET /api/v1/deployments/:id/logs/stream
func (h *DeploymentHandler) StreamLogs(c echo.Context) error {
    deploymentID := c.Param("id")

    // Verify deployment exists
    deployment, err := h.service.GetDeployment(c.Request().Context(), deploymentID)
    if err != nil {
        return echo.NewHTTPError(http.StatusNotFound, "deployment not found")
    }

    c.Response().Header().Set("Content-Type", "text/event-stream")
    c.Response().Header().Set("Cache-Control", "no-cache")
    c.Response().Header().Set("Connection", "keep-alive")
    c.Response().Header().Set("X-Accel-Buffering", "no")
    c.Response().WriteHeader(http.StatusOK)

    // Send existing log lines first (for reconnection / late join)
    lastEventIDStr := c.Request().Header.Get("Last-Event-ID")
    lastEventID, _ := strconv.ParseInt(lastEventIDStr, 10, 64)

    logPath := deployment.LogPath
    if logPath == "" {
        logPath = filepath.Join(h.logDir, deploymentID+".log")
    }

    if data, err := os.ReadFile(logPath); err == nil {
        lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
        for i, line := range lines {
            lineID := int64(i + 1)
            if lineID <= lastEventID {
                continue
            }
            fmt.Fprintf(c.Response(), "id: %d\nevent: log\ndata: %s\n\n", lineID, line)
        }
        c.Response().Flush()
    }

    // If the build is already completed, send done event and close
    if deployment.Status == "ready" || deployment.Status == "failed" || deployment.Status == "cancelled" {
        fmt.Fprintf(c.Response(), "event: done\ndata: {\"status\":\"%s\"}\n\n", deployment.Status)
        c.Response().Flush()
        return nil
    }

    // Subscribe to live events
    events, unsubscribe := h.sseHub.Subscribe(deploymentID)
    defer unsubscribe()

    flusher := c.Response()

    for {
        select {
        case <-c.Request().Context().Done():
            return nil
        case event, ok := <-events:
            if !ok {
                return nil
            }
            fmt.Fprintf(flusher, "id: %d\nevent: %s\ndata: %s\n\n", event.ID, event.Type, event.Data)
            flusher.Flush()

            // Close connection after done event
            if event.Type == worker.SSEEventDone {
                return nil
            }
        }
    }
}

// POST /api/v1/deployments/:id/cancel
func (h *DeploymentHandler) CancelDeploy(c echo.Context) error {
    id := c.Param("id")
    deployment, err := h.service.CancelDeployment(c.Request().Context(), id)
    if err != nil {
        return echo.NewHTTPError(http.StatusBadRequest, err.Error())
    }
    return c.JSON(http.StatusOK, dto.DeploymentResponse{Deployment: toDeploymentDTO(deployment)})
}

// POST /api/v1/projects/:id/redeploy
func (h *DeploymentHandler) Redeploy(c echo.Context) error {
    projectID := c.Param("id")
    deployment, err := h.service.Redeploy(c.Request().Context(), projectID)
    if err != nil {
        return echo.NewHTTPError(http.StatusBadRequest, err.Error())
    }
    return c.JSON(http.StatusAccepted, dto.DeploymentResponse{Deployment: toDeploymentDTO(deployment)})
}

// POST /api/v1/projects/:id/rollback
func (h *DeploymentHandler) Rollback(c echo.Context) error {
    projectID := c.Param("id")
    var req dto.RollbackRequest
    if err := c.Bind(&req); err != nil {
        return echo.NewHTTPError(http.StatusBadRequest, "invalid request body")
    }
    deployment, err := h.service.Rollback(c.Request().Context(), projectID, req.DeploymentID)
    if err != nil {
        return echo.NewHTTPError(http.StatusBadRequest, err.Error())
    }
    return c.JSON(http.StatusOK, dto.DeploymentResponse{Deployment: toDeploymentDTO(deployment)})
}

// POST /api/v1/projects/:id/promote/:deploymentId
func (h *DeploymentHandler) Promote(c echo.Context) error {
    projectID := c.Param("id")
    deploymentID := c.Param("deploymentId")
    deployment, err := h.service.Promote(c.Request().Context(), projectID, deploymentID)
    if err != nil {
        return echo.NewHTTPError(http.StatusBadRequest, err.Error())
    }
    return c.JSON(http.StatusOK, dto.DeploymentResponse{Deployment: toDeploymentDTO(deployment)})
}
```

### Route Registration

Add to the existing route setup (e.g., `internal/api/routes/routes.go`):

```go
// Deployment routes
deployHandler := handlers.NewDeploymentHandler(deploymentService, sseHub, cfg.Build.LogBaseDir)

// Project-scoped
projects := api.Group("/projects/:id", authMiddleware)
projects.POST("/deployments", deployHandler.TriggerDeploy)
projects.GET("/deployments", deployHandler.ListDeployments)
projects.POST("/redeploy", deployHandler.Redeploy)
projects.POST("/rollback", deployHandler.Rollback)
projects.POST("/promote/:deploymentId", deployHandler.Promote)

// Deployment-scoped
deployments := api.Group("/deployments/:id", authMiddleware)
deployments.GET("", deployHandler.GetDeployment)
deployments.GET("/logs", deployHandler.GetLogs)
deployments.GET("/logs/stream", deployHandler.StreamLogs) // SSE — no auth middleware on this? See note below.
deployments.POST("/cancel", deployHandler.CancelDeploy)
```

**Auth note for SSE**: The SSE endpoint needs authentication. Since SSE doesn't support custom headers in the browser's `EventSource` API, authentication for `/logs/stream` uses a query parameter token: `?token=<access_token>`. The auth middleware should check both the `Authorization` header and the `token` query parameter.

---

## 13. DTOs

### File: `internal/dto/deployment.go`

```go
package dto

import "time"

// --- Requests ---

type TriggerDeployRequest struct {
    Branch        string `json:"branch" validate:"required"`
    CommitSHA     string `json:"commit_sha" validate:"required"`
    CommitMessage string `json:"commit_message,omitempty"`
    CommitAuthor  string `json:"commit_author,omitempty"`
}

type RollbackRequest struct {
    DeploymentID string `json:"deployment_id" validate:"required"`
}

// --- Responses ---

type DeploymentDTO struct {
    ID                string     `json:"id"`
    ProjectID         string     `json:"project_id"`
    CommitSHA         string     `json:"commit_sha"`
    CommitMessage     string     `json:"commit_message,omitempty"`
    CommitAuthor      string     `json:"commit_author,omitempty"`
    Branch            string     `json:"branch"`
    Status            string     `json:"status"`
    IsProduction      bool       `json:"is_production"`
    DeploymentURL     string     `json:"deployment_url,omitempty"`
    ArtifactSizeBytes int64      `json:"artifact_size_bytes,omitempty"`
    ErrorMessage      string     `json:"error_message,omitempty"`
    IsRollback        bool       `json:"is_rollback"`
    RollbackSourceID  *string    `json:"rollback_source_id,omitempty"`
    GithubPRNumber    *int       `json:"github_pr_number,omitempty"`
    BuildDurationMs   int        `json:"build_duration_ms,omitempty"`
    StartedAt         *time.Time `json:"started_at,omitempty"`
    CompletedAt       *time.Time `json:"completed_at,omitempty"`
    CreatedAt         time.Time  `json:"created_at"`
}

type DeploymentResponse struct {
    Deployment DeploymentDTO `json:"deployment"`
}

type DeploymentListResponse struct {
    Deployments []DeploymentDTO `json:"deployments"`
    Pagination  Pagination      `json:"pagination"`
}

type LogResponse struct {
    Lines      []string `json:"lines"`
    TotalLines int      `json:"total_lines"`
    HasMore    bool     `json:"has_more"`
}

// Pagination is shared across all list responses (already exists from Phase 2).
type Pagination struct {
    Total      int `json:"total"`
    Page       int `json:"page"`
    PerPage    int `json:"per_page"`
    TotalPages int `json:"total_pages"`
}
```

---

## 14. URL Generation

### Rules

| Deployment Type | URL Format | Example |
|---|---|---|
| Production | `{project_slug}.{platform_domain}` | `my-app.hostbox.example.com` |
| Preview (commit) | `{project_slug}-{commit_sha_8}.{platform_domain}` | `my-app-a1b2c3d4.hostbox.example.com` |
| Branch-stable | `{project_slug}-{branch_slug}.{platform_domain}` | `my-app-feat-login.hostbox.example.com` |

### Implementation

The `generateDeploymentURL` function in `internal/worker/util.go` (shown in §9.2) handles this. The `slugify` function sanitizes branch names:

- Lowercase
- Replace non-alphanumeric characters with hyphens
- Collapse consecutive hyphens
- Trim leading/trailing hyphens
- Max 40 characters

---

## 15. Build Caching Strategy

### Cache Volumes

| Volume Name | Contents | Mount Point in Container |
|---|---|---|
| `cache-{project_id}-modules` | `node_modules` | `/app/node_modules` |
| `cache-{project_id}-build` | Framework build caches (`.next/cache`, `.astro`, etc.) | `/app/.build-cache` |

### Cache Invalidation Triggers

| Trigger | Detection | Action |
|---|---|---|
| Lock file hash changed | Compare SHA-256 of lock file with `projects.lock_file_hash` | Remove both cache volumes |
| Node version changed | Compare project's `node_version` with detected version | Remove both cache volumes |
| Package manager changed | Compare project's `detected_package_manager` with detected PM | Remove both cache volumes |
| Manual clear (API) | User clicks "Clear Cache" in dashboard | Remove both cache volumes |
| Project deleted | Cascading cleanup | Remove both cache volumes |

### Cache Flow

```
Build starts
  │
  ├── Read lock file → compute SHA-256
  ├── Compare with projects.lock_file_hash
  │     ├── Same → cache hit → skip invalidation
  │     └── Different → cache miss → docker volume rm both volumes
  │
  ├── Create container with cache volumes mounted
  │     └── If volumes don't exist, Docker creates them empty
  │
  ├── Run install command
  │     └── node_modules written to cache volume
  │
  ├── Run build command
  │     └── Framework cache written to build cache volume
  │
  └── Update projects.lock_file_hash + detected_package_manager
```

---

## 16. Error Handling & Resilience

### 16.1 Error Categories

| Category | Examples | Handling |
|---|---|---|
| **Transient** | Git clone network timeout, Docker API temporary failure | Retry with backoff |
| **User** | Invalid build command, missing output directory, bad package.json | Fail with clear message in build log |
| **System** | Disk full, Docker daemon down, OOM | Fail with system error, log at ERROR level |
| **Cancellation** | User cancelled, deduplication cancelled | Mark as "cancelled", clean up |

### 16.2 Retry Policies

| Operation | Retries | Backoff | Timeout |
|---|---|---|---|
| Git clone | 3 | 5s linear (5s, 10s, 15s) | 120s per attempt |
| Docker image pull | 2 | 10s linear | 300s |
| Docker container create | 1 | None | 30s |
| Docker exec | 0 | None | Governed by build timeout |

### 16.3 Cleanup Guarantees

Every code path through the executor ensures:

1. **Clone directory** is removed (`defer os.RemoveAll(cloneDir)`)
2. **Docker container** is removed (`defer docker.RemoveContainer(containerID)`)
3. **Deployment status** is updated to a terminal state (`ready`, `failed`, or `cancelled`)
4. **Build logger** file is closed (`defer logger.Close()`)
5. **SSE event** is published for `done` (so connected clients know the build finished)
6. **Cancel function** is unregistered from the executor's map

### 16.4 Panic Recovery

The worker goroutine wraps `executor.Execute()` in a recover block:

```go
func (p *Pool) worker(id int) {
    defer p.wg.Done()
    for {
        select {
        case <-p.ctx.Done():
            return
        case deploymentID, ok := <-p.jobs:
            if !ok {
                return
            }
            func() {
                defer func() {
                    if r := recover(); r != nil {
                        slog.Error("worker panic recovered",
                            "worker_id", id,
                            "deployment_id", deploymentID,
                            "panic", r,
                            "stack", string(debug.Stack()),
                        )
                        // Mark deployment as failed
                        p.deployRepo.UpdateStatus(deploymentID, "failed", "Internal error: build worker panic")
                    }
                }()
                p.executor.Execute(p.ctx, deploymentID)
            }()
        }
    }
}
```

---

## 17. Startup Integration

### Changes to `cmd/api/main.go`

Add the following to the startup sequence (after step 3 "Initialize service layer", before step 5 "Start HTTP server"):

```go
// Step 3b: Initialize Docker client
dockerClient, err := docker.NewClient()
if err != nil {
    log.Fatal("failed to initialize Docker client", "err", err)
}

// Step 3c: Initialize SSE hub
sseHub := worker.NewSSEHub()

// Step 3d: Initialize build executor
executor := worker.NewBuildExecutor(
    &cfg.Build,
    dockerClient,
    deploymentRepo,
    projectRepo,
    envVarRepo,
    sseHub,
    cfg.PlatformDomain,
)

// Step 3e: Initialize deployment service
deploymentService := deploysvc.NewService(
    deploymentRepo,
    projectRepo,
    pool,
    executor,
    cfg.PlatformDomain,
)

// Step 4: Initialize and start worker pool
pool := worker.NewPool(
    cfg.Build.MaxConcurrentBuilds,
    cfg.Build.JobChannelBuffer,
    executor,
    deploymentRepo,
    dockerClient,
)
if err := pool.Start(); err != nil {
    log.Fatal("failed to start worker pool", "err", err)
}
```

### Startup Order Dependency Graph

```
Config → SQLite → Repos → Docker Client → SSE Hub → Executor → Pool → Service → HTTP Server
```

---

## 18. Graceful Shutdown Integration

### Changes to shutdown sequence in `cmd/api/main.go`

```go
// Receive shutdown signal
quit := make(chan os.Signal, 1)
signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
<-quit

slog.Info("shutting down...")

// 1. Stop accepting new HTTP connections
shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
defer shutdownCancel()
server.Shutdown(shutdownCtx)

// 2. Shut down worker pool (waits for in-progress builds, with timeout)
pool.Shutdown(time.Duration(cfg.Build.ShutdownTimeoutSec) * time.Second)

// 3. Close Docker client
dockerClient.Close()

// 4. Close SQLite (flush WAL)
db.Close()

slog.Info("shutdown complete")
```

---

## 19. Testing Strategy

### 19.1 Unit Tests (no Docker required)

| Test File | What It Tests | Key Cases |
|---|---|---|
| `detect/framework_test.go` | Framework detection | Each framework (9 cases), missing package.json, malformed JSON, monorepo root_dir, project overrides |
| `detect/packagemanager_test.go` | PM detection | Each lock file (4 cases), no lock file (npm fallback), lock file hash computation |
| `worker/sse_test.go` | SSE hub pub/sub | Subscribe/unsubscribe, publish to multiple subscribers, slow client drop, cleanup |
| `worker/logger_test.go` | Build logger | File write, size limit truncation, StreamWriter line buffering |
| `worker/util_test.go` | URL generation, slugify | Production URL, preview URL, branch slugification edge cases |
| `services/deployment/service_test.go` | Deployment service | Trigger, cancel, dedup, rollback, promote (with mocked repos and pool) |

### 19.2 Integration Tests (require Docker)

| Test | What It Tests | Setup |
|---|---|---|
| `worker/executor_integration_test.go` | Full build pipeline | Uses a real Docker daemon, builds a minimal Vite project from a fixture directory. Verifies: container created, install runs, build runs, output copied, deployment status updated, container cleaned up |
| `worker/pool_integration_test.go` | Pool lifecycle | Crash recovery (pre-populate DB with "building" deployments), enqueue/dequeue, graceful shutdown |

### 19.3 Test Fixtures

```
testdata/
├── vite-project/
│   ├── package.json          {"dependencies": {}, "devDependencies": {"vite": "^5.0.0"}}
│   ├── package-lock.json
│   ├── index.html
│   ├── vite.config.js
│   └── src/
│       └── main.js
├── nextjs-project/
│   ├── package.json          {"dependencies": {"next": "^14.0.0", "react": "^18.0.0"}}
│   └── ...
├── static-project/
│   └── index.html
├── hugo-project/
│   └── hugo.toml
├── no-framework/
│   └── package.json          {"dependencies": {}}
└── monorepo/
    ├── package.json
    └── apps/
        └── web/
            ├── package.json  {"devDependencies": {"vite": "^5.0.0"}}
            └── ...
```

### 19.4 Running Tests

```bash
# Unit tests only (fast, no Docker)
go test ./internal/platform/detect/... ./internal/worker/... ./internal/services/deployment/... -short

# Integration tests (requires Docker)
go test ./internal/worker/... -run Integration -v

# All tests
go test ./...
```

### 19.5 Mock Interfaces

```go
// File: internal/platform/docker/mock_test.go

type MockDockerClient struct {
    CreateBuildContainerFn func(ctx context.Context, opts BuildContainerOpts) (string, error)
    ExecCommandFn          func(ctx context.Context, containerID string, cmd string, stdout, stderr io.Writer) error
    StopContainerFn        func(ctx context.Context, containerID string, gracePeriod time.Duration) error
    RemoveContainerFn      func(ctx context.Context, nameOrID string) error
    CopyFromContainerFn    func(ctx context.Context, containerID, srcPath, destPath string) (int64, error)
    // ... etc
}

func (m *MockDockerClient) CreateBuildContainer(ctx context.Context, opts BuildContainerOpts) (string, error) {
    if m.CreateBuildContainerFn != nil {
        return m.CreateBuildContainerFn(ctx, opts)
    }
    return "mock-container-id", nil
}
// ... implement all interface methods
```

---

## 20. Implementation Order

Each step builds on the previous. Check off when done.

### Step 1: Foundation (Day 1)
- [ ] Add Docker SDK dependency to `go.mod`
- [ ] Create database migration `003_deployments_cache.sql`
- [ ] Add `BuildConfig` to `internal/config/config.go`
- [ ] Update `.env.example`

### Step 2: Detection Engine (Day 2)
- [ ] Implement `internal/platform/detect/framework.go`
- [ ] Implement `internal/platform/detect/packagemanager.go`
- [ ] Write unit tests for both
- [ ] Create test fixtures under `testdata/`

### Step 3: Docker Client (Day 3)
- [ ] Implement `internal/platform/docker/interface.go`
- [ ] Implement `internal/platform/docker/docker.go`
- [ ] Test Docker client manually (create container, exec, copy, remove)

### Step 4: Build Logger + SSE Hub (Day 4)
- [ ] Implement `internal/worker/sse.go`
- [ ] Implement `internal/worker/logger.go`
- [ ] Implement `internal/worker/util.go`
- [ ] Write unit tests for all three

### Step 5: Build Executor (Days 5–6)
- [ ] Implement `internal/worker/executor.go` (all 6 steps)
- [ ] Implement `PostBuildHook` interface + noop stub
- [ ] Write integration test with real Docker

### Step 6: Worker Pool (Day 7)
- [ ] Implement `internal/worker/pool.go`
- [ ] Test crash recovery
- [ ] Test graceful shutdown
- [ ] Test dequeue and build execution

### Step 7: Deployment Service (Day 8)
- [ ] Implement `internal/services/deployment/service.go`
- [ ] Implement `internal/services/deployment/types.go`
- [ ] Implement deduplication logic
- [ ] Implement rollback, promote, redeploy
- [ ] Write unit tests with mocked repos

### Step 8: Repository Extensions (Day 8)
- [ ] Add `FindByStatus(status string) ([]models.Deployment, error)`
- [ ] Add `FindQueuedOrBuilding(projectID, branch string) (*models.Deployment, error)`
- [ ] Add `FindLatestReady(projectID string, production bool) (*models.Deployment, error)`
- [ ] Add `UpdateBuildMeta(projectID, pkgManager, lockHash string) error` to project repo
- [ ] Add `GetDecryptedForBuild(projectID, scope string) ([]DecryptedEnvVar, error)` to env var repo

### Step 9: API Handlers + DTOs (Day 9)
- [ ] Implement `internal/dto/deployment.go`
- [ ] Implement `internal/api/handlers/deployment.go`
- [ ] Register routes in router
- [ ] Test all 8 endpoints with curl

### Step 10: Startup + Shutdown Integration (Day 10)
- [ ] Wire up Docker client, SSE hub, executor, pool, service in `main.go`
- [ ] Integrate graceful shutdown
- [ ] End-to-end test: trigger deploy → watch SSE → verify artifacts

### Step 11: Polish (Days 11–12)
- [ ] Run full test suite
- [ ] Test cancellation (cancel during clone, during build)
- [ ] Test deduplication (rapid pushes to same branch)
- [ ] Test rollback + promote + redeploy
- [ ] Test cache invalidation (change lock file, change node version)
- [ ] Verify orphaned container cleanup on restart
- [ ] Load test: queue 10 deployments with 1 worker, verify FIFO ordering

---

## 21. Acceptance Criteria

Phase 3 is complete when ALL of the following are true:

### Functional
- [ ] `POST /api/v1/projects/:id/deployments` creates a deployment and starts a build
- [ ] Build clones the repo, detects the framework, and produces static output
- [ ] Build output is available at `/app/deployments/{project_id}/{deployment_id}/`
- [ ] `GET /api/v1/deployments/:id` returns correct status transitions: `queued → building → ready`
- [ ] `GET /api/v1/deployments/:id/logs` returns the full build log
- [ ] `GET /api/v1/deployments/:id/logs/stream` streams real-time SSE events during a build
- [ ] SSE reconnection works via `Last-Event-ID` header
- [ ] `POST /api/v1/deployments/:id/cancel` stops a building deployment
- [ ] `POST /api/v1/projects/:id/rollback` creates an instant rollback (no rebuild)
- [ ] `POST /api/v1/projects/:id/promote/:deploymentId` promotes preview to production
- [ ] `POST /api/v1/projects/:id/redeploy` re-triggers a production build
- [ ] Rapid pushes to the same branch cancel the previous queued/building deployment

### Build Container
- [ ] Container uses `node:{version}-slim` image
- [ ] Memory, CPU, PID limits are enforced
- [ ] Container is read-only rootfs with tmpfs `/tmp`
- [ ] `--cap-drop=ALL` and `--security-opt=no-new-privileges` are applied
- [ ] Container is cleaned up after build (success or failure)
- [ ] Clone directory is cleaned up after build

### Cache
- [ ] `node_modules` cache persists across builds for the same project
- [ ] Cache is invalidated when lock file hash changes
- [ ] Cache is invalidated when Node version changes
- [ ] Cache is invalidated when package manager changes

### Resilience
- [ ] On startup, "building" deployments are marked as "failed" (crash recovery)
- [ ] On startup, orphaned Docker containers are cleaned up
- [ ] On startup, "queued" deployments are re-enqueued
- [ ] Graceful shutdown waits up to 60s for in-progress builds
- [ ] After shutdown timeout, Docker containers are force-killed
- [ ] Build timeout (15 min default) kills the container and fails the deployment

### Detection
- [ ] All 9 frameworks are correctly detected from package.json
- [ ] All 4 package managers are detected from lock files
- [ ] Node version is detected from `engines.node`
- [ ] Project-level overrides take priority over auto-detection
- [ ] Monorepo `root_directory` is respected

### Tests
- [ ] All unit tests pass
- [ ] Integration tests pass with Docker
- [ ] No regressions in Phase 1/2 tests
