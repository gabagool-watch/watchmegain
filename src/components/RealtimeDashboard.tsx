'use client';

import { useRealtime } from '@/hooks/useRealtime';
import { useEffect, useState } from 'react';

interface RealtimeDashboardProps {
  initialPnl: number;
  initialUnrealizedPnl: number;
}

export function RealtimeDashboard({ initialPnl, initialUnrealizedPnl }: RealtimeDashboardProps) {
  const { isConnected, statusMessage, prices, recentTrades } = useRealtime({
    enabled: true,
  });
  
  const [liveUnrealizedPnl, setLiveUnrealizedPnl] = useState(initialUnrealizedPnl);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  
  // Update unrealized PnL when prices change
  useEffect(() => {
    if (prices.size > 0) {
      // In a real implementation, we'd recalculate based on positions and new prices
      // For now, just show that prices are updating
      setLastUpdate(new Date());
    }
  }, [prices]);

  return (
    <div className="card bg-gradient-to-r from-surface-900 to-surface-800 border-primary-500/20">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div 
            className={`w-3 h-3 rounded-full ${
              isConnected 
                ? 'bg-green-500 animate-pulse shadow-lg shadow-green-500/50' 
                : 'bg-yellow-500 animate-pulse'
            }`}
          />
          <h2 className="text-lg font-semibold text-surface-100">
            {isConnected ? '🔴 Live Updates' : '⏳ Connecting...'}
          </h2>
        </div>
        <span className="text-xs text-surface-500">
          {statusMessage}
        </span>
      </div>
      
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div>
          <p className="text-xs text-surface-500 uppercase tracking-wider">Status</p>
          <p className={`text-lg font-bold ${isConnected ? 'text-green-400' : 'text-yellow-400'}`}>
            {isConnected ? 'Connected' : 'Connecting'}
          </p>
        </div>
        
        <div>
          <p className="text-xs text-surface-500 uppercase tracking-wider">Markets Tracked</p>
          <p className="text-lg font-bold text-surface-100">
            {prices.size}
          </p>
        </div>
        
        <div>
          <p className="text-xs text-surface-500 uppercase tracking-wider">Recent Trades</p>
          <p className="text-lg font-bold text-surface-100">
            {recentTrades.length}
          </p>
        </div>
        
        <div>
          <p className="text-xs text-surface-500 uppercase tracking-wider">Last Update</p>
          <p className="text-lg font-bold text-surface-100">
            {lastUpdate ? lastUpdate.toLocaleTimeString() : '-'}
          </p>
        </div>
      </div>
      
      {recentTrades.length > 0 && (
        <div className="mt-4 pt-4 border-t border-surface-700">
          <h3 className="text-sm font-medium text-surface-300 mb-2">
            Latest Trade
          </h3>
          <div className="flex items-center justify-between bg-surface-900/50 rounded px-3 py-2">
            <span className={recentTrades[0].side === 'BUY' ? 'text-green-400' : 'text-red-400'}>
              {recentTrades[0].side}
            </span>
            <span className="text-surface-300">
              {recentTrades[0].size.toFixed(2)} @ ${recentTrades[0].price.toFixed(4)}
            </span>
            <span className="text-surface-500 text-sm">
              {new Date(recentTrades[0].timestamp).toLocaleTimeString()}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
