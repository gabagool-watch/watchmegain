import { PrismaClient, TradeSide, MarketStatus } from '@prisma/client';

const prisma = new PrismaClient();

// Example tracked wallets (replace with real addresses)
const SEED_WALLETS = [
  { address: '0x1234567890123456789012345678901234567890', alias: 'Whale Alpha' },
  { address: '0x2345678901234567890123456789012345678901', alias: 'DeFi Degen' },
  { address: '0x3456789012345678901234567890123456789012', alias: 'Smart Money' },
  { address: '0x4567890123456789012345678901234567890123', alias: 'Prediction Pro' },
  { address: '0x5678901234567890123456789012345678901234', alias: 'Market Maker' },
];

// Example markets
const SEED_MARKETS = [
  {
    conditionId: '0xabc123def456789',
    title: 'Will Bitcoin reach $100k by end of 2025?',
    description: 'This market resolves YES if Bitcoin price exceeds $100,000 USD on any major exchange.',
    status: MarketStatus.OPEN,
    outcomes: [{ name: 'Yes', index: 0 }, { name: 'No', index: 1 }],
    endTime: new Date('2025-12-31'),
  },
  {
    conditionId: '0xdef456789abc123',
    title: 'US Presidential Election 2024 Winner',
    description: 'This market resolves based on the winner of the 2024 US Presidential Election.',
    status: MarketStatus.RESOLVED,
    outcomes: [{ name: 'Democrat', index: 0 }, { name: 'Republican', index: 1 }],
    endTime: new Date('2024-11-05'),
    resolutionPrice: { 0: 0, 1: 1 },
  },
  {
    conditionId: '0x789abc123def456',
    title: 'ETH/BTC ratio above 0.05 by March 2025?',
    description: 'Resolves YES if ETH/BTC trading pair exceeds 0.05 ratio.',
    status: MarketStatus.OPEN,
    outcomes: [{ name: 'Yes', index: 0 }, { name: 'No', index: 1 }],
    endTime: new Date('2025-03-31'),
  },
  {
    conditionId: '0x456789abc123def',
    title: 'Fed rate cut in Q1 2025?',
    description: 'Resolves YES if Federal Reserve cuts interest rates in Q1 2025.',
    status: MarketStatus.OPEN,
    outcomes: [{ name: 'Yes', index: 0 }, { name: 'No', index: 1 }],
    endTime: new Date('2025-03-31'),
  },
];

async function main() {
  console.log('🌱 Seeding database...');

  // Clean existing data
  await prisma.snapshot.deleteMany();
  await prisma.trade.deleteMany();
  await prisma.position.deleteMany();
  await prisma.market.deleteMany();
  await prisma.trackedWallet.deleteMany();
  await prisma.syncStatus.deleteMany();

  // Create wallets
  console.log('Creating wallets...');
  const wallets = await Promise.all(
    SEED_WALLETS.map((wallet) =>
      prisma.trackedWallet.create({ data: wallet })
    )
  );

  // Create markets
  console.log('Creating markets...');
  const markets = await Promise.all(
    SEED_MARKETS.map((market) =>
      prisma.market.create({ data: market })
    )
  );

  // Generate mock trades for demonstration
  console.log('Creating mock trades...');
  const now = new Date();
  const trades = [];

  for (const wallet of wallets) {
    for (const market of markets) {
      // Generate 5-15 trades per wallet per market
      const numTrades = Math.floor(Math.random() * 10) + 5;
      
      for (let i = 0; i < numTrades; i++) {
        const daysAgo = Math.floor(Math.random() * 60);
        const blockTime = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
        const outcome = Math.random() > 0.5 ? 0 : 1;
        const side = Math.random() > 0.4 ? TradeSide.BUY : TradeSide.SELL;
        const price = Math.random() * 0.6 + 0.2; // 0.2 - 0.8
        const size = Math.floor(Math.random() * 500) + 50;
        const fee = size * price * 0.001; // 0.1% fee
        const cost = side === TradeSide.BUY ? size * price + fee : size * price - fee;

        trades.push({
          walletId: wallet.id,
          marketId: market.id,
          txHash: `0x${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`.slice(0, 66),
          logIndex: i,
          blockTime,
          blockNumber: 50000000 + Math.floor(Math.random() * 1000000),
          outcome,
          side,
          price: Math.round(price * 10000) / 10000,
          size,
          cost: Math.round(cost * 100) / 100,
          fee: Math.round(fee * 100) / 100,
        });
      }
    }
  }

  // Sort trades by blockTime and insert
  trades.sort((a, b) => a.blockTime.getTime() - b.blockTime.getTime());
  
  for (const trade of trades) {
    await prisma.trade.create({ data: trade });
  }

  // Create sync status entries
  console.log('Creating sync status entries...');
  await prisma.syncStatus.createMany({
    data: [
      { jobType: 'sync_trades', lastSuccess: now },
      { jobType: 'sync_markets', lastSuccess: now },
      { jobType: 'recompute_positions', lastSuccess: now },
      { jobType: 'create_snapshots', lastSuccess: now },
    ],
  });

  console.log('✅ Seed completed!');
  console.log(`   - ${wallets.length} wallets`);
  console.log(`   - ${markets.length} markets`);
  console.log(`   - ${trades.length} trades`);
}

main()
  .catch((e) => {
    console.error('Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
