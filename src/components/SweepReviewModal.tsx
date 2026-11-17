'use client';

import React, { useState } from 'react';
import { VersionedTransaction } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Download,
  ExternalLink,
  FileText,
  Layers,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  X,
  XCircle,
  Zap,
} from 'lucide-react';
import {
  DestinationSymbol,
  DiscoveredTokenAsset,
  ExecutionMode,
  SolanaNetwork,
  SweepReceipt,
  SweepSession,
} from '@/types/vacuum';
import { DestinationTokenIcon } from '@/components/VacuumLogo';

export type ExecutionStage =
  | 'SCANNING_ASSETS'
  | 'FINDING_LIQUIDITY'
  | 'BUILDING_BATCHES'
  | 'REVIEW_READY'
  | 'WAITING_WALLET_AUTH'
  | 'EXECUTING_TRANSACTIONS'
  | 'VERIFYING_CONFIRMATIONS'
  | 'SWEEP_COMPLETE';

interface SweepReviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedAssets: DiscoveredTokenAsset[];
  destinationSymbol: DestinationSymbol;
  network: SolanaNetwork;
  mode: ExecutionMode;
  walletAddress: string;
  initialSlippageBps: number;
  onSweepCompleted: () => void;
}

const EXECUTION_STEPS: Array<{ id: ExecutionStage; label: string }> = [
  { id: 'SCANNING_ASSETS', label: 'Scanning assets' },
  { id: 'FINDING_LIQUIDITY', label: 'Finding liquidity' },
  { id: 'BUILDING_BATCHES', label: 'Building transaction batches' },
  { id: 'WAITING_WALLET_AUTH', label: 'Waiting for wallet authorization' },
  { id: 'EXECUTING_TRANSACTIONS', label: 'Executing transactions' },
  { id: 'VERIFYING_CONFIRMATIONS', label: 'Verifying confirmations' },
  { id: 'SWEEP_COMPLETE', label: 'Completing sweep' },
];

