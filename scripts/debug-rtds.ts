import WebSocket from 'ws';

const url = process.env.POLYMARKET_RTDS_URL || 'wss://ws-live-data.polymarket.com';

const ws = new WebSocket(url);

let pingTimer: NodeJS.Timeout | null = null;

ws.on('open', async () => {
  console.log('open', url);

  pingTimer = setInterval(() => {
    try { ws.send('PING'); } catch {}
  }, 5000);

  const msg = {
    action: 'subscribe',
    subscriptions: [
      { topic: 'crypto_prices_chainlink', type: '*', filters: JSON.stringify({ symbol: 'btc/usd' }) },
    ],
  };

  console.log('send', JSON.stringify(msg));
  ws.send(JSON.stringify(msg));
});

ws.on('message', (data) => {
  const raw = data.toString();
  console.log('msg', raw.slice(0, 600));
});

ws.on('close', (c, r) => {
  if (pingTimer) clearInterval(pingTimer);
  console.log('close', c, r.toString());
});

ws.on('error', (e) => {
  console.error('error', e);
});

setTimeout(() => {
  console.log('timeout, closing');
  ws.close();
}, 15000);
