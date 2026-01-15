/**
 * Move-based lag analysis between Binance and Chainlink (or other sources)
 *
 * Goal: detect patterns like:
 *  - Binance moves -$6
 *  - Chainlink updates ~1200ms later by -$5..7
 *
 * GET /api/price-samples/lag-moves?from=&to=&thresholdUsd=5&windowMs=10000
 * Defaults to BINANCE BTCUSDT vs CHAINLINK BTCUSD.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

type Sample = {
  observedAt: Date;
  price: number;
};

function median(values: number[]) {
  if (values.length === 0) return 0;
  const v = [...values].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}

function percentile(values: number[], p: number) {
  if (values.length === 0) return 0;
  const v = [...values].sort((a, b) => a - b);
  const idx = Math.min(v.length - 1, Math.max(0, Math.floor((p / 100) * v.length)));
  return v[idx];
}

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const from = sp.get('from');
    const to = sp.get('to');
    const thresholdUsd = Number(sp.get('thresholdUsd') || 5);
    const windowMs = Number(sp.get('windowMs') || 10_000);
    const deltaBucketUsd = Number(sp.get('deltaBucketUsd') || 2); // bucket size for |ΔA|
    const maxBuckets = Number(sp.get('maxBuckets') || 20);

    const aSource = sp.get('aSource') || 'BINANCE';
    const aSymbol = sp.get('aSymbol') || 'BTCUSDT';
    const aSide = sp.get('aSide') || 'BID';

    const bSource = sp.get('bSource') || 'CHAINLINK';
    const bSymbol = sp.get('bSymbol') || 'BTCUSD';

    const startTime = from ? new Date(from) : new Date(Date.now() - 60 * 60 * 1000);
    const endTime = to ? new Date(to) : new Date();

    // Pull series efficiently:
    // - Binance is extremely high-frequency: fetch a bounded number of most recent ticks (index-friendly),
    //   then downsample in JS to buckets (default 200ms).
    // - Chainlink is sparse: raw is fine.
    const bucketMs = Number(sp.get('bucketMs') || 200);
    const maxPoints = Number(sp.get('maxPoints') || 20_000);

    const [aTicks, bRaw] = await Promise.all([
      prisma.priceSample.findMany({
        where: {
          source: aSource,
          symbol: aSymbol,
          ...(aSide ? { side: aSide } : {}),
          observedAt: { gte: startTime, lte: endTime },
        },
        select: { observedAt: true, price: true },
        orderBy: { observedAt: 'desc' },
        take: maxPoints,
      }),
      prisma.priceSample.findMany({
        where: {
          source: bSource,
          symbol: bSymbol,
          observedAt: { gte: startTime, lte: endTime },
        },
        select: { observedAt: true, price: true },
        orderBy: { observedAt: 'asc' },
        take: 20_000,
      }),
    ]);

    // Downsample A to one point per bucket (keep last tick in that bucket)
    const aDesc: Sample[] = aTicks as any;
    const bucketMap = new Map<number, Sample>();
    for (const s of aDesc) {
      const t = s.observedAt.getTime();
      const bucket = Math.floor(t / bucketMs);
      if (!bucketMap.has(bucket)) {
        bucketMap.set(bucket, s); // because we're iterating desc, first seen is latest in bucket
      }
    }
    const a: Sample[] = Array.from(bucketMap.values()).sort((x, y) => x.observedAt.getTime() - y.observedAt.getTime());
    const b: Sample[] = bRaw as any;

    if (a.length < 2 || b.length < 2) {
      return NextResponse.json({
        events: [],
        stats: { total: 0, avgLagMs: 0, medianLagMs: 0, minLagMs: 0, maxLagMs: 0 },
      });
    }

    // Identify significant A moves (price change >= thresholdUsd)
    const aEvents: Array<{ t0: Date; p0: number; p1: number; dA: number }> = [];
    for (let i = 1; i < a.length; i++) {
      const dA = a[i].price - a[i - 1].price;
      if (Math.abs(dA) >= thresholdUsd) {
        aEvents.push({ t0: a[i - 1].observedAt, p0: a[i - 1].price, p1: a[i].price, dA });
      }
    }

    // Match each A move to first B move after it within window, same direction
    const events: Array<{
      timestamp: Date;
      lagMs: number;
      binanceDelta: number;
      chainlinkDelta: number;
      ratio: number;
      aPrice0: number;
      aPrice1: number;
      bPrice0: number;
      bPrice1: number;
    }> = [];

    let bIdx = 1;
    for (const ev of aEvents) {
      const tStart = ev.t0.getTime();
      const tEnd = tStart + windowMs;

      // advance bIdx to first point after tStart
      while (bIdx < b.length && b[bIdx].observedAt.getTime() < tStart) bIdx++;
      if (bIdx >= b.length) break;

      // find first B move within window with same sign and non-trivial magnitude
      let matched: { j: number; b0: Sample; b1: Sample; dB: number } | null = null;
      for (let j = bIdx; j < b.length; j++) {
        const t = b[j].observedAt.getTime();
        if (t > tEnd) break;
        const dB = b[j].price - b[j - 1].price;
        if (Math.sign(dB) === Math.sign(ev.dA) && Math.abs(dB) > 0) {
          matched = { j, b0: b[j - 1], b1: b[j], dB };
          break;
        }
      }

      if (!matched) continue;

      const lagMs = matched.b1.observedAt.getTime() - tStart;
      const ratio = Math.abs(matched.dB) / Math.max(1e-9, Math.abs(ev.dA));

      events.push({
        timestamp: ev.t0,
        lagMs,
        binanceDelta: ev.dA,
        chainlinkDelta: matched.dB,
        ratio,
        aPrice0: ev.p0,
        aPrice1: ev.p1,
        bPrice0: matched.b0.price,
        bPrice1: matched.b1.price,
      });
    }

    const lags = events.map((e) => e.lagMs);
    const avgLagMs = lags.length ? Math.round(lags.reduce((a, b) => a + b, 0) / lags.length) : 0;
    const minLagMs = lags.length ? Math.min(...lags) : 0;
    const maxLagMs = lags.length ? Math.max(...lags) : 0;
    const medianLagMs = lags.length ? Math.round(median(lags)) : 0;
    const p90LagMs = lags.length ? Math.round(percentile(lags, 90)) : 0;
    const p95LagMs = lags.length ? Math.round(percentile(lags, 95)) : 0;

    // Significance: mean ± 1.96 * (sd/sqrt(n))
    let sd = 0;
    if (lags.length >= 2) {
      const mean = lags.reduce((a, b) => a + b, 0) / lags.length;
      const variance = lags.reduce((acc, x) => acc + (x - mean) * (x - mean), 0) / (lags.length - 1);
      sd = Math.sqrt(variance);
    }
    const se = lags.length ? sd / Math.sqrt(lags.length) : 0;
    const ci95LowMs = lags.length ? Math.round(avgLagMs - 1.96 * se) : 0;
    const ci95HighMs = lags.length ? Math.round(avgLagMs + 1.96 * se) : 0;

    const ratios = events.map((e) => e.ratio);
    const avgRatio = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 0;

    // Pattern discovery: bucket by |ΔA| and summarize lag + ΔB behavior
    type BucketAgg = {
      bucketMin: number;
      bucketMax: number;
      lags: number[];
      dA: number[];
      dB: number[];
      ratios: number[];
    };
    const buckets = new Map<number, BucketAgg>();
    const bucketSize = Math.max(0.01, deltaBucketUsd);

    for (const e of events) {
      const absA = Math.abs(e.binanceDelta);
      if (absA < thresholdUsd) continue;
      const idx = Math.floor((absA - thresholdUsd) / bucketSize);
      if (idx < 0) continue;
      const b = buckets.get(idx) || {
        bucketMin: thresholdUsd + idx * bucketSize,
        bucketMax: thresholdUsd + (idx + 1) * bucketSize,
        lags: [],
        dA: [],
        dB: [],
        ratios: [],
      };
      b.lags.push(e.lagMs);
      b.dA.push(e.binanceDelta);
      b.dB.push(e.chainlinkDelta);
      b.ratios.push(e.ratio);
      buckets.set(idx, b);
    }

    const bucketRows = Array.from(buckets.entries())
      .sort((a, b) => a[0] - b[0])
      .slice(0, maxBuckets)
      .map(([idx, b]) => {
        const n = b.lags.length;
        const avgLag = n ? Math.round(b.lags.reduce((x, y) => x + y, 0) / n) : 0;
        const medLag = n ? Math.round(median(b.lags)) : 0;
        const p90 = n ? Math.round(percentile(b.lags, 90)) : 0;
        const p95 = n ? Math.round(percentile(b.lags, 95)) : 0;

        const absB = b.dB.map((x) => Math.abs(x));
        const avgAbsB = n ? absB.reduce((x, y) => x + y, 0) / n : 0;
        const medAbsB = n ? median(absB) : 0;
        const minAbsB = n ? Math.min(...absB) : 0;
        const maxAbsB = n ? Math.max(...absB) : 0;

        const ratioMed = n ? median(b.ratios) : 0;
        const ratioP10 = n ? percentile(b.ratios, 10) : 0;
        const ratioP90 = n ? percentile(b.ratios, 90) : 0;

        // Keep direction intuition: show typical ΔB range (signed) for this bucket
        const dBMin = n ? Math.min(...b.dB) : 0;
        const dBMax = n ? Math.max(...b.dB) : 0;

        return {
          idx,
          bucketMin: b.bucketMin,
          bucketMax: b.bucketMax,
          n,
          avgLagMs: avgLag,
          medianLagMs: medLag,
          p90LagMs: p90,
          p95LagMs: p95,
          avgAbsBUsd: avgAbsB,
          medianAbsBUsd: medAbsB,
          minAbsBUsd: minAbsB,
          maxAbsBUsd: maxAbsB,
          dBMin,
          dBMax,
          ratioMedian: ratioMed,
          ratioP10,
          ratioP90,
        };
      });

    return NextResponse.json({
      events,
      patternBuckets: bucketRows,
      stats: {
        total: events.length,
        avgLagMs,
        medianLagMs,
        minLagMs,
        maxLagMs,
        p90LagMs,
        p95LagMs,
        sdMs: Math.round(sd),
        seMs: Math.round(se),
        ci95LowMs,
        ci95HighMs,
        avgRatio,
        thresholdUsd,
        windowMs,
        deltaBucketUsd: bucketSize,
        maxBuckets,
        bucketMs,
        maxPoints,
        seriesCounts: { a: a.length, b: b.length, aEvents: aEvents.length },
      },
    });
  } catch (error) {
    console.error('Failed to calculate move lag:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to calculate move lag' },
      { status: 500 }
    );
  }
}

