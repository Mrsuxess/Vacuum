import { describe, it, expect, beforeEach } from 'vitest';
import { PricingService } from '@/services/pricingService';
import { TokenRiskService } from '@/services/tokenRiskService';
import { LiquidityService } from '@/services/liquidityService';
import { JupiterService } from '@/services/jupiterService';
import { TransactionBatcher } from '@/services/transactionBatcher';
import { SponsorshipService } from '@/services/sponsorshipService';
import { SweepOrchestrator } from '@/services/sweepOrchestrator';
import { VacuumTokenService } from '@/services/vacuumTokenService';
import { resetTestDb } from '@/lib/db';
import {
  DEFAULT_DUST_THRESHOLD_CONFIG,
  SOLANA_TX_MAX_BYTES,
  SOL_MINT_ADDRESS,
} from '@/lib/config';
import { SweepQuoteItem, TransactionBatch } from '@/types/vacuum';

describe('VACUUM Core Unit Tests', () => {
  beforeEach(() => {
    process.env.VITEST = 'true';
    resetTestDb();
  });

  describe('1. Token Balance Normalization & USD Valuation', () => {
    it('normalizes raw token balances accurately across decimals', () => {
      expect(PricingService.normalizeBalance('1000000000', 9)).toBeCloseTo(1.0, 6);
      expect(PricingService.normalizeBalance('2500000', 6)).toBeCloseTo(2.5, 6);
      expect(PricingService.normalizeBalance('0', 6)).toBe(0);
      expect(PricingService.toRawAmount(1.5, 6)).toBe('1500000');
    });

    it('calculates USD value and handles null/invalid prices safely', () => {
      expect(PricingService.calculateUsdValue(10, 2.45)).toBeCloseTo(24.5, 4);
      expect(PricingService.calculateUsdValue(100, null)).toBeNull();
    });
  });

  describe('2. Token Risk Assessment & Dust Classification', () => {
    it('flags phishing URLs in token names as CRITICAL and blocks sweeping', () => {
      const risk = TokenRiskService.assessTokenRisk({
        mintAddress: 'ScamMint11111111111111111111111111111111111',
        symbol: 'CLAIM-SOL.COM',
        name: 'Visit https://scam-drop.xyz to claim',
        hasMintAuthority: true,
        hasFreezeAuthority: true,
        isToken2022: false,
        hasTransferFeeOrHook: false,
        priceImpactPct: null,
        hasViableRoute: false,
        estimatedValueUsd: 50,
      });

      expect(risk.riskLevel).toBe('CRITICAL');
      expect(risk.canSweepSafely).toBe(false);
    });

    it('distinguishes between Valuable Assets, Recoverable Dust, and Unroutable Dust', () => {
      const safeRisk = TokenRiskService.assessTokenRisk({
        mintAddress: SOL_MINT_ADDRESS,
        symbol: 'BONK',
        name: 'Bonk',
        hasMintAuthority: false,
        hasFreezeAuthority: false,
        isToken2022: false,
        hasTransferFeeOrHook: false,
        priceImpactPct: 0.15,
        hasViableRoute: true,
        estimatedValueUsd: 2.1,
      });

      const recoverable = LiquidityService.classifyAsset(
        {
          mintAddress: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
          uiBalance: 100,
          estimatedValueUsd: 2.1,
          reclaimableRentUsd: 0.37,
          liquidityStatus: 'HIGH',
          hasViableRoute: true,
          expectedOutputUsd: 2.09,
          estimatedNetworkCostUsd: 0.003,
          priceImpactPct: 0.15,
          risk: safeRisk,
          isDestinationAsset: false,
        },
        DEFAULT_DUST_THRESHOLD_CONFIG
      );

      expect(recoverable.category).toBe('POTENTIAL_DUST');
      expect(recoverable.isPotentialDust).toBe(true);
      expect(recoverable.isRecoverableDust).toBe(true);
      expect(recoverable.estimatedNetRecoveryUsd).toBeGreaterThan(2.4);

      const unroutable = LiquidityService.classifyAsset(
        {
          mintAddress: 'DeadMint11111111111111111111111111111111111',
          uiBalance: 5000,
          estimatedValueUsd: 1.5,
          reclaimableRentUsd: 0.37,
          liquidityStatus: 'NONE',
          hasViableRoute: false,
          expectedOutputUsd: 0,
          estimatedNetworkCostUsd: 0.003,
          priceImpactPct: null,
          risk: safeRisk,
          isDestinationAsset: false,
        },
        DEFAULT_DUST_THRESHOLD_CONFIG
      );

      expect(unroutable.isPotentialDust).toBe(true);
      expect(unroutable.isRecoverableDust).toBe(false);
      expect(unroutable.category).toBe('NO_VIABLE_ROUTE');
    });
  });

  describe('3. Quote Validation', () => {
    it('validates positive output, price impact thresholds, and quote expiration', () => {
      const validOrder = {
        mode: 'ultra',
        router: 'metis',
        requestId: 'req-123',
        inAmount: '100000',
        outAmount: '50000',
        otherAmountThreshold: '49500',
        swapMode: 'ExactIn',
        slippageBps: 100,
        priceImpactPct: '0.45',
        routePlan: [],
        transaction: 'AgAAAA==',
        expireAt: Date.now() + 30_000,
      };
      expect(JupiterService.validateOrderQuote(validOrder, 5.0).valid).toBe(true);

      const highImpactOrder = { ...validOrder, priceImpactPct: '14.5' };
      expect(JupiterService.validateOrderQuote(highImpactOrder, 5.0).valid).toBe(false);

      const expiredOrder = { ...validOrder, expireAt: Date.now() - 1_000 };
      expect(JupiterService.validateOrderQuote(expiredOrder, 5.0).valid).toBe(false);
    });
  });

  describe('4. Intelligent Batch Grouping (34 Swaps Split Safely)', () => {
    it('never packs 34 swaps into a single Solana transaction and respects byte/CU limits', () => {
      const thirtyFourItems: SweepQuoteItem[] = Array.from({ length: 34 }, (_, idx) => ({
        mintAddress: `Mint${idx}111111111111111111111111111111111111`,
        tokenAccountAddress: `Acc${idx}1111111111111111111111111111111111111`,
        symbol: `TOK${idx}`,
        name: `Token ${idx}`,
        decimals: 6,
        inputRawAmount: '1000000',
        inputUiAmount: 1,
        inputValueUsd: 0.85,
        destinationMint: SOL_MINT_ADDRESS,
        destinationSymbol: 'SOL',
        expectedOutputRaw: '4500000',
        expectedOutputUi: 0.0045,
        minOutputRaw: '4450000',
        minOutputUi: 0.00445,
        expectedOutputUsd: 0.84,
        priceImpactPct: 0.2,
        routerLabel: 'Solana Devnet Consolidator',
        estimatedComputeUnits: 55_000,
        estimatedTransactionBytes: 135,
        accountCount: 4,
        usesLookupTable: false,
        quoteExpiresAt: Date.now() + 60_000,
        actionType: 'DEVNET_SWAP_AND_RECLAIM',
      }));

      const batches = TransactionBatcher.groupQuoteItemsIntoBatches(thirtyFourItems, {
        sessionId: 'vac_test34',
        walletAddress: 'Wa11et1111111111111111111111111111111111111',
        network: 'devnet',
        sponsorPublicKey: null,
        sponsorshipApplied: false,
        solPriceUsd: 185.4,
      });

      expect(batches.length).toBeGreaterThanOrEqual(6);
      for (const b of batches) {
        expect(b.items.length).toBeLessThanOrEqual(6);
        expect(b.estimatedBytes).toBeLessThanOrEqual(SOLANA_TX_MAX_BYTES);
      }
    });
  });

  describe('5. Sponsorship Eligibility & Economic Viability', () => {
    it('approves economically viable sweeps and rejects sweeps below minimum value', () => {
      const viable = SponsorshipService.evaluateSponsorshipEligibility({
        walletAddress: 'Wa11etViable1111111111111111111111111111111',
        network: 'devnet',
        estimatedLiquidationUsd: 4.5,
        batchCount: 1,
        requiresDestinationAtaCreation: false,
        reclaimableRentLamports: 2_039_280,
        solPriceUsd: 185.4,
      });
      expect(viable.eligible).toBe(true);
      expect(viable.estimatedNetRecoveryUsd).toBeGreaterThan(4.0);

      const tooSmall = SponsorshipService.evaluateSponsorshipEligibility({
        walletAddress: 'Wa11etTiny111111111111111111111111111111111',
        network: 'devnet',
        estimatedLiquidationUsd: 0.01,
        batchCount: 1,
        requiresDestinationAtaCreation: false,
        reclaimableRentLamports: 0,
        solPriceUsd: 185.4,
      });
      expect(tooSmall.eligible).toBe(false);
    });
  });

  describe('6. Transaction Status Transitions & $VACUUM Mint Integrity', () => {
    it('computes COMPLETED, PARTIAL_SUCCESS, and FAILED accurately across batches', () => {
      const mockBatch = (status: TransactionBatch['status']): TransactionBatch => ({
        batchId: 'b1',
        sessionId: 's1',
        batchIndex: 1,
        totalBatches: 2,
        items: [],
        serializedTransactionBase64: null,
        estimatedFeeLamports: 15000,
        estimatedFeeUsd: 0.002,
        estimatedComputeUnits: 50000,
        estimatedBytes: 300,
        sponsorshipApplied: true,
        sponsorPublicKey: null,
        status,
        createdAt: '',
        updatedAt: '',
        expiresAt: Date.now() + 60000,
      });

      expect(
        SweepOrchestrator.computeSessionStatusFromBatches([
          mockBatch('CONFIRMED'),
          mockBatch('CONFIRMED'),
        ])
      ).toBe('COMPLETED');

      expect(
        SweepOrchestrator.computeSessionStatusFromBatches([
          mockBatch('CONFIRMED'),
          mockBatch('FAILED'),
        ])
      ).toBe('PARTIAL_SUCCESS');

      expect(
        SweepOrchestrator.computeSessionStatusFromBatches([
          mockBatch('FAILED'),
          mockBatch('EXPIRED'),
        ])
      ).toBe('FAILED');
    });

    it('never invents an unverified mainnet mint address for $VACUUM when unset', () => {
      delete process.env.NEXT_PUBLIC_VACUUM_TOKEN_MINT;
      const destinations = VacuumTokenService.getSupportedDestinations('mainnet-beta');
      const vac = destinations.find((d) => d.symbol === 'VACUUM')!;
      expect(vac.isFlagship).toBe(true);
      expect(vac.mintAddress).toBeNull();
      expect(vac.isConfiguredForNetwork).toBe(false);
    });
  });
});
