# Deploy guide (VPS / production)

This repo supports a full production stack via Docker Compose:

- Next.js app (dashboard + API)
- Postgres
- Redis
- Worker (`npm run worker`)
- Lag recorder (`npm run lag-recorder`)
- One-shot DB migrations (`npm run db:deploy`)

## 0) Server assumptions

- Ubuntu 22.04/24.04 (or Debian equivalent)
- You have SSH access as a sudo user
- You want the app reachable on port 80/443 (recommended via reverse proxy), and containers on an internal docker network

## 1) Install Docker + Compose

On Ubuntu:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg

sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

sudo usermod -aG docker $USER
newgrp docker
```

Verify:

```bash
docker --version
docker compose version
```

## 2) Put the repo on the server

Pick a directory (recommended):

```bash
sudo mkdir -p /opt/pnltracker
sudo chown -R $USER:$USER /opt/pnltracker
cd /opt/pnltracker
```

Then:

```bash
git clone <YOUR_REPO_URL> .
```

## 3) Create `.env` for production

```bash
cp /opt/pnltracker/env.example /opt/pnltracker/.env
```

Edit:

```bash
nano /opt/pnltracker/.env
```

Minimum recommended values:

```env
POSTGRES_PASSWORD=REPLACE_ME_WITH_A_LONG_RANDOM_PASSWORD
POSTGRES_DB=pnltracker

ADMIN_PASSWORD=REPLACE_ME_WITH_A_LONG_RANDOM_PASSWORD
NEXT_PUBLIC_APP_URL=https://YOUR_DOMAIN

DATA_PROVIDER=polymarket

# For lag-recorder (optional but recommended)
POLYMARKET_RTDS_URL=wss://ws-live-data.polymarket.com
POLYGON_WSS_URL=wss://polygon-bor-rpc.publicnode.com
CHAINLINK_POLL_MS=250
BINANCE_SAMPLE_MS=100

# Optional: auth (needed for user websocket / trading endpoints)
POLYMARKET_API_KEY=
POLYMARKET_API_SECRET=
POLYMARKET_API_PASSPHRASE=
POLYMARKET_ADDRESS=
POLYMARKET_PRIVATE_KEY=
```

## 4) First boot (build + migrate + start everything)

From the repo root:

```bash
cd /opt/pnltracker
docker compose -f /opt/pnltracker/docker-compose.prod.yml up -d --build
```

What happens:

- Postgres/Redis start
- `migrate` runs `prisma migrate deploy`
- then app/worker/lag-recorder start

## 5) Check status + logs

```bash
docker compose -f /opt/pnltracker/docker-compose.prod.yml ps
```

Health:

```bash
curl -sS http://localhost:3000/api/health
```

Logs (follow):

```bash
docker compose -f /opt/pnltracker/docker-compose.prod.yml logs -f app
docker compose -f /opt/pnltracker/docker-compose.prod.yml logs -f worker
docker compose -f /opt/pnltracker/docker-compose.prod.yml logs -f lag_recorder
```

## 6) Reverse proxy (recommended)

Use Nginx or Caddy on the host to expose `http(s)://YOUR_DOMAIN` → `http://127.0.0.1:3000`.

If you want, we can add a Caddyfile or Nginx config tailored to your domain + Cloudflare mode.

## 7) Updating (safe flow)

```bash
cd /opt/pnltracker
git pull
docker compose -f /opt/pnltracker/docker-compose.prod.yml up -d --build
```

Rollback (to previous git commit):

```bash
cd /opt/pnltracker
git checkout <KNOWN_GOOD_COMMIT>
docker compose -f /opt/pnltracker/docker-compose.prod.yml up -d --build
```

## 8) Common pitfalls

- If `lag_recorder` shows no Chainlink data: set `POLYGON_WSS_URL` (WS endpoint) in `.env`.
- If WebSocket errors occur on very new Node versions: this repo forces `ws` to avoid native `bufferutil`.
- If you use Cloudflare and websockets: ensure proxy settings allow WS and set correct headers in your proxy config.
