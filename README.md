# Mini Polymarket Tracker

A webapp that tracks wallet positions and PnL on Polymarket prediction markets.

![Dashboard Preview](docs/dashboard-preview.png)

## Features

- 📊 **Dashboard** - Overview of total PnL, volume, and wallet leaderboard
- 👛 **Wallet Tracking** - Track multiple wallet addresses with aliases
- 📈 **Position Tracking** - View open and closed positions per wallet
- 💰 **PnL Calculation** - Realized and unrealized profit/loss using weighted average cost
- 📜 **Trade History** - Complete trade history with filtering
- 🏪 **Market Details** - View all positions and trades per market
- 🔄 **Automatic Sync** - Background job to keep data up-to-date
- 🐳 **Docker Ready** - Easy deployment with Docker Compose

## Tech Stack

- **Frontend**: Next.js 14 (App Router), React, Tailwind CSS, Recharts
- **Backend**: Next.js API Routes
- **Database**: PostgreSQL with Prisma ORM
- **Jobs**: Node.js worker with cron-style scheduling
- **Containerization**: Docker & Docker Compose

## Quick Start

### Prerequisites

- Node.js 18+ 
- PostgreSQL 15+ (or Docker)
- npm or yarn

### Development Setup

1. **Clone and install dependencies:**

```bash
git clone <repo-url>
cd pnltracker
npm install
```

2. **Set up environment variables:**

```bash
cp env.example .env
```

Edit `.env` with your settings:

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/pnltracker?schema=public"
REDIS_URL="redis://localhost:6379"
ADMIN_PASSWORD=your-admin-password
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

3. **Start the database (with Docker):**

```bash
docker-compose up -d postgres redis
```

4. **Initialize the database:**

```bash
npm run db:push
npm run db:seed
```

5. **Start the development server:**

```bash
npm run dev
```

6. **Open the app:**

