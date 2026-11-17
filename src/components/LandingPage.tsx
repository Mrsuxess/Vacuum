'use client';

import React, { useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  Cpu,
  Layers,
  Lock,
  Radar,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Wallet,
  Zap,
} from 'lucide-react';
import { VacuumLogo, DestinationTokenIcon } from '@/components/VacuumLogo';

interface LandingPageProps {
  onConnectWallet: () => void;
  onExploreDemo: () => void;
}

const PREVIEW_DUST_TOKENS = [
  { symbol: 'BONK', name: 'Bonk', balance: '142.50', usd: '$2.64', rent: '+$0.38', status: 'VIABLE ROUTE', selected: true },
  { symbol: 'WIF', name: 'dogwifhat', balance: '1.58', usd: '$3.87', rent: '+$0.38', status: 'VIABLE ROUTE', selected: true },
  { symbol: 'POPCAT', name: 'Popcat (SOL)', balance: '2.85', usd: '$1.82', rent: '+$0.38', status: 'VIABLE ROUTE', selected: true },
  { symbol: 'BOME', name: 'BOOK OF MEME', balance: '185.00', usd: '$0.89', rent: '+$0.38', status: 'VIABLE ROUTE', selected: true },
  { symbol: 'RAY', name: 'Empty Token Account', balance: '0.00', usd: '$0.00', rent: '+$0.38', status: 'RENT RECLAIM', selected: true },
  { symbol: 'CLAIM-SOL.COM', name: 'Suspicious Airdrop', balance: '500.00', usd: '—', rent: '—', status: 'QUARANTINED', selected: false },
];

const FAQ_ITEMS = [
  {
    q: 'How does VACUUM distinguish between potential dust and recoverable value?',
    a: 'Nominal USD value does not guarantee a token can be sold. VACUUM queries real-time executable routes via Jupiter Swap API V2, checks pool price impact, adds reclaimable SPL token account rent (~0.002039 SOL per closed account), and subtracts network and priority fees to compute your true net economic recovery.',
  },
  {
    q: 'How does Gasless Transaction Sponsorship work on Solana?',
    a: 'Solana transactions natively support a designated fee payer separate from the token owner. When your sweep meets our positive net-recovery policy and wallet rate limits, VACUUM’s server-side sponsor co-signs as the transaction fee payer so you can consolidate dust even with near-zero SOL.',
  },
  {
    q: 'Does VACUUM ever request my private key or execute swaps without permission?',
    a: 'Never. VACUUM is strictly non-custodial. Every transaction batch displays the exact input assets, expected output, minimum slippage-protected output, and fee structure, requiring your explicit signature through a Solana Wallet Standard wallet such as Phantom or Solflare.',
  },
  {
    q: 'Why does VACUUM split large sweeps into transaction batches?',
    a: 'Solana enforces a strict 1,232-byte raw packet limit, a 64-account limit, and a 1.4M compute-unit cap per transaction. Attempting 30+ swaps in a single transaction will fail on-chain. Our TransactionBatcher intelligently groups swaps and isolates failures so one illiquid token never blocks your remaining eligible assets.',
  },
  {
    q: 'How is the $VACUUM token integrated?',
    a: '$VACUUM is our flagship consolidation destination. The platform uses a verified configuration layer so that $VACUUM, SOL, and USDC are supported cleanly without ever hardcoding unverified mint addresses.',
  },
];

