'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import {
  Activity,
  AlertTriangle,
  ArrowUpDown,
  BarChart3,
  CheckSquare,
  Clock,
  ExternalLink,
  Filter,
  History,
  LogOut,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  Wallet,
  Zap,
} from 'lucide-react';
import {
  DestinationAsset,
  DestinationSymbol,
  DiscoveredTokenAsset,
  PlatformAnalyticsSummary,
} from '@/types/vacuum';
import { DUST_PRESET_THRESHOLDS } from '@/lib/config';
import { VacuumLogo, DestinationTokenIcon } from '@/components/VacuumLogo';
import { useVacuumNetwork } from '@/components/SolanaWalletProvider';
import { SweepReviewModal } from '@/components/SweepReviewModal';
import { WalletDiscoveryResult } from '@/services/tokenDiscoveryService';

interface SweepDashboardProps {
  onBackToLanding: () => void;
}

export function SweepDashboard({ onBackToLanding }: SweepDashboardProps) {
  const { publicKey, connected, disconnect } = useWallet();
  const { setVisible: setWalletModalVisible } = useWalletModal();
  const { network, setNetwork, mode, setMode } = useVacuumNetwork();

  const [activeTab, setActiveTab] = useState<'ASSETS' | 'HISTORY' | 'ANALYTICS'>('ASSETS');
  const [dustThresholdUsd, setDustThresholdUsd] = useState<number>(5.0);
  const [customThresholdInput, setCustomThresholdInput] = useState<string>('5.00');
  const [destinationSymbol, setDestinationSymbol] = useState<DestinationSymbol>('VACUUM');
  const [destinations, setDestinations] = useState<DestinationAsset[]>([]);
  const [discovery, setDiscovery] = useState<WalletDiscoveryResult | null>(null);
  const [analytics, setAnalytics] = useState<PlatformAnalyticsSummary | null>(null);
  const [selectedAccounts, setSelectedAccounts] = useState<Set<string>>(new Set());
  const [isLoadingScan, setIsLoadingScan] = useState<boolean>(false);
  const [scanError, setScanError] = useState<string | null>(null);

  // Table filter & sort states
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [categoryFilter, setCategoryFilter] = useState<
    'ALL' | 'ELIGIBLE_DUST' | 'VALUABLE' | 'UNROUTABLE_OR_RISKY'
  >('ALL');
  const [sortField, setSortField] = useState<'NET_RECOVERY' | 'VALUE_USD' | 'SYMBOL'>(
    'NET_RECOVERY'
  );
  const [isReviewModalOpen, setIsReviewModalOpen] = useState<boolean>(false);

  const activeWalletAddress = useMemo(() => {
    if (mode === 'demo') {
      return 'DemoWa11etVacuumSweeperPreview1111111111111';
    }
    return publicKey ? publicKey.toBase58() : '';
  }, [mode, publicKey]);

  // Fetch platform status & destinations
  const fetchPlatformStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/status?network=${network}`);
      const data = await res.json();
      if (data.ok && Array.isArray(data.destinations)) {
        setDestinations(data.destinations);
        const vacDest = data.destinations.find(
          (d: DestinationAsset) => d.symbol === 'VACUUM'
        );
        // If in live mode and $VACUUM mint is not yet configured, default to SOL while keeping $VACUUM visible
        if (mode === 'live' && vacDest && !vacDest.isConfiguredForNetwork) {
          setDestinationSymbol((prev) => (prev === 'VACUUM' ? 'SOL' : prev));
        }
      }
    } catch {
      // Non-fatal
    }
  }, [network, mode]);

  // Scan wallet assets
  const scanWallet = useCallback(
    async (overrideThreshold?: number) => {
      if (mode === 'live' && !activeWalletAddress) {
        setDiscovery(null);
        return;
      }

      setIsLoadingScan(true);
      setScanError(null);
      const effectiveThreshold = overrideThreshold ?? dustThresholdUsd;

      try {
        const res = await fetch('/api/discover', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            walletAddress: activeWalletAddress,
            network,
            mode,
            maxUsdValue: effectiveThreshold,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || 'Failed to scan wallet token accounts');
        }

        const disc: WalletDiscoveryResult = data.discovery;
        setDiscovery(disc);

        // Automatically select all recoverable dust assets that are safe to sweep
        const autoSelected = new Set<string>();
        for (const a of disc.assets) {
          if (a.isRecoverableDust && a.risk.canSweepSafely && !a.risk.requiresUserAcknowledgement) {
            autoSelected.add(a.tokenAccountAddress);
          }
        }
        setSelectedAccounts(autoSelected);
      } catch (err) {
        setScanError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsLoadingScan(false);
      }
    },
    [mode, activeWalletAddress, network, dustThresholdUsd]
  );

  // Fetch historical analytics
  const fetchHistoryAndAnalytics = useCallback(async () => {
    try {
      const query = activeWalletAddress
        ? `?walletAddress=${encodeURIComponent(activeWalletAddress)}`
        : '';
      const res = await fetch(`/api/history${query}`);
      const data = await res.json();
      if (data.ok && data.analytics) {
        setAnalytics(data.analytics);
      }
    } catch {
      // Non-fatal
    }
  }, [activeWalletAddress]);

  useEffect(() => {
    fetchPlatformStatus();
    scanWallet();
    fetchHistoryAndAnalytics();
  }, [fetchPlatformStatus, scanWallet, fetchHistoryAndAnalytics]);

  // Filtered and sorted assets
  const filteredAssets = useMemo(() => {
    if (!discovery) return [];
    return discovery.assets
      .filter((a) => {
        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase();
          const match =
            a.symbol.toLowerCase().includes(q) ||
            a.name.toLowerCase().includes(q) ||
            a.mintAddress.toLowerCase().includes(q);
          if (!match) return false;
        }
        if (categoryFilter === 'ELIGIBLE_DUST') return a.isRecoverableDust;
        if (categoryFilter === 'VALUABLE')
          return a.category === 'VALUABLE_ESTABLISHED' || a.category === 'SMALL_BALANCE';
        if (categoryFilter === 'UNROUTABLE_OR_RISKY')
          return (
            a.category === 'NO_VIABLE_ROUTE' ||
            a.category === 'INSUFFICIENT_LIQUIDITY' ||
            a.category === 'SUSPICIOUS_UNSUPPORTED' ||
            a.category === 'REQUIRES_INSPECTION'
          );
        return true;
      })
      .sort((a, b) => {
        if (sortField === 'NET_RECOVERY') {
          return b.estimatedNetRecoveryUsd - a.estimatedNetRecoveryUsd;
        }
        if (sortField === 'VALUE_USD') {
          return (b.estimatedValueUsd ?? 0) - (a.estimatedValueUsd ?? 0);
        }
        return a.symbol.localeCompare(b.symbol);
      });
  }, [discovery, searchQuery, categoryFilter, sortField]);

  const selectedAssetObjects = useMemo(() => {
    if (!discovery) return [];
    return discovery.assets.filter((a) => selectedAccounts.has(a.tokenAccountAddress));
  }, [discovery, selectedAccounts]);

  const handleSelectAllEligible = () => {
    if (!discovery) return;
    const next = new Set<string>();
    for (const a of discovery.assets) {
      if (a.isRecoverableDust && a.risk.canSweepSafely) {
        next.add(a.tokenAccountAddress);
      }
    }
    setSelectedAccounts(next);
  };

  const handleDeselectAll = () => {
    setSelectedAccounts(new Set());
  };

  const toggleAssetSelection = (asset: DiscoveredTokenAsset) => {
    if (!asset.risk.canSweepSafely || !asset.hasViableRoute) return;
    const next = new Set(selectedAccounts);
    if (next.has(asset.tokenAccountAddress)) {
      next.delete(asset.tokenAccountAddress);
    } else {
      next.add(asset.tokenAccountAddress);
    }
    setSelectedAccounts(next);
  };

  return (
    <div className="min-h-screen bg-obsidian-950 text-slate-100">
      {/* Top Ambient Glow */}
      <div className="pointer-events-none fixed inset-x-0 top-0 h-96 bg-vortex-radial opacity-75 z-0" />

      {/* Top Application Header */}
      <header className="sticky top-0 z-30 border-b border-obsidian-800 bg-obsidian-950/85 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-20 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <button
              onClick={onBackToLanding}
              className="flex items-center gap-2.5 text-left group"
            >
              <VacuumLogo size={36} />
              <div>
                <div className="text-lg font-bold text-white group-hover:text-cyan-300 transition">
                  VACUUM
                </div>
                <div className="text-[10px] font-mono text-slate-400 uppercase tracking-wider">
                  Dust Sweeper Terminal
                </div>
              </div>
            </button>
          </div>

          {/* Network, Mode, and Wallet Controls */}
          <div className="flex flex-wrap items-center gap-2.5">
            {/* Network Switcher — Never silently submit mainnet when user expects devnet */}
            <div className="inline-flex items-center rounded-xl bg-obsidian-900 border border-obsidian-700 p-1">
              <button
                onClick={() => setNetwork('devnet')}
                className={`px-3 py-1.5 rounded-lg text-xs font-mono font-semibold transition ${
                  network === 'devnet'
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                DEVNET
              </button>
              <button
                onClick={() => setNetwork('mainnet-beta')}
                className={`px-3 py-1.5 rounded-lg text-xs font-mono font-semibold transition ${
                  network === 'mainnet-beta'
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                MAINNET-BETA
              </button>
            </div>

            {/* Live vs Explicit Demo Mode Switcher */}
            <div className="inline-flex items-center rounded-xl bg-obsidian-900 border border-obsidian-700 p-1">
              <button
                onClick={() => setMode('live')}
                className={`px-3 py-1.5 rounded-lg text-xs font-mono font-semibold transition ${
                  mode === 'live'
                    ? 'bg-ultraviolet-600 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                LIVE MODE
              </button>
              <button
                onClick={() => setMode('demo')}
                className={`px-3 py-1.5 rounded-lg text-xs font-mono font-semibold transition ${
                  mode === 'demo'
                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                DEMO DATA
              </button>
            </div>

            {/* Solana Wallet Connection Button */}
            {connected && publicKey ? (
              <div className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-obsidian-900 border border-obsidian-700 text-xs font-mono">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-white font-semibold">
                  {publicKey.toBase58().slice(0, 4)}...{publicKey.toBase58().slice(-4)}
                </span>
                {discovery && mode === 'live' && (
                  <span className="text-cyan-400 border-l border-obsidian-700 pl-2">
                    {discovery.nativeSolBalance.toFixed(4)} SOL
                  </span>
                )}
                <button
                  onClick={() => disconnect()}
                  className="text-slate-400 hover:text-rose-400 ml-1"
                  title="Disconnect Wallet"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => setWalletModalVisible(true)}
                className="px-4 py-2 rounded-xl bg-gradient-to-r from-ultraviolet-600 to-cyan-500 hover:from-ultraviolet-500 hover:to-cyan-400 text-white text-xs font-semibold flex items-center gap-2 shadow-lg shadow-ultraviolet-600/20 transition"
              >
                <Wallet className="w-3.5 h-3.5" />
                <span>CONNECT WALLET</span>
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Demo Mode Explicit Banner */}
      {mode === 'demo' && (
        <div className="bg-amber-500/10 border-b border-amber-500/30 px-4 py-2.5 text-center text-xs text-amber-200 flex items-center justify-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
          <span>
            <strong>DEMO MODE ACTIVE:</strong> Displaying sample wallet dust data for product
            exploration. Switch to <strong>LIVE MODE</strong> and connect a Solana wallet to scan
            and sweep real blockchain balances.
          </span>
        </div>
      )}

      <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        {/* SECTION 4: 5 DASHBOARD OVERVIEW CARDS */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          <div className="p-5 rounded-2xl bg-obsidian-900/90 border border-obsidian-800 space-y-1.5">
            <div className="text-[11px] font-mono uppercase tracking-wider text-slate-400">
              TOTAL WALLET VALUE
            </div>
            <div className="text-2xl font-extrabold text-white font-mono">
              ${discovery ? discovery.summary.totalWalletValueUsd.toFixed(2) : '0.00'}
            </div>
            <div className="text-xs text-slate-400">
              {mode === 'demo' ? 'Explicit Demo Portfolio' : `${discovery?.summary.totalAccountsCount ?? 0} Token Accounts`}
            </div>
          </div>

          <div className="p-5 rounded-2xl bg-obsidian-900/90 border border-cyan-500/30 space-y-1.5">
            <div className="text-[11px] font-mono uppercase tracking-wider text-cyan-400">
              RECOVERABLE DUST
            </div>
            <div className="text-2xl font-extrabold text-emerald-400 font-mono">
              ${discovery ? discovery.summary.recoverableDustValueUsd.toFixed(2) : '0.00'}
            </div>
            <div className="text-xs text-slate-400">
              Potential Dust: ${discovery ? discovery.summary.potentialDustValueUsd.toFixed(2) : '0.00'} (incl. +${discovery ? discovery.summary.reclaimableRentUsd.toFixed(2) : '0.00'} rent)
            </div>
          </div>

          <div className="p-5 rounded-2xl bg-obsidian-900/90 border border-obsidian-800 space-y-1.5">
            <div className="text-[11px] font-mono uppercase tracking-wider text-slate-400">
              ELIGIBLE TOKENS
            </div>
            <div className="text-2xl font-extrabold text-white font-mono">
              {discovery ? discovery.summary.eligibleTokensCount : 0}
            </div>
            <div className="text-xs text-cyan-400">
              {selectedAccounts.size} currently selected for sweep
            </div>
          </div>

          <div className="p-5 rounded-2xl bg-obsidian-900/90 border border-obsidian-800 space-y-1.5">
            <div className="text-[11px] font-mono uppercase tracking-wider text-slate-400">
              TOTAL VALUE SWEPT
            </div>
            <div className="text-2xl font-extrabold text-white font-mono">
              ${analytics ? analytics.totalValueSweptUsd.toFixed(2) : '0.00'}
            </div>
            <div className="text-xs text-slate-400">
              Across {analytics ? analytics.totalSuccessfulSweeps : 0} verified sessions
            </div>
          </div>

          <div className="p-5 rounded-2xl bg-obsidian-900/90 border border-ultraviolet-500/40 space-y-1.5">
            <div className="text-[11px] font-mono uppercase tracking-wider text-ultraviolet-300">
              VACUUM ACQUIRED
            </div>
            <div className="text-2xl font-extrabold text-white font-mono flex items-center gap-1.5">
              <span>{analytics ? analytics.totalVacuumAcquiredUi.toLocaleString() : '0'}</span>
              <span className="text-xs text-ultraviolet-400 font-semibold">$VACUUM</span>
            </div>
            <div className="text-xs text-slate-400">
              Historical consolidated balance
            </div>
          </div>
        </div>

        {/* FLAGSHIP ACTION BAR & DESTINATION SELECTOR */}
        <div className="p-6 rounded-2xl bg-gradient-to-r from-obsidian-900 via-obsidian-900 to-obsidian-850 border border-obsidian-700/90 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
          <div className="space-y-2">
            <div className="text-xs font-mono uppercase text-cyan-400 flex items-center gap-2">
              <Zap className="w-3.5 h-3.5" />
              <span>SMART MERGER & CONSOLIDATION TARGET</span>
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              {destinations.map((dest) => {
                const isSelected = destinationSymbol === dest.symbol;
                return (
                  <button
                    key={dest.symbol}
                    onClick={() => setDestinationSymbol(dest.symbol)}
                    className={`px-4 py-2.5 rounded-xl border text-left flex items-center gap-2.5 transition ${
                      isSelected
                        ? 'bg-ultraviolet-600/20 border-ultraviolet-500 text-white shadow-lg shadow-ultraviolet-600/15'
                        : 'bg-obsidian-950 border-obsidian-800 text-slate-300 hover:border-obsidian-700'
                    }`}
                  >
                    <DestinationTokenIcon symbol={dest.symbol} size={24} />
                    <div>
                      <div className="text-xs font-bold flex items-center gap-1.5">
                        <span>${dest.symbol}</span>
                        {dest.badgeText && (
                          <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-obsidian-800 text-cyan-300">
                            {dest.badgeText}
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-slate-400">
                        {dest.symbol === 'VACUUM' && !dest.isConfiguredForNetwork && mode === 'live'
                          ? 'Pending Official Mint Config'
                          : dest.name}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Primary Action: SWEEP MY WALLET + Secondary Actions */}
          <div className="flex flex-wrap items-center gap-3 w-full lg:w-auto justify-end">
            <button
              onClick={() => scanWallet()}
              disabled={isLoadingScan}
              className="px-4 py-3.5 rounded-xl bg-obsidian-850 hover:bg-obsidian-800 border border-obsidian-700 text-xs font-mono font-semibold text-slate-200 flex items-center gap-2 transition"
            >
              <RefreshCw className={`w-4 h-4 ${isLoadingScan ? 'animate-spin text-cyan-400' : ''}`} />
              <span>Scan Wallet</span>
            </button>

            <button
              onClick={() => setActiveTab('ASSETS')}
              className={`px-4 py-3.5 rounded-xl border text-xs font-mono font-semibold transition ${
                activeTab === 'ASSETS'
                  ? 'bg-obsidian-800 border-cyan-500/40 text-cyan-300'
                  : 'bg-obsidian-900 border-obsidian-800 text-slate-300 hover:text-white'
              }`}
            >
              View Assets
            </button>

            <button
              onClick={() => setActiveTab('HISTORY')}
              className={`px-4 py-3.5 rounded-xl border text-xs font-mono font-semibold flex items-center gap-1.5 transition ${
                activeTab === 'HISTORY'
                  ? 'bg-obsidian-800 border-cyan-500/40 text-cyan-300'
                  : 'bg-obsidian-900 border-obsidian-800 text-slate-300 hover:text-white'
              }`}
            >
              <History className="w-3.5 h-3.5" />
              <span>Transaction History</span>
            </button>

            <button
              onClick={() => setActiveTab('ANALYTICS')}
              className={`px-4 py-3.5 rounded-xl border text-xs font-mono font-semibold flex items-center gap-1.5 transition ${
                activeTab === 'ANALYTICS'
                  ? 'bg-obsidian-800 border-cyan-500/40 text-cyan-300'
                  : 'bg-obsidian-900 border-obsidian-800 text-slate-300 hover:text-white'
              }`}
            >
              <BarChart3 className="w-3.5 h-3.5" />
              <span>Analytics & Ecosystem</span>
            </button>

            <button
              disabled={selectedAssetObjects.length === 0}
              onClick={() => setIsReviewModalOpen(true)}
              className="px-7 py-3.5 rounded-xl bg-gradient-to-r from-ultraviolet-600 to-cyan-500 hover:from-ultraviolet-500 hover:to-cyan-400 disabled:opacity-40 text-white font-bold text-sm shadow-xl shadow-ultraviolet-600/30 flex items-center gap-2.5 transition"
            >
              <Sparkles className="w-4 h-4" />
              <span>SWEEP MY WALLET ({selectedAssetObjects.length})</span>
            </button>
          </div>
        </div>

        {/* Prompt to Connect Wallet when in Live Mode with no wallet connected */}
        {mode === 'live' && !connected && (
          <div className="p-10 rounded-2xl bg-obsidian-900 border border-obsidian-800 text-center space-y-4">
            <Wallet className="w-10 h-10 text-ultraviolet-400 mx-auto" />
            <h3 className="text-xl font-bold text-white">
              Connect Your Solana Wallet for Live Asset Discovery
            </h3>
            <p className="text-xs sm:text-sm text-slate-400 max-w-lg mx-auto">
              Connect Phantom, Solflare, or any Solana Wallet Standard wallet to scan real SPL and
              Token-2022 balances on <strong>{network.toUpperCase()}</strong>, or click{' '}
              <strong>DEMO DATA</strong> above to explore with sample dust accounts.
            </p>
            <div className="flex items-center justify-center gap-3 pt-2">
              <button
                onClick={() => setWalletModalVisible(true)}
                className="px-6 py-3 rounded-xl bg-gradient-to-r from-ultraviolet-600 to-cyan-500 text-white text-xs font-semibold"
              >
                CONNECT WALLET
              </button>
              <button
                onClick={() => setMode('demo')}
                className="px-6 py-3 rounded-xl bg-obsidian-800 border border-obsidian-700 text-slate-200 text-xs font-semibold"
              >
                EXPLORE DEMO DATA
              </button>
            </div>
          </div>
        )}

        {/* TAB 1: ASSET DISCOVERY TABLE & DUST THRESHOLD BAR */}
        {activeTab === 'ASSETS' && (mode === 'demo' || connected) && (
          <div className="space-y-4">
            {/* Configurable Dust Threshold & Filter Bar */}
            <div className="p-4 rounded-2xl bg-obsidian-900 border border-obsidian-800 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-mono uppercase text-slate-400 flex items-center gap-1.5 mr-1">
                  <SlidersHorizontal className="w-3.5 h-3.5 text-ultraviolet-400" />
                  Dust Threshold:
                </span>
                {DUST_PRESET_THRESHOLDS.map((preset) => (
                  <button
                    key={preset}
                    onClick={() => {
                      setDustThresholdUsd(preset);
                      setCustomThresholdInput(preset.toFixed(2));
                      scanWallet(preset);
                    }}
                    className={`px-2.5 py-1 rounded-lg text-xs font-mono transition ${
                      dustThresholdUsd === preset
                        ? 'bg-ultraviolet-600 text-white font-semibold'
                        : 'bg-obsidian-850 text-slate-300 hover:bg-obsidian-800'
                    }`}
                  >
                    Under ${preset.toFixed(2)}
                  </button>
                ))}

                <div className="flex items-center gap-1 ml-1">
                  <span className="text-xs font-mono text-slate-400">Custom $:</span>
                  <input
                    type="number"
                    step="0.1"
                    min="0.01"
                    value={customThresholdInput}
                    onChange={(e) => setCustomThresholdInput(e.target.value)}
                    onBlur={() => {
                      const val = Number(customThresholdInput);
                      if (!Number.isNaN(val) && val > 0) {
                        setDustThresholdUsd(val);
                        scanWallet(val);
                      }
                    }}
                    className="w-20 px-2 py-1 rounded-lg bg-obsidian-950 border border-obsidian-700 text-xs font-mono text-white"
                  />
                </div>
              </div>

              {/* Search, Category Filter, Sort, Select All / Deselect All */}
              <div className="flex flex-wrap items-center gap-2.5 w-full lg:w-auto">
                <div className="relative flex-1 sm:w-52">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    placeholder="Search symbol or mint..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-8 pr-3 py-1.5 rounded-xl bg-obsidian-950 border border-obsidian-700 text-xs text-white placeholder-slate-500"
                  />
                </div>

                <div className="flex items-center gap-1">
                  <Filter className="w-3.5 h-3.5 text-slate-400" />
                  <select
                    value={categoryFilter}
                    onChange={(e) =>
                      setCategoryFilter(
                        e.target.value as
                          | 'ALL'
                          | 'ELIGIBLE_DUST'
                          | 'VALUABLE'
                          | 'UNROUTABLE_OR_RISKY'
                      )
                    }
                    className="px-2.5 py-1.5 rounded-xl bg-obsidian-950 border border-obsidian-700 text-xs text-slate-200"
                  >
                    <option value="ALL">All Assets</option>
                    <option value="ELIGIBLE_DUST">Recoverable Dust Only</option>
                    <option value="VALUABLE">Valuable Holdings</option>
                    <option value="UNROUTABLE_OR_RISKY">No Route / Quarantined</option>
                  </select>
                </div>

                <button
                  onClick={() =>
                    setSortField((prev) =>
                      prev === 'NET_RECOVERY'
                        ? 'VALUE_USD'
                        : prev === 'VALUE_USD'
                          ? 'SYMBOL'
                          : 'NET_RECOVERY'
                    )
                  }
                  className="px-2.5 py-1.5 rounded-xl bg-obsidian-950 border border-obsidian-700 text-xs font-mono text-slate-300 flex items-center gap-1"
                >
                  <ArrowUpDown className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Sort: {sortField.replace('_', ' ')}</span>
                </button>

                <button
                  onClick={handleSelectAllEligible}
                  className="px-2.5 py-1.5 rounded-xl bg-obsidian-850 hover:bg-obsidian-800 border border-obsidian-700 text-xs text-cyan-300 flex items-center gap-1"
                >
                  <CheckSquare className="w-3.5 h-3.5" />
                  <span>Select Eligible</span>
                </button>

                <button
                  onClick={handleDeselectAll}
                  className="px-2.5 py-1.5 rounded-xl bg-obsidian-850 hover:bg-obsidian-800 border border-obsidian-700 text-xs text-slate-400 flex items-center gap-1"
                >
                  <Square className="w-3.5 h-3.5" />
                  <span>Deselect All</span>
                </button>
              </div>
            </div>

            {scanError && (
              <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-200">
                {scanError}
              </div>
            )}

            {/* Asset Table */}
            <div className="rounded-2xl bg-obsidian-900 border border-obsidian-800 overflow-hidden shadow-xl">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-obsidian-800 bg-obsidian-950/70 text-[11px] font-mono uppercase text-slate-400">
                      <th className="py-3.5 px-4 w-10">Select</th>
                      <th className="py-3.5 px-4">Asset / Mint</th>
                      <th className="py-3.5 px-4 text-right">Balance</th>
                      <th className="py-3.5 px-4 text-right">Est. USD Value</th>
                      <th className="py-3.5 px-4 text-right">Net Recoverable</th>
                      <th className="py-3.5 px-4">Liquidity & Route</th>
                      <th className="py-3.5 px-4">Risk & Classification</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-obsidian-800/70 text-xs">
                    {filteredAssets.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-12 text-center text-slate-400">
                          {isLoadingScan
                            ? 'Scanning Solana token accounts and evaluating routes...'
                            : 'No token accounts match the current filter.'}
                        </td>
                      </tr>
                    ) : (
                      filteredAssets.map((asset) => {
                        const isSelected = selectedAccounts.has(asset.tokenAccountAddress);
                        const isSelectable =
                          asset.risk.canSweepSafely && asset.hasViableRoute;

                        return (
                          <tr
                            key={asset.tokenAccountAddress}
                            onClick={() => isSelectable && toggleAssetSelection(asset)}
                            className={`transition ${
                              isSelectable ? 'cursor-pointer hover:bg-obsidian-850/70' : 'opacity-65'
                            } ${isSelected ? 'bg-ultraviolet-500/10' : ''}`}
                          >
                            <td className="py-3.5 px-4" onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                disabled={!isSelectable}
                                checked={isSelected}
                                onChange={() => toggleAssetSelection(asset)}
                                className="rounded border-obsidian-700 bg-obsidian-950 text-ultraviolet-500 disabled:opacity-30"
                              />
                            </td>

                            <td className="py-3.5 px-4">
                              <div className="flex items-center gap-3">
                                <DestinationTokenIcon symbol={asset.symbol} size={30} />
                                <div>
                                  <div className="font-bold text-white flex items-center gap-1.5">
                                    <span>{asset.symbol}</span>
                                    {asset.isToken2022 && (
                                      <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-obsidian-800 text-cyan-300">
                                        Token-2022
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-[11px] text-slate-400">
                                    {asset.name} •{' '}
                                    <span className="font-mono text-slate-500">
                                      {asset.mintAddress.slice(0, 4)}...{asset.mintAddress.slice(-4)}
                                    </span>
                                  </div>
                                </div>
                              </div>
                            </td>

                            <td className="py-3.5 px-4 text-right font-mono">
                              <div className="text-white font-medium">
                                {asset.uiBalance.toLocaleString(undefined, {
                                  maximumFractionDigits: 4,
                                })}
                              </div>
                              <div className="text-[10px] text-cyan-400">
                                +{(asset.reclaimableRentLamports / 1e9).toFixed(4)} SOL Rent
                              </div>
                            </td>

                            <td className="py-3.5 px-4 text-right font-mono">
                              <div className="text-white">
                                {asset.estimatedValueUsd !== null
                                  ? `$${asset.estimatedValueUsd.toFixed(2)}`
                                  : 'Unpriced'}
                              </div>
                              <div className="text-[10px] text-slate-400">
                                Rent: +${asset.reclaimableRentUsd.toFixed(2)}
                              </div>
                            </td>

                            <td className="py-3.5 px-4 text-right font-mono">
                              {asset.estimatedNetRecoveryUsd > 0 ? (
                                <span className="text-emerald-400 font-bold">
                                  ${asset.estimatedNetRecoveryUsd.toFixed(2)}
                                </span>
                              ) : (
                                <span className="text-slate-500">$0.00</span>
                              )}
                            </td>

                            <td className="py-3.5 px-4">
                              <div className="flex flex-col gap-1">
                                <span
                                  className={`inline-flex w-fit items-center px-2 py-0.5 rounded text-[10px] font-mono font-semibold ${
                                    asset.liquidityStatus === 'HIGH' ||
                                    asset.liquidityStatus === 'VIABLE'
                                      ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                                      : 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
                                  }`}
                                >
                                  {asset.liquidityStatus}
                                </span>
                                {asset.routeSummary && (
                                  <span className="text-[10px] text-slate-400 truncate max-w-[160px]">
                                    {asset.routeSummary.router} ({asset.routeSummary.priceImpactPct.toFixed(2)}% impact)
                                  </span>
                                )}
                              </div>
                            </td>

                            <td className="py-3.5 px-4">
                              <div className="flex flex-col gap-1">
                                <div className="flex items-center gap-1.5">
                                  {asset.risk.riskLevel === 'LOW' ? (
                                    <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-obsidian-800 text-emerald-300">
                                      <ShieldCheck className="w-3 h-3" /> LOW RISK
                                    </span>
                                  ) : (
                                    <span
                                      className={`inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded ${
                                        asset.risk.riskLevel === 'CRITICAL'
                                          ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                                          : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                                      }`}
                                    >
                                      <ShieldAlert className="w-3 h-3" /> {asset.risk.riskLevel}
                                    </span>
                                  )}
                                  <span className="text-[10px] font-mono text-slate-400">
                                    {asset.category.replace(/_/g, ' ')}
                                  </span>
                                </div>

                                {asset.risk.signals.length > 0 && (
                                  <div className="text-[10px] text-amber-300/90">
                                    {asset.risk.signals[0].label}
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: TRANSACTION HISTORY & RECEIPTS */}
        {activeTab === 'HISTORY' && (
          <div className="rounded-2xl bg-obsidian-900 border border-obsidian-800 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-white">
                  Sweep Session History & Verifiable Receipts
                </h3>
                <p className="text-xs text-slate-400">
                  Every sweep session is persisted with batch status, sponsorship records, and
                  Solscan explorer links.
                </p>
              </div>
              <button
                onClick={fetchHistoryAndAnalytics}
                className="px-3 py-1.5 rounded-xl bg-obsidian-800 hover:bg-obsidian-700 text-xs font-mono text-slate-200 flex items-center gap-1.5"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Refresh
              </button>
            </div>

            {!analytics || analytics.recentSessions.length === 0 ? (
              <div className="py-12 text-center text-slate-400 text-sm">
                No sweep sessions recorded yet. Select eligible tokens and run a sweep to generate
                your first receipt.
              </div>
            ) : (
              <div className="space-y-3">
                {analytics.recentSessions.map((s) => (
                  <div
                    key={s.sessionId}
                    className="p-4 rounded-xl bg-obsidian-950 border border-obsidian-800 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono font-bold text-white">
                          {s.sessionId}
                        </span>
                        <span
                          className={`text-[10px] font-mono px-2 py-0.5 rounded ${
                            s.status === 'COMPLETED'
                              ? 'bg-emerald-500/15 text-emerald-300'
                              : s.status === 'PARTIAL_SUCCESS'
                                ? 'bg-amber-500/15 text-amber-300'
                                : 'bg-obsidian-800 text-slate-300'
                          }`}
                        >
                          {s.status}
                        </span>
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-obsidian-800 text-cyan-300">
                          {s.mode === 'demo' ? 'DEMO' : s.network.toUpperCase()}
                        </span>
                      </div>
                      <div className="text-xs text-slate-400 flex items-center gap-2">
                        <Clock className="w-3.5 h-3.5" />
                        <span>{new Date(s.createdAt).toLocaleString()}</span>
                        <span>•</span>
                        <span>
                          {s.totalAssetsSelected} Assets → {s.actualDestinationOutputUi}{' '}
                          ${s.destinationSymbol}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2.5">
                      {s.batches.map((b) =>
                        b.signature && !b.signature.startsWith('DEMO_') ? (
                          <a
                            key={b.batchId}
                            href={`https://solscan.io/tx/${b.signature}${
                              s.network === 'devnet' ? '?cluster=devnet' : ''
                            }`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="px-3 py-1.5 rounded-lg bg-obsidian-800 hover:bg-obsidian-700 text-xs font-mono text-cyan-300 flex items-center gap-1"
                          >
                            Batch #{b.batchIndex} Solscan <ExternalLink className="w-3 h-3" />
                          </a>
                        ) : null
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* TAB 3: ANALYTICS, AUTO-SWEEP & $VACUUM ECOSYSTEM */}
        {activeTab === 'ANALYTICS' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="p-6 rounded-2xl bg-obsidian-900 border border-obsidian-800 space-y-4">
              <div className="flex items-center gap-2 text-cyan-400 text-xs font-mono uppercase">
                <Activity className="w-4 h-4" />
                <span>SWEEP ANALYTICS & SPONSORSHIP METRICS</span>
              </div>
              <h3 className="text-xl font-bold text-white">
                Historical Consolidation Performance
              </h3>

              <div className="grid grid-cols-2 gap-3">
                <div className="p-4 rounded-xl bg-obsidian-950 border border-obsidian-800">
                  <div className="text-[11px] font-mono text-slate-400">TOKENS CLEANED</div>
                  <div className="text-xl font-bold text-white mt-1">
                    {analytics?.totalTokensCleaned ?? 0}
                  </div>
                </div>
                <div className="p-4 rounded-xl bg-obsidian-950 border border-obsidian-800">
                  <div className="text-[11px] font-mono text-slate-400">NET VALUE RECOVERED</div>
                  <div className="text-xl font-bold text-emerald-400 mt-1">
                    ${analytics?.estimatedNetValueRecoveredUsd.toFixed(2) ?? '0.00'}
                  </div>
                </div>
                <div className="p-4 rounded-xl bg-obsidian-950 border border-obsidian-800">
                  <div className="text-[11px] font-mono text-slate-400">FEES SPONSORED (SOL)</div>
                  <div className="text-xl font-bold text-cyan-400 mt-1">
                    {((analytics?.totalFeesSponsoredLamports ?? 0) / 1e9).toFixed(5)} SOL
                  </div>
                </div>
                <div className="p-4 rounded-xl bg-obsidian-950 border border-obsidian-800">
                  <div className="text-[11px] font-mono text-slate-400">SUCCESSFUL SWEEPS</div>
                  <div className="text-xl font-bold text-white mt-1">
                    {analytics?.totalSuccessfulSweeps ?? 0}
                  </div>
                </div>
              </div>
            </div>

            <div className="p-6 rounded-2xl bg-obsidian-900 border border-ultraviolet-500/30 space-y-4">
              <div className="flex items-center gap-2 text-ultraviolet-400 text-xs font-mono uppercase">
                <Sparkles className="w-4 h-4" />
                <span>$VACUUM ECOSYSTEM & PLANNED PRO TIER</span>
              </div>
              <h3 className="text-xl font-bold text-white">
                Configurable Token Integration Layer
              </h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                VACUUM is architected so the official $VACUUM token launch plugs in via environment
                configuration (`NEXT_PUBLIC_VACUUM_TOKEN_MINT`). Unavailable utilities remain safely
                feature-flagged until live verification.
              </p>

              <div className="space-y-2.5 text-xs">
                <div className="p-3 rounded-xl bg-obsidian-950 border border-obsidian-800 flex items-center justify-between">
                  <div>
                    <div className="font-semibold text-white">Smart Merger</div>
                    <div className="text-slate-400">Consolidate multiple SPL tokens into $VACUUM, SOL, or USDC</div>
                  </div>
                  <span className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 font-mono text-[10px]">
                    ACTIVE
                  </span>
                </div>

                <div className="p-3 rounded-xl bg-obsidian-950 border border-obsidian-800 flex items-center justify-between">
                  <div>
                    <div className="font-semibold text-white">Auto-Sweep Recurring Scanner</div>
                    <div className="text-slate-400">Scheduled background scans with explicit wallet signing</div>
                  </div>
                  <span className="px-2 py-0.5 rounded bg-obsidian-800 text-slate-400 font-mono text-[10px]">
                    FEATURE FLAG READY
                  </span>
                </div>

                <div className="p-3 rounded-xl bg-obsidian-950 border border-obsidian-800 flex items-center justify-between">
                  <div>
                    <div className="font-semibold text-white">VACUUM Pro & Fee Discounts</div>
                    <div className="text-slate-400">Reduced service fees for verified $VACUUM holders</div>
                  </div>
                  <span className="px-2 py-0.5 rounded bg-obsidian-800 text-slate-400 font-mono text-[10px]">
                    PLANNED UTILITY
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Sweep Review & Real-Time Execution Modal */}
      <SweepReviewModal
        isOpen={isReviewModalOpen}
        onClose={() => setIsReviewModalOpen(false)}
        selectedAssets={selectedAssetObjects}
        destinationSymbol={destinationSymbol}
        network={network}
        mode={mode}
        walletAddress={activeWalletAddress}
        initialSlippageBps={100}
        onSweepCompleted={() => {
          scanWallet();
          fetchHistoryAndAnalytics();
        }}
      />
    </div>
  );
}