Visit [http://localhost:3000](http://localhost:3000)

### Docker Deployment

For production deployment with Docker:

```bash
# Build and start all services
docker-compose up -d --build

# View logs
docker-compose logs -f app

# Stop services
docker-compose down
```

## Project Structure

```
pnltracker/
├── prisma/
│   ├── schema.prisma     # Database schema
│   └── seed.ts           # Seed data script
├── src/
│   ├── app/              # Next.js App Router pages
│   │   ├── api/          # API routes
│   │   ├── admin/        # Admin page
│   │   ├── markets/      # Markets pages
│   │   └── wallets/      # Wallet pages
│   ├── components/       # React components
│   ├── lib/
│   │   ├── pnl-engine.ts # PnL calculation engine
│   │   ├── providers/    # Data source providers
│   │   └── sync/         # Sync services
│   ├── jobs/
│   │   └── worker.ts     # Background sync worker
│   └── types/            # TypeScript types
├── docker-compose.yml    # Docker services
├── Dockerfile           # App container
└── package.json
```

## API Endpoints

### Wallets
- `GET /api/wallets` - List all tracked wallets with stats
- `POST /api/wallets` - Add a new wallet
- `GET /api/wallets/:id` - Get wallet details
- `PUT /api/wallets/:id` - Update wallet alias
- `DELETE /api/wallets/:id` - Remove wallet
- `GET /api/wallets/:id/trades` - Get wallet trades
- `GET /api/wallets/:id/positions` - Get wallet positions

### Markets
- `GET /api/markets` - List markets with filtering
- `GET /api/markets/:conditionId` - Get market details

### Sync
- `GET /api/sync` - Get sync status
- `POST /api/sync/run` - Trigger manual sync (requires auth)

### Stats
- `GET /api/stats` - Get dashboard statistics
- `GET /api/health` - Health check

## PnL Calculation

The PnL engine uses **weighted average cost** method:

### Buy Trade
```
new_shares = shares + size
new_avg = (shares × avg + size × price) / new_shares
```

### Sell Trade
```
realized_pnl += (price - avg) × size - fee
shares -= size
```

### Unrealized PnL
```
unrealized = (mark_price - avg_entry) × shares
```

### Market Resolution
When a market resolves, all remaining shares settle at the payout price (0 or 1 for binary markets).

## Data Providers

The app uses an interface-based data provider system with two implementations:

### Mock Provider (Development)
Uses generated mock data for development and testing.

### Polymarket Provider (Production)
Uses real Polymarket data from:
- **Goldsky Activity Subgraph** - Trades/fills with pagination
- **Gamma Markets API** - Market metadata (title, outcomes, status)
- **CLOB API** - Current prices for mark-to-market

```typescript
interface ITradeSource {
  fetchTrades(wallet: string, from: Date, to: Date): Promise<RawTrade[]>;
}

interface IMarketSource {
  fetchMarket(conditionId: string): Promise<MarketData | null>;
}

interface IPriceSource {
  getMarkPrice(conditionId: string, outcome: number): Promise<MarkPrice | null>;
}
```

### Switching Providers

Set `DATA_PROVIDER` in your `.env`:

```env
# Use mock data
DATA_PROVIDER=mock

# Use real Polymarket data
DATA_PROVIDER=polymarket
```

### Rate Limiting

The GraphQL client includes:
- Configurable delay between requests (`API_RATE_LIMIT_MS`)
- Exponential backoff retry (`API_MAX_RETRIES`)
- Request queuing to prevent concurrent floods

## Background Worker

Start the background sync worker:

```bash
npm run worker
```

The worker runs:
- **Trade sync**: Every 2 minutes (configurable)
- **Position recompute**: After each trade sync
- **Snapshots**: Every 15 minutes

Configure via environment variables:
- `SYNC_INTERVAL_SECONDS` - Trade sync interval (default: 120)
- `REORG_LOOKBACK_MINUTES` - Lookback window for reorg safety (default: 120)

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | Required |
| `REDIS_URL` | Redis connection string | Optional |
| `DATA_PROVIDER` | `mock` or `polymarket` | `mock` |
| `GOLDSKY_ACTIVITY_ENDPOINT` | Goldsky Activity subgraph URL | Polymarket default |
| `GOLDSKY_POSITIONS_ENDPOINT` | Goldsky Positions subgraph URL | Polymarket default |
| `GAMMA_MARKETS_API` | Gamma Markets API base URL | `https://gamma-api.polymarket.com` |
| `POLYMARKET_CLOB_API` | Polymarket CLOB API base URL | `https://clob.polymarket.com` |
| `API_RATE_LIMIT_MS` | Delay between API requests | `100` |
| `API_MAX_RETRIES` | Max retries for failed requests | `3` |
| `ADMIN_PASSWORD` | Password for admin API routes | `changeme` |
| `SYNC_INTERVAL_SECONDS` | Sync interval in seconds | `120` |
| `REORG_LOOKBACK_MINUTES` | Lookback for reorg safety | `120` |
| `NEXT_PUBLIC_APP_URL` | App URL for API calls | `http://localhost:3000` |

## Testing

Run PnL engine tests:

```bash
npm test
```

Test cases include:
- Weighted average price calculation
- Realized PnL on partial sells
- Market resolution settlement
- Edge cases (zero shares, large numbers)

## Troubleshooting

### Database connection issues
```bash
# Check if Postgres is running
docker-compose ps

# Check connection
docker-compose exec postgres psql -U postgres -d pnltracker
```

### Prisma issues
```bash
# Regenerate client
npm run db:generate

# Reset database
npx prisma migrate reset
```

### Sync not working
1. Check the admin page for sync status
2. Check logs: `docker-compose logs -f app`
3. Verify wallets are added in admin

## Roadmap

- [ ] Real Polymarket data provider (subgraph/API)
- [ ] Alerts (Telegram/Discord webhooks)
- [ ] Advanced filtering and search
- [ ] Export to CSV
- [ ] Multi-chain support
- [ ] Authentication (NextAuth)

## License

MIT

## Disclaimer

This tool is for informational purposes only. Data may be delayed or inaccurate. Not financial advice. Always verify information on-chain before making trading decisions.
