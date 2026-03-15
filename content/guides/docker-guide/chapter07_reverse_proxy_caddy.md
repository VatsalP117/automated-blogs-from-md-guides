# Chapter 7 — Reverse Proxy with Caddy (The Core of the Platform)

---

## Table of Contents

1. [What a Reverse Proxy Is and Why Every Platform Needs One](#1-what-a-reverse-proxy-is-and-why-every-platform-needs-one)
2. [Why Caddy Over Nginx](#2-why-caddy-over-nginx)
3. [How Caddy Works — The Caddyfile Format](#3-how-caddy-works--the-caddyfile-format)
4. [Routing Traffic to Containers by Domain](#4-routing-traffic-to-containers-by-domain)
5. [Automatic SSL Certificate Provisioning](#5-automatic-ssl-certificate-provisioning)
6. [Dynamic Configuration — Add/Remove Apps Without Restarts](#6-dynamic-configuration--addremove-apps-without-restarts)
7. [Caddy as a Docker Container](#7-caddy-as-a-docker-container)
8. [Custom Domains](#8-custom-domains)
9. [Wildcard Subdomains](#9-wildcard-subdomains)
10. [Caddy API — Programmatic Route Management](#10-caddy-api--programmatic-route-management)
11. [Full Working Multi-App Setup](#11-full-working-multi-app-setup)

---

## 1. What a Reverse Proxy Is and Why Every Platform Needs One

A reverse proxy sits between the internet and your application servers. Every HTTP request first hits the reverse proxy, which then decides which backend application should handle it.

```
Without reverse proxy:
  User → Port 3000 → App A
  User → Port 3001 → App B
  User → Port 3002 → App C
  (Users need to know port numbers. No SSL. No routing.)

With reverse proxy:
  User → app-a.example.com → Caddy → App A (:3000)
  User → app-b.example.com → Caddy → App B (:3001)  
  User → app-c.example.com → Caddy → App C (:5000)
  (Clean URLs. Automatic SSL. Single entry point.)
```

What the reverse proxy handles:
- **SSL/TLS termination:** HTTPS encryption is handled by the proxy. Apps behind it serve plain HTTP.
- **Domain-based routing:** Route `app-a.example.com` to one container, `app-b.example.com` to another.
- **Load balancing:** Distribute traffic across multiple instances of the same app (not needed for us now, but possible).
- **Security:** Only the proxy is exposed to the internet. Apps are hidden behind it.
- **HTTP/2, compression, caching:** Handled by the proxy, transparent to apps.

For our platform, the reverse proxy is the single most critical piece of infrastructure. It's how users reach their apps.

---

## 2. Why Caddy Over Nginx

Nginx is the most popular reverse proxy. Caddy is newer and, for our use case, significantly better.

| Feature | Nginx | Caddy |
|---|---|---|
| SSL certificates | Manual (certbot, cron renewal) | **Automatic** (built-in ACME, auto-renews) |
| Config syntax | Complex, many directives | Simple, few concepts |
| Dynamic config | Requires reload/restart | **Hot reload via API** |
| HTTP/2 + HTTP/3 | Manual setup | Enabled by default |
| Default security | Requires hardening | Secure by default (HTTPS, HSTS, etc.) |
| Config API | None built-in | **Full REST API for dynamic updates** |

The two killer features for our platform:

1. **Automatic SSL:** When you add `app.yourdomain.com` to Caddy's config, it automatically obtains a Let's Encrypt certificate. No certbot. No cron jobs. No manual renewal. It just works.

2. **Admin API:** Our deploy service can add/remove routes programmatically via HTTP requests to Caddy's API — no config file editing, no restarts. When a new app deploys, we hit the Caddy API to add its route.

---

## 3. How Caddy Works — The Caddyfile Format

Caddy's configuration file is called a `Caddyfile`. Its syntax is remarkably simple.

### The Simplest Possible Caddyfile

```
:80 {
    respond "Hello from Caddy"
}
```

This listens on port 80 and responds with "Hello from Caddy" for all requests.

### Domain-Based Routing

```
app-a.example.com {
    reverse_proxy app-a:3000
}

app-b.example.com {
    reverse_proxy app-b:8080
}
```

Each block is a **site block**. The address (domain name) goes first, followed by directives in curly braces. `reverse_proxy` forwards the request to the specified backend.

When Caddy sees a real domain name (not just `:80`), it **automatically enables HTTPS** and obtains a certificate for that domain.

### Key Concepts

**Site block:** Everything inside `{ }` after an address.

```
address {
    directive1
    directive2
}
```

**Addresses:**
```
:80                        # Any hostname, port 80
localhost                  # localhost, with self-signed cert
example.com                # example.com with auto HTTPS
*.example.com              # Wildcard subdomain
```

**Common directives:**
```
reverse_proxy backend:port  # Forward to a backend
file_server                 # Serve static files
respond "text"              # Respond with static text
encode gzip zstd            # Enable compression
header Field "Value"        # Set response headers
log                         # Enable access logging
```

---

## 4. Routing Traffic to Containers by Domain

### Basic Setup

Each app gets a subdomain. Caddy routes each subdomain to the correct container:

```
# Caddyfile

myapp.yourdomain.com {
    reverse_proxy myapp:3000
}

api.yourdomain.com {
    reverse_proxy api-service:8080
}

dashboard.yourdomain.com {
    reverse_proxy grafana:3000
}
```

This works because Caddy and the app containers are on the same Docker network. `myapp`, `api-service`, and `grafana` are container names that Docker DNS resolves to the correct IP addresses.

### With Headers and Compression

Production-grade reverse proxy config:

```
myapp.yourdomain.com {
    encode gzip zstd

    reverse_proxy myapp:3000 {
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }

    header {
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "strict-origin-when-cross-origin"
        -Server
    }

    log {
        output file /var/log/caddy/myapp.log
        format json
    }
}
```

What each part does:
- `encode gzip zstd` — compresses responses (reduces bandwidth)
- `header_up` — adds headers to the request sent to the backend (so the app knows the original client IP and protocol)
- `header` — sets security headers on responses to the client
- `-Server` — removes the Server header (don't advertise you're running Caddy)
- `log` — structured JSON access logs

---

## 5. Automatic SSL Certificate Provisioning

This is Caddy's superpower. Here's what happens when you add a domain to the Caddyfile:

```
newapp.yourdomain.com {
    reverse_proxy newapp:3000
}
```

Caddy automatically:
1. Detects that `newapp.yourdomain.com` needs an SSL certificate
2. Initiates the ACME protocol with Let's Encrypt
3. Proves domain ownership (via the HTTP-01 challenge: Let's Encrypt sends a request to `http://newapp.yourdomain.com/.well-known/acme-challenge/...`, Caddy responds)
4. Receives and installs the certificate
5. Configures HTTPS with modern TLS settings
6. Redirects HTTP to HTTPS automatically
7. Renews the certificate before it expires (Let's Encrypt certs last 90 days, Caddy renews at ~30 days remaining)

### Requirements

For automatic SSL to work:
1. The domain must have a DNS A record pointing to your VM's public IP
2. Ports 80 and 443 must be open on the VM firewall
3. Caddy must be accessible on port 80 (for the ACME HTTP challenge)

### Certificate Storage

Caddy stores certificates and ACME account data in its data directory. In Docker, mount this as a volume:

```bash
docker run -d \
  --name caddy \
  -v caddy_data:/data \       # Certificates live here — MUST persist
  -v caddy_config:/config \   # Runtime config cache
  caddy:2
```

If you lose the `caddy_data` volume, Caddy re-obtains all certificates on next startup. This works, but Let's Encrypt has rate limits (50 certificates per domain per week), so preserve this volume.

---

## 6. Dynamic Configuration — Add/Remove Apps Without Restarts

There are two ways to update Caddy's configuration:

### Method 1: Edit the Caddyfile and Reload

```bash
# Edit the Caddyfile on the host
vim /opt/platform/caddy/Caddyfile

# Tell Caddy to reload (graceful — no downtime)
docker exec caddy caddy reload --config /etc/caddy/Caddyfile
```

The reload is graceful: existing connections finish, new connections use the new config.

### Method 2: Caddy Admin API (Preferred for Automation)

Caddy has a built-in admin API (listening on `localhost:2019` by default inside the container) that lets you view and modify the configuration via HTTP.

```bash
# Get current config (as JSON)
docker exec caddy curl -s localhost:2019/config/ | python3 -m json.tool

# Add a new route via API
docker exec caddy curl -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "@id": "route-myapp",
    "match": [{"host": ["myapp.yourdomain.com"]}],
    "handle": [{
      "handler": "reverse_proxy",
      "upstreams": [{"dial": "myapp:3000"}]
    }]
  }' \
  localhost:2019/config/apps/http/servers/srv0/routes

# Remove a route by ID
docker exec caddy curl -X DELETE \
  localhost:2019/id/route-myapp
```

**For our platform:** The Go deploy service will use the Caddy API to:
1. Add a route when a new app is deployed
2. Update a route when an app is redeployed (new container name/port)
3. Remove a route when an app is deleted

No file editing, no restarts, no downtime.

---

## 7. Caddy as a Docker Container

### Running Caddy

```bash
docker run -d \
  --name caddy \
  --network platform \
  -p 80:80 \
  -p 443:443 \
  -p 443:443/udp \
  -v caddy_data:/data \
  -v caddy_config:/config \
  -v /opt/platform/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \
  --restart always \
  caddy:2-alpine
```

Breakdown:
- `--network platform` — same network as all app containers
- `-p 80:80` — HTTP (also used for ACME challenges)
- `-p 443:443` — HTTPS
- `-p 443:443/udp` — HTTP/3 (QUIC, uses UDP)
- `caddy_data:/data` — certificate storage (MUST persist)
- `caddy_config:/config` — runtime config cache
- `Caddyfile:/etc/caddy/Caddyfile:ro` — configuration file (read-only)
- `--restart always` — Caddy must always be running

### Initial Caddyfile for the Platform

```
# /opt/platform/caddy/Caddyfile

# Global options
{
    email you@yourdomain.com          # Used for Let's Encrypt account
    admin 0.0.0.0:2019                # Enable admin API (accessible within Docker network)
}

# Platform dashboard
dashboard.yourdomain.com {
    reverse_proxy grafana:3000
}

# Webhook receiver
deploy.yourdomain.com {
    reverse_proxy webhook-receiver:9000
}

# App routes will be added dynamically via the admin API
# or appended to this file by the deploy service
```

### Exposing the Admin API Safely

The admin API is powerful — it can modify all routing. It should ONLY be accessible from within the Docker network, never from the internet:

```
{
    admin 0.0.0.0:2019    # Accessible on the Docker network (other containers can reach it)
}
```

Since Caddy's admin port (2019) is NOT in the `-p` flags, it's only accessible from containers on the same Docker network. The deploy service container can reach it at `caddy:2019`.

---

## 8. Custom Domains

### How Custom Domains Work

Each app on our platform gets a subdomain by default: `appname.yourdomain.com`. But users might want their own domain: `www.theirapp.com`.

The setup:

1. **User adds a DNS record:** They create a CNAME or A record pointing their domain to our VM.
   ```
   www.theirapp.com → CNAME → yourdomain.com
   # or
   www.theirapp.com → A → 203.0.113.50 (your VM IP)
   ```

2. **We add the domain to Caddy:**
   ```
   www.theirapp.com {
       reverse_proxy theirapp:3000
   }
   ```

3. **Caddy handles the rest:** Automatically obtains an SSL certificate for `www.theirapp.com` and starts routing traffic.

### Supporting Multiple Domains per App

An app can have both the platform subdomain and a custom domain:

```
myapp.yourdomain.com, www.theirapp.com {
    reverse_proxy myapp:3000
}
```

Both domains route to the same container. Caddy obtains certificates for both.

### Verifying Domain Ownership

Before adding a custom domain, verify the user actually owns it (to prevent domain hijacking):

```bash
# Check if the domain points to our VM
dig +short www.theirapp.com
# Should return our VM's IP: 203.0.113.50

# Or check CNAME
dig +short CNAME www.theirapp.com
# Should return: yourdomain.com.
```

Our deploy service should verify this before adding the route.

---

## 9. Wildcard Subdomains

Instead of adding each app's subdomain individually, we can use a wildcard:

```
*.yourdomain.com {
    # Dynamic routing based on subdomain
    @app1 host app1.yourdomain.com
    handle @app1 {
        reverse_proxy app1:3000
    }

    @app2 host app2.yourdomain.com
    handle @app2 {
        reverse_proxy app2:8080
    }

    # Fallback for unknown subdomains
    handle {
        respond "App not found" 404
    }
}
```

### Wildcard SSL Certificates

Wildcard certificates (`*.yourdomain.com`) require the DNS-01 ACME challenge instead of HTTP-01. This means Caddy needs access to your DNS provider's API to create TXT records:

```
# Caddyfile with DNS challenge for wildcard cert
*.yourdomain.com {
    tls {
        dns cloudflare {env.CLOUDFLARE_API_TOKEN}
    }

    @app1 host app1.yourdomain.com
    handle @app1 {
        reverse_proxy app1:3000
    }
}
```

This requires the Caddy image with the DNS provider plugin. Build a custom Caddy image:

```dockerfile
FROM caddy:2-builder AS builder
RUN xcaddy build \
    --with github.com/caddy-dns/cloudflare

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
```

```bash
docker build -t caddy-custom:2 -f Dockerfile.caddy .

docker run -d \
  --name caddy \
  --network platform \
  -p 80:80 -p 443:443 -p 443:443/udp \
  -e CLOUDFLARE_API_TOKEN=your-token-here \
  -v caddy_data:/data \
  -v caddy_config:/config \
  -v /opt/platform/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \
  --restart always \
  caddy-custom:2
```

### Simpler Alternative: Per-App Subdomains Without Wildcards

If wildcard DNS is too complex, add each subdomain individually. The only difference is:
- Each subdomain needs its own DNS A record (or use a wildcard A record: `*.yourdomain.com → VM IP`)
- Each subdomain gets its own certificate (Caddy handles this automatically)
- Slightly more Let's Encrypt API calls (but well within rate limits for most platforms)

For a small platform (under 50 apps), individual subdomain certs are perfectly fine.

---

## 10. Caddy API — Programmatic Route Management

This is how our Go deploy service will manage routing. Instead of editing the Caddyfile, it talks to Caddy's admin API.

### The API Model

Caddy's config is a JSON document. The admin API lets you GET, POST, PUT, PATCH, and DELETE any part of it.

```
GET    /config/              → Full config
GET    /config/apps/http/    → HTTP app config
POST   /config/apps/http/servers/srv0/routes  → Add a route
DELETE /id/route-myapp       → Delete a route by ID
PUT    /config/              → Replace entire config
PATCH  /config/              → Merge into config
POST   /load                 → Load a new Caddyfile
```

### Adding a Route for a New App

When our deploy service finishes building and starting a new app container:

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  http://caddy:2019/config/apps/http/servers/srv0/routes \
  -d '{
    "@id": "route-myapp",
    "match": [{
      "host": ["myapp.yourdomain.com"]
    }],
    "handle": [{
      "handler": "subroute",
      "routes": [{
        "handle": [{
          "handler": "reverse_proxy",
          "upstreams": [{"dial": "myapp:3000"}],
          "headers": {
            "request": {
              "set": {
                "X-Real-IP": ["{http.request.remote.host}"],
                "X-Forwarded-For": ["{http.request.remote.host}"],
                "X-Forwarded-Proto": ["{http.request.scheme}"]
              }
            }
          }
        }]
      }]
    }],
    "terminal": true
  }'
```

### Updating a Route

When an app is redeployed (new container):

```bash
# If the container name/port hasn't changed, no Caddy update is needed.
# The DNS name "myapp" still resolves to a container — just a new one.

# If the upstream changes:
curl -X PATCH \
  -H "Content-Type: application/json" \
  http://caddy:2019/id/route-myapp \
  -d '{
    "handle": [{
      "handler": "reverse_proxy",
      "upstreams": [{"dial": "myapp-v2:3000"}]
    }]
  }'
```

### Removing a Route

When an app is deleted:

```bash
curl -X DELETE http://caddy:2019/id/route-myapp
```

### Loading a Full Caddyfile via API

You can also push an entire Caddyfile through the API:

```bash
curl -X POST \
  -H "Content-Type: text/caddyfile" \
  --data-binary @/opt/platform/caddy/Caddyfile \
  http://caddy:2019/load
```

This is the simplest approach: our deploy service maintains the Caddyfile as a text file, and after any change, pushes it to Caddy via `/load`. Caddy applies it with zero downtime.

**This is what we'll use in our platform.** It's simpler than managing individual JSON routes:

1. Deploy service edits `/opt/platform/caddy/Caddyfile` (adds/removes a site block)
2. Deploy service calls `POST /load` with the new Caddyfile
3. Caddy applies the new config (zero downtime)
4. If the domain is new, Caddy auto-obtains an SSL cert

---

## 11. Full Working Multi-App Setup

Here's the complete Caddy setup for our platform, with three apps deployed:

### Caddyfile

```
# /opt/platform/caddy/Caddyfile

# Global options
{
    email admin@yourdomain.com
    admin 0.0.0.0:2019
}

# ─── Platform Infrastructure ────────────────────────
dashboard.yourdomain.com {
    reverse_proxy grafana:3000
}

deploy.yourdomain.com {
    reverse_proxy webhook-receiver:9000
}

# ─── Deployed Apps ──────────────────────────────────

# Go API
goapi.yourdomain.com {
    encode gzip

    reverse_proxy goapi:8080 {
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }

    log {
        output file /var/log/caddy/goapi.log {
            roll_size 10mb
            roll_keep 5
        }
        format json
    }
}

# Node.js app
nodeapp.yourdomain.com {
    encode gzip

    reverse_proxy nodeapp:3000 {
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }

    log {
        output file /var/log/caddy/nodeapp.log {
            roll_size 10mb
            roll_keep 5
        }
        format json
    }
}

# Static React site
react-site.yourdomain.com {
    encode gzip

    reverse_proxy react-site:80 {
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }

    header {
        X-Content-Type-Options "nosniff"
        X-Frame-Options "SAMEORIGIN"
        -Server
    }

    log {
        output file /var/log/caddy/react-site.log {
            roll_size 10mb
            roll_keep 5
        }
        format json
    }
}

# Custom domain pointing to the same Node.js app
www.customerdomain.com {
    encode gzip

    reverse_proxy nodeapp:3000 {
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }
}
```

### Running It

```bash
# Create the platform network (if not exists)
docker network create platform 2>/dev/null || true

# Start Caddy
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
  caddy:2-alpine

# Start the apps (these are what the deploy service would start)
docker run -d --name goapi --network platform --restart unless-stopped goapi:abc123
docker run -d --name nodeapp --network platform --restart unless-stopped nodeapp:def456
docker run -d --name react-site --network platform --restart unless-stopped react-site:ghi789
```

### Adding a New App (What the Deploy Service Does)

```bash
# 1. Build and start the container
docker build -t apps/newapp:abc123 /opt/platform/apps/newapp/repo
docker run -d --name newapp --network platform --restart unless-stopped apps/newapp:abc123

# 2. Add the route to Caddyfile
cat >> /opt/platform/caddy/Caddyfile << 'EOF'

newapp.yourdomain.com {
    encode gzip
    reverse_proxy newapp:3000 {
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }
}
EOF

# 3. Reload Caddy
curl -X POST \
  -H "Content-Type: text/caddyfile" \
  --data-binary @/opt/platform/caddy/Caddyfile \
  http://localhost:2019/load
# (Or from inside the Docker network: http://caddy:2019/load)

# 4. Done. newapp.yourdomain.com is live with HTTPS.
```

### Verifying the Setup

```bash
# Check Caddy logs
docker logs caddy

# Test that routing works (from the VM)
curl -H "Host: goapi.yourdomain.com" http://localhost
# Should get a response from the Go API

# Check certificate status
curl -vI https://goapi.yourdomain.com 2>&1 | grep "SSL certificate"

# View Caddy's current config
docker exec caddy curl -s localhost:2019/config/ | python3 -m json.tool
```

---

## Summary

Caddy is the routing backbone of our platform:

- **Automatic HTTPS** — add a domain, get a certificate. No manual cert management.
- **Simple config** — the Caddyfile format is readable and minimal.
- **Admin API** — add/remove/update routes programmatically, zero downtime.
- **Docker-native** — runs as a container on the same network as apps. Routes by container name.
- **The pattern:** Caddy is the only container with published ports (80/443). Everything else is internal. Traffic flows: Internet → Caddy → Docker DNS → App container.

In our platform:
1. Deploy service builds an app container and starts it
2. Deploy service adds a route to the Caddyfile
3. Deploy service pushes the Caddyfile to Caddy via the `/load` API
4. Caddy obtains an SSL cert and starts routing traffic
5. The app is live at `appname.yourdomain.com` with HTTPS

In Chapter 8, we'll build the git push → auto deploy pipeline — the webhook receiver that triggers builds and deploys when you push to GitHub.

---

→ next: [chapter08_git_push_deploy_pipeline.md](chapter08_git_push_deploy_pipeline.md)
