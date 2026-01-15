import prisma from '../src/lib/db';

async function main() {
  console.log('Checking price_samples...\n');
  
  const count = await prisma.priceSample.count();
  console.log(`Total samples: ${count}`);
  
  if (count > 0) {
    const bySrc = await prisma.priceSample.groupBy({
      by: ['source'],
      _count: true,
    });
    console.log('\nBy source:');
    bySrc.forEach(s => console.log(`  ${s.source}: ${s._count}`));
    
    // Polymarket samples
    const polyCount = await prisma.priceSample.count({ where: { source: 'POLYMARKET' } });
    console.log(`\nPolymarket samples: ${polyCount}`);
    
    if (polyCount > 0) {
      const polyRecent = await prisma.priceSample.findMany({
        where: { source: 'POLYMARKET' },
        take: 10,
        orderBy: { observedAt: 'desc' },
      });
      console.log('Recent Polymarket samples:');
      polyRecent.forEach(r => {
        console.log(`  ${r.symbol} ${r.side}: ${r.price} @ ${r.observedAt.toISOString()}`);
      });
    }
    
    // Binance recent
    const binRecent = await prisma.priceSample.findMany({
      where: { source: 'BINANCE' },
      take: 5,
      orderBy: { observedAt: 'desc' },
    });
    console.log('\nRecent Binance samples:');
    binRecent.forEach(r => {
      console.log(`  ${r.symbol} ${r.side}: ${r.price} @ ${r.observedAt.toISOString()}`);
    });
  }
  
  await prisma.$disconnect();
}

main().catch(console.error);
