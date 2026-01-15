'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine, Brush } from 'recharts';

interface PriceSample {
  id: string;
  source: string;
  symbol: string;
  price: number;
  side?: string;
  observedAt: string;
  assetId?: string;
  conditionId?: string;
}

interface LagData {
  timestamp: string;
  polyPrice: number;
  polySymbol: string;
  binancePrice: number;
  lagMs: number;
  priceDiff: number;
}

interface MoveLagEvent {
  timestamp: string;
  lagMs: number;
  binanceDelta: number;
  chainlinkDelta: number;
  ratio: number;
}

export default function LagAnalysisPage() {
  const [samples, setSamples] = useState<PriceSample[]>([]);
  const [lagData, setLagData] = useState<LagData[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [lagStats, setLagStats] = useState<any>(null);
  const [mode, setMode] = useState<'poly' | 'chainlink'>('chainlink');
  const [moveLagEvents, setMoveLagEvents] = useState<MoveLagEvent[]>([]);
  const [moveLagStats, setMoveLagStats] = useState<any>(null);
  const [patternBuckets, setPatternBuckets] = useState<any[]>([]);
  const [btc15mBuckets, setBtc15mBuckets] = useState<any[]>([]);
  const [btc15mEventsCount, setBtc15mEventsCount] = useState<number>(0);
  const [btc15mGlobalUpRate, setBtc15mGlobalUpRate] = useState<number | null>(null);
  const [btc15mStrategies, setBtc15mStrategies] = useState<any[]>([]);
  const [paperHoldMs, setPaperHoldMs] = useState<number>(2000);
  const [paperFeeBps, setPaperFeeBps] = useState<number>(0);
  const [paperIncludeFills, setPaperIncludeFills] = useState<boolean>(true);
  const [paperMaxFills, setPaperMaxFills] = useState<number>(300);
  const [paperLoading, setPaperLoading] = useState(false);
  const [paperError, setPaperError] = useState<string | null>(null);
  const [paperRes, setPaperRes] = useState<any>(null);
  const [orderP95Ms, setOrderP95Ms] = useState<number | ''>('');
  const [thresholdUsd, setThresholdUsd] = useState(5);
  const [chainlinkSource, setChainlinkSource] = useState<'CHAINLINK' | 'POLYMARKET_RTDS_CHAINLINK'>('POLYMARKET_RTDS_CHAINLINK');
  const [liveBinance, setLiveBinance] = useState<PriceSample | null>(null);
  const [liveChainlink, setLiveChainlink] = useState<PriceSample | null>(null);
  const [livePolyUp, setLivePolyUp] = useState<number | null>(null);
  const [livePolyDown, setLivePolyDown] = useState<number | null>(null);
  const [livePolyObservedAt, setLivePolyObservedAt] = useState<number | null>(null);
  const [liveSeries, setLiveSeries] = useState<
    Array<{ t: number; binance?: number; chainlink?: number; spread?: number; polyUp?: number; polyDown?: number }>
  >(
    []
  );
  const [ageSeries, setAgeSeries] = useState<Array<{ t: number; binanceAgeMs?: number; chainlinkAgeMs?: number; polyAgeMs?: number }>>([]);
  const [showBinanceLine, setShowBinanceLine] = useState(true);
  const [showChainlinkLine, setShowChainlinkLine] = useState(true);
  const [showSpreadLine, setShowSpreadLine] = useState(true);
  const [showPolyUpLine, setShowPolyUpLine] = useState(true);
  const [showPolyDownLine, setShowPolyDownLine] = useState(true);
  const [realtimeView, setRealtimeView] = useState<'delta' | 'price'>('delta');
  const [baseline, setBaseline] = useState<{ b: number | null; c: number | null; t: number | null }>({ b: null, c: null, t: null });
  const [liveWindowSec, setLiveWindowSec] = useState<30 | 60 | 180>(60);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<'1h' | '6h' | '24h' | '7d'>('1h');

  const fetchAnalysis = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const now = new Date();
      const from = new Date(now.getTime() - getTimeRangeMs(timeRange));

      // Fetch minimal samples only for table (slow path, less frequent)
      const sources =
        mode === 'chainlink'
          ? chainlinkSource === 'POLYMARKET_RTDS_CHAINLINK'
            ? 'BINANCE,POLYMARKET_RTDS_CHAINLINK'
            : 'BINANCE,CHAINLINK'
          : 'BINANCE,POLYMARKET';
      const samplesRes = await fetch(
        `/api/price-samples?from=${from.toISOString()}&to=${now.toISOString()}&sources=${sources}&limit=200&order=desc`
      );
      if (samplesRes.ok) {
        const samplesData = await samplesRes.json();
        setSamples(samplesData.samples || []);
        setStats(samplesData.stats || null);
      }

      if (mode === 'poly') {
        const lagRes = await fetch(
          `/api/price-samples/lag?from=${from.toISOString()}&to=${now.toISOString()}`
        );
        if (lagRes.ok) {
          const lagDataRes = await lagRes.json();
          setLagData(lagDataRes.lagData || []);
          setLagStats(lagDataRes.stats || null);
        }
      } else {
        const bSource = chainlinkSource;
        const moveRes = await fetch(
          `/api/price-samples/lag-moves?from=${from.toISOString()}&to=${now.toISOString()}&thresholdUsd=${thresholdUsd}&bucketMs=200&maxPoints=20000&bSource=${bSource}&bSymbol=BTCUSD&deltaBucketUsd=2&maxBuckets=20`
        );
        if (moveRes.ok) {
          const move = await moveRes.json();
          setMoveLagEvents(move.events || []);
          setMoveLagStats(move.stats || null);
          setPatternBuckets(move.patternBuckets || []);
        }

        // BTC 15m pattern discovery (price-to-beat anchored)
        const patRes = await fetch(
          `/api/patterns/btc15m?from=${from.toISOString()}&to=${now.toISOString()}&spikeUsd=${thresholdUsd}&reactionWindowMs=3000&deltaBucketUsd=10&spikeBucketUsd=2&spikeCooldownMs=250&epsilon=0.01&minN=10${
            typeof orderP95Ms === 'number' ? `&orderP95Ms=${orderP95Ms}&safetyMs=150` : ''
          }`,
          { cache: 'no-store' }
        );
        if (patRes.ok) {
          const pat = await patRes.json();
          // Prefer the expert 2D buckets; fallback to legacy 1D buckets
          setBtc15mBuckets(Array.isArray(pat.buckets2d) ? pat.buckets2d : Array.isArray(pat.buckets) ? pat.buckets : []);
          setBtc15mEventsCount(Number(pat.eventsCount || 0));
          setBtc15mGlobalUpRate(typeof pat.global?.upResponseRate === 'number' ? pat.global.upResponseRate : null);
          setBtc15mStrategies(Array.isArray(pat.strategies) ? pat.strategies : []);
        }
      }
    } catch (error) {
      console.error('Failed to fetch data:', error);
      setError(error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [chainlinkSource, mode, orderP95Ms, thresholdUsd, timeRange]);

  const runPapertrade = useCallback(async () => {
    setPaperLoading(true);
    setPaperError(null);
    try {
      const now = new Date();
      const from = new Date(now.getTime() - getTimeRangeMs(timeRange));
      const orderMs = typeof orderP95Ms === 'number' ? orderP95Ms : 0;
      const res = await fetch(
        `/api/papertrade/btc15m?from=${from.toISOString()}&to=${now.toISOString()}&spikeUsd=${thresholdUsd}&reactionWindowMs=3000&deltaBucketUsd=10&spikeBucketUsd=2&spikeCooldownMs=250&epsilon=0.01&minN=10&orderP95Ms=${orderMs}&safetyMs=150&holdMs=${paperHoldMs}&feeBps=${paperFeeBps}&includeFills=${paperIncludeFills ? 1 : 0}&maxFills=${paperMaxFills}`,
        { cache: 'no-store' }
      );
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `papertrade failed: ${res.status}`);
      }
      const data = await res.json();
      setPaperRes(data);
    } catch (e) {
      console.error('papertrade failed:', e);
      setPaperError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setPaperLoading(false);
    }
  }, [orderP95Ms, paperFeeBps, paperHoldMs, paperIncludeFills, paperMaxFills, thresholdUsd, timeRange]);

  useEffect(() => {
    // True realtime via SSE (server polls DB and pushes updates)
    const es = new EventSource(`/api/realtime/prices?intervalMs=250&includePolymarket=true`);
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        const t = msg.t as number;
        const b = msg.binance?.price as number | undefined;
        const c = msg.chainlink?.price as number | undefined;
        const spread = typeof b === 'number' && typeof c === 'number' ? c - b : undefined;
        const bObs = msg.binance?.observedAt as number | undefined;
        const cObs = msg.chainlink?.observedAt as number | undefined;
        const binanceAgeMs = typeof bObs === 'number' ? t - bObs : undefined;
        const chainlinkAgeMs = typeof cObs === 'number' ? t - cObs : undefined;

        const upBid = msg.polymarket?.up?.bid as number | null | undefined;
        const upAsk = msg.polymarket?.up?.ask as number | null | undefined;
        const downBid = msg.polymarket?.down?.bid as number | null | undefined;
        const downAsk = msg.polymarket?.down?.ask as number | null | undefined;
        const polyUp =
          typeof upBid === 'number' && typeof upAsk === 'number'
            ? (upBid + upAsk) / 2
            : typeof upBid === 'number'
              ? upBid
              : typeof upAsk === 'number'
                ? upAsk
                : undefined;
        const polyDown =
          typeof downBid === 'number' && typeof downAsk === 'number'
            ? (downBid + downAsk) / 2
            : typeof downBid === 'number'
              ? downBid
              : typeof downAsk === 'number'
                ? downAsk
                : undefined;

        const polyTUp = msg.polymarket?.up?.t as number | null | undefined;
        const polyTDown = msg.polymarket?.down?.t as number | null | undefined;
        const polyObs = Math.max(typeof polyTUp === 'number' ? polyTUp : 0, typeof polyTDown === 'number' ? polyTDown : 0) || null;
        const polyAgeMs = typeof polyObs === 'number' ? t - polyObs : undefined;

        if (typeof b === 'number') {
          setLiveBinance({ id: 'live', source: 'BINANCE', symbol: 'BTCUSDT', price: b, side: 'BID', observedAt: new Date(msg.binance.observedAt).toISOString() });
        }
        if (typeof c === 'number') {
          setLiveChainlink({
            id: 'live',
            source: String(msg.chainlink?.source ?? 'CHAINLINK'),
            symbol: 'BTCUSD',
            price: c,
            side: 'ORACLE',
            observedAt: new Date(msg.chainlink.observedAt).toISOString(),
          });
        }
        if (typeof polyUp === 'number') setLivePolyUp(polyUp);
        if (typeof polyDown === 'number') setLivePolyDown(polyDown);
        if (typeof polyObs === 'number') setLivePolyObservedAt(polyObs);

        // Initialize baseline once we have both values
        setBaseline((prev) => {
          if (prev.b == null && prev.c == null && typeof b === 'number' && typeof c === 'number') {
            return { b, c, t };
          }
          return prev;
        });

        setLiveSeries((prev) => {
          const next = [...prev, { t, binance: b, chainlink: c, spread, polyUp, polyDown }].slice(-600); // ~2.5 minutes @250ms
          return next;
        });

        setAgeSeries((prev) => {
          const next = [...prev, { t, binanceAgeMs, chainlinkAgeMs, polyAgeMs }].slice(-600);
          return next;
        });
      } catch {
        // ignore
      }
    };
    return () => es.close();
  }, []);

  const livePoints = useMemo(() => Math.max(50, Math.floor((liveWindowSec * 1000) / 250)), [liveWindowSec]);
  const liveSeriesWindow = useMemo(() => liveSeries.slice(-livePoints), [liveSeries, livePoints]);

  useEffect(() => {
    fetchAnalysis();
    const interval = setInterval(fetchAnalysis, mode === 'chainlink' ? 15000 : 5000);
    return () => clearInterval(interval);
  }, [fetchAnalysis, mode]);

  const getTimeRangeMs = (range: string) => {
    switch (range) {
      case '1h':
        return 60 * 60 * 1000;
      case '6h':
        return 6 * 60 * 60 * 1000;
      case '24h':
        return 24 * 60 * 60 * 1000;
      case '7d':
        return 7 * 24 * 60 * 60 * 1000;
      default:
        return 60 * 60 * 1000;
    }
  };

  // (Removed heavy chart series derived from raw samples; charts use lag endpoints)

  // Lag chart data
  const lagChartData = lagData.map((d) => ({
    time: new Date(d.timestamp).toLocaleTimeString(),
    timestamp: new Date(d.timestamp).getTime(),
    lagMs: d.lagMs,
    priceDiff: d.priceDiff,
    symbol: d.polySymbol,
  }));

  const moveLagChartData = moveLagEvents.map((e) => ({
    time: new Date(e.timestamp).toLocaleTimeString(),
    timestamp: new Date(e.timestamp).getTime(),
    lagMs: e.lagMs,
    binanceDelta: e.binanceDelta,
    chainlinkDelta: e.chainlinkDelta,
    ratio: e.ratio,
  }));

  return (
    <div className="min-h-screen bg-slate-950">
      <div className="container mx-auto px-4 py-8">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-3xl font-bold text-slate-100">Lag Analysis</h1>
          <div className="flex gap-2 items-center">
            <div className="flex gap-2">
              <button
                onClick={() => setMode('chainlink')}
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  mode === 'chainlink'
                    ? 'bg-cyan-600 text-white'
                    : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                }`}
              >
                Binance ↔ Chainlink
              </button>
              <button
                onClick={() => setMode('poly')}
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  mode === 'poly'
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                }`}
              >
                Binance ↔ Polymarket
              </button>
            </div>

            {mode === 'chainlink' && (
              <>
                <div className="flex items-center gap-2 bg-slate-900 rounded-lg px-3 py-2">
                  <span className="text-xs text-slate-400">Feed</span>
                  <select
                    value={chainlinkSource}
                    onChange={(e) => setChainlinkSource(e.target.value as any)}
                    className="bg-slate-800 text-slate-100 text-sm rounded px-2 py-1"
                  >
                    <option value="POLYMARKET_RTDS_CHAINLINK">Polymarket RTDS (Chainlink)</option>
                    <option value="CHAINLINK">On-chain Chainlink (Polygon)</option>
                  </select>
                </div>
                <div className="flex items-center gap-2 bg-slate-900 rounded-lg px-3 py-2">
                  <span className="text-xs text-slate-400">Threshold</span>
                  <input
                    type="number"
                    value={thresholdUsd}
                    min={1}
                    step={1}
                    onChange={(e) => setThresholdUsd(Number(e.target.value))}
                    className="w-16 bg-slate-800 text-slate-100 text-sm rounded px-2 py-1"
                  />
                  <span className="text-xs text-slate-400">USD</span>
                </div>
                <div className="flex items-center gap-2 bg-slate-900 rounded-lg px-3 py-2">
                  <span className="text-xs text-slate-400">Order p95</span>
                  <input
                    type="number"
                    value={orderP95Ms}
                    min={0}
                    step={1}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === '') return setOrderP95Ms('');
                      const n = Number(v);
                      setOrderP95Ms(Number.isFinite(n) ? n : '');
                    }}
                    className="w-20 bg-slate-800 text-slate-100 text-sm rounded px-2 py-1"
                    placeholder="ms"
                  />
                  <span className="text-xs text-slate-400">ms</span>
                </div>
              </>
            )}

            {(['1h', '6h', '24h', '7d'] as const).map((range) => (
              <button
                key={range}
                onClick={() => setTimeRange(range)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  timeRange === range
                    ? 'bg-emerald-600 text-white'
                    : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                }`}
              >
                {range}
              </button>
            ))}
          </div>
        </div>

        {/* Live ticker (fast) */}
        {mode === 'chainlink' && (
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-6">
            <div className="bg-slate-800 rounded-lg p-4">
              <div className="text-sm text-slate-400">Live Binance BID</div>
              <div className="text-2xl font-bold text-emerald-400 font-mono">
                {liveBinance ? liveBinance.price.toFixed(2) : '—'}
              </div>
              <div className="text-xs text-slate-500">
                {liveBinance ? new Date(liveBinance.observedAt).toLocaleTimeString() : ''}
              </div>
            </div>
            <div className="bg-slate-800 rounded-lg p-4">
              <div className="text-sm text-slate-400">Live Chainlink BTC/USD</div>
              <div className="text-2xl font-bold text-cyan-300 font-mono">
                {liveChainlink ? liveChainlink.price.toFixed(2) : '—'}
              </div>
              <div className="text-xs text-slate-500">
                {liveChainlink ? new Date(liveChainlink.observedAt).toLocaleTimeString() : ''}
              </div>
            </div>
            <div className="bg-slate-800 rounded-lg p-4">
              <div className="text-sm text-slate-400">Spread (Chainlink - Binance)</div>
              <div className="text-2xl font-bold text-slate-100 font-mono">
                {liveBinance && liveChainlink
                  ? (liveChainlink.price - liveBinance.price).toFixed(2)
                  : '—'}
              </div>
              <div className="text-xs text-slate-500">Updates every ~1s</div>
            </div>
            <div className="bg-slate-800 rounded-lg p-4">
              <div className="text-sm text-slate-400">Live Polymarket UP (mid)</div>
              <div className="text-2xl font-bold text-blue-300 font-mono">
                {typeof livePolyUp === 'number' ? livePolyUp.toFixed(3) : '—'}
              </div>
              <div className="text-xs text-slate-500">
                {typeof livePolyObservedAt === 'number' ? new Date(livePolyObservedAt).toLocaleTimeString() : ''}
              </div>
            </div>
            <div className="bg-slate-800 rounded-lg p-4">
              <div className="text-sm text-slate-400">Live Polymarket DOWN (mid)</div>
              <div className="text-2xl font-bold text-purple-300 font-mono">
                {typeof livePolyDown === 'number' ? livePolyDown.toFixed(3) : '—'}
              </div>
              <div className="text-xs text-slate-500">
                {typeof livePolyObservedAt === 'number' ? new Date(livePolyObservedAt).toLocaleTimeString() : ''}
              </div>
            </div>
          </div>
        )}

        {/* Realtime chart */}
        {mode === 'chainlink' && (
          <div className="bg-slate-800 rounded-lg p-6 mb-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold text-slate-100">Realtime (Binance vs Chainlink)</h2>
              <div className="flex gap-3 items-center text-xs text-slate-300">
                <div className="flex gap-2 bg-slate-900 rounded-lg px-2 py-1">
                  <button
                    onClick={() => setLiveWindowSec(30)}
                    className={`px-2 py-1 rounded ${liveWindowSec === 30 ? 'bg-slate-700 text-white' : 'text-slate-300 hover:bg-slate-800'}`}
                  >
                    30s
                  </button>
                  <button
                    onClick={() => setLiveWindowSec(60)}
                    className={`px-2 py-1 rounded ${liveWindowSec === 60 ? 'bg-slate-700 text-white' : 'text-slate-300 hover:bg-slate-800'}`}
                  >
                    1m
                  </button>
                  <button
                    onClick={() => setLiveWindowSec(180)}
                    className={`px-2 py-1 rounded ${liveWindowSec === 180 ? 'bg-slate-700 text-white' : 'text-slate-300 hover:bg-slate-800'}`}
                  >
                    3m
                  </button>
                </div>
                <div className="flex gap-2 bg-slate-900 rounded-lg px-2 py-1">
                  <button
                    onClick={() => setRealtimeView('delta')}
                    className={`px-2 py-1 rounded ${realtimeView === 'delta' ? 'bg-slate-700 text-white' : 'text-slate-300 hover:bg-slate-800'}`}
                  >
                    Δ ($)
                  </button>
                  <button
                    onClick={() => setRealtimeView('price')}
                    className={`px-2 py-1 rounded ${realtimeView === 'price' ? 'bg-slate-700 text-white' : 'text-slate-300 hover:bg-slate-800'}`}
                  >
                    Price
                  </button>
                </div>
                <button
                  onClick={() => {
                    if (liveBinance && liveChainlink) {
                      setBaseline({ b: liveBinance.price, c: liveChainlink.price, t: Date.now() });
                    }
                  }}
                  className="px-2 py-1 rounded bg-slate-900 hover:bg-slate-800"
                >
                  Reset baseline
                </button>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={showBinanceLine}
                    onChange={(e) => setShowBinanceLine(e.target.checked)}
                  />
                  Binance
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={showChainlinkLine}
                    onChange={(e) => setShowChainlinkLine(e.target.checked)}
                  />
                  Chainlink
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={showSpreadLine}
                    onChange={(e) => setShowSpreadLine(e.target.checked)}
                  />
                  Spread
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={showPolyUpLine}
                    onChange={(e) => setShowPolyUpLine(e.target.checked)}
                  />
                  Poly UP
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={showPolyDownLine}
                    onChange={(e) => setShowPolyDownLine(e.target.checked)}
                  />
                  Poly DOWN
                </label>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={320}>
              <LineChart
                data={liveSeriesWindow.map((p) => {
                  const b = p.binance;
                  const c = p.chainlink;
                  const b0 = baseline.b;
                  const c0 = baseline.c;
                  const deltaBinance = typeof b === 'number' && typeof b0 === 'number' ? b - b0 : undefined;
                  const deltaChainlink = typeof c === 'number' && typeof c0 === 'number' ? c - c0 : undefined;
                  return {
                    ts: p.t,
                    time: new Date(p.t).toLocaleTimeString(),
                    binance: p.binance,
                    chainlink: p.chainlink,
                    spread: p.spread,
                    polyUp: p.polyUp,
                    polyDown: p.polyDown,
                    deltaBinance,
                    deltaChainlink,
                  };
                })}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis
                  dataKey="ts"
                  stroke="#9ca3af"
                  tick={{ fill: '#9ca3af' }}
                  tickFormatter={(v) => new Date(Number(v)).toLocaleTimeString()}
                  interval="preserveStartEnd"
                />
                {realtimeView === 'price' ? (
                  <>
                    <YAxis
                      yAxisId="price"
                      stroke="#9ca3af"
                      tick={{ fill: '#9ca3af' }}
                      tickFormatter={(v) => (typeof v === 'number' ? v.toFixed(0) : v)}
                      domain={['dataMin - 25', 'dataMax + 25']}
                      width={70}
                    />
                    <YAxis
                      yAxisId="spread"
                      orientation="right"
                      stroke="#9ca3af"
                      tick={{ fill: '#9ca3af' }}
                      tickFormatter={(v) => (typeof v === 'number' ? v.toFixed(2) : v)}
                      domain={['dataMin - 5', 'dataMax + 5']}
                      width={80}
                    />
                    <YAxis
                      yAxisId="poly"
                      orientation="right"
                      stroke="#9ca3af"
                      tick={{ fill: '#9ca3af' }}
                      tickFormatter={(v) => (typeof v === 'number' ? v.toFixed(2) : v)}
                      domain={[0, 1]}
                      width={60}
                    />
                  </>
                ) : (
                  <>
                    <YAxis
                      yAxisId="delta"
                      stroke="#9ca3af"
                      tick={{ fill: '#9ca3af' }}
                      tickFormatter={(v) => (typeof v === 'number' ? v.toFixed(2) : v)}
                      domain={['dataMin - 2', 'dataMax + 2']}
                      width={80}
                    />
                    <ReferenceLine yAxisId="delta" y={6} stroke="#ef4444" strokeDasharray="4 4" />
                    <ReferenceLine yAxisId="delta" y={-6} stroke="#ef4444" strokeDasharray="4 4" />
                    <ReferenceLine yAxisId="delta" y={0} stroke="#64748b" strokeDasharray="2 2" />
                  </>
                )}
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#1f2937',
                    border: '1px solid #374151',
                    borderRadius: '8px',
                  }}
                  labelFormatter={(v) => new Date(Number(v)).toLocaleTimeString()}
                />
                <Legend />
                <Brush
                  dataKey="ts"
                  height={22}
                  travellerWidth={10}
                  stroke="#64748b"
                  tickFormatter={(v) => new Date(Number(v)).toLocaleTimeString()}
                />
                {showBinanceLine && (
                  <Line
                    yAxisId={realtimeView === 'price' ? 'price' : 'delta'}
                    // In delta view we want true shapes (no smoothing/overshoot)
                    type={realtimeView === 'price' ? 'monotone' : 'linear'}
                    dataKey={realtimeView === 'price' ? 'binance' : 'deltaBinance'}
                    stroke="#10b981"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                    name={realtimeView === 'price' ? 'Binance BID' : 'Δ Binance ($)'}
                  />
                )}
                {showChainlinkLine && (
                  <Line
                    yAxisId={realtimeView === 'price' ? 'price' : 'delta'}
                    // Chainlink updates discretely; show as steps in delta view
                    type={realtimeView === 'price' ? 'monotone' : 'stepAfter'}
                    dataKey={realtimeView === 'price' ? 'chainlink' : 'deltaChainlink'}
                    stroke="#06b6d4"
                    strokeWidth={4}
                    strokeDasharray="6 3"
                    dot={false}
                    activeDot={{ r: 5 }}
                    isAnimationActive={false}
                    name={realtimeView === 'price' ? 'Chainlink (dashed)' : 'Δ Chainlink ($) (dashed)'}
                  />
                )}
                {realtimeView === 'price' && showSpreadLine && (
                  <Line
                    yAxisId="spread"
                    type="monotone"
                    dataKey="spread"
                    stroke="#f59e0b"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                    name="Spread (RHS)"
                  />
                )}
                {realtimeView === 'price' && showPolyUpLine && (
                  <Line
                    yAxisId="poly"
                    type="monotone"
                    dataKey="polyUp"
                    stroke="#3b82f6"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                    name="Poly UP (0..1)"
                  />
                )}
                {realtimeView === 'price' && showPolyDownLine && (
                  <Line
                    yAxisId="poly"
                    type="monotone"
                    dataKey="polyDown"
                    stroke="#a855f7"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                    name="Poly DOWN (0..1)"
                  />
                )}
              </LineChart>
            </ResponsiveContainer>

            {/* Realtime staleness chart: shows update cadence differences clearly */}
            <div className="mt-6">
              <h3 className="text-sm font-semibold text-slate-200 mb-2">Update Age (ms) — realtime verschil tussen feeds</h3>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart
                  data={ageSeries.map((p) => ({
                    time: new Date(p.t).toLocaleTimeString(),
                    binanceAgeMs: p.binanceAgeMs,
                    chainlinkAgeMs: p.chainlinkAgeMs,
                    polyAgeMs: p.polyAgeMs,
                  }))}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis dataKey="time" stroke="#9ca3af" tick={{ fill: '#9ca3af' }} interval="preserveStartEnd" />
                  <YAxis stroke="#9ca3af" tick={{ fill: '#9ca3af' }} domain={[0, 'dataMax + 500']} width={80} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#1f2937',
                      border: '1px solid #374151',
                      borderRadius: '8px',
                    }}
                  />
                  <Legend />
                  <Line type="monotone" dataKey="binanceAgeMs" stroke="#10b981" strokeWidth={2} dot={false} name="Binance age (ms)" />
                  <Line type="monotone" dataKey="chainlinkAgeMs" stroke="#06b6d4" strokeWidth={2} strokeDasharray="6 3" dot={false} name="Chainlink age (ms)" />
                  <Line type="monotone" dataKey="polyAgeMs" stroke="#3b82f6" strokeWidth={2} dot={false} name="Poly share age (ms)" />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Delta view: show ONLY the difference in USD, so it’s always visible */}
            <div className="mt-6">
              <h3 className="text-sm font-semibold text-slate-200 mb-2">Delta View (Chainlink − Binance) in USD</h3>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart
                  data={liveSeries.map((p) => ({
                    time: new Date(p.t).toLocaleTimeString(),
                    delta: p.spread,
                  }))}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis dataKey="time" stroke="#9ca3af" tick={{ fill: '#9ca3af' }} interval="preserveStartEnd" />
                  <YAxis
                    stroke="#9ca3af"
                    tick={{ fill: '#9ca3af' }}
                    tickFormatter={(v) => (typeof v === 'number' ? v.toFixed(2) : v)}
                    domain={['dataMin - 5', 'dataMax + 5']}
                    width={80}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#1f2937',
                      border: '1px solid #374151',
                      borderRadius: '8px',
                    }}
                  />
                  <Legend />
                  <Line type="monotone" dataKey="delta" stroke="#f59e0b" strokeWidth={2} dot={false} name="Spread ($)" />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Polymarket shareprice view: UP/DOWN are on a 0..1 axis */}
            <div className="mt-6">
              <h3 className="text-sm font-semibold text-slate-200 mb-2">Polymarket Share Price (UP/DOWN) — realtime</h3>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart
                  data={liveSeries.map((p) => ({
                    time: new Date(p.t).toLocaleTimeString(),
                    up: p.polyUp,
                    down: p.polyDown,
                  }))}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis dataKey="time" stroke="#9ca3af" tick={{ fill: '#9ca3af' }} interval="preserveStartEnd" />
                  <YAxis
                    stroke="#9ca3af"
                    tick={{ fill: '#9ca3af' }}
                    domain={[0, 1]}
                    tickFormatter={(v) => (typeof v === 'number' ? v.toFixed(2) : v)}
                    width={70}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#1f2937',
                      border: '1px solid #374151',
                      borderRadius: '8px',
                    }}
                  />
                  <Legend />
                  {showPolyUpLine && (
                    <Line type="monotone" dataKey="up" stroke="#3b82f6" strokeWidth={2} dot={false} isAnimationActive={false} name="Poly UP (mid)" />
                  )}
                  {showPolyDownLine && (
                    <Line type="monotone" dataKey="down" stroke="#a855f7" strokeWidth={2} dot={false} isAnimationActive={false} name="Poly DOWN (mid)" />
                  )}
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* COMBINED: Delta + Poly correlation chart */}
            <div className="mt-6 bg-slate-900 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-slate-200 mb-2">
                📊 Delta vs Poly Correlation — KEY STRATEGY VIEW
              </h3>
              <p className="text-xs text-slate-400 mb-3">
                Wanneer delta (Chainlink - Binance) groeit → BTC stijgt op Binance voordat Chainlink/Polymarket het ziet.
                Kijk hoe Poly UP/DOWN reageert op delta-veranderingen.
              </p>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart
                  data={liveSeriesWindow.map((p) => {
                    const delta = p.spread; // Chainlink - Binance
                    return {
                      ts: p.t,
                      time: new Date(p.t).toLocaleTimeString(),
                      delta,
                      polyUp: p.polyUp,
                      polyDown: p.polyDown,
                    };
                  })}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis
                    dataKey="ts"
                    stroke="#9ca3af"
                    tick={{ fill: '#9ca3af' }}
                    tickFormatter={(v) => new Date(Number(v)).toLocaleTimeString()}
                    interval="preserveStartEnd"
                  />
                  {/* Left Y-axis: Delta in USD */}
                  <YAxis
                    yAxisId="delta"
                    stroke="#f59e0b"
                    tick={{ fill: '#f59e0b' }}
                    tickFormatter={(v) => (typeof v === 'number' ? v.toFixed(1) : v)}
                    domain={['dataMin - 5', 'dataMax + 5']}
                    width={60}
                    label={{ value: 'Δ ($)', angle: -90, position: 'insideLeft', fill: '#f59e0b', fontSize: 12 }}
                  />
                  {/* Right Y-axis: Poly share price 0-1 */}
                  <YAxis
                    yAxisId="poly"
                    orientation="right"
                    stroke="#8b5cf6"
                    tick={{ fill: '#8b5cf6' }}
                    domain={[0, 1]}
                    tickFormatter={(v) => (typeof v === 'number' ? v.toFixed(2) : v)}
                    width={50}
                    label={{ value: 'Poly', angle: 90, position: 'insideRight', fill: '#8b5cf6', fontSize: 12 }}
                  />
                  <ReferenceLine yAxisId="delta" y={0} stroke="#64748b" strokeDasharray="2 2" />
                  <ReferenceLine yAxisId="delta" y={5} stroke="#22c55e" strokeDasharray="4 4" strokeOpacity={0.5} />
                  <ReferenceLine yAxisId="delta" y={-5} stroke="#ef4444" strokeDasharray="4 4" strokeOpacity={0.5} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#1f2937',
                      border: '1px solid #374151',
                      borderRadius: '8px',
                    }}
                    labelFormatter={(v) => new Date(Number(v)).toLocaleTimeString()}
                    formatter={(value: any, name: string) => {
                      if (name === 'Delta (CL-BN)') return [`$${Number(value).toFixed(2)}`, name];
                      return [Number(value).toFixed(3), name];
                    }}
                  />
                  <Legend />
                  <Brush
                    dataKey="ts"
                    height={20}
                    travellerWidth={8}
                    stroke="#64748b"
                    tickFormatter={(v) => new Date(Number(v)).toLocaleTimeString()}
                  />
                  {/* Delta line - THICK, prominent */}
                  <Line
                    yAxisId="delta"
                    type="stepAfter"
                    dataKey="delta"
                    stroke="#f59e0b"
                    strokeWidth={3}
                    dot={false}
                    isAnimationActive={false}
                    name="Delta (CL-BN)"
                  />
                  {/* Poly UP - on right axis */}
                  {showPolyUpLine && (
                    <Line
                      yAxisId="poly"
                      type="monotone"
                      dataKey="polyUp"
                      stroke="#3b82f6"
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                      name="Poly UP"
                    />
                  )}
                  {/* Poly DOWN - on right axis */}
                  {showPolyDownLine && (
                    <Line
                      yAxisId="poly"
                      type="monotone"
                      dataKey="polyDown"
                      stroke="#a855f7"
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                      name="Poly DOWN"
                    />
                  )}
                </LineChart>
              </ResponsiveContainer>
              <div className="text-xs text-slate-500 mt-2">
                <strong>Strategie hint:</strong> Als delta negatief wordt (Binance stijgt sneller dan Chainlink ziet) 
                → verwacht Poly UP stijging. Als delta positief wordt (Binance daalt sneller) → verwacht Poly DOWN stijging.
                De referentielijnen op ±$5 markeren potentiële entry triggers.
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <div className="text-center py-12">
            <div className="text-slate-400">Loading...</div>
          </div>
        ) : error ? (
          <div className="bg-red-900/20 border border-red-500/50 rounded-lg p-6 mb-6">
            <h2 className="text-xl font-bold text-red-400 mb-2">Error</h2>
            <p className="text-red-300">{error}</p>
            <button
              onClick={fetchAnalysis}
              className="mt-4 px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg transition-colors"
            >
              Retry
            </button>
          </div>
        ) : samples.length === 0 ? (
          <div className="bg-slate-800 rounded-lg p-8 text-center">
            <h2 className="text-2xl font-bold text-slate-100 mb-4">No Data Yet</h2>
            <p className="text-slate-400 mb-4">
              Start the lag recorder to begin collecting price samples:
            </p>
            <code className="block bg-slate-900 px-4 py-2 rounded text-slate-300 mb-4">
              npm run lag-recorder
            </code>
            <p className="text-sm text-slate-500">
              The recorder will log Binance and Polymarket prices in real-time.
            </p>
          </div>
        ) : (
          <>
            {/* Statistics */}
            {stats && (
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
                <div className="bg-slate-800 rounded-lg p-4">
                  <div className="text-sm text-slate-400">Total Samples</div>
                  <div className="text-2xl font-bold text-slate-100">{stats.total}</div>
                </div>
                <div className="bg-slate-800 rounded-lg p-4">
                  <div className="text-sm text-slate-400">Binance</div>
                  <div className="text-2xl font-bold text-emerald-400">
                    {stats.bySource.BINANCE || 0}
                  </div>
                </div>
                <div className="bg-slate-800 rounded-lg p-4">
                  <div className="text-sm text-slate-400">Polymarket</div>
                  <div className="text-2xl font-bold text-blue-400">
                    {stats.bySource.POLYMARKET || 0}
                  </div>
                </div>
                {lagStats && (
                  <div className="bg-slate-800 rounded-lg p-4">
                    <div className="text-sm text-slate-400">Avg Lag</div>
                    <div className="text-2xl font-bold text-yellow-400">
                      {lagStats.avgLagMs}ms
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Lag Statistics */}
            {mode === 'poly' && lagStats && (
              <div className="bg-slate-800 rounded-lg p-6 mb-6">
                <h2 className="text-xl font-bold text-slate-100 mb-4">Lag Statistics</h2>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div>
                    <div className="text-sm text-slate-400">Average</div>
                    <div className="text-lg font-bold text-slate-100">
                      {lagStats.avgLagMs}ms
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-slate-400">Median</div>
                    <div className="text-lg font-bold text-slate-100">
                      {lagStats.medianLagMs}ms
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-slate-400">Min</div>
                    <div className="text-lg font-bold text-green-400">
                      {lagStats.minLagMs}ms
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-slate-400">Max</div>
                    <div className="text-lg font-bold text-red-400">
                      {lagStats.maxLagMs}ms
                    </div>
                  </div>
                </div>
              </div>
            )}

            {mode === 'chainlink' && moveLagStats && (
              <div className="bg-slate-800 rounded-lg p-6 mb-6">
                <h2 className="text-xl font-bold text-slate-100 mb-4">
                  Move Lag (Binance → {chainlinkSource === 'POLYMARKET_RTDS_CHAINLINK' ? 'RTDS Chainlink' : 'On-chain Chainlink'})
                </h2>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                  <div>
                    <div className="text-sm text-slate-400">Events</div>
                    <div className="text-lg font-bold text-slate-100">{moveLagStats.total}</div>
                  </div>
                  <div>
                    <div className="text-sm text-slate-400">Avg Lag</div>
                    <div className="text-lg font-bold text-yellow-400">{moveLagStats.avgLagMs}ms</div>
                    <div className="text-xs text-slate-500">
                      95% CI: {moveLagStats.ci95LowMs}–{moveLagStats.ci95HighMs}ms
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-slate-400">Median</div>
                    <div className="text-lg font-bold text-slate-100">{moveLagStats.medianLagMs}ms</div>
                  </div>
                  <div>
                    <div className="text-sm text-slate-400">Min/Max</div>
                    <div className="text-lg font-bold text-slate-100">
                      {moveLagStats.minLagMs} / {moveLagStats.maxLagMs}ms
                    </div>
                    <div className="text-xs text-slate-500">
                      p95: {moveLagStats.p95LagMs}ms (n={moveLagStats.total})
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-slate-400">Avg |ΔB|/|ΔA|</div>
                    <div className="text-lg font-bold text-cyan-300">
                      {(moveLagStats.avgRatio || 0).toFixed(2)}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {mode === 'chainlink' && patternBuckets.length > 0 && (
              <div className="bg-slate-800 rounded-lg p-6 mb-6">
                <h2 className="text-xl font-bold text-slate-100 mb-4">Pattern discovery (bucketed by |Δ Binance|)</h2>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-700">
                        <th className="text-left py-2 px-3 text-slate-400">|ΔA| bucket</th>
                        <th className="text-right py-2 px-3 text-slate-400">n</th>
                        <th className="text-right py-2 px-3 text-slate-400">avg lag</th>
                        <th className="text-right py-2 px-3 text-slate-400">p95 lag</th>
                        <th className="text-right py-2 px-3 text-slate-400">|ΔB| median</th>
                        <th className="text-right py-2 px-3 text-slate-400">|ΔB| range</th>
                        <th className="text-right py-2 px-3 text-slate-400">ratio median</th>
                      </tr>
                    </thead>
                    <tbody>
                      {patternBuckets.map((b) => (
                        <tr key={b.idx} className="border-b border-slate-700/50 hover:bg-slate-700/40">
                          <td className="py-2 px-3 text-slate-200 font-mono">
                            {b.bucketMin.toFixed(0)}–{b.bucketMax.toFixed(0)}
                          </td>
                          <td className="py-2 px-3 text-right text-slate-200">{b.n}</td>
                          <td className="py-2 px-3 text-right text-yellow-300 font-mono">{b.avgLagMs}ms</td>
                          <td className="py-2 px-3 text-right text-slate-200 font-mono">{b.p95LagMs}ms</td>
                          <td className="py-2 px-3 text-right text-cyan-200 font-mono">{Number(b.medianAbsBUsd).toFixed(2)}</td>
                          <td className="py-2 px-3 text-right text-slate-300 font-mono">
                            {Number(b.minAbsBUsd).toFixed(2)}–{Number(b.maxAbsBUsd).toFixed(2)}
                          </td>
                          <td className="py-2 px-3 text-right text-slate-200 font-mono">{Number(b.ratioMedian).toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="text-xs text-slate-500 mt-2">
                  ΔA = Binance move per bucket; ΔB = first matching Chainlink move within window (same direction).
                </div>
              </div>
            )}

            {mode === 'chainlink' && btc15mBuckets.length > 0 && (
              <div className="bg-slate-800 rounded-lg p-6 mb-6">
                <h2 className="text-xl font-bold text-slate-100 mb-2">
                  BTC 15m pattern (baseline delta × Binance spike → Poly reaction)
                </h2>
                <div className="text-sm text-slate-400 mb-4">
                  Events analysed: <span className="text-slate-100 font-semibold">{btc15mEventsCount}</span> (Binance spikes ≥ threshold)
                  {typeof btc15mGlobalUpRate === 'number' && (
                    <span className="ml-3">
                      Global UP response rate: <span className="text-slate-100 font-semibold">{(btc15mGlobalUpRate * 100).toFixed(1)}%</span>
                    </span>
                  )}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-700">
                        <th className="text-left py-2 px-3 text-slate-400">Δbaseline bucket</th>
                        <th className="text-left py-2 px-3 text-slate-400">|ΔBinance| bucket</th>
                        <th className="text-right py-2 px-3 text-slate-400">n</th>
                        <th className="text-right py-2 px-3 text-slate-400">UP resp (95% CI)</th>
                        <th className="text-right py-2 px-3 text-slate-400">UP aligned</th>
                        <th className="text-right py-2 px-3 text-slate-400">UP med lag</th>
                        <th className="text-right py-2 px-3 text-slate-400">lift</th>
                      </tr>
                    </thead>
                    <tbody>
                      {btc15mBuckets.map((b: any) => (
                        <tr key={String(b.bucket)} className="border-b border-slate-700/50 hover:bg-slate-700/40">
                          <td className="py-2 px-3 text-slate-200 font-mono">{String(b.deltaBucket ?? b.bucket ?? '—')}</td>
                          <td className="py-2 px-3 text-slate-200 font-mono">{String(b.spikeBucket ?? '—')}</td>
                          <td className="py-2 px-3 text-right text-slate-200">{Number(b.n || 0)}</td>
                          <td className="py-2 px-3 text-right text-yellow-300 font-mono">
                            {b.upResponseRate == null
                              ? '—'
                              : `${(Number(b.upResponseRate) * 100).toFixed(1)}% (${(Number(b.upCI95Low ?? 0) * 100).toFixed(0)}–${(Number(b.upCI95High ?? 0) * 100).toFixed(0)})`}
                          </td>
                          <td className="py-2 px-3 text-right text-cyan-200 font-mono">
                            {b.upAlignedRate == null ? '—' : `${(Number(b.upAlignedRate) * 100).toFixed(0)}%`}
                          </td>
                          <td className="py-2 px-3 text-right text-slate-200 font-mono">
                            {b.upMedianLagMs == null ? '—' : `${Number(b.upMedianLagMs).toFixed(0)}ms`}
                          </td>
                          <td className="py-2 px-3 text-right text-slate-200 font-mono">
                            {b.liftVsGlobal == null ? '—' : `${(Number(b.liftVsGlobal) * 100).toFixed(1)}%`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="text-xs text-slate-500 mt-2">
                  “price-to-beat” = Chainlink BTCUSD op start-tick van de 15m market (xx:00/15/30/45). Response = Poly mid beweegt ≥ 0.01 binnen 3s na Binance spike (gemeten op Polymarket timestamps).
                </div>
              </div>
            )}

            {mode === 'chainlink' && btc15mStrategies.length > 0 && (
              <div className="bg-slate-800 rounded-lg p-6 mb-6">
                <h2 className="text-xl font-bold text-slate-100 mb-2">Strategy candidates (statistically filtered)</h2>
                <div className="text-sm text-slate-400 mb-4">
                  Filter: n≥10 and CI low &gt; global. Sorted by edgeScore.
                  {typeof orderP95Ms === 'number' && <span className="ml-2">Feasibility uses order p95 + 150ms safety.</span>}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-700">
                        <th className="text-left py-2 px-3 text-slate-400">Δbaseline</th>
                        <th className="text-left py-2 px-3 text-slate-400">|ΔBinance|</th>
                        <th className="text-left py-2 px-3 text-slate-400">time left</th>
                        <th className="text-right py-2 px-3 text-slate-400">n</th>
                        <th className="text-right py-2 px-3 text-slate-400">UP resp (CI)</th>
                        <th className="text-right py-2 px-3 text-slate-400">UP aligned</th>
                        <th className="text-right py-2 px-3 text-slate-400">UP med lag</th>
                        <th className="text-right py-2 px-3 text-slate-400">lift</th>
                        <th className="text-right py-2 px-3 text-slate-400">edgeScore</th>
                        {typeof orderP95Ms === 'number' && <th className="text-right py-2 px-3 text-slate-400">feasible</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {btc15mStrategies.map((s: any, idx: number) => (
                        <tr
                          key={`${String(s.deltaBucket)}|${String(s.spikeBucket)}|${String(s.remainingBucket)}|${idx}`}
                          className="border-b border-slate-700/50 hover:bg-slate-700/40"
                        >
                          <td className="py-2 px-3 text-slate-200 font-mono">{String(s.deltaBucket)}</td>
                          <td className="py-2 px-3 text-slate-200 font-mono">{String(s.spikeBucket)}</td>
                          <td className="py-2 px-3 text-slate-200 font-mono">{String(s.remainingBucket)}</td>
                          <td className="py-2 px-3 text-right text-slate-200">{Number(s.n || 0)}</td>
                          <td className="py-2 px-3 text-right text-yellow-300 font-mono">
                            {`${(Number(s.upResponseRate || 0) * 100).toFixed(1)}% (${(Number(s.upCI95Low || 0) * 100).toFixed(0)}–${(Number(s.upCI95High || 0) * 100).toFixed(0)})`}
                          </td>
                          <td className="py-2 px-3 text-right text-cyan-200 font-mono">{`${(Number(s.upAlignedRate || 0) * 100).toFixed(0)}%`}</td>
                          <td className="py-2 px-3 text-right text-slate-200 font-mono">
                            {s.upMedianLagMs == null ? '—' : `${Number(s.upMedianLagMs).toFixed(0)}ms`}
                          </td>
                          <td className="py-2 px-3 text-right text-slate-200 font-mono">{`${(Number(s.liftVsGlobal || 0) * 100).toFixed(1)}%`}</td>
                          <td className="py-2 px-3 text-right text-slate-200 font-mono">{Number(s.edgeScore || 0).toFixed(3)}</td>
                          {typeof orderP95Ms === 'number' && (
                            <td className="py-2 px-3 text-right text-slate-200 font-mono">
                              {s.feasibleForOrderLatency == null ? '—' : s.feasibleForOrderLatency ? 'YES' : 'NO'}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {mode === 'chainlink' && (
              <div className="bg-slate-800 rounded-lg p-6 mb-6">
                <div className="flex items-center justify-between gap-4 mb-2">
                  <h2 className="text-xl font-bold text-slate-100">Papertrade (latency-aware, side-by-side)</h2>
                  <button
                    onClick={runPapertrade}
                    disabled={paperLoading}
                    className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                      paperLoading ? 'bg-slate-700 text-slate-300' : 'bg-emerald-600 text-white hover:bg-emerald-500'
                    }`}
                  >
                    {paperLoading ? 'Running…' : 'Run papertrade'}
                  </button>
                </div>
                <div className="text-sm text-slate-400 mb-4">
                  Simulates: enter at (spike time + order p95), pay ask; exit after holdMs, hit bid. PnL is per 1 share.
                </div>

                <div className="flex flex-wrap gap-3 items-center mb-4">
                  <div className="flex items-center gap-2 bg-slate-900 rounded-lg px-3 py-2">
                    <span className="text-xs text-slate-400">hold</span>
                    <input
                      type="number"
                      value={paperHoldMs}
                      min={0}
                      step={50}
                      onChange={(e) => setPaperHoldMs(Number(e.target.value))}
                      className="w-24 bg-slate-800 text-slate-100 text-sm rounded px-2 py-1"
                    />
                    <span className="text-xs text-slate-400">ms</span>
                  </div>
                  <div className="flex items-center gap-2 bg-slate-900 rounded-lg px-3 py-2">
                    <span className="text-xs text-slate-400">fee</span>
                    <input
                      type="number"
                      value={paperFeeBps}
                      min={0}
                      step={1}
                      onChange={(e) => setPaperFeeBps(Number(e.target.value))}
                      className="w-20 bg-slate-800 text-slate-100 text-sm rounded px-2 py-1"
                    />
                    <span className="text-xs text-slate-400">bps</span>
                  </div>
                  <div className="flex items-center gap-2 bg-slate-900 rounded-lg px-3 py-2">
                    <span className="text-xs text-slate-400">fills</span>
                    <select
                      value={paperIncludeFills ? '1' : '0'}
                      onChange={(e) => setPaperIncludeFills(e.target.value === '1')}
                      className="bg-slate-800 text-slate-100 text-sm rounded px-2 py-1"
                    >
                      <option value="1">include</option>
                      <option value="0">off</option>
                    </select>
                    <span className="text-xs text-slate-400">max</span>
                    <input
                      type="number"
                      value={paperMaxFills}
                      min={0}
                      step={50}
                      onChange={(e) => setPaperMaxFills(Number(e.target.value))}
                      className="w-20 bg-slate-800 text-slate-100 text-sm rounded px-2 py-1"
                    />
                  </div>
                  <div className="text-xs text-slate-500">
                    Uses threshold={thresholdUsd}USD and timeRange={timeRange}.
                  </div>
                </div>

                {paperError && (
                  <div className="mb-4 text-sm text-red-300 bg-red-900/20 border border-red-800 rounded p-3">{paperError}</div>
                )}

                {paperRes?.global?.paper && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                    <div className="bg-slate-900 rounded-lg p-4">
                      <div className="text-sm text-slate-400">Global paper (UP)</div>
                      <div className="text-sm text-slate-200 font-mono">
                        fills={paperRes.global.paper.UP?.fills ?? 0} avgPnl={(Number(paperRes.global.paper.UP?.avgPnl ?? 0)).toFixed(4)} medPnl=
                        {(Number(paperRes.global.paper.UP?.medianPnl ?? 0)).toFixed(4)} win={(Number(paperRes.global.paper.UP?.winRate ?? 0) * 100).toFixed(0)}%
                      </div>
                    </div>
                    <div className="bg-slate-900 rounded-lg p-4">
                      <div className="text-sm text-slate-400">Global paper (DOWN)</div>
                      <div className="text-sm text-slate-200 font-mono">
                        fills={paperRes.global.paper.DOWN?.fills ?? 0} avgPnl={(Number(paperRes.global.paper.DOWN?.avgPnl ?? 0)).toFixed(4)} medPnl=
                        {(Number(paperRes.global.paper.DOWN?.medianPnl ?? 0)).toFixed(4)} win={(Number(paperRes.global.paper.DOWN?.winRate ?? 0) * 100).toFixed(0)}%
                      </div>
                    </div>
                  </div>
                )}

                {Array.isArray(paperRes?.strategies) && paperRes.strategies.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-700">
                          <th className="text-left py-2 px-3 text-slate-400">Δbaseline</th>
                          <th className="text-left py-2 px-3 text-slate-400">|ΔBinance|</th>
                          <th className="text-left py-2 px-3 text-slate-400">time left</th>
                          <th className="text-right py-2 px-3 text-slate-400">n</th>
                          <th className="text-right py-2 px-3 text-slate-400">edge</th>
                          <th className="text-right py-2 px-3 text-slate-400">UP avgPnl</th>
                          <th className="text-right py-2 px-3 text-slate-400">UP fills</th>
                          <th className="text-right py-2 px-3 text-slate-400">DOWN avgPnl</th>
                          <th className="text-right py-2 px-3 text-slate-400">DOWN fills</th>
                          <th className="text-left py-2 px-3 text-slate-400">best</th>
                        </tr>
                      </thead>
                      <tbody>
                        {paperRes.strategies.map((s: any, idx: number) => {
                          const up = s.paper?.UP;
                          const down = s.paper?.DOWN;
                          const upAvg = Number(up?.avgPnl ?? 0);
                          const downAvg = Number(down?.avgPnl ?? 0);
                          const best =
                            up?.fills && down?.fills ? (upAvg >= downAvg ? 'UP' : 'DOWN') : up?.fills ? 'UP' : down?.fills ? 'DOWN' : '—';
                          return (
                            <tr
                              key={`${String(s.deltaBucket)}|${String(s.spikeBucket)}|${String(s.remainingBucket)}|paper|${idx}`}
                              className="border-b border-slate-700/50 hover:bg-slate-700/40"
                            >
                              <td className="py-2 px-3 text-slate-200 font-mono">{String(s.deltaBucket)}</td>
                              <td className="py-2 px-3 text-slate-200 font-mono">{String(s.spikeBucket)}</td>
                              <td className="py-2 px-3 text-slate-200 font-mono">{String(s.remainingBucket)}</td>
                              <td className="py-2 px-3 text-right text-slate-200">{Number(s.n || 0)}</td>
                              <td className="py-2 px-3 text-right text-slate-200 font-mono">{Number(s.edgeScore || 0).toFixed(3)}</td>
                              <td className="py-2 px-3 text-right text-emerald-300 font-mono">{up ? upAvg.toFixed(4) : '—'}</td>
                              <td className="py-2 px-3 text-right text-slate-200 font-mono">{up?.fills ?? 0}</td>
                              <td className="py-2 px-3 text-right text-purple-300 font-mono">{down ? downAvg.toFixed(4) : '—'}</td>
                              <td className="py-2 px-3 text-right text-slate-200 font-mono">{down?.fills ?? 0}</td>
                              <td className="py-2 px-3 text-slate-200 font-mono">{best}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="text-sm text-slate-500">Click “Run papertrade” to simulate fills for the current time range.</div>
                )}

                {Array.isArray(paperRes?.fills) && paperRes.fills.length > 0 && (
                  <div className="mt-6">
                    <div className="text-sm text-slate-300 mb-2">Paper fills (simulated “placed” trades)</div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-slate-700">
                            <th className="text-left py-2 px-3 text-slate-400">time</th>
                            <th className="text-left py-2 px-3 text-slate-400">side</th>
                            <th className="text-left py-2 px-3 text-slate-400">bucket</th>
                            <th className="text-right py-2 px-3 text-slate-400">entry</th>
                            <th className="text-right py-2 px-3 text-slate-400">exit</th>
                            <th className="text-right py-2 px-3 text-slate-400">fee</th>
                            <th className="text-right py-2 px-3 text-slate-400">pnl</th>
                          </tr>
                        </thead>
                        <tbody>
                          {paperRes.fills.map((f: any, idx: number) => {
                            const pnl = Number(f.pnl || 0);
                            const bucket = `${String(f.deltaBucket)} | ${String(f.spikeBucket)} | ${String(f.remainingBucket)}`;
                            return (
                              <tr key={`${String(f.tEntry)}|${idx}`} className="border-b border-slate-700/50 hover:bg-slate-700/40">
                                <td className="py-2 px-3 text-slate-200 font-mono">{new Date(String(f.tEntry)).toLocaleTimeString()}</td>
                                <td className="py-2 px-3 text-slate-200 font-mono">{String(f.side)}</td>
                                <td className="py-2 px-3 text-slate-300 font-mono">{bucket}</td>
                                <td className="py-2 px-3 text-right text-slate-200 font-mono">{Number(f.entry || 0).toFixed(4)}</td>
                                <td className="py-2 px-3 text-right text-slate-200 font-mono">{Number(f.exit || 0).toFixed(4)}</td>
                                <td className="py-2 px-3 text-right text-slate-200 font-mono">{Number(f.fee || 0).toFixed(4)}</td>
                                <td className={`py-2 px-3 text-right font-mono ${pnl >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>
                                  {pnl.toFixed(4)}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div className="text-xs text-slate-500 mt-2">
                      PnL is per 1 share, using ask on entry and bid on exit, with your configured latency + hold.
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Price Comparison Chart */}
            {mode === 'poly' && (
              <div className="bg-slate-800 rounded-lg p-6 mb-6">
                <h2 className="text-xl font-bold text-slate-100 mb-4">Price Comparison</h2>
                <ResponsiveContainer width="100%" height={400}>
                  <LineChart data={lagChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis
                    dataKey="time"
                    stroke="#9ca3af"
                    tick={{ fill: '#9ca3af' }}
                    interval="preserveStartEnd"
                  />
                  <YAxis stroke="#9ca3af" tick={{ fill: '#9ca3af' }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#1f2937',
                      border: '1px solid #374151',
                      borderRadius: '8px',
                    }}
                  />
                  <Legend />
                  <Line
                    type="monotone"
                      dataKey="binancePrice"
                    stroke="#10b981"
                    strokeWidth={2}
                    dot={false}
                    name="Binance BTC"
                  />
                  <Line
                    type="monotone"
                      dataKey="polyPrice"
                    stroke="#3b82f6"
                    strokeWidth={2}
                    dot={false}
                      name="Polymarket (prob)"
                  />
                </LineChart>
              </ResponsiveContainer>
              </div>
            )}

            {/* Lag Chart */}
            {mode === 'poly' && lagChartData.length > 0 && (
              <div className="bg-slate-800 rounded-lg p-6">
                <h2 className="text-xl font-bold text-slate-100 mb-4">Lag Over Time</h2>
                <ResponsiveContainer width="100%" height={400}>
                  <LineChart data={lagChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                    <XAxis
                      dataKey="time"
                      stroke="#9ca3af"
                      tick={{ fill: '#9ca3af' }}
                      interval="preserveStartEnd"
                    />
                    <YAxis stroke="#9ca3af" tick={{ fill: '#9ca3af' }} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#1f2937',
                        border: '1px solid #374151',
                        borderRadius: '8px',
                      }}
                    />
                    <Legend />
                    <Line
                      type="monotone"
                      dataKey="lagMs"
                      stroke="#f59e0b"
                      strokeWidth={2}
                      dot={false}
                      name="Lag (ms)"
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            {mode === 'chainlink' && moveLagChartData.length > 0 && (
              <div className="bg-slate-800 rounded-lg p-6">
                <h2 className="text-xl font-bold text-slate-100 mb-4">Move Lag Over Time</h2>
                <ResponsiveContainer width="100%" height={400}>
                  <LineChart data={moveLagChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                    <XAxis dataKey="time" stroke="#9ca3af" tick={{ fill: '#9ca3af' }} interval="preserveStartEnd" />
                    <YAxis stroke="#9ca3af" tick={{ fill: '#9ca3af' }} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#1f2937',
                        border: '1px solid #374151',
                        borderRadius: '8px',
                      }}
                    />
                    <Legend />
                    <Line type="monotone" dataKey="lagMs" stroke="#22c55e" strokeWidth={2} dot={false} name="Lag (ms)" />
                    <Line type="monotone" dataKey="binanceDelta" stroke="#10b981" strokeWidth={1} dot={false} name="Δ Binance ($)" />
                    <Line type="monotone" dataKey="chainlinkDelta" stroke="#06b6d4" strokeWidth={1} dot={false} name="Δ Chainlink ($)" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Recent Samples Table */}
            <div className="bg-slate-800 rounded-lg p-6 mt-6">
              <h2 className="text-xl font-bold text-slate-100 mb-4">Recent Samples</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-700">
                      <th className="text-left py-2 px-4 text-slate-400">Time</th>
                      <th className="text-left py-2 px-4 text-slate-400">Source</th>
                      <th className="text-left py-2 px-4 text-slate-400">Symbol</th>
                      <th className="text-right py-2 px-4 text-slate-400">Price</th>
                      <th className="text-left py-2 px-4 text-slate-400">Side</th>
                    </tr>
                  </thead>
                  <tbody>
                    {samples.slice(-50).reverse().map((sample) => (
                      <tr
                        key={sample.id}
                        className="border-b border-slate-700/50 hover:bg-slate-700/50"
                      >
                        <td className="py-2 px-4 text-slate-300">
                          {new Date(sample.observedAt).toLocaleTimeString()}
                        </td>
                        <td className="py-2 px-4">
                          <span
                            className={`px-2 py-1 rounded text-xs font-medium ${
                              sample.source === 'BINANCE'
                                ? 'bg-emerald-500/20 text-emerald-400'
                                : 'bg-blue-500/20 text-blue-400'
                            }`}
                          >
                            {sample.source}
                          </span>
                        </td>
                        <td className="py-2 px-4 text-slate-300">{sample.symbol}</td>
                        <td className="py-2 px-4 text-right text-slate-100 font-mono">
                          {sample.price.toFixed(4)}
                        </td>
                        <td className="py-2 px-4 text-slate-400">{sample.side || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
