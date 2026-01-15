/**
 * Server-Sent Events (SSE) endpoint for live prices
 *
 * Streams:
 * - BINANCE BTCUSDT (BID)
 * - CHAINLINK BTCUSD (ORACLE)
 * - (optional) POLYMARKET UP/DOWN best bid/ask
 *
 * GET /api/realtime/prices?intervalMs=250
 */

import { NextRequest } from 'next/server';
import prisma from '@/lib/db';

export const dynamic = 'force-dynamic';

function sseFrame(data: unknown) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const intervalMs = Math.max(100, Number(sp.get('intervalMs') || 250));
  const includePolymarket = sp.get('includePolymarket') === 'true';

  const encoder = new TextEncoder();
  let timer: NodeJS.Timeout | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = async () => {
        try {
          const [binance, chainlink, polyUpBid, polyUpAsk, polyDownBid, polyDownAsk] = await Promise.all([
            prisma.priceSample.findFirst({
              where: { source: 'BINANCE', symbol: 'BTCUSDT', side: 'BID' },
              orderBy: { observedAt: 'desc' },
              select: { observedAt: true, price: true },
            }),
            // Prefer Polymarket RTDS crypto_prices (what Polymarket uses), fallback to on-chain Chainlink.
            (async () => {
              const rtds = await prisma.priceSample.findFirst({
                where: { source: 'POLYMARKET_RTDS_CHAINLINK', symbol: 'BTCUSD' },
                orderBy: { observedAt: 'desc' },
                select: { observedAt: true, price: true },
              });
              if (rtds) return { observedAt: rtds.observedAt, price: rtds.price, source: 'POLYMARKET_RTDS_CHAINLINK' as const };
              const cl = await prisma.priceSample.findFirst({
                where: { source: 'CHAINLINK', symbol: 'BTCUSD' },
                orderBy: { observedAt: 'desc' },
                select: { observedAt: true, price: true },
              });
              return cl ? { observedAt: cl.observedAt, price: cl.price, source: 'CHAINLINK' as const } : null;
            })(),
            includePolymarket
              ? prisma.priceSample.findFirst({
                  where: { source: 'POLYMARKET', symbol: 'POLY_BTC_15M_UP', side: 'BID' },
                  orderBy: { observedAt: 'desc' },
                  select: { observedAt: true, price: true },
                })
              : Promise.resolve(null),
            includePolymarket
              ? prisma.priceSample.findFirst({
                  where: { source: 'POLYMARKET', symbol: 'POLY_BTC_15M_UP', side: 'ASK' },
                  orderBy: { observedAt: 'desc' },
                  select: { observedAt: true, price: true },
                })
              : Promise.resolve(null),
            includePolymarket
              ? prisma.priceSample.findFirst({
                  where: { source: 'POLYMARKET', symbol: 'POLY_BTC_15M_DOWN', side: 'BID' },
                  orderBy: { observedAt: 'desc' },
                  select: { observedAt: true, price: true },
                })
              : Promise.resolve(null),
            includePolymarket
              ? prisma.priceSample.findFirst({
                  where: { source: 'POLYMARKET', symbol: 'POLY_BTC_15M_DOWN', side: 'ASK' },
                  orderBy: { observedAt: 'desc' },
                  select: { observedAt: true, price: true },
                })
              : Promise.resolve(null),
          ]);

          const payload = {
            t: Date.now(),
            binance: binance
              ? { price: binance.price, observedAt: binance.observedAt.getTime() }
              : null,
            chainlink: chainlink
              ? { price: (chainlink as any).price, observedAt: (chainlink as any).observedAt.getTime(), source: (chainlink as any).source }
              : null,
            polymarket: includePolymarket
              ? {
                  up: {
                    bid: polyUpBid?.price ?? null,
                    ask: polyUpAsk?.price ?? null,
                    t: Math.max(polyUpBid?.observedAt?.getTime?.() ?? 0, polyUpAsk?.observedAt?.getTime?.() ?? 0) || null,
                  },
                  down: {
                    bid: polyDownBid?.price ?? null,
                    ask: polyDownAsk?.price ?? null,
                    t: Math.max(polyDownBid?.observedAt?.getTime?.() ?? 0, polyDownAsk?.observedAt?.getTime?.() ?? 0) || null,
                  },
                }
              : null,
          };

          controller.enqueue(encoder.encode(sseFrame(payload)));
        } catch (e) {
          // keep stream alive; surface minimal error
          controller.enqueue(encoder.encode(sseFrame({ t: Date.now(), error: 'poll_failed' })));
        }
      };

      // initial hello
      controller.enqueue(encoder.encode(`event: hello\ndata: {}\n\n`));

      timer = setInterval(send, intervalMs);
      send();

      req.signal.addEventListener('abort', () => {
        if (timer) clearInterval(timer);
        controller.close();
      });
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

