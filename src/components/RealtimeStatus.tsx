'use client';

import { useRealtime } from '@/hooks/useRealtime';

interface RealtimeStatusProps {
  walletAddress?: string;
  showTrades?: boolean;
}

export function RealtimeStatus({ walletAddress, showTrades = false }: RealtimeStatusProps) {
  const { isConnected, statusMessage, recentTrades, error } = useRealtime({
    walletAddress,
    enabled: true,
  });

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-surface-100">
          Real-time Status
        </h2>
        <div className="flex items-center gap-2">
          <div 
            className={`w-3 h-3 rounded-full ${
              isConnected 
                ? 'bg-green-500 animate-pulse' 
                : 'bg-red-500'
            }`}
          />
          <span className={`text-sm ${isConnected ? 'text-green-400' : 'text-red-400'}`}>
            {isConnected ? 'Live' : 'Disconnected'}
          </span>
        </div>
      </div>
      
      <p className="text-surface-400 text-sm mb-4">
        {statusMessage}
      </p>
      
      {error && (
        <div className="text-red-400 text-sm mb-4">
          Error: {error}
        </div>
      )}
      
      {showTrades && recentTrades.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-medium text-surface-300 mb-2">
            Recent Trades
          </h3>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {recentTrades.slice(0, 10).map((trade, i) => (
              <div 
                key={`${trade.timestamp}-${i}`}
                className="flex items-center justify-between text-xs bg-surface-900/50 rounded px-3 py-2"
              >
                <span className={trade.side === 'BUY' ? 'text-green-400' : 'text-red-400'}>
                  {trade.side}
                </span>
                <span className="text-surface-300">
                  {trade.size.toFixed(2)} @ ${trade.price.toFixed(2)}
                </span>
                <span className="text-surface-500">
                  {new Date(trade.timestamp).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