export function LandingPage({ onConnectWallet, onExploreDemo }: LandingPageProps) {
  const [previewStep, setPreviewStep] = useState<'SCAN' | 'SELECT' | 'SWEEP'>('SELECT');
  const [openFaqIdx, setOpenFaqIdx] = useState<number | null>(0);

  return (
    <div className="min-h-screen bg-obsidian-950 text-slate-100 selection:bg-ultraviolet-500 selection:text-white">
      {/* Subtle Top Ambient Vortex Glow */}
      <div className="pointer-events-none fixed inset-x-0 top-0 h-[520px] bg-vortex-radial opacity-90 z-0" />

      {/* Top Navigation */}
      <header className="sticky top-0 z-40 border-b border-obsidian-800/80 bg-obsidian-950/80 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-20 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <VacuumLogo size={38} />
            <div>
              <span className="text-xl font-bold tracking-tight text-white">VACUUM</span>
              <span className="hidden sm:inline-block ml-2.5 text-[11px] font-mono uppercase px-2 py-0.5 rounded-full bg-ultraviolet-500/15 text-ultraviolet-300 border border-ultraviolet-500/30">
                $VACUUM ECOSYSTEM
              </span>
            </div>
          </div>

          <nav className="hidden md:flex items-center gap-7 text-sm text-slate-300">
            <a href="#problem" className="hover:text-white transition">Problem</a>
            <a href="#how-it-works" className="hover:text-white transition">How It Works</a>
            <a href="#routing" className="hover:text-white transition">Routing & Batching</a>
            <a href="#sponsorship" className="hover:text-white transition">Gasless Engine</a>
            <a href="#security" className="hover:text-white transition">Security</a>
            <a href="#faq" className="hover:text-white transition">FAQ</a>
          </nav>

          <div className="flex items-center gap-3">
            <button
              onClick={onExploreDemo}
              className="hidden sm:inline-flex px-4 py-2.5 rounded-xl bg-obsidian-850 hover:bg-obsidian-800 border border-obsidian-700 text-xs font-mono font-semibold text-slate-200 transition"
            >
              EXPLORE THE DEMO
            </button>
            <button
              onClick={onConnectWallet}
              className="px-4 sm:px-5 py-2.5 rounded-xl bg-gradient-to-r from-ultraviolet-600 to-cyan-500 hover:from-ultraviolet-500 hover:to-cyan-400 text-white text-xs sm:text-sm font-semibold shadow-lg shadow-ultraviolet-600/25 flex items-center gap-2 transition"
            >
              <Wallet className="w-4 h-4" />
              <span>CONNECT WALLET</span>
            </button>
          </div>
        </div>
      </header>

      <main className="relative z-10">
        {/* HERO SECTION */}
        <section className="pt-16 pb-20 sm:pt-24 sm:pb-28 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
            <div className="lg:col-span-6 space-y-6">
              <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-obsidian-900 border border-obsidian-700 text-xs font-mono text-cyan-300">
                <Sparkles className="w-3.5 h-3.5 text-ultraviolet-400" />
                <span>SOLANA WALLET CLEANING & ASSET CONSOLIDATION</span>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-mono uppercase tracking-widest text-ultraviolet-400 font-semibold">
                  VACUUM • $VACUUM
                </div>
                <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight text-white leading-[1.08]">
                  CLEAR THE CLUTTER.{' '}
                  <span className="bg-gradient-to-r from-ultraviolet-400 via-purple-300 to-cyan-400 bg-clip-text text-transparent">
                    KEEP THE VALUE.
                  </span>
                </h1>
              </div>

              <p className="text-base sm:text-lg text-slate-300 leading-relaxed max-w-xl">
                Your wallet is full of forgotten tokens. VACUUM helps you consolidate eligible
                assets into one destination with intelligent Solana-powered swaps.
              </p>

              <div className="grid grid-cols-2 gap-3 pt-1 max-w-lg text-xs text-slate-400">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-cyan-400 shrink-0" />
                  <span>Your wallet deserves a cleanup.</span>
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-cyan-400 shrink-0" />
                  <span>Turn forgotten tokens into something useful.</span>
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-cyan-400 shrink-0" />
                  <span>One sweep. Multiple assets. One destination.</span>
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-cyan-400 shrink-0" />
                  <span>Stop leaving recoverable value behind.</span>
                </div>
              </div>

              {/* Primary & Secondary Hero CTAs */}
              <div className="flex flex-wrap items-center gap-4 pt-3">
                <button
                  onClick={onConnectWallet}
                  className="px-7 py-4 rounded-xl bg-gradient-to-r from-ultraviolet-600 to-cyan-500 hover:from-ultraviolet-500 hover:to-cyan-400 text-white font-semibold text-sm shadow-xl shadow-ultraviolet-600/30 flex items-center gap-2.5 transition"
                >
                  <Wallet className="w-4 h-4" />
                  <span>CONNECT WALLET</span>
                  <ArrowRight className="w-4 h-4" />
                </button>

                <button
                  onClick={onExploreDemo}
                  className="px-7 py-4 rounded-xl bg-obsidian-900 hover:bg-obsidian-800 border border-obsidian-700 text-slate-200 font-semibold text-sm flex items-center gap-2 transition"
                >
                  <Radar className="w-4 h-4 text-cyan-400" />
                  <span>EXPLORE THE DEMO</span>
                </button>
              </div>
            </div>

            {/* Interactive Lightweight Product Preview Component */}
            <div className="lg:col-span-6">
              <div className="rounded-2xl bg-obsidian-900/90 border border-obsidian-700/90 shadow-2xl overflow-hidden backdrop-blur-xl">
                {/* Preview Header */}
                <div className="px-5 py-3.5 bg-obsidian-950 border-b border-obsidian-800 flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <VacuumLogo size={24} />
                    <span className="text-xs font-mono font-semibold text-white">
                      INTERACTIVE PRODUCT PREVIEW
                    </span>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
                      SIMULATED UI PREVIEW
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    {(['SCAN', 'SELECT', 'SWEEP'] as const).map((tab) => (
                      <button
                        key={tab}
                        onClick={() => setPreviewStep(tab)}
                        className={`px-2.5 py-1 rounded text-[10px] font-mono font-semibold transition ${
                          previewStep === tab
                            ? 'bg-ultraviolet-600 text-white'
                            : 'bg-obsidian-800 text-slate-400 hover:text-white'
                        }`}
                      >
                        {tab}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Preview Body */}
                <div className="p-5 space-y-4">
                  <div className="grid grid-cols-3 gap-3">
                    <div className="p-3 rounded-xl bg-obsidian-950 border border-obsidian-800">
                      <div className="text-[10px] font-mono text-slate-400">DISCOVERED DUST</div>
                      <div className="text-base font-bold text-white mt-0.5">$9.22 USD</div>
                    </div>
                    <div className="p-3 rounded-xl bg-obsidian-950 border border-obsidian-800">
                      <div className="text-[10px] font-mono text-slate-400">RENT RECOVERY</div>
                      <div className="text-base font-bold text-cyan-400 mt-0.5">+$1.89 SOL Rent</div>
                    </div>
                    <div className="p-3 rounded-xl bg-obsidian-950 border border-ultraviolet-500/40">
                      <div className="text-[10px] font-mono text-ultraviolet-300">DESTINATION</div>
                      <div className="text-base font-bold text-white mt-0.5 flex items-center gap-1.5">
                        <DestinationTokenIcon symbol="VACUUM" size={18} />
                        <span>$VACUUM</span>
                      </div>
                    </div>
                  </div>

                  {/* Mini Token List */}
                  <div className="rounded-xl border border-obsidian-800 bg-obsidian-950/70 divide-y divide-obsidian-800/70">
                    {PREVIEW_DUST_TOKENS.map((t) => (
                      <div
                        key={t.symbol}
                        className="px-3.5 py-2.5 flex items-center justify-between text-xs"
                      >
                        <div className="flex items-center gap-2.5">
                          <input
                            type="checkbox"
                            readOnly
                            checked={t.selected}
                            className="rounded border-obsidian-700 bg-obsidian-900 text-ultraviolet-500"
                          />
                          <DestinationTokenIcon symbol={t.symbol} size={22} />
                          <div>
                            <div className="font-semibold text-white">{t.symbol}</div>
                            <div className="text-[10px] text-slate-400">{t.name}</div>
                          </div>
                        </div>

                        <div className="flex items-center gap-4 text-right font-mono">
                          <div>
                            <div className="text-white">{t.usd}</div>
                            <div className="text-[10px] text-cyan-400">{t.rent}</div>
                          </div>
                          <span
                            className={`text-[10px] px-2 py-0.5 rounded border ${
                              t.status === 'QUARANTINED'
                                ? 'bg-rose-500/10 text-rose-300 border-rose-500/30'
                                : 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                            }`}
                          >
                            {t.status}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Interactive Preview Footer */}
                  <div className="pt-1 flex items-center justify-between gap-3">
                    <div className="text-[11px] text-slate-400">
                      Net Recoverable: <span className="text-emerald-400 font-mono font-semibold">$11.06</span> • Gasless Sponsor Eligible
                    </div>
                    <button
                      onClick={onExploreDemo}
                      className="px-4 py-2 rounded-xl bg-ultraviolet-600 hover:bg-ultraviolet-500 text-white text-xs font-semibold flex items-center gap-1.5 transition"
                    >
                      <span>Launch Full Interactive Demo</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* SECTION 1 & 2: THE PROBLEM & THE SOLUTION */}
        <section id="problem" className="py-20 border-t border-obsidian-800/80 bg-obsidian-900/40">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-12">
            <div className="max-w-3xl space-y-3">
              <div className="text-xs font-mono uppercase tracking-widest text-cyan-400">
                01 / THE PROBLEM & SOLUTION
              </div>
              <h2 className="text-3xl sm:text-4xl font-bold text-white">
                Active Solana wallets accumulate fragmented dust and locked account rent.
              </h2>
              <p className="text-slate-400 text-base">
                Every memecoin trade, airdrop, and DeFi interaction leaves behind fractional balances
                and open SPL token accounts holding ~0.002039 SOL in rent. Managing 25 micro-positions
                manually across DEXs takes hours and wastes gas.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="p-6 rounded-2xl bg-obsidian-900 border border-obsidian-800 space-y-4">
                <div className="text-xs font-mono uppercase px-2.5 py-1 rounded bg-rose-500/10 text-rose-300 border border-rose-500/30 inline-block">
                  WITHOUT VACUUM
                </div>
                <h3 className="text-xl font-bold text-white">
                  Fragmented Clutter & Stranded Value
                </h3>
                <ul className="space-y-2.5 text-sm text-slate-300">
                  <li className="flex items-start gap-2.5">
                    <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0 mt-1" />
                    <span>Dozens of $0.20–$4.50 leftover balances too tedious to swap one by one.</span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0 mt-1" />
                    <span>Zero-balance SPL token accounts locking up recoverable SOL rent indefinitely.</span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0 mt-1" />
                    <span>Scam/phishing tokens mixed alongside legitimate assets with freeze-authority traps.</span>
                  </li>
                </ul>
              </div>

              <div className="p-6 rounded-2xl bg-obsidian-900 border border-ultraviolet-500/40 space-y-4">
                <div className="text-xs font-mono uppercase px-2.5 py-1 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 inline-block">
                  WITH VACUUM
                </div>
                <h3 className="text-xl font-bold text-white">
                  One Intelligent Sweeping Experience
                </h3>
                <ul className="space-y-2.5 text-sm text-slate-300">
                  <li className="flex items-start gap-2.5">
                    <CheckCircle2 className="w-4 h-4 text-cyan-400 shrink-0 mt-1" />
                    <span>Automatic classification of valuable holdings, recoverable dust, and unroutable tokens.</span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <CheckCircle2 className="w-4 h-4 text-cyan-400 shrink-0 mt-1" />
                    <span>Jupiter Swap API V2 meta-aggregation combined with SPL account rent reclamation.</span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <CheckCircle2 className="w-4 h-4 text-cyan-400 shrink-0 mt-1" />
                    <span>Safe, failure-isolated transaction batching into $VACUUM, SOL, or USDC.</span>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* SECTION 3: HOW IT WORKS */}
        <section id="how-it-works" className="py-20 border-t border-obsidian-800/80">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-12">
            <div className="max-w-3xl space-y-2">
              <div className="text-xs font-mono uppercase tracking-widest text-ultraviolet-400">
                02 / WORKFLOW
              </div>
              <h2 className="text-3xl sm:text-4xl font-bold text-white">
                CONNECT → SCAN → SELECT → SWEEP → RECEIVE
              </h2>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
              {[
                {
                  step: '01',
                  title: 'Connect Wallet',
                  desc: 'Connect Phantom, Solflare, or any Solana Wallet Standard wallet on Mainnet or Devnet.',
                },
                {
                  step: '02',
                  title: 'Scan Accounts',
                  desc: 'Discover SPL Token and Token-2022 balances, mint authorities, and reclaimable rent.',
                },
                {
                  step: '03',
                  title: 'Select Eligible Dust',
                  desc: 'Filter by customizable USD thresholds ($0.10 to $5.00+) while protecting core holdings.',
                },
                {
                  step: '04',
                  title: 'Authorize Batches',
                  desc: 'Review transparent quotes, slippage, and gasless sponsorship before signing.',
                },
                {
                  step: '05',
                  title: 'Receive Output',
                  desc: 'Verify on-chain confirmation and export a cryptographic receipt for your consolidated assets.',
                },
              ].map((item) => (
                <div
                  key={item.step}
                  className="p-5 rounded-2xl bg-obsidian-900 border border-obsidian-800 flex flex-col justify-between space-y-4"
                >
                  <div className="text-xs font-mono font-bold text-cyan-400 bg-cyan-500/10 border border-cyan-500/20 w-9 h-9 rounded-xl flex items-center justify-center">
                    {item.step}
                  </div>
                  <div className="space-y-1.5">
                    <h3 className="text-base font-bold text-white">{item.title}</h3>
                    <p className="text-xs text-slate-400 leading-relaxed">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* SECTION 4: SUPPORTED DESTINATIONS & SECTION 8: VACUUM ECOSYSTEM */}
        <section className="py-20 border-t border-obsidian-800/80 bg-obsidian-900/40">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-12">
            <div className="max-w-3xl space-y-2">
              <div className="text-xs font-mono uppercase tracking-widest text-cyan-400">
                03 / CONSOLIDATION DESTINATIONS & $VACUUM ECOSYSTEM
              </div>
              <h2 className="text-3xl sm:text-4xl font-bold text-white">
                One Sweep. Multiple Assets. One Destination.
              </h2>
              <p className="text-slate-400 text-sm sm:text-base">
                Consolidate your eligible wallet dust into our flagship ecosystem asset{' '}
                <span className="text-white font-semibold">$VACUUM</span>, native{' '}
                <span className="text-white font-semibold">SOL</span>, or{' '}
                <span className="text-white font-semibold">USDC</span>.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="p-6 rounded-2xl bg-obsidian-900 border-2 border-ultraviolet-500/60 space-y-4 relative">
                <span className="absolute top-4 right-4 text-[10px] font-mono uppercase px-2.5 py-0.5 rounded-full bg-ultraviolet-500/20 text-ultraviolet-300 border border-ultraviolet-500/40">
                  FLAGSHIP DESTINATION
                </span>
                <DestinationTokenIcon symbol="VACUUM" size={42} />
                <div>
                  <h3 className="text-xl font-bold text-white">$VACUUM</h3>
                  <p className="text-xs text-slate-400 mt-1">
                    The flagship asset of the VACUUM consolidation protocol. Built with a verified
                    configuration boundary so official token deployment integrates without hardcoding
                    unverified mints.
                  </p>
                </div>
                <div className="pt-2 border-t border-obsidian-800 text-[11px] text-slate-300 space-y-1">
                  <div className="font-mono text-cyan-300 uppercase">Planned Ecosystem Utilities:</div>
                  <div>• Reduced platform service fees for eligible holders</div>
                  <div>• Priority gasless sponsorship allowances</div>
                  <div>• VACUUM Pro automation & multi-wallet access</div>
                </div>
              </div>

              <div className="p-6 rounded-2xl bg-obsidian-900 border border-obsidian-800 space-y-4">
                <DestinationTokenIcon symbol="SOL" size={42} />
                <div>
                  <h3 className="text-xl font-bold text-white">Solana (SOL)</h3>
                  <p className="text-xs text-slate-400 mt-1">
                    Direct consolidation into native SOL with maximum DEX liquidity depth and
                    immediate combination with reclaimed SPL token account rent.
                  </p>
                </div>
                <div className="pt-2 border-t border-obsidian-800 text-[11px] text-slate-400 font-mono">
                  Mint: So11111111111111111111111111111111111111112
                </div>
              </div>

              <div className="p-6 rounded-2xl bg-obsidian-900 border border-obsidian-800 space-y-4">
                <DestinationTokenIcon symbol="USDC" size={42} />
                <div>
                  <h3 className="text-xl font-bold text-white">USD Coin (USDC)</h3>
                  <p className="text-xs text-slate-400 mt-1">
                    Consolidate volatile micro-balances and memecoin remnants directly into
                    dollar-denominated SPL USDC.
                  </p>
                </div>
                <div className="pt-2 border-t border-obsidian-800 text-[11px] text-slate-400 font-mono">
                  Mint: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* SECTION 5, 6, 7: INTELLIGENT ROUTING, GAS SPONSORSHIP & SECURITY */}
        <section id="routing" className="py-20 border-t border-obsidian-800/80">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="p-6 rounded-2xl bg-obsidian-900 border border-obsidian-800 space-y-3">
              <div className="w-10 h-10 rounded-xl bg-ultraviolet-500/15 border border-ultraviolet-500/30 flex items-center justify-center">
                <Cpu className="w-5 h-5 text-ultraviolet-400" />
              </div>
              <div className="text-xs font-mono text-ultraviolet-400">JUPITER SWAP API V2 + BATCHER</div>
              <h3 className="text-lg font-bold text-white">Intelligent Routing & Batching</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Uses Jupiter Swap API V2 (`/swap/v2/order` and `/swap/v2/execute`) to route across
                Metis, JupiterZ RFQ, Dflow, and OKX. Our transaction batcher respects Solana&apos;s
                1,232-byte limit, 64-account cap, and 1.4M compute-unit budget with full failure
                isolation.
              </p>
            </div>

            <div id="sponsorship" className="p-6 rounded-2xl bg-obsidian-900 border border-obsidian-800 space-y-3">
              <div className="w-10 h-10 rounded-xl bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center">
                <Zap className="w-5 h-5 text-cyan-400" />
              </div>
              <div className="text-xs font-mono text-cyan-400">DESIGNATED SOLANA FEE PAYER</div>
              <h3 className="text-lg font-bold text-white">Economically Sustainable Gasless</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                No SOL left for gas? Our backend SponsorshipService evaluates liquidation proceeds
                minus network fees, priority fees, ATA creation, and risk buffers. Eligible sweeps
                are co-signed server-side within strict per-wallet and daily budgets.
              </p>
            </div>

            <div id="security" className="p-6 rounded-2xl bg-obsidian-900 border border-obsidian-800 space-y-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center">
                <Lock className="w-5 h-5 text-emerald-400" />
              </div>
              <div className="text-xs font-mono text-emerald-400">NON-CUSTODIAL & RISK ENGINE</div>
              <h3 className="text-lg font-bold text-white">Security & User Control</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                TokenRiskService inspects mint authority, freeze authority, Token-2022 transfer
                hooks, price impact, and phishing metadata before any transaction is built. Every
                batch is simulated and requires your explicit wallet signature.
              </p>
            </div>
          </div>
        </section>

        {/* SECTION 9: FAQ */}
        <section id="faq" className="py-20 border-t border-obsidian-800/80 bg-obsidian-900/30">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 space-y-8">
            <div className="text-center space-y-2">
              <div className="text-xs font-mono uppercase tracking-widest text-cyan-400">
                FREQUENTLY ASKED QUESTIONS
              </div>
              <h2 className="text-3xl font-bold text-white">
                Engineered for Transparency
              </h2>
            </div>

            <div className="space-y-3">
              {FAQ_ITEMS.map((item, idx) => {
                const isOpen = openFaqIdx === idx;
                return (
                  <div
                    key={item.q}
                    className="rounded-xl bg-obsidian-900 border border-obsidian-800 overflow-hidden"
                  >
                    <button
                      onClick={() => setOpenFaqIdx(isOpen ? null : idx)}
                      className="w-full px-5 py-4 text-left flex items-center justify-between gap-4 hover:bg-obsidian-850 transition"
                    >
                      <span className="text-sm font-semibold text-white">{item.q}</span>
                      <ChevronDown
                        className={`w-4 h-4 text-slate-400 shrink-0 transition-transform ${
                          isOpen ? 'rotate-180 text-cyan-400' : ''
                        }`}
                      />
                    </button>
                    {isOpen && (
                      <div className="px-5 pb-4 text-xs sm:text-sm text-slate-300 leading-relaxed border-t border-obsidian-800/60 pt-3">
                        {item.a}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* SECTION 10: FINAL WALLET CONNECTION CTA */}
        <section className="py-20 border-t border-obsidian-800/80">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center space-y-6">
            <VacuumLogo size={52} className="mx-auto" />
            <h2 className="text-3xl sm:text-4xl font-extrabold text-white">
              Ready to Clean Your Solana Wallet?
            </h2>
            <p className="text-slate-400 max-w-xl mx-auto text-sm sm:text-base">
              Connect your Solana wallet to scan for recoverable token dust and reclaimable rent,
              or explore our interactive Demo Mode.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-4 pt-2">
              <button
                onClick={onConnectWallet}
                className="px-7 py-4 rounded-xl bg-gradient-to-r from-ultraviolet-600 to-cyan-500 hover:from-ultraviolet-500 hover:to-cyan-400 text-white font-semibold text-sm shadow-xl shadow-ultraviolet-600/30 flex items-center gap-2 transition"
              >
                <Wallet className="w-4 h-4" />
                <span>CONNECT WALLET</span>
              </button>
              <button
                onClick={onExploreDemo}
                className="px-7 py-4 rounded-xl bg-obsidian-900 hover:bg-obsidian-800 border border-obsidian-700 text-slate-200 font-semibold text-sm transition"
              >
                EXPLORE THE DEMO
              </button>
            </div>
          </div>
        </section>
      </main>

      {/* POLISHED FOOTER */}
      <footer className="border-t border-obsidian-800 bg-obsidian-950 py-12 px-4 sm:px-6 lg:px-8 text-xs text-slate-400">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <VacuumLogo size={28} />
            <div>
              <div className="font-bold text-white">VACUUM — $VACUUM</div>
              <div className="text-[11px] text-slate-500">
                CLEAR THE CLUTTER. KEEP THE VALUE. • Non-Custodial Solana Asset Consolidation
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-6 text-slate-400">
            <button onClick={onExploreDemo} className="hover:text-white transition">
              Demo Workspace
            </button>
            <a href="#how-it-works" className="hover:text-white transition">
              Architecture
            </a>
            <a href="#security" className="hover:text-white transition">
              Token Safety
            </a>
            <a href="#faq" className="hover:text-white transition">
              FAQ
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
