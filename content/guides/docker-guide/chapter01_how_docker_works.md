# Chapter 1 — How Docker Actually Works (The Mental Model)

---

## Table of Contents

1. [What Docker Is and the Problem It Solves](#1-what-docker-is-and-the-problem-it-solves)
2. [VMs vs. Containers — What's Actually Different Under the Hood](#2-vms-vs-containers--whats-actually-different-under-the-hood)
3. [The Linux Primitives Docker Is Built On](#3-the-linux-primitives-docker-is-built-on)
4. [Images vs. Containers — The Single Most Important Distinction](#4-images-vs-containers--the-single-most-important-distinction)
5. [The Docker Daemon, CLI, and How They Talk to Each Other](#5-the-docker-daemon-cli-and-how-they-talk-to-each-other)
6. [Registries — What They Are and Why They Matter](#6-registries--what-they-are-and-why-they-matter)
7. [The Full Lifecycle: From Dockerfile to Running Container](#7-the-full-lifecycle-from-dockerfile-to-running-container)
8. [How This Maps to the Deployment Platform We're Building](#8-how-this-maps-to-the-deployment-platform-we-re-building)
9. [Common Beginner Misconceptions That Cause Confusion Later](#9-common-beginner-misconceptions-that-cause-confusion-later)

---

## 1. What Docker Is and the Problem It Solves

Imagine you've built a Node.js API on your MacBook. It works. You push it to your Linux server, install Node, run `npm install`, and it blows up. Wrong Node version. Missing system library. A Python dependency compiled against the wrong glibc. Your colleague clones the repo, runs it, and gets a completely different error.

This is the environment problem. Your code doesn't just depend on your source files — it depends on the operating system, the installed system libraries, specific versions of runtimes, environment variables, filesystem paths, and a dozen other things that vary between machines.

**Docker solves this by letting you package your application together with its entire environment into a single, portable artifact called an image.** That image contains your code, the runtime (Node, Python, Go binary — whatever), the system libraries it needs, the filesystem layout, environment variables, and the exact command to start the application. When you run that image, Docker creates an isolated environment called a container where your app runs exactly as you packaged it — on your laptop, on a server, on your colleague's machine, anywhere.

Think of it this way:

- **Without Docker:** "Here's my code. Good luck figuring out what else you need to install to make it work."
- **With Docker:** "Here's a box containing my code and everything it needs. Just run the box."

### Why This Matters for Our Deployment Platform

The platform we're building needs to deploy apps written in any language. A user might push a Go API, a Python ML service, and a React frontend — all to the same VM. Without Docker, you'd need to install Go, Python, Node, and all their dependencies on the VM, manage version conflicts, and figure out isolation between apps. With Docker, each app is a self-contained image. They don't know about each other. They can't interfere with each other. You just run them.

This is why every modern deployment platform — Vercel, Railway, Render, Fly.io, and the one we're building — is built on containers.

---

## 2. VMs vs. Containers — What's Actually Different Under the Hood

You may have heard containers described as "lightweight VMs." This is a useful starting point but technically wrong, and the difference matters.

### Virtual Machines

A virtual machine runs a **complete operating system** on top of virtualized hardware. Here's what that stack looks like:

```
┌─────────────────────────────────────────────────────────┐
│                    Your Application                      │
├─────────────────────────────────────────────────────────┤
│               Guest OS (full Linux kernel,               │
│               init system, package manager, etc.)        │
├─────────────────────────────────────────────────────────┤
│                 Hypervisor (VMware, KVM, etc.)           │
├─────────────────────────────────────────────────────────┤
│                    Host Operating System                  │
├─────────────────────────────────────────────────────────┤
│                    Physical Hardware                      │
└─────────────────────────────────────────────────────────┘
```

Every VM has its own kernel, its own init system, its own copy of system libraries. A minimal Ubuntu VM image is ~500MB. If you run five apps in five VMs, that's five full operating systems consuming RAM, CPU, and disk — even before your apps start.

Boot time: 30 seconds to minutes.

### Containers

A container shares the host's kernel. It doesn't have its own OS. Instead, it uses Linux kernel features to create an isolated view of the system:

```
┌──────────┐  ┌──────────┐  ┌──────────┐
│  App A   │  │  App B   │  │  App C   │
│  libs    │  │  libs    │  │  libs    │
├──────────┤  ├──────────┤  ├──────────┤
│          Container Runtime (Docker)     │
├─────────────────────────────────────────┤
│            Host OS (single kernel)      │
├─────────────────────────────────────────┤
│            Physical Hardware            │
└─────────────────────────────────────────┘
```

Each container gets:
- Its own filesystem (but it's just a thin layer on top of shared base layers)
- Its own process tree (container processes can't see host processes)
- Its own network interface (its own IP address, its own ports)
- Its own resource limits (capped CPU and memory)

But they all share the same Linux kernel. No second OS boots up. A minimal container image can be as small as 5MB (Alpine Linux). Startup time: milliseconds.

### The Practical Differences That Matter for Us

| Property | VM | Container |
|---|---|---|
| Startup time | 30s–minutes | Milliseconds |
| Image size | 500MB–several GB | 5MB–500MB |
| Memory overhead | Hundreds of MB per VM (guest OS) | Negligible (no guest OS) |
| Isolation | Strong (separate kernel) | Good (shared kernel, namespace isolation) |
| Density | ~10-20 VMs per server | Hundreds of containers per server |
| Portability | Hardware/hypervisor dependent | Runs anywhere Docker runs |

For our deployment platform on a single VM, this is critical. We might be running 10, 20, or 50 apps on one machine. With VMs, we'd run out of resources after a handful. With containers, we can run dozens with minimal overhead.

### A Note on Security

Because containers share the host kernel, the isolation boundary is thinner than a VM. A kernel vulnerability could theoretically allow a container to break out to the host. In practice, for a self-hosted platform on your own VM running your own code, this is an acceptable trade-off. If you were running untrusted code from strangers (like a public cloud provider does), you'd add extra isolation layers (gVisor, Firecracker micro-VMs, etc.). For our use case, standard Docker isolation is fine.

---

## 3. The Linux Primitives Docker Is Built On

Docker is not magic. It's a user-friendly wrapper around Linux kernel features that have existed since the mid-2000s. Understanding these primitives — even at a high level — will save you hours of confusion when you're debugging networking, permissions, or resource limits later.

### Namespaces — Isolation

Namespaces give a process its own private view of certain system resources. A process inside a namespace thinks it's the only thing on the system.

Docker uses these namespaces:

| Namespace | What It Isolates | What It Means for a Container |
|---|---|---|
| **PID** | Process IDs | The container's main process is PID 1 inside the container. It can't see host processes. |
| **NET** | Network interfaces, IPs, ports | The container gets its own IP address, its own `eth0`, its own port space. Port 80 inside the container is NOT port 80 on the host (until you explicitly map it). |
| **MNT** | Filesystem mounts | The container sees its own root filesystem. It can't see the host filesystem (unless you explicitly mount a volume). |
| **UTS** | Hostname | The container has its own hostname. |
| **IPC** | Inter-process communication | Shared memory segments are isolated between containers. |
| **USER** | User/group IDs | A process can be `root` (UID 0) inside the container but mapped to an unprivileged user on the host. |

**Why this matters for us:** When you run `docker exec -it mycontainer sh` and see PID 1, or when a container's port 3000 doesn't conflict with another container's port 3000, or when a container can't read another container's files — that's namespaces doing their job.

### Cgroups (Control Groups) — Resource Limits

Namespaces isolate what a process can *see*. Cgroups limit what it can *use*.

Cgroups let you set hard limits on:
- **CPU:** This container can use at most 0.5 CPU cores
- **Memory:** This container can use at most 512MB of RAM. If it tries to use more, the kernel kills it (the dreaded OOM kill).
- **Disk I/O:** Throttle read/write speed
- **Network bandwidth:** Limit outbound traffic

**Why this matters for us:** On our single VM, one misbehaving app could eat all the CPU and memory, starving everything else. Cgroups (exposed through Docker's `--memory` and `--cpus` flags) let us enforce fair resource sharing. We'll configure this per app in Chapter 10.

### Union Filesystem — Layered Images

Docker images are built in layers. Each instruction in a Dockerfile creates a new layer. These layers are stacked using a union filesystem (commonly OverlayFS on modern Linux).

```
┌─────────────────────────────┐
│ Layer 4: COPY . /app        │  ← Your application code
├─────────────────────────────┤
│ Layer 3: RUN npm install    │  ← Your dependencies
├─────────────────────────────┤
│ Layer 2: RUN apt-get install│  ← System packages
├─────────────────────────────┤
│ Layer 1: FROM node:20       │  ← Base OS + Node runtime
└─────────────────────────────┘
```

Key properties of layers:
- **Layers are read-only.** Once built, a layer never changes.
- **Layers are shared.** If ten containers use `node:20` as their base, they share that base layer on disk. It's not duplicated.
- **When a container writes to the filesystem**, it writes to a thin read-write layer on top. This is "copy-on-write" — the original image layer is untouched.
- **Layers are cached.** If a layer hasn't changed, Docker reuses it on the next build. This is why the order of instructions in your Dockerfile affects build speed dramatically (more in Chapter 2).

**Why this matters for us:** When deploying 20 apps that all use `node:20-alpine` as a base, that ~150MB base layer exists once on disk. Each app only adds its own code and dependencies. This is what makes it practical to run many apps on a single VM.

---

## 4. Images vs. Containers — The Single Most Important Distinction

This is the concept that causes the most confusion for beginners, and it's the most important one to get right.

### The Analogy

An **image** is like a class definition. A **container** is like an instance of that class.

Or in filesystem terms: an image is like an `.iso` file. A container is like a running VM booted from that `.iso`.

### The Precise Definition

**An image** is a read-only, layered filesystem snapshot plus some metadata (what command to run when started, what environment variables to set, what ports to expose, etc.). It's an artifact. It sits on disk. It doesn't run.

**A container** is a running (or stopped) instance of an image. When you start a container from an image, Docker:
1. Takes all the read-only layers of the image
2. Adds a thin read-write layer on top (the container layer)
3. Creates namespaces for the process (PID, NET, MNT, etc.)
4. Sets up cgroups for resource limits
5. Runs the command specified in the image

You can create many containers from the same image. Each gets its own read-write layer, its own namespaces, its own process. They're completely independent.

```
       ┌──────────────────────────────┐
       │         Image: myapp:v2      │    (Read-only, on disk)
       │  Layer 3: app code           │
       │  Layer 2: dependencies       │
       │  Layer 1: node:20-alpine     │
       └──────────┬───────────────────┘
                  │
        ┌─────────┼──────────┐
        │         │          │
   ┌────▼───┐ ┌──▼─────┐ ┌──▼─────┐
   │Container│ │Container│ │Container│   (Running processes,
   │   A     │ │   B     │ │   C     │    each with own R/W layer)
   │ :3000   │ │ :3001   │ │ :3002   │
   └─────────┘ └────────┘ └────────┘
```

### Image Naming Convention

Images are identified by a name and a tag:

```
node:20-alpine
 │      │
 │      └── Tag: specific version/variant
 └── Name: the image name (often a repository path)
```

Real-world examples:
```
postgres:16-alpine          # PostgreSQL 16 on Alpine Linux
nginx:1.25                  # Nginx 1.25
myregistry.com/myapp:v2.3   # Your app, version 2.3, stored in your private registry
myregistry.com/myapp:abc123  # Your app, tagged with the git commit SHA
```

The tag `latest` is the default if you don't specify one. **In production, never use `latest`.** Always use specific, immutable tags (version numbers or git commit SHAs). We'll use commit SHAs in our deploy pipeline — this way, every deployment is traceable to an exact commit.

### Container Lifecycle

A container can be in one of these states:

```
Created  →  Running  →  Stopped  →  Removed
   │                       │
   │                       └── Can be restarted
   └── Never started (created but not run)
```

- **Created:** The container exists but hasn't been started.
- **Running:** The process inside is executing.
- **Stopped (Exited):** The process has finished or was killed. The container's filesystem (its read-write layer) still exists on disk. You can restart it or copy files out of it.
- **Removed:** The container and its read-write layer are deleted from disk.

**Common confusion:** Stopping a container does NOT delete it. Stopped containers take up disk space. You must explicitly remove them (`docker rm`) or use auto-removal (`docker run --rm`).

---

## 5. The Docker Daemon, CLI, and How They Talk to Each Other

Docker is a client-server system. There are two main components:

### The Docker Daemon (`dockerd`)

This is the background service that does all the actual work — building images, running containers, managing networks, managing volumes. It runs as a root-level process on the host machine and listens for API requests.

On a Linux server (which is what we'll use), the daemon runs as a systemd service and listens on a Unix socket at `/var/run/docker.sock`.

### The Docker CLI (`docker`)

This is the command-line tool you type commands into. It's just an API client. When you run:

```bash
docker run -d -p 8080:3000 myapp:v2
```

The CLI sends an HTTP request to the daemon (over the Unix socket) that says: "Create and start a container from the image `myapp:v2`, detach it, and map port 8080 on the host to port 3000 in the container." The daemon does the work.

### The Architecture

```
┌────────────────┐         ┌──────────────────────────────────┐
│   Docker CLI   │ ──────▶ │         Docker Daemon            │
│ (your terminal)│  REST   │  ┌────────┐  ┌────────────────┐  │
│                │  API    │  │ Images │  │   Containers   │  │
│                │  over   │  ├────────┤  ├────────────────┤  │
│                │  Unix   │  │Networks│  │    Volumes     │  │
│                │  socket │  └────────┘  └────────────────┘  │
└────────────────┘         └──────────────────────────────────┘
                                      │
                                      ▼
                           ┌──────────────────────┐
                           │   Container Runtime   │
                           │  (containerd + runc)  │
                           └──────────────────────┘
```

### Why This Matters

1. **Remote management:** Because it's an API, you can manage Docker on a remote machine by pointing the CLI at a remote daemon (via TCP instead of Unix socket). Useful when your server is a remote VM.

2. **The Docker socket is powerful and dangerous.** Anything that can talk to `/var/run/docker.sock` has root-level access to the host. This is why mounting the Docker socket into a container (which some tools require) is a significant security decision. We'll deal with this carefully when building our deploy pipeline.

3. **Docker Compose, Docker Desktop, and other tools** are all just different API clients talking to the same daemon. Same underlying engine.

### Docker Desktop vs. Docker Engine

- **Docker Desktop** is what you install on macOS and Windows. It runs a Linux VM behind the scenes (because Docker containers need a Linux kernel) and bundles the daemon + CLI + a GUI.
- **Docker Engine** is what you install on a Linux server. It's just the daemon + CLI. No VM needed because you already have a Linux kernel.

For development on your Mac, you'll use Docker Desktop. On your deployment VM (Ubuntu), you'll install Docker Engine directly. The CLI commands are identical.

---

## 6. Registries — What They Are and Why They Matter

A **registry** is a storage and distribution service for Docker images. It's like npm for Node packages or PyPI for Python packages, but for Docker images.

### How Registries Work

```
Your laptop                    Registry                    Your server
┌──────────┐   docker push    ┌──────────┐   docker pull   ┌──────────┐
│ Build     │ ──────────────▶ │  Store   │ ◀────────────── │  Deploy  │
│ image     │                 │  images  │                  │  image   │
└──────────┘                  └──────────┘                  └──────────┘
```

The flow:
1. You build an image on your laptop (or in a CI pipeline).
2. You push the image to a registry.
3. Your server pulls the image from the registry.
4. Your server runs the image as a container.

### Docker Hub

Docker Hub (`hub.docker.com`) is the default public registry. When you write `FROM node:20-alpine` in a Dockerfile, Docker pulls that image from Docker Hub. It hosts official images for almost every major runtime and tool (Node, Python, Go, PostgreSQL, Redis, Nginx, etc.).

You get one free private repository. For more, you pay.

### Other Registries

- **GitHub Container Registry (ghcr.io):** Free private images for GitHub users. Good choice for personal projects.
- **AWS ECR, Google Artifact Registry, Azure ACR:** Cloud provider registries. Good for cloud deployments.
- **Self-hosted:** You can run your own registry as a Docker container (!). We'll use this for our platform.

### Image Naming with Registries

The full image name includes the registry:

```
ghcr.io/yourusername/myapp:v2
  │           │         │    │
  │           │         │    └── Tag
  │           │         └── Image name
  │           └── Namespace (usually your username or org)
  └── Registry hostname (omitted = Docker Hub)
```

When you write `node:20-alpine`, it's actually shorthand for `docker.io/library/node:20-alpine`.

### How This Fits Our Platform

In our deploy pipeline:
1. A git push triggers a webhook on our VM.
2. Our platform pulls the code and builds a Docker image on the VM.
3. We can either (a) build and run locally (no registry needed since build and deploy are on the same machine), or (b) push to a private registry for backup/rollback purposes.

For a single-VM platform, option (a) is simpler. We'll build directly on the VM and tag images with git commit SHAs so we can roll back to any previous version.

---

## 7. The Full Lifecycle: From Dockerfile to Running Container

Let's walk through the complete journey. This is the flow that our deployment platform will automate for every git push.

### Step 1: Write a Dockerfile

A Dockerfile is a text file with instructions for building an image. Here's a real one for a Go service (we'll break this down in depth in Chapter 2):

```dockerfile
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o server ./cmd/server

FROM alpine:3.19
RUN apk add --no-cache ca-certificates
COPY --from=builder /app/server /usr/local/bin/server
EXPOSE 8080
CMD ["server"]
```

### Step 2: Build the Image

```bash
docker build -t myapp:abc123f -f Dockerfile .
#             │                │              │
#             │                │              └── Build context: current directory
#             │                └── Which Dockerfile to use
#             └── Tag the resulting image as myapp:abc123f
```

Docker reads the Dockerfile, executes each instruction in order, and produces a layered image. Each instruction creates one layer. The final result is stored locally on the machine where you ran the build.

### Step 3: (Optional) Push to a Registry

```bash
docker push myregistry.com/myapp:abc123f
```

This uploads all the layers of the image to the registry. If the registry already has some of the layers (like the base `alpine:3.19` layer), only the new/changed layers are uploaded. This makes pushes fast after the first one.

### Step 4: (Optional) Pull on the Server

```bash
docker pull myregistry.com/myapp:abc123f
```

Downloads the image layers to the server. Again, only layers it doesn't already have.

If you build directly on the server (which we will in our platform), you skip steps 3 and 4.

### Step 5: Run the Container

```bash
docker run -d \
  --name myapp \
  -p 8080:8080 \
  --restart unless-stopped \
  myapp:abc123f
```

This tells Docker:
- `-d`: Run in the background (detached)
- `--name myapp`: Name the container `myapp` (so we can refer to it later)
- `-p 8080:8080`: Map port 8080 on the host to port 8080 in the container
- `--restart unless-stopped`: Automatically restart the container if it crashes or the VM reboots
- `myapp:abc123f`: The image to run

The container is now running. The Go server inside is listening on port 8080. Traffic hitting the VM on port 8080 reaches the container.

### Step 6: Manage the Running Container

```bash
docker ps                    # List running containers
docker logs myapp            # See the app's stdout/stderr output
docker exec -it myapp sh     # Get a shell inside the container (for debugging)
docker stop myapp            # Gracefully stop the container
docker rm myapp              # Remove the stopped container
```

### The Full Lifecycle as a Diagram

```
Developer writes code
        │
        ▼
   Dockerfile
        │
        ▼
  docker build ──▶ Image (stored locally)
        │                    │
        │              docker push (optional)
        │                    │
        │                    ▼
        │              Registry (remote store)
        │                    │
        │              docker pull (optional)
        │                    │
        ▼                    ▼
  docker run ───▶ Container (running process)
        │
        ▼
  docker logs / exec / stop / rm
```

---

## 8. How This Maps to the Deployment Platform We're Building

Let's connect everything we've learned to the concrete system we'll build across this guide. Here's the high-level architecture:

```
┌──────────────────────────────────────────────────────────────────┐
│                          YOUR VM                                  │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                     Docker Network                          │  │
│  │                                                             │  │
│  │  ┌────────────┐                                             │  │
│  │  │   Caddy    │  ← Receives all HTTP/HTTPS traffic          │  │
│  │  │  (reverse  │  ← Routes to the right app by domain name   │  │
│  │  │   proxy)   │  ← Handles SSL certificates automatically   │  │
│  │  └──────┬─────┘                                             │  │
│  │         │                                                   │  │
│  │    ┌────┴────┬──────────┬──────────┐                        │  │
│  │    │         │          │          │                         │  │
│  │  ┌─▼──┐  ┌──▼──┐  ┌───▼──┐  ┌───▼──┐                      │  │
│  │  │App │  │App  │  │App   │  │App   │  ← Each app is        │  │
│  │  │ A  │  │ B   │  │ C    │  │ D    │    a Docker container  │  │
│  │  │Go  │  │Node │  │Python│  │React │    running from        │  │
│  │  │:8080│ │:3000│  │:5000 │  │:80   │    its own image       │  │
│  │  └────┘  └─────┘  └──────┘  └──────┘                       │  │
│  │                                                             │  │
│  │  ┌──────────┐  ┌───────────┐  ┌──────────┐                 │  │
│  │  │Prometheus│  │   Loki    │  │ Grafana  │  ← Observability │  │
│  │  │+ cAdvisor│  │+ Promtail │  │Dashboard │    stack         │  │
│  │  └──────────┘  └───────────┘  └──────────┘                 │  │
│  │                                                             │  │
│  │  ┌──────────────────┐                                       │  │
│  │  │ Webhook Receiver │  ← Listens for git push events       │  │
│  │  │   (Go service)   │  ← Triggers build + deploy           │  │
│  │  └──────────────────┘                                       │  │
│  │                                                             │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

Here's how each Docker concept maps to a piece of the platform:

| Docker Concept | Role in Our Platform |
|---|---|
| **Image** | Every app, every infrastructure component (Caddy, Prometheus, Grafana, the webhook receiver) is an image. |
| **Container** | Every running instance is a container. Each app runs in its own isolated container. |
| **Dockerfile** | Each app includes a Dockerfile. Our platform builds an image from it on every push. |
| **Docker build** | Triggered automatically when a webhook fires. Builds a new image tagged with the git SHA. |
| **Docker network** | All containers live on a shared Docker network so they can talk to each other by name (e.g., the webhook receiver tells Caddy about a new app). |
| **Volumes** | Database containers use volumes so data survives container restarts. |
| **Docker Compose** | The observability stack (Prometheus + Loki + Grafana + cAdvisor + Promtail) is defined as a single Compose file. |
| **Registry** | Images are built and stored locally on the VM. Old images are kept for rollback. |

### The Deploy Flow (What We'll Build)

```
1. Developer pushes code to GitHub
       │
2. GitHub sends a webhook to our VM
       │
3. Webhook receiver (Go service) catches it
       │
4. Pulls the latest code
       │
5. Runs `docker build` with the app's Dockerfile
       │
6. Tags the image with the git commit SHA
       │
7. Stops the old container (if any)
       │
8. Starts a new container from the new image
       │
9. Updates Caddy's routing config:
       appname.yourdomain.com → new container
       │
10. Streams build logs to Loki → viewable in Grafana
       │
11. cAdvisor + Prometheus collect metrics → viewable in Grafana
       │
12. Done. App is live at appname.yourdomain.com with HTTPS.
```

Everything in this flow — every step — is a Docker operation. By the end of this guide, you'll have built every piece of this.

---

## 9. Common Beginner Misconceptions That Cause Confusion Later

Having taught Docker to many developers, here are the misunderstandings that cause the most grief. Internalize these now and save yourself hours of debugging.

### Misconception 1: "A container is a lightweight VM"

**Reality:** A container is a process (or group of processes) running on the host, with isolation and resource limits applied by the kernel. It's not a separate machine. It doesn't have its own kernel. When you `docker exec` into a container, you're not "SSH-ing into a VM" — you're starting another process in the same namespaces as the container's main process.

**Why it matters:** If the container's main process (PID 1) exits, the container stops. There's no "OS" keeping it alive. If you run `docker run ubuntu` without a command that keeps running, the container starts, the default command runs (usually bash, which exits immediately because there's no terminal attached), and the container stops. This confuses many beginners.

### Misconception 2: "My container's data is saved somewhere"

**Reality:** By default, anything written inside a container is stored in the container's read-write layer. When you remove the container (`docker rm`), that layer is deleted. Your data is gone.

If your database is running in a container without a volume, and you remove the container, your database is empty. This is by design. Containers are meant to be ephemeral. Persistent data must go in a volume — we'll cover this in detail in Chapter 5.

### Misconception 3: "I need to install Docker inside my container"

**Reality:** You don't run Docker inside Docker (in most cases). The container runs your application — Node, Python, Go, whatever. Docker is the thing that runs the container. You don't put Docker inside Docker any more than you'd install VMware inside a VM.

The exception is CI/CD systems that need to build Docker images. They need access to a Docker daemon, but that's usually done by mounting the host's Docker socket, not by installing Docker inside the container. We'll handle this carefully in our platform.

### Misconception 4: "`EXPOSE` in a Dockerfile publishes a port"

**Reality:** `EXPOSE` is documentation. It tells humans and tools "this container listens on this port." It does NOT make the port accessible from outside. To actually make a container's port reachable, you use `-p` at runtime:

```bash
docker run -p 8080:3000 myapp    # Host port 8080 → container port 3000
```

We'll cover networking in detail in Chapter 4.

### Misconception 5: "I should use `latest` tag in production"

**Reality:** `latest` is not a magic "most recent" tag. It's just the default tag when none is specified. It's mutable — it can point to a different image at any time. If your production server pulls `myapp:latest` today and tomorrow, it might get two completely different images.

**In production, always use immutable tags.** For our platform, we tag every image with the git commit SHA:
```
myapp:a1b2c3d    # This always refers to the exact same image
```

This gives you:
- Traceability (you know exactly what code is running)
- Reproducibility (you can roll back to this exact image)
- Safety (no surprise changes)

### Misconception 6: "Stopping a container removes it"

**Reality:** `docker stop` sends a SIGTERM to the container's main process, waits (default 10 seconds), then sends SIGKILL. The container enters the "stopped" state. It still exists on disk. Its filesystem (read-write layer) is preserved. You can restart it or inspect it.

To actually remove a container, use `docker rm`. To stop and remove in one shot: `docker rm -f`. To auto-remove when it stops: `docker run --rm`.

Stopped containers and their layers accumulate. We'll set up automatic cleanup in Chapter 10.

### Misconception 7: "Docker Compose is a different thing from Docker"

**Reality:** Docker Compose is just a tool that reads a YAML file and makes Docker API calls. Every `docker compose up` translates to a series of `docker network create`, `docker volume create`, `docker run` commands. There's nothing Compose does that you couldn't do with the Docker CLI by hand — Compose just makes it declarative and repeatable.

Understanding this duality is important. We'll use Compose for the observability stack (Prometheus + Grafana + etc.) because managing 5+ containers by hand is painful. But individual app containers will be managed directly by our Go deploy service.

### Misconception 8: "Multi-stage builds are an advanced/optional optimization"

**Reality:** Multi-stage builds are the standard way to build production images. A "single-stage" build that includes the compiler, build tools, and source code in the final image is the exception, not the rule. Every Go service, every compiled frontend, every language with a build step should use multi-stage builds. We'll cover this thoroughly in Chapter 2.

---

## Summary

Here's what you now know:

- Docker packages your application and its environment into a portable image.
- Containers are isolated processes sharing the host kernel — not lightweight VMs.
- Docker leverages Linux namespaces (isolation), cgroups (resource limits), and union filesystems (layered images).
- An image is a read-only template; a container is a running instance of an image.
- The Docker CLI talks to the Docker daemon via a REST API over a Unix socket.
- Registries store and distribute images (Docker Hub, GHCR, self-hosted).
- The full lifecycle is: Dockerfile → build → (push → pull) → run → manage.
- Our deployment platform will automate this entire lifecycle for every git push.

Everything from here builds on these foundations. In Chapter 2, we'll dive deep into Dockerfiles — the instructions that turn your code into production-ready images.

---

→ next: [chapter02_dockerfiles.md](chapter02_dockerfiles.md)
