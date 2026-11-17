import {
  AssetCategory,
  DustThresholdConfig,
  LiquidityStatus,
  TokenRiskAssessment,
} from '@/types/vacuum';
import { DEFAULT_DUST_THRESHOLD_CONFIG } from '@/lib/config';

export interface ClassificationInput {
  mintAddress: string;
  uiBalance: number;
  estimatedValueUsd: number | null;
  reclaimableRentUsd: number;
  liquidityStatus: LiquidityStatus;
  hasViableRoute: boolean;
  expectedOutputUsd: number;
  estimatedNetworkCostUsd: number;
  priceImpactPct: number | null;
  risk: TokenRiskAssessment;
  isDestinationAsset: boolean;
}

export interface ClassificationResult {
  category: AssetCategory;
  isPotentialDust: boolean;
  isRecoverableDust: boolean;
  estimatedNetRecoveryUsd: number;
}

export class LiquidityService {
  /**
   * Classifies a discovered token asset into one of the 7 canonical VACUUM categories
   * and distinguishes between Potential Dust Value and Actually Recoverable Value.
   */
  static classifyAsset(
    input: ClassificationInput,
    thresholdConfig: DustThresholdConfig = DEFAULT_DUST_THRESHOLD_CONFIG
  ): ClassificationResult {
    const valueUsd = input.estimatedValueUsd ?? 0;

    // Net economic recovery = expected swap output + reclaimable account rent - network cost
    const grossProceedsUsd =
      input.hasViableRoute && input.expectedOutputUsd > 0
        ? input.expectedOutputUsd + input.reclaimableRentUsd
        : input.uiBalance === 0
          ? input.reclaimableRentUsd
          : 0;

    const estimatedNetRecoveryUsd = Number(
      (grossProceedsUsd - input.estimatedNetworkCostUsd).toFixed(4)
    );

    // 1. Critical security / phishing / unsupported freeze-trap tokens
    if (!input.risk.canSweepSafely || input.risk.riskLevel === 'CRITICAL') {
      return {
        category: 'SUSPICIOUS_UNSUPPORTED',
        isPotentialDust: false,
        isRecoverableDust: false,
        estimatedNetRecoveryUsd: 0,
      };
    }

    // 2. Non-zero balance with no viable swap route
    if (input.uiBalance > 0 && (input.liquidityStatus === 'NONE' || !input.hasViableRoute)) {
      const withinDustCap = !input.isDestinationAsset && valueUsd <= thresholdConfig.maxUsdValue;
      return {
        category:
          input.liquidityStatus === 'LOW' ? 'INSUFFICIENT_LIQUIDITY' : 'NO_VIABLE_ROUTE',
        isPotentialDust: withinDustCap,
        isRecoverableDust: false,
        estimatedNetRecoveryUsd: 0,
      };
    }

    // 3. High-risk tokens or Token-2022 transfer hooks requiring manual inspection
    if (input.risk.hasTransferFeeOrHook || input.risk.riskLevel === 'HIGH') {
      const withinDustCap = valueUsd > 0 && valueUsd <= thresholdConfig.maxUsdValue;
      return {
        category: 'REQUIRES_INSPECTION',
        isPotentialDust: withinDustCap,
        isRecoverableDust:
          withinDustCap &&
          input.hasViableRoute &&
          estimatedNetRecoveryUsd >= thresholdConfig.minNetRecoveryUsd,
        estimatedNetRecoveryUsd: Math.max(0, estimatedNetRecoveryUsd),
      };
    }

    // 3. Zero-balance closeable token account (pure rent reclamation)
    if (input.uiBalance === 0) {
      if (
        thresholdConfig.includeZeroBalanceCloseableAccounts &&
        input.reclaimableRentUsd > input.estimatedNetworkCostUsd
      ) {
        return {
          category: 'POTENTIAL_DUST',
          isPotentialDust: true,
          isRecoverableDust: true,
          estimatedNetRecoveryUsd: Number(
            (input.reclaimableRentUsd - input.estimatedNetworkCostUsd).toFixed(4)
          ),
        };
      }
      return {
        category: 'NO_VIABLE_ROUTE',
        isPotentialDust: false,
        isRecoverableDust: false,
        estimatedNetRecoveryUsd: 0,
      };
    }

    // 4. Valuable established assets above the dust threshold
    if (valueUsd > thresholdConfig.maxUsdValue) {
      if (valueUsd >= 25.0 || input.risk.isKnownVerified) {
        return {
          category: 'VALUABLE_ESTABLISHED',
          isPotentialDust: false,
          isRecoverableDust: false,
          estimatedNetRecoveryUsd,
        };
      }
      return {
        category: 'SMALL_BALANCE',
        isPotentialDust: false,
        isRecoverableDust: false,
        estimatedNetRecoveryUsd,
      };
    }

    // 5. Token balance is <= dust threshold (or unpriced micro-balance)
    const isPotentialDust = !input.isDestinationAsset && valueUsd <= thresholdConfig.maxUsdValue;

    if (input.liquidityStatus === 'NONE' || !input.hasViableRoute) {
      return {
        category:
          input.liquidityStatus === 'LOW' ? 'INSUFFICIENT_LIQUIDITY' : 'NO_VIABLE_ROUTE',
        isPotentialDust,
        isRecoverableDust: false,
        estimatedNetRecoveryUsd: 0,
      };
    }

    if (
      input.priceImpactPct !== null &&
      input.priceImpactPct > thresholdConfig.maxPriceImpactPct
    ) {
      return {
        category: 'INSUFFICIENT_LIQUIDITY',
        isPotentialDust,
        isRecoverableDust: false,
        estimatedNetRecoveryUsd: Math.max(0, estimatedNetRecoveryUsd),
      };
    }

    // Check positive net economics for actual recoverability
    const isRecoverableDust =
      isPotentialDust &&
      input.hasViableRoute &&
      estimatedNetRecoveryUsd >= thresholdConfig.minNetRecoveryUsd;

    if (!isRecoverableDust) {
      return {
        category: 'INSUFFICIENT_LIQUIDITY',
        isPotentialDust,
        isRecoverableDust: false,
        estimatedNetRecoveryUsd: Math.max(0, estimatedNetRecoveryUsd),
      };
    }

    return {
      category: 'POTENTIAL_DUST',
      isPotentialDust: true,
      isRecoverableDust: true,
      estimatedNetRecoveryUsd,
    };
  }
}
