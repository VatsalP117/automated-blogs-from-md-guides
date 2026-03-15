# Chapter 9 — Logs, Metrics & Monitoring Dashboard

---

## Table of Contents

### 9A — Container Logging
1. [How Docker Logging Works](#1-how-docker-logging-works)
2. [Collecting Logs Centrally](#2-collecting-logs-centrally)
3. [The Loki + Promtail Stack](#3-the-loki--promtail-stack)
4. [Structured vs Plain Text Logs](#4-structured-vs-plain-text-logs)
5. [Log Retention and Rotation](#5-log-retention-and-rotation)

### 9B — Metrics
6. [What Metrics to Collect](#6-what-metrics-to-collect)
7. [cAdvisor — Container Metrics Collection](#7-cadvisor--container-metrics-collection)
8. [Prometheus — Scraping and Storing Metrics](#8-prometheus--scraping-and-storing-metrics)
9. [What to Alert On](#9-what-to-alert-on)

### 9C — Dashboard
10. [Grafana — The Unified Dashboard](#10-grafana--the-unified-dashboard)
11. [Building the Platform Dashboard](#11-building-the-platform-dashboard)
12. [Alerting Basics](#12-alerting-basics)

### 9D — Full Stack
13. [Complete Observability Stack Compose File](#13-complete-observability-stack-compose-file)

---

## 9A — Container Logging

### 1. How Docker Logging Works

When a process inside a container writes to stdout or stderr, Docker captures that output and stores it using a **log driver**. The default log driver is `json-file`, which writes logs as JSON lines to files on the host.

```
Container process
  │
  │ writes to stdout/stderr
  ▼
Docker daemon
  │
  │ captures output
  ▼
Log driver (json-file by default)
  │
  │ writes to disk
  ▼
/var/lib/docker/containers/<id>/<id>-json.log
```

Each log line is stored as:
```json
{"log":"Server started on port 3000\n","stream":"stdout","time":"2024-01-15T10:30:45.123456789Z"}
```

When you run `docker logs myapp`, Docker reads these files and displays the `log` field.

### Key Implication for App Developers

**Your application should log to stdout/stderr, not to files.** Docker captures stdout/stderr automatically. If your app writes to `/var/log/app.log` inside the container, Docker doesn't know about those logs — `docker logs` won't show them, and your log collection pipeline won't pick them up.

```python
# GOOD: Logs to stdout (captured by Docker)
import logging
logging.basicConfig(stream=sys.stdout, level=logging.INFO)

# BAD: Logs to a file (invisible to Docker)
logging.basicConfig(filename='/var/log/app.log', level=logging.INFO)
```

```javascript
// GOOD: console.log goes to stdout
console.log('Server started');

// BAD: Writing to a file
fs.appendFileSync('/var/log/app.log', 'Server started\n');
```

---

### 2. Collecting Logs Centrally

With 10+ containers running, you can't SSH in and run `docker logs` on each one. You need centralized logging: all container logs flowing to one place where you can search, filter, and dashboard them.

The stack we'll use:

```
Container stdout/stderr
  │
  ▼
Docker json-file log driver
  │
  ▼ (reads log files)
Promtail (log shipper)
  │
  ▼ (pushes to)
Loki (log aggregation + storage)
  │
  ▼ (queried by)
Grafana (visualization + search)
```

**Why this stack (and not ELK)?**

| Stack | RAM Usage | Disk Usage | Complexity |
|---|---|---|---|
| ELK (Elasticsearch + Logstash + Kibana) | 2-4GB minimum | Heavy (full-text indexing) | High |
| Loki + Promtail + Grafana | ~200-300MB | Light (indexes labels only, not content) | Low |

Loki was designed by the Grafana team specifically for this use case: lightweight log aggregation that's affordable to run on a single machine. It's what Prometheus is to metrics — Loki is to logs.

---

### 3. The Loki + Promtail Stack

#### Loki — Log Storage and Querying

Loki stores log data. Unlike Elasticsearch, it doesn't index the full text of every log line. Instead, it indexes only **labels** (like container name, app name, etc.) and stores the log content as compressed chunks. This makes it fast and lightweight.

**Loki config** (`/opt/platform/loki/loki-config.yml`):

```yaml
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
  retention_period: 168h          # Keep logs for 7 days
  max_query_series: 500
  max_query_parallelism: 2

compactor:
  working_directory: /loki/compactor
  compaction_interval: 5m
  retention_enabled: true
  retention_delete_delay: 2h
```

#### Promtail — Log Shipper

Promtail runs alongside Docker, reads container log files, and ships them to Loki. It auto-discovers containers and adds labels.

**Promtail config** (`/opt/platform/promtail/promtail-config.yml`):

```yaml
server:
  http_listen_port: 9080

positions:
  filename: /tmp/positions.yaml

clients:
  - url: http://loki:3100/loki/api/v1/push

scrape_configs:
  - job_name: docker
    static_configs:
      - targets:
          - localhost
        labels:
          job: docker
          __path__: /var/lib/docker/containers/*/*-json.log

    pipeline_stages:
      # Parse Docker's JSON log format
      - docker: {}

      # Extract container name from the file path
      - regex:
          source: filename
          expression: '/var/lib/docker/containers/(?P<container_id>[^/]+)/.*'

      # Add labels from Docker container labels
      - labels:
          container_id:

      # Drop health check noise
      - match:
          selector: '{job="docker"}'
          stages:
            - regex:
                expression: '.*health.*check.*'
            - metrics:
                health_check_total:
                  type: Counter
                  description: "Total health check log lines"
```

For better container label extraction, use the Docker service discovery:

```yaml
scrape_configs:
  - job_name: docker
    docker_sd_configs:
      - host: unix:///var/run/docker.sock
        refresh_interval: 15s
        filters:
          - name: label
            values: ["platform=true"]

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
```

This uses Docker's API to discover containers, and extracts labels we set during `docker run` (`-l app=myapp -l deploy.sha=abc123`). In Grafana, you can then query logs by app name: `{app="myapp"}`.

---

### 4. Structured vs Plain Text Logs

**Plain text** (hard to query):
```
2024-01-15 10:30:45 INFO Server started on port 3000
2024-01-15 10:30:46 INFO User john logged in
2024-01-15 10:30:47 ERROR Failed to process request: connection refused
```

**Structured JSON** (easy to query in Loki):
```json
{"ts":"2024-01-15T10:30:45Z","level":"info","msg":"server started","port":3000}
{"ts":"2024-01-15T10:30:46Z","level":"info","msg":"user logged in","user":"john"}
{"ts":"2024-01-15T10:30:47Z","level":"error","msg":"request failed","error":"connection refused","path":"/api/data"}
```

With structured logs in Loki, you can:
```
# Find all errors for a specific app
{app="myapp"} |= "error"

# Parse JSON and filter by level
{app="myapp"} | json | level="error"

# Find slow requests
{app="myapp"} | json | duration > 1000
```

**Recommendation:** Configure your apps to output JSON logs in production.

---

### 5. Log Retention and Rotation

**Docker level:** Configure the json-file log driver to rotate:

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
```

Put this in `/etc/docker/daemon.json`. Each container gets at most 30MB of logs on disk.

**Loki level:** The `retention_period` in the Loki config controls how long logs are kept:

```yaml
limits_config:
  retention_period: 168h    # 7 days
```

For a single VM, 7 days is a reasonable default. Increase if you have disk space and need longer history.

---

## 9B — Metrics

### 6. What Metrics to Collect

For a deployment platform, you need to know:

**Per-container metrics:**
- CPU usage (percentage and total time)
- Memory usage (current, limit, percentage)
- Network I/O (bytes in/out)
- Disk I/O (reads/writes)
- Container restarts (OOM kills, crashes)

**System-level metrics:**
- Total CPU usage
- Total memory usage
- Disk space remaining
- Network throughput

**Application-level metrics** (if apps expose them):
- Request count and latency
- Error rates
- Custom business metrics

---

### 7. cAdvisor — Container Metrics Collection

cAdvisor (Container Advisor) is a tool from Google that automatically collects resource usage metrics from every running container. It exposes these metrics in Prometheus format.

```
cAdvisor
  │
  │ reads from /sys/fs/cgroup and Docker API
  │
  ▼
Exposes metrics at :8080/metrics
  │
  │ scraped by
  ▼
Prometheus
```

cAdvisor requires no configuration. It discovers containers automatically and exposes metrics like:

```
# CPU usage per container
container_cpu_usage_seconds_total{name="myapp"} 45.23

# Memory usage per container
container_memory_usage_bytes{name="myapp"} 52428800

# Network bytes received
container_network_receive_bytes_total{name="myapp"} 1048576

# Container restart count
container_restart_count{name="myapp"} 0

# OOM kill count
container_oom_events_total{name="myapp"} 0
```

---

### 8. Prometheus — Scraping and Storing Metrics

Prometheus periodically scrapes (pulls) metrics from targets (like cAdvisor) and stores them as time series data. You query it with PromQL.

**Prometheus config** (`/opt/platform/prometheus/prometheus.yml`):

```yaml
global:
  scrape_interval: 15s          # Collect metrics every 15 seconds
  evaluation_interval: 15s      # Evaluate alerting rules every 15 seconds

scrape_configs:
  # Prometheus scrapes itself (for health monitoring)
  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']

  # cAdvisor (container metrics)
  - job_name: 'cadvisor'
    static_configs:
      - targets: ['cadvisor:8080']
    metric_relabel_configs:
      # Drop high-cardinality metrics we don't need
      - source_labels: [__name__]
        regex: 'container_tasks_state|container_memory_failures_total'
        action: drop

  # Node exporter (host system metrics — optional but recommended)
  - job_name: 'node'
    static_configs:
      - targets: ['node-exporter:9100']

  # Caddy metrics (if enabled)
  - job_name: 'caddy'
    static_configs:
      - targets: ['caddy:2019']
    metrics_path: /metrics

# Alerting rules
rule_files:
  - /etc/prometheus/alerts.yml
```

**Alert rules** (`/opt/platform/prometheus/alerts.yml`):

```yaml
groups:
  - name: container_alerts
    rules:
      # Container is using more than 90% of its memory limit
      - alert: ContainerHighMemory
        expr: |
          (container_memory_usage_bytes{name!=""} /
           container_spec_memory_limit_bytes{name!=""}) > 0.9
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Container {{ $labels.name }} is using >90% memory"

      # Container was OOM killed
      - alert: ContainerOOMKilled
        expr: increase(container_oom_events_total{name!=""}[5m]) > 0
        labels:
          severity: critical
        annotations:
          summary: "Container {{ $labels.name }} was OOM killed"

      # Container restarting frequently
      - alert: ContainerRestartLoop
        expr: increase(container_restart_count{name!=""}[15m]) > 3
        labels:
          severity: critical
        annotations:
          summary: "Container {{ $labels.name }} has restarted {{ $value }} times in 15m"

      # Container is down
      - alert: ContainerDown
        expr: absent(container_cpu_usage_seconds_total{name=~".+"})
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Expected container is not running"

  - name: host_alerts
    rules:
      # Disk space running low
      - alert: DiskSpaceLow
        expr: |
          (node_filesystem_avail_bytes{mountpoint="/"} /
           node_filesystem_size_bytes{mountpoint="/"}) < 0.15
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Disk space below 15%"

      # Host memory running low
      - alert: HostHighMemory
        expr: |
          (1 - (node_memory_MemAvailable_bytes /
                node_memory_MemTotal_bytes)) > 0.9
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Host memory usage above 90%"
```

---

### 9. What to Alert On

| Alert | Severity | Why |
|---|---|---|
| Container OOM killed | Critical | App is crashing due to memory exhaustion |
| Container restart loop (>3 restarts in 15 min) | Critical | App is crash-looping |
| Container memory >90% of limit | Warning | About to be OOM killed |
| Host disk space <15% | Warning | VM is running out of disk |
| Host memory >90% | Warning | Overall resource exhaustion |
| Certificate expiring in <7 days | Warning | HTTPS will break if cert expires |
| Prometheus target down | Warning | Monitoring gap |

---

## 9C — Dashboard

### 10. Grafana — The Unified Dashboard

Grafana is the visualization layer. It connects to Prometheus (for metrics) and Loki (for logs) and presents everything in dashboards.

Grafana runs as a container with a persistent volume for its database (dashboards, users, settings):

```bash
docker run -d \
  --name grafana \
  --network platform \
  -v grafana_data:/var/lib/grafana \
  -e GF_SECURITY_ADMIN_USER=admin \
  -e GF_SECURITY_ADMIN_PASSWORD=your-secure-password \
  --restart unless-stopped \
  grafana/grafana:10.2.3
```

Accessed via Caddy at `dashboard.yourdomain.com`.

### Data Sources

After Grafana starts, configure two data sources:

**Prometheus:**
- URL: `http://prometheus:9090`
- Default: Yes

**Loki:**
- URL: `http://loki:3100`

Both are reachable by container name because everything is on the same Docker network.

---

### 11. Building the Platform Dashboard

The platform dashboard should show at a glance:

1. **All running apps** with their status
2. **Per-app CPU and memory** usage
3. **Per-app logs** (searchable)
4. **Recent deploys** (from build logs)
5. **System health** (host CPU, memory, disk)

#### Key Grafana Dashboard Panels

**Panel: Running Containers**

PromQL:
```promql
count(container_cpu_usage_seconds_total{name!=""}) by (name)
```

**Panel: CPU Usage Per App**

PromQL:
```promql
rate(container_cpu_usage_seconds_total{name!=""}[5m]) * 100
```

**Panel: Memory Usage Per App**

PromQL:
```promql
container_memory_usage_bytes{name!=""} / 1024 / 1024
```

**Panel: Memory Usage as % of Limit**

PromQL:
```promql
(container_memory_usage_bytes{name!=""} /
 container_spec_memory_limit_bytes{name!=""}) * 100
```

**Panel: Network Traffic Per App**

PromQL:
```promql
rate(container_network_receive_bytes_total{name!=""}[5m]) * 8
```

**Panel: Container Restarts**

PromQL:
```promql
increase(container_restart_count{name!=""}[1h])
```

**Panel: App Logs (Loki)**

LogQL:
```
{app="myapp"} | json
```

**Panel: Error Rate Across All Apps**

LogQL:
```
sum by (app) (rate({job="docker"} |= "error" [5m]))
```

**Panel: Host Disk Space**

PromQL:
```promql
100 - ((node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}) * 100)
```

---

### 12. Alerting Basics

Grafana can send alerts when metrics cross thresholds:

**Where to send alerts:**
- **Email** — requires SMTP config in Grafana
- **Slack** — webhook integration
- **Discord** — webhook
- **PagerDuty** — for on-call rotation
- **Webhook** — custom HTTP endpoint

Simplest setup (Grafana → Slack/Discord webhook):

1. Create a webhook URL in Slack/Discord
2. In Grafana: Alerting → Contact Points → Add → Webhook
3. Set up alert rules that fire on the PromQL expressions above

For a single-VM platform, email or a Discord/Slack webhook is usually sufficient.

---

## 9D — Full Observability Stack

### 13. Complete Observability Stack Compose File

`/opt/platform/docker-compose.monitoring.yml`:

```yaml
services:
  # ─── Prometheus (metrics storage) ──────────────────────────
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
          cpus: "0.5"
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

  # ─── cAdvisor (container metrics) ─────────────────────────
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
          cpus: "0.25"
    logging:
      driver: json-file
      options:
        max-size: "5m"
        max-file: "3"

  # ─── Node Exporter (host metrics) ─────────────────────────
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
          cpus: "0.1"
    logging:
      driver: json-file
      options:
        max-size: "5m"
        max-file: "3"

  # ─── Loki (log storage) ───────────────────────────────────
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
          cpus: "0.5"
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

  # ─── Promtail (log shipper) ───────────────────────────────
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
          cpus: "0.1"
    logging:
      driver: json-file
      options:
        max-size: "5m"
        max-file: "3"

  # ─── Grafana (dashboard) ──────────────────────────────────
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
      - GF_SERVER_ROOT_URL=https://dashboard.${PLATFORM_DOMAIN}
    depends_on:
      prometheus:
        condition: service_healthy
      loki:
        condition: service_healthy
    deploy:
      resources:
        limits:
          memory: 256M
          cpus: "0.5"
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
```

### Starting the Stack

```bash
# Ensure the platform network exists
docker network create platform 2>/dev/null || true

# Start the observability stack
cd /opt/platform
GRAFANA_PASSWORD=your-secure-password \
PLATFORM_DOMAIN=yourdomain.com \
docker compose -f docker-compose.monitoring.yml up -d

# Check everything is healthy
docker compose -f docker-compose.monitoring.yml ps
```

### Total Resource Usage of the Monitoring Stack

| Service | Memory Limit | CPU Limit |
|---|---|---|
| Prometheus | 512MB | 0.5 |
| cAdvisor | 256MB | 0.25 |
| Node Exporter | 128MB | 0.1 |
| Loki | 512MB | 0.5 |
| Promtail | 128MB | 0.1 |
| Grafana | 256MB | 0.5 |
| **Total** | **~1.8GB** | **~2.0 cores** |

On a VM with 4GB+ RAM and 2+ CPU cores, this leaves plenty of room for your app containers.

---

## Summary

The observability stack gives you full visibility into your platform:

- **Logs** (Promtail → Loki → Grafana): Centralized, searchable logs from all containers. Query by app name, log level, or any field.
- **Metrics** (cAdvisor + Node Exporter → Prometheus → Grafana): CPU, memory, network, disk per container and for the host. Time-series history.
- **Dashboard** (Grafana): A single pane of glass showing all running apps, their resource usage, logs, and alerts.
- **Alerts** (Prometheus rules → Grafana notifications): Get notified when containers are OOM killed, crash-looping, or when the host is running low on resources.

The entire stack runs as Docker containers on the same `platform` network, consuming about 1.8GB RAM total. It's production-ready for a single-VM platform.

In Chapter 10, we'll cover production operations — setting up the VM, security hardening, resource management, and day-to-day operations.

---

→ next: [chapter10_production_operations.md](chapter10_production_operations.md)
