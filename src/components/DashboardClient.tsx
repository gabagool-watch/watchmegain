'use client';

import { useState, useMemo, useEffect } from 'react';
import { useRealtime } from '@/hooks/useRealtime';

interface DashboardData {
  summary: {
    totalPnl: number;
    totalProfit: number;
    totalLoss: number;
    totalVolume: number;
    totalTrades: number;
    uniqueMarkets: number;
    openPositions: number;
    closedPositions: number;
    winRate: number;
    winningPositions: number;
    losingPositions: number;
  };
  topWinners: Array<{ market: string; pnl: number; trades: number }>;
  topLosers: Array<{ market: string; pnl: number; trades: number }>;
  recentTrades: Array<{
    id: string;
    market: string;
    side: string;
    size: number;
    price: number;
    cost: number;
    time: string;
    txHash: string;
  }>;
  openPositions: Array<{
    id: string;
    market: string;
    outcome: number;
    shares: number;
    avgPrice: number;
    currentValue: number;
    pnl: number;
    marketSlug?: string;
  }>;
  walletCount: number;
  walletAddress: string;
}

interface Notification {
  id: string;
  type: 'order' | 'trade' | 'info';
  message: string;
  detail?: string;
  timestamp: Date;
}

function formatUSD(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1000000) {
    return `$${(value / 1000000).toFixed(2)}M`;
  }
  if (abs >= 1000) {
    return `$${(value / 1000).toFixed(1)}K`;
  }
  return `$${value.toFixed(2)}`;
}

function formatPnlColor(value: number): string {
  if (value > 0) return 'text-emerald-400';
  if (value < 0) return 'text-red-400';
  return 'text-slate-400';
}

function StatCard({ 
  label, 
  value, 
  subValue,
  color = 'default',
}: { 
  label: string; 
  value: string | number; 
  subValue?: string;
  color?: 'default' | 'green' | 'red' | 'yellow' | 'blue';
}) {
  const colorClasses = {
    default: 'text-slate-100',
    green: 'text-emerald-400',
    red: 'text-red-400',
    yellow: 'text-amber-400',
    blue: 'text-cyan-400',
  };

  return (
    <div className="bg-slate-800/60 rounded-xl p-4 border border-slate-700/50">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs text-slate-500 uppercase tracking-wider">{label}</span>
      </div>
      <div className={`text-2xl font-bold ${colorClasses[color]}`}>
        {value}
      </div>
      {subValue && (
        <div className="text-xs text-slate-500 mt-1">{subValue}</div>
      )}
    </div>
  );
}

