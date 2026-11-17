import crypto from 'crypto';
import { SweepReceipt, SweepSession } from '@/types/vacuum';
import { getDb } from '@/lib/db';
import { SweepOrchestrator } from '@/services/sweepOrchestrator';
import { TransactionVerificationService } from '@/services/transactionVerificationService';

export class HistoryService {
  /**
   * Lists sweep sessions for a specific wallet address (or recent sessions within bounded limit).
   */
  static listWalletSessions(walletAddress?: string, limit: number = 25): SweepSession[] {
    const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 25)));
    const db = getDb();
    const rows = walletAddress
      ? (db
          .prepare(
            `SELECT session_id FROM sweep_sessions
             WHERE wallet_address = ?
             ORDER BY created_at DESC LIMIT ?`
          )
          .all(walletAddress.trim(), safeLimit) as Array<{ session_id: string }>)
      : (db
          .prepare(
            `SELECT session_id FROM sweep_sessions
             ORDER BY created_at DESC LIMIT ?`
          )
          .all(safeLimit) as Array<{ session_id: string }>);

    const sessions: SweepSession[] = [];
    for (const r of rows) {
      const s = SweepOrchestrator.getSessionById(r.session_id);
      if (s) sessions.push(s);
    }
    return sessions;
  }

  /**
   * Generates a deterministic, exportable SweepReceipt for a session.
   */
  static generateSessionReceipt(sessionId: string): SweepReceipt {
    const session = SweepOrchestrator.getSessionById(sessionId);
    if (!session) {
      throw new Error(`Cannot generate receipt: session ${sessionId} not found`);
    }

    const confirmedBatches = session.batches.filter((b) => b.status === 'CONFIRMED');
    const sweptAssetsCount = confirmedBatches.reduce((sum, b) => sum + b.items.length, 0);
    const failedAssetsCount =
      session.totalAssetsSelected - sweptAssetsCount + session.skippedAssets.length;

    const totalConvertedUsd = Number(
      confirmedBatches
        .reduce(
          (sum, b) => sum + b.items.reduce((isum, i) => isum + i.expectedOutputUsd, 0),
          0
        )
        .toFixed(4)
    );

    const totalNetworkFeesLamports = confirmedBatches.reduce(
      (sum, b) => sum + (b.actualFeeLamports ?? b.estimatedFeeLamports),
      0
    );
    const totalSponsoredLamports = confirmedBatches
      .filter((b) => b.sponsorshipApplied)
      .reduce((sum, b) => sum + (b.actualFeeLamports ?? b.estimatedFeeLamports), 0);

    const batchSummaries = session.batches.map((b) => {
      const isLiveSignature =
        b.signature && !b.signature.startsWith('DEMO_SIMULATION_ONLY_');
      return {
        batchNumber: b.batchIndex,
        status: b.status,
        signature: b.signature,
        explorerUrl: isLiveSignature
          ? TransactionVerificationService.getExplorerUrl(b.signature!, session.network)
          : undefined,
        inputSymbols: b.items.map((i) => i.symbol),
        outputUi: Number(
          b.items.reduce((sum, i) => sum + i.expectedOutputUi, 0).toFixed(6)
        ),
        failureReason: b.errorMessage,
      };
    });

    const payloadToHash = JSON.stringify({
      sessionId: session.sessionId,
      walletAddress: session.walletAddress,
      network: session.network,
      mode: session.mode,
      finalOutput: session.actualDestinationOutputUi,
      signatures: batchSummaries.map((b) => b.signature || b.status),
    });

    const verificationHash = crypto
      .createHash('sha256')
      .update(payloadToHash)
      .digest('hex');

    return {
      receiptId: `rcpt_${session.sessionId.replace(/^vac_/, '')}`,
      sessionId: session.sessionId,
      walletAddress: session.walletAddress,
      network: session.network,
      mode: session.mode,
      timestamp: session.completedAt || session.createdAt,
      destinationSymbol: session.destinationSymbol,
      destinationMint: session.destinationMint,
      totalAssetsAttempted:
        session.totalAssetsSelected + session.skippedAssets.length,
      totalAssetsSwept: sweptAssetsCount,
      totalAssetsFailedOrSkipped: failedAssetsCount,
      totalValueConvertedUsd: totalConvertedUsd,
      finalDestinationAmountUi: session.actualDestinationOutputUi,
      totalNetworkFeesLamports,
      totalSponsoredLamports,
      platformFeeUsd: session.sponsorshipEvaluation.platformServiceFeeUsd,
      batches: batchSummaries,
      verificationHash,
    };
  }
}
