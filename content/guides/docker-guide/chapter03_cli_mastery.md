# Chapter 3 — Docker CLI Mastery

---

## Table of Contents

1. [The Commands You'll Use Every Day](#1-the-commands-youll-use-every-day)
2. [Building Images — `docker build`](#2-building-images--docker-build)
3. [Running Containers — `docker run`](#3-running-containers--docker-run)
4. [Inspecting Running Containers](#4-inspecting-running-containers)
5. [Managing Images](#5-managing-images)
6. [Stopping, Killing, and Removing](#6-stopping-killing-and-removing)
7. [Pushing and Pulling Images](#7-pushing-and-pulling-images)
8. [Debugging a Running Container](#8-debugging-a-running-container)
9. [Debugging a Container That Won't Start](#9-debugging-a-container-that-wont-start)
10. [Reading Logs Effectively](#10-reading-logs-effectively)
11. [Copying Files In and Out of Containers](#11-copying-files-in-and-out-of-containers)
12. [Running One-Off Commands](#12-running-one-off-commands)
13. [System Cleanup](#13-system-cleanup)
14. [Platform Operator's Cheatsheet](#14-platform-operators-cheatsheet)

---

## 1. The Commands You'll Use Every Day

Docker has dozens of commands, but you'll use about 15 of them 95% of the time. Here they are grouped by function:

```
BUILD & SHIP          RUN & MANAGE          DEBUG & INSPECT
─────────────         ──────────────        ───────────────
docker build          docker run            docker logs
docker tag            docker ps             docker exec
docker push           docker stop           docker inspect
docker pull           docker rm             docker stats
docker images         docker restart        docker top
docker rmi            docker compose up     docker cp
docker system prune   docker compose down   docker events
```

We'll go through every one in depth.

---

## 2. Building Images — `docker build`

### Basic Build

```bash
docker build -t myapp:v1 .
```

- `-t myapp:v1` — Tag the image with name `myapp` and tag `v1`.
- `.` — Build context: the current directory. All files here (minus `.dockerignore` exclusions) are sent to the daemon.

### Important Flags

```bash
docker build \
  -t myapp:v1 \                          # Name and tag
  -t myapp:latest \                      # You can apply multiple tags at once
  -f deploy/Dockerfile \                 # Use a Dockerfile at a different path
  --build-arg NODE_VERSION=20 \          # Pass build arguments (ARG in Dockerfile)
  --no-cache \                           # Force rebuild all layers (ignore cache)
  --target builder \                     # Only build up to a specific stage (multi-stage)
  --platform linux/amd64 \              # Build for a specific platform (useful on Mac M1/M2)
  .
```

### Tagging Strategy for Our Platform

Every build in our deploy pipeline will use the git commit SHA as the tag:

```bash
GIT_SHA=$(git rev-parse --short HEAD)
docker build -t apps/myapp:${GIT_SHA} .
```

This gives us:
- **Immutable tags:** `apps/myapp:a1b2c3d` always refers to the same build.
- **Traceability:** Given a running container, you know exactly what commit it's running.
- **Rollback:** To roll back, just start a container from the previous SHA tag.

### Build Output

By default, Docker uses BuildKit which shows a compact progress view. To see the full output (useful for debugging build failures):

```bash
docker build --progress=plain -t myapp:v1 .
```

To see build timing per step:

```bash
DOCKER_BUILDKIT=1 docker build -t myapp:v1 .
# Each step shows elapsed time in the BuildKit output
```

### Build Context Tips

```bash
# Build with a specific directory as context (not the current directory)
docker build -t myapp:v1 ./app

# Build from stdin (no build context — useful for simple images)
echo "FROM alpine" | docker build -t minimal -

# See what's being sent as build context
# If this is slow, your .dockerignore is missing something
docker build -t myapp:v1 . 2>&1 | head -5
# => Sending build context to Docker daemon  52.4MB
# 52MB?! Check your .dockerignore.
```

---

## 3. Running Containers — `docker run`

`docker run` is the command you'll type most often. It creates and starts a container from an image.

### The Full Anatomy

```bash
docker run [OPTIONS] IMAGE [COMMAND] [ARGS...]
```

### Every Important Flag

#### Detached Mode (`-d`)

```bash
# Foreground (attached): you see output, Ctrl+C stops it
docker run myapp:v1

# Background (detached): runs in background, returns container ID
docker run -d myapp:v1
# => a1b2c3d4e5f6...
```

Production containers always run detached. You use `docker logs` to see their output.

#### Port Mapping (`-p`)

```bash
docker run -d -p 8080:3000 myapp:v1
#              ─────┬─────
#              host:container
```

This maps port 8080 on the host (your VM) to port 3000 inside the container. Traffic hitting `http://your-vm-ip:8080` reaches the container's port 3000.

```bash
# Multiple port mappings
docker run -d -p 8080:3000 -p 8443:3443 myapp:v1

# Bind to a specific host interface (default is 0.0.0.0 = all interfaces)
docker run -d -p 127.0.0.1:8080:3000 myapp:v1
# Only accessible from the VM itself, not from the internet

# Random host port (Docker picks one)
docker run -d -p 3000 myapp:v1
docker port <container_id>  # See what port was assigned
```

**For our platform:** We won't expose individual app ports to the host. Instead, all apps will be on a Docker network, and Caddy (reverse proxy) will route traffic to them internally. Caddy is the only container with ports mapped to the host (80 and 443).

#### Volume Mounts (`-v` / `--mount`)

```bash
# Named volume (Docker manages the storage location)
docker run -d -v pgdata:/var/lib/postgresql/data postgres:16

# Bind mount (map a host directory into the container)
docker run -d -v /host/path/config.yml:/app/config.yml:ro myapp:v1
#                                                      ^^
#                                                      Read-only mount
```

Covered in detail in Chapter 5.

#### Environment Variables (`-e` / `--env-file`)

```bash
# Set individual variables
docker run -d \
  -e DATABASE_URL="postgres://user:pass@db:5432/mydb" \
  -e NODE_ENV=production \
  myapp:v1

# Load from a file (one VAR=VALUE per line)
docker run -d --env-file .env myapp:v1
```

**Never put secrets in docker run commands in shell history.** Use `--env-file` or Docker secrets (Swarm) or pass via a secrets manager. For our platform, we'll store per-app environment variables in files on the VM and use `--env-file`.

#### Container Name (`--name`)

```bash
docker run -d --name myapp myapp:v1
```

Without `--name`, Docker generates a random name (like `boring_perlman`). Named containers are easier to manage:

```bash
docker logs myapp       # instead of docker logs a1b2c3d4e5f6
docker stop myapp       # instead of docker stop a1b2c3d4e5f6
docker exec -it myapp sh
```

Container names must be unique. If `myapp` already exists (even stopped), you'll get an error. Remove the old one first (`docker rm myapp`) or use `docker rm -f myapp` to force-remove.

#### Restart Policy (`--restart`)

```bash
docker run -d --restart unless-stopped myapp:v1
```

| Policy | Behavior |
|---|---|
| `no` (default) | Never restart. If the container stops, it stays stopped. |
| `on-failure` | Restart only if the container exits with a non-zero exit code. |
| `on-failure:5` | Restart on failure, maximum 5 attempts. |
| `always` | Always restart, even if the container was manually stopped. Also restarts on VM reboot. |
| `unless-stopped` | Like `always`, but if you manually `docker stop` it, it stays stopped even after VM reboot. |

**For our platform:** App containers use `unless-stopped`. Infrastructure containers (Caddy, Prometheus, Grafana) use `always`.

#### Network (`--network`)

```bash
docker run -d --network mynetwork myapp:v1
```

Connects the container to a specific Docker network. Containers on the same network can reach each other by container name. Covered in depth in Chapter 4.

#### Resource Limits (`--memory`, `--cpus`)

```bash
docker run -d \
  --memory 512m \            # Hard memory limit: 512MB (OOM-killed if exceeded)
  --memory-reservation 256m \ # Soft limit: Docker tries to keep it under 256MB
  --cpus 0.5 \              # Limit to half a CPU core
  myapp:v1
```

**For our platform:** Every app container gets resource limits to prevent one app from starving others. Covered in Chapter 10.

#### Auto-Remove (`--rm`)

```bash
docker run --rm myapp:v1 node migrate.js
```

The container is automatically removed when it stops. Perfect for one-off tasks (migrations, scripts, etc.) where you don't want to accumulate stopped containers.

#### All Options Together — A Real Example

```bash
docker run -d \
  --name myapp-production \
  --network platform \
  --restart unless-stopped \
  --memory 512m \
  --cpus 1.0 \
  --env-file /opt/platform/apps/myapp/.env \
  -l app=myapp \
  -l deploy.sha=a1b2c3d \
  myapp:a1b2c3d
```

This is what our deploy service will execute for each app. No host ports (Caddy handles routing), resource limits, restart policy, environment from a file, labels for identification.

---

## 4. Inspecting Running Containers

### List Running Containers (`docker ps`)

```bash
docker ps
# CONTAINER ID   IMAGE          COMMAND       CREATED        STATUS        PORTS                  NAMES
# a1b2c3d4e5f6   myapp:v1       "node ..."    2 hours ago    Up 2 hours    0.0.0.0:8080->3000     myapp

# Include stopped containers
docker ps -a

# Compact format — just names and status
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}"

# Filter by label
docker ps --filter "label=app=myapp"

# Only show container IDs (useful for scripting)
docker ps -q

# Count running containers
docker ps -q | wc -l
```

### Container Details (`docker inspect`)

`docker inspect` dumps the full JSON configuration of a container (or image, network, volume — anything Docker manages):

```bash
docker inspect myapp
```

This outputs hundreds of lines of JSON. Usually you want specific fields:

```bash
# Get the container's IP address
docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' myapp

# Get the restart count
docker inspect -f '{{.RestartCount}}' myapp

# Get environment variables
docker inspect -f '{{.Config.Env}}' myapp

# Get the image SHA the container is running
docker inspect -f '{{.Image}}' myapp

# Get mounted volumes
docker inspect -f '{{json .Mounts}}' myapp | python3 -m json.tool
```

### Live Resource Usage (`docker stats`)

```bash
docker stats
# CONTAINER ID   NAME    CPU %   MEM USAGE / LIMIT   MEM %   NET I/O        BLOCK I/O
# a1b2c3d4e5f6   myapp   0.50%   45.2MiB / 512MiB    8.83%   1.2kB / 648B   0B / 0B

# Stats for specific containers
docker stats myapp postgres redis

# One-shot (not streaming)
docker stats --no-stream
```

**For our platform:** `docker stats` is useful for quick checks, but for dashboards we'll use cAdvisor + Prometheus (Chapter 9).

### Processes Inside a Container (`docker top`)

```bash
docker top myapp
# UID     PID     PPID    C    STIME   TTY   TIME     CMD
# 1000    12345   12300   0    10:30   ?     00:00:05 node dist/server.js
```

Shows the processes running inside the container as seen from the host. Useful for checking if your app is actually running and what child processes it spawned.

---

## 5. Managing Images

### List Local Images

```bash
docker images
# REPOSITORY   TAG        IMAGE ID       CREATED         SIZE
# myapp        v1         abc123def456   5 minutes ago   152MB
# myapp        v2         789ghi012345   2 minutes ago   148MB
# node         20-alpine  aaa111bbb222   2 weeks ago     130MB

# Filter by name
docker images myapp

# Show all images including intermediate layers
docker images -a

# Dangling images (untagged, leftover from builds)
docker images --filter "dangling=true"
```

### Remove Images

```bash
# Remove a specific image
docker rmi myapp:v1

# Remove by image ID
docker rmi abc123def456

# Force remove (even if a container is using it)
docker rmi -f myapp:v1

# Remove all dangling images
docker image prune

# Remove ALL unused images (not just dangling)
docker image prune -a
# WARNING: This removes every image not used by a running container
```

### Tag Images

```bash
# Add a new tag to an existing image
docker tag myapp:v1 myapp:latest
docker tag myapp:v1 myregistry.com/myapp:v1

# The image is the same (same ID) — you're just adding a name alias
```

---

## 6. Stopping, Killing, and Removing

### Graceful Stop (`docker stop`)

```bash
docker stop myapp
```

Sends `SIGTERM` to the container's PID 1 process. Waits 10 seconds (configurable) for the process to exit. If it doesn't exit in time, sends `SIGKILL`.

```bash
# Custom timeout (30 seconds for graceful shutdown)
docker stop -t 30 myapp

# Stop all running containers
docker stop $(docker ps -q)
```

**Your application must handle SIGTERM.** In Node.js:

```javascript
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    process.exit(0);
  });
});
```

In Go, use `signal.NotifyContext` or `signal.Notify`.

### Force Kill (`docker kill`)

```bash
docker kill myapp
```

Sends `SIGKILL` immediately. No grace period. The process is killed instantly. Use this when `docker stop` doesn't work (stuck process).

```bash
# Send a different signal
docker kill --signal=SIGUSR1 myapp
```

### Remove Containers (`docker rm`)

```bash
# Remove a stopped container
docker rm myapp

# Force remove (stops and removes a running container)
docker rm -f myapp

# Remove all stopped containers
docker container prune

# Nuclear option: stop and remove ALL containers
docker rm -f $(docker ps -aq)
```

### The Stop-Remove Pattern

The most common sequence in our deploy pipeline:

```bash
# Stop the old container
docker stop myapp-old 2>/dev/null || true
# Remove it
docker rm myapp-old 2>/dev/null || true
# Start the new one
docker run -d --name myapp ...
```

The `2>/dev/null || true` prevents errors if the container doesn't exist (first deploy).

---

## 7. Pushing and Pulling Images

### Pull an Image

```bash
docker pull node:20-alpine
docker pull postgres:16-alpine
docker pull ghcr.io/yourusername/myapp:v1
```

Most pulls happen implicitly — `docker run` pulls automatically if the image isn't local. Explicit `docker pull` is used to pre-cache images or to update a mutable tag.

### Push an Image

```bash
# First, tag the image with the registry path
docker tag myapp:v1 ghcr.io/yourusername/myapp:v1

# Login to the registry
docker login ghcr.io -u yourusername

# Push
docker push ghcr.io/yourusername/myapp:v1
```

**Push only sends layers the registry doesn't already have.** First push: slow (uploading base layers). Subsequent pushes: fast (only your code layer changed).

### For Our Platform

Since we build and run on the same VM, we don't need to push/pull. The image is built locally and run locally. We keep old images around for rollback:

```bash
# List all versions of an app
docker images apps/myapp
# REPOSITORY    TAG       SIZE
# apps/myapp    a1b2c3d   152MB    ← current
# apps/myapp    d4e5f6g   150MB    ← previous
# apps/myapp    h7i8j9k   155MB    ← two deploys ago
```

---

## 8. Debugging a Running Container

### Get a Shell Inside a Running Container

```bash
docker exec -it myapp sh
#            ││        ^^
#            ││        The command to run (sh, bash, /bin/ash, etc.)
#            │└── -t: allocate a pseudo-TTY
#            └── -i: keep STDIN open (interactive)
```

Once inside, you can:
- Check if config files are correct: `cat /app/config.yml`
- Test network connectivity: `ping db` or `curl http://other-service:8080/health`
- Check running processes: `ps aux`
- Check environment variables: `env`
- Look at filesystem: `ls -la /app`

**Alpine images use `sh` (not `bash`).** If you need bash, install it: `apk add bash` (or use a Debian-based image).

**`scratch`/distroless images have no shell.** You can't exec into them. This is a security feature. To debug, either:
- Use `docker logs` to see output
- Use a sidecar debug container on the same network
- Temporarily switch to an Alpine-based image for debugging

### Run a Command Without a Shell

```bash
# Check if the app can reach the database
docker exec myapp wget -qO- http://db:5432/ || echo "Can't reach db"

# Run a Node.js script
docker exec myapp node scripts/check-health.js

# Check what the app sees as its environment
docker exec myapp env
```

### Run as a Different User

```bash
# Exec as root (even if the container runs as non-root)
docker exec -u root -it myapp sh
```

Useful for installing debug tools temporarily:
```bash
docker exec -u root -it myapp sh -c "apk add curl && curl http://other-service:8080/health"
```

---

## 9. Debugging a Container That Won't Start

This is the most frustrating debugging scenario. The container starts and immediately exits. `docker exec` doesn't work because the container isn't running.

### Step 1: Check the Exit Code

```bash
docker ps -a --filter "name=myapp"
# STATUS: Exited (1) 5 seconds ago
#                 ^
#                 Exit code: 1 = generic error, 137 = OOM killed, 139 = segfault
```

| Exit Code | Meaning |
|---|---|
| 0 | Success (container finished normally) |
| 1 | Generic application error |
| 126 | Command not executable (permission issue) |
| 127 | Command not found (wrong CMD/ENTRYPOINT) |
| 137 | Killed by SIGKILL (OOM kill or `docker kill`) |
| 139 | Segmentation fault |
| 143 | Killed by SIGTERM (docker stop) |

### Step 2: Check the Logs

```bash
docker logs myapp
```

Even if the container exited, its logs are preserved (until you `docker rm` it). This is where you'll see the error message, stack trace, or startup failure.

### Step 3: Override the Command

If the app crashes on startup, bypass it and get a shell:

```bash
# Override CMD to get a shell instead of running the app
docker run -it --entrypoint sh myapp:v1

# Now you're inside the container. You can:
# - Check if files are where they should be
# - Try running the app command manually to see the error
# - Check environment variables
```

`--entrypoint sh` overrides the ENTRYPOINT (if any) with `sh`, and the shell form ignores CMD. This lets you poke around inside the container.

### Step 4: Check the Image

```bash
# See what the image's CMD and ENTRYPOINT are
docker inspect myapp:v1 -f '{{.Config.Cmd}}'
docker inspect myapp:v1 -f '{{.Config.Entrypoint}}'

# See the image's environment variables
docker inspect myapp:v1 -f '{{.Config.Env}}'

# See the image's layers (what was done during build)
docker history myapp:v1
```

### Common Causes of Startup Failure

1. **Wrong CMD path:** `CMD ["node", "server.js"]` but the file is at `dist/server.js`
2. **Missing environment variables:** App requires `DATABASE_URL` but it wasn't set
3. **Permission denied:** App runs as non-root but files are owned by root
4. **Port already in use:** Another container is already using the port
5. **Missing dependency:** A required system library isn't in the image
6. **OOM killed:** Container hit its memory limit during startup

---

## 10. Reading Logs Effectively

### Basic Log Reading

```bash
# All logs since container started
docker logs myapp

# Follow logs in real-time (like tail -f)
docker logs -f myapp

# Last 100 lines
docker logs --tail 100 myapp

# Logs since a specific time
docker logs --since 2024-01-15T10:00:00 myapp
docker logs --since 30m myapp        # Last 30 minutes
docker logs --since 1h myapp         # Last hour

# Show timestamps
docker logs -t myapp
# 2024-01-15T10:30:45.123456789Z  Server started on port 3000

# Combine: follow new logs with timestamps, starting from last 50 lines
docker logs -f -t --tail 50 myapp
```

### Redirect Logs for Analysis

```bash
# Save all logs to a file
docker logs myapp > /tmp/myapp.log 2>&1

# Search logs for errors
docker logs myapp 2>&1 | grep -i error

# Count errors
docker logs myapp 2>&1 | grep -ic error
```

### Log Drivers

By default, Docker captures whatever your container process writes to stdout and stderr. This is the `json-file` log driver. Logs are stored as JSON files on disk.

```bash
# Where are the log files stored?
docker inspect -f '{{.LogPath}}' myapp
# /var/lib/docker/containers/abc123.../abc123...-json.log
```

**Warning:** These log files grow forever by default. On a server running many containers, this can fill up the disk. Configure log rotation:

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
```

Put this in `/etc/docker/daemon.json` and restart Docker. This limits each container to 3 log files of 10MB each (30MB max per container). We'll configure this in Chapter 10.

### Structured Logging

For our platform's observability stack (Chapter 9), structured JSON logs are much easier to query:

```
# Plain text log — hard to parse and search
Server started on port 3000
User john logged in
Error processing request: connection refused

# Structured JSON log — easy to parse, filter, and dashboard
{"level":"info","msg":"Server started","port":3000,"ts":"2024-01-15T10:30:45Z"}
{"level":"info","msg":"User logged in","user":"john","ts":"2024-01-15T10:30:46Z"}
{"level":"error","msg":"Request failed","error":"connection refused","ts":"2024-01-15T10:30:47Z"}
```

Docker doesn't enforce log format — it captures whatever your app prints. Configure your app to output JSON logs in production.

---

## 11. Copying Files In and Out of Containers

### Copy from Container to Host

```bash
# Copy a file
docker cp myapp:/app/config.yml ./config.yml

# Copy a directory
docker cp myapp:/app/logs ./local-logs/

# Copy from a stopped container (works as long as the container exists)
docker cp stopped-container:/app/data ./backup/
```

### Copy from Host to Container

```bash
# Copy a file into a running container
docker cp ./hotfix.js myapp:/app/hotfix.js

# Copy a config file
docker cp ./nginx.conf caddy:/etc/caddy/Caddyfile
```

**When to use this:** Debugging only. In production, never manually copy files into containers. If the container needs a file, it should be in the image (via `COPY` in the Dockerfile) or in a volume. Manual copies are lost when the container is removed.

---

## 12. Running One-Off Commands

Containers aren't just for long-running services. They're also great for running one-off tasks in a controlled environment:

### Database Migrations

```bash
docker run --rm \
  --network platform \
  --env-file /opt/platform/apps/myapp/.env \
  myapp:a1b2c3d \
  node migrate.js
```

This creates a temporary container from the same image as the running app, connects to the same network (so it can reach the database), loads the same environment variables, and runs the migration script. `--rm` ensures the container is cleaned up after.

### Database Shell

```bash
# Connect to a running PostgreSQL container
docker exec -it postgres psql -U myuser -d mydb

# Or run a standalone psql client container
docker run --rm -it \
  --network platform \
  postgres:16 \
  psql -h postgres -U myuser -d mydb
```

### Run a Script in the App's Context

```bash
docker exec myapp node scripts/seed-data.js

# Or in a fresh container (if the running one shouldn't be interrupted)
docker run --rm \
  --network platform \
  --env-file /opt/platform/apps/myapp/.env \
  myapp:a1b2c3d \
  node scripts/seed-data.js
```

### Use a Tool Container

Need to run a tool that's not installed on the host?

```bash
# Use the redis-cli without installing Redis on the host
docker run --rm --network platform redis:7 redis-cli -h redis PING

# Run a curl request from inside the Docker network
docker run --rm --network platform alpine/curl http://myapp:3000/health
```

---

## 13. System Cleanup

Docker accumulates unused data over time: stopped containers, dangling images, unused volumes, build cache. On a server running many apps, this can consume tens of gigabytes.

### See What's Using Space

```bash
docker system df
# TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE
# Images          25        10        4.2GB     2.1GB (50%)
# Containers      15        10        150MB     50MB (33%)
# Local Volumes   8         5         1.2GB     300MB (25%)
# Build Cache     -         -         800MB     800MB
```

### Selective Cleanup

```bash
# Remove stopped containers
docker container prune

# Remove dangling images (untagged build leftovers)
docker image prune

# Remove ALL unused images (not used by any container)
docker image prune -a

# Remove unused volumes (WARNING: this deletes data!)
docker volume prune

# Remove build cache
docker builder prune
```

### Nuclear Cleanup

```bash
# Remove everything unused: containers, images, networks, build cache
docker system prune

# Including volumes (DANGER: deletes persistent data!)
docker system prune --volumes

# Force (no confirmation prompt)
docker system prune -af
```

### Automated Cleanup for Our Platform

We'll set up a cron job to clean up regularly (Chapter 10):

```bash
# Keep the last 3 images per app, remove everything else
# Run daily at 3 AM
0 3 * * * docker image prune -a --filter "until=168h" --force
```

---

## 14. Platform Operator's Cheatsheet

Here's every command you'll use when operating the deployment platform, organized by scenario:

### Deploying an App

```bash
# Build the new image
docker build -t apps/myapp:${GIT_SHA} /opt/platform/apps/myapp/repo

# Stop and remove the old container
docker stop myapp 2>/dev/null; docker rm myapp 2>/dev/null

# Start the new container
docker run -d \
  --name myapp \
  --network platform \
  --restart unless-stopped \
  --memory 512m --cpus 1.0 \
  --env-file /opt/platform/apps/myapp/.env \
  -l app=myapp -l deploy.sha=${GIT_SHA} \
  apps/myapp:${GIT_SHA}
```

### Checking App Status

```bash
# Is it running?
docker ps --filter "name=myapp"

# What's it logging?
docker logs --tail 50 -f myapp

# Resource usage?
docker stats myapp --no-stream

# Full config?
docker inspect myapp
```

### Debugging a Broken App

```bash
# Check why it crashed
docker logs myapp
docker inspect -f '{{.State.ExitCode}}' myapp
docker inspect -f '{{.State.OOMKilled}}' myapp

# Get a shell in the running container
docker exec -it myapp sh

# If it's crashed, start a debug container from the same image
docker run --rm -it --entrypoint sh apps/myapp:${GIT_SHA}
```

### Rolling Back

```bash
# Find the previous image
docker images apps/myapp --format "{{.Tag}}"
# a1b2c3d  ← current (broken)
# d4e5f6g  ← previous (working)

# Roll back
docker stop myapp; docker rm myapp
docker run -d --name myapp \
  --network platform \
  --restart unless-stopped \
  --env-file /opt/platform/apps/myapp/.env \
  apps/myapp:d4e5f6g
```

### Infrastructure Health

```bash
# All running containers
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Image}}"

# Resource usage across all containers
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"

# Disk usage
docker system df

# Events (watch for container restarts, OOM kills, etc.)
docker events --filter "type=container" --since 1h
```

---

## Summary

You now have command-line fluency in Docker. The commands in this chapter break down into:

- **Build:** `docker build` with proper tagging (git SHA), build args, and multi-platform support.
- **Run:** `docker run` with all the flags that matter in production: `-d`, `-p`, `-v`, `-e`, `--name`, `--restart`, `--network`, `--memory`, `--cpus`.
- **Inspect:** `docker ps`, `docker logs`, `docker exec`, `docker inspect`, `docker stats` — the tools for understanding what's happening.
- **Manage:** `docker stop`, `docker rm`, `docker rmi`, `docker system prune` — keeping things clean.
- **Debug:** Override entrypoints, check exit codes, read logs, exec into running containers, copy files.

The operator's cheatsheet at the end is your reference for running the deployment platform day to day.

In Chapter 4, we'll tackle Docker networking — how containers talk to each other, how traffic flows from the internet to the right container, and how to set up the network architecture for our platform.

---

→ next: [chapter04_networking.md](chapter04_networking.md)