function AssetBar({ 
  asset, 
  wins, 
  losses, 
  pnl,
}: { 
  asset: string; 
  wins: number; 
  losses: number; 
  pnl: number;
}) {
  const total = wins + losses;
  const winPercent = total > 0 ? (wins / total) * 100 : 50;
  
  return (
    <div className="bg-slate-800/60 rounded-lg p-3 border border-slate-700/50">
      <div className="flex items-center justify-between mb-2">
        <span className="font-medium text-slate-200">{asset}</span>
        <span className={`font-semibold ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
          {pnl >= 0 ? '+' : ''}{pnl.toFixed(0)}
        </span>
      </div>
      <div className="flex h-2 rounded-full overflow-hidden bg-slate-900">
        <div 
          className="bg-emerald-500 transition-all duration-300" 
          style={{ width: `${winPercent}%` }}
        />
        <div 
          className="bg-red-500 transition-all duration-300" 
          style={{ width: `${100 - winPercent}%` }}
        />
      </div>
      <div className="flex justify-between mt-1 text-xs text-slate-500">
        <span>{wins}W / {losses}L</span>
      </div>
    </div>
  );
}

// Toast notification component
function NotificationToast({ notification, onClose }: { notification: Notification; onClose: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onClose, 5000);
    return () => clearTimeout(timer);
  }, [onClose]);

  const bgColor = notification.type === 'trade' 
    ? 'bg-emerald-900/90 border-emerald-500/50' 
    : notification.type === 'order'
    ? 'bg-blue-900/90 border-blue-500/50'
    : 'bg-slate-800/90 border-slate-600/50';

  const icon = notification.type === 'trade' ? '💰' : notification.type === 'order' ? '📋' : 'ℹ️';

  return (
    <div className={`${bgColor} border rounded-xl p-4 shadow-2xl backdrop-blur-sm animate-slideIn`}>
      <div className="flex items-start gap-3">
        <span className="text-2xl">{icon}</span>
        <div className="flex-1">
          <p className="font-medium text-slate-100">{notification.message}</p>
          {notification.detail && (
            <p className="text-sm text-slate-400 mt-1">{notification.detail}</p>
          )}
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-200">
          ✕
        </button>
      </div>
    </div>
  );
}

export function DashboardClient({ data }: { data: DashboardData }) {
  const [activeTab, setActiveTab] = useState<'positions' | 'trades' | 'activity'>('activity');
  const [filter, setFilter] = useState('ALL');
  const [notifications, setNotifications] = useState<Notification[]>([]);
  
  const { 
    isConnected, 
    isUserConnected, 
    hasAuth,
    statusMessage,
    recentOrders,
    ownTrades,
    latestOrder,
    latestOwnTrade,
  } = useRealtime({ 
    enabled: false, // Disabled to prevent SSE reconnection loop
    walletAddress: data.walletAddress,
    onOrder: (order) => {
      // Show notification for order updates
      const statusText = order.status === 'MATCHED' ? 'Order Filled!' 
        : order.status === 'LIVE' ? 'Order Placed'
        : order.status === 'CANCELLED' ? 'Order Cancelled'
        : 'Order Expired';
      
      addNotification({
        type: 'order',
        message: `${statusText}: ${order.side} ${order.originalSize.toFixed(2)} @ ${(order.price * 100).toFixed(1)}¢`,
        detail: order.market || `Asset: ${order.assetId.slice(0, 16)}...`,
      });
    },
    onUserTrade: (trade) => {
      // Show notification for fills
      addNotification({
        type: 'trade',
        message: `Trade Filled: ${trade.side} ${trade.size.toFixed(2)} @ ${(trade.price * 100).toFixed(1)}¢`,
        detail: `Total: $${(trade.size * trade.price).toFixed(2)}`,
      });
    },
  });

  const { summary, topWinners, topLosers, recentTrades, openPositions } = data;
  
  // Add notification helper
  const addNotification = (notif: Omit<Notification, 'id' | 'timestamp'>) => {
    const newNotif: Notification = {
      ...notif,
      id: Math.random().toString(36).slice(2),
      timestamp: new Date(),
    };
    setNotifications(prev => [newNotif, ...prev].slice(0, 5));
  };

  const removeNotification = (id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  };
  
  // Calculate additional stats
  const avgBetSize = summary.totalTrades > 0 ? summary.totalVolume / summary.totalTrades : 0;
  const avgProfit = summary.winningPositions > 0 ? summary.totalProfit / summary.winningPositions : 0;
  const avgLoss = summary.losingPositions > 0 ? summary.totalLoss / summary.losingPositions : 0;
  const profitFactor = summary.totalLoss > 0 ? summary.totalProfit / summary.totalLoss : summary.totalProfit > 0 ? Infinity : 0;
  const roi = summary.totalVolume > 0 ? (summary.totalPnl / summary.totalVolume) * 100 : 0;

  // Get top market categories
  const marketCategories = useMemo(() => {
    const allMarkets = [...topWinners, ...topLosers];
    const categories = new Map<string, { wins: number; losses: number; pnl: number }>();
    
    allMarkets.forEach(m => {
      const category = m.market.split(' ')[0].toUpperCase().slice(0, 8);
      const existing = categories.get(category) || { wins: 0, losses: 0, pnl: 0 };
      if (m.pnl > 0) {
        existing.wins++;
        existing.pnl += m.pnl;
      } else {
        existing.losses++;
        existing.pnl += m.pnl;
      }
      categories.set(category, existing);
    });
    
    return Array.from(categories.entries())
      .map(([name, stats]) => ({ name, ...stats }))
      .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl))
      .slice(0, 4);
  }, [topWinners, topLosers]);

  const filteredTrades = useMemo(() => {
    if (filter === 'ALL') return recentTrades;
    return recentTrades.filter(t => t.market.toUpperCase().includes(filter));
  }, [recentTrades, filter]);

  const filteredPositions = useMemo(() => {
    if (filter === 'ALL') return openPositions;
    return openPositions.filter(p => p.market.toUpperCase().includes(filter));
  }, [openPositions, filter]);

  // Combine real-time activity
  const activityFeed = useMemo(() => {
    const items: Array<{
      id: string;
      type: 'order' | 'trade';
      side: string;
      size: number;
      price: number;
      status?: string;
      timestamp: string;
      market?: string;
    }> = [];
    
    recentOrders.forEach(o => {
      items.push({
        id: o.orderId,
        type: 'order',
        side: o.side,
        size: o.originalSize,
        price: o.price,
        status: o.status,
        timestamp: o.timestamp,
        market: o.market,
      });
    });
    
    ownTrades.forEach((t, i) => {
      items.push({
        id: `trade-${i}`,
        type: 'trade',
        side: t.side,
        size: t.size,
        price: t.price,
        timestamp: t.timestamp,
      });
    });
    
    return items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).slice(0, 20);
  }, [recentOrders, ownTrades]);

  return (
    <div className="min-h-screen bg-[#0d1117]">
      {/* Notification Toasts */}
      <div className="fixed top-4 right-4 z-50 space-y-2 w-96">
        {notifications.map(notif => (
          <NotificationToast 
            key={notif.id} 
            notification={notif} 
            onClose={() => removeNotification(notif.id)} 
          />
        ))}
      </div>

      {/* Header */}
      <header className="border-b border-slate-800 bg-[#161b22]">
        <div className="max-w-[1600px] mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <span className="text-slate-400">←</span>
                <h1 className="text-xl font-bold text-slate-100">PnL Tracker</h1>
              </div>
              
              {/* Connection Status */}
              <div className="flex items-center gap-2">
                {/* Market WS Status */}
                <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full ${
                  isConnected 
                    ? 'bg-emerald-500/10 border border-emerald-500/30' 
                    : 'bg-amber-500/10 border border-amber-500/30'
                }`}>
                  <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`} />
                  <span className={`text-xs font-medium ${isConnected ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {isConnected ? 'Live' : 'Connecting'}
                  </span>
                </div>
                
                {/* User WS Status */}
                {hasAuth && (
                  <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full ${
                    isUserConnected 
                      ? 'bg-blue-500/10 border border-blue-500/30' 
                      : 'bg-slate-700/50 border border-slate-600/30'
                  }`}>
                    <span className="text-lg">🔐</span>
                    <span className={`text-xs font-medium ${isUserConnected ? 'text-blue-400' : 'text-slate-500'}`}>
                      {isUserConnected ? 'Your Orders' : 'Auth Pending'}
                    </span>
                  </div>
                )}
              </div>
            </div>
            
            <div className="flex items-center gap-2">
              <a href="https://polymarket.com" target="_blank" rel="noopener" 
                className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors flex items-center gap-2">
                <span>↗</span> Polymarket
              </a>
              <button onClick={() => window.location.reload()} 
                className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors flex items-center gap-2">
                <span>↻</span> Refresh
              </button>
              <a href="/admin" 
                className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors flex items-center gap-2">
                <span>⚙</span> Settings
              </a>
            </div>
          </div>
        </div>
      </header>

      {/* Subtitle */}
      <div className="bg-[#161b22] border-b border-slate-800 px-4 py-2">
        <div className="max-w-[1600px] mx-auto">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <span className="text-emerald-500">↗</span>
              <span className="font-mono">{data.walletAddress.slice(0, 10)}...{data.walletAddress.slice(-8)}</span>
              <span>•</span>
              <span>{data.walletCount} wallet(s) tracked</span>
            </div>
            <div className="text-xs text-slate-600">
              {statusMessage}
            </div>
          </div>
        </div>
      </div>

      <main className="max-w-[1600px] mx-auto px-4 py-6 space-y-6">
        {/* Top Stats Row */}
        <div className="grid grid-cols-5 gap-4">
          <div className="bg-slate-800/60 rounded-xl p-5 border border-slate-700/50">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-2 h-2 rounded-full bg-slate-500" />
              <span className="text-xs text-slate-500 uppercase tracking-wider">Filled</span>
            </div>
            <div className="text-3xl font-bold text-slate-100">{summary.totalTrades}</div>
            <div className="text-xs text-cyan-400 mt-1">{summary.openPositions} live</div>
          </div>
          
          <div className="bg-emerald-900/20 rounded-xl p-5 border border-emerald-700/30">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-emerald-400">↗</span>
              <span className="text-xs text-slate-500 uppercase tracking-wider">Wins</span>
            </div>
            <div className="text-3xl font-bold text-emerald-400">{summary.winningPositions}</div>
          </div>
          
          <div className="bg-red-900/20 rounded-xl p-5 border border-red-700/30">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-red-400">×</span>
              <span className="text-xs text-slate-500 uppercase tracking-wider">Losses</span>
            </div>
            <div className="text-3xl font-bold text-red-400">{summary.losingPositions}</div>
          </div>
          
          <div className="bg-slate-800/60 rounded-xl p-5 border border-slate-700/50">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-slate-400">%</span>
              <span className="text-xs text-slate-500 uppercase tracking-wider">Win Rate</span>
            </div>
            <div className="text-3xl font-bold text-slate-100">{summary.winRate.toFixed(1)}%</div>
          </div>
          
          <div className={`rounded-xl p-5 border ${summary.totalPnl >= 0 ? 'bg-emerald-900/30 border-emerald-600/40' : 'bg-red-900/30 border-red-600/40'}`}>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-slate-400">$</span>
              <span className="text-xs text-slate-500 uppercase tracking-wider">Net P&L</span>
            </div>
            <div className={`text-3xl font-bold ${summary.totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {summary.totalPnl >= 0 ? '+' : ''}{formatUSD(summary.totalPnl)}
            </div>
          </div>
        </div>

        {/* Second Stats Row */}
        <div className="grid grid-cols-4 gap-4">
          <StatCard 
            label="$ Invested" 
            value={formatUSD(summary.totalVolume)}
            subValue={`ROI: ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`}
            color={roi >= 0 ? 'green' : 'red'}
          />
          <StatCard 
            label="Avg Bet Size" 
            value={formatUSD(avgBetSize)}
            subValue={`${summary.totalTrades} total bets`}
          />
          <StatCard 
            label="Avg Win" 
            value={`+${formatUSD(avgProfit)}`}
            subValue={`Over ${summary.winningPositions} wins`}
            color="green"
          />
          <StatCard 
            label="Avg Loss" 
            value={`-${formatUSD(avgLoss)}`}
            subValue={`Over ${summary.losingPositions} losses`}
            color="red"
          />
        </div>

        {/* Third Stats Row */}
        <div className="grid grid-cols-5 gap-4">
          <StatCard 
            label="Profit Factor" 
            value={profitFactor === Infinity ? '∞' : profitFactor.toFixed(2)}
            subValue={profitFactor >= 1 ? 'Profitable' : 'Unprofitable'}
            color={profitFactor >= 1 ? 'green' : 'red'}
          />
          <StatCard 
            label="Total Profit" 
            value={`+${formatUSD(summary.totalProfit)}`}
            color="green"
          />
          <StatCard 
            label="Total Loss" 
            value={`-${formatUSD(summary.totalLoss)}`}
            color="red"
          />
          <StatCard 
            label="Markets" 
            value={summary.uniqueMarkets}
            subValue="Unique markets"
            color="blue"
          />
          <StatCard 
            label="Open" 
            value={summary.openPositions}
            subValue={`${summary.closedPositions} closed`}
            color="yellow"
          />
        </div>

        {/* Performance Section */}
        <div className="bg-slate-800/40 rounded-xl border border-slate-700/50 p-6">
          <h2 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
            <span className="text-lg">📊</span> Performance by Market
          </h2>
          
          <div className="grid grid-cols-4 gap-4 mb-6">
            {topWinners.slice(0, 2).map((m, i) => (
              <div key={`win-${i}`} className="bg-slate-900/60 rounded-lg p-4 border border-emerald-700/30">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-slate-500 truncate flex-1">{m.market.slice(0, 30)}...</span>
                  <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400">
                    {m.trades} trades
                  </span>
                </div>
                <div className="text-xl font-bold text-emerald-400">+{formatUSD(m.pnl)}</div>
              </div>
            ))}
            {topLosers.slice(0, 2).map((m, i) => (
              <div key={`loss-${i}`} className="bg-slate-900/60 rounded-lg p-4 border border-red-700/30">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-slate-500 truncate flex-1">{m.market.slice(0, 30)}...</span>
                  <span className="text-xs px-2 py-0.5 rounded bg-red-500/20 text-red-400">
                    {m.trades} trades
                  </span>
                </div>
                <div className="text-xl font-bold text-red-400">{formatUSD(m.pnl)}</div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-4 gap-4">
            {marketCategories.map((cat, i) => (
              <AssetBar 
                key={i}
                asset={cat.name}
                wins={cat.wins}
                losses={cat.losses}
                pnl={cat.pnl}
              />
            ))}
            {marketCategories.length === 0 && (
              <div className="col-span-4 text-center text-slate-500 py-4">
                No market data available yet
              </div>
            )}
          </div>
        </div>

        {/* Activity / Trades Section */}
        <div className="bg-slate-800/40 rounded-xl border border-slate-700/50 overflow-hidden">
          {/* Tabs */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700/50">
            <div className="flex gap-2">
              {['ALL', ...marketCategories.slice(0, 4).map(c => c.name)].map(f => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-4 py-1.5 text-sm rounded-lg transition-colors ${
                    filter === f
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                      : 'text-slate-400 hover:bg-slate-700/50 border border-transparent'
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setActiveTab('activity')}
                className={`px-4 py-1.5 text-sm rounded-lg transition-colors flex items-center gap-2 ${
                  activeTab === 'activity'
                    ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30'
                    : 'text-slate-400 hover:bg-slate-700/50'
                }`}
              >
                {isUserConnected && <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />}
                Live Activity
              </button>
              <button
                onClick={() => setActiveTab('trades')}
                className={`px-4 py-1.5 text-sm rounded-lg transition-colors ${
                  activeTab === 'trades'
                    ? 'bg-slate-700 text-slate-200'
                    : 'text-slate-400 hover:bg-slate-700/50'
                }`}
              >
                All Trades
              </button>
              <button
                onClick={() => setActiveTab('positions')}
                className={`px-4 py-1.5 text-sm rounded-lg transition-colors ${
                  activeTab === 'positions'
                    ? 'bg-slate-700 text-slate-200'
                    : 'text-slate-400 hover:bg-slate-700/50'
                }`}
              >
                Positions
              </button>
            </div>
          </div>

          {/* Table Header */}
          <div className="grid grid-cols-8 gap-4 px-4 py-3 text-xs text-slate-500 uppercase tracking-wider border-b border-slate-700/50 bg-slate-900/30">
            <div className="col-span-3">{activeTab === 'activity' ? 'Activity' : 'Market'}</div>
            <div className="text-right">Shares</div>
            <div className="text-right">Price</div>
            <div className="text-right">Cost</div>
            <div className="text-center">{activeTab === 'activity' ? 'Status' : 'Side'}</div>
            <div className="text-right">P&L</div>
          </div>

          {/* Table Body */}
          <div className="max-h-[500px] overflow-y-auto">
            {activeTab === 'activity' ? (
              activityFeed.length === 0 ? (
                <div className="text-center text-slate-500 py-12">
                  <div className="text-4xl mb-4">📡</div>
                  <p className="font-medium">Waiting for live activity...</p>
                  <p className="text-sm mt-2">
                    {isUserConnected 
                      ? 'Place an order on Polymarket to see it here instantly!'
                      : hasAuth 
                        ? 'Connecting to your account...'
                        : 'Add API credentials in .env to see your orders'}
                  </p>
                </div>
              ) : (
                activityFeed.map((item) => (
                  <div 
                    key={item.id}
                    className="grid grid-cols-8 gap-4 px-4 py-3 text-sm border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors animate-fadeIn"
                  >
                    <div className="col-span-3 truncate flex items-center gap-2">
                      <span className="text-lg">{item.type === 'order' ? '📋' : '💰'}</span>
                      <span className="text-slate-200">
                        {item.market || `${item.type === 'order' ? 'Order' : 'Trade'}`}
                      </span>
                    </div>
                    <div className="text-right text-slate-300">{item.size.toFixed(2)}</div>
                    <div className="text-right text-slate-300">{(item.price * 100).toFixed(1)}¢</div>
                    <div className="text-right text-slate-300">${(item.size * item.price).toFixed(2)}</div>
                    <div className="text-center">
                      {item.status ? (
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                          item.status === 'MATCHED' ? 'bg-emerald-500/20 text-emerald-400'
                          : item.status === 'LIVE' ? 'bg-blue-500/20 text-blue-400'
                          : item.status === 'CANCELLED' ? 'bg-red-500/20 text-red-400'
                          : 'bg-slate-500/20 text-slate-400'
                        }`}>
                          {item.status}
                        </span>
                      ) : (
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                          item.side === 'BUY' 
                            ? 'bg-emerald-500/20 text-emerald-400' 
                            : 'bg-red-500/20 text-red-400'
                        }`}>
                          {item.side}
                        </span>
                      )}
                    </div>
                    <div className="text-right text-slate-500">
                      {new Date(item.timestamp).toLocaleTimeString()}
                    </div>
                  </div>
                ))
              )
            ) : activeTab === 'trades' ? (
              filteredTrades.length === 0 ? (
                <div className="text-center text-slate-500 py-12">No trades found</div>
              ) : (
                filteredTrades.map((trade) => (
                  <div 
                    key={trade.id}
                    className="grid grid-cols-8 gap-4 px-4 py-3 text-sm border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors"
                  >
                    <div className="col-span-3 truncate">
                      <span className="text-slate-200">{trade.market}</span>
                    </div>
                    <div className="text-right text-slate-300">{trade.size.toFixed(2)}</div>
                    <div className="text-right text-slate-300">{(trade.price * 100).toFixed(1)}¢</div>
                    <div className="text-right text-slate-300">${trade.cost.toFixed(2)}</div>
                    <div className="text-center">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                        trade.side === 'BUY' 
                          ? 'bg-emerald-500/20 text-emerald-400' 
                          : 'bg-red-500/20 text-red-400'
                      }`}>
                        {trade.side}
                      </span>
                    </div>
                    <div className="text-right text-slate-500">-</div>
                  </div>
                ))
              )
            ) : (
              filteredPositions.length === 0 ? (
                <div className="text-center text-slate-500 py-12">No open positions</div>
              ) : (
                filteredPositions.map((pos) => (
                  <div 
                    key={pos.id}
                    className="grid grid-cols-8 gap-4 px-4 py-3 text-sm border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors"
                  >
                    <div className="col-span-3 truncate">
                      <span className="text-slate-200">{pos.market}</span>
                    </div>
                    <div className="text-right text-slate-300">{pos.shares.toFixed(2)}</div>
                    <div className="text-right text-slate-300">{(pos.avgPrice * 100).toFixed(1)}¢</div>
                    <div className="text-right text-slate-300">${pos.currentValue.toFixed(2)}</div>
                    <div className="text-center">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                        pos.outcome === 0 
                          ? 'bg-emerald-500/20 text-emerald-400' 
                          : 'bg-amber-500/20 text-amber-400'
                      }`}>
                        {pos.outcome === 0 ? 'YES' : 'NO'}
                      </span>
                    </div>
                    <div className={`text-right font-medium ${formatPnlColor(pos.pnl)}`}>
                      {pos.pnl >= 0 ? '+' : ''}{formatUSD(pos.pnl)}
                    </div>
                  </div>
                ))
              )
            )}
          </div>

          {/* Footer */}
          <div className="px-4 py-3 text-sm text-slate-500 border-t border-slate-700/50 bg-slate-900/30 flex justify-between">
            <span>
              {activeTab === 'activity' 
                ? `${activityFeed.length} live updates`
                : activeTab === 'trades' 
                  ? `${filteredTrades.length} trades` 
                  : `${filteredPositions.length} positions`}
            </span>
            {latestOrder && (
              <span className="text-blue-400">
                Last order: {latestOrder.status} @ {new Date(latestOrder.timestamp).toLocaleTimeString()}
              </span>
            )}
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800 mt-8 bg-[#161b22]">
        <div className="max-w-[1600px] mx-auto px-4 py-4">
          <div className="flex items-center justify-between text-sm text-slate-500">
            <p>PnL Tracker • Polymarket Analytics Dashboard</p>
            <p className="flex items-center gap-2">
              {isUserConnected && <span className="text-blue-400">🔐 Authenticated</span>}
              Data synced from Polymarket
            </p>
          </div>
        </div>
      </footer>

      <style jsx>{`
        @keyframes slideIn {
          from {
            opacity: 0;
            transform: translateX(100px);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }
        .animate-slideIn {
          animation: slideIn 0.3s ease-out;
        }
        .animate-fadeIn {
          animation: fadeIn 0.3s ease-out;
        }
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `}</style>
    </div>
  );
}
