# Chapter 2 — Dockerfiles in Depth

---

## Table of Contents

1. [What a Dockerfile Is and How It Becomes an Image](#1-what-a-dockerfile-is-and-how-it-becomes-an-image)
2. [Every Instruction Explained](#2-every-instruction-explained)
3. [CMD vs ENTRYPOINT — The Difference That Matters](#3-cmd-vs-entrypoint--the-difference-that-matters)
4. [ENV vs ARG — Build-Time vs Runtime Variables](#4-env-vs-arg--build-time-vs-runtime-variables)
5. [Layer Caching — How It Works and How to Design for It](#5-layer-caching--how-it-works-and-how-to-design-for-it)
6. [Multi-Stage Builds — The Production Standard](#6-multi-stage-builds--the-production-standard)
7. [Production Dockerfiles for Every Stack](#7-production-dockerfiles-for-every-stack)
8. [.dockerignore — What It Is and Why It Matters](#8-dockerignore--what-it-is-and-why-it-matters)
9. [Image Size Optimization](#9-image-size-optimization)
10. [Security Best Practices](#10-security-best-practices)

---

## 1. What a Dockerfile Is and How It Becomes an Image

A Dockerfile is a plain text file — no special extension, just named `Dockerfile` by convention — that contains a sequence of instructions. Each instruction tells Docker to do something: start from a base image, copy files, run a command, set an environment variable.

When you run `docker build`, Docker reads the Dockerfile from top to bottom and executes each instruction in order. Each instruction produces a new **layer** in the image. The final result — all layers stacked together — is the image.

Here's the simplest possible Dockerfile:

```dockerfile
FROM ubuntu:22.04
CMD ["echo", "hello from Docker"]
```

And here's how you build it:

```bash
docker build -t hello:v1 .
```

Let's break down what happens:

1. Docker reads the Dockerfile in the current directory (`.`).
2. `FROM ubuntu:22.04` — Docker pulls the Ubuntu 22.04 base image (if not already cached locally). This becomes the first layer.
3. `CMD ["echo", "hello from Docker"]` — Docker records metadata: "when this image starts, run this command." This doesn't create a filesystem layer; it adds metadata to the image config.
4. Docker tags the resulting image as `hello:v1`.

Run it:

```bash
docker run hello:v1
# Output: hello from Docker
```

That's the core loop. Everything else is adding power and nuance to this process.

### The Build Context

The `.` at the end of `docker build -t hello:v1 .` is the **build context**. It's the directory whose contents are sent to the Docker daemon for the build. When your Dockerfile says `COPY . /app`, it copies from this context.

The entire build context is sent to the daemon before the build starts. If your project directory is 2GB (because of `node_modules`, `.git`, datasets, etc.), Docker sends all 2GB — making your build slow. This is why `.dockerignore` matters (covered in section 8).

---

## 2. Every Instruction Explained

### FROM — The Starting Point

Every Dockerfile must start with `FROM`. It sets the base image — the foundation your image is built on top of.

```dockerfile
FROM node:20-alpine
```

This says: "start with an image that has Alpine Linux and Node.js 20 pre-installed."

**Choosing a base image matters enormously.** Your options generally fall into:

| Base Image | Size | Use Case |
|---|---|---|
| `ubuntu:22.04` | ~77MB | When you need a full package manager and broad compatibility |
| `debian:bookworm-slim` | ~74MB | Slimmed-down Debian; good default for most things |
| `alpine:3.19` | ~7MB | Minimal Linux; much smaller but uses musl libc instead of glibc |
| `node:20-alpine` | ~130MB | Alpine with Node pre-installed |
| `golang:1.22-alpine` | ~250MB | Alpine with Go pre-installed (used in build stage only) |
| `python:3.12-slim` | ~130MB | Slim Debian with Python pre-installed |
| `scratch` | 0MB | Literally empty; for statically compiled binaries (Go) |
| `gcr.io/distroless/static` | ~2MB | Google's minimal images; no shell, no package manager |

**For our platform:** We'll use Alpine-based images where possible for small size, and `scratch` or distroless for Go services (since Go compiles to a single binary that doesn't need an OS).

**Production vs. tutorials:** Tutorials often use `FROM node:20` (the full Debian-based image, ~1GB). Production uses `FROM node:20-alpine` (~130MB) or multi-stage builds to an even smaller final image. Always use the smallest base image that works.

### RUN — Execute Commands During Build

`RUN` executes a command inside the image and commits the result as a new layer.

```dockerfile
RUN apt-get update && apt-get install -y curl
```

This runs the command inside the container filesystem, installs curl, and saves the result as a layer.

**Critical rule: each RUN creates a layer.** Layers stack and are cached independently. This has two implications:

1. **Combine related commands with `&&`** to avoid unnecessary layers and to ensure cleanup happens in the same layer:

```dockerfile
# BAD: Three layers. The apt cache from the first RUN is baked into that layer forever,
# even though the third RUN tries to clean it up.
RUN apt-get update
RUN apt-get install -y curl
RUN rm -rf /var/lib/apt/lists/*

# GOOD: One layer. Install and cleanup happen in the same layer,
# so the apt cache is never persisted.
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*
```

2. **Order matters for caching.** Put instructions that change less frequently earlier in the Dockerfile (we'll cover this in section 5).

### COPY — Add Files from Build Context to Image

```dockerfile
COPY package.json package-lock.json ./
COPY . .
```

`COPY` takes files from the build context (the directory you passed to `docker build`) and adds them to the image filesystem.

- `COPY package.json package-lock.json ./` — copies those two specific files to the current `WORKDIR` in the image.
- `COPY . .` — copies everything in the build context to the current `WORKDIR`.

**`COPY` always creates a new layer.** This is why you copy dependency files first, install dependencies, then copy source code. If only source code changes, the dependency installation layer is cached. This pattern is so important we'll dedicate a whole section to it.

### ADD — COPY's Older, More Dangerous Sibling

`ADD` does everything `COPY` does, plus:
- Automatically extracts `.tar.gz`, `.tar.bz2`, and similar archives
- Can download files from URLs

```dockerfile
ADD app.tar.gz /app/           # Extracts the archive
ADD https://example.com/file /app/file  # Downloads the file
```

**In practice, always use `COPY` unless you specifically need auto-extraction.** `ADD`'s implicit behavior makes Dockerfiles harder to understand. If you need to download a file, use `RUN curl` or `RUN wget` instead — it's more explicit and gives you control over error handling.

### WORKDIR — Set the Working Directory

```dockerfile
WORKDIR /app
```

Sets the working directory for all subsequent `RUN`, `CMD`, `ENTRYPOINT`, `COPY`, and `ADD` instructions. If the directory doesn't exist, Docker creates it.

```dockerfile
WORKDIR /app
COPY . .          # Copies to /app
RUN npm install   # Runs in /app
CMD ["node", "server.js"]  # Runs in /app
```

**Always use `WORKDIR` instead of `RUN cd /somewhere`.** `cd` only affects the current `RUN` instruction (each `RUN` starts in the `WORKDIR`). `WORKDIR` persists for all subsequent instructions.

```dockerfile
# BAD: cd doesn't persist between RUN instructions
RUN cd /app
RUN npm install   # This runs in /, not /app!

# GOOD: WORKDIR persists
WORKDIR /app
RUN npm install   # This runs in /app
```

### ENV — Set Environment Variables

```dockerfile
ENV NODE_ENV=production
ENV PORT=3000
```

Sets environment variables that persist in the image. They're available during build (in subsequent `RUN` instructions) AND at runtime when a container starts from this image.

```dockerfile
ENV NODE_ENV=production
RUN echo $NODE_ENV    # "production" — available during build
# When the container runs, NODE_ENV is still "production"
```

These can be overridden at runtime:

```bash
docker run -e NODE_ENV=development myapp
```

**Security warning:** `ENV` values are baked into the image and visible to anyone who can `docker inspect` it. Never put secrets (API keys, database passwords) in `ENV`. Pass them at runtime with `-e` or `--env-file`. We'll cover this pattern repeatedly.

### ARG — Build-Time Variables

```dockerfile
ARG NODE_VERSION=20
FROM node:${NODE_VERSION}-alpine

ARG BUILD_DATE
RUN echo "Built on: ${BUILD_DATE}"
```

`ARG` defines variables available only during the build process. They're not present at runtime.

```bash
docker build --build-arg BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ) -t myapp .
```

**Key differences from ENV:**

| | `ARG` | `ENV` |
|---|---|---|
| Available during build | Yes | Yes (after the `ENV` instruction) |
| Available at runtime | No | Yes |
| Visible in `docker inspect` | No (sort of — see below) | Yes |
| Can be set via `--build-arg` | Yes | No (use `-e` at runtime) |
| Scope | From the `ARG` line to end of build stage | From the `ENV` line to runtime |

**Gotcha:** `ARG` values before `FROM` are only available in the `FROM` line itself. After `FROM`, all `ARG`s are cleared. You need to re-declare them in each stage:

```dockerfile
ARG NODE_VERSION=20
FROM node:${NODE_VERSION}-alpine
# NODE_VERSION is NOT available here anymore

ARG NODE_VERSION
# Now it's available again (but needs to be re-declared)
```

**Security warning:** Even though `ARG` values aren't in the final image's environment, they ARE recorded in the image's build history (`docker history`). Never pass secrets via `ARG`. Use Docker BuildKit secrets for that (covered in section 10).

### EXPOSE — Document Which Ports the Container Listens On

```dockerfile
EXPOSE 8080
```

`EXPOSE` does **not** publish the port. It's documentation — it tells humans and tools "this container expects traffic on port 8080." To actually make the port accessible, you use `-p` at runtime:

```bash
docker run -p 8080:8080 myapp    # Now port 8080 is actually accessible
```

**Best practice:** Always include `EXPOSE` for documentation, even though it's not functionally required.

### CMD — The Default Command

```dockerfile
CMD ["node", "server.js"]
```

`CMD` specifies the default command that runs when a container starts. It has two forms:

**Exec form (preferred):**
```dockerfile
CMD ["node", "server.js"]
```
This runs `node server.js` directly as PID 1. Signals (like SIGTERM for graceful shutdown) are delivered directly to the node process.

**Shell form (avoid in production):**
```dockerfile
CMD node server.js
```
This runs `/bin/sh -c "node server.js"`. The shell is PID 1, and node is a child process. SIGTERM goes to the shell, which may not forward it to node. This causes containers to not shut down gracefully (they hang for 10 seconds until Docker kills them).

**Always use exec form in production Dockerfiles.**

`CMD` can be overridden when running a container:

```bash
docker run myapp node script.js    # Overrides CMD
docker run myapp sh                # Get a shell instead
```

### ENTRYPOINT — The Immutable Command

```dockerfile
ENTRYPOINT ["node"]
CMD ["server.js"]
```

`ENTRYPOINT` sets the command that always runs. `CMD` provides default arguments to it. Together:

- `docker run myapp` → runs `node server.js`
- `docker run myapp worker.js` → runs `node worker.js` (CMD is overridden, ENTRYPOINT is not)

This is covered in detail in the next section.

---

## 3. CMD vs ENTRYPOINT — The Difference That Matters

This distinction confuses almost everyone. Here's the mental model:

- **`CMD`** = "here's the default thing to run, but you can replace it"
- **`ENTRYPOINT`** = "this always runs; anything else is appended as arguments"

### When You Have Only CMD

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY . .
CMD ["node", "server.js"]
```

```bash
docker run myapp                    # Runs: node server.js
docker run myapp node worker.js     # Runs: node worker.js (CMD replaced entirely)
docker run myapp sh                 # Runs: sh (CMD replaced entirely)
```

### When You Have ENTRYPOINT + CMD

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY . .
ENTRYPOINT ["node"]
CMD ["server.js"]
```

```bash
docker run myapp                    # Runs: node server.js
docker run myapp worker.js          # Runs: node worker.js (CMD replaced, ENTRYPOINT stays)
docker run myapp sh                 # Runs: node sh (probably not what you wanted)
```

### When You Have Only ENTRYPOINT

```dockerfile
FROM python:3.12-slim
ENTRYPOINT ["python", "-m", "pytest"]
```

```bash
docker run mytests                  # Runs: python -m pytest
docker run mytests tests/unit/      # Runs: python -m pytest tests/unit/
docker run mytests -v --tb=short    # Runs: python -m pytest -v --tb=short
```

### The Entrypoint Script Pattern (Production Standard)

Many production images use an entrypoint script that does setup before running the main command:

```dockerfile
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
```

The entrypoint script:

```bash
#!/bin/sh
set -e

# Run database migrations before starting the app
echo "Running migrations..."
node migrate.js

# Execute the CMD (whatever was passed to docker run, or the default CMD)
exec "$@"
```

The critical line is `exec "$@"`. This replaces the shell process with whatever `CMD` is — so the main application process becomes PID 1 and receives signals correctly.

**For our platform:** Most app containers will use a simple `CMD`. The entrypoint script pattern is useful for apps that need pre-startup tasks (migrations, config generation, etc.).

### Summary Table

| Dockerfile | `docker run myapp` | `docker run myapp foo` |
|---|---|---|
| `CMD ["node", "server.js"]` | `node server.js` | `foo` |
| `ENTRYPOINT ["node"]` | `node` | `node foo` |
| `ENTRYPOINT ["node"]` + `CMD ["server.js"]` | `node server.js` | `node foo` |

**Rule of thumb:** Use `CMD` alone for application containers. Use `ENTRYPOINT` + `CMD` when you want a fixed executable with variable arguments (CLI tools, test runners).

---

## 4. ENV vs ARG — Build-Time vs Runtime Variables

This section digs deeper into the practical implications.

### The Build/Runtime Boundary

```
┌─────────────────────────────────────────────────┐
│                BUILD TIME                        │
│  docker build --build-arg API_URL=...            │
│                                                  │
│  Dockerfile:                                     │
│    ARG API_URL           ← Available here        │
│    ENV APP_ENV=production ← Available here        │
│    RUN echo $API_URL     ← Available here        │
│    RUN echo $APP_ENV     ← Available here        │
│                                                  │
├──────────────── Image created ───────────────────┤
│                                                  │
│                RUNTIME                           │
│  docker run -e DB_HOST=postgres myapp            │
│                                                  │
│    ARG API_URL           ← NOT available         │
│    ENV APP_ENV=production ← Available (baked in)  │
│    -e DB_HOST=postgres   ← Available (injected)  │
│                                                  │
└─────────────────────────────────────────────────┘
```

### When to Use ARG

Use `ARG` for values that only matter during the build and should not be in the final image:

```dockerfile
# Base image version — only needed to select the FROM image
ARG NODE_VERSION=20
FROM node:${NODE_VERSION}-alpine

# Build metadata — useful for labeling images
ARG BUILD_DATE
ARG GIT_SHA
LABEL build.date=${BUILD_DATE} build.sha=${GIT_SHA}

# Build-time feature flags
ARG INSTALL_DEV_DEPS=false
RUN if [ "$INSTALL_DEV_DEPS" = "true" ]; then npm install; else npm ci --omit=dev; fi
```

Build:
```bash
docker build \
  --build-arg BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --build-arg GIT_SHA=$(git rev-parse HEAD) \
  -t myapp:$(git rev-parse --short HEAD) .
```

### When to Use ENV

Use `ENV` for values that the running application needs:

```dockerfile
ENV NODE_ENV=production
ENV PORT=3000
```

But remember: sensitive values (database URLs, API keys, tokens) must NOT go in `ENV`. They should be injected at runtime:

```bash
docker run \
  -e DATABASE_URL="postgres://user:pass@db:5432/mydb" \
  -e API_KEY="sk-..." \
  myapp:v1
```

Or even better, from a file:

```bash
# .env file (NEVER commit this to git)
DATABASE_URL=postgres://user:pass@db:5432/mydb
API_KEY=sk-...

docker run --env-file .env myapp:v1
```

### The Conversion Pattern: ARG to ENV

Sometimes you need a build-time value to also be available at runtime. The pattern:

```dockerfile
ARG APP_VERSION=unknown
ENV APP_VERSION=${APP_VERSION}
```

Now `APP_VERSION` is available both during build and at runtime. Useful for embedding version info in the image.

```bash
docker build --build-arg APP_VERSION=2.3.1 -t myapp:2.3.1 .
docker run myapp:2.3.1 env | grep APP_VERSION
# APP_VERSION=2.3.1
```

---

## 5. Layer Caching — How It Works and How to Design for It

Layer caching is the single most impactful factor in Docker build speed. Understanding it is the difference between 30-second builds and 10-minute builds.

### How Caching Works

When Docker executes each instruction:
1. It computes a cache key based on the instruction itself and its inputs.
2. If a layer with that cache key already exists, Docker reuses it (cache hit).
3. If not, Docker executes the instruction and caches the result (cache miss).

**The critical rule: once a cache miss occurs, all subsequent layers are rebuilt.** The cache is linear. If layer 3 out of 8 changes, layers 3-8 are all rebuilt — even if layers 4-8 haven't changed at all.

```
Layer 1: FROM node:20-alpine          ← Cached ✓
Layer 2: WORKDIR /app                  ← Cached ✓
Layer 3: COPY package.json ./          ← CHANGED (cache miss) ✗
Layer 4: RUN npm install               ← Rebuilt (because layer 3 changed) ✗
Layer 5: COPY . .                      ← Rebuilt ✗
Layer 6: RUN npm run build             ← Rebuilt ✗
```

### Cache Keys for Different Instructions

| Instruction | Cache key based on... |
|---|---|
| `FROM` | The image digest (changes when the base image is updated) |
| `RUN` | The exact command string. Same string = cache hit (even if the command would produce different output) |
| `COPY` / `ADD` | The checksum of all files being copied. If any file changes, cache miss |
| `ENV` / `ARG` / `WORKDIR` | The instruction string and its value |

**The `RUN` cache gotcha:** `RUN apt-get update && apt-get install -y curl` always has the same command string, so Docker reuses the cached layer — even if the apt repositories have new packages. This means your image could have stale packages. To force a refresh, change the command (e.g., add a comment with a date) or use `--no-cache`.

### The Dependency-First Pattern

This is the most important Dockerfile pattern you'll learn. It exploits caching to avoid reinstalling dependencies when only source code changes.

**BAD: Copy everything first, then install**

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY . .                    # Source code changes = cache miss here
RUN npm ci --omit=dev       # Rebuilt every time, even if deps didn't change
CMD ["node", "server.js"]
```

Every time you change any source file, `COPY . .` invalidates the cache, and `npm ci` runs again (which might take 30–60 seconds).

**GOOD: Copy dependency files first, install, then copy source**

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./   # Only changes when deps change
RUN npm ci --omit=dev                    # Cached if package files didn't change
COPY . .                                 # Source code changes only rebuild from here
CMD ["node", "server.js"]
```

Now when you change a source file:
- `COPY package.json package-lock.json ./` → cache hit (files unchanged)
- `RUN npm ci --omit=dev` → cache hit (layer above didn't change)
- `COPY . .` → cache miss (source changed)
- Only the `COPY . .` layer and anything after it rebuilds.

Build goes from 60 seconds to 2 seconds.

**This pattern applies to every language:**

```dockerfile
# Python
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

# Go
COPY go.mod go.sum ./
RUN go mod download
COPY . .

# Rust
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release
COPY . .
RUN cargo build --release
```

### Caching Across Builds on Our Platform

When our deploy platform rebuilds an app on every git push, layer caching is what makes builds fast. The base image layer, the dependency installation layer — these are usually cached. Only the source code layer changes. A rebuild that would take 5 minutes from scratch takes 10 seconds with caching.

This is why we build directly on the VM (instead of in a CI system that starts fresh every time). The VM has the full layer cache from previous builds.

---

## 6. Multi-Stage Builds — The Production Standard

Multi-stage builds are not an optimization. They're the standard way to build production Docker images. If your language has a build step (compilation, bundling, transpilation), you should be using multi-stage builds.

### The Problem Multi-Stage Solves

Without multi-stage:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
CMD ["node", "dist/server.js"]
```

The final image contains:
- The full Node runtime (~130MB)
- ALL npm dependencies, including devDependencies (~200MB+ depending on project)
- Your source code (TypeScript files, tests, configs)
- The build output (dist/)
- The npm cache

Your image might be 500MB or more. Most of it is not needed to run the application.

### How Multi-Stage Builds Work

A multi-stage Dockerfile has multiple `FROM` instructions. Each `FROM` starts a new stage. You can copy files from a previous stage into the current one. Only the final stage becomes the image.

```dockerfile
# ============ Stage 1: Build ============
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci                              # Install ALL deps (including dev)
COPY . .
RUN npm run build                       # Compile TypeScript, bundle, etc.

# ============ Stage 2: Production ============
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev                   # Install only production deps
COPY --from=builder /app/dist ./dist    # Copy ONLY the build output
CMD ["node", "dist/server.js"]
```

What happens:
1. **Stage 1 ("builder"):** Installs all dependencies, compiles the code. This stage is used during the build but is NOT part of the final image.
2. **Stage 2:** Starts fresh from `node:20-alpine`. Installs only production dependencies. Copies only the compiled output from stage 1. This is the final image.

The final image contains only what's needed to run: the Node runtime, production dependencies, and compiled code. No TypeScript compiler, no test frameworks, no source code.

### Go — The Best Case for Multi-Stage

Go compiles to a single static binary. The final image doesn't need Go, doesn't need an OS package manager, doesn't even need glibc. It can run on `scratch` (an empty image):

```dockerfile
# ============ Stage 1: Build ============
FROM golang:1.22-alpine AS builder
WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o server ./cmd/server
#   │              │           │              │
#   │              │           │              └── Strip debug info (smaller binary)
#   │              │           └── Output binary name
#   │              └── Target Linux (in case building on Mac)
#   └── Disable CGO (makes binary fully static — no libc dependency)

# ============ Stage 2: Production ============
FROM scratch
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /app/server /server
EXPOSE 8080
ENTRYPOINT ["/server"]
```

**Result:** The final image is literally just the binary + SSL certificates. Could be 10-15MB for a full web server. Compare that to the 250MB Go build image.

### Why `scratch` Works for Go

`scratch` is a completely empty image. No OS, no shell, no nothing. This means:
- You can't `docker exec -it container sh` into it (no shell)
- You can't install packages
- The binary must be fully statically compiled

If you need a shell for debugging, use `gcr.io/distroless/static` instead (~2MB, includes timezone data and SSL certs but no shell) or `alpine:3.19` (~7MB, includes a shell).

For our deploy platform: we'll use `scratch` for the Go webhook receiver service (maximum security surface reduction). For user-deployed apps, the user chooses their base image in their own Dockerfile.

---

## 7. Production Dockerfiles for Every Stack

These are the Dockerfiles our platform will use to build apps. Each one is fully annotated and production-ready.

### Node.js Backend API

```dockerfile
# ============================================================
# Stage 1: Install dependencies and build
# ============================================================
FROM node:20-alpine AS builder

# Security: run as non-root during build where possible
WORKDIR /app

# Dependency-first pattern: copy only package files first
COPY package.json package-lock.json ./

# npm ci is deterministic (uses lockfile exactly). --ignore-scripts prevents
# malicious postinstall scripts in dependencies from running during build.
RUN npm ci --ignore-scripts

# Copy source code (this layer breaks cache when code changes,
# but the npm ci layer above stays cached)
COPY . .

# Build the project (TypeScript compilation, etc.)
RUN npm run build

# Remove devDependencies to shrink what we copy to the production stage
RUN npm prune --omit=dev

# ============================================================
# Stage 2: Production image
# ============================================================
FROM node:20-alpine

# Security: don't run as root
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy only what's needed to run
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./

# Set production environment
ENV NODE_ENV=production

# Switch to non-root user
USER appuser

EXPOSE 3000

# Use exec form so node receives signals (SIGTERM) directly
CMD ["node", "dist/server.js"]
```

**Size comparison:**
- Without multi-stage: ~400-800MB
- With multi-stage: ~150-200MB

### Node.js Frontend (React/Next.js Static Build)

For a static site (React, Vue, plain HTML) that builds to static files and serves via Nginx:

```dockerfile
# ============================================================
# Stage 1: Build the frontend
# ============================================================
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .

# Build produces static files in /app/dist (or /app/build, /app/out, etc.)
RUN npm run build

# ============================================================
# Stage 2: Serve with Nginx
# ============================================================
FROM nginx:1.25-alpine

# Remove default Nginx config
RUN rm /etc/nginx/conf.d/default.conf

# Add our Nginx config
COPY nginx.conf /etc/nginx/conf.d/app.conf

# Copy the built static files from the builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

# Nginx runs as non-root by default in the official image (worker processes)
CMD ["nginx", "-g", "daemon off;"]
```

The `nginx.conf` for a single-page app (SPA):

```nginx
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;

    # Serve static assets with long cache
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # SPA fallback: serve index.html for all routes
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    # Gzip compression
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml;
    gzip_min_length 256;
}
```

**Size:** ~25-40MB (just Alpine + Nginx + static files).

### Go Service

```dockerfile
# ============================================================
# Stage 1: Build
# ============================================================
FROM golang:1.22-alpine AS builder
WORKDIR /app

# Dependency-first pattern
COPY go.mod go.sum ./
RUN go mod download

# Copy source and build
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w" \
    -o server \
    ./cmd/server

# ============================================================
# Stage 2: Production
# ============================================================
FROM alpine:3.19

# SSL certs for HTTPS requests, timezone data
RUN apk add --no-cache ca-certificates tzdata

# Security: non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY --from=builder /app/server /usr/local/bin/server

USER appuser

EXPOSE 8080

CMD ["server"]
```

**Size:** ~15-25MB. If you use `FROM scratch` instead of `FROM alpine:3.19` and copy the certs manually: ~10-15MB.

### Python Service

```dockerfile
# ============================================================
# Stage 1: Build dependencies
# ============================================================
FROM python:3.12-slim AS builder
WORKDIR /app

# Install build dependencies for compiled packages (like psycopg2)
RUN apt-get update && \
    apt-get install -y --no-install-recommends gcc libpq-dev && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./

# Install into a virtual environment so we can copy it cleanly
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install --no-cache-dir -r requirements.txt

# ============================================================
# Stage 2: Production
# ============================================================
FROM python:3.12-slim
WORKDIR /app

# Runtime dependency: libpq for psycopg2 (but NOT gcc — that was only needed to compile)
RUN apt-get update && \
    apt-get install -y --no-install-recommends libpq5 && \
    rm -rf /var/lib/apt/lists/*

# Copy the virtual environment from builder
COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copy application code
COPY . .

# Security: non-root user
RUN useradd --create-home --shell /bin/bash appuser
USER appuser

EXPOSE 5000

CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "4", "app:app"]
```

**Why the venv trick:** By installing packages into a virtual environment, we get a self-contained directory (`/opt/venv`) that we can copy wholesale to the production stage. Without this, you'd need to copy individual site-packages directories and worry about paths.

**Size:** ~180-250MB (Python's runtime is larger than Node's Alpine variant, but still much smaller than without multi-stage).

### Generic Static Site (Any HTML/CSS/JS)

For a static site that doesn't need a build step:

```dockerfile
FROM nginx:1.25-alpine

RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/app.conf
COPY public/ /usr/share/nginx/html/

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

**Size:** ~10-20MB.

---

## 8. .dockerignore — What It Is and Why It Matters

### The Problem

When you run `docker build .`, Docker sends the entire build context (the `.` directory) to the daemon. Without a `.dockerignore`, this includes:

- `.git/` — your entire git history (could be hundreds of MB)
- `node_modules/` — your local dependencies (will be reinstalled in the image anyway)
- `dist/`, `build/`, `__pycache__/` — build artifacts
- `.env` files — secrets that should never be in an image
- IDE config, OS files, test coverage reports, etc.

This bloats the build context, slows down `docker build`, and risks leaking secrets or unnecessary files into your image.

### The Solution

A `.dockerignore` file works exactly like `.gitignore`. Put it in the root of your build context (same directory as your Dockerfile).

### Production .dockerignore

```
# Version control
.git
.gitignore

# Dependencies (reinstalled in Docker)
node_modules
vendor
__pycache__
*.pyc
.venv
venv

# Build output (rebuilt in Docker)
dist
build
out
*.o
*.exe

# Environment and secrets — NEVER include these
.env
.env.*
*.pem
*.key
credentials.json

# IDE and editor
.vscode
.idea
*.swp
*.swo
*~

# Docker files (don't recursively include Dockerfiles)
Dockerfile*
docker-compose*.yml
.dockerignore

# OS files
.DS_Store
Thumbs.db

# Test and CI
coverage
.nyc_output
.pytest_cache
htmlcov
.github
.gitlab-ci.yml

# Documentation (not needed in the image)
docs
*.md
LICENSE
```

### Why This Matters for Our Platform

When our deploy pipeline runs `docker build` for a user's app, the `.dockerignore` determines what gets sent. If a user's repo is 500MB because of a large `.git` history and cached build artifacts, but their actual source code is 5MB, a good `.dockerignore` makes the build context 5MB instead of 500MB. The build starts in seconds instead of minutes.

Our platform should generate a reasonable default `.dockerignore` if the user's repo doesn't have one.

---

## 9. Image Size Optimization

Smaller images mean:
- Faster pulls (less data to transfer)
- Faster deploys (less time to download on the server)
- Lower storage costs (especially with many apps)
- Smaller attack surface (fewer packages = fewer potential vulnerabilities)

### The Optimization Checklist

**1. Use the smallest appropriate base image**

```dockerfile
# Instead of this (900MB+):
FROM node:20

# Use this (~130MB):
FROM node:20-alpine

# Or for Go, use this (~0MB):
FROM scratch
```

**2. Use multi-stage builds (covered above)**

This is the single biggest size reduction. A Go service goes from 250MB to 10MB. A Node service goes from 800MB to 150MB.

**3. Combine and clean up RUN instructions**

```dockerfile
# BAD: Intermediate files persist in earlier layers
RUN apt-get update
RUN apt-get install -y build-essential
RUN make
RUN apt-get purge -y build-essential
RUN rm -rf /var/lib/apt/lists/*

# GOOD: Everything in one layer, cleanup happens before the layer is committed
RUN apt-get update && \
    apt-get install -y --no-install-recommends build-essential && \
    make && \
    apt-get purge -y build-essential && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*
```

**4. Use `--no-install-recommends` with apt**

```dockerfile
RUN apt-get install -y --no-install-recommends curl
#                       ^^^^^^^^^^^^^^^^^^^^^^^^
#                       Without this, apt installs "recommended" packages
#                       that you probably don't need, adding 50-200MB
```

**5. Use `--no-cache-dir` with pip**

```dockerfile
RUN pip install --no-cache-dir -r requirements.txt
#               ^^^^^^^^^^^^^^^
#               Prevents pip from caching downloaded packages
#               (you'll never install again inside this layer)
```

**6. Remove unnecessary files from COPY**

Use `.dockerignore` to exclude tests, docs, and other files that aren't needed at runtime. Copy only what you need:

```dockerfile
# Instead of:
COPY . .

# Consider:
COPY src/ ./src/
COPY config/ ./config/
COPY package.json package-lock.json ./
```

### Checking Image Size

```bash
docker images myapp
# REPOSITORY   TAG       IMAGE ID       CREATED         SIZE
# myapp        v1        abc123def456   5 minutes ago   23.4MB

docker history myapp:v1
# Shows size of each layer — find what's taking space
```

---

## 10. Security Best Practices

### Run as Non-Root

By default, processes in a container run as root (UID 0). If there's a container escape vulnerability, the attacker is root on the host. Always create and switch to a non-root user:

**Alpine:**
```dockerfile
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser
```

**Debian/Ubuntu:**
```dockerfile
RUN groupadd -r appgroup && useradd -r -g appgroup appuser
USER appuser
```

Place the `USER` instruction as late as possible in the Dockerfile, because earlier instructions (like `RUN apt-get install`) often need root.

### Never Put Secrets in the Image

Secrets in `ENV`, `ARG`, `COPY`, or `RUN` are permanently baked into image layers. Even if you delete them in a later layer, they exist in the earlier layer and can be extracted.

```dockerfile
# TERRIBLE: Secret is in the image layer forever
RUN echo "DATABASE_URL=postgres://user:pass@host/db" > .env

# TERRIBLE: Secret is in build history
ARG DB_PASSWORD
RUN echo $DB_PASSWORD > /tmp/pass

# CORRECT: Inject at runtime
# (Dockerfile has no secrets at all)
CMD ["node", "server.js"]

# Run with:
# docker run -e DATABASE_URL="postgres://..." myapp
```

For secrets needed during build (like a private npm registry token), use Docker BuildKit secret mounts:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=npmrc,target=/app/.npmrc npm ci
#   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
#   Mounts the secret file during this RUN instruction only.
#   It's NOT saved in the layer.
COPY . .
CMD ["node", "server.js"]
```

Build with:
```bash
docker build --secret id=npmrc,src=$HOME/.npmrc -t myapp .
```

### Use Minimal Base Images

Every package in your base image is a potential vulnerability. Use the smallest image that works:

| Approach | Packages in image | Vulnerability surface |
|---|---|---|
| `FROM ubuntu:22.04` | Full OS (~300 packages) | Large |
| `FROM debian:bookworm-slim` | Minimal Debian (~100 packages) | Medium |
| `FROM alpine:3.19` | Minimal (~15 packages) | Small |
| `FROM scratch` | Nothing | Almost zero |
| `FROM distroless/static` | Only certs + tzdata | Almost zero |

### Don't Run SSH in Containers

Tutorials sometimes show installing SSH in a container to "log into" it. Never do this. Use `docker exec` to get a shell in a running container:

```bash
docker exec -it mycontainer sh
```

SSH adds attack surface, requires key management, and is unnecessary.

### Pin Base Image Digests for Maximum Reproducibility

Tags like `node:20-alpine` are mutable — they can point to different images over time (e.g., when a security patch is applied). For maximum reproducibility:

```dockerfile
# Pin by digest — this always refers to the exact same image
FROM node:20-alpine@sha256:1a2b3c4d5e6f...
```

In practice, pinning to a specific minor/patch version (like `node:20.11-alpine`) is usually sufficient. Full digest pinning is for regulated environments that need absolute reproducibility.

### Scan Images for Vulnerabilities

After building, scan the image:

```bash
docker scout cves myapp:v1
# or
trivy image myapp:v1
```

This finds known vulnerabilities (CVEs) in OS packages and language dependencies in the image. In our platform, we could integrate scanning into the build pipeline and warn users about critical vulnerabilities.

---

## Summary

You now know how to write production-grade Dockerfiles for any stack:

- **Every instruction** (`FROM`, `RUN`, `COPY`, `WORKDIR`, `ENV`, `ARG`, `EXPOSE`, `CMD`, `ENTRYPOINT`) and when to use each.
- **CMD vs ENTRYPOINT**: CMD for the default command (can be overridden), ENTRYPOINT for the fixed executable.
- **ENV vs ARG**: ENV persists to runtime, ARG is build-time only. Never put secrets in either.
- **Layer caching**: Copy dependency files first, install, then copy source code. This makes rebuilds fast.
- **Multi-stage builds**: Build in one stage, copy only what's needed to a minimal production stage.
- **Production Dockerfiles** for Node.js (backend + frontend), Go, Python, and static sites.
- **`.dockerignore`**: Exclude `.git`, `node_modules`, secrets, and anything not needed in the build.
- **Size optimization**: Small base images, combined RUN commands, multi-stage builds.
- **Security**: Non-root users, no secrets in images, minimal base images, BuildKit secret mounts.

In Chapter 3, we'll master the Docker CLI — every command you'll use to build, run, debug, and manage containers on a daily basis.

---

→ next: [chapter03_cli_mastery.md](chapter03_cli_mastery.md)
