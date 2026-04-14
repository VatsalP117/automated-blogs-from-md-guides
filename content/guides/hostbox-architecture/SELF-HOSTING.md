# Self-Hosting Guide

Complete guide to self-hosting Hostbox on your own server.

## Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| RAM | 512 MB | 1 GB+ |
| Disk | 10 GB | 20 GB+ |
| CPU | 1 vCPU | 2 vCPU |
| OS | Ubuntu 22.04+ / Debian 12+ | Ubuntu 24.04 |

You also need:
- A **domain name** (e.g., `hostbox.example.com`)
- **Docker** and **Docker Compose** installed
- Ports **80** and **443** open

## DNS Setup

Point your domain and wildcard subdomain to your server's IP:

```
A     hostbox.example.com       → YOUR_SERVER_IP
A     *.hostbox.example.com     → YOUR_SERVER_IP
```

### Provider-Specific Guides

**Cloudflare**: Add both A records. Set proxy status to "DNS only" (grey cloud) for the wildcard record to allow direct SSL.

**DigitalOcean**: In the Networking panel, add both A records pointing to your droplet IP.

**Namecheap**: In Advanced DNS, add both A records. Use `@` for the root and `*` for the wildcard.

## Installation

### Automated (Recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/vatsalpatel/hostbox/main/scripts/install.sh | sudo bash
```

The script will:
1. Install Docker if needed
2. Ask for your domain and SSL email
3. Generate secure secrets
4. Start Hostbox

### Manual

```bash
# Create directory
sudo mkdir -p /opt/hostbox
cd /opt/hostbox

# Download compose file
curl -fsSL https://raw.githubusercontent.com/vatsalpatel/hostbox/main/docker-compose.yml -o docker-compose.yml

# Create environment file
cat > .env << 'EOF'
PLATFORM_DOMAIN=hostbox.example.com
PLATFORM_HTTPS=true
JWT_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)
ACME_EMAIL=admin@example.com
LOG_LEVEL=info
EOF

# Start
docker compose up -d
```

## Configuration

All configuration is done via environment variables in the `.env` file:

| Variable | Description | Default |
|----------|-------------|---------|
| `PLATFORM_DOMAIN` | Your domain (required) | — |
| `PLATFORM_HTTPS` | Enable HTTPS | `true` |
| `PLATFORM_NAME` | Display name | `Hostbox` |
| `JWT_SECRET` | JWT signing key (required) | — |
| `ENCRYPTION_KEY` | Env var encryption key (required) | — |
| `ACME_EMAIL` | Email for Let's Encrypt | — |
| `DNS_PROVIDER` | DNS provider for wildcard certs | `none` |
| `LOG_LEVEL` | Log level: debug/info/warn/error | `info` |
| `GITHUB_APP_ID` | GitHub App ID | — |
| `GITHUB_APP_SLUG` | GitHub App slug | — |
| `GITHUB_APP_PEM` | GitHub App private key (PEM) | — |
| `GITHUB_WEBHOOK_SECRET` | GitHub webhook secret | — |

### DNS Provider Configuration

For wildcard SSL certificates, configure a DNS provider:

**Cloudflare**:
```env
DNS_PROVIDER=cloudflare
CF_API_TOKEN=your-cloudflare-api-token
```

**AWS Route53**:
```env
DNS_PROVIDER=route53
AWS_ACCESS_KEY_ID=your-key
AWS_SECRET_ACCESS_KEY=your-secret
```

**DigitalOcean**:
```env
DNS_PROVIDER=digitalocean
DO_AUTH_TOKEN=your-token
```

## GitHub App Setup

To enable git-push deployments:

1. Go to **GitHub Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App**
2. Set the following:
   - **Homepage URL**: `https://your-domain.com`
   - **Webhook URL**: `https://your-domain.com/api/v1/github/webhook`
   - **Webhook secret**: Use the `GITHUB_WEBHOOK_SECRET` from your `.env`
3. **Permissions**:
   - Repository: Contents (Read), Pull requests (Read & Write), Commit statuses (Read & Write)
   - Organization: Members (Read)
4. **Events**: Push, Pull request, Installation
5. After creating, note the **App ID** and generate a **Private key**
6. Add to your `.env`:
   ```env
   GITHUB_APP_ID=12345
   GITHUB_APP_SLUG=my-hostbox
   GITHUB_APP_PEM="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
   ```
7. Restart Hostbox: `docker compose restart`

## Firewall

Ensure these ports are open:

| Port | Protocol | Purpose |
|------|----------|---------|
| 80 | TCP | HTTP (redirects to HTTPS) |
| 443 | TCP/UDP | HTTPS + HTTP/3 |
| 22 | TCP | SSH (management) |

```bash
# UFW example
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw allow 22/tcp
sudo ufw enable
```

## Backup & Restore

### Create Backup

```bash
# Via CLI
hostbox admin backup

# Via API
curl -X POST https://your-domain.com/api/v1/admin/backups \
  -H "Authorization: Bearer $TOKEN"
```

Backups are stored in `/opt/hostbox/data/backups/`.

### Restore

```bash
# Via CLI
hostbox admin restore /path/to/backup.db.gz

# Via API
curl -X POST https://your-domain.com/api/v1/admin/backups/restore \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"path": "/app/data/backups/hostbox-20240115-103000.db.gz"}'
```

## Updating

```bash
cd /opt/hostbox
docker compose pull
docker compose up -d
```

## Troubleshooting

### Hostbox won't start

```bash
# Check logs
docker compose logs hostbox

# Check health
curl http://localhost:8080/api/v1/health
```

### SSL certificate issues

```bash
# Check Caddy logs
docker compose logs caddy

# Verify DNS
dig +short your-domain.com
dig +short *.your-domain.com
```

### Build failures

```bash
# Check Docker socket access
docker compose exec hostbox ls -la /var/run/docker.sock

# Check available disk space
df -h
```

### Database issues

```bash
# Check database integrity
docker compose exec hostbox sqlite3 /app/data/hostbox.db "PRAGMA integrity_check;"
```
