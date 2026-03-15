# Chapter 11 — Putting It All Together: The Complete Platform

---

## Table of Contents

1. [What the Platform Does](#1-what-the-platform-does)
2. [Full Directory Structure](#2-full-directory-structure)
3. [Platform Setup Script](#3-platform-setup-script)
4. [The Webhook Receiver Service — Complete Code](#4-the-webhook-receiver-service--complete-code)
5. [The Caddy Configuration and Update Logic](#5-the-caddy-configuration-and-update-logic)
6. [The Observability Stack — Complete Compose File](#6-the-observability-stack--complete-compose-file)
7. [Sample App: Deploying a Node.js Service](#7-sample-app-deploying-a-nodejs-service)
8. [Sample App: Deploying a Go Service](#8-sample-app-deploying-a-go-service)
9. [End-to-End Walkthrough: Adding a New App](#9-end-to-end-walkthrough-adding-a-new-app)
10. [Rolling Back a Bad Deploy](#10-rolling-back-a-bad-deploy)
11. [Platform Operations Runbook](#11-platform-operations-runbook)

---

## 1. What the Platform Does

Here is the complete system we've built across the previous 10 chapters:

```
┌──────────────────────────────────────────────────────────────────────────┐
│                              YOUR VM                                      │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │                       Docker Network: "platform"                    │  │
│  │                                                                     │  │
│  │  ┌──────────────────────────────────────────────────────────────┐   │  │
│  │  │                  REVERSE PROXY (Caddy)                       │   │  │
│  │  │  - Receives all HTTP/HTTPS traffic                          │   │  │
│  │  │  - Routes by domain → container                             │   │  │
│  │  │  - Auto SSL via Let's Encrypt                               │   │  │
│  │  │  - Ports: 80, 443 (only exposed ports on the VM)            │   │  │
│  │  └──────────────────────────────────────────────────────────────┘   │  │
│  │         │                │                │               │         │  │
│  │  ┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐  │  │
│  │  │  App: todo  │ │ App: go-api │ │ App: blog   │ │  Grafana    │  │  │
│  │  │  (Node.js)  │ │   (Go)     │ │ (React SPA) │ │ (dashboard) │  │  │
│  │  │  :3000      │ │  :8080     │ │  :80        │ │  :3000      │  │  │
│  │  └─────────────┘ └────────────┘ └─────────────┘ └─────────────┘  │  │
│  │                                                                     │  │
│  │  ┌─────────────────┐  ┌─────────────┐  ┌────────────────────────┐  │  │
│  │  │ Webhook Receiver │  │ PostgreSQL  │  │  Observability Stack   │  │  │
│  │  │   (Go :9000)     │  │   :5432     │  │  Prometheus+cAdvisor   │  │  │
│  │  │   Builds & deps  │  │   (pgdata)  │  │  Loki+Promtail         │  │  │
│  │  └─────────────────┘  └─────────────┘  │  Node Exporter          │  │  │
│  │                                         └────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  Firewall: UFW (only 22, 80, 443 open)                                   │
│  Cron: backup.sh at 2AM, cleanup.sh at 3AM                               │
│                                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

**Capabilities:**
- Accept git push webhooks from GitHub/GitLab
- Automatically build a Docker image from the pushed code
- Deploy it as a container on the VM
- Update Caddy to route `appname.yourdomain.com` → new container
- Stream build and runtime logs to Grafana (via Loki)
- Show per-app CPU/memory metrics in Grafana (via Prometheus + cAdvisor)
- Support any language/stack (as long as it has a Dockerfile)
- Roll back to previous versions instantly

---

## 2. Full Directory Structure

```
/opt/platform/
│
├── apps/                                     # App data and repos
│   ├── registry.json                         # All registered apps
│   ├── todo-app/
│   │   ├── .env                              # NODE_ENV=production, DB_URL=...
│   │   ├── build.log                         # Latest build output
│   │   └── repo/                             # Cloned from GitHub
│   │       ├── Dockerfile
│   │       ├── package.json
│   │       └── src/
│   └── go-api/
│       ├── .env
│       ├── build.log
│       └── repo/
│           ├── Dockerfile
│           ├── go.mod
│           └── cmd/
│
├── webhook-receiver/                         # Deploy service source
│   ├── main.go
│   ├── deploy.go
│   ├── caddy.go
│   ├── config.go
│   ├── go.mod
│   ├── go.sum
│   └── Dockerfile
│
├── caddy/
│   ├── Caddyfile                             # Routing config
│   └── logs/                                 # Access logs
│
├── prometheus/
│   ├── prometheus.yml                        # Scrape config
│   └── alerts.yml                            # Alert rules
│
├── loki/
│   └── loki-config.yml                       # Log storage config
│
├── promtail/
│   └── promtail-config.yml                   # Log shipping config
│
├── docker-compose.monitoring.yml             # Observability stack
│
├── backups/                                  # Automated backups
│
└── scripts/
    ├── setup.sh                              # One-time platform setup
    ├── backup.sh                             # Daily backup (cron)
    ├── cleanup.sh                            # Daily Docker cleanup (cron)
    └── add-app.sh                            # Register a new app
```

---

## 3. Platform Setup Script

Run this once on a fresh Ubuntu VM to set up the entire platform:

`/opt/platform/scripts/setup.sh`:

```bash
#!/bin/bash
set -euo pipefail

PLATFORM_DOMAIN="${1:?Usage: setup.sh <yourdomain.com>}"
WEBHOOK_SECRET="${2:?Usage: setup.sh <domain> <webhook-secret>}"
GRAFANA_PASSWORD="${3:-changeme}"

echo "========================================"
echo " Setting up deployment platform"
echo " Domain: ${PLATFORM_DOMAIN}"
echo "========================================"

# ─── 1. Create directory structure ─────────────────────────
echo "Creating directory structure..."
sudo mkdir -p /opt/platform/{apps,webhook-receiver,caddy/logs,prometheus,loki,promtail,backups,scripts}
sudo chown -R "$USER:$USER" /opt/platform
chmod 750 /opt/platform

# ─── 2. Create Docker network ─────────────────────────────
echo "Creating Docker network..."
docker network create platform 2>/dev/null || echo "Network 'platform' already exists"

# ─── 3. Initialize app registry ───────────────────────────
if [ ! -f /opt/platform/apps/registry.json ]; then
  echo "[]" > /opt/platform/apps/registry.json
fi

# ─── 4. Write Caddyfile ───────────────────────────────────
echo "Writing Caddyfile..."
cat > /opt/platform/caddy/Caddyfile << EOF
{
    email admin@${PLATFORM_DOMAIN}
    admin 0.0.0.0:2019
}

dashboard.${PLATFORM_DOMAIN} {
    reverse_proxy grafana:3000
}

deploy.${PLATFORM_DOMAIN} {
    reverse_proxy webhook-receiver:9000
}
EOF

# ─── 5. Write Prometheus config ───────────────────────────
echo "Writing Prometheus config..."
cat > /opt/platform/prometheus/prometheus.yml << 'EOF'
global:
  scrape_interval: 15s
  evaluation_interval: 15s

rule_files:
  - /etc/prometheus/alerts.yml

scrape_configs:
  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']

  - job_name: 'cadvisor'
    static_configs:
      - targets: ['cadvisor:8080']

  - job_name: 'node'
    static_configs:
      - targets: ['node-exporter:9100']
EOF

cat > /opt/platform/prometheus/alerts.yml << 'EOF'
groups:
  - name: platform_alerts
    rules:
      - alert: ContainerOOMKilled
        expr: increase(container_oom_events_total{name!=""}[5m]) > 0
        labels:
          severity: critical
        annotations:
          summary: "Container {{ $labels.name }} was OOM killed"

      - alert: ContainerRestartLoop
        expr: increase(container_restart_count{name!=""}[15m]) > 3
        labels:
          severity: critical
        annotations:
          summary: "Container {{ $labels.name }} restarting frequently"

      - alert: HighMemoryUsage
        expr: (container_memory_usage_bytes{name!=""} / container_spec_memory_limit_bytes{name!=""}) > 0.9
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Container {{ $labels.name }} using >90% memory"

      - alert: DiskSpaceLow
        expr: (node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}) < 0.15
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Disk space below 15%"
EOF

# ─── 6. Write Loki config ─────────────────────────────────
echo "Writing Loki config..."
cat > /opt/platform/loki/loki-config.yml << 'EOF'
auth_enabled: false

server:
  http_listen_port: 3100

common:
  path_prefix: /loki
  storage:
    filesystem:
      chunks_directory: /loki/chunks
      rules_directory: /loki/rules
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory

schema_config:
  configs:
    - from: 2024-01-01
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h

limits_config:
  retention_period: 168h

compactor:
  working_directory: /loki/compactor
  compaction_interval: 5m
  retention_enabled: true
  retention_delete_delay: 2h
EOF

# ─── 7. Write Promtail config ─────────────────────────────
echo "Writing Promtail config..."
cat > /opt/platform/promtail/promtail-config.yml << 'EOF'
server:
  http_listen_port: 9080

positions:
  filename: /tmp/positions.yaml

clients:
  - url: http://loki:3100/loki/api/v1/push

scrape_configs:
  - job_name: docker
    docker_sd_configs:
      - host: unix:///var/run/docker.sock
        refresh_interval: 15s

    relabel_configs:
      - source_labels: ['__meta_docker_container_name']
        regex: '/(.*)'
        target_label: 'container'
      - source_labels: ['__meta_docker_container_label_app']
        target_label: 'app'
      - source_labels: ['__meta_docker_container_label_deploy_sha']
        target_label: 'deploy_sha'

    pipeline_stages:
      - docker: {}
EOF

# ─── 8. Write monitoring Compose file ─────────────────────
echo "Writing monitoring Compose file..."
cat > /opt/platform/docker-compose.monitoring.yml << 'EOF'
services:
  prometheus:
    image: prom/prometheus:v2.49.1
    container_name: prometheus
    restart: unless-stopped
    networks:
      - platform
    volumes:
      - prometheus_data:/prometheus
      - /opt/platform/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - /opt/platform/prometheus/alerts.yml:/etc/prometheus/alerts.yml:ro
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
      - '--storage.tsdb.retention.time=30d'
      - '--web.enable-lifecycle'
    deploy:
      resources:
        limits:
          memory: 512M
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:9090/-/healthy"]
      interval: 30s
      timeout: 10s
      retries: 3
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

  cadvisor:
    image: gcr.io/cadvisor/cadvisor:v0.49.1
    container_name: cadvisor
    restart: unless-stopped
    networks:
      - platform
    volumes:
      - /:/rootfs:ro
      - /var/run:/var/run:ro
      - /sys:/sys:ro
      - /var/lib/docker/:/var/lib/docker:ro
      - /dev/disk/:/dev/disk:ro
    privileged: true
    devices:
      - /dev/kmsg
    deploy:
      resources:
        limits:
          memory: 256M
    logging:
      driver: json-file
      options:
        max-size: "5m"
        max-file: "3"

  node-exporter:
    image: prom/node-exporter:v1.7.0
    container_name: node-exporter
    restart: unless-stopped
    networks:
      - platform
    command:
      - '--path.rootfs=/host'
      - '--collector.filesystem.mount-points-exclude=^/(sys|proc|dev|host|etc)($$|/)'
    volumes:
      - /:/host:ro,rslave
    deploy:
      resources:
        limits:
          memory: 128M
    logging:
      driver: json-file
      options:
        max-size: "5m"
        max-file: "3"

  loki:
    image: grafana/loki:2.9.3
    container_name: loki
    restart: unless-stopped
    networks:
      - platform
    volumes:
      - loki_data:/loki
      - /opt/platform/loki/loki-config.yml:/etc/loki/local-config.yaml:ro
    command: -config.file=/etc/loki/local-config.yaml
    deploy:
      resources:
        limits:
          memory: 512M
    healthcheck:
      test: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:3100/ready || exit 1"]
      interval: 30s
      timeout: 10s
      retries: 3
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

  promtail:
    image: grafana/promtail:2.9.3
    container_name: promtail
    restart: unless-stopped
    networks:
      - platform
    volumes:
      - /opt/platform/promtail/promtail-config.yml:/etc/promtail/config.yml:ro
      - /var/lib/docker/containers:/var/lib/docker/containers:ro
      - /var/run/docker.sock:/var/run/docker.sock:ro
    command: -config.file=/etc/promtail/config.yml
    depends_on:
      loki:
        condition: service_healthy
    deploy:
      resources:
        limits:
          memory: 128M
    logging:
      driver: json-file
      options:
        max-size: "5m"
        max-file: "3"

  grafana:
    image: grafana/grafana:10.2.3
    container_name: grafana
    restart: unless-stopped
    networks:
      - platform
    volumes:
      - grafana_data:/var/lib/grafana
    environment:
      - GF_SECURITY_ADMIN_USER=admin
      - GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_PASSWORD:-changeme}
      - GF_USERS_ALLOW_SIGN_UP=false
    depends_on:
      prometheus:
        condition: service_healthy
      loki:
        condition: service_healthy
    deploy:
      resources:
        limits:
          memory: 256M
    healthcheck:
      test: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1"]
      interval: 30s
      timeout: 10s
      retries: 3
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

networks:
  platform:
    external: true

volumes:
  prometheus_data:
  loki_data:
  grafana_data:
EOF

# ─── 9. Start Caddy ───────────────────────────────────────
echo "Starting Caddy..."
docker run -d \
  --name caddy \
  --network platform \
  -p 80:80 \
  -p 443:443 \
  -p 443:443/udp \
  -v caddy_data:/data \
  -v caddy_config:/config \
  -v /opt/platform/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \
  -v /opt/platform/caddy/logs:/var/log/caddy \
  --restart always \
  -l platform=true \
  -l app=caddy \
  caddy:2-alpine

# ─── 10. Start monitoring stack ───────────────────────────
echo "Starting monitoring stack..."
cd /opt/platform
GRAFANA_PASSWORD="${GRAFANA_PASSWORD}" \
  docker compose -f docker-compose.monitoring.yml up -d

# ─── 11. Build and start webhook receiver ─────────────────
echo "Building webhook receiver..."
cd /opt/platform/webhook-receiver

# Create a minimal webhook receiver if source doesn't exist yet
if [ ! -f main.go ]; then
  echo "Webhook receiver source not found at /opt/platform/webhook-receiver/"
  echo "Please copy the webhook receiver source files from Chapter 8, then run:"
  echo "  cd /opt/platform/webhook-receiver && docker build -t webhook-receiver:latest ."
  echo "  docker run -d --name webhook-receiver --network platform \\"
  echo "    -v /var/run/docker.sock:/var/run/docker.sock \\"
  echo "    -v /opt/platform:/opt/platform \\"
  echo "    -e WEBHOOK_SECRET=${WEBHOOK_SECRET} \\"
  echo "    -e PLATFORM_DOMAIN=${PLATFORM_DOMAIN} \\"
  echo "    --restart always \\"
  echo "    -l platform=true -l app=webhook-receiver \\"
  echo "    webhook-receiver:latest"
else
  docker build -t webhook-receiver:latest .
  docker run -d \
    --name webhook-receiver \
    --network platform \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v /opt/platform:/opt/platform \
    -e WEBHOOK_SECRET="${WEBHOOK_SECRET}" \
    -e PLATFORM_DOMAIN="${PLATFORM_DOMAIN}" \
    --restart always \
    -l platform=true \
    -l app=webhook-receiver \
    webhook-receiver:latest
fi

# ─── 12. Set up cron jobs ─────────────────────────────────
echo "Setting up cron jobs..."
(crontab -l 2>/dev/null; echo "0 2 * * * /opt/platform/scripts/backup.sh >> /opt/platform/backups/backup-cron.log 2>&1") | sort -u | crontab -
(crontab -l 2>/dev/null; echo "0 3 * * * /opt/platform/scripts/cleanup.sh >> /opt/platform/backups/cleanup-cron.log 2>&1") | sort -u | crontab -

# ─── 13. Summary ──────────────────────────────────────────
echo ""
echo "========================================"
echo " Platform setup complete!"
echo "========================================"
echo ""
echo " Services running:"
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" --filter "label=platform=true"
echo ""
echo " URLs:"
echo "   Dashboard:  https://dashboard.${PLATFORM_DOMAIN}"
echo "   Webhooks:   https://deploy.${PLATFORM_DOMAIN}/webhook/github"
echo "   Health:     https://deploy.${PLATFORM_DOMAIN}/health"
echo ""
echo " Next steps:"
echo "   1. Point DNS A records to this VM's IP for:"
echo "      - ${PLATFORM_DOMAIN}"
echo "      - *.${PLATFORM_DOMAIN}"
echo "   2. Configure Grafana data sources (Prometheus + Loki)"
echo "   3. Register your first app with add-app.sh"
echo ""
```

---

## 4. The Webhook Receiver Service — Complete Code

The complete webhook receiver was detailed in Chapter 8. Here's the `caddy.go` file that handles Caddy config updates — the final piece:

### caddy.go — Caddy Config Management

```go
package main

import (
	"bytes"
	"fmt"
	"net/http"
	"os"
	"strings"
	"text/template"
)

const appRouteTemplate = `
{{.Domain}} {
    encode gzip

    reverse_proxy {{.ContainerName}}:{{.Port}} {
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }

    log {
        output file /var/log/caddy/{{.Name}}.log {
            roll_size 10mb
            roll_keep 5
        }
        format json
    }
}
`

type CaddyRouteData struct {
	Name          string
	Domain        string
	ContainerName string
	Port          int
}

func (d *Deployer) updateCaddyConfig(app *AppConfig) error {
	domain := app.Domain
	if domain == "" {
		domain = fmt.Sprintf("%s.%s", app.Name, d.config.PlatformDomain)
	}

	routeData := CaddyRouteData{
		Name:          app.Name,
		Domain:        domain,
		ContainerName: app.Name,
		Port:          app.Port,
	}

	tmpl, err := template.New("route").Parse(appRouteTemplate)
	if err != nil {
		return fmt.Errorf("template parse error: %w", err)
	}

	var routeBlock bytes.Buffer
	if err := tmpl.Execute(&routeBlock, routeData); err != nil {
		return fmt.Errorf("template execute error: %w", err)
	}

	caddyfileContent, err := os.ReadFile(d.config.CaddyfilePath)
	if err != nil {
		return fmt.Errorf("failed to read Caddyfile: %w", err)
	}

	content := string(caddyfileContent)
	marker := fmt.Sprintf("# --- app:%s ---", app.Name)
	endMarker := fmt.Sprintf("# --- end:%s ---", app.Name)

	newBlock := fmt.Sprintf("%s\n%s%s\n", marker, routeBlock.String(), endMarker)

	if strings.Contains(content, marker) {
		startIdx := strings.Index(content, marker)
		endIdx := strings.Index(content, endMarker)
		if endIdx > startIdx {
			endIdx += len(endMarker)
			content = content[:startIdx] + newBlock + content[endIdx:]
		}
	} else {
		content = content + "\n" + newBlock
	}

	if err := os.WriteFile(d.config.CaddyfilePath, []byte(content), 0644); err != nil {
		return fmt.Errorf("failed to write Caddyfile: %w", err)
	}

	return d.reloadCaddy(content)
}

func (d *Deployer) removeCaddyRoute(appName string) error {
	caddyfileContent, err := os.ReadFile(d.config.CaddyfilePath)
	if err != nil {
		return fmt.Errorf("failed to read Caddyfile: %w", err)
	}

	content := string(caddyfileContent)
	marker := fmt.Sprintf("# --- app:%s ---", appName)
	endMarker := fmt.Sprintf("# --- end:%s ---", appName)

	if strings.Contains(content, marker) {
		startIdx := strings.Index(content, marker)
		endIdx := strings.Index(content, endMarker)
		if endIdx > startIdx {
			endIdx += len(endMarker) + 1
			content = content[:startIdx] + content[endIdx:]
		}
	}

	if err := os.WriteFile(d.config.CaddyfilePath, []byte(content), 0644); err != nil {
		return fmt.Errorf("failed to write Caddyfile: %w", err)
	}

	return d.reloadCaddy(content)
}

func (d *Deployer) reloadCaddy(caddyfileContent string) error {
	url := fmt.Sprintf("%s/load", d.config.CaddyAdminURL)
	req, err := http.NewRequest("POST", url, strings.NewReader(caddyfileContent))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "text/caddyfile")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to reload Caddy: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("Caddy reload returned status %d", resp.StatusCode)
	}

	return nil
}
```

### Webhook Receiver go.mod

```
module webhook-receiver

go 1.22
```

### Webhook Receiver Dockerfile

```dockerfile
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum* ./
RUN go mod download 2>/dev/null || true
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o webhook-receiver .

FROM alpine:3.19
RUN apk add --no-cache ca-certificates git docker-cli
COPY --from=builder /app/webhook-receiver /usr/local/bin/webhook-receiver
EXPOSE 9000
CMD ["webhook-receiver"]
```

---

## 5. The Caddy Configuration and Update Logic

### How Caddy Config Evolves

When the platform starts, the Caddyfile has only infrastructure routes:

```
{
    email admin@yourdomain.com
    admin 0.0.0.0:2019
}

dashboard.yourdomain.com {
    reverse_proxy grafana:3000
}

deploy.yourdomain.com {
    reverse_proxy webhook-receiver:9000
}
```

After deploying `todo-app` and `go-api`, the deploy service appends route blocks:

```
{
    email admin@yourdomain.com
    admin 0.0.0.0:2019
}

dashboard.yourdomain.com {
    reverse_proxy grafana:3000
}

deploy.yourdomain.com {
    reverse_proxy webhook-receiver:9000
}

# --- app:todo-app ---
todo-app.yourdomain.com {
    encode gzip

    reverse_proxy todo-app:3000 {
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }

    log {
        output file /var/log/caddy/todo-app.log {
            roll_size 10mb
            roll_keep 5
        }
        format json
    }
}
# --- end:todo-app ---

# --- app:go-api ---
go-api.yourdomain.com {
    encode gzip

    reverse_proxy go-api:8080 {
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }

    log {
        output file /var/log/caddy/go-api.log {
            roll_size 10mb
            roll_keep 5
        }
        format json
    }
}
# --- end:go-api ---
```

The markers (`# --- app:name ---` / `# --- end:name ---`) let the deploy service find and replace existing routes when redeploying.

---

## 6. The Observability Stack — Complete Compose File

This was fully defined in Chapter 9 and included in the setup script above. It's at `/opt/platform/docker-compose.monitoring.yml`.

After starting, configure Grafana:

1. Open `https://dashboard.yourdomain.com`
2. Login with admin / your-password
3. Go to Connections → Data Sources → Add
4. Add **Prometheus**: URL = `http://prometheus:9090`, set as default
5. Add **Loki**: URL = `http://loki:3100`
6. Import dashboards:
   - Docker/cAdvisor dashboard: Import ID `14282` (popular community dashboard)
   - Create custom panels as described in Chapter 9

---

## 7. Sample App: Deploying a Node.js Service

### The App

A simple Express.js TODO API with PostgreSQL:

**Dockerfile:**

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-alpine
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
ENV NODE_ENV=production
USER app
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

### Register It

```bash
# Create app directory and env file
mkdir -p /opt/platform/apps/todo-app
cat > /opt/platform/apps/todo-app/.env << 'EOF'
NODE_ENV=production
PORT=3000
DATABASE_URL=postgres://todouser:todopass@postgres:5432/tododb
EOF

# Add to registry
cat > /opt/platform/apps/registry.json << 'EOF'
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
EOF
```

### Set Up GitHub Webhook

1. Go to `https://github.com/youruser/todo-app/settings/hooks`
2. Add webhook:
   - Payload URL: `https://deploy.yourdomain.com/webhook/github`
   - Content type: `application/json`
   - Secret: same as `WEBHOOK_SECRET`
   - Events: Just the push event

### Deploy

```bash
git push origin main
```

What happens:
1. GitHub sends webhook to `deploy.yourdomain.com/webhook/github`
2. Webhook receiver verifies the signature
3. Clones the repo to `/opt/platform/apps/todo-app/repo/`
4. Runs `docker build -t apps/todo-app:a1b2c3d .`
5. Runs `docker run -d --name todo-app --network platform --memory 256m --cpus 0.5 --env-file /opt/platform/apps/todo-app/.env apps/todo-app:a1b2c3d`
6. Updates the Caddyfile with a route for `todo-app.yourdomain.com`
7. Reloads Caddy via the admin API
8. Caddy obtains an SSL certificate for `todo-app.yourdomain.com`
9. App is live at `https://todo-app.yourdomain.com`

---

## 8. Sample App: Deploying a Go Service

### The App

A Go REST API:

**Dockerfile:**

```dockerfile
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o server ./cmd/server

FROM alpine:3.19
RUN apk add --no-cache ca-certificates tzdata
RUN addgroup -S app && adduser -S app -G app
COPY --from=builder /app/server /usr/local/bin/server
USER app
EXPOSE 8080
CMD ["server"]
```

### Register and Deploy

```bash
# Register
mkdir -p /opt/platform/apps/go-api
cat > /opt/platform/apps/go-api/.env << 'EOF'
PORT=8080
DATABASE_URL=postgres://apiuser:apipass@postgres:5432/apidb
EOF

# Update registry.json to include the new app
# Then set up GitHub webhook and push
```

Same flow. The platform doesn't care what language the app uses — it just needs a Dockerfile.

---

## 9. End-to-End Walkthrough: Adding a New App

Here's the complete checklist for adding a new app to the platform:

### Step 1: Ensure the App Has a Dockerfile

The app's git repository must contain a `Dockerfile` in the root. It can use any base image, any language, any build process. The only requirements:
- The final image must have a process that listens on a port
- The port should be configurable via an environment variable

### Step 2: Register the App

```bash
# Create the app directory
APP_NAME="my-new-app"
mkdir -p /opt/platform/apps/${APP_NAME}

# Create the environment file with app-specific secrets
cat > /opt/platform/apps/${APP_NAME}/.env << EOF
PORT=3000
DATABASE_URL=postgres://user:pass@postgres:5432/mydb
# Add any other environment variables the app needs
EOF
chmod 640 /opt/platform/apps/${APP_NAME}/.env

# Add to the app registry (edit registry.json)
# Use jq or edit manually:
python3 -c "
import json
with open('/opt/platform/apps/registry.json', 'r') as f:
    apps = json.load(f)
apps.append({
    'name': '${APP_NAME}',
    'repo_url': 'https://github.com/youruser/${APP_NAME}.git',
    'branch': 'main',
    'port': 3000,
    'memory_mb': 512,
    'cpus': '1.0'
})
with open('/opt/platform/apps/registry.json', 'w') as f:
    json.dump(apps, f, indent=2)
"
```

### Step 3: Set Up the GitHub Webhook

In the GitHub repository:
1. Settings → Webhooks → Add webhook
2. Payload URL: `https://deploy.yourdomain.com/webhook/github`
3. Content type: `application/json`
4. Secret: your `WEBHOOK_SECRET`
5. Which events: Just the push event
6. Active: checked

### Step 4: Set Up DNS (If Not Using Wildcard)

Add a DNS A record:
```
my-new-app.yourdomain.com → YOUR_VM_IP
```

If you have a wildcard record (`*.yourdomain.com → YOUR_VM_IP`), this step is automatic.

### Step 5: Push and Deploy

```bash
cd my-new-app/
git push origin main
```

The platform handles everything from here.

### Step 6: Verify

```bash
# Check the container is running
docker ps --filter "name=my-new-app"

# Check the build logs
curl https://deploy.yourdomain.com/apps/my-new-app/logs

# Test the app
curl https://my-new-app.yourdomain.com/health

# Check in Grafana
# Go to https://dashboard.yourdomain.com
# - Look for the container in metrics panels
# - Query logs: {app="my-new-app"}
```

---

## 10. Rolling Back a Bad Deploy

### Automatic Rollback

The deploy service automatically rolls back if:
1. The Docker build fails (old container keeps running)
2. The new container fails to start (rolls back to previous image)
3. The new container fails the health check (rolls back to previous image)

### Manual Rollback

If the automated health check passes but the app is broken in a way the health check doesn't catch:

```bash
APP_NAME="my-new-app"

# List available image tags (most recent first)
docker images "apps/${APP_NAME}" --format "table {{.Tag}}\t{{.CreatedAt}}\t{{.Size}}"
# TAG       CREATED AT               SIZE
# a1b2c3d   2024-01-15 10:30:00      152MB   ← current (broken)
# d4e5f6g   2024-01-14 15:20:00      150MB   ← previous (working)
# h7i8j9k   2024-01-13 09:10:00      155MB   ← two deploys ago

# Roll back to the previous version
ROLLBACK_TAG="d4e5f6g"
docker stop ${APP_NAME}
docker rm ${APP_NAME}
docker run -d \
  --name ${APP_NAME} \
  --network platform \
  --restart unless-stopped \
  --memory 512m \
  --cpus 1.0 \
  --env-file /opt/platform/apps/${APP_NAME}/.env \
  -l platform=true \
  -l "app=${APP_NAME}" \
  -l "deploy.sha=${ROLLBACK_TAG}" \
  "apps/${APP_NAME}:${ROLLBACK_TAG}"

# Verify
docker ps --filter "name=${APP_NAME}"
curl https://${APP_NAME}.yourdomain.com/health
```

No Caddy update needed — the container name is the same, Docker DNS resolves to the new container automatically.

---

## 11. Platform Operations Runbook

### Daily Checks

```bash
# Quick health overview
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Image}}" --filter "label=platform=true"

# Resource usage
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}"

# Disk usage
df -h /
docker system df

# Check for recent restarts
docker events --filter "type=container" --filter "event=restart" --since 24h --until $(date -u +%Y-%m-%dT%H:%M:%SZ)

# Check Grafana dashboard
# https://dashboard.yourdomain.com
```

### Weekly Maintenance

```bash
# Update base images (security patches)
docker pull caddy:2-alpine
docker pull postgres:16-alpine
docker pull redis:7-alpine
docker pull grafana/grafana:10.2.3
docker pull prom/prometheus:v2.49.1

# Rebuild and restart updated infrastructure
# (Only if new versions are pulled)

# Check backup integrity
ls -lh /opt/platform/backups/ | head -20

# Review alert history in Grafana
```

### Adding a Shared Database

```bash
# PostgreSQL (shared across apps)
docker run -d \
  --name postgres \
  --network platform \
  -v pgdata:/var/lib/postgresql/data \
  -e POSTGRES_PASSWORD=strong-password-here \
  --restart unless-stopped \
  --memory 1g \
  --cpus 1.0 \
  -l platform=true \
  -l app=postgres \
  postgres:16-alpine

# Create a database for an app
docker exec -it postgres psql -U postgres -c "CREATE DATABASE tododb;"
docker exec -it postgres psql -U postgres -c "CREATE USER todouser WITH PASSWORD 'todopass';"
docker exec -it postgres psql -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE tododb TO todouser;"

# Redis
docker run -d \
  --name redis \
  --network platform \
  -v redisdata:/data \
  --restart unless-stopped \
  --memory 256m \
  -l platform=true \
  -l app=redis \
  redis:7-alpine redis-server --appendonly yes
```

### Removing an App

```bash
APP_NAME="old-app"

# Stop and remove the container
docker stop ${APP_NAME}
docker rm ${APP_NAME}

# Remove old images
docker images "apps/${APP_NAME}" -q | xargs -r docker rmi

# Remove the Caddy route
# Edit /opt/platform/caddy/Caddyfile — remove the block between
# # --- app:old-app --- and # --- end:old-app ---

# Reload Caddy
docker exec caddy caddy reload --config /etc/caddy/Caddyfile

# Remove app data
rm -rf /opt/platform/apps/${APP_NAME}

# Update registry.json — remove the entry

# Remove the GitHub webhook from the repo settings
```

### Emergency: Everything Is Down

```bash
# Check if Docker daemon is running
sudo systemctl status docker

# If not:
sudo systemctl start docker
# Containers with restart policies will come back automatically

# If Docker is running but containers aren't:
docker ps -a  # Check which containers exist but are stopped
docker start caddy prometheus grafana loki promtail cadvisor node-exporter
# Then start app containers

# If the VM itself is unresponsive:
# Reboot via your cloud provider's console
# Docker starts on boot, containers with restart policies auto-start

# If all else fails: disaster recovery (Chapter 10, section 11)
```

---

## You've Built a Deployment Platform

What started as "what is Docker?" is now a complete, working system:

- **Any developer** can push code to a GitHub repo, and it automatically deploys to your VM
- **Any language** works — Node.js, Go, Python, Rust, static sites — as long as there's a Dockerfile
- **Every app** gets its own subdomain with automatic HTTPS
- **Every app** is isolated in its own container with resource limits
- **Every app's** logs and metrics flow to a central Grafana dashboard
- **Rollbacks** are instant — just start a container from the previous image
- **Backups** run daily
- **The whole platform** can be restored on a new VM in under an hour

This is functionally what Dokploy, Coolify, and similar self-hosted platforms provide. You've built it from scratch, understanding every layer: from Linux namespaces to Dockerfiles to reverse proxies to webhook pipelines.

From here, you could extend it with:
- A web UI for managing apps (instead of CLI/API)
- Blue-green or canary deployments
- Docker Swarm for multi-VM scaling
- Build caching with Docker BuildKit
- Preview environments for pull requests (deploy each PR to a temporary subdomain)
- Billing/usage tracking per app

The foundation is solid. Everything else is iteration.

---

→ This is the final chapter of the guide.
