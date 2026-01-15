'use client';

import { useState, useEffect } from 'react';
import { useRealtime } from '@/hooks/useRealtime';

interface Position {
  id: string;
  market: string;
  marketEndTime?: string;
  outcome: number;
  outcomeName?: string; // "Yes", "No", "Up", "Down"
  shares: number;
  avgPrice: number;
  currentPrice?: number;
  pnl: number;
  pnlPercent?: number;
}

interface DashboardData {
  positions: Position[];
  walletAddress: string;
  totalPnl: number;
  totalValue: number;
  totalCost: number;
}

function formatPrice(price: number): string {
  return `${Math.round(price * 100)}¢`;
}

function formatPnl(value: number): string {
  const prefix = value >= 0 ? '+' : '';
  return `${prefix}$${value.toFixed(2)}`;
}

function formatPnlPercent(value: number): string {
  const prefix = value >= 0 ? '+' : '';
  return `${prefix}${value.toFixed(1)}%`;
}

// Extract crypto asset from market title (e.g., "Bitcoin Up or Down..." -> "BTC")
function extractAsset(title: string): string {
  if (title.includes('Bitcoin')) return 'BTC';
  if (title.includes('Ethereum')) return 'ETH';
  if (title.includes('Solana')) return 'SOL';
  if (title.includes('XRP')) return 'XRP';
  if (title.includes('Dogecoin')) return 'DOGE';
  if (title.includes('Cardano')) return 'ADA';
  return title.slice(0, 6);
}

// Extract time slot from market title
function extractTimeSlot(title: string): string {
  const match = title.match(/(\d{1,2}:\d{2}[AP]M)-(\d{1,2}:\d{2}[AP]M)/);
  return match ? match[0] : '';
}

// Check if market is still active (not ended)
function isMarketActive(endTime?: string): boolean {
  if (!endTime) return true;
  return new Date(endTime) > new Date();
}

