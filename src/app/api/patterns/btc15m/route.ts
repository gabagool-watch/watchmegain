import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';

export const dynamic = 'force-dynamic';

type Sample = { t: number; price: number };

function toMs(d: Date) {
  return d.getTime();
}

function lastAtOrBefore(series: Sample[], t: number, startIdxRef: { i: number }): Sample | null {
  // series must be sorted asc by t
  let i = startIdxRef.i;
  while (i + 1 < series.length && series[i + 1].t <= t) i++;
  startIdxRef.i = i;
  return series[i] && series[i].t <= t ? series[i] : null;
}

function bucket(value: number, bucketSize: number) {
  const b = Math.floor(value / bucketSize) * bucketSize;
  return `${b}..${b + bucketSize}`;
}

function median(nums: number[]) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.floor(a.length / 2)];
}

function wilson95(n: number, k: number) {
  // Wilson score interval (95%) for proportion k/n
  if (n <= 0) return { p: 0, lo: 0, hi: 0 };
  const z = 1.96;
  const phat = k / n;
  const denom = 1 + (z * z) / n;
  const center = (phat + (z * z) / (2 * n)) / denom;
  const half =
    (z *
      Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n))) /
    denom;
  return { p: phat, lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

function bucketAbs(value: number, bucketSize: number) {
  const v = Math.abs(value);
  const b = Math.floor(v / bucketSize) * bucketSize;
  return `${b}..${b + bucketSize}`;
}

function bucketRemainingMs(remainingMs: number) {
  // 15m window: strategy behavior often differs near settlement.
  // Buckets are coarse on purpose.
  if (remainingMs <= 30_000) return '0..30s';
  if (remainingMs <= 60_000) return '30..60s';
  if (remainingMs <= 120_000) return '60..120s';
  if (remainingMs <= 300_000) return '120..300s';
  if (remainingMs <= 600_000) return '300..600s';
  return '600s+';
}

function firstMidMove(params: {
  bid: Sample[];
  ask: Sample[];
  t0: number;
  windowMs: number;
  epsilon: number;
}) {
  const { bid, ask, t0, windowMs, epsilon } = params;
  if (!bid.length && !ask.length) return { mid0: null as number | null, mid1: null as number | null, lagMs: null as number | null };

  // find last indices at or before t0
  let iB = 0;
  while (iB + 1 < bid.length && bid[iB + 1].t <= t0) iB++;
  let iA = 0;
  while (iA + 1 < ask.length && ask[iA + 1].t <= t0) iA++;

  const b0 = bid[iB] && bid[iB].t <= t0 ? bid[iB].price : null;
  const a0 = ask[iA] && ask[iA].t <= t0 ? ask[iA].price : null;
  const mid0 =
    typeof b0 === 'number' && typeof a0 === 'number' ? (b0 + a0) / 2 : typeof b0 === 'number' ? b0 : typeof a0 === 'number' ? a0 : null;
  if (mid0 == null) return { mid0: null, mid1: null, lagMs: null };

  const end = t0 + windowMs;

  // advance to next updates after t0
  while (iB < bid.length && bid[iB].t <= t0) iB++;
  while (iA < ask.length && ask[iA].t <= t0) iA++;

  let lastB = b0;
  let lastA = a0;

  while (true) {
    const nextBT = iB < bid.length ? bid[iB].t : Number.POSITIVE_INFINITY;
    const nextAT = iA < ask.length ? ask[iA].t : Number.POSITIVE_INFINITY;
    const tNext = Math.min(nextBT, nextAT);
    if (!Number.isFinite(tNext) || tNext > end) break;

    if (nextBT === tNext) {
      lastB = bid[iB].price;
      iB++;
    }
    if (nextAT === tNext) {
      lastA = ask[iA].price;
      iA++;
    }

    const mid =
      typeof lastB === 'number' && typeof lastA === 'number'
        ? (lastB + lastA) / 2
        : typeof lastB === 'number'
          ? lastB
          : typeof lastA === 'number'
            ? lastA
            : null;

    if (mid != null && Math.abs(mid - mid0) >= epsilon) {
      return { mid0, mid1: mid, lagMs: tNext - t0 };
    }
  }

  return { mid0, mid1: null, lagMs: null };
}

/**
 * Pattern discovery for BTC 15m Up/Down markets.
 *
 * GET /api/patterns/btc15m?from=...&to=...&spikeUsd=6&reactionWindowMs=3000&deltaBucketUsd=10&spikeBucketUsd=2&spikeCooldownMs=250&epsilon=0.01
 *
 * Returns:
 * - events: binance spike events joined with (chainlink - price_to_beat) and polymarket share move/lag
 * - buckets: aggregated stats by (deltaFromBaselineUsd bucket)
 */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const now = new Date();
    const from = sp.get('from') ? new Date(String(sp.get('from'))) : new Date(now.getTime() - 60 * 60 * 1000);
    const to = sp.get('to') ? new Date(String(sp.get('to'))) : now;

    const spikeUsd = Number(sp.get('spikeUsd') || 6);
    const reactionWindowMs = Number(sp.get('reactionWindowMs') || 3000);
    const deltaBucketUsd = Number(sp.get('deltaBucketUsd') || 10);
    const spikeBucketUsd = Number(sp.get('spikeBucketUsd') || 2);
    const spikeCooldownMs = Number(sp.get('spikeCooldownMs') || 250);
    const epsilon = Number(sp.get('epsilon') || 0.01);
    const minN = Number(sp.get('minN') || 10);
    const orderP95Ms = sp.get('orderP95Ms') == null ? null : Number(sp.get('orderP95Ms'));
    const safetyMs = Number(sp.get('safetyMs') || 150);

    // Use the recorded baselines as the canonical set of windows (no DISTINCT needed).
    const baselines = await prisma.priceSample.findMany({
      where: {
        source: 'POLYMARKET_PRICE_TO_BEAT',
        symbol: 'BTCUSD',
        side: 'BASELINE',
        observedAt: { gte: from, lte: to },
        conditionId: { not: null },
        marketSlug: { not: null },
      },
      orderBy: { observedAt: 'desc' },
      select: { observedAt: true, price: true, conditionId: true, marketSlug: true },
      take: 200,
    });

    const events: any[] = [];

    for (const baseline of baselines) {
      const conditionId = String(baseline.conditionId || '');
      const marketSlug = String(baseline.marketSlug || '');
      if (!conditionId || !marketSlug) continue;

      const windowStart = baseline.observedAt;
      const windowEnd = new Date(windowStart.getTime() + 15 * 60 * 1000);

      // Pull binance + chainlink + poly (up/down bid/ask) within this 15m window (bounded)
      const [binanceRows, chainlinkRows, upBidRows, upAskRows, downBidRows, downAskRows] = await Promise.all([
        prisma.priceSample.findMany({
          where: { source: 'BINANCE', symbol: 'BTCUSDT', side: 'BID', observedAt: { gte: windowStart, lte: windowEnd } },
          orderBy: { observedAt: 'asc' },
          select: { observedAt: true, price: true },
          take: 20000,
        }),
        prisma.priceSample.findMany({
          where: {
            source: 'POLYMARKET_RTDS_CHAINLINK',
            symbol: 'BTCUSD',
            side: 'ORACLE',
            observedAt: { gte: windowStart, lte: windowEnd },
          },
          orderBy: { observedAt: 'asc' },
          select: { observedAt: true, price: true },
          take: 20000,
        }),
        prisma.priceSample.findMany({
          where: { source: 'POLYMARKET', symbol: 'POLY_BTC_15M_UP', side: 'BID', conditionId, observedAt: { gte: windowStart, lte: windowEnd } },
          orderBy: { observedAt: 'asc' },
          select: { observedAt: true, price: true },
          take: 20000,
        }),
        prisma.priceSample.findMany({
          where: { source: 'POLYMARKET', symbol: 'POLY_BTC_15M_UP', side: 'ASK', conditionId, observedAt: { gte: windowStart, lte: windowEnd } },
          orderBy: { observedAt: 'asc' },
          select: { observedAt: true, price: true },
          take: 20000,
        }),
        prisma.priceSample.findMany({
          where: { source: 'POLYMARKET', symbol: 'POLY_BTC_15M_DOWN', side: 'BID', conditionId, observedAt: { gte: windowStart, lte: windowEnd } },
          orderBy: { observedAt: 'asc' },
          select: { observedAt: true, price: true },
          take: 20000,
        }),
        prisma.priceSample.findMany({
          where: { source: 'POLYMARKET', symbol: 'POLY_BTC_15M_DOWN', side: 'ASK', conditionId, observedAt: { gte: windowStart, lte: windowEnd } },
          orderBy: { observedAt: 'asc' },
          select: { observedAt: true, price: true },
          take: 20000,
        }),
      ]);

      const binance: Sample[] = binanceRows.map((r) => ({ t: toMs(r.observedAt), price: r.price }));
      const chainlink: Sample[] = chainlinkRows.map((r) => ({ t: toMs(r.observedAt), price: r.price }));
      const upBid: Sample[] = upBidRows.map((r) => ({ t: toMs(r.observedAt), price: r.price }));
      const upAsk: Sample[] = upAskRows.map((r) => ({ t: toMs(r.observedAt), price: r.price }));
      const downBid: Sample[] = downBidRows.map((r) => ({ t: toMs(r.observedAt), price: r.price }));
      const downAsk: Sample[] = downAskRows.map((r) => ({ t: toMs(r.observedAt), price: r.price }));

      if (binance.length < 2 || chainlink.length < 1) continue;

      // Build spike events from Binance BID deltas (with cooldown to avoid double-counting clustered spikes)
      let prev = binance[0];
      const clIdx = { i: 0 };
      let lastSpikeT = -Infinity;

      for (let i = 1; i < binance.length; i++) {
        const cur = binance[i];
        const d = cur.price - prev.price;
        if (Math.abs(d) >= spikeUsd && cur.t - lastSpikeT >= spikeCooldownMs) {
          const t0 = cur.t;
          lastSpikeT = t0;

          const cl = lastAtOrBefore(chainlink, t0, clIdx);
          const deltaFromBaselineUsd = cl ? cl.price - baseline.price : null;

          const up = firstMidMove({ bid: upBid, ask: upAsk, t0, windowMs: reactionWindowMs, epsilon });
          const down = firstMidMove({ bid: downBid, ask: downAsk, t0, windowMs: reactionWindowMs, epsilon });

          const dir = d === 0 ? 0 : d > 0 ? 1 : -1;
          const upMove = up.mid0 != null && up.mid1 != null ? up.mid1 - up.mid0 : null;
          const downMove = down.mid0 != null && down.mid1 != null ? down.mid1 - down.mid0 : null;
          const upAligned = typeof upMove === 'number' ? (dir > 0 ? upMove > 0 : dir < 0 ? upMove < 0 : false) : null;
          const downAligned =
            typeof downMove === 'number' ? (dir > 0 ? downMove < 0 : dir < 0 ? downMove > 0 : false) : null;

          const remainingMs = windowEnd.getTime() - t0;
          const remainingBucket = bucketRemainingMs(remainingMs);
          const chainlinkAgeMs = cl ? t0 - cl.t : null;
          const binancePrice = cur.price;
          const binanceDeltaFromBaselineUsd = binancePrice - baseline.price;
          const clPrice = cl ? cl.price : null;

          const polyUpMid0 = up.mid0;
          const polyDownMid0 = down.mid0;
          const polySkew0 =
            typeof polyUpMid0 === 'number' && typeof polyDownMid0 === 'number' ? polyUpMid0 - polyDownMid0 : null;

          events.push({
            conditionId,
            marketSlug,
            baselineT: baseline.observedAt.toISOString(),
            priceToBeat: baseline.price,
            t: new Date(t0).toISOString(),
            binanceDeltaUsd: d,
            chainlinkDeltaFromBaselineUsd: deltaFromBaselineUsd,
            remainingMs,
            remainingBucket,
            chainlinkAgeMs,
            binancePrice,
            chainlinkPrice: clPrice,
            binanceDeltaFromBaselineUsd,
            polyUpMid0,
            polyUpMid1: up.mid1,
            polyUpLagMs: up.lagMs,
            polyDownMid0,
            polyDownMid1: down.mid1,
            polyDownLagMs: down.lagMs,
            polyUpMove: upMove,
            polyDownMove: downMove,
            polyUpAligned: upAligned,
            polyDownAligned: downAligned,
            polySkew0,
          });
        }
        prev = cur;
      }
    }

  // 1D bucket stats by chainlink delta from baseline (kept for backwards UI compatibility)
  const bucketMap = new Map<string, any>();
  for (const e of events) {
    const delta = Number(e.chainlinkDeltaFromBaselineUsd);
    if (!Number.isFinite(delta)) continue;
    const k = bucket(delta, deltaBucketUsd);
    const cur = bucketMap.get(k) || { bucket: k, n: 0, responseN: 0, lagMs: [] as number[], move: [] as number[] };
    cur.n += 1;
    if (typeof e.polyUpLagMs === 'number') {
      cur.responseN += 1;
      cur.lagMs.push(e.polyUpLagMs);
      if (typeof e.polyUpMove === 'number') {
        cur.move.push(e.polyUpMove);
      }
    }
    bucketMap.set(k, cur);
  }

  const buckets = Array.from(bucketMap.values())
    .map((b) => ({
      bucket: b.bucket,
      n: b.n,
      responseRate: b.n ? b.responseN / b.n : 0,
      medianLagMs: median(b.lagMs),
      medianMove: median(b.move),
    }))
    .sort((a, b) => a.bucket.localeCompare(b.bucket));

  // 2D buckets: (delta from baseline bucket) x (|binance spike| bucket)
  const globalN = events.filter((e) => Number.isFinite(Number(e.chainlinkDeltaFromBaselineUsd))).length;
  const globalK = events.filter((e) => typeof e.polyUpLagMs === 'number' && Number.isFinite(Number(e.chainlinkDeltaFromBaselineUsd))).length;
  const globalRate = globalN ? globalK / globalN : 0;

  const map2d = new Map<string, any>();
  for (const e of events) {
    const delta = Number(e.chainlinkDeltaFromBaselineUsd);
    if (!Number.isFinite(delta)) continue;
    const spike = Number(e.binanceDeltaUsd);
    if (!Number.isFinite(spike)) continue;

    const k1 = bucket(delta, deltaBucketUsd);
    const k2 = bucketAbs(spike, spikeBucketUsd);
    const k3 = String(e.remainingBucket || 'unknown');
    const key = `${k1} | ${k2} | ${k3}`;

    const cur = map2d.get(key) || {
      deltaBucket: k1,
      spikeBucket: k2,
      remainingBucket: k3,
      n: 0,
      upResponseN: 0,
      downResponseN: 0,
      upAlignedN: 0,
      downAlignedN: 0,
      upLagMs: [] as number[],
      downLagMs: [] as number[],
      upMove: [] as number[],
      downMove: [] as number[],
    };
    cur.n += 1;

    if (typeof e.polyUpLagMs === 'number') {
      cur.upResponseN += 1;
      cur.upLagMs.push(e.polyUpLagMs);
      if (typeof e.polyUpMove === 'number') cur.upMove.push(e.polyUpMove);
      if (e.polyUpAligned === true) cur.upAlignedN += 1;
    }
    if (typeof e.polyDownLagMs === 'number') {
      cur.downResponseN += 1;
      cur.downLagMs.push(e.polyDownLagMs);
      if (typeof e.polyDownMove === 'number') cur.downMove.push(e.polyDownMove);
      if (e.polyDownAligned === true) cur.downAlignedN += 1;
    }

    map2d.set(key, cur);
  }

  const buckets2d = Array.from(map2d.values())
    .map((b) => {
      const upCI = wilson95(b.n, b.upResponseN);
      const downCI = wilson95(b.n, b.downResponseN);
      const upRate = upCI.p;
      const lift = upRate - globalRate;
      const feasible =
        typeof orderP95Ms === 'number' && Number.isFinite(orderP95Ms)
          ? (median(b.upLagMs) ?? -1) > orderP95Ms + safetyMs
          : null;
      return {
        deltaBucket: b.deltaBucket,
        spikeBucket: b.spikeBucket,
        remainingBucket: b.remainingBucket,
        n: b.n,
        upResponseRate: upRate,
        upCI95Low: upCI.lo,
        upCI95High: upCI.hi,
        downResponseRate: downCI.p,
        downCI95Low: downCI.lo,
        downCI95High: downCI.hi,
        upAlignedRate: b.upResponseN ? b.upAlignedN / b.upResponseN : 0,
        downAlignedRate: b.downResponseN ? b.downAlignedN / b.downResponseN : 0,
        upMedianLagMs: median(b.upLagMs),
        downMedianLagMs: median(b.downLagMs),
        upMedianMove: median(b.upMove),
        downMedianMove: median(b.downMove),
        liftVsGlobal: lift,
        feasibleForOrderLatency: feasible,
      };
    })
    // sort by strongest positive lift first, then sample size
    .sort((a, b) => (b.liftVsGlobal - a.liftVsGlobal) || (b.n - a.n));

  // Strategy candidates: conservative filter (enough samples + CI low above global)
  const strategies = buckets2d
    .filter((b) => b.n >= minN)
    .filter((b) => b.upCI95Low > globalRate)
    .map((b) => {
      const edgeScore = (b.liftVsGlobal || 0) * (b.upResponseRate || 0) * (b.upAlignedRate || 0) * Math.log10(1 + b.n);
      return { ...b, edgeScore };
    })
    .sort((a, b) => (b.edgeScore - a.edgeScore) || (b.n - a.n))
    .slice(0, 50);

    return NextResponse.json({
      params: {
        from: from.toISOString(),
        to: to.toISOString(),
        spikeUsd,
        reactionWindowMs,
        deltaBucketUsd,
        spikeBucketUsd,
        spikeCooldownMs,
        epsilon,
        minN,
        orderP95Ms,
        safetyMs,
      },
      baselinesCount: baselines.length,
      eventsCount: events.length,
      events: events.slice(0, 5000),
      buckets,
      buckets2d: buckets2d.slice(0, 200),
      global: { n: globalN, upResponseRate: globalRate },
      strategies,
    });
  } catch (e) {
    console.error('patterns/btc15m failed:', e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'unknown_error' },
      { status: 500 },
    );
  }
}