export function SweepReviewModal({
  isOpen,
  onClose,
  selectedAssets,
  destinationSymbol,
  network,
  mode,
  walletAddress,
  initialSlippageBps,
  onSweepCompleted,
}: SweepReviewModalProps) {
  const { signTransaction, signAllTransactions } = useWallet();

  const [stage, setStage] = useState<ExecutionStage>('SCANNING_ASSETS');
  const [slippageBps, setSlippageBps] = useState<number>(initialSlippageBps);
  const [requestSponsorship, setRequestSponsorship] = useState<boolean>(true);
  const [session, setSession] = useState<SweepSession | null>(null);
  const [receipt, setReceipt] = useState<SweepReceipt | null>(null);
  const [showReceiptView, setShowReceiptView] = useState<boolean>(false);
  const [activeBatchIdx, setActiveBatchIdx] = useState<number>(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [acknowledgedHighRisk, setAcknowledgedHighRisk] = useState<boolean>(false);

  const highRiskAssets = selectedAssets.filter(
    (a) => a.risk.requiresUserAcknowledgement
  );

  const initializeQuoteSession = React.useCallback(
    async (customSlippageBps?: number, sponsorPref?: boolean) => {
      try {
        setErrorMsg(null);
        setStage('SCANNING_ASSETS');
        await new Promise((r) => setTimeout(r, 180));
        setStage('FINDING_LIQUIDITY');
        await new Promise((r) => setTimeout(r, 220));
        setStage('BUILDING_BATCHES');

        const res = await fetch('/api/sweep/quote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            walletAddress,
            network,
            mode,
            selectedAssets,
            destinationSymbol,
            slippageBps: customSlippageBps ?? slippageBps,
            requestGaslessSponsorship: sponsorPref ?? requestSponsorship,
          }),
        });

        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || 'Failed to build sweep quote batches');
        }

        setSession(data.session);
        setStage('REVIEW_READY');
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setStage('REVIEW_READY');
      }
    },
    [walletAddress, network, mode, selectedAssets, destinationSymbol, slippageBps, requestSponsorship]
  );

  const wasOpenRef = React.useRef<boolean>(false);

  React.useEffect(() => {
    if (isOpen && !wasOpenRef.current && selectedAssets.length > 0) {
      wasOpenRef.current = true;
      setSession(null);
      setReceipt(null);
      setShowReceiptView(false);
      initializeQuoteSession(initialSlippageBps, true);
    } else if (!isOpen) {
      wasOpenRef.current = false;
    }
  }, [isOpen, selectedAssets, initialSlippageBps, initializeQuoteSession]);

  if (!isOpen) return null;

  const handleExecuteBatchOrAll = async (specificBatchId?: string) => {
    if (!session) return;
    setErrorMsg(null);

    const batchesToRun = specificBatchId
      ? session.batches.filter((b) => b.batchId === specificBatchId)
      : session.batches.filter(
          (b) => b.status === 'PENDING_SIGNATURE' || b.status === 'FAILED'
        );

    if (batchesToRun.length === 0) return;

    // One-Click Multi-Transaction Wallet Authorization:
    // If running multiple batches in live mode and the wallet supports signAllTransactions,
    // collect all user signatures in a single wallet prompt before broadcasting sequentially.
    const preSignedMap = new Map<string, string>();
    if (mode === 'live' && batchesToRun.length > 1 && signAllTransactions) {
      try {
        setActiveBatchIdx(batchesToRun[0].batchIndex);
        setStage('WAITING_WALLET_AUTH');
        const unsignedTxs = batchesToRun.map((b) => {
          if (!b.serializedTransactionBase64) {
            throw new Error(`Batch #${b.batchIndex} is missing serializedTransactionBase64.`);
          }
          return VersionedTransaction.deserialize(
            Buffer.from(b.serializedTransactionBase64, 'base64')
          );
        });
        const signedTxs = await signAllTransactions(unsignedTxs);
        signedTxs.forEach((stx, idx) => {
          preSignedMap.set(
            batchesToRun[idx].batchId,
            Buffer.from(stx.serialize()).toString('base64')
          );
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setErrorMsg(`Wallet authorization rejected or failed: ${message}`);
        setStage('REVIEW_READY');
        return;
      }
    }

    let latestSessionState: SweepSession = session;

    for (let i = 0; i < batchesToRun.length; i++) {
      const batch = batchesToRun[i];
      setActiveBatchIdx(batch.batchIndex);

      let userSignedBase64: string | undefined = preSignedMap.get(batch.batchId);

      try {
        if (mode === 'live') {
          if (!userSignedBase64) {
            setStage('WAITING_WALLET_AUTH');
            if (!signTransaction) {
              throw new Error(
                'Connected wallet does not support transaction signing (signTransaction).'
              );
            }
            if (!batch.serializedTransactionBase64) {
              throw new Error(
                'Batch does not contain a serialized transaction payload to sign.'
              );
            }

            const unsignedTx = VersionedTransaction.deserialize(
              Buffer.from(batch.serializedTransactionBase64, 'base64')
            );

            const signedTx = await signTransaction(unsignedTx);
            userSignedBase64 = Buffer.from(signedTx.serialize()).toString('base64');
          }
        } else {
          setStage('WAITING_WALLET_AUTH');
          // Explicit Demo Mode authorization step
          await new Promise((r) => setTimeout(r, 450));
        }

        setStage('EXECUTING_TRANSACTIONS');
        const execRes = await fetch('/api/sweep/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: session.sessionId,
            batchId: batch.batchId,
            walletAddress,
            network,
            userSignedTransactionBase64: userSignedBase64,
          }),
        });

        setStage('VERIFYING_CONFIRMATIONS');
        const execData = await execRes.json();

        if (!execRes.ok || !execData.ok) {
          throw new Error(execData.error || `Batch #${batch.batchIndex} execution failed`);
        }

        latestSessionState = execData.session;
        setSession(execData.session);
        setReceipt(execData.receipt);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setErrorMsg(`Batch #${batch.batchIndex}: ${message}`);
        // Failure isolation: allow user to inspect, retry, or continue remaining batches
        setStage('REVIEW_READY');
        return;
      }
    }

    if (latestSessionState.status === 'FAILED') {
      setErrorMsg('All attempted transaction batches failed or expired. Please refresh quotes and retry.');
      setStage('REVIEW_READY');
      return;
    }

    setStage('SWEEP_COMPLETE');
    onSweepCompleted();
  };

  const handleDownloadReceipt = () => {
    if (!receipt) return;
    const blob = new Blob([JSON.stringify(receipt, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `VACUUM-Receipt-${receipt.receiptId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const currentStageIndex = EXECUTION_STEPS.findIndex((s) =>
    stage === 'REVIEW_READY' ? s.id === 'BUILDING_BATCHES' : s.id === stage
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 overflow-y-auto">
      <div className="relative w-full max-w-2xl rounded-2xl bg-obsidian-900 border border-obsidian-700/80 shadow-2xl overflow-hidden my-8">
        {/* Top Ambient Header Bar */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-obsidian-800 bg-obsidian-950/60">
          <div className="flex items-center gap-3">
            <DestinationTokenIcon symbol={destinationSymbol} size={28} />
            <div>
              <h3 className="text-base font-semibold text-white flex items-center gap-2">
                {stage === 'SWEEP_COMPLETE'
                  ? 'SWEEP COMPLETE'
                  : `VACUUM Sweep Orchestrator → $${destinationSymbol}`}
                <span
                  className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded-full border ${
                    mode === 'demo'
                      ? 'bg-amber-500/10 text-amber-300 border-amber-500/30'
                      : network === 'mainnet-beta'
                        ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                        : 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30'
                  }`}
                >
                  {mode === 'demo' ? 'DEMO PREVIEW' : network.toUpperCase()}
                </span>
              </h3>
              <p className="text-xs text-slate-400">
                {session
                  ? `Session ID: ${session.sessionId} • ${session.batches.length} Transaction Batch(es)`
                  : 'Evaluating executable routes and sponsorship economics...'}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-obsidian-800 transition"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Real-Time 7-Stage Progress Bar */}
        <div className="px-6 py-3 bg-obsidian-950/90 border-b border-obsidian-800">
          <div className="grid grid-cols-7 gap-1.5">
            {EXECUTION_STEPS.map((step, idx) => {
              const isCompleted =
                stage === 'SWEEP_COMPLETE' || idx < currentStageIndex;
              const isCurrent = idx === currentStageIndex && stage !== 'SWEEP_COMPLETE';
              return (
                <div key={step.id} className="flex flex-col gap-1">
                  <div
                    className={`h-1.5 rounded-full transition-all duration-300 ${
                      isCompleted
                        ? 'bg-cyan-400'
                        : isCurrent
                          ? 'bg-ultraviolet-500 animate-pulse'
                          : 'bg-obsidian-800'
                    }`}
                  />
                  <span
                    className={`text-[10px] leading-tight truncate ${
                      isCompleted
                        ? 'text-cyan-300 font-medium'
                        : isCurrent
                          ? 'text-white font-semibold'
                          : 'text-slate-500'
                    }`}
                    title={step.label}
                  >
                    {step.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="p-6 max-h-[75vh] overflow-y-auto space-y-5">
          {/* Loading / Quote Construction State */}
          {(stage === 'SCANNING_ASSETS' ||
            stage === 'FINDING_LIQUIDITY' ||
            stage === 'BUILDING_BATCHES') && (
            <div className="py-12 flex flex-col items-center justify-center text-center space-y-3">
              <Loader2 className="w-10 h-10 text-ultraviolet-400 animate-spin" />
              <div className="text-base font-medium text-white">
                {EXECUTION_STEPS.find((s) => s.id === stage)?.label}...
              </div>
              <p className="text-xs text-slate-400 max-w-md">
                Querying executable routes, checking SPL / Token-2022 account rent reclamation,
                and grouping instructions within Solana&apos;s 1232-byte limit.
              </p>
            </div>
          )}

          {/* Active Signing / Execution State */}
          {(stage === 'WAITING_WALLET_AUTH' ||
            stage === 'EXECUTING_TRANSACTIONS' ||
            stage === 'VERIFYING_CONFIRMATIONS') && (
            <div className="py-10 flex flex-col items-center justify-center text-center space-y-4">
              <div className="w-14 h-14 rounded-2xl bg-ultraviolet-500/15 border border-ultraviolet-500/40 flex items-center justify-center">
                <Loader2 className="w-7 h-7 text-cyan-400 animate-spin" />
              </div>
              <div>
                <div className="text-lg font-semibold text-white">
                  {stage === 'WAITING_WALLET_AUTH' &&
                    `Waiting for Wallet Authorization (Batch #${activeBatchIdx})`}
                  {stage === 'EXECUTING_TRANSACTIONS' &&
                    `Executing Transaction Batch #${activeBatchIdx}`}
                  {stage === 'VERIFYING_CONFIRMATIONS' &&
                    `Verifying Blockchain Confirmation (Batch #${activeBatchIdx})`}
                </div>
                <p className="text-xs text-slate-400 mt-1 max-w-md">
                  {stage === 'WAITING_WALLET_AUTH'
                    ? 'Please review and approve the transaction prompt in your connected Solana wallet.'
                    : 'Submitting signed transaction and verifying on-chain finality before updating state.'}
                </p>
              </div>
            </div>
          )}

          {/* Error Banner */}
          {errorMsg && (
            <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 flex items-start gap-3">
              <XCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
              <div className="flex-1 text-xs text-rose-200">
                <div className="font-semibold text-rose-300 mb-0.5">
                  Execution or Routing Alert
                </div>
                {errorMsg}
              </div>
              <button
                onClick={() => initializeQuoteSession()}
                className="px-2.5 py-1 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 text-xs font-medium flex items-center gap-1"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Refresh Quotes
              </button>
            </div>
          )}

          {/* SWEEP REVIEW SCREEN */}
          {stage === 'REVIEW_READY' && session && (
            <>
              {/* Core 6 Review Metrics */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div className="p-3.5 rounded-xl bg-obsidian-950 border border-obsidian-800">
                  <div className="text-[11px] font-mono uppercase text-slate-400">
                    TOTAL ASSETS SELECTED
                  </div>
                  <div className="text-lg font-bold text-white mt-1">
                    {session.totalAssetsSelected} Accounts
                  </div>
                  <div className="text-[11px] text-slate-400">
                    {session.swapAssetsCount ?? session.totalAssetsSelected} Swap(s) •{' '}
                    {session.closeAccountsCount ?? 0} Rent Closure(s) ({session.batches.length} batch)
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-obsidian-950 border border-obsidian-800">
                  <div className="text-[11px] font-mono uppercase text-slate-400">
                    SWAP PROCEEDS VS RENT RECLAIM
                  </div>
                  <div className="text-lg font-bold text-white mt-1">
                    ${(session.expectedSwapOutputUsd ?? session.totalInputValueUsd).toFixed(2)}{' '}
                    <span className="text-xs font-normal text-slate-400">Swaps</span>
                  </div>
                  <div className="text-[11px] text-cyan-400 font-mono">
                    + {(session.expectedRentReclaimSol ?? session.sponsorshipEvaluation.reclaimableRentLamports / 1e9).toFixed(4)} SOL Rent (${(session.expectedRentReclaimUsd ?? 0).toFixed(2)})
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-obsidian-950 border border-ultraviolet-500/40">
                  <div className="text-[11px] font-mono uppercase text-ultraviolet-400">
                    EXPECTED DESTINATION OUTPUT
                  </div>
                  <div className="text-lg font-bold text-white mt-1">
                    {session.expectedDestinationOutputUi.toLocaleString()}{' '}
                    <span className="text-sm text-cyan-400">${session.destinationSymbol}</span>
                  </div>
                  <div className="text-[11px] text-slate-400">
                    ≈ ${session.expectedDestinationOutputUsd.toFixed(2)} USD
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-obsidian-950 border border-obsidian-800">
                  <div className="text-[11px] font-mono uppercase text-slate-400">
                    ESTIMATED NETWORK COST
                  </div>
                  <div className="text-base font-semibold text-white mt-1">
                    {session.sponsorshipEvaluation.eligible ? (
                      <span className="text-emerald-400 font-mono">$0.00 (Sponsored)</span>
                    ) : (
                      <span>${session.estimatedNetworkCostUsd.toFixed(4)}</span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-400">
                    Platform Fee: ${session.sponsorshipEvaluation.platformServiceFeeUsd.toFixed(4)} (
                    {(session.sponsorshipEvaluation.platformServiceFeeBps / 100).toFixed(2)}%)
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-obsidian-950 border border-obsidian-800">
                  <div className="text-[11px] font-mono uppercase text-slate-400">
                    SPONSORSHIP STATUS
                  </div>
                  <div className="text-sm font-semibold mt-1 flex items-center gap-1.5">
                    {session.sponsorshipEvaluation.eligible ? (
                      <span className="text-emerald-400 flex items-center gap-1">
                        <Zap className="w-4 h-4" /> Gasless Active
                      </span>
                    ) : (
                      <span className="text-amber-300">Self-Paid SOL</span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-400 truncate" title={session.sponsorshipEvaluation.reason}>
                    {session.sponsorshipEvaluation.eligible
                      ? 'Fee Payer covers SOL gas'
                      : session.sponsorshipEvaluation.reason}
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-obsidian-950 border border-cyan-500/30">
                  <div className="text-[11px] font-mono uppercase text-cyan-400">
                    ESTIMATED NET RESULT
                  </div>
                  <div className="text-lg font-bold text-emerald-400 mt-1">
                    ${session.estimatedNetResultUsd.toFixed(2)}
                  </div>
                  <div className="text-[11px] text-slate-400">
                    Net value after all costs
                  </div>
                </div>
              </div>

              {/* Slippage & Gasless Controls */}
              <div className="p-3.5 rounded-xl bg-obsidian-950/70 border border-obsidian-800 flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono uppercase text-slate-400">
                    SLIPPAGE SETTINGS:
                  </span>
                  {[50, 100, 250].map((bps) => (
                    <button
                      key={bps}
                      onClick={() => {
                        setSlippageBps(bps);
                        initializeQuoteSession(bps, requestSponsorship);
                      }}
                      className={`px-2.5 py-1 rounded-lg text-xs font-mono transition ${
                        slippageBps === bps
                          ? 'bg-ultraviolet-600 text-white font-semibold'
                          : 'bg-obsidian-800 text-slate-300 hover:bg-obsidian-700'
                      }`}
                    >
                      {(bps / 100).toFixed(1)}%
                    </button>
                  ))}
                </div>

                <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-300">
                  <input
                    type="checkbox"
                    checked={requestSponsorship}
                    onChange={(e) => {
                      const val = e.target.checked;
                      setRequestSponsorship(val);
                      initializeQuoteSession(slippageBps, val);
                    }}
                    className="rounded border-obsidian-700 bg-obsidian-900 text-ultraviolet-500"
                  />
                  <span>Request Gasless Fee Sponsorship</span>
                </label>
              </div>

              {/* Batch Breakdown & Failure Isolation Controls */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between text-xs text-slate-400 font-mono uppercase">
                  <span className="flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5 text-ultraviolet-400" />
                    Transaction Batches ({session.batches.length})
                  </span>
                  <span>Recipient: {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}</span>
                </div>

                <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                  {session.batches.map((b) => (
                    <div
                      key={b.batchId}
                      className="p-3 rounded-xl bg-obsidian-950 border border-obsidian-800 flex items-center justify-between gap-3"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono font-semibold text-white">
                            Batch #{b.batchIndex} of {b.totalBatches}
                          </span>
                          <span className="text-[11px] px-2 py-0.5 rounded bg-obsidian-800 text-slate-300 font-mono">
                            {b.items.map((i) => i.symbol).join(', ')}
                          </span>
                          <span className="text-[10px] font-mono text-slate-500">
                            ({b.estimatedBytes} B • {(b.estimatedComputeUnits / 1000).toFixed(0)}k CU)
                          </span>
                        </div>
                        <div className="text-[11px] text-slate-400 mt-1">
                          Expected Output:{' '}
                          <span className="text-cyan-300 font-mono">
                            {b.items
                              .reduce((s, i) => s + i.expectedOutputUi, 0)
                              .toFixed(4)}{' '}
                            ${session.destinationSymbol}
                          </span>{' '}
                          (Min:{' '}
                          {b.items
                            .reduce((s, i) => s + i.minOutputUi, 0)
                            .toFixed(4)}
                          )
                        </div>
                        {b.errorMessage && (
                          <div className="text-[11px] text-rose-400 mt-1">
                            Error: {b.errorMessage}
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        {b.status === 'CONFIRMED' && (
                          <span className="px-2 py-1 rounded bg-emerald-500/15 text-emerald-300 text-xs font-mono flex items-center gap-1">
                            <CheckCircle2 className="w-3.5 h-3.5" /> Confirmed
                          </span>
                        )}
                        {b.status === 'FAILED' && (
                          <button
                            onClick={() => handleExecuteBatchOrAll(b.batchId)}
                            className="px-2.5 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 text-xs font-medium flex items-center gap-1"
                          >
                            <RefreshCw className="w-3 h-3" /> Retry Batch
                          </button>
                        )}
                        {b.status === 'PENDING_SIGNATURE' && (
                          <span className="text-xs font-mono text-slate-400">
                            Ready to Sign
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Skipped Assets Notice */}
              {session.skippedAssets.length > 0 && (
                <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200">
                  <div className="font-semibold mb-1 flex items-center gap-1.5">
                    <AlertTriangle className="w-4 h-4 text-amber-400" />
                    Isolated & Skipped Unsupported Tokens ({session.skippedAssets.length})
                  </div>
                  {session.skippedAssets.map((s) => (
                    <div key={s.mintAddress} className="text-[11px] text-amber-300/90">
                      • {s.symbol}: {s.reason}
                    </div>
                  ))}
                </div>
              )}

              {/* High-Risk Token Explicit Acknowledgement Gate */}
              {highRiskAssets.length > 0 && (
                <label className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={acknowledgedHighRisk}
                    onChange={(e) => setAcknowledgedHighRisk(e.target.checked)}
                    className="mt-1 rounded border-rose-500/50 bg-obsidian-900"
                  />
                  <span className="text-xs text-rose-200">
                    I acknowledge that {highRiskAssets.map((a) => a.symbol).join(', ')}{' '}
                    flagged elevated risk signals (freeze authority or transfer hooks) and
                    authorize including them in this sweep.
                  </span>
                </label>
              )}

              {/* Mandatory Quote Disclaimer */}
              <div className="text-[11px] text-slate-400 bg-obsidian-950/60 p-3 rounded-xl border border-obsidian-800 flex items-start gap-2">
                <ShieldCheck className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
                <span>
                  Quoted output amounts are real-time estimates based on current DEX pool depth and
                  can change before on-chain execution. Minimum output is protected by your{' '}
                  {(slippageBps / 100).toFixed(2)}% slippage tolerance. You will explicitly authorize
                  every transaction batch in your wallet.
                </span>
              </div>

              {/* Action Footer */}
              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  onClick={onClose}
                  className="px-4 py-2.5 rounded-xl bg-obsidian-800 hover:bg-obsidian-700 text-slate-300 text-sm font-medium transition"
                >
                  Cancel
                </button>
                <button
                  disabled={highRiskAssets.length > 0 && !acknowledgedHighRisk}
                  onClick={() => handleExecuteBatchOrAll()}
                  className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-ultraviolet-600 to-cyan-500 hover:from-ultraviolet-500 hover:to-cyan-400 disabled:opacity-40 text-white text-sm font-semibold shadow-lg shadow-ultraviolet-600/25 flex items-center gap-2 transition"
                >
                  <Sparkles className="w-4 h-4" />
                  {mode === 'demo'
                    ? `Authorize Demo Sweep (${session.batches.length} Batch)`
                    : `Authorize & Execute Sweep (${session.batches.length} Batch)`}
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </>
          )}

          {/* COMPLETION SCREEN */}
          {stage === 'SWEEP_COMPLETE' && session && receipt && (
            <div className="space-y-6 py-2">
              <div className="text-center space-y-2">
                <div
                  className={`w-16 h-16 rounded-2xl flex items-center justify-center mx-auto border ${
                    session.status === 'PARTIAL_SUCCESS'
                      ? 'bg-amber-500/15 border-amber-500/40'
                      : 'bg-emerald-500/15 border-emerald-500/40'
                  }`}
                >
                  {session.status === 'PARTIAL_SUCCESS' ? (
                    <AlertTriangle className="w-9 h-9 text-amber-400" />
                  ) : (
                    <CheckCircle2 className="w-9 h-9 text-emerald-400" />
                  )}
                </div>
                <h4 className="text-2xl font-bold text-white tracking-tight">
                  {session.status === 'PARTIAL_SUCCESS'
                    ? 'PARTIAL SWEEP COMPLETE'
                    : 'SWEEP COMPLETE'}
                </h4>
                <p className="text-xs text-slate-400">
                  {mode === 'demo'
                    ? 'Demo Mode Simulation Complete — Connect a live wallet to execute real on-chain transactions.'
                    : `Verified on Solana ${network.toUpperCase()} • Receipt ${receipt.receiptId}`}
                </p>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div className="p-3.5 rounded-xl bg-obsidian-950 border border-obsidian-800">
                  <div className="text-[11px] font-mono text-slate-400">
                    TOTAL ASSETS PROCESSED
                  </div>
                  <div className="text-lg font-bold text-white mt-1">
                    {receipt.totalAssetsSwept} / {receipt.totalAssetsAttempted}
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-obsidian-950 border border-obsidian-800">
                  <div className="text-[11px] font-mono text-slate-400">
                    TOTAL VALUE CONVERTED
                  </div>
                  <div className="text-lg font-bold text-emerald-400 mt-1">
                    ${receipt.totalValueConvertedUsd.toFixed(2)}
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-obsidian-950 border border-ultraviolet-500/40">
                  <div className="text-[11px] font-mono text-ultraviolet-300">
                    FINAL DESTINATION AMOUNT
                  </div>
                  <div className="text-lg font-bold text-white mt-1">
                    {receipt.finalDestinationAmountUi.toLocaleString()} ${receipt.destinationSymbol}
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-obsidian-950 border border-obsidian-800">
                  <div className="text-[11px] font-mono text-slate-400">
                    SUCCESSFUL TRANSACTIONS
                  </div>
                  <div className="text-base font-bold text-cyan-400 mt-1">
                    {receipt.batches.filter((b) => b.status === 'CONFIRMED').length} Batches
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-obsidian-950 border border-obsidian-800">
                  <div className="text-[11px] font-mono text-slate-400">
                    SKIPPED OR FAILED ASSETS
                  </div>
                  <div className="text-base font-bold text-slate-300 mt-1">
                    {receipt.totalAssetsFailedOrSkipped}
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-obsidian-950 border border-obsidian-800">
                  <div className="text-[11px] font-mono text-slate-400">
                    FEES SPONSORED
                  </div>
                  <div className="text-base font-bold text-emerald-400 mt-1">
                    {(receipt.totalSponsoredLamports / 1e9).toFixed(5)} SOL
                  </div>
                </div>
              </div>

              {/* Expandable Receipt Details */}
              {showReceiptView && (
                <div className="p-4 rounded-xl bg-obsidian-950 border border-obsidian-800 space-y-2 text-xs font-mono">
                  <div className="flex items-center justify-between text-slate-300 font-semibold border-b border-obsidian-800 pb-2">
                    <span>CRYPTOGRAPHIC RECEIPT ({receipt.receiptId})</span>
                    <button
                      onClick={handleDownloadReceipt}
                      className="text-cyan-400 hover:underline flex items-center gap-1"
                    >
                      <Download className="w-3.5 h-3.5" /> Export JSON
                    </button>
                  </div>
                  <div className="text-slate-400 break-all">
                    Wallet: {receipt.walletAddress}
                  </div>
                  <div className="text-slate-400 break-all">
                    SHA-256 Verification Hash: {receipt.verificationHash}
                  </div>
                  {receipt.batches.map((b) => (
                    <div
                      key={b.batchNumber}
                      className="pt-1.5 border-t border-obsidian-800/70 flex items-center justify-between"
                    >
                      <span>
                        Batch #{b.batchNumber} ({b.inputSymbols.join(', ')}) → {b.outputUi}{' '}
                        ${receipt.destinationSymbol}
                      </span>
                      {b.explorerUrl ? (
                        <a
                          href={b.explorerUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-cyan-400 hover:underline flex items-center gap-1"
                        >
                          Solscan <ExternalLink className="w-3 h-3" />
                        </a>
                      ) : (
                        <span className="text-amber-300">{b.signature}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Completion CTAs: VIEW RECEIPT, VIEW ON SOLSCAN, SWEEP AGAIN */}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
                <div className="flex flex-wrap items-center gap-2.5">
                  <button
                    onClick={() => setShowReceiptView(!showReceiptView)}
                    className="px-4 py-2.5 rounded-xl bg-obsidian-800 hover:bg-obsidian-700 text-white text-xs font-mono font-semibold flex items-center gap-1.5 transition"
                  >
                    <FileText className="w-4 h-4 text-cyan-400" />
                    VIEW RECEIPT
                  </button>

                  {receipt.batches.find((b) => b.explorerUrl) ? (
                    <a
                      href={receipt.batches.find((b) => b.explorerUrl)!.explorerUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-4 py-2.5 rounded-xl bg-obsidian-800 hover:bg-obsidian-700 text-cyan-300 text-xs font-mono font-semibold flex items-center gap-1.5 transition"
                    >
                      VIEW ON SOLSCAN <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  ) : (
                    <a
                      href={`https://solscan.io/account/${walletAddress}${
                        network === 'devnet' ? '?cluster=devnet' : ''
                      }`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-4 py-2.5 rounded-xl bg-obsidian-800 hover:bg-obsidian-700 text-cyan-300 text-xs font-mono font-semibold flex items-center gap-1.5 transition"
                    >
                      VIEW ON SOLSCAN <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  )}
                </div>

                <button
                  onClick={onClose}
                  className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-ultraviolet-600 to-cyan-500 hover:from-ultraviolet-500 hover:to-cyan-400 text-white text-xs font-mono font-bold uppercase tracking-wider transition"
                >
                  SWEEP AGAIN
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
