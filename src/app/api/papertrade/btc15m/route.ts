import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';

export const dynamic = 'force-dynamic';

type Sample = { t: number; price: number };

function toMs(d: Date) {
  return d.getTime();
}

function bucket(value: number, bucketSize: number) {
  const b = Math.floor(value / bucketSize) * bucketSize;
  return `${b}..${b + bucketSize}`;
}

function bucketAbs(value: number, bucketSize: number) {
  const v = Math.abs(value);
  const b = Math.floor(v / bucketSize) * bucketSize;
  return `${b}..${b + bucketSize}`;
}

function bucketRemainingMs(remainingMs: number) {
  if (remainingMs <= 30_000) return '0..30s';
  if (remainingMs <= 60_000) return '30..60s';
  if (remainingMs <= 120_000) return '60..120s';
  if (remainingMs <= 300_000) return '120..300s';
  if (remainingMs <= 600_000) return '300..600s';
  return '600s+';
}

function median(nums: number[]) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.floor(a.length / 2)];
}

function wilson95(n: number, k: number) {
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

function firstMidMove(params: {
  bid: Sample[];
  ask: Sample[];
  t0: number;
  windowMs: number;
  epsilon: number;
}) {
  const { bid, ask, t0, windowMs, epsilon } = params;
  if (!bid.length && !ask.length) return { mid0: null as number | null, mid1: null as number | null, lagMs: null as number | null };

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

function lastAtOrBefore(series: Sample[], t: number, startIdxRef: { i: number }): Sample | null {
  let i = startIdxRef.i;
  while (i + 1 < series.length && series[i + 1].t <= t) i++;
  startIdxRef.i = i;
  return series[i] && series[i].t <= t ? series[i] : null;
}

function firstAtOrAfter(series: Sample[], t: number): Sample | null {
  if (!series.length) return null;
  let lo = 0;
  let hi = series.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t >= t) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans >= 0 ? series[ans] : null;
}

function tradeKey(params: { deltaBucket: string; spikeBucket: string; remainingBucket: string }) {
  return `${params.deltaBucket} | ${params.spikeBucket} | ${params.remainingBucket}`;
}

type PaperAgg = {
  trades: number;
  fills: number;
  skippedNoQuote: number;
  skippedTooLate: number;
  totalPnl: number; // per 1 share
  pnl: number[];
  winN: number;
  roiSum: number;
};

type FillRecord = {
  conditionId: string;
  marketSlug: string;
  deltaBucket: string;
  spikeBucket: string;
  remainingBucket: string;
  side: 'UP' | 'DOWN';
  t0: number;
  tEntry: number;
  tExit: number;
  entry: number;
  exit: number;
  fee: number;
  pnl: number;
  roi: number;
};

function emptyAgg(): PaperAgg {
  return {
    trades: 0,
    fills: 0,
    skippedNoQuote: 0,
    skippedTooLate: 0,
    totalPnl: 0,
    pnl: [],
    winN: 0,
    roiSum: 0,
  };
}

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const now = new Date();
    const from = sp.get('from') ? new Date(String(sp.get('from'))) : new Date(now.getTime() - 6 * 60 * 60 * 1000);
    const to = sp.get('to') ? new Date(String(sp.get('to'))) : now;

    const spikeUsd = Number(sp.get('spikeUsd') || 6);
    const reactionWindowMs = Number(sp.get('reactionWindowMs') || 3000);
    const deltaBucketUsd = Number(sp.get('deltaBucketUsd') || 10);
    const spikeBucketUsd = Number(sp.get('spikeBucketUsd') || 2);
    const spikeCooldownMs = Number(sp.get('spikeCooldownMs') || 250);
    const epsilon = Number(sp.get('epsilon') || 0.01);
    const minN = Number(sp.get('minN') || 10);

    const orderP95Ms = Number(sp.get('orderP95Ms') || 0);
    const safetyMs = Number(sp.get('safetyMs') || 150);
    const holdMs = Number(sp.get('holdMs') || 2000);
    const feeBps = Number(sp.get('feeBps') || 0); // applied on entry+exit notional (very rough)
    const includeFills = sp.get('includeFills') === '1' || sp.get('includeFills') === 'true';
    const maxFills = Math.max(0, Math.min(5000, Number(sp.get('maxFills') || 500)));

    // Use the recorded baselines as canonical windows.
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
    const paperByKey = new Map<string, PaperAgg>();
    const paperGlobal = { UP: emptyAgg(), DOWN: emptyAgg() };
    const fills: FillRecord[] = [];

    for (const baseline of baselines) {
      const conditionId = String(baseline.conditionId || '');
      const marketSlug = String(baseline.marketSlug || '');
      if (!conditionId || !marketSlug) continue;

      const windowStart = baseline.observedAt;
      const windowEnd = new Date(windowStart.getTime() + 15 * 60 * 1000);

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
          const remainingMs = windowEnd.getTime() - t0;
          const remainingBucket = bucketRemainingMs(remainingMs);

          const up = firstMidMove({ bid: upBid, ask: upAsk, t0, windowMs: reactionWindowMs, epsilon });
          const down = firstMidMove({ bid: downBid, ask: downAsk, t0, windowMs: reactionWindowMs, epsilon });

          const dir = d === 0 ? 0 : d > 0 ? 1 : -1;
          const upMove = up.mid0 != null && up.mid1 != null ? up.mid1 - up.mid0 : null;
          const downMove = down.mid0 != null && down.mid1 != null ? down.mid1 - down.mid0 : null;

          const deltaBucket = Number.isFinite(Number(deltaFromBaselineUsd))
            ? bucket(Number(deltaFromBaselineUsd), deltaBucketUsd)
            : 'unknown';
          const spikeBucket = Number.isFinite(Number(d)) ? bucketAbs(d, spikeBucketUsd) : 'unknown';
          const key = tradeKey({ deltaBucket, spikeBucket, remainingBucket });

          events.push({
            t0,
            conditionId,
            marketSlug,
            deltaBucket,
            spikeBucket,
            remainingBucket,
            binanceDeltaUsd: d,
            chainlinkDeltaFromBaselineUsd: deltaFromBaselineUsd,
            remainingMs,
            polyUpLagMs: up.lagMs,
            polyDownLagMs: down.lagMs,
            polyUpMove: upMove,
            polyDownMove: downMove,
          });

          // Papertrade: execute after latency, hold for holdMs, long token matching spike direction.
          if (dir !== 0) {
            const side = dir > 0 ? ('UP' as const) : ('DOWN' as const);
            const tEntry = t0 + orderP95Ms;
            const tExit = tEntry + holdMs;
            const latestExitAllowed = windowEnd.getTime() - safetyMs;

            const agg = paperByKey.get(`${key} | ${side}`) || emptyAgg();
            agg.trades += 1;

            if (tExit > latestExitAllowed) {
              agg.skippedTooLate += 1;
              paperByKey.set(`${key} | ${side}`, agg);
              continue;
            }

            const entryAsk = side === 'UP' ? firstAtOrAfter(upAsk, tEntry) : firstAtOrAfter(downAsk, tEntry);
            const exitBid = side === 'UP' ? firstAtOrAfter(upBid, tExit) : firstAtOrAfter(downBid, tExit);

            if (!entryAsk || !exitBid) {
              agg.skippedNoQuote += 1;
              paperByKey.set(`${key} | ${side}`, agg);
              continue;
            }

            const entry = entryAsk.price;
            const exit = exitBid.price;
            const fee = ((feeBps / 10_000) * (entry + exit)); // rough: fee on notional
            const pnl = exit - entry - fee;
            const roi = entry > 0 ? pnl / entry : 0;

            agg.fills += 1;
            agg.totalPnl += pnl;
            agg.pnl.push(pnl);
            if (pnl > 0) agg.winN += 1;
            agg.roiSum += roi;

            paperByKey.set(`${key} | ${side}`, agg);

            const g = paperGlobal[side];
            g.trades += 1;
            g.fills += 1;
            g.totalPnl += pnl;
            g.pnl.push(pnl);
            if (pnl > 0) g.winN += 1;
            g.roiSum += roi;

            if (includeFills) {
              fills.push({
                conditionId,
                marketSlug,
                deltaBucket,
                spikeBucket,
                remainingBucket,
                side,
                t0,
                tEntry,
                tExit,
                entry,
                exit,
                fee,
                pnl,
                roi,
              });
            }
          }
        }
        prev = cur;
      }
    }

    // 2D buckets (same idea as patterns route), so we can re-use its “strategy” concept and attach paper results.
    const globalN = events.filter((e) => e.deltaBucket !== 'unknown').length;
    const globalK = events.filter((e) => typeof e.polyUpLagMs === 'number' && e.deltaBucket !== 'unknown').length;
    const globalRate = globalN ? globalK / globalN : 0;

    const map2d = new Map<string, any>();
    for (const e of events) {
      if (e.deltaBucket === 'unknown' || e.spikeBucket === 'unknown') continue;
      const key = tradeKey({ deltaBucket: e.deltaBucket, spikeBucket: e.spikeBucket, remainingBucket: e.remainingBucket });
      const cur = map2d.get(key) || {
        deltaBucket: e.deltaBucket,
        spikeBucket: e.spikeBucket,
        remainingBucket: e.remainingBucket,
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
      }
      if (typeof e.polyDownLagMs === 'number') {
        cur.downResponseN += 1;
        cur.downLagMs.push(e.polyDownLagMs);
        if (typeof e.polyDownMove === 'number') cur.downMove.push(e.polyDownMove);
      }
      map2d.set(key, cur);
    }

    const buckets2d = Array.from(map2d.values())
      .map((b) => {
        const upCI = wilson95(b.n, b.upResponseN);
        const downCI = wilson95(b.n, b.downResponseN);
        const upRate = upCI.p;
        const lift = upRate - globalRate;
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
          upMedianLagMs: median(b.upLagMs),
          downMedianLagMs: median(b.downLagMs),
          upMedianMove: median(b.upMove),
          downMedianMove: median(b.downMove),
          liftVsGlobal: lift,
        };
      })
      .sort((a, b) => (b.liftVsGlobal - a.liftVsGlobal) || (b.n - a.n));

    const strategies = buckets2d
      .filter((b) => b.n >= minN)
      .filter((b) => b.upCI95Low > globalRate)
      .map((b) => {
        const edgeScore = (b.liftVsGlobal || 0) * (b.upResponseRate || 0) * Math.log10(1 + b.n);
        const key = tradeKey({ deltaBucket: b.deltaBucket, spikeBucket: b.spikeBucket, remainingBucket: b.remainingBucket });

        const upAgg = paperByKey.get(`${key} | UP`) || emptyAgg();
        const downAgg = paperByKey.get(`${key} | DOWN`) || emptyAgg();

        const summarize = (a: PaperAgg) => ({
          trades: a.trades,
          fills: a.fills,
          skippedNoQuote: a.skippedNoQuote,
          skippedTooLate: a.skippedTooLate,
          totalPnl: a.totalPnl,
          avgPnl: a.fills ? a.totalPnl / a.fills : 0,
          winRate: a.fills ? a.winN / a.fills : 0,
          avgRoi: a.fills ? a.roiSum / a.fills : 0,
          medianPnl: median(a.pnl),
        });

        return { ...b, edgeScore, paper: { UP: summarize(upAgg), DOWN: summarize(downAgg) } };
      })
      .sort((a, b) => (b.edgeScore - a.edgeScore) || (b.n - a.n))
      .slice(0, 50);

    const summarizeGlobal = (a: PaperAgg) => ({
      fills: a.fills,
      totalPnl: a.totalPnl,
      avgPnl: a.fills ? a.totalPnl / a.fills : 0,
      winRate: a.fills ? a.winN / a.fills : 0,
      avgRoi: a.fills ? a.roiSum / a.fills : 0,
      medianPnl: median(a.pnl),
    });

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
        holdMs,
        feeBps,
        includeFills,
        maxFills,
      },
      baselinesCount: baselines.length,
      eventsCount: events.length,
      global: { n: globalN, upResponseRate: globalRate, paper: { UP: summarizeGlobal(paperGlobal.UP), DOWN: summarizeGlobal(paperGlobal.DOWN) } },
      strategies,
      fills: includeFills
        ? fills
            .sort((a, b) => b.tEntry - a.tEntry)
            .slice(0, maxFills)
            .map((f) => ({ ...f, t0: new Date(f.t0).toISOString(), tEntry: new Date(f.tEntry).toISOString(), tExit: new Date(f.tExit).toISOString() }))
        : undefined,
    });
  } catch (e) {
    console.error('papertrade/btc15m failed:', e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'unknown_error' },
      { status: 500 },
    );
  }
}

