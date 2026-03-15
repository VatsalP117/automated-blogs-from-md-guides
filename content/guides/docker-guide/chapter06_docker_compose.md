# Chapter 6 — Docker Compose in Depth

---

## Table of Contents

1. [What Docker Compose Is and Why It Exists](#1-what-docker-compose-is-and-why-it-exists)
2. [The docker-compose.yml Structure — Every Field Explained](#2-the-docker-composeyml-structure--every-field-explained)
3. [Services, Networks, Volumes — How They Connect](#3-services-networks-volumes--how-they-connect)
4. [Environment Variables in Compose](#4-environment-variables-in-compose)
5. [Dependency Ordering — depends_on and Its Limitations](#5-dependency-ordering--depends_on-and-its-limitations)
6. [Health Checks — Making Services Wait Properly](#6-health-checks--making-services-wait-properly)
7. [Profiles — Running Subsets of Services](#7-profiles--running-subsets-of-services)
8. [Overrides — Dev vs Prod Configs](#8-overrides--dev-vs-prod-configs)
9. [Compose CLI — Every Command You Need](#9-compose-cli--every-command-you-need)
10. [Full Example: Go API + PostgreSQL + Redis + Nginx](#10-full-example-go-api--postgresql--redis--nginx)
11. [Common Compose Mistakes in Production](#11-common-compose-mistakes-in-production)
12. [How Compose Fits Into Our Platform](#12-how-compose-fits-into-our-platform)

---

## 1. What Docker Compose Is and Why It Exists

Imagine starting the observability stack for our platform by hand:

```bash
docker network create monitoring
docker volume create prometheus_data
docker volume create grafana_data
docker volume create loki_data

docker run -d --name prometheus --network monitoring \
  -v prometheus_data:/prometheus \
  -v /opt/platform/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro \
  --restart unless-stopped \
  prom/prometheus:v2.49.1

docker run -d --name grafana --network monitoring \
  -v grafana_data:/var/lib/grafana \
  -e GF_SECURITY_ADMIN_PASSWORD=admin \
  --restart unless-stopped \
  grafana/grafana:10.2.3

docker run -d --name loki --network monitoring \
  -v loki_data:/loki \
  -v /opt/platform/loki/loki-config.yml:/etc/loki/local-config.yaml:ro \
  --restart unless-stopped \
  grafana/loki:2.9.3

# ... and more for cAdvisor, Promtail, etc.
```

That's five commands just to start. To stop, you need to stop each one. To update, you rebuild individually. It's error-prone and tedious.

**Docker Compose lets you define all of this in a single YAML file and manage it with one command.**

```bash
docker compose up -d      # Start everything
docker compose down        # Stop everything
docker compose logs        # See all logs
docker compose restart     # Restart everything
```

Under the hood, Compose just translates the YAML into the same Docker CLI commands. There's nothing Compose does that you couldn't do by hand — Compose just makes it declarative, repeatable, and manageable.

### `docker compose` vs `docker-compose`

- `docker-compose` (with hyphen): The old standalone binary, written in Python. Deprecated.
- `docker compose` (with space): The new plugin, written in Go, integrated into the Docker CLI. **Use this.**

On a modern Docker installation, `docker compose` is available by default. If not, install the compose plugin:

```bash
sudo apt-get install docker-compose-plugin
```

---

## 2. The docker-compose.yml Structure — Every Field Explained

Here's the skeleton of a Compose file with every major section:

```yaml
# Compose file version (optional in modern Compose, but good practice)
# No 'version' key needed with Docker Compose V2+

services:
  # Each service becomes a container
  service-name:
    image: image:tag                    # Use a pre-built image
    build:                              # OR build from a Dockerfile
      context: ./path
      dockerfile: Dockerfile
    container_name: custom-name         # Override auto-generated name
    restart: unless-stopped             # Restart policy
    ports:
      - "8080:3000"                     # Host:Container port mapping
    volumes:
      - named-vol:/container/path       # Named volume mount
      - ./host/path:/container/path     # Bind mount
      - ./config.yml:/app/config.yml:ro # Read-only bind mount
    environment:
      - NODE_ENV=production             # Environment variables
      - DB_HOST=postgres
    env_file:
      - .env                            # Load from file
    networks:
      - frontend                        # Connect to specific networks
      - backend
    depends_on:
      - postgres                        # Start after these services
    healthcheck:                        # Container health check
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 512M
    labels:
      - "app=myservice"                 # Metadata labels
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    command: ["node", "server.js"]      # Override image CMD
    entrypoint: ["docker-entrypoint.sh"] # Override image ENTRYPOINT
    working_dir: /app                    # Override image WORKDIR
    user: "1000:1000"                    # Run as specific UID:GID

networks:
  frontend:
    driver: bridge
  backend:
    driver: bridge
  # Use a pre-existing network (not managed by Compose)
  external-net:
    external: true
    name: platform

volumes:
  named-vol:
    driver: local
  # Use a pre-existing volume
  external-vol:
    external: true
    name: pgdata
```

### Key Points

- **services:** Each entry under `services` is a container that Compose creates.
- **image vs build:** Use `image` to pull from a registry, or `build` to build from a Dockerfile. You can use both (build locally and tag it with the image name).
- **container_name:** By default, Compose names containers `<project>-<service>-<index>` (e.g., `myproject-api-1`). Use `container_name` for a fixed name.
- **restart:** Same policies as `docker run --restart`.
- **deploy.resources.limits:** Resource limits. In `docker compose up` (non-Swarm mode), this requires Compose file to work with Docker Engine resource constraints.

---

## 3. Services, Networks, Volumes — How They Connect

### How Services See Each Other

In a Compose file, each service is reachable by its service name as a hostname:

```yaml
services:
  api:
    image: myapi:v1
    environment:
      - DATABASE_URL=postgres://user:pass@db:5432/mydb
      #                                    ^^
      #                    Service name "db" resolves to the db container's IP
  db:
    image: postgres:16
```

The `api` service can reach the `db` service at hostname `db`. Compose creates a default network and connects all services to it.

### Default Network Behavior

If you don't specify any networks, Compose creates one default network for the project:

```bash
docker compose up -d
# Creates network "myproject_default" and connects all services to it
```

This is usually fine for a standalone Compose project. All services can talk to each other by name.

### Explicit Networks

For more control, define networks explicitly:

```yaml
services:
  caddy:
    networks:
      - frontend
      - backend          # Caddy bridges both networks

  api:
    networks:
      - backend          # API only on backend

  postgres:
    networks:
      - backend          # DB only on backend

  react-app:
    networks:
      - frontend         # Frontend only on frontend

networks:
  frontend:
  backend:
```

Now `react-app` can't directly reach `postgres` — they're on different networks. Only `caddy` can reach both.

### External Networks

For our platform, we want Compose services to join the existing `platform` network (used by all other containers):

```yaml
services:
  prometheus:
    image: prom/prometheus:v2.49.1
    networks:
      - platform

networks:
  platform:
    external: true       # Don't create it — it already exists
```

This is critical: the observability stack (Compose) needs to talk to app containers (managed by our Go deploy service, not Compose). By using an external network, they're all on the same network.

### Volume References

```yaml
services:
  postgres:
    volumes:
      - pgdata:/var/lib/postgresql/data    # Named volume

volumes:
  pgdata:                                   # Declare the volume
```

If you don't declare the volume in the top-level `volumes:` section, Compose creates an anonymous volume. Always declare volumes explicitly so they have predictable names and persist across `docker compose down`.

---

## 4. Environment Variables in Compose

### Inline Environment Variables

```yaml
services:
  api:
    environment:
      NODE_ENV: production
      PORT: "3000"                 # Always quote numbers
      DATABASE_URL: postgres://user:pass@db:5432/mydb
```

Or as a list:

```yaml
    environment:
      - NODE_ENV=production
      - PORT=3000
```

### From an .env File

```yaml
services:
  api:
    env_file:
      - .env                 # Loads all vars from .env file
      - .env.production      # Additional overrides
```

The `.env` file:

```
NODE_ENV=production
PORT=3000
DATABASE_URL=postgres://user:pass@db:5432/mydb
SECRET_KEY=your-secret-key-here
```

**Security rule:** `.env` files with secrets should be in `.gitignore` and never committed.

### Variable Substitution in Compose Files

Compose can read environment variables from the shell and substitute them in the YAML:

```yaml
services:
  api:
    image: myapp:${GIT_SHA:-latest}
    #                      ^^^^^^^^^
    #                      Default value if GIT_SHA is not set
    environment:
      - NODE_ENV=${NODE_ENV:-production}
```

```bash
GIT_SHA=abc123f docker compose up -d
# Uses myapp:abc123f

docker compose up -d
# Uses myapp:latest (default)
```

### The Special `.env` File

If a file named `.env` exists in the same directory as your `docker-compose.yml`, Compose automatically reads it for variable substitution (not the same as `env_file` which loads into the container):

```
# .env file (for Compose variable substitution)
POSTGRES_VERSION=16
GRAFANA_VERSION=10.2.3
```

```yaml
services:
  postgres:
    image: postgres:${POSTGRES_VERSION}     # Becomes postgres:16
  grafana:
    image: grafana/grafana:${GRAFANA_VERSION}
```

This is useful for pinning versions in one place.

---

## 5. Dependency Ordering — depends_on and Its Limitations

### Basic depends_on

```yaml
services:
  api:
    depends_on:
      - db
      - redis
  db:
    image: postgres:16
  redis:
    image: redis:7
```

This ensures `db` and `redis` containers START before `api`. But **it only waits for the container to start — not for the service inside to be ready.**

PostgreSQL takes a few seconds to initialize. If `api` connects to `db` immediately after `db`'s container starts, the database isn't ready yet and the connection fails.

### The Solution: depends_on with Health Checks

```yaml
services:
  api:
    depends_on:
      db:
        condition: service_healthy      # Wait until db is HEALTHY, not just started
      redis:
        condition: service_healthy

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: secret
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5
      start_period: 10s

  redis:
    image: redis:7-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5
```

Now Compose waits until PostgreSQL actually responds to `pg_isready` and Redis responds to `ping` before starting the API. This is the correct way to handle service dependencies.

---

## 6. Health Checks — Making Services Wait Properly

### Health Check Configuration

```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
  interval: 30s        # Check every 30 seconds
  timeout: 10s         # Give the check 10 seconds to complete
  retries: 3           # After 3 consecutive failures, mark as unhealthy
  start_period: 30s    # Give the container 30 seconds to start before counting failures
```

### Health Check States

```
starting → (passes)  → healthy
starting → (fails N times after start_period) → unhealthy
healthy  → (fails N times) → unhealthy
unhealthy → (passes) → healthy
```

### Common Health Checks

**HTTP API:**
```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
  interval: 30s
  timeout: 10s
  retries: 3
  start_period: 15s
```

**PostgreSQL:**
```yaml
healthcheck:
  test: ["CMD-SHELL", "pg_isready -U postgres"]
  interval: 10s
  timeout: 5s
  retries: 5
  start_period: 30s
```

**Redis:**
```yaml
healthcheck:
  test: ["CMD", "redis-cli", "ping"]
  interval: 10s
  timeout: 5s
  retries: 5
```

**MySQL:**
```yaml
healthcheck:
  test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
  interval: 10s
  timeout: 5s
  retries: 5
  start_period: 30s
```

**TCP port check (generic):**
```yaml
healthcheck:
  test: ["CMD-SHELL", "nc -z localhost 8080 || exit 1"]
  interval: 10s
  timeout: 5s
  retries: 5
```

### Checking Health Status

```bash
docker ps
# CONTAINER ID   IMAGE        STATUS
# abc123         myapp:v1     Up 5 min (healthy)
# def456         postgres:16  Up 5 min (healthy)

docker inspect -f '{{.State.Health.Status}}' myapp
# healthy
```

---

## 7. Profiles — Running Subsets of Services

Profiles let you define services that only start when a specific profile is activated. Useful for separating core services from debug tools, or production from development-only services.

```yaml
services:
  api:
    image: myapp:v1
    # No profile — always starts

  postgres:
    image: postgres:16
    # No profile — always starts

  adminer:
    image: adminer:4
    profiles:
      - debug                    # Only starts with --profile debug
    ports:
      - "8081:8080"

  pgadmin:
    image: dpage/pgadmin4
    profiles:
      - debug
    ports:
      - "5050:80"

  prometheus:
    image: prom/prometheus
    profiles:
      - monitoring              # Only starts with --profile monitoring
```

```bash
# Start core services only
docker compose up -d
# Starts: api, postgres

# Start with debug tools
docker compose --profile debug up -d
# Starts: api, postgres, adminer, pgadmin

# Start with monitoring
docker compose --profile monitoring up -d
# Starts: api, postgres, prometheus

# Start everything
docker compose --profile debug --profile monitoring up -d
```

---

## 8. Overrides — Dev vs Prod Configs

### How Overrides Work

Docker Compose automatically merges `docker-compose.yml` with `docker-compose.override.yml` if both exist:

```
docker-compose.yml           ← Base config (production)
docker-compose.override.yml  ← Automatically merged (development overrides)
```

### Example: Production Base

`docker-compose.yml`:
```yaml
services:
  api:
    image: myapp:${GIT_SHA}
    restart: unless-stopped
    networks:
      - platform
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: "1.0"

  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    volumes:
      - pgdata:/var/lib/postgresql/data
    networks:
      - platform
    environment:
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password

networks:
  platform:
    external: true

volumes:
  pgdata:
```

### Example: Development Override

`docker-compose.override.yml`:
```yaml
services:
  api:
    build:
      context: .
      dockerfile: Dockerfile
    image: myapp:dev
    volumes:
      - ./src:/app/src                  # Live code reload
    ports:
      - "3000:3000"                     # Direct access (no reverse proxy in dev)
    environment:
      - NODE_ENV=development

  postgres:
    ports:
      - "5432:5432"                     # Direct DB access from host
    environment:
      POSTGRES_PASSWORD: devpassword     # Simple password for dev
```

```bash
# Development (auto-merges override)
docker compose up -d

# Production (explicit file, skip override)
docker compose -f docker-compose.yml up -d

# Or use named files
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

---

## 9. Compose CLI — Every Command You Need

### Starting Services

```bash
# Start all services in the background
docker compose up -d

# Start specific services
docker compose up -d api postgres

# Start and rebuild images
docker compose up -d --build

# Start and force recreate containers (even if config unchanged)
docker compose up -d --force-recreate

# Start with a specific number of replicas
docker compose up -d --scale api=3
```

### Stopping Services

```bash
# Stop and remove containers, networks (volumes preserved)
docker compose down

# Stop and remove EVERYTHING including volumes (DATA LOSS!)
docker compose down -v

# Stop and remove including images
docker compose down --rmi all

# Just stop (don't remove — can restart later)
docker compose stop

# Stop a specific service
docker compose stop api
```

### Viewing Status

```bash
# Running containers for this Compose project
docker compose ps

# Include stopped
docker compose ps -a

# Show service names only
docker compose ps --services
```

### Logs

```bash
# All service logs
docker compose logs

# Follow logs (real-time)
docker compose logs -f

# Logs for specific services
docker compose logs -f api postgres

# Last 100 lines
docker compose logs --tail 100

# With timestamps
docker compose logs -t
```

### Executing Commands

```bash
# Run a command in a running service container
docker compose exec api sh
docker compose exec db psql -U postgres

# Run a one-off container (new container, not in the running one)
docker compose run --rm api node migrate.js
docker compose run --rm api npm test
```

### Restarting

```bash
# Restart all services
docker compose restart

# Restart a specific service
docker compose restart api

# Restart with a timeout
docker compose restart -t 30 api
```

### Building

```bash
# Build all services that have a 'build' key
docker compose build

# Build with no cache
docker compose build --no-cache

# Build a specific service
docker compose build api
```

### Pulling

```bash
# Pull latest images for all services
docker compose pull

# Pull a specific service
docker compose pull postgres
```

---

## 10. Full Example: Go API + PostgreSQL + Redis + Nginx

Here's a complete, production-grade Compose file for a real multi-service application:

```yaml
services:
  # ─── Go API Server ──────────────────────────────────────────
  api:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: api
    restart: unless-stopped
    networks:
      - app
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
    environment:
      - DATABASE_URL=postgres://appuser:${DB_PASSWORD}@db:5432/appdb?sslmode=disable
      - REDIS_URL=redis://redis:6379/0
      - PORT=8080
    env_file:
      - .env
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: "1.0"
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:8080/health"]
      interval: 15s
      timeout: 5s
      retries: 3
      start_period: 10s
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

  # ─── PostgreSQL Database ────────────────────────────────────
  db:
    image: postgres:16-alpine
    container_name: db
    restart: unless-stopped
    networks:
      - app
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    environment:
      POSTGRES_DB: appdb
      POSTGRES_USER: appuser
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U appuser -d appdb"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
    deploy:
      resources:
        limits:
          memory: 1G
          cpus: "1.0"
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

  # ─── Redis Cache ────────────────────────────────────────────
  redis:
    image: redis:7-alpine
    container_name: redis
    restart: unless-stopped
    networks:
      - app
    volumes:
      - redisdata:/data
    command: redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: "0.5"
    logging:
      driver: json-file
      options:
        max-size: "5m"
        max-file: "3"

  # ─── Nginx Reverse Proxy ───────────────────────────────────
  nginx:
    image: nginx:1.25-alpine
    container_name: nginx
    restart: unless-stopped
    networks:
      - app
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./nginx/conf.d:/etc/nginx/conf.d:ro
    depends_on:
      api:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost/health"]
      interval: 30s
      timeout: 10s
      retries: 3
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"

networks:
  app:
    driver: bridge

volumes:
  pgdata:
  redisdata:
```

### Supporting Files

`.env` (never committed to git):
```
DB_PASSWORD=a-strong-random-password-here
JWT_SECRET=another-strong-random-secret
```

`init.sql` (run on first database initialization):
```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

`nginx/conf.d/app.conf`:
```nginx
upstream api_backend {
    server api:8080;
}

server {
    listen 80;
    server_name _;

    location /health {
        access_log off;
        return 200 "ok";
    }

    location /api/ {
        proxy_pass http://api_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Running This Stack

```bash
# Start everything
docker compose up -d

# Check status
docker compose ps
# NAME     IMAGE              STATUS                   PORTS
# api      myapp:latest       Up 2 min (healthy)
# db       postgres:16        Up 2 min (healthy)       
# redis    redis:7            Up 2 min (healthy)
# nginx    nginx:1.25         Up 2 min (healthy)       0.0.0.0:80->80/tcp

# Follow API logs
docker compose logs -f api

# Run database migrations
docker compose exec api ./migrate up

# Get a PostgreSQL shell
docker compose exec db psql -U appuser -d appdb

# Restart just the API after a code change
docker compose build api && docker compose up -d api
```

---

## 11. Common Compose Mistakes in Production

### Mistake 1: Using `docker compose down -v` Carelessly

```bash
docker compose down -v   # Removes ALL volumes — database data is GONE
```

The `-v` flag deletes named volumes. If your PostgreSQL data is in a Compose-managed volume, it's deleted permanently. **Only use `-v` when you intentionally want to destroy all data.**

### Mistake 2: Not Pinning Image Tags

```yaml
# BAD: Mutable tags — different image on every pull
services:
  postgres:
    image: postgres:latest
  redis:
    image: redis

# GOOD: Pinned to specific versions
services:
  postgres:
    image: postgres:16-alpine
  redis:
    image: redis:7-alpine
```

### Mistake 3: Storing Secrets in the Compose File

```yaml
# BAD: Secrets in plain text, committed to git
services:
  db:
    environment:
      POSTGRES_PASSWORD: my-super-secret-password

# GOOD: Reference from .env file (which is in .gitignore)
services:
  db:
    environment:
      POSTGRES_PASSWORD: ${DB_PASSWORD}
```

### Mistake 4: No Log Rotation

Without log limits, a busy service can fill the disk:

```yaml
# GOOD: Always set log limits
logging:
  driver: json-file
  options:
    max-size: "10m"
    max-file: "3"
```

### Mistake 5: No Resource Limits

One misbehaving service can eat all the memory and crash the host:

```yaml
# GOOD: Set limits
deploy:
  resources:
    limits:
      memory: 512M
      cpus: "1.0"
```

### Mistake 6: Using `depends_on` Without Health Checks

```yaml
# BAD: api starts before database is ready
depends_on:
  - db

# GOOD: api waits until database is actually healthy
depends_on:
  db:
    condition: service_healthy
```

### Mistake 7: Not Using restart Policies

```yaml
# BAD: Container stays dead after a crash
services:
  api:
    image: myapp:v1

# GOOD: Automatically restarts
services:
  api:
    image: myapp:v1
    restart: unless-stopped
```

---

## 12. How Compose Fits Into Our Platform

### What Compose Manages

In our platform, Docker Compose manages the **infrastructure services** — the things that don't change per deployment:

1. **Observability stack:** Prometheus, Grafana, Loki, Promtail, cAdvisor
2. **Shared databases:** PostgreSQL, Redis (if shared across apps)
3. **Caddy** (reverse proxy) — could be Compose or standalone

### What Compose Does NOT Manage

**App containers** are managed by our Go deploy service, not Compose. Each app is started/stopped individually via Docker CLI commands. This is because:

- Apps are deployed independently (you don't want to restart all apps when deploying one)
- Apps have independent lifecycles (different repos, different deploy schedules)
- The deploy service needs programmatic control (build, tag with SHA, stop old, start new)

### The Architecture

```
┌──────────────────────────────────────────────────┐
│                 Our Platform VM                    │
│                                                   │
│  Managed by docker compose:                       │
│  ┌─────────────────────────────────────────────┐  │
│  │ Observability Stack (docker-compose.yml)     │  │
│  │ - Prometheus                                │  │
│  │ - Grafana                                   │  │
│  │ - Loki + Promtail                           │  │
│  │ - cAdvisor                                  │  │
│  └─────────────────────────────────────────────┘  │
│                                                   │
│  Managed by Go deploy service (docker CLI):       │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐     │
│  │ App A  │ │ App B  │ │ App C  │ │ Caddy  │     │
│  └────────┘ └────────┘ └────────┘ └────────┘     │
│                                                   │
│  All on the same Docker network: "platform"       │
└──────────────────────────────────────────────────┘
```

The key bridge is the `platform` network, declared as `external: true` in the Compose file. This lets Compose-managed services (Prometheus) talk to non-Compose containers (app containers).

---

## Summary

Docker Compose is a declarative tool for defining and running multi-container applications from a single YAML file:

- **Services** define containers, their images, config, and dependencies.
- **Networks** define how services communicate. Use explicit networks for isolation.
- **Volumes** define persistent storage. Always declare them explicitly.
- **Health checks + depends_on with conditions** ensure services wait for each other properly.
- **Profiles** let you define optional service groups (debug tools, monitoring).
- **Overrides** separate dev and prod configuration cleanly.
- **Always** set resource limits, log rotation, restart policies, and pin image versions.

In our platform, Compose manages the observability stack. Individual app containers are managed programmatically by the Go deploy service. They share a network.

In Chapter 7, we'll set up Caddy as the reverse proxy — the component that routes traffic from the internet to the right app container.

---

→ next: [chapter07_reverse_proxy_caddy.md](chapter07_reverse_proxy_caddy.md)
