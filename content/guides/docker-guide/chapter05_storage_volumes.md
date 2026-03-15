# Chapter 5 — Storage & Volumes

---

## Table of Contents

1. [Why Container Storage Is Ephemeral by Default](#1-why-container-storage-is-ephemeral-by-default)
2. [Volumes vs Bind Mounts vs tmpfs](#2-volumes-vs-bind-mounts-vs-tmpfs)
3. [Named Volumes — Creating, Inspecting, Backing Up](#3-named-volumes--creating-inspecting-backing-up)
4. [Bind Mounts — How They Work and When to Use Them](#4-bind-mounts--how-they-work-and-when-to-use-them)
5. [Where Databases Must Store Data](#5-where-databases-must-store-data)
6. [Volume Permissions and Common Permission Errors](#6-volume-permissions-and-common-permission-errors)
7. [Backup and Restore Strategies](#7-backup-and-restore-strategies)
8. [How Storage Works in Our Platform](#8-how-storage-works-in-our-platform)

---

## 1. Why Container Storage Is Ephemeral by Default

Recall from Chapter 1: when Docker creates a container, it takes the image's read-only layers and adds a thin read-write layer on top. Any files the container creates or modifies go into this read-write layer.

```
┌────────────────────────────────────┐
│  Container read-write layer        │  ← Files created/modified at runtime
│  (ephemeral — dies with container) │    (logs, temp files, data, uploads)
├────────────────────────────────────┤
│  Image layer 3: app code (R/O)     │
├────────────────────────────────────┤
│  Image layer 2: dependencies (R/O) │
├────────────────────────────────────┤
│  Image layer 1: base OS (R/O)      │
└────────────────────────────────────┘
```

When the container is removed (`docker rm`), the read-write layer is deleted. **All data in it is gone permanently.**

This is intentional. Containers are designed to be disposable — you should be able to stop, remove, and recreate a container at any time without losing anything important. This is what enables our deploy pipeline: stop old container, start new container, zero concern about state.

But some data IS important:
- Database files (PostgreSQL data directory)
- User uploads
- Application configuration
- Encryption keys, SSL certificates (like Caddy's)

This data must survive container restarts and removal. That's what volumes are for.

---

## 2. Volumes vs Bind Mounts vs tmpfs

Docker provides three ways to persist data outside the container's ephemeral layer:

```
┌───────────────────────────────────────────────────────┐
│                     HOST FILESYSTEM                    │
│                                                       │
│  /var/lib/docker/volumes/    /home/user/project/      │
│  ┌──────────────────┐       ┌──────────────────┐      │
│  │  Named Volume     │       │  Bind Mount       │      │
│  │  (Docker-managed) │       │  (your directory)  │      │
│  └────────┬─────────┘       └────────┬──────────┘      │
│           │                          │                  │
│           └──────────┬───────────────┘                  │
│                      │                                  │
│  ┌───────────────────▼───────────────────────────────┐  │
│  │              Container filesystem                  │  │
│  │                                                   │  │
│  │  /app/data/  ← mounted from volume or bind mount  │  │
│  │  /tmp/cache/ ← could be tmpfs (RAM only)          │  │
│  └───────────────────────────────────────────────────┘  │
│                                                       │
└───────────────────────────────────────────────────────┘
```

### Named Volumes

Docker creates and manages the storage location (under `/var/lib/docker/volumes/`). You refer to them by name.

```bash
docker volume create pgdata
docker run -d -v pgdata:/var/lib/postgresql/data postgres:16
```

**Pros:**
- Docker manages the lifecycle — easy to create, list, inspect, back up
- Works on any platform (Linux, Docker Desktop on Mac/Windows)
- Can be shared between containers
- Best performance on Linux

**Cons:**
- Less transparent — files are buried in `/var/lib/docker/volumes/`
- Harder to edit directly from the host

**Use for:** Database storage, application state, anything that must persist in production.

### Bind Mounts

Maps a specific host directory into the container.

```bash
docker run -d -v /host/path/config.yml:/app/config.yml myapp:v1
docker run -d -v $(pwd)/src:/app/src myapp:v1    # Development: live code reload
```

**Pros:**
- You control exactly where files are on the host
- Easy to edit files from the host (great for development)
- Transparent — you can `ls` the directory on the host

**Cons:**
- Path must exist on the host
- Works differently on Mac (Docker Desktop uses a VM, so bind mounts go through a file-sharing layer that's slower)
- No lifecycle management by Docker

**Use for:** Config files, development live-reload, host directories you need to read in a container.

### tmpfs Mounts

Stored in memory (RAM) only. Never written to disk. Disappears when container stops.

```bash
docker run -d --tmpfs /tmp:size=100m myapp:v1
```

**Use for:** Sensitive temp data that shouldn't touch disk (session tokens, temp encryption keys), or high-speed scratch space.

### Comparison Table

| Feature | Named Volume | Bind Mount | tmpfs |
|---|---|---|---|
| Managed by Docker | Yes | No | No |
| Location on host | `/var/lib/docker/volumes/` | Anywhere you specify | Memory (RAM) |
| Survives container removal | Yes | Yes (host files remain) | No |
| Survives host reboot | Yes | Yes | No |
| Shareable between containers | Yes | Yes | No |
| Performance on Linux | Excellent | Excellent | Fastest (RAM) |
| Performance on Mac | Good | Slow (VM translation) | Fast |
| Use case | Production data | Config files, development | Temp/sensitive data |

---

## 3. Named Volumes — Creating, Inspecting, Backing Up

### Creating Volumes

```bash
# Create explicitly
docker volume create pgdata

# Or let Docker create it implicitly (on first use)
docker run -d -v pgdata:/var/lib/postgresql/data postgres:16
# If "pgdata" doesn't exist, Docker creates it automatically
```

### Listing and Inspecting

```bash
# List all volumes
docker volume ls
# DRIVER    VOLUME NAME
# local     pgdata
# local     redis_data
# local     caddy_data

# Inspect a volume (see where it's stored, what uses it)
docker volume inspect pgdata
# [
#   {
#     "CreatedAt": "2024-01-15T10:30:00Z",
#     "Driver": "local",
#     "Labels": {},
#     "Mountpoint": "/var/lib/docker/volumes/pgdata/_data",
#     "Name": "pgdata",
#     "Options": {},
#     "Scope": "local"
#   }
# ]
```

The `Mountpoint` shows where the data actually lives on disk. You can read files there directly (as root):

```bash
sudo ls /var/lib/docker/volumes/pgdata/_data
```

### Removing Volumes

```bash
# Remove a specific volume (must not be in use by any container)
docker volume rm pgdata

# Remove all unused volumes (DANGER: permanent data loss!)
docker volume prune

# Force remove (no confirmation)
docker volume prune -f
```

**Never run `docker volume prune` carelessly.** It removes every volume not attached to a running container — including database volumes from stopped containers. Data loss is permanent.

### Backing Up a Volume

Volumes don't have a built-in backup command, but the pattern is straightforward — run a temporary container that mounts the volume and creates a tar archive:

```bash
# Back up the pgdata volume to a tar file on the host
docker run --rm \
  -v pgdata:/source:ro \
  -v $(pwd):/backup \
  alpine \
  tar czf /backup/pgdata-backup-$(date +%Y%m%d).tar.gz -C /source .
```

What this does:
1. Starts a temporary Alpine container
2. Mounts the `pgdata` volume read-only at `/source`
3. Mounts the current host directory at `/backup`
4. Creates a compressed tar archive of the volume contents
5. Container auto-removes when done (`--rm`)

### Restoring a Volume from Backup

```bash
# Create a new volume (or use the existing one)
docker volume create pgdata

# Restore from backup
docker run --rm \
  -v pgdata:/target \
  -v $(pwd):/backup:ro \
  alpine \
  sh -c "cd /target && tar xzf /backup/pgdata-backup-20240115.tar.gz"
```

---

## 4. Bind Mounts — How They Work and When to Use Them

### In Development (Most Common Use)

Bind mounts are essential for development — they let you edit code on your host and see changes reflected inside the container immediately:

```bash
docker run -d \
  -v $(pwd)/src:/app/src \
  -v $(pwd)/public:/app/public \
  -p 3000:3000 \
  myapp:dev
```

Your editor modifies files on the host. The container sees the changes instantly. With a file watcher (like nodemon or vite's HMR), the app reloads automatically.

### In Production (Config Files, Read-Only Mounts)

In production, bind mounts are used for config files and read-only data:

```bash
# Mount a config file (read-only)
docker run -d \
  -v /opt/platform/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \
  caddy:2

# Mount environment file
docker run -d \
  --env-file /opt/platform/apps/myapp/.env \
  myapp:v1
```

The `:ro` suffix makes the mount read-only — the container can read the file but can't modify it. This is a security best practice for config files.

### The --mount Syntax (More Explicit)

Docker has two syntaxes for mounts. The `-v` flag is shorter; `--mount` is more explicit and clear:

```bash
# These are equivalent:

# -v syntax
docker run -v pgdata:/var/lib/postgresql/data postgres:16

# --mount syntax
docker run --mount type=volume,source=pgdata,target=/var/lib/postgresql/data postgres:16

# Bind mount with --mount
docker run --mount type=bind,source=/host/path,target=/container/path,readonly myapp:v1
```

`--mount` fails loudly if the source doesn't exist (good for catching mistakes). `-v` silently creates a directory if the source doesn't exist (bad for catching mistakes but more convenient).

**Recommendation:** Use `-v` for quick work; use `--mount` in scripts and production configs.

---

## 5. Where Databases Must Store Data

Every database has a specific directory where it stores its data files. You MUST mount a volume at this path:

| Database | Data Directory | Volume Mount |
|---|---|---|
| PostgreSQL | `/var/lib/postgresql/data` | `-v pgdata:/var/lib/postgresql/data` |
| MySQL | `/var/lib/mysql` | `-v mysqldata:/var/lib/mysql` |
| MongoDB | `/data/db` | `-v mongodata:/data/db` |
| Redis | `/data` | `-v redisdata:/data` |
| SQLite | Wherever your app puts the `.db` file | `-v sqlitedata:/app/data` |

### What Happens Without a Volume

```bash
# DON'T: Running PostgreSQL without a volume
docker run -d --name postgres postgres:16

# Write data...
docker exec postgres psql -U postgres -c "CREATE TABLE users (id serial, name text);"
docker exec postgres psql -U postgres -c "INSERT INTO users (name) VALUES ('Alice');"

# Now remove and recreate the container (which happens on every deploy)
docker rm -f postgres
docker run -d --name postgres postgres:16

# Data is GONE
docker exec postgres psql -U postgres -c "SELECT * FROM users;"
# ERROR:  relation "users" does not exist
```

### The Correct Way

```bash
# DO: Always use a named volume for database data
docker run -d \
  --name postgres \
  --network platform \
  -v pgdata:/var/lib/postgresql/data \
  -e POSTGRES_PASSWORD=secretpassword \
  --restart unless-stopped \
  postgres:16-alpine

# Now data survives container removal
docker rm -f postgres
docker run -d \
  --name postgres \
  --network platform \
  -v pgdata:/var/lib/postgresql/data \
  -e POSTGRES_PASSWORD=secretpassword \
  --restart unless-stopped \
  postgres:16-alpine

# Data is still there!
docker exec postgres psql -U postgres -c "SELECT * FROM users;"
# Alice is still here
```

### Redis Persistence

Redis is often used as a cache (data loss acceptable) but also as a session store or queue (data loss NOT acceptable). Configure accordingly:

```bash
# Redis with persistence (AOF + RDB)
docker run -d \
  --name redis \
  --network platform \
  -v redisdata:/data \
  --restart unless-stopped \
  redis:7-alpine \
  redis-server --appendonly yes

# Redis as pure cache (no persistence needed, no volume)
docker run -d \
  --name redis-cache \
  --network platform \
  --restart unless-stopped \
  redis:7-alpine
```

---

## 6. Volume Permissions and Common Permission Errors

Permission errors are one of the most frustrating Docker issues. Here's why they happen and how to fix them.

### The Problem

Your Dockerfile creates a non-root user (as it should for security):

```dockerfile
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser
```

You mount a volume:

```bash
docker run -d -v mydata:/app/data myapp:v1
```

The app tries to write to `/app/data` and gets:

```
Error: EACCES: permission denied, open '/app/data/file.txt'
```

### Why It Happens

When Docker creates a named volume for the first time, it copies the contents and permissions from the container's mount point. If `/app/data` exists in the image and is owned by `appuser`, the volume inherits that.

But if the volume already exists (from a previous container or a different image), it keeps its existing permissions. If those don't match the container's user, you get permission errors.

Bind mounts are worse — they always use the host's file permissions. If the host directory is owned by `root` (UID 0) and the container runs as `appuser` (UID 1000), the container can't write.

### Fixes

**Fix 1: Set permissions in the Dockerfile**

```dockerfile
RUN mkdir -p /app/data && chown appuser:appgroup /app/data
USER appuser
```

**Fix 2: Use an entrypoint script that fixes permissions**

```bash
#!/bin/sh
set -e
# Fix permissions (runs as root if ENTRYPOINT runs before USER)
chown -R appuser:appgroup /app/data
# Drop to non-root
exec su-exec appuser "$@"
```

**Fix 3: Match UIDs between host and container**

For bind mounts, ensure the container user's UID matches the host file owner:

```dockerfile
# Use a specific UID that matches the host user
RUN adduser -u 1000 -S appuser
USER appuser
```

```bash
# On the host, ensure the directory is owned by UID 1000
sudo chown -R 1000:1000 /host/path/data
```

**Fix 4: For databases, just use named volumes**

Official database images (PostgreSQL, MySQL, etc.) handle permissions internally. Named volumes work out of the box:

```bash
docker run -d -v pgdata:/var/lib/postgresql/data postgres:16
# Just works — PostgreSQL handles permissions in its entrypoint
```

---

## 7. Backup and Restore Strategies

### Strategy 1: Volume Tar Backups

Best for: general-purpose volume backup (files, configs, small databases).

```bash
# Backup
docker run --rm \
  -v pgdata:/source:ro \
  -v /opt/platform/backups:/backup \
  alpine \
  tar czf /backup/pgdata-$(date +%Y%m%d-%H%M%S).tar.gz -C /source .

# Restore
docker run --rm \
  -v pgdata:/target \
  -v /opt/platform/backups:/backup:ro \
  alpine \
  sh -c "cd /target && tar xzf /backup/pgdata-20240115-103000.tar.gz"
```

### Strategy 2: Database-Native Dumps

Best for: databases. Produces a logical backup that can be restored to any version.

```bash
# PostgreSQL dump
docker exec postgres pg_dump -U myuser -d mydb > /opt/platform/backups/mydb-$(date +%Y%m%d).sql

# PostgreSQL restore
docker exec -i postgres psql -U myuser -d mydb < /opt/platform/backups/mydb-20240115.sql

# MySQL dump
docker exec mysql mysqldump -u root -p mydb > /opt/platform/backups/mydb-$(date +%Y%m%d).sql
```

### Strategy 3: Automated Backup Script

For our platform, we'll run this daily:

```bash
#!/bin/bash
BACKUP_DIR="/opt/platform/backups"
DATE=$(date +%Y%m%d-%H%M%S)
RETENTION_DAYS=7

mkdir -p "$BACKUP_DIR"

# Backup PostgreSQL
if docker ps -q -f name=postgres > /dev/null 2>&1; then
  docker exec postgres pg_dumpall -U postgres > "$BACKUP_DIR/postgres-$DATE.sql"
  gzip "$BACKUP_DIR/postgres-$DATE.sql"
  echo "PostgreSQL backed up"
fi

# Backup named volumes
for vol in $(docker volume ls -q); do
  docker run --rm \
    -v "$vol":/source:ro \
    -v "$BACKUP_DIR":/backup \
    alpine \
    tar czf "/backup/vol-${vol}-${DATE}.tar.gz" -C /source .
  echo "Volume $vol backed up"
done

# Clean old backups
find "$BACKUP_DIR" -type f -mtime +$RETENTION_DAYS -delete
echo "Old backups cleaned (older than $RETENTION_DAYS days)"
```

---

## 8. How Storage Works in Our Platform

### Volume Map

| Component | Volume Name | Mount Path | Purpose |
|---|---|---|---|
| PostgreSQL | `pgdata` | `/var/lib/postgresql/data` | Database files |
| Redis | `redisdata` | `/data` | Persistent cache/sessions |
| Caddy | `caddy_data` | `/data` | SSL certificates, OCSP cache |
| Caddy | `caddy_config` | `/config` | Runtime configuration |
| Prometheus | `prometheus_data` | `/prometheus` | Metrics time-series data |
| Grafana | `grafana_data` | `/var/lib/grafana` | Dashboards, users, settings |
| Loki | `loki_data` | `/loki` | Log storage |
| Per-app uploads | `app_<name>_data` | `/app/data` | User-uploaded files |

### What Uses Bind Mounts

| Component | Host Path | Container Path | Purpose |
|---|---|---|---|
| Caddy config | `/opt/platform/caddy/Caddyfile` | `/etc/caddy/Caddyfile` | Routing configuration |
| Prometheus config | `/opt/platform/prometheus/prometheus.yml` | `/etc/prometheus/prometheus.yml` | Scrape configuration |
| App env files | `/opt/platform/apps/<name>/.env` | passed via `--env-file` | Per-app secrets |
| Docker socket | `/var/run/docker.sock` | `/var/run/docker.sock` | For cAdvisor (read container metrics) |

### What Uses No Persistent Storage

App containers (the actual deployed apps) are stateless by default. Their code is in the image. They write logs to stdout/stderr (captured by Docker). If an app needs persistent file storage (user uploads, generated files), we create a dedicated named volume for it.

### The Directory Structure on the VM

```
/opt/platform/
├── apps/
│   ├── myapp/
│   │   ├── .env              # Secrets (env vars)
│   │   └── repo/             # Cloned git repository
│   ├── another-app/
│   │   ├── .env
│   │   └── repo/
├── caddy/
│   └── Caddyfile             # Reverse proxy routing
├── prometheus/
│   └── prometheus.yml        # Metrics collection config
├── loki/
│   └── loki-config.yml       # Log aggregation config
├── promtail/
│   └── promtail-config.yml   # Log shipping config
├── backups/
│   ├── postgres-20240115.sql.gz
│   └── vol-pgdata-20240115.tar.gz
└── scripts/
    ├── backup.sh
    └── cleanup.sh
```

Config files are bind-mounted (you can edit them on the host). Data is in named volumes (Docker manages the storage). This separation is crucial: config is easily editable; data is safely managed.

---

## Summary

- Container storage is **ephemeral by default** — data disappears when the container is removed.
- **Named volumes** are the production standard for persistent data (databases, certs, metrics).
- **Bind mounts** are for config files and development live-reload.
- **Every database must use a volume** at its data directory, or you will lose data.
- **Permission errors** are common — match UIDs between container users and volume owners.
- **Backup volumes** using tar archives or database-native dump tools.
- In our platform, infrastructure services use named volumes for data and bind mounts for config.

In Chapter 6, we'll learn Docker Compose — the tool for defining and running multi-container setups from a single YAML file.

---

→ next: [chapter06_docker_compose.md](chapter06_docker_compose.md)
