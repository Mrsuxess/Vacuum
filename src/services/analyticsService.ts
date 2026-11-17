import { PlatformAnalyticsSummary } from '@/types/vacuum';
import { HistoryService } from '@/services/historyService';

export class AnalyticsService {
  /**
   * Computes authentic historical sweep statistics from persisted sweep sessions.
   * Never fabricates portfolio statistics.
   */
  static getAnalyticsSummary(walletAddress?: string): PlatformAnalyticsSummary {
    const sessions = HistoryService.listWalletSessions(walletAddress, 100);

    let totalValueSweptUsd = 0;
    let totalVacuumAcquiredUi = 0;
    let totalTokensCleaned = 0;
    let totalSuccessfulSweeps = 0;
    let totalFeesSponsoredLamports = 0;
    let totalFeesSponsoredUsd = 0;
    let estimatedNetValueRecoveredUsd = 0;

    for (const s of sessions) {
      if (s.status === 'COMPLETED' || s.status === 'PARTIAL_SUCCESS') {
        totalSuccessfulSweeps += 1;

        for (const b of s.batches) {
          if (b.status === 'CONFIRMED') {
            totalTokensCleaned += b.items.length;
            const batchUsd = b.items.reduce((acc, i) => acc + i.expectedOutputUsd, 0);
            totalValueSweptUsd += batchUsd;
            estimatedNetValueRecoveredUsd += batchUsd - (b.sponsorshipApplied ? 0 : b.estimatedFeeUsd);

            if (s.destinationSymbol === 'VACUUM') {
              totalVacuumAcquiredUi += b.items.reduce(
                (acc, i) => acc + i.expectedOutputUi,
                0
              );
            }

            if (b.sponsorshipApplied) {
              totalFeesSponsoredLamports += b.estimatedFeeLamports;
              totalFeesSponsoredUsd += b.estimatedFeeUsd;
            }
          }
        }
      }
    }

    return {
      walletAddress,
      totalValueSweptUsd: Number(totalValueSweptUsd.toFixed(2)),
      totalVacuumAcquiredUi: Number(totalVacuumAcquiredUi.toFixed(2)),
      totalTokensCleaned,
      totalSuccessfulSweeps,
      totalFeesSponsoredLamports,
      totalFeesSponsoredUsd: Number(totalFeesSponsoredUsd.toFixed(4)),
      estimatedNetValueRecoveredUsd: Number(estimatedNetValueRecoveredUsd.toFixed(2)),
      recentSessions: sessions.slice(0, 15),
    };
  }
}
