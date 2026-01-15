import WebSocket from 'ws';
import { btc15mMarketDiscovery } from '../src/lib/market-discovery';

const URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

type Candidate = { name: string; msg: any };

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const m = await btc15mMarketDiscovery.findActiveMarket();
  if (!m) throw new Error('No active BTC 15m market');

  const assetId = m.upTokenId;
  console.log('Using assetId:', assetId);

  const ws = new WebSocket(URL);

  ws.on('open', async () => {
    console.log('WS open');

    const candidates: Candidate[] = [
      { name: 'subscribe price assets_ids', msg: { type: 'subscribe', channel: 'price', assets_ids: [assetId] } },
      { name: 'subscribe price asset_ids', msg: { type: 'subscribe', channel: 'price', asset_ids: [assetId] } },
      { name: 'subscribe book assets_ids', msg: { type: 'subscribe', channel: 'book', assets_ids: [assetId] } },
      { name: 'subscribe book asset_ids', msg: { type: 'subscribe', channel: 'book', asset_ids: [assetId] } },
      { name: 'subscribe book asset_id', msg: { type: 'subscribe', channel: 'book', asset_id: assetId } },
      { name: 'subscribe book token_id', msg: { type: 'subscribe', channel: 'book', token_id: assetId } },
      { name: 'op subscribe book asset_ids', msg: { op: 'subscribe', channel: 'book', asset_ids: [assetId] } },
      { name: 'op subscribe book assets_ids', msg: { op: 'subscribe', channel: 'book', assets_ids: [assetId] } },
      { name: 'event subscribe book', msg: { event: 'subscribe', channel: 'book', asset_id: assetId } },
      { name: 'market type', msg: { type: 'market', assets_ids: [assetId] } },
      { name: 'topic market', msg: { type: 'subscribe', topic: 'market', asset_id: assetId } },
      { name: 'token_ids book', msg: { type: 'subscribe', channel: 'book', token_ids: [assetId] } },
      { name: 'asset_ids book (alt key)', msg: { type: 'subscribe', channel: 'book', assetIds: [assetId] } },
    ];

    for (const c of candidates) {
      console.log('\nSENDING:', c.name, JSON.stringify(c.msg));
      ws.send(JSON.stringify(c.msg));
      await sleep(400);
    }

    console.log('\nDone sending. Waiting 2s...');
    await sleep(2000);
    ws.close();
  });

  ws.on('message', (data) => {
    const raw = data.toString();
    if (raw.length < 400) {
      console.log('RECV:', raw);
    } else {
      console.log('RECV (trunc):', raw.slice(0, 400));
    }
  });

  ws.on('close', (code, reason) => {
    console.log('WS closed', code, reason.toString());
  });

  ws.on('error', (err) => {
    console.error('WS error', err);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
