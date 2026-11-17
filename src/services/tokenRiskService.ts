import {
  RiskLevel,
  TokenRiskAssessment,
  TokenRiskSignal,
} from '@/types/vacuum';
import { SOL_MINT_ADDRESS, USDC_DEVNET_MINT, USDC_MAINNET_MINT } from '@/lib/config';

export interface TokenRiskInput {
  mintAddress: string;
  symbol: string;
  name: string;
  hasMintAuthority: boolean;
  hasFreezeAuthority: boolean;
  isToken2022: boolean;
  hasTransferFeeOrHook: boolean;
  isFrozen?: boolean;
  isNonTransferable?: boolean;
  hasWithheldTransferFees?: boolean;
  hasPermanentDelegate?: boolean;
  hasThirdPartyCloseAuthority?: boolean;
  priceImpactPct: number | null;
  hasViableRoute: boolean;
  estimatedValueUsd: number | null;
}

const KNOWN_VERIFIED_MINTS = new Set<string>([
  SOL_MINT_ADDRESS,
  USDC_MAINNET_MINT,
  USDC_DEVNET_MINT,
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', // JUP
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', // WIF
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', // RAY
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // JitoSOL
]);

const SUSPICIOUS_METADATA_PATTERNS = [
  /claim\s+reward/i,
  /airdrop.*visit/i,
  /https?:\/\//i,
  /\.com\b|\.io\b|\.xyz\b|\.org\b/i,
  /free\s+sol/i,
  /voucher/i,
];

