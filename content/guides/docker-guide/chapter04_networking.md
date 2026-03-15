# Chapter 4 — Networking in Docker

---

## Table of Contents

1. [How Docker Networking Works Under the Hood](#1-how-docker-networking-works-under-the-hood)
2. [Network Types: bridge, host, none, overlay](#2-network-types-bridge-host-none-overlay)
3. [The Default Bridge Network and Its Limitations](#3-the-default-bridge-network-and-its-limitations)
4. [User-Defined Bridge Networks — The Production Standard](#4-user-defined-bridge-networks--the-production-standard)
5. [How Containers Talk to Each Other by Name (DNS)](#5-how-containers-talk-to-each-other-by-name-dns)
6. [Exposing Ports: EXPOSE vs -p vs --network host](#6-exposing-ports-expose-vs--p-vs---network-host)
7. [How Traffic Flows: Internet → VM → Docker → Container](#7-how-traffic-flows-internet--vm--docker--container)
8. [The Reverse Proxy Pattern](#8-the-reverse-proxy-pattern)
9. [How This Applies to Our Platform](#9-how-this-applies-to-our-platform)
10. [Common Networking Mistakes and How to Debug Them](#10-common-networking-mistakes-and-how-to-debug-them)

---

## 1. How Docker Networking Works Under the Hood

When Docker is installed, it creates a virtual networking layer on the host. Each container gets its own network namespace (its own `eth0`, its own IP address, its own port space). Docker then connects containers to virtual networks using Linux bridges, veth pairs, and iptables rules.

Think of it like this: Docker creates a mini-network inside your VM. Containers are devices on that network. Docker is the network administrator — it assigns IPs, manages routing, and controls what can talk to what.

```
┌─────────────────────────────────────────────────────────────────┐
│                           HOST VM                                │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │                  Docker Network (bridge)                  │    │
│  │                  Subnet: 172.18.0.0/16                   │    │
│  │                                                          │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │    │
│  │  │  Container A  │  │  Container B  │  │  Container C  │   │    │
│  │  │ 172.18.0.2   │  │ 172.18.0.3   │  │ 172.18.0.4   │   │    │
│  │  │ eth0         │  │ eth0         │  │ eth0         │   │    │
│  │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘   │    │
│  │         │                 │                 │            │    │
│  │    ┌────┴─────────────────┴─────────────────┴────┐       │    │
│  │    │            docker0 bridge                    │       │    │
│  │    │            172.18.0.1                        │       │    │
│  │    └──────────────────┬──────────────────────────┘       │    │
│  │                       │                                  │    │
│  └───────────────────────┼──────────────────────────────────┘    │
│                          │                                       │
│                   ┌──────┴──────┐                                │
│                   │  iptables   │  ← NAT, port forwarding        │
│                   └──────┬──────┘                                │
│                          │                                       │
│                   ┌──────┴──────┐                                │
│                   │   eth0      │  ← Host's real network         │
│                   │ (public IP) │    interface                    │
│                   └─────────────┘                                │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

The key pieces:
- **veth pairs:** Virtual ethernet cables. One end is in the container (its `eth0`), the other end is attached to the Docker bridge. This is how the container connects to the network.
- **Bridge:** A virtual switch. Containers on the same bridge can talk to each other.
- **iptables:** The Linux firewall. Docker adds rules to handle port forwarding (`-p` flag) and NAT (so containers can reach the internet).

You don't need to manage any of this directly. Docker does it for you. But understanding it helps when debugging "why can't container A reach container B."

---

## 2. Network Types: bridge, host, none, overlay

Docker has several network drivers. Each creates a different type of network:

### Bridge (Default)

The default and most common network type. Creates an isolated network with its own subnet. Containers connect to a virtual bridge.

```bash
# Create a bridge network
docker network create mynetwork

# Run a container on it
docker run -d --network mynetwork --name myapp myapp:v1
```

**Use when:** Almost always. This is what we'll use for our platform.

### Host

The container shares the host's network namespace. No isolation. The container uses the host's IP and ports directly.

```bash
docker run -d --network host myapp:v1
# The app listens on host port 3000 directly — no -p mapping needed
```

**Use when:** Maximum network performance is needed and you don't need port isolation. Rarely used in multi-app setups because containers can't use the same port.

**Not for our platform:** We're running many apps on the same VM. They'd all conflict on ports.

### None

No networking at all. The container has a loopback interface only.

```bash
docker run --network none myapp:v1
# Container has no network access
```

**Use when:** Security-critical batch jobs that should never make network requests.

### Overlay

Spans multiple Docker hosts. Used in Docker Swarm for multi-machine clusters.

```bash
docker network create --driver overlay my-swarm-net
```

**Not for our platform:** We're running everything on a single VM. Bridge networks are sufficient.

### Summary

| Driver | Isolation | Cross-host | Use Case |
|---|---|---|---|
| `bridge` | Full | No | Default. Multi-container on one host. **This is what we use.** |
| `host` | None | N/A | Performance-critical single containers |
| `none` | Total | N/A | Airgapped batch jobs |
| `overlay` | Full | Yes | Docker Swarm multi-host clusters |

---

## 3. The Default Bridge Network and Its Limitations

When you install Docker, it creates a default bridge network called `bridge` (creative naming). When you run a container without specifying a network, it goes on this default bridge.

```bash
docker run -d --name app1 myapp:v1      # Goes on default bridge
docker run -d --name app2 myapp:v2      # Also on default bridge
```

### The Problem: No DNS

On the default bridge network, **containers cannot resolve each other by name.** They can only communicate by IP address.

```bash
# Inside app1, this does NOT work on the default bridge:
curl http://app2:3000
# curl: (6) Could not resolve host: app2

# You'd need the IP address:
curl http://172.17.0.3:3000
# This works, but IPs are dynamic and change every restart
```

This is a critical limitation. Every production Docker setup needs containers to find each other by name (e.g., the app connects to `postgres` by hostname, not by IP). The default bridge doesn't support this.

### Other Limitations

- All containers on the default bridge can talk to each other (no isolation between unrelated apps)
- No automatic DNS resolution
- Harder to manage and debug

**Rule: Never use the default bridge network for anything real.** Always create user-defined bridge networks.

---

## 4. User-Defined Bridge Networks — The Production Standard

User-defined bridge networks fix every problem with the default bridge:

```bash
# Create a network
docker network create platform
```

That's it. Now connect containers to it:

```bash
docker run -d --name myapp --network platform myapp:v1
docker run -d --name postgres --network platform postgres:16
docker run -d --name redis --network platform redis:7
```

### What You Get

1. **Automatic DNS resolution:** Containers can reach each other by name.
   ```bash
   # Inside myapp:
   curl http://postgres:5432    # Works!
   curl http://redis:6379       # Works!
   ```

2. **Isolation between networks:** Containers on `network-a` can't talk to containers on `network-b` unless a container is connected to both networks.

3. **Better security:** Only containers you explicitly add to the network can communicate.

### Managing Networks

```bash
# List all networks
docker network ls
# NETWORK ID     NAME        DRIVER    SCOPE
# abc123         bridge      bridge    local    ← default (don't use)
# def456         host        host      local
# ghi789         none        null      local
# jkl012         platform    bridge    local    ← our custom network

# Inspect a network (see connected containers, subnet, etc.)
docker network inspect platform

# Connect a running container to a network
docker network connect platform existing-container

# Disconnect a container from a network
docker network disconnect platform existing-container

# Remove a network (must have no connected containers)
docker network rm platform
```

### Connecting a Container to Multiple Networks

A container can be on multiple networks:

```bash
docker network create frontend
docker network create backend

# Caddy needs to talk to both frontend and backend apps
docker run -d --name caddy --network frontend caddy:2
docker network connect backend caddy

# Frontend app only on frontend network
docker run -d --name react-app --network frontend react-app:v1

# Database only on backend network
docker run -d --name postgres --network backend postgres:16
```

Now:
- Caddy can reach both `react-app` and `postgres`
- `react-app` can NOT reach `postgres` (different networks)
- `postgres` can NOT reach `react-app`

This is network-level isolation. For our platform, we'll keep it simpler — one shared `platform` network — but this pattern is available if you want stronger isolation.

---

## 5. How Containers Talk to Each Other by Name (DNS)

Docker runs an embedded DNS server (at `127.0.0.11`) for user-defined networks. When a container makes a DNS query for another container's name, Docker's DNS server resolves it to that container's IP address.

```
Container A wants to reach Container B:

1. A's app calls: connect to "postgres"
2. A's resolver queries Docker's DNS server at 127.0.0.11
3. Docker DNS looks up "postgres" → 172.18.0.3
4. A connects to 172.18.0.3
5. Traffic flows through the bridge to Container B
```

### What Names Can Be Resolved

On a user-defined bridge network:

```bash
docker run -d --name myapp --network platform myapp:v1
docker run -d --name postgres --network platform postgres:16
```

- Container name: `myapp` → resolves to myapp's IP
- Container name: `postgres` → resolves to postgres's IP

In Docker Compose (Chapter 6), the service name is also resolvable:

```yaml
services:
  api:        # Resolvable as "api"
    image: myapp:v1
  db:         # Resolvable as "db"
    image: postgres:16
```

### Network Aliases

You can give a container additional DNS names:

```bash
docker run -d --name postgres-main --network platform --network-alias db postgres:16
# Now reachable as both "postgres-main" AND "db"
```

This is useful when you want a stable service name (`db`) even when the container's name includes version info (`postgres-main-v16`).

---

## 6. Exposing Ports: EXPOSE vs -p vs --network host

These three are related but do completely different things.

### `EXPOSE` (Dockerfile instruction)

```dockerfile
EXPOSE 3000
```

**Does:** Documents that the container listens on port 3000. That's it. No ports are opened. No traffic is routed. It's metadata.

**Analogy:** A sign on a building that says "entrance on port 3000." Doesn't mean the door is unlocked.

### `-p` / `--publish` (runtime flag)

```bash
docker run -d -p 8080:3000 myapp:v1
#              ──────┬─────
#                host:container
```

**Does:** Creates an iptables rule that forwards traffic from host port 8080 to container port 3000. This is what actually makes a container reachable from outside the Docker network.

```bash
# From outside the VM:
curl http://vm-public-ip:8080    # Reaches the container's port 3000

# Map to all interfaces (default)
-p 8080:3000              # 0.0.0.0:8080 → container:3000

# Map to localhost only (not reachable from outside)
-p 127.0.0.1:8080:3000   # 127.0.0.1:8080 → container:3000
```

**Important:** Containers on the same Docker network can talk to each other directly — they don't need published ports. `-p` is only for traffic from outside the Docker network (or from the host itself).

### `--network host`

```bash
docker run -d --network host myapp:v1
```

**Does:** The container shares the host's network stack entirely. If the app binds to port 3000, it's bound on the host's port 3000. No port mapping needed or possible.

### How They Work Together (and Don't)

```
Internet → (port 8080) → HOST VM → (iptables/port forward) → Container:3000
                          ↑ This hop is created by -p 8080:3000

Container A → (DNS: "containerB") → Container B:3000
              ↑ This works because they're on the same Docker network
              ↑ No -p needed for container-to-container traffic
```

**For our platform:**
- App containers: NO `-p` flag. They're on the `platform` network.
- Caddy (reverse proxy): `-p 80:80 -p 443:443`. It's the only container with published ports.
- Caddy routes traffic to app containers by name on the Docker network.

---

## 7. How Traffic Flows: Internet → VM → Docker → Container

This is the full picture of how a user's browser request reaches your app:

```
User's browser
    │
    │ HTTPS request to myapp.yourdomain.com
    │
    ▼
DNS resolution
    │ myapp.yourdomain.com → 203.0.113.50 (your VM's IP)
    │
    ▼
Your VM (203.0.113.50)
    │
    │ Port 443 (HTTPS)
    │
    ▼
iptables (Docker port mapping)
    │ 0.0.0.0:443 → caddy container:443
    │
    ▼
Caddy container (reverse proxy)
    │ Reads the Host header: myapp.yourdomain.com
    │ Looks up routing config: myapp.yourdomain.com → myapp:3000
    │ (Caddy and myapp are on the same Docker network)
    │
    ▼
myapp container (port 3000)
    │ Your application handles the request
    │ Sends response back through the same chain
    │
    ▼
Response arrives at user's browser
```

Each layer:
1. **DNS:** Your domain points to the VM's public IP. You set this up with your domain registrar (A record).
2. **VM firewall (UFW):** Allows inbound traffic on ports 80 and 443 only. All other ports are blocked.
3. **Docker port mapping:** Caddy is the only container with `-p 80:80 -p 443:443`. It receives all HTTP/HTTPS traffic.
4. **Caddy:** Terminates SSL, reads the hostname, routes to the right container on the Docker network.
5. **App container:** Receives the request on its internal port, processes it, responds.

### Why This Architecture Matters

- **Security:** Only ports 80, 443, and 22 (SSH) are exposed to the internet. App containers have no direct internet exposure.
- **Flexibility:** Adding a new app is just adding a route in Caddy's config. No firewall changes, no port management.
- **SSL:** Caddy handles SSL certificates automatically for every domain. Apps don't deal with HTTPS at all.
- **Simplicity:** Apps listen on any port they want internally. No conflicts. Caddy maps domains to containers.

---

## 8. The Reverse Proxy Pattern

A reverse proxy sits between the internet and your applications. It receives all incoming requests and forwards them to the right backend service based on the domain name (or URL path).

### Why Every Multi-App Setup Needs One

Without a reverse proxy:
```
App A: -p 3000:3000    →  http://vm-ip:3000
App B: -p 3001:3000    →  http://vm-ip:3001
App C: -p 3002:5000    →  http://vm-ip:3002
```
Problems:
- Users need to remember port numbers
- No SSL (need to manage certificates per app)
- Hard to manage as apps grow
- No custom domains

With a reverse proxy:
```
All apps behind Caddy:
  app-a.yourdomain.com  →  Caddy  →  app-a:3000
  app-b.yourdomain.com  →  Caddy  →  app-b:3000
  app-c.yourdomain.com  →  Caddy  →  app-c:5000
```
Benefits:
- Clean URLs with custom domains
- Automatic SSL for every domain
- Single point of entry (ports 80/443 only)
- Central logging of all HTTP traffic
- Easy to add/remove apps

### The Pattern in Docker

```
┌─────────── Docker Network ──────────────┐
│                                          │
│   ┌───────┐   DNS: "app-a"   ┌──────┐   │
│   │       │ ──────────────── │App A │   │
│   │       │                  └──────┘   │
│   │ Caddy │   DNS: "app-b"   ┌──────┐   │
│   │  :80  │ ──────────────── │App B │   │
│   │  :443 │                  └──────┘   │
│   │       │   DNS: "app-c"   ┌──────┐   │
│   │       │ ──────────────── │App C │   │
│   └───┬───┘                  └──────┘   │
│       │                                  │
└───────┼──────────────────────────────────┘
        │
   -p 80:80
   -p 443:443
        │
    Internet
```

We'll implement this fully with Caddy in Chapter 7.

---

## 9. How This Applies to Our Platform

### The Network Architecture

```bash
# Create the platform network (done once during setup)
docker network create platform
```

Every container — app containers, Caddy, observability stack, webhook receiver — connects to this network.

```bash
# Caddy (the only container with published ports)
docker run -d \
  --name caddy \
  --network platform \
  -p 80:80 -p 443:443 \
  -v caddy_data:/data \
  -v /opt/platform/caddy/Caddyfile:/etc/caddy/Caddyfile \
  caddy:2

# An app container (no published ports)
docker run -d \
  --name myapp \
  --network platform \
  --restart unless-stopped \
  myapp:a1b2c3d

# Caddy routes myapp.yourdomain.com → myapp:3000 (internal DNS)
```

### Per-App Networking

Each app container:
- Has NO published ports (no `-p`)
- Is on the `platform` network
- Is reachable by its container name (Docker DNS)
- Is isolated from the internet (only reachable through Caddy)

This means:
- No port conflict management needed
- Every app can listen on port 3000 (or whatever) internally — they don't conflict
- Adding an app = starting a container + adding a Caddy route
- Removing an app = stopping the container + removing the Caddy route

### Container-to-Container Communication

Apps can also reach each other if needed:

```bash
# Inside the "frontend" container:
curl http://api:8080/users    # Reaches the "api" container on port 8080
```

And apps can reach shared services:

```bash
# Inside any app container:
# Database
psql -h postgres -U user -d mydb

# Redis
redis-cli -h redis ping

# Another app's API
curl http://other-app:3000/api/data
```

All through Docker DNS on the `platform` network.

---

## 10. Common Networking Mistakes and How to Debug Them

### Mistake 1: "Container A can't reach Container B"

**Cause:** They're on different networks (or one is on the default bridge).

**Debug:**
```bash
# Check what network each container is on
docker inspect -f '{{json .NetworkSettings.Networks}}' containerA
docker inspect -f '{{json .NetworkSettings.Networks}}' containerB

# Are they on the same network?
docker network inspect platform -f '{{range .Containers}}{{.Name}} {{end}}'
```

**Fix:** Ensure both containers are on the same user-defined network:
```bash
docker network connect platform containerA
docker network connect platform containerB
```

### Mistake 2: "Connection refused when trying to reach a container"

**Cause (most common):** The app inside the container is listening on `127.0.0.1` (localhost) instead of `0.0.0.0` (all interfaces).

```bash
# BAD: app binds to localhost — only reachable from inside the container itself
node server.js --host 127.0.0.1

# GOOD: app binds to all interfaces — reachable from other containers
node server.js --host 0.0.0.0
```

This is one of the most common Docker networking issues. Inside a container, `127.0.0.1` means "only this container." Other containers connect via the Docker network interface, which is NOT localhost.

**Debug:**
```bash
# Get a shell in the container that's failing to connect
docker exec -it containerA sh

# Try to reach the target container
curl http://containerB:3000
# "Connection refused"

# Check if the port is actually open in containerB
docker exec containerB ss -tlnp
# or
docker exec containerB netstat -tlnp

# If you see "127.0.0.1:3000" instead of "0.0.0.0:3000", that's the problem
```

**Fix:** Configure your application to listen on `0.0.0.0`:

```javascript
// Node.js Express
app.listen(3000, '0.0.0.0');   // NOT '127.0.0.1' or 'localhost'

// Or just omit the host (defaults to 0.0.0.0 in most frameworks)
app.listen(3000);
```

```python
# Flask
app.run(host='0.0.0.0', port=5000)

# Gunicorn
gunicorn --bind 0.0.0.0:5000 app:app
```

```go
// Go
http.ListenAndServe(":8080", handler)  // ":" = all interfaces
// NOT "localhost:8080" or "127.0.0.1:8080"
```

### Mistake 3: "Port already in use"

```
Error: Bind for 0.0.0.0:8080 failed: port is already allocated
```

**Cause:** Another container (or host process) is already using that host port.

**Debug:**
```bash
# What's using the port on the host?
sudo ss -tlnp | grep 8080
# or
docker ps --filter "publish=8080"
```

**Fix:** Stop the conflicting container or use a different host port.

### Mistake 4: "DNS resolution not working"

```
# Inside a container:
curl http://myapp:3000
# curl: (6) Could not resolve host: myapp
```

**Cause:** The container is on the default bridge network (which has no DNS).

**Debug:**
```bash
docker inspect -f '{{json .NetworkSettings.Networks}}' mycontainer
# If you see "bridge" but not your custom network, that's the issue
```

**Fix:** Use a user-defined network:
```bash
docker network create platform
docker run --network platform ...
```

### Mistake 5: "Container can't reach the internet"

**Cause:** Docker's NAT or DNS forwarding is broken, or the host has no internet.

**Debug:**
```bash
# Check from inside the container
docker exec -it mycontainer sh

# Can we resolve DNS?
nslookup google.com

# Can we reach the internet?
ping -c 3 8.8.8.8

# Can we make HTTP requests?
wget -qO- http://httpbin.org/ip
```

**Fix:** Usually a Docker daemon restart fixes it:
```bash
sudo systemctl restart docker
```

If DNS resolution fails inside containers, check `/etc/docker/daemon.json` for custom DNS settings:
```json
{
  "dns": ["8.8.8.8", "8.8.4.4"]
}
```

### The Network Debug Toolkit

When debugging networking, these commands (run inside containers) are invaluable:

```bash
# Install network tools in Alpine containers
apk add --no-cache curl bind-tools iputils

# DNS resolution
nslookup myapp
dig myapp

# Connectivity test
ping -c 3 myapp
curl -v http://myapp:3000/health

# See network interfaces and IPs
ip addr

# See routing table
ip route

# TCP connection test
nc -zv myapp 3000
```

Or run a dedicated network debug container:

```bash
docker run --rm -it --network platform nicolaka/netshoot
# This image comes with curl, dig, nslookup, tcpdump, ping, traceroute, etc.
```

---

## Summary

Docker networking is simpler than it looks once you understand the core concepts:

- **Always use user-defined bridge networks** — never the default bridge.
- Containers on the same user-defined network can **resolve each other by name** (Docker DNS).
- **`-p` publishes ports** to the host. It's not needed for container-to-container communication.
- Apps must **listen on `0.0.0.0`**, not `127.0.0.1`, to be reachable from other containers.
- **The reverse proxy pattern** (Caddy in front, apps behind) is the standard for multi-app setups.
- In our platform, **only Caddy has published ports** (80/443). Everything else is internal.
- Traffic flow: Internet → VM:443 → Caddy → Docker DNS → App container.

In Chapter 5, we'll cover storage and volumes — how to make data persist across container restarts and how to handle databases, uploads, and config files.

---

→ next: [chapter05_storage_volumes.md](chapter05_storage_volumes.md)
