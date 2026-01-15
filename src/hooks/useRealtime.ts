'use client';

import { useEffect, useState, useCallback, useRef } from 'react';

interface PriceUpdate {
  assetId: string;
  conditionId?: string;
  price: number;
  bestBid?: number;
  bestAsk?: number;
  timestamp: string;
}

interface TradeUpdate {
  assetId: string;
  conditionId?: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  timestamp: string;
  isOwn?: boolean;
}

interface OrderUpdate {
  orderId: string;
  assetId: string;
  conditionId?: string;
  side: 'BUY' | 'SELL';
  status: 'LIVE' | 'MATCHED' | 'CANCELLED' | 'EXPIRED';
  originalSize: number;
  sizeMatched: number;
  price: number;
  timestamp: string;
  market?: string;
  outcome?: string;
}

interface StatusUpdate {
  connected: boolean;
  userConnected?: boolean;
  message: string;
  markets?: number;
  hasAuth?: boolean;
}

interface UseRealtimeOptions {
  walletAddress?: string;
  onPrice?: (update: PriceUpdate) => void;
  onTrade?: (update: TradeUpdate) => void;
  onOrder?: (update: OrderUpdate) => void;
  onUserTrade?: (update: TradeUpdate) => void;
  enabled?: boolean;
}

export function useRealtime(options: UseRealtimeOptions = {}) {
  const { walletAddress, onPrice, onTrade, onOrder, onUserTrade, enabled = true } = options;
  
  const [isConnected, setIsConnected] = useState(false);
  const [isUserConnected, setIsUserConnected] = useState(false);
  const [hasAuth, setHasAuth] = useState(false);
  const [statusMessage, setStatusMessage] = useState('Loading...');
  const [prices, setPrices] = useState<Map<string, PriceUpdate>>(new Map());
  const [recentTrades, setRecentTrades] = useState<TradeUpdate[]>([]);
  const [recentOrders, setRecentOrders] = useState<OrderUpdate[]>([]);
  const [ownTrades, setOwnTrades] = useState<TradeUpdate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ordersLoaded, setOrdersLoaded] = useState(false);
  
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttempts = useRef(0);
  
  // Fetch open orders from API on mount
  const fetchOrders = useCallback(async () => {
    try {
      console.log('📋 Fetching open orders from API...');
      const response = await fetch('/api/orders');
      
      if (!response.ok) {
        const data = await response.json();
        console.log('Orders API response:', data);
        if (response.status === 400 && data.error?.includes('credentials')) {
          setHasAuth(false);
        }
        return;
      }
      
      const data = await response.json();
      console.log(`✅ Loaded ${data.total} open orders from API`);
      setHasAuth(true);
      
      // Convert API orders to OrderUpdate format
      const orders: OrderUpdate[] = data.orders.map((o: {
        id: string;
        assetId: string;
        side: 'BUY' | 'SELL';
        status: string;
        originalSize: number;
        sizeMatched: number;
        price: number;
        createdAt: string;
        market: string;
        outcome?: string;
      }) => ({
        orderId: o.id,
        assetId: o.assetId,
        side: o.side,
        status: o.status as 'LIVE' | 'MATCHED' | 'CANCELLED' | 'EXPIRED',
        originalSize: o.originalSize,
        sizeMatched: o.sizeMatched,
        price: o.price,
        timestamp: o.createdAt,
        market: o.market,
        outcome: o.outcome,
      }));
      
      setRecentOrders(orders);
      setOrdersLoaded(true);
    } catch (e) {
      console.error('Failed to fetch orders:', e);
    }
  }, []);
  
  const connect = useCallback(() => {
    if (!enabled) return;
    
    // Prevent multiple simultaneous connections
    if (eventSourceRef.current) {
      console.log('Already connected, skipping...');
      return;
    }
    
    // Build URL with optional wallet filter
    let url = '/api/realtime';
    if (walletAddress) {
      url += `?wallet=${encodeURIComponent(walletAddress)}`;
    }
    
    console.log('🔌 Connecting to real-time updates...');
    
    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;
    
    eventSource.onopen = () => {
      console.log('✅ SSE connection opened');
      reconnectAttempts.current = 0;
    };
    
    // Status updates
    eventSource.addEventListener('status', (event) => {
      const data: StatusUpdate = JSON.parse(event.data);
      setIsConnected(data.connected);
      setIsUserConnected(data.userConnected || false);
      setHasAuth(data.hasAuth || false);
      setStatusMessage(data.message);
      setError(null);
    });
    
    // Price updates
    eventSource.addEventListener('price', (event) => {
      const update: PriceUpdate = JSON.parse(event.data);
      
      setPrices(prev => {
        const next = new Map(prev);
        next.set(update.conditionId || update.assetId, update);
        return next;
      });
      
      onPrice?.(update);
    });
    
    // All market trades
    eventSource.addEventListener('trade', (event) => {
      const update: TradeUpdate = JSON.parse(event.data);
      
      setRecentTrades(prev => {
        const next = [update, ...prev].slice(0, 50);
        return next;
      });
      
      onTrade?.(update);
    });
    
    // Your order updates
    eventSource.addEventListener('order', (event) => {
      const update: OrderUpdate = JSON.parse(event.data);
      console.log('🔔 Order update received:', update.status, update.side, update.originalSize);
      
      setRecentOrders(prev => {
        // Update existing order or add new one
        const existing = prev.findIndex(o => o.orderId === update.orderId);
        if (existing >= 0) {
          const next = [...prev];
          next[existing] = update;
          return next;
        }
        return [update, ...prev].slice(0, 50);
      });
      
      onOrder?.(update);
    });
    
    // Your trade fills
    eventSource.addEventListener('user_trade', (event) => {
      const update: TradeUpdate = JSON.parse(event.data);
      console.log('💰 Own trade filled:', update.side, update.size, '@', update.price);
      
      setOwnTrades(prev => {
        const next = [update, ...prev].slice(0, 50);
        return next;
      });
      
      onUserTrade?.(update);
    });
    
    // Error handling
    eventSource.addEventListener('error', (event) => {
      if (event instanceof MessageEvent) {
        const data = JSON.parse(event.data);
        setError(data.message);
      }
    });
    
    // Heartbeat
    eventSource.addEventListener('heartbeat', () => {
      // Keep-alive, no action needed
    });
    
    // Connection error
    eventSource.onerror = () => {
      console.log('❌ SSE connection error');
      setIsConnected(false);
      setIsUserConnected(false);
      setStatusMessage('Connection lost');
      
      eventSource.close();
      eventSourceRef.current = null;
      
      // In dev mode, don't reconnect aggressively to avoid spam
      // The connection tends to close due to HMR
      if (reconnectAttempts.current < 3) {
        reconnectAttempts.current++;
        const delay = Math.min(5000 * reconnectAttempts.current, 30000);
        
        console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts.current})...`);
        reconnectTimeoutRef.current = setTimeout(connect, delay);
      } else {
        setStatusMessage('Connection failed - refresh to retry');
      }
    };
  }, [enabled, walletAddress, onPrice, onTrade, onOrder, onUserTrade]);
  
  const disconnect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    
    setIsConnected(false);
    setIsUserConnected(false);
    setStatusMessage('Disconnected');
  }, []);
  
  useEffect(() => {
    if (enabled) {
      // First load orders from API, then try to connect for real-time updates
      fetchOrders();
      connect();
    }
    
    return () => {
      disconnect();
    };
  }, [enabled, connect, disconnect, fetchOrders]);
  
  // Get price for a specific market
  const getPrice = useCallback((conditionId: string): number | null => {
    const update = prices.get(conditionId);
    return update?.price ?? null;
  }, [prices]);
  
  // Get latest order for display
  const latestOrder = recentOrders[0] || null;
  const latestOwnTrade = ownTrades[0] || null;
  
  return {
    // Connection status
    isConnected,
    isUserConnected,
    hasAuth,
    statusMessage,
    error,
    ordersLoaded,
    
    // Data
    prices,
    recentTrades,
    recentOrders,
    ownTrades,
    latestOrder,
    latestOwnTrade,
    
    // Helpers
    getPrice,
    connect,
    disconnect,
    refreshOrders: fetchOrders,
  };
}