export class TokenRiskService {
  /**
   * Evaluates on-chain and market signals for a token.
   * Never claims a token is guaranteed safe; surfaces transparent risk signals
   * and quarantines frozen, non-transferable, withheld-fee-locked, or phishing assets.
   */
  static assessTokenRisk(input: TokenRiskInput): TokenRiskAssessment {
    const signals: TokenRiskSignal[] = [];
    let riskScore = 0;

    const isKnownVerified = KNOWN_VERIFIED_MINTS.has(input.mintAddress);

    // 1. Frozen Token Account check (blocks all transfers, burns, and CloseAccount)
    if (input.isFrozen) {
      riskScore += 100;
      signals.push({
        code: 'ACCOUNT_FROZEN',
        severity: 'CRITICAL',
        label: 'Frozen Token Account',
        description:
          'This token account is frozen on-chain by the mint freeze authority. Transfers, burns, and closures will fail.',
      });
    }

    // 2. Non-Transferable (Soulbound) Token-2022 extension check
    if (input.isNonTransferable) {
      riskScore += 100;
      signals.push({
        code: 'TOKEN_2022_NON_TRANSFERABLE',
        severity: 'CRITICAL',
        label: 'Non-Transferable Token-2022 Asset',
        description:
          'This Token-2022 asset uses the NonTransferable extension and cannot be swapped on DEX pools.',
      });
    }

    // 3. Token-2022 Unharvested Withheld Transfer Fees check (blocks CloseAccount until harvested)
    if (input.hasWithheldTransferFees) {
      riskScore += 85;
      signals.push({
        code: 'TOKEN_2022_WITHHELD_FEES',
        severity: 'CRITICAL',
        label: 'Unharvested Token-2022 Withheld Fees',
        description:
          'Token-2022 account holds unharvested withheld transfer fees, which blocks standard account closure.',
      });
    }

    // 4. Suspicious phishing metadata check (e.g. URL in token name/symbol)
    const combinedText = `${input.name} ${input.symbol}`;
    const hasPhishingPattern = SUSPICIOUS_METADATA_PATTERNS.some((regex) =>
      regex.test(combinedText)
    );
    if (hasPhishingPattern) {
      riskScore += 80;
      signals.push({
        code: 'SUSPICIOUS_METADATA_URL',
        severity: 'CRITICAL',
        label: 'Phishing / Scam Metadata Indicator',
        description:
          'Token name or symbol contains URL or claim-bait text commonly used by scam airdrops.',
      });
    }

    // 5. Token-2022 Permanent Delegate check
    if (input.hasPermanentDelegate) {
      riskScore += 45;
      signals.push({
        code: 'TOKEN_2022_PERMANENT_DELEGATE',
        severity: 'HIGH',
        label: 'Token-2022 Permanent Delegate Active',
        description:
          'Mint configures a Permanent Delegate that has unconditional transfer/burn authority over token accounts.',
      });
    }

    // 6. Third-Party Close Authority check
    if (input.hasThirdPartyCloseAuthority) {
      riskScore += 45;
      signals.push({
        code: 'THIRD_PARTY_CLOSE_AUTHORITY',
        severity: 'HIGH',
        label: 'External Close Authority Assigned',
        description:
          'A third-party address holds close authority on this token account.',
      });
    }

    // 7. Freeze Authority check
    if (input.hasFreezeAuthority && !isKnownVerified) {
      riskScore += 40;
      signals.push({
        code: 'ACTIVE_FREEZE_AUTHORITY',
        severity: 'HIGH',
        label: 'Active Freeze Authority',
        description:
          'The mint authority retains the ability to freeze token accounts, which may block transfers or swaps.',
      });
    }

    // 8. Mint Authority check
    if (input.hasMintAuthority && !isKnownVerified) {
      riskScore += 15;
      signals.push({
        code: 'ACTIVE_MINT_AUTHORITY',
        severity: 'MEDIUM',
        label: 'Mutable Supply (Mint Authority Active)',
        description:
          'New tokens can still be minted by the authority, risking sudden dilution.',
      });
    }

    // 9. Token-2022 Transfer Hook / Transfer Fee check
    if (input.isToken2022 && input.hasTransferFeeOrHook) {
      riskScore += 40;
      signals.push({
        code: 'TOKEN_2022_TRANSFER_RESTRICTION',
        severity: 'HIGH',
        label: 'Token-2022 Transfer Fee / Hook',
        description:
          'This Token-2022 asset enforces transfer fees or custom hooks that may alter swap output or fail execution.',
      });
    } else if (input.isToken2022) {
      signals.push({
        code: 'TOKEN_2022_STANDARD',
        severity: 'LOW',
        label: 'Token-2022 Program Asset',
        description: 'Uses Solana Token Extensions (Token-2022) program.',
      });
    }

    // 10. Price Impact check
    if (input.priceImpactPct !== null) {
      if (input.priceImpactPct > 15) {
        riskScore += 45;
        signals.push({
          code: 'EXTREME_PRICE_IMPACT',
          severity: 'HIGH',
          label: `Extreme Price Impact (${input.priceImpactPct.toFixed(2)}%)`,
          description:
            'Shallow pool liquidity causes severe slippage when swapping this balance.',
        });
      } else if (input.priceImpactPct > 5) {
        riskScore += 20;
        signals.push({
          code: 'ELEVATED_PRICE_IMPACT',
          severity: 'MEDIUM',
          label: `Elevated Price Impact (${input.priceImpactPct.toFixed(2)}%)`,
          description: 'Route exhibits noticeable price impact above 5%.',
        });
      }
    }

    // 11. Unverified / Unknown Liquidity check
    if (!input.hasViableRoute && (input.estimatedValueUsd ?? 0) > 0) {
      riskScore += 25;
      signals.push({
        code: 'NO_EXECUTABLE_LIQUIDITY',
        severity: 'MEDIUM',
        label: 'No Executable DEX Route',
        description:
          'Nominal price may exist, but no executable swap route with viable depth was found.',
      });
    }

    const clampedScore = Math.min(100, riskScore);
    const hasCriticalSignal = signals.some((s) => s.severity === 'CRITICAL');
    const hasHighSignal = signals.some((s) => s.severity === 'HIGH');

    let riskLevel: RiskLevel = 'LOW';
    if (clampedScore >= 70 || hasCriticalSignal) {
      riskLevel = 'CRITICAL';
    } else if (clampedScore >= 40 || hasHighSignal) {
      riskLevel = 'HIGH';
    } else if (clampedScore >= 15) {
      riskLevel = 'MEDIUM';
    }

    const canSweepSafely = riskLevel !== 'CRITICAL';
    const requiresUserAcknowledgement = riskLevel === 'HIGH' || riskLevel === 'CRITICAL';

    return {
      mintAddress: input.mintAddress,
      riskLevel,
      riskScore: clampedScore,
      hasMintAuthority: input.hasMintAuthority,
      hasFreezeAuthority: input.hasFreezeAuthority,
      isToken2022: input.isToken2022,
      hasTransferFeeOrHook: input.hasTransferFeeOrHook,
      isFrozen: Boolean(input.isFrozen),
      isNonTransferable: Boolean(input.isNonTransferable),
      hasWithheldTransferFees: Boolean(input.hasWithheldTransferFees),
      hasPermanentDelegate: Boolean(input.hasPermanentDelegate),
      hasThirdPartyCloseAuthority: Boolean(input.hasThirdPartyCloseAuthority),
      isKnownVerified,
      priceImpactPct: input.priceImpactPct,
      signals,
      canSweepSafely,
      requiresUserAcknowledgement,
    };
  }
}
