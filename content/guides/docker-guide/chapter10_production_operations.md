# Chapter 10 — Production Operations on a Single VM

---

## Table of Contents

1. [Setting Up Docker on a Fresh Ubuntu VM](#1-setting-up-docker-on-a-fresh-ubuntu-vm)
2. [docker compose Plugin vs Standalone docker-compose](#2-docker-compose-plugin-vs-standalone-docker-compose)
3. [Security Hardening](#3-security-hardening)
4. [The Directory Structure for the Platform](#4-the-directory-structure-for-the-platform)
5. [Managing Multiple Apps](#5-managing-multiple-apps)
6. [Keeping Docker Clean](#6-keeping-docker-clean)
7. [Resource Limits — Preventing Starvation](#7-resource-limits--preventing-starvation)
8. [Container Restart Policies](#8-container-restart-policies)
9. [Updating the Platform Without Downtime](#9-updating-the-platform-without-downtime)
10. [Backing Up the Entire Platform](#10-backing-up-the-entire-platform)
11. [Disaster Recovery — Restoring on a New VM](#11-disaster-recovery--restoring-on-a-new-vm)
12. [Common Production Incidents and Debugging](#12-common-production-incidents-and-debugging)

---

## 1. Setting Up Docker on a Fresh Ubuntu VM

Start with Ubuntu 22.04 LTS or 24.04 LTS. These steps install Docker Engine (not Docker Desktop — that's for your laptop).

### Step 1: Update the System

```bash
sudo apt-get update && sudo apt-get upgrade -y
```

### Step 2: Install Prerequisites

```bash
sudo apt-get install -y \
  ca-certificates \
  curl \
  gnupg \
  lsb-release \
  git \
  ufw \
  fail2ban
```

### Step 3: Add Docker's Official GPG Key and Repository

```bash
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
```

### Step 4: Install Docker Engine

```bash
sudo apt-get update
sudo apt-get install -y \
  docker-ce \
  docker-ce-cli \
  containerd.io \
  docker-buildx-plugin \
  docker-compose-plugin
```

### Step 5: Configure Docker for Production

Create `/etc/docker/daemon.json`:

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  },
  "storage-driver": "overlay2",
  "live-restore": true,
  "default-address-pools": [
    {"base": "172.17.0.0/12", "size": 24}
  ]
}
```

What each setting does:
- **log-driver + log-opts:** Rotate logs automatically. Without this, logs grow forever and fill the disk.
- **storage-driver overlay2:** The modern, recommended storage driver.
- **live-restore:** Keeps containers running when the Docker daemon restarts (e.g., during a Docker update). Critical for production.
- **default-address-pools:** Configures the IP ranges Docker uses for bridge networks.

Apply:

```bash
sudo systemctl restart docker
```

### Step 6: Add Your User to the Docker Group

```bash
sudo usermod -aG docker $USER
# Log out and back in for this to take effect
```

This lets you run `docker` commands without `sudo`. Only do this for trusted users — the `docker` group grants root-equivalent privileges.

### Step 7: Verify

```bash
docker --version
# Docker version 25.x.x

docker compose version
# Docker Compose version v2.24.x

docker run --rm hello-world
# Should print "Hello from Docker!"
```

---

## 2. docker compose Plugin vs Standalone docker-compose

| | `docker-compose` (v1, standalone) | `docker compose` (v2, plugin) |
|---|---|---|
| Installation | Separate binary | Part of Docker Engine install |
| Written in | Python | Go |
| Command | `docker-compose up` (hyphen) | `docker compose up` (space) |
| Status | **Deprecated** | **Current, use this** |
| Speed | Slower | Faster |
| Compatibility | Old Compose file formats | All formats |

If you installed Docker Engine as shown above, `docker compose` (plugin) is already installed. If you see scripts or guides using `docker-compose` (hyphenated), just replace the hyphen with a space.

---

## 3. Security Hardening

### SSH: Key-Only Authentication

Disable password login for SSH. Key-based auth only:

```bash
sudo vim /etc/ssh/sshd_config
```

Set:
```
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
```

```bash
sudo systemctl restart sshd
```

Make sure you have your SSH key set up BEFORE disabling password auth, or you'll lock yourself out.

### Firewall: UFW

```bash
# Reset to default (deny all incoming)
sudo ufw default deny incoming
sudo ufw default allow outgoing

# Allow SSH
sudo ufw allow 22/tcp

# Allow HTTP and HTTPS (for Caddy)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Enable
sudo ufw enable

# Check status
sudo ufw status verbose
```

That's it. Only ports 22, 80, and 443 are accessible from the internet. Everything else (Grafana, Prometheus, app containers) is only reachable through Caddy.

**Important:** Docker manipulates iptables directly and can bypass UFW. To prevent Docker from exposing container ports through the firewall, add to `/etc/docker/daemon.json`:

```json
{
  "iptables": false
}
```

However, this breaks Docker networking. The better approach: **never publish ports directly on app containers.** Only Caddy gets `-p 80:80 -p 443:443`. All other containers have no published ports and are only reachable on the Docker network.

### Fail2Ban: Brute Force Protection

```bash
sudo apt-get install -y fail2ban

sudo cat > /etc/fail2ban/jail.local << 'EOF'
[sshd]
enabled = true
port = 22
filter = sshd
logpath = /var/log/auth.log
maxretry = 5
bantime = 3600
findtime = 600
EOF

sudo systemctl enable fail2ban
sudo systemctl start fail2ban
```

This bans IPs that fail SSH login 5 times in 10 minutes for 1 hour.

### Automatic Security Updates

```bash
sudo apt-get install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
# Select "Yes" to enable automatic security updates
```

---

## 4. The Directory Structure for the Platform

```
/opt/platform/
├── apps/                              # Per-app data
│   ├── registry.json                  # App registry (all registered apps)
│   ├── myapp/
│   │   ├── .env                       # Environment variables (secrets)
│   │   ├── build.log                  # Latest build output
│   │   └── repo/                      # Cloned git repository
│   │       ├── Dockerfile
│   │       ├── package.json
│   │       └── src/
│   ├── go-api/
│   │   ├── .env
│   │   ├── build.log
│   │   └── repo/
│   └── react-site/
│       ├── .env
│       ├── build.log
│       └── repo/
│
├── caddy/                             # Reverse proxy config
│   ├── Caddyfile                      # Routing configuration
│   └── logs/                          # Caddy access logs
│
├── prometheus/                        # Metrics collection
│   ├── prometheus.yml                 # Scrape config
│   └── alerts.yml                     # Alert rules
│
├── loki/                              # Log aggregation
│   └── loki-config.yml
│
├── promtail/                          # Log shipping
│   └── promtail-config.yml
│
├── docker-compose.monitoring.yml      # Observability stack
│
├── backups/                           # Database dumps and volume backups
│   ├── postgres-20240115.sql.gz
│   └── vol-pgdata-20240115.tar.gz
│
└── scripts/                           # Operational scripts
    ├── backup.sh                      # Backup script (cron)
    ├── cleanup.sh                     # Docker cleanup (cron)
    └── setup.sh                       # Initial platform setup
```

### Create the Structure

```bash
sudo mkdir -p /opt/platform/{apps,caddy/logs,prometheus,loki,promtail,backups,scripts}
sudo chown -R $USER:$USER /opt/platform
chmod 750 /opt/platform
```

### File Permissions

```
/opt/platform/apps/*/.env   → 640 (owner read/write, group read)
/opt/platform/scripts/*.sh  → 750 (owner execute, group execute)
/opt/platform/caddy/        → 755
```

Environment files contain secrets. Never `chmod 777`. Never commit to git.

---

## 5. Managing Multiple Apps

### Naming Conventions

| Item | Convention | Example |
|---|---|---|
| Container name | Lowercase, hyphenated | `my-node-app` |
| Image name | `apps/<name>:<sha>` | `apps/my-node-app:a1b2c3d` |
| Subdomain | `<name>.yourdomain.com` | `my-node-app.yourdomain.com` |
| Env file path | `/opt/platform/apps/<name>/.env` | `/opt/platform/apps/my-node-app/.env` |
| Repo path | `/opt/platform/apps/<name>/repo/` | `/opt/platform/apps/my-node-app/repo/` |
| Docker label | `app=<name>` | `app=my-node-app` |

### Listing All Platform Containers

```bash
# All containers managed by the platform
docker ps --filter "label=platform=true" \
  --format "table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}"

# All apps with their resource usage
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}" \
  $(docker ps --filter "label=platform=true" -q)
```

### Per-App Operations

```bash
APP_NAME="myapp"

# View logs
docker logs --tail 100 -f $APP_NAME

# Get a shell
docker exec -it $APP_NAME sh

# Check health
docker inspect -f '{{.State.Health.Status}}' $APP_NAME

# See which image/commit is running
docker inspect -f '{{.Config.Image}}' $APP_NAME

# Restart
docker restart $APP_NAME

# Resource usage
docker stats --no-stream $APP_NAME
```

---

## 6. Keeping Docker Clean

### The Problem

Over time, Docker accumulates:
- Old images from previous deploys
- Stopped containers
- Unused volumes
- Build cache

On a VM with limited disk, this can consume 10s of gigabytes.

### Automated Cleanup Script

`/opt/platform/scripts/cleanup.sh`:

```bash
#!/bin/bash
set -euo pipefail

LOG_FILE="/opt/platform/backups/cleanup-$(date +%Y%m%d).log"

echo "=== Docker cleanup started at $(date) ===" | tee -a "$LOG_FILE"

# Show disk usage before
echo "Disk usage before:" | tee -a "$LOG_FILE"
docker system df | tee -a "$LOG_FILE"

# Remove stopped containers older than 24h
docker container prune -f --filter "until=24h" 2>&1 | tee -a "$LOG_FILE"

# Remove dangling images
docker image prune -f 2>&1 | tee -a "$LOG_FILE"

# Remove images not used by any container, older than 7 days
docker image prune -af --filter "until=168h" 2>&1 | tee -a "$LOG_FILE"

# Remove unused networks
docker network prune -f 2>&1 | tee -a "$LOG_FILE"

# Remove build cache older than 7 days
docker builder prune -f --filter "until=168h" 2>&1 | tee -a "$LOG_FILE"

# Show disk usage after
echo "Disk usage after:" | tee -a "$LOG_FILE"
docker system df | tee -a "$LOG_FILE"

echo "=== Cleanup complete at $(date) ===" | tee -a "$LOG_FILE"

# Clean old cleanup logs (keep 30 days)
find /opt/platform/backups -name "cleanup-*.log" -mtime +30 -delete
```

### Cron Schedule

```bash
# Add to crontab
crontab -e
```

```
# Docker cleanup — daily at 3 AM
0 3 * * * /opt/platform/scripts/cleanup.sh

# Backup — daily at 2 AM
0 2 * * * /opt/platform/scripts/backup.sh
```

### Keeping N Recent Images Per App

The cleanup script above removes images older than 7 days. For more control, keep exactly the N most recent images per app:

```bash
#!/bin/bash
KEEP=5  # Keep the 5 most recent images per app

for app_dir in /opt/platform/apps/*/; do
  app_name=$(basename "$app_dir")
  images=$(docker images "apps/${app_name}" --format "{{.Repository}}:{{.Tag}}" | tail -n +$((KEEP + 1)))
  for img in $images; do
    echo "Removing old image: $img"
    docker rmi "$img" 2>/dev/null || true
  done
done
```

---

## 7. Resource Limits — Preventing Starvation

On a single VM, one misbehaving app can consume all resources and crash everything. Resource limits prevent this.

### Memory Limits

```bash
docker run -d \
  --memory 512m \               # Hard limit: container is killed if it exceeds this
  --memory-reservation 256m \   # Soft limit: Docker tries to keep it under this
  myapp:v1
```

If the container tries to use more than 512MB:
1. The Linux OOM killer terminates a process inside the container
2. Docker logs: `container killed: OOM`
3. If `--restart unless-stopped` is set, Docker restarts the container

### CPU Limits

```bash
docker run -d \
  --cpus 1.0 \           # Limit to 1 CPU core equivalent
  --cpu-shares 512 \     # Relative weight (default: 1024)
  myapp:v1
```

- `--cpus 1.0` — hard limit. Even if the host is idle, this container can use at most 1 core.
- `--cpu-shares` — relative weight. If two containers compete for CPU, the one with higher shares gets more. Default is 1024.

### Recommended Limits for Our Platform

| Component | Memory | CPUs | Rationale |
|---|---|---|---|
| Caddy | 256M | 0.5 | Reverse proxy is lightweight |
| Webhook receiver | 256M | 0.5 | Build processes happen externally |
| Prometheus | 512M | 0.5 | Metrics storage |
| Grafana | 256M | 0.5 | Dashboard |
| Loki | 512M | 0.5 | Log storage |
| Promtail | 128M | 0.1 | Log shipping |
| cAdvisor | 256M | 0.25 | Metrics collection |
| Node Exporter | 128M | 0.1 | Host metrics |
| Per app (default) | 512M | 1.0 | Adjustable per app |
| PostgreSQL | 1G | 1.0 | Database needs more |
| Redis | 256M | 0.25 | Cache |

**Total infrastructure:** ~2.3GB RAM, ~3 CPU cores
**Remaining for apps:** On a 8GB/4-core VM, ~5GB RAM and ~1 core for apps. On a 16GB/8-core VM, plenty of headroom.

### Monitoring Resource Usage

```bash
# Live view of all containers
docker stats

# One-shot summary
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}"
```

---

## 8. Container Restart Policies

| Policy | Behavior | Use For |
|---|---|---|
| `no` | Never restart | One-off tasks, migrations |
| `on-failure:5` | Restart on non-zero exit, max 5 times | Apps during testing |
| `unless-stopped` | Always restart unless manually stopped | **App containers** |
| `always` | Always restart, even after manual stop | **Infrastructure** (Caddy, Prometheus) |

### How Restarts Work with System Reboots

When the VM reboots:
- Docker daemon starts (it's a systemd service)
- Containers with `always` or `unless-stopped` restart automatically
- Containers with `no` or `on-failure` stay stopped

Ensure Docker starts on boot:

```bash
sudo systemctl enable docker
```

### Detecting Restart Loops

A container that crashes and restarts repeatedly wastes resources and floods logs. Docker increases the delay between restarts exponentially (100ms, 200ms, 400ms, ... up to ~2 minutes).

Detect it:

```bash
# Check restart count
docker inspect -f '{{.RestartCount}}' myapp

# Check if container was OOM killed
docker inspect -f '{{.State.OOMKilled}}' myapp

# Prometheus alert (from Chapter 9)
# increase(container_restart_count{name="myapp"}[15m]) > 3
```

---

## 9. Updating the Platform Without Downtime

### Updating App Containers (Routine)

This happens on every deploy — covered in Chapter 8. The deploy service stops the old container and starts a new one. Brief interruption (milliseconds to seconds) with Caddy in front.

### Updating Infrastructure Containers

**Caddy:**
```bash
# Pull new image
docker pull caddy:2-alpine

# Stop and replace
docker stop caddy && docker rm caddy
docker run -d \
  --name caddy \
  --network platform \
  -p 80:80 -p 443:443 -p 443:443/udp \
  -v caddy_data:/data \
  -v caddy_config:/config \
  -v /opt/platform/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \
  --restart always \
  caddy:2-alpine

# Caddy starts, loads the Caddyfile, and resumes serving — downtime is seconds
```

**Observability stack:**
```bash
cd /opt/platform
docker compose -f docker-compose.monitoring.yml pull
docker compose -f docker-compose.monitoring.yml up -d
# Compose pulls new images and recreates changed containers
```

### Updating Docker Engine Itself

```bash
sudo apt-get update
sudo apt-get install --only-upgrade docker-ce docker-ce-cli containerd.io

# With live-restore enabled, containers keep running during the daemon restart
sudo systemctl restart docker

# Verify containers are still running
docker ps
```

The `live-restore: true` setting in `daemon.json` is critical. Without it, all containers stop when the daemon restarts.

---

## 10. Backing Up the Entire Platform

### What to Back Up

| Item | Location | Backup Method |
|---|---|---|
| App configs | `/opt/platform/apps/*/` (.env, registry.json) | File copy |
| Caddy config | `/opt/platform/caddy/Caddyfile` | File copy |
| Prometheus config | `/opt/platform/prometheus/` | File copy |
| Loki config | `/opt/platform/loki/` | File copy |
| Promtail config | `/opt/platform/promtail/` | File copy |
| Compose files | `/opt/platform/docker-compose.*.yml` | File copy |
| PostgreSQL data | `pgdata` volume | `pg_dumpall` |
| Caddy certificates | `caddy_data` volume | Volume tar backup |
| Grafana dashboards | `grafana_data` volume | Volume tar backup or Grafana API export |
| App repos | `/opt/platform/apps/*/repo/` | Already in git (no backup needed) |
| Docker images | Local image cache | Rebuild from git (no backup needed) |

### Backup Script

`/opt/platform/scripts/backup.sh`:

```bash
#!/bin/bash
set -euo pipefail

BACKUP_DIR="/opt/platform/backups"
DATE=$(date +%Y%m%d-%H%M%S)
RETENTION_DAYS=7

mkdir -p "$BACKUP_DIR"

echo "=== Backup started at $(date) ==="

# 1. Backup configs (excluding repos — they're in git)
echo "Backing up platform configs..."
tar czf "$BACKUP_DIR/configs-$DATE.tar.gz" \
  --exclude='*/repo' \
  --exclude='*/build.log' \
  -C /opt/platform \
  apps caddy prometheus loki promtail \
  docker-compose.monitoring.yml \
  scripts

# 2. Backup PostgreSQL (if running)
if docker ps -q -f name=postgres > /dev/null 2>&1; then
  echo "Backing up PostgreSQL..."
  docker exec postgres pg_dumpall -U postgres | gzip > "$BACKUP_DIR/postgres-$DATE.sql.gz"
fi

# 3. Backup critical volumes
for vol in caddy_data grafana_data; do
  echo "Backing up volume: $vol..."
  docker run --rm \
    -v "${vol}:/source:ro" \
    -v "$BACKUP_DIR:/backup" \
    alpine \
    tar czf "/backup/vol-${vol}-${DATE}.tar.gz" -C /source . 2>/dev/null || \
    echo "WARNING: Could not backup volume $vol (might not exist)"
done

# 4. Clean old backups
echo "Cleaning backups older than $RETENTION_DAYS days..."
find "$BACKUP_DIR" -type f -mtime +$RETENTION_DAYS -delete

# 5. Show backup sizes
echo ""
echo "Backup files:"
ls -lh "$BACKUP_DIR"/*$DATE* 2>/dev/null || echo "No files created"

echo ""
echo "=== Backup complete at $(date) ==="
```

### Offsite Backup

Local backups on the same VM don't protect against VM failure. Copy backups offsite:

```bash
# Rsync to a backup server
rsync -avz /opt/platform/backups/ backup-user@backup-server:/backups/platform/

# Or to S3-compatible storage
aws s3 sync /opt/platform/backups/ s3://your-bucket/platform-backups/
```

Add this to the backup script or as a separate cron job.

---

## 11. Disaster Recovery — Restoring on a New VM

If your VM dies, here's how to restore everything on a new one:

### Step 1: Set Up Docker on the New VM

Follow section 1 of this chapter. Same Ubuntu version, same Docker install.

### Step 2: Restore Configs

```bash
# Copy backup files to the new VM
scp backup-server:/backups/platform/configs-LATEST.tar.gz /tmp/

# Extract
cd /opt/platform
tar xzf /tmp/configs-LATEST.tar.gz
```

### Step 3: Create the Network

```bash
docker network create platform
```

### Step 4: Start Caddy

```bash
# Restore Caddy data (certificates)
docker volume create caddy_data
docker run --rm \
  -v caddy_data:/target \
  -v /tmp:/backup:ro \
  alpine \
  sh -c "cd /target && tar xzf /backup/vol-caddy_data-LATEST.tar.gz"

# Start Caddy
docker run -d \
  --name caddy \
  --network platform \
  -p 80:80 -p 443:443 -p 443:443/udp \
  -v caddy_data:/data \
  -v caddy_config:/config \
  -v /opt/platform/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \
  --restart always \
  caddy:2-alpine
```

### Step 5: Restore PostgreSQL

```bash
docker run -d \
  --name postgres \
  --network platform \
  -v pgdata:/var/lib/postgresql/data \
  -e POSTGRES_PASSWORD=your-password \
  --restart unless-stopped \
  postgres:16-alpine

# Wait for PostgreSQL to be ready
sleep 10

# Restore the dump
gunzip -c /tmp/postgres-LATEST.sql.gz | docker exec -i postgres psql -U postgres
```

### Step 6: Rebuild and Deploy Apps

```bash
# For each app in the registry
for app_dir in /opt/platform/apps/*/; do
  app_name=$(basename "$app_dir")
  repo_dir="$app_dir/repo"

  # Clone the repo (since repo directories aren't backed up — they're in git)
  # Read repo URL from registry.json
  repo_url=$(jq -r ".[] | select(.name==\"$app_name\") | .repo_url" /opt/platform/apps/registry.json)
  branch=$(jq -r ".[] | select(.name==\"$app_name\") | .branch" /opt/platform/apps/registry.json)

  git clone --depth 1 --branch "$branch" "$repo_url" "$repo_dir"

  # Build and run
  sha=$(git -C "$repo_dir" rev-parse --short HEAD)
  docker build -t "apps/${app_name}:${sha}" "$repo_dir"
  docker run -d \
    --name "$app_name" \
    --network platform \
    --restart unless-stopped \
    --env-file "$app_dir/.env" \
    -l platform=true \
    -l "app=$app_name" \
    "apps/${app_name}:${sha}"
done
```

### Step 7: Start the Monitoring Stack

```bash
cd /opt/platform
docker compose -f docker-compose.monitoring.yml up -d
```

### Step 8: Restore Grafana Dashboards

```bash
docker volume create grafana_data
docker run --rm \
  -v grafana_data:/target \
  -v /tmp:/backup:ro \
  alpine \
  sh -c "cd /target && tar xzf /backup/vol-grafana_data-LATEST.tar.gz"

docker restart grafana
```

### Step 9: Update DNS

If the new VM has a different IP, update your DNS A records to point to the new IP.

### Recovery Time Estimate

| Step | Time |
|---|---|
| Provision new VM | 2-5 minutes |
| Install Docker | 3-5 minutes |
| Restore configs | 1 minute |
| Start Caddy + restore certs | 2 minutes |
| Restore PostgreSQL | 2-10 minutes (depends on DB size) |
| Rebuild all apps | 5-15 minutes (depends on number of apps) |
| Start monitoring | 2 minutes |
| DNS propagation | 5-60 minutes |
| **Total** | **~20-45 minutes** |

---

## 12. Common Production Incidents and Debugging

### Incident: Disk Full

**Symptoms:** Builds fail, containers can't start, `no space left on device` errors.

**Debug:**
```bash
df -h                     # Check host disk usage
docker system df          # Check Docker disk usage
du -sh /var/lib/docker/*  # What's taking space in Docker
```

**Fix:**
```bash
# Emergency cleanup
docker system prune -af   # Remove all unused images, containers, networks
docker volume prune -f     # Remove unused volumes (CAREFUL: data loss!)

# If /var/log is full
sudo journalctl --vacuum-size=100M
```

**Prevent:** The cron cleanup script from section 6.

### Incident: Container OOM Killed

**Symptoms:** Container restarts frequently. Application hangs then crashes.

**Debug:**
```bash
docker inspect -f '{{.State.OOMKilled}}' myapp
# true

docker logs myapp | tail -50
# Look for memory-related errors before the kill

docker stats --no-stream myapp
# Check current memory usage vs limit
```

**Fix:** Increase the memory limit or fix the memory leak in the application:
```bash
docker update --memory 1g myapp
# Or redeploy with higher limit
```

### Incident: Container Can't Start — Port Conflict

**Symptoms:** `Error: port is already allocated`

**Debug:**
```bash
docker ps -a | grep "8080"     # What's using the port?
sudo ss -tlnp | grep "8080"   # Is a host process using it?
```

**Fix:** Stop the conflicting container or use a different port.

### Incident: Can't Pull Images — Docker Hub Rate Limit

**Symptoms:** `toomanyrequests: You have reached your pull rate limit`

**Fix:**
```bash
# Log in to Docker Hub (authenticated pulls have higher limits)
docker login

# Or use a mirror
# Add to /etc/docker/daemon.json:
# "registry-mirrors": ["https://mirror.gcr.io"]
```

### Incident: Container Network Connectivity Lost

**Symptoms:** Containers can't reach each other. DNS resolution fails.

**Debug:**
```bash
# Check if containers are on the same network
docker network inspect platform

# Test connectivity from inside a container
docker run --rm --network platform alpine ping -c 3 myapp

# Check Docker's iptables rules
sudo iptables -L -n | grep DOCKER
```

**Fix:**
```bash
# Restart Docker networking
sudo systemctl restart docker

# Or recreate the network (requires restarting all containers)
docker network rm platform
docker network create platform
# Restart all containers with --network platform
```

### Incident: SSL Certificate Not Working

**Symptoms:** Browser shows certificate error.

**Debug:**
```bash
# Check Caddy logs
docker logs caddy | grep -i "certificate\|error\|tls"

# Check if the domain resolves to your VM
dig +short myapp.yourdomain.com
# Should return your VM's IP

# Check if port 80 is accessible (needed for ACME challenge)
curl -I http://myapp.yourdomain.com/.well-known/acme-challenge/test
```

**Common causes:**
1. DNS not pointing to VM → Fix DNS A record
2. Port 80 blocked by firewall → `sudo ufw allow 80/tcp`
3. Caddy data volume lost → Caddy will re-obtain certs (may hit rate limits)

### Incident: High CPU on the VM

**Debug:**
```bash
# Which containers are using the most CPU?
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}" | sort -k2 -t'%' -rn

# Host-level CPU usage
top -o %CPU

# Check for a build running (docker build uses lots of CPU)
docker ps | grep "build"
```

**Fix:** Set CPU limits on the misbehaving container:
```bash
docker update --cpus 0.5 myapp
```

---

## Summary

Running a deployment platform in production on a single VM requires:

- **Proper Docker installation** with production settings (log rotation, live restore, overlay2).
- **Security hardening** — SSH keys only, UFW firewall (only 22/80/443), fail2ban, auto-updates.
- **Organized directory structure** under `/opt/platform/` with clear separation of configs, repos, and data.
- **Resource limits** on every container to prevent starvation.
- **Automated cleanup** via cron to prevent disk exhaustion.
- **Restart policies** (`unless-stopped` for apps, `always` for infrastructure).
- **Regular backups** of configs, database dumps, and critical volumes. Offsite copies.
- **Disaster recovery plan** — tested procedure to restore on a new VM in under an hour.
- **Monitoring** (Chapter 9) to catch problems before users do.

In Chapter 11, we'll bring everything together into the complete, working platform.

---

→ next: [chapter11_complete_platform.md](chapter11_complete_platform.md)