export function TradingDashboard({ data }: { data: DashboardData }) {
  const [currentTime, setCurrentTime] = useState(new Date());
  
  // Update time every second
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Real-time connection for orders
  const {
    isConnected,
    isUserConnected,
    hasAuth,
    recentOrders,
    ordersLoaded,
    refreshOrders,
  } = useRealtime({
    enabled: true,
    walletAddress: data.walletAddress,
  });

  // Separate active and resolved positions
  const activePositions = data.positions.filter(p => isMarketActive(p.marketEndTime));
  const resolvedPositions = data.positions.filter(p => !isMarketActive(p.marketEndTime));

  // Get current time slot from active positions
  const currentTimeSlot = activePositions.length > 0 
    ? extractTimeSlot(activePositions[0].market)
    : '';

  // Calculate totals for active positions
  const activeTotalPnl = activePositions.reduce((sum, p) => sum + p.pnl, 0);
  const activeTotalValue = activePositions.reduce((sum, p) => sum + (p.shares * (p.currentPrice || p.avgPrice)), 0);
  const activeTotalCost = activePositions.reduce((sum, p) => sum + (p.shares * p.avgPrice), 0);

  // Open orders (from WebSocket)
  const openOrders = recentOrders.filter(o => o.status === 'LIVE');
  const nextTimeSlot = openOrders.length > 0 
    ? extractTimeSlot(openOrders[0].market || '')
    : '';

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-white">
      <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        {/* In-page header (global top nav is now handled by RootLayout) */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold">Trading Bot</h1>
            <span className="text-slate-500 text-sm">
              {currentTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <button 
              onClick={() => refreshOrders()}
              className="text-xs text-slate-400 hover:text-white transition-colors px-2 py-1 rounded hover:bg-slate-700"
            >
              Refresh
            </button>
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${ordersLoaded ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'}`} />
              <span className="text-xs text-slate-400">
                {ordersLoaded ? (hasAuth ? 'Orders Loaded' : 'No API Auth') : 'Loading...'}
              </span>
            </div>
          </div>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-4 gap-4">
          <div className="bg-slate-800/60 rounded-xl p-4 border border-slate-700/50">
            <div className="text-xs text-slate-500 uppercase mb-1">Active Positions</div>
            <div className="text-3xl font-bold text-white">{activePositions.length}</div>
            <div className="text-xs text-slate-400 mt-1">{currentTimeSlot || 'No active'}</div>
          </div>
          
          <div className="bg-slate-800/60 rounded-xl p-4 border border-slate-700/50">
            <div className="text-xs text-slate-500 uppercase mb-1">Open Orders</div>
            <div className="text-3xl font-bold text-cyan-400">{openOrders.length}</div>
            <div className="text-xs text-slate-400 mt-1">{nextTimeSlot || 'None pending'}</div>
          </div>
          
          <div className="bg-slate-800/60 rounded-xl p-4 border border-slate-700/50">
            <div className="text-xs text-slate-500 uppercase mb-1">Active Value</div>
            <div className="text-3xl font-bold text-white">${activeTotalValue.toFixed(2)}</div>
            <div className="text-xs text-slate-400 mt-1">Cost: ${activeTotalCost.toFixed(2)}</div>
          </div>
          
          <div className={`rounded-xl p-4 border ${activeTotalPnl >= 0 ? 'bg-emerald-900/30 border-emerald-700/50' : 'bg-red-900/30 border-red-700/50'}`}>
            <div className="text-xs text-slate-500 uppercase mb-1">Active P&L</div>
            <div className={`text-3xl font-bold ${activeTotalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {formatPnl(activeTotalPnl)}
            </div>
            <div className={`text-xs mt-1 ${activeTotalPnl >= 0 ? 'text-emerald-400/70' : 'text-red-400/70'}`}>
              {activeTotalCost > 0 ? formatPnlPercent((activeTotalPnl / activeTotalCost) * 100) : '0%'}
            </div>
          </div>
        </div>

        {/* Open Orders Section */}
        <div className="bg-slate-800/40 rounded-xl border border-cyan-700/30 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-700/50 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${openOrders.length > 0 ? 'bg-cyan-400 animate-pulse' : 'bg-slate-500'}`} />
              <h2 className="font-semibold text-cyan-400">Open Orders</h2>
              <span className="text-xs text-slate-500">{nextTimeSlot}</span>
            </div>
            <span className="text-sm text-slate-400">
              {!ordersLoaded ? 'Loading...' : `${openOrders.length} pending`}
            </span>
          </div>
          {!ordersLoaded ? (
            <div className="px-4 py-8 text-center text-slate-500">
              <span className="animate-pulse">Loading orders...</span>
            </div>
          ) : openOrders.length === 0 ? (
            <div className="px-4 py-8 text-center text-slate-500">
              {hasAuth ? 'No open orders' : 'API credentials not configured'}
            </div>
          ) : (
            <div className="divide-y divide-slate-700/30">
              {openOrders.map((order, i) => (
                <div key={i} className="px-4 py-3 flex items-center justify-between hover:bg-slate-700/20 transition-colors">
                  <div className="flex items-center gap-3">
                    <span className="text-lg font-bold text-slate-300">{extractAsset(order.market || '')}</span>
                    <span className="px-2 py-0.5 rounded text-xs bg-blue-500/20 text-blue-400">
                      {order.side}
                    </span>
                  </div>
                  <div className="text-right">
                    <div className="text-slate-300">
                      {order.sizeMatched?.toFixed(0) || 0} / {order.originalSize.toFixed(0)} filled
                    </div>
                    <div className="text-xs text-slate-500">@ {formatPrice(order.price)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Active Positions Section */}
        <div className="bg-slate-800/40 rounded-xl border border-emerald-700/30 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-700/50 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <h2 className="font-semibold text-emerald-400">Active Positions</h2>
              <span className="text-xs text-slate-500">{currentTimeSlot}</span>
            </div>
            <span className="text-sm text-slate-400">{activePositions.length} positions</span>
          </div>
          
          {activePositions.length === 0 ? (
            <div className="px-4 py-8 text-center text-slate-500">
              No active positions right now
            </div>
          ) : (
            <div className="divide-y divide-slate-700/30">
              {activePositions.map((pos) => {
                const currentValue = pos.shares * (pos.currentPrice || pos.avgPrice);
                const cost = pos.shares * pos.avgPrice;
                const pnlPercent = cost > 0 ? (pos.pnl / cost) * 100 : 0;
                const outcomeLower = String(pos.outcomeName ?? '').toLowerCase();
                const isUp = outcomeLower === 'up' || outcomeLower === 'yes';
                
                return (
                  <div key={pos.id} className="px-4 py-3 flex items-center justify-between hover:bg-slate-700/20 transition-colors">
                  <div className="flex items-center gap-3">
                    <span className="text-lg font-bold text-slate-300">{extractAsset(pos.market)}</span>
                    <span className={`px-2 py-0.5 rounded text-xs ${
                      isUp
                        ? 'bg-emerald-500/20 text-emerald-400' 
                        : 'bg-red-500/20 text-red-400'
                    }`}>
                      {pos.outcomeName || (pos.outcome === 0 ? 'Yes' : 'No')}
                    </span>
                    <span className="text-sm text-slate-500">
                      {pos.shares.toFixed(0)} shares
                    </span>
                  </div>
                    <div className="flex items-center gap-6">
                      <div className="text-right">
                        <div className="text-sm text-slate-400">
                          {formatPrice(pos.avgPrice)} → {formatPrice(pos.currentPrice || pos.avgPrice)}
                        </div>
                      </div>
                      <div className="text-right min-w-[80px]">
                        <div className={`font-semibold ${pos.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {formatPnl(pos.pnl)}
                        </div>
                        <div className={`text-xs ${pos.pnl >= 0 ? 'text-emerald-400/70' : 'text-red-400/70'}`}>
                          {formatPnlPercent(pnlPercent)}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Recent Results Section */}
        {resolvedPositions.length > 0 && (
          <div className="bg-slate-800/40 rounded-xl border border-slate-700/30 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-700/50 flex items-center justify-between">
              <h2 className="font-semibold text-slate-400">Recent Results</h2>
              <span className="text-sm text-slate-500">{resolvedPositions.length} resolved</span>
            </div>
            <div className="divide-y divide-slate-700/30">
              {resolvedPositions.slice(0, 10).map((pos) => (
                <div key={pos.id} className="px-4 py-2 flex items-center justify-between hover:bg-slate-700/20 transition-colors text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-slate-400">{extractAsset(pos.market)}</span>
                    {(() => {
                      const outcomeLower = String(pos.outcomeName ?? '').toLowerCase();
                      const isUp = outcomeLower === 'up' || outcomeLower === 'yes';
                      return (
                    <span className={`px-1.5 py-0.5 rounded text-xs ${
                      isUp
                        ? 'bg-emerald-500/20 text-emerald-400/70' 
                        : 'bg-red-500/20 text-red-400/70'
                    }`}>
                      {pos.outcomeName || (pos.outcome === 0 ? 'Yes' : 'No')}
                    </span>
                      );
                    })()}
                    <span className="text-slate-500">{extractTimeSlot(pos.market)}</span>
                  </div>
                  <span className={`font-medium ${pos.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {formatPnl(pos.pnl)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Total P&L Summary */}
        <div className="bg-slate-800/40 rounded-xl border border-slate-700/30 p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-slate-500 uppercase">All-Time P&L</div>
              <div className={`text-2xl font-bold ${data.totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {formatPnl(data.totalPnl)}
              </div>
            </div>
            <div className="text-right">
              <div className="text-sm text-slate-500">Total Positions</div>
              <div className="text-lg text-slate-300">{data.positions.length}</div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
