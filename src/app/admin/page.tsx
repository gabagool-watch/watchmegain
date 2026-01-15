'use client';

import { useState, useEffect } from 'react';
import { formatAddress, timeAgo } from '@/lib/utils';
import Link from 'next/link';

interface Wallet {
  id: string;
  address: string;
  alias?: string | null;
  createdAt: string;
}

interface SyncStatus {
  jobType: string;
  lastRunAt: string | null;
  lastSuccess: string | null;
  lastError: string | null;
  isRunning: boolean;
  itemsProcessed: number;
}

export default function AdminPage() {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus[]>([]);
  const [newAddress, setNewAddress] = useState('');
  const [newAlias, setNewAlias] = useState('');
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncingDataApi, setSyncingDataApi] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    fetchData();
  }, []);

  async function fetchData() {
    try {
      const [walletsRes, syncRes] = await Promise.all([
        fetch('/api/wallets'),
        fetch('/api/sync'),
      ]);

      if (walletsRes.ok) {
        setWallets(await walletsRes.json());
      }
      if (syncRes.ok) {
        setSyncStatus(await syncRes.json());
      }
    } catch (e) {
      console.error('Failed to fetch data:', e);
    } finally {
      setLoading(false);
    }
  }

  async function handleAddWallet(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    try {
      const res = await fetch('/api/wallets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: newAddress,
          alias: newAlias || undefined,
        }),
      });

      if (res.ok) {
        setNewAddress('');
        setNewAlias('');
        setSuccess('Wallet added successfully!');
        fetchData();
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to add wallet');
      }
    } catch (e) {
      setError('Failed to add wallet');
    }
  }

  async function handleDeleteWallet(id: string) {
    if (!confirm('Are you sure you want to delete this wallet?')) return;

    try {
      const res = await fetch(`/api/wallets/${id}`, {
        method: 'DELETE',
      });

      if (res.ok) {
        setSuccess('Wallet deleted');
        fetchData();
      } else {
        setError('Failed to delete wallet');
      }
    } catch (e) {
      setError('Failed to delete wallet');
    }
  }

  async function handleRunSync() {
    setSyncing(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await fetch('/api/sync/run', {
        method: 'POST',
      });

      if (res.ok) {
        const data = await res.json();
        const found = data.result?.tradesFound || 0;
        const newTrades = data.result?.tradesNew || 0;
        const duration = Math.round((data.result?.duration || 0) / 1000);
        setSuccess(`✅ Full sync completed in ${duration}s. Found ${found} trades, ${newTrades} new.`);
        fetchData();
      } else {
        const data = await res.json();
        setError(data.error || 'Sync failed');
      }
    } catch (e) {
      setError('Sync failed');
    } finally {
      setSyncing(false);
    }
  }

  async function handleDataApiSync() {
    setSyncingDataApi(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await fetch('/api/sync/dataapi', {
        method: 'POST',
      });

      if (res.ok) {
        const data = await res.json();
        const positions = data.positionsImported || 0;
        const pnl = data.totalCashPnl?.toFixed(2) || '0.00';
        const duration = Math.round(data.duration / 1000);
        setSuccess(`✅ Data API Sync completed in ${duration}s. ${positions} positions imported. Cash PnL: $${pnl}`);
        fetchData();
      } else {
        const data = await res.json();
        setError(data.error || 'Data API sync failed');
      }
    } catch (e) {
      setError('Data API sync failed');
    } finally {
      setSyncingDataApi(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-slate-400">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
      {/* Header */}
      <header className="border-b border-slate-800/50 bg-slate-900/50 backdrop-blur-sm">
        <div className="max-w-4xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link href="/" className="text-slate-400 hover:text-slate-200 transition-colors">
                ← Back to Dashboard
              </Link>
            </div>
            <h1 className="text-xl font-bold text-slate-200">Settings</h1>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8 space-y-8">
        {/* Messages */}
        {error && (
          <div className="rounded-xl bg-red-500/10 border border-red-500/30 p-4 text-red-400">
            {error}
          </div>
        )}
        {success && (
          <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 p-4 text-emerald-400">
            {success}
          </div>
        )}

        {/* Add Wallet Form */}
        <div className="rounded-2xl bg-slate-800/50 border border-slate-700/50 p-6">
          <h2 className="text-lg font-semibold text-slate-200 mb-4">
            Add Wallet to Track
          </h2>
          <form onSubmit={handleAddWallet} className="flex flex-col md:flex-row gap-4">
            <input
              type="text"
              placeholder="Wallet address (0x...)"
              value={newAddress}
              onChange={(e) => setNewAddress(e.target.value)}
              className="flex-1 px-4 py-3 rounded-xl bg-slate-900/50 border border-slate-700/50 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-emerald-500/50"
              required
              pattern="^0x[a-fA-F0-9]{40}$"
            />
            <input
              type="text"
              placeholder="Alias (optional)"
              value={newAlias}
              onChange={(e) => setNewAlias(e.target.value)}
              className="md:w-48 px-4 py-3 rounded-xl bg-slate-900/50 border border-slate-700/50 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-emerald-500/50"
            />
            <button 
              type="submit" 
              className="px-6 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-medium transition-colors"
            >
              Add Wallet
            </button>
          </form>
        </div>

        {/* Tracked Wallets */}
        <div className="rounded-2xl bg-slate-800/50 border border-slate-700/50 p-6">
          <h2 className="text-lg font-semibold text-slate-200 mb-4">
            Tracked Wallets ({wallets.length})
          </h2>
          <div className="space-y-3">
            {wallets.map((wallet) => (
              <div 
                key={wallet.id} 
                className="flex items-center justify-between p-4 rounded-xl bg-slate-900/50 border border-slate-700/50"
              >
                <div>
                  <p className="font-mono text-slate-300">
                    {formatAddress(wallet.address, 10)}
                  </p>
                  <p className="text-sm text-slate-500 mt-1">
                    {wallet.alias || 'No alias'} • Added {timeAgo(wallet.createdAt)}
                  </p>
                </div>
                <button
                  onClick={() => handleDeleteWallet(wallet.id)}
                  className="px-4 py-2 rounded-lg text-red-400 hover:bg-red-500/10 transition-colors"
                >
                  Delete
                </button>
              </div>
            ))}
            {wallets.length === 0 && (
              <div className="py-8 text-center text-slate-500">
                No wallets tracked yet. Add one above!
              </div>
            )}
          </div>
        </div>

        {/* Sync Controls */}
        <div className="rounded-2xl bg-slate-800/50 border border-slate-700/50 p-6">
          <h2 className="text-lg font-semibold text-slate-200 mb-4">
            Data Sync
          </h2>
          <div className="grid md:grid-cols-2 gap-4 mb-6">
            <button
              onClick={handleDataApiSync}
              disabled={syncingDataApi || syncing}
              className="p-6 rounded-xl bg-gradient-to-br from-emerald-600 to-emerald-700 hover:from-emerald-500 hover:to-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all text-left"
            >
              <div className="flex items-center gap-3 mb-2">
                <span className="text-2xl">⚡</span>
                <span className="font-semibold text-white">
                  {syncingDataApi ? 'Syncing...' : 'Quick Sync'}
                </span>
              </div>
              <p className="text-emerald-200/80 text-sm">
                Uses Polymarket Data API. Fast and accurate PnL.
              </p>
            </button>

            <button
              onClick={handleRunSync}
              disabled={syncing || syncingDataApi}
              className="p-6 rounded-xl bg-slate-700/50 hover:bg-slate-700 border border-slate-600/50 disabled:opacity-50 disabled:cursor-not-allowed transition-all text-left"
            >
              <div className="flex items-center gap-3 mb-2">
                <span className="text-2xl">🔗</span>
                <span className="font-semibold text-slate-200">
                  {syncing ? 'Syncing...' : 'Full Blockchain Sync'}
                </span>
              </div>
              <p className="text-slate-400 text-sm">
                Fetches all trades from Polygonscan. Slower but complete.
              </p>
            </button>
          </div>

          {/* Sync Status */}
          {syncStatus.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-slate-400 mb-3">Sync History</h3>
              {syncStatus.map((status) => (
                <div 
                  key={status.jobType}
                  className="flex items-center justify-between p-3 rounded-lg bg-slate-900/50"
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-2 h-2 rounded-full ${
                      status.isRunning ? 'bg-amber-500 animate-pulse' :
                      status.lastError ? 'bg-red-500' : 'bg-emerald-500'
                    }`} />
                    <span className="text-slate-300 text-sm">{status.jobType}</span>
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-slate-400">
                      {status.lastRunAt ? timeAgo(status.lastRunAt) : 'Never'}
                    </p>
                    <p className="text-xs text-slate-500">
                      {status.itemsProcessed} items
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Info */}
        <div className="rounded-2xl bg-amber-500/10 border border-amber-500/30 p-6">
          <h3 className="font-semibold text-amber-400 mb-2">💡 Tips</h3>
          <ul className="text-sm text-amber-300/80 space-y-1">
            <li>• Use <strong>Quick Sync</strong> for fast, accurate PnL from Polymarket</li>
            <li>• Use <strong>Full Sync</strong> only if you need complete trade history</li>
            <li>• The dashboard updates in real-time via WebSocket</li>
          </ul>
        </div>
      </main>
    </div>
  );
}
