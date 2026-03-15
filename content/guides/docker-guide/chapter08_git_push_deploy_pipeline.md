# Chapter 8 — Building the Git Push → Auto Deploy Pipeline

---

## Table of Contents

1. [How Vercel-Style Git Push Deploys Actually Work](#1-how-vercel-style-git-push-deploys-actually-work)
2. [The Full Flow](#2-the-full-flow)
3. [Setting Up the Webhook Receiver in Go](#3-setting-up-the-webhook-receiver-in-go)
4. [Verifying Webhook Signatures](#4-verifying-webhook-signatures)
5. [Triggering a Build on the VM](#5-triggering-a-build-on-the-vm)
6. [Tagging Images with Git Commit SHA](#6-tagging-images-with-git-commit-sha)
7. [Zero-Downtime Container Swap](#7-zero-downtime-container-swap)
8. [Handling Build Failures — Rollback](#8-handling-build-failures--rollback)
9. [Build Logs — Streaming and Storing](#9-build-logs--streaming-and-storing)
10. [Supporting Multiple Apps](#10-supporting-multiple-apps)
11. [Full Working Example](#11-full-working-example)

---

## 1. How Vercel-Style Git Push Deploys Actually Work

When you push to a GitHub repository connected to Vercel, your app is deployed automatically within seconds. Here's what actually happens behind the scenes — and what we're going to replicate:

1. You run `git push origin main`
2. GitHub receives the push
3. GitHub sends an HTTP POST request (a "webhook") to a configured URL with details about the push (repo, branch, commit SHA, author, etc.)
4. The deployment platform receives this webhook
5. The platform clones/pulls the latest code
6. The platform builds a Docker image from the code
7. The platform stops the old container and starts a new one from the new image
8. The platform updates the reverse proxy to route traffic to the new container
9. Your app is live with the new code

The key insight: **there is no magic.** It's an HTTP webhook triggering a shell script (or in our case, a Go program) that runs `git pull`, `docker build`, `docker run`, and updates Caddy.

---

## 2. The Full Flow

```
Developer
  │
  │ git push origin main
  ▼
GitHub
  │
  │ POST https://deploy.yourdomain.com/webhook/github
  │ Body: { repo, branch, commit SHA, ... }
  │ Header: X-Hub-Signature-256: sha256=abc123...
  ▼
Webhook Receiver (Go service on your VM)
  │
  ├── 1. Verify webhook signature (is this really from GitHub?)
  ├── 2. Parse payload (which repo? which branch? which commit?)
  ├── 3. Look up app config (what's the app name? what port?)
  ├── 4. Pull latest code: git pull in /opt/platform/apps/<name>/repo
  ├── 5. Build image: docker build -t apps/<name>:<sha> .
  ├── 6. Stop old container: docker stop <name>; docker rm <name>
  ├── 7. Start new container: docker run -d --name <name> ...
  ├── 8. Update Caddy: POST /load with updated Caddyfile
  ├── 9. Store build logs
  └── 10. Return deploy status
```

---

## 3. Setting Up the Webhook Receiver in Go

The webhook receiver is a simple HTTP server. It listens for webhook POST requests from GitHub (or GitLab, or any git host) and triggers the deploy pipeline.

### Project Structure

```
webhook-receiver/
├── main.go              # HTTP server, webhook handler
├── deploy.go            # Build and deploy logic
├── caddy.go             # Caddy config management
├── config.go            # App configuration
├── go.mod
├── go.sum
└── Dockerfile
```

### main.go — The HTTP Server

```go
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	cfg := LoadConfig()

	deployer := NewDeployer(cfg)

	mux := http.NewServeMux()
	mux.HandleFunc("POST /webhook/github", deployer.HandleGitHubWebhook)
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})
	mux.HandleFunc("GET /apps", deployer.HandleListApps)
	mux.HandleFunc("GET /apps/{name}/logs", deployer.HandleGetBuildLogs)

	server := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 300 * time.Second, // Long timeout for streaming build logs
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		slog.Info("webhook receiver starting", "port", cfg.Port)
		if err := server.ListenAndServe(); err != http.ErrServerClosed {
			slog.Error("server error", "error", err)
			os.Exit(1)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	slog.Info("shutting down server")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	server.Shutdown(ctx)
}
```

### config.go — App Configuration

Each app registered on the platform has a config entry:

```go
package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

type Config struct {
	Port           string
	WebhookSecret  string
	PlatformDomain string
	AppsDir        string
	CaddyfilePath  string
	CaddyAdminURL  string
	DockerNetwork  string
}

type AppConfig struct {
	Name       string `json:"name"`
	RepoURL    string `json:"repo_url"`
	Branch     string `json:"branch"`
	Port       int    `json:"port"`
	Domain     string `json:"domain,omitempty"`
	EnvFile    string `json:"env_file,omitempty"`
	MemoryMB   int    `json:"memory_mb,omitempty"`
	CPUs       string `json:"cpus,omitempty"`
}

type AppRegistry struct {
	mu   sync.RWMutex
	apps map[string]*AppConfig
	path string
}

func LoadConfig() *Config {
	return &Config{
		Port:           getEnvOrDefault("PORT", "9000"),
		WebhookSecret:  os.Getenv("WEBHOOK_SECRET"),
		PlatformDomain: os.Getenv("PLATFORM_DOMAIN"),
		AppsDir:        getEnvOrDefault("APPS_DIR", "/opt/platform/apps"),
		CaddyfilePath:  getEnvOrDefault("CADDYFILE_PATH", "/opt/platform/caddy/Caddyfile"),
		CaddyAdminURL:  getEnvOrDefault("CADDY_ADMIN_URL", "http://caddy:2019"),
		DockerNetwork:  getEnvOrDefault("DOCKER_NETWORK", "platform"),
	}
}

func NewAppRegistry(path string) *AppRegistry {
	r := &AppRegistry{
		apps: make(map[string]*AppConfig),
		path: path,
	}
	r.load()
	return r
}

func (r *AppRegistry) Get(name string) (*AppConfig, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	app, ok := r.apps[name]
	return app, ok
}

func (r *AppRegistry) Set(app *AppConfig) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.apps[app.Name] = app
	return r.save()
}

func (r *AppRegistry) All() []*AppConfig {
	r.mu.RLock()
	defer r.mu.RUnlock()
	result := make([]*AppConfig, 0, len(r.apps))
	for _, app := range r.apps {
		result = append(result, app)
	}
	return result
}

func (r *AppRegistry) load() {
	data, err := os.ReadFile(r.path)
	if err != nil {
		return
	}
	var apps []*AppConfig
	if err := json.Unmarshal(data, &apps); err != nil {
		return
	}
	for _, app := range apps {
		r.apps[app.Name] = app
	}
}

func (r *AppRegistry) save() error {
	apps := make([]*AppConfig, 0, len(r.apps))
	for _, app := range r.apps {
		apps = append(apps, app)
	}
	data, err := json.MarshalIndent(apps, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(r.path)
	os.MkdirAll(dir, 0750)
	return os.WriteFile(r.path, data, 0640)
}

func getEnvOrDefault(key, defaultVal string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultVal
}
```

---

## 4. Verifying Webhook Signatures

When GitHub sends a webhook, it includes a signature header (`X-Hub-Signature-256`) that proves the request came from GitHub and wasn't tampered with. **Always verify this.**

```go
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
)

type GitHubPushEvent struct {
	Ref        string `json:"ref"`
	After      string `json:"after"`
	Repository struct {
		Name     string `json:"name"`
		FullName string `json:"full_name"`
		CloneURL string `json:"clone_url"`
	} `json:"repository"`
	HeadCommit struct {
		ID      string `json:"id"`
		Message string `json:"message"`
		Author  struct {
			Name string `json:"name"`
		} `json:"author"`
	} `json:"head_commit"`
}

func verifyGitHubSignature(payload []byte, signatureHeader, secret string) bool {
	if secret == "" || signatureHeader == "" {
		return false
	}

	parts := strings.SplitN(signatureHeader, "=", 2)
	if len(parts) != 2 || parts[0] != "sha256" {
		return false
	}

	expectedMAC, err := hex.DecodeString(parts[1])
	if err != nil {
		return false
	}

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(payload)
	actualMAC := mac.Sum(nil)

	return hmac.Equal(expectedMAC, actualMAC)
}

type Deployer struct {
	config   *Config
	registry *AppRegistry
}

func NewDeployer(cfg *Config) *Deployer {
	return &Deployer{
		config:   cfg,
		registry: NewAppRegistry(cfg.AppsDir + "/registry.json"),
	}
}

func (d *Deployer) HandleGitHubWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 10*1024*1024))
	if err != nil {
		http.Error(w, "failed to read body", http.StatusBadRequest)
		return
	}

	sig := r.Header.Get("X-Hub-Signature-256")
	if !verifyGitHubSignature(body, sig, d.config.WebhookSecret) {
		slog.Warn("webhook signature verification failed")
		http.Error(w, "invalid signature", http.StatusUnauthorized)
		return
	}

	var event GitHubPushEvent
	if err := json.Unmarshal(body, &event); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}

	branch := strings.TrimPrefix(event.Ref, "refs/heads/")
	repoName := event.Repository.Name
	commitSHA := event.After[:8]

	app, exists := d.registry.Get(repoName)
	if !exists {
		slog.Info("webhook received for unregistered app", "repo", repoName)
		http.Error(w, "app not registered", http.StatusNotFound)
		return
	}

	if branch != app.Branch {
		slog.Info("ignoring push to non-deploy branch",
			"repo", repoName, "branch", branch, "deploy_branch", app.Branch)
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ignored: not the deploy branch"))
		return
	}

	slog.Info("starting deploy",
		"app", app.Name,
		"commit", commitSHA,
		"author", event.HeadCommit.Author.Name,
		"message", event.HeadCommit.Message,
	)

	go d.Deploy(r.Context(), app, commitSHA)

	w.WriteHeader(http.StatusAccepted)
	fmt.Fprintf(w, "deploy started for %s at %s", app.Name, commitSHA)
}

func (d *Deployer) HandleListApps(w http.ResponseWriter, r *http.Request) {
	apps := d.registry.All()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(apps)
}

func (d *Deployer) HandleGetBuildLogs(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	logPath := fmt.Sprintf("%s/%s/build.log", d.config.AppsDir, name)
	http.ServeFile(w, r, logPath)
}
```

---

## 5. Triggering a Build on the VM

The deploy service runs Docker commands by calling the Docker CLI (or the Docker API). Since the deploy service itself runs in a container, it needs access to the host's Docker daemon.

### deploy.go — Build and Deploy Logic

```go
package main

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type DeployResult struct {
	Success   bool
	ImageTag  string
	Duration  time.Duration
	BuildLog  string
	Error     string
}

func (d *Deployer) Deploy(ctx context.Context, app *AppConfig, commitSHA string) *DeployResult {
	start := time.Now()
	result := &DeployResult{}
	var buildLog strings.Builder

	defer func() {
		result.Duration = time.Since(start)
		result.BuildLog = buildLog.String()

		logPath := filepath.Join(d.config.AppsDir, app.Name, "build.log")
		os.WriteFile(logPath, []byte(result.BuildLog), 0640)

		if result.Success {
			slog.Info("deploy succeeded",
				"app", app.Name, "commit", commitSHA,
				"duration", result.Duration)
		} else {
			slog.Error("deploy failed",
				"app", app.Name, "commit", commitSHA,
				"error", result.Error, "duration", result.Duration)
		}
	}()

	repoDir := filepath.Join(d.config.AppsDir, app.Name, "repo")

	// Step 1: Clone or pull the repository
	buildLog.WriteString("=== Pulling latest code ===\n")
	if err := d.gitPull(ctx, repoDir, app, &buildLog); err != nil {
		result.Error = fmt.Sprintf("git pull failed: %v", err)
		buildLog.WriteString("FAILED: " + result.Error + "\n")
		return result
	}

	// Step 2: Build the Docker image
	imageTag := fmt.Sprintf("apps/%s:%s", app.Name, commitSHA)
	result.ImageTag = imageTag
	buildLog.WriteString("\n=== Building Docker image ===\n")
	buildLog.WriteString(fmt.Sprintf("Image: %s\n", imageTag))

	if err := d.dockerBuild(ctx, repoDir, imageTag, &buildLog); err != nil {
		result.Error = fmt.Sprintf("docker build failed: %v", err)
		buildLog.WriteString("FAILED: " + result.Error + "\n")
		return result
	}

	// Step 3: Stop the old container
	buildLog.WriteString("\n=== Stopping old container ===\n")
	d.dockerStopAndRemove(ctx, app.Name, &buildLog)

	// Step 4: Start the new container
	buildLog.WriteString("\n=== Starting new container ===\n")
	if err := d.dockerRun(ctx, app, imageTag, &buildLog); err != nil {
		result.Error = fmt.Sprintf("docker run failed: %v", err)
		buildLog.WriteString("FAILED: " + result.Error + "\n")

		buildLog.WriteString("\n=== Rolling back to previous image ===\n")
		d.rollback(ctx, app, &buildLog)
		return result
	}

	// Step 5: Update Caddy routing
	buildLog.WriteString("\n=== Updating routing ===\n")
	if err := d.updateCaddyConfig(app); err != nil {
		buildLog.WriteString(fmt.Sprintf("WARNING: Caddy update failed: %v\n", err))
	} else {
		buildLog.WriteString("Routing updated successfully\n")
	}

	// Step 6: Health check
	buildLog.WriteString("\n=== Running health check ===\n")
	if err := d.healthCheck(ctx, app); err != nil {
		result.Error = fmt.Sprintf("health check failed: %v", err)
		buildLog.WriteString("FAILED: " + result.Error + "\n")
		buildLog.WriteString("Rolling back...\n")
		d.dockerStopAndRemove(ctx, app.Name, &buildLog)
		d.rollback(ctx, app, &buildLog)
		return result
	}

	buildLog.WriteString("Health check passed\n")
	buildLog.WriteString(fmt.Sprintf("\n=== Deploy complete in %s ===\n", time.Since(start)))
	result.Success = true
	return result
}

func (d *Deployer) gitPull(ctx context.Context, repoDir string, app *AppConfig, log *strings.Builder) error {
	if _, err := os.Stat(filepath.Join(repoDir, ".git")); os.IsNotExist(err) {
		os.MkdirAll(filepath.Dir(repoDir), 0750)
		return d.runCmd(ctx, "", log, "git", "clone", "--depth", "1",
			"--branch", app.Branch, app.RepoURL, repoDir)
	}

	if err := d.runCmd(ctx, repoDir, log, "git", "fetch", "origin", app.Branch); err != nil {
		return err
	}
	return d.runCmd(ctx, repoDir, log, "git", "reset", "--hard", "origin/"+app.Branch)
}

func (d *Deployer) dockerBuild(ctx context.Context, repoDir, imageTag string, log *strings.Builder) error {
	return d.runCmd(ctx, "", log,
		"docker", "build",
		"--tag", imageTag,
		"--progress", "plain",
		repoDir,
	)
}

func (d *Deployer) dockerStopAndRemove(ctx context.Context, name string, log *strings.Builder) {
	d.runCmd(ctx, "", log, "docker", "stop", name)
	d.runCmd(ctx, "", log, "docker", "rm", name)
}

func (d *Deployer) dockerRun(ctx context.Context, app *AppConfig, imageTag string, log *strings.Builder) error {
	args := []string{
		"docker", "run", "-d",
		"--name", app.Name,
		"--network", d.config.DockerNetwork,
		"--restart", "unless-stopped",
		"--label", "platform=true",
		"--label", fmt.Sprintf("app=%s", app.Name),
	}

	if app.MemoryMB > 0 {
		args = append(args, "--memory", fmt.Sprintf("%dm", app.MemoryMB))
	}
	if app.CPUs != "" {
		args = append(args, "--cpus", app.CPUs)
	}

	envFile := filepath.Join(d.config.AppsDir, app.Name, ".env")
	if _, err := os.Stat(envFile); err == nil {
		args = append(args, "--env-file", envFile)
	}

	args = append(args, imageTag)
	return d.runCmd(ctx, "", log, args...)
}

func (d *Deployer) healthCheck(ctx context.Context, app *AppConfig) error {
	checkCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	url := fmt.Sprintf("http://%s:%d/health", app.Name, app.Port)

	for {
		select {
		case <-checkCtx.Done():
			return fmt.Errorf("health check timed out after 30s")
		default:
			out, err := exec.CommandContext(checkCtx,
				"docker", "exec", app.Name,
				"wget", "-qO-", "--timeout=2", url,
			).CombinedOutput()

			if err == nil && len(out) > 0 {
				return nil
			}
			time.Sleep(2 * time.Second)
		}
	}
}

func (d *Deployer) rollback(ctx context.Context, app *AppConfig, log *strings.Builder) {
	log.WriteString("Looking for previous image...\n")
	out, err := exec.CommandContext(ctx,
		"docker", "images",
		fmt.Sprintf("apps/%s", app.Name),
		"--format", "{{.Tag}}",
		"--filter", "dangling=false",
	).Output()

	if err != nil {
		log.WriteString(fmt.Sprintf("Failed to list images: %v\n", err))
		return
	}

	tags := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(tags) < 2 {
		log.WriteString("No previous image found for rollback\n")
		return
	}

	previousTag := tags[1]
	previousImage := fmt.Sprintf("apps/%s:%s", app.Name, previousTag)
	log.WriteString(fmt.Sprintf("Rolling back to %s\n", previousImage))

	d.dockerStopAndRemove(ctx, app.Name, log)
	d.dockerRun(ctx, app, previousImage, log)
}

func (d *Deployer) runCmd(ctx context.Context, dir string, log *strings.Builder, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	if dir != "" {
		cmd.Dir = dir
	}

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()

	if stdout.Len() > 0 {
		log.WriteString(stdout.String())
	}
	if stderr.Len() > 0 {
		log.WriteString(stderr.String())
	}

	return err
}
```

---

## 6. Tagging Images with Git Commit SHA

Every image we build is tagged with the short git commit SHA:

```
apps/myapp:a1b2c3d    ← Commit a1b2c3d
apps/myapp:e4f5g6h    ← Previous deploy (commit e4f5g6h)
apps/myapp:i7j8k9l    ← Two deploys ago
```

This gives us:

- **Immutability:** `apps/myapp:a1b2c3d` always refers to the same build.
- **Traceability:** `docker inspect myapp` → see the image tag → know exactly what commit is running.
- **Rollback:** To roll back, start the container from the previous tag: `docker run apps/myapp:e4f5g6h`.

### Getting the Commit SHA in the Pipeline

From our deploy code, after `git pull`:

```go
out, _ := exec.Command("git", "-C", repoDir, "rev-parse", "--short", "HEAD").Output()
commitSHA := strings.TrimSpace(string(out))
```

Or from the webhook payload directly:

```go
commitSHA := event.After[:8]  // First 8 chars of the full SHA
```

### Keeping Old Images for Rollback

We keep old images around so we can roll back instantly. A cron job cleans up images older than N deploys:

```bash
# Keep the 5 most recent images per app, remove older ones
for app in $(ls /opt/platform/apps/); do
  docker images "apps/${app}" --format "{{.Tag}}" | tail -n +6 | while read tag; do
    docker rmi "apps/${app}:${tag}" 2>/dev/null
  done
done
```

---

## 7. Zero-Downtime Container Swap

The basic swap is: stop old, start new. There's a brief window where neither is running. For most apps, this is a few hundred milliseconds — acceptable.

### Basic Swap (Simple, Brief Downtime)

```go
func (d *Deployer) swapContainer(ctx context.Context, app *AppConfig, newImage string) error {
    // Stop old
    exec.CommandContext(ctx, "docker", "stop", "-t", "10", app.Name).Run()
    exec.CommandContext(ctx, "docker", "rm", app.Name).Run()

    // Start new
    return d.dockerRun(ctx, app, newImage, &strings.Builder{})
}
```

### Improved Swap (Minimal Downtime)

Use a temporary container name, verify it's healthy, then swap:

```go
func (d *Deployer) zeroDowntimeSwap(ctx context.Context, app *AppConfig, newImage string, log *strings.Builder) error {
    tempName := app.Name + "-new"

    // Start the new container with a temporary name
    tempApp := *app
    tempApp.Name = tempName
    if err := d.dockerRun(ctx, &tempApp, newImage, log); err != nil {
        return fmt.Errorf("failed to start new container: %w", err)
    }

    // Health check the new container
    tempApp.Name = tempName
    if err := d.healthCheck(ctx, &tempApp); err != nil {
        exec.CommandContext(ctx, "docker", "rm", "-f", tempName).Run()
        return fmt.Errorf("new container failed health check: %w", err)
    }

    // New container is healthy — swap
    exec.CommandContext(ctx, "docker", "stop", "-t", "10", app.Name).Run()
    exec.CommandContext(ctx, "docker", "rm", app.Name).Run()
    exec.CommandContext(ctx, "docker", "rename", tempName, app.Name).Run()

    return nil
}
```

With Caddy in front: during the swap, Caddy gets a connection error for a fraction of a second and retries. The user might see a brief delay but not an error.

---

## 8. Handling Build Failures — Rollback

If the build fails or the new container fails its health check, we need to keep the old version running.

### The Rollback Strategy

```
1. Build new image
      ├── Build fails → Log error, stop. Old container is still running. Nothing to roll back.
      └── Build succeeds → Continue

2. Start new container
      ├── Start fails → Old container already stopped? Start previous image.
      └── Start succeeds → Continue

3. Health check new container
      ├── Fails → Stop new container, start previous image.
      └── Passes → Deploy complete.
```

The rollback function (from deploy.go above) finds the previous image tag and starts a container from it:

```go
func (d *Deployer) rollback(ctx context.Context, app *AppConfig, log *strings.Builder) {
    // List all images for this app, sorted newest first
    out, _ := exec.CommandContext(ctx,
        "docker", "images",
        fmt.Sprintf("apps/%s", app.Name),
        "--format", "{{.Tag}}",
    ).Output()

    tags := strings.Split(strings.TrimSpace(string(out)), "\n")
    if len(tags) < 2 {
        log.WriteString("No previous image available for rollback\n")
        return
    }

    // tags[0] is the just-built (failed) image, tags[1] is the previous one
    previousImage := fmt.Sprintf("apps/%s:%s", app.Name, tags[1])
    log.WriteString(fmt.Sprintf("Rolling back to %s\n", previousImage))

    d.dockerStopAndRemove(ctx, app.Name, log)
    d.dockerRun(ctx, app, previousImage, log)
}
```

---

## 9. Build Logs — Streaming and Storing

### Capturing Build Output

Every `docker build` and `docker run` command's output is captured and stored:

```go
func (d *Deployer) runCmd(ctx context.Context, dir string, log *strings.Builder, name string, args ...string) error {
    cmd := exec.CommandContext(ctx, name, args...)
    if dir != "" {
        cmd.Dir = dir
    }
    var stdout, stderr bytes.Buffer
    cmd.Stdout = &stdout
    cmd.Stderr = &stderr

    err := cmd.Run()

    log.WriteString(stdout.String())
    log.WriteString(stderr.String())

    return err
}
```

### Storing Logs

After each deploy, the full build log is saved:

```go
logPath := filepath.Join(d.config.AppsDir, app.Name, "build.log")
os.WriteFile(logPath, []byte(result.BuildLog), 0640)
```

Directory structure after a deploy:

```
/opt/platform/apps/myapp/
├── .env            # Environment variables
├── build.log       # Latest build output
├── registry.json   # App configuration
└── repo/           # Git repository
```

### Viewing Logs

Build logs are accessible via the webhook receiver's HTTP API:

```bash
curl https://deploy.yourdomain.com/apps/myapp/logs
```

And in Chapter 9, we'll pipe these logs to Loki for viewing in Grafana.

---

## 10. Supporting Multiple Apps

Each app is independent:
- Its own git repo
- Its own Dockerfile
- Its own Docker image (`apps/<name>:<sha>`)
- Its own container (named `<name>`)
- Its own subdomain (`<name>.yourdomain.com`)
- Its own environment file (`/opt/platform/apps/<name>/.env`)
- Its own build logs

### Registering a New App

To add a new app to the platform, create its config:

```bash
# Example: Register a new app via a simple API call or config file
curl -X POST https://deploy.yourdomain.com/apps \
  -H "Content-Type: application/json" \
  -d '{
    "name": "myapp",
    "repo_url": "https://github.com/user/myapp.git",
    "branch": "main",
    "port": 3000,
    "memory_mb": 512,
    "cpus": "1.0"
  }'
```

Then set up the GitHub webhook:
1. Go to the repo's Settings → Webhooks
2. Payload URL: `https://deploy.yourdomain.com/webhook/github`
3. Content type: `application/json`
4. Secret: the same `WEBHOOK_SECRET` your platform uses
5. Events: "Just the push event"

### Per-App Isolation

Apps are isolated by:
- **Docker containers:** Each app runs in its own container
- **Docker network:** All on the same network, but each has its own IP
- **Resource limits:** Each app has memory and CPU caps
- **Filesystem:** Each app's data is in its own volume
- **Environment:** Each app has its own `.env` file

Apps CAN talk to each other via the Docker network (they're on the same `platform` network). This is intentional — an app might need to call another app's API. If you need stricter isolation, put apps on separate networks.

---

## 11. Full Working Example

### The Webhook Receiver Dockerfile

```dockerfile
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o webhook-receiver .

FROM alpine:3.19
RUN apk add --no-cache ca-certificates git docker-cli
RUN addgroup -S app && adduser -S app -G app
COPY --from=builder /app/webhook-receiver /usr/local/bin/webhook-receiver
USER app
EXPOSE 9000
CMD ["webhook-receiver"]
```

Note: We install `git` and `docker-cli` in the production image because the webhook receiver needs to run `git pull` and `docker build/run` commands.

### Running the Webhook Receiver

```bash
docker run -d \
  --name webhook-receiver \
  --network platform \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /opt/platform:/opt/platform \
  -e WEBHOOK_SECRET=your-github-webhook-secret \
  -e PLATFORM_DOMAIN=yourdomain.com \
  --restart always \
  webhook-receiver:latest
```

**Security note:** Mounting `/var/run/docker.sock` gives the container full control over Docker on the host. This is necessary (it needs to build and run containers) but powerful. The webhook receiver is a trusted internal service — never expose it directly to the internet without authentication.

### End-to-End: Deploying a Node.js App

1. **Register the app:**
   ```bash
   mkdir -p /opt/platform/apps/todo-app
   cat > /opt/platform/apps/todo-app/.env << 'EOF'
   NODE_ENV=production
   PORT=3000
   DATABASE_URL=postgres://user:pass@postgres:5432/tododb
   EOF
   ```

   Add to registry.json:
   ```json
   [
     {
       "name": "todo-app",
       "repo_url": "https://github.com/youruser/todo-app.git",
       "branch": "main",
       "port": 3000,
       "memory_mb": 256,
       "cpus": "0.5"
     }
   ]
   ```

2. **Set up the GitHub webhook** on the repo (as described in section 10).

3. **Push code:**
   ```bash
   git add . && git commit -m "initial deploy" && git push origin main
   ```

4. **GitHub sends webhook → our receiver catches it → build → deploy → Caddy update.**

5. **App is live at `todo-app.yourdomain.com` with HTTPS.**

6. **Check the deploy:**
   ```bash
   # Container running?
   docker ps --filter "name=todo-app"

   # Build logs?
   curl https://deploy.yourdomain.com/apps/todo-app/logs

   # App responding?
   curl https://todo-app.yourdomain.com/health
   ```

---

## Summary

The git push deploy pipeline is the heart of our platform:

- **Webhook receiver** (Go HTTP server) listens for GitHub push events
- **Signature verification** ensures webhooks are legitimate
- **Git pull → Docker build → Docker run** is the core pipeline
- **Images tagged with commit SHAs** provide immutability and traceability
- **Health checks** verify the new container works before declaring success
- **Automatic rollback** to the previous image if anything fails
- **Caddy route updates** via the admin API make the app accessible
- **Build logs** are captured and accessible via HTTP

Each app is independent: its own repo, its own container, its own subdomain, its own environment variables. The platform handles the orchestration.

In Chapter 9, we'll add observability — logs, metrics, and dashboards — so you can see what's happening across all your deployed apps.

---

→ next: [chapter09_logs_metrics_monitoring.md](chapter09_logs_metrics_monitoring.md)
