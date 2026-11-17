import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ComputeBudgetProgram,
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  createCloseAccountInstruction,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { getDb, resetTestDb } from '@/lib/db';
import { ApiSecurity } from '@/lib/apiSecurity';
import {
  DEVNET_KNOWN_SPONSOR_PUBKEY,
  SOL_MINT_ADDRESS,
  TOKEN_ACCOUNT_RENT_LAMPORTS,
  USDC_DEVNET_MINT,
  USDC_MAINNET_MINT,
} from '@/lib/config';
import { SponsorshipService } from '@/services/sponsorshipService';
import { SweepOrchestrator } from '@/services/sweepOrchestrator';
import { QuoteService } from '@/services/quoteService';
import { JupiterService } from '@/services/jupiterService';
import { TransactionVerificationService } from '@/services/transactionVerificationService';
import { LiquidityService } from '@/services/liquidityService';
import { TokenRiskService } from '@/services/tokenRiskService';
import { DiscoveredTokenAsset } from '@/types/vacuum';

function buildAsset(overrides: Partial<DiscoveredTokenAsset> = {}): DiscoveredTokenAsset {
  const mintAddress = overrides.mintAddress || Keypair.generate().publicKey.toBase58();
  const tokenAccountAddress =
    overrides.tokenAccountAddress || Keypair.generate().publicKey.toBase58();
  const symbol = overrides.symbol || 'TOK';
  const name = overrides.name || 'Test Token';
  const isToken2022 = overrides.isToken2022 ?? false;

  const risk =
    overrides.risk ||
    TokenRiskService.assessTokenRisk({
      mintAddress,
      symbol,
      name,
      hasMintAuthority: false,
      hasFreezeAuthority: false,
      isToken2022,
      hasTransferFeeOrHook: false,
      priceImpactPct: 0.2,
      hasViableRoute: true,
      estimatedValueUsd: 2.0,
    });

  return {
    tokenAccountAddress,
    mintAddress,
    programId: isToken2022 ? TOKEN_2022_PROGRAM_ID.toBase58() : TOKEN_PROGRAM_ID.toBase58(),
    isToken2022,
    name,
    symbol,
    decimals: 6,
    rawBalance: '2000000',
    uiBalance: 2.0,
    estimatedPriceUsd: 1.0,
    estimatedValueUsd: 2.0,
    reclaimableRentLamports: TOKEN_ACCOUNT_RENT_LAMPORTS,
    reclaimableRentUsd: 0.378,
    liquidityStatus: 'HIGH',
    hasViableRoute: true,
    category: 'POTENTIAL_DUST',
    isPotentialDust: true,
    isRecoverableDust: true,
    estimatedNetRecoveryUsd: 1.98,
    risk,
    ...overrides,
  };
}

describe('PHASE 12 — Mainnet Migration, Network Isolation & Production Readiness Suite', () => {
  let userKp: Keypair;
  let mainnetSponsorKp: Keypair;

  beforeEach(() => {
    process.env.VITEST = 'true';
    resetTestDb();
    ApiSecurity.resetRateLimits();
    userKp = Keypair.generate();
    mainnetSponsorKp = Keypair.generate();

    delete process.env.SERVER_ENFORCED_NETWORK;
    delete process.env.MAINNET_SPONSORSHIP_ENABLED;
    delete process.env.SPONSOR_MAINNET_FEE_PAYER_SECRET_KEY;
    delete process.env.SPONSOR_DEVNET_FEE_PAYER_SECRET_KEY;
    delete process.env.SPONSOR_FEE_PAYER_SECRET_KEY;
    delete process.env.NEXT_PUBLIC_VACUUM_TOKEN_MINT;
    delete process.env.NEXT_PUBLIC_VACUUM_DEVNET_MINT;
    process.env.SPONSORSHIP_ENABLED = 'true';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. MAINNET NETWORK & CREDENTIAL ISOLATION
  // =========================================================================
  describe('1. Cross-Network Isolation & Credential Separation', () => {
    it('strictly refuses to load the Devnet sponsor keypair on mainnet-beta', () => {
      // Even if someone accidentally copies ./data/devnet-sponsor-keypair.json into SPONSOR_FEE_PAYER_SECRET_KEY,
      // mainnet-beta must reject it!
      const devKp = SponsorshipService.getServerSponsorKeypair('devnet');
      expect(devKp).not.toBeNull();
      expect(devKp!.publicKey.toBase58()).toBe(DEVNET_KNOWN_SPONSOR_PUBKEY);

      process.env.SPONSOR_FEE_PAYER_SECRET_KEY = bs58.encode(devKp!.secretKey);
      const mainnetAttempt = SponsorshipService.getServerSponsorKeypair('mainnet-beta');
      expect(mainnetAttempt).toBeNull();
    });

    it('keeps Mainnet gasless sponsorship disabled by default until MAINNET_SPONSORSHIP_ENABLED=true', () => {
      process.env.SPONSOR_MAINNET_FEE_PAYER_SECRET_KEY = bs58.encode(mainnetSponsorKp.secretKey);
      // MAINNET_SPONSORSHIP_ENABLED is not set (defaults to false)
      const evalDisabled = SponsorshipService.evaluateSponsorshipEligibility({
        walletAddress: userKp.publicKey.toBase58(),
        network: 'mainnet-beta',
        estimatedLiquidationUsd: 5.0,
        batchCount: 1,
        requiresDestinationAtaCreation: false,
        reclaimableRentLamports: TOKEN_ACCOUNT_RENT_LAMPORTS,
        solPriceUsd: 185.4,
      });
      expect(evalDisabled.eligible).toBe(false);
      expect(evalDisabled.mode).toBe('USER_SELF_PAID');
      expect(evalDisabled.reason).toMatch(/MAINNET_SPONSORSHIP_ENABLED=false/);

      // Once explicitly enabled by administrator:
      process.env.MAINNET_SPONSORSHIP_ENABLED = 'true';
      const evalEnabled = SponsorshipService.evaluateSponsorshipEligibility({
        walletAddress: userKp.publicKey.toBase58(),
        network: 'mainnet-beta',
        estimatedLiquidationUsd: 5.0,
        batchCount: 1,
        requiresDestinationAtaCreation: false,
        reclaimableRentLamports: TOKEN_ACCOUNT_RENT_LAMPORTS,
        solPriceUsd: 185.4,
      });
      expect(evalEnabled.eligible).toBe(true);
      expect(evalEnabled.sponsorPublicKey).toBe(mainnetSponsorKp.publicKey.toBase58());
    });

    it('blocks frontend network override when SERVER_ENFORCED_NETWORK is set', () => {
      process.env.SERVER_ENFORCED_NETWORK = 'devnet';
      expect(ApiSecurity.validateNetwork('devnet')).toBe('devnet');
      expect(() => ApiSecurity.validateNetwork('mainnet-beta')).toThrow(
        /Network isolation violation: server is locked to "devnet"/
      );
    });

    it('rejects Devnet token mints and Devnet-discovered accounts when submitted to a Mainnet quote session', async () => {
      const walletAddr = userKp.publicKey.toBase58();

      // 1. Asset using Devnet USDC mint on mainnet-beta
      const devnetUsdcOnMainnet = buildAsset({
        mintAddress: USDC_DEVNET_MINT,
        symbol: 'USDC-Dev',
      });

      // 2. Asset discovered on devnet replayed against mainnet-beta
      const devnetDiscoveredAsset = buildAsset({
        symbol: 'REPLAY_DEV',
      });
      getDb()
        .prepare(
          `INSERT INTO discovered_assets (
            id, wallet_address, network, token_account_address, mint_address,
            symbol, name, decimals, raw_balance, ui_balance,
            estimated_value_usd, reclaimable_rent_lamports, liquidity_status,
            category, is_recoverable_dust
          ) VALUES (?, ?, 'devnet', ?, ?, 'REPLAY_DEV', 'Replay Token', 6, '2000000', 2.0, 2.0, 2039280, 'HIGH', 'POTENTIAL_DUST', 1)`
        )
        .run(
          `${walletAddr}:devnet:${devnetDiscoveredAsset.tokenAccountAddress}`,
          walletAddr,
          devnetDiscoveredAsset.tokenAccountAddress,
          devnetDiscoveredAsset.mintAddress
        );

      const res = await QuoteService.buildExecutableQuotes({
        walletAddress: walletAddr,
        network: 'mainnet-beta',
        mode: 'live',
        selectedAssets: [devnetUsdcOnMainnet, devnetDiscoveredAsset],
        destinationSymbol: 'SOL',
        slippageBps: 100,
        sponsorPublicKey: null,
      });

      expect(res.quoteItems).toHaveLength(0);
      expect(res.skippedAssets).toHaveLength(2);
      expect(res.skippedAssets[0].reason).toMatch(/Devnet USDC mint .* cannot be used on mainnet-beta/);
      expect(res.skippedAssets[1].reason).toMatch(/Cross-network asset replay blocked/);
    });

    it('rejects cross-network batch execution when session network and execute request network differ', async () => {
      const session = await SweepOrchestrator.createSweepSession({
        walletAddress: userKp.publicKey.toBase58(),
        network: 'devnet',
        mode: 'demo',
        selectedAssets: [buildAsset()],
        destinationSymbol: 'SOL',
        slippageBps: 100,
        requestGaslessSponsorship: false,
      });

      await expect(
        SweepOrchestrator.executeAuthorizedBatch({
          sessionId: session.sessionId,
          batchId: session.batches[0].batchId,
          network: 'mainnet-beta',
        })
      ).rejects.toThrow(/Network isolation violation: session .* is bound to devnet/);
    });
  });

  // =========================================================================
  // 2. MAINNET TOKEN DISCOVERY & RENT RECLAMATION SAFETY
  // =========================================================================
  describe('2. Mainnet Discovery Classification, Rent Destination & Priority Fee Caps', () => {
    it('does not classify non-zero illiquid Mainnet tokens as recoverable merely because of account rent', () => {
      const lowLiqMint = Keypair.generate().publicKey.toBase58();
      const risk = TokenRiskService.assessTokenRisk({
        mintAddress: lowLiqMint,
        symbol: 'ILLIQ',
        name: 'Illiquid Microcap',
        hasMintAuthority: false,
        hasFreezeAuthority: false,
        isToken2022: false,
        hasTransferFeeOrHook: false,
        priceImpactPct: null,
        hasViableRoute: false,
        estimatedValueUsd: 0.5,
      });

      // On Mainnet, non-zero tokens cannot be burned just to reclaim rent, so classificationRentUsd = 0
      const res = LiquidityService.classifyAsset({
        mintAddress: lowLiqMint,
        uiBalance: 100,
        estimatedValueUsd: 0.5,
        reclaimableRentUsd: 0,
        liquidityStatus: 'LOW',
        hasViableRoute: false,
        expectedOutputUsd: 0,
        estimatedNetworkCostUsd: 0.002,
        priceImpactPct: null,
        risk,
        isDestinationAsset: false,
      });

      expect(res.category).toBe('INSUFFICIENT_LIQUIDITY');
      expect(res.isPotentialDust).toBe(true);
      expect(res.isRecoverableDust).toBe(false);
      expect(res.estimatedNetRecoveryUsd).toBe(0);
    });

    it('rejects any CloseAccount instruction that redirects reclaimed rent away from the user wallet', () => {
      const attackerKp = Keypair.generate();
      const tokenAccountPubkey = Keypair.generate().publicKey;

      // Construct a transaction where CloseAccount sends rent to attackerKp instead of userKp
      const maliciousCloseMsg = new TransactionMessage({
        payerKey: mainnetSponsorKp.publicKey,
        recentBlockhash: '11111111111111111111111111111111',
        instructions: [
          createCloseAccountInstruction(
            tokenAccountPubkey,
            attackerKp.publicKey, // Hijacked rent destination!
            userKp.publicKey,
            [],
            TOKEN_PROGRAM_ID
          ),
        ],
      }).compileToV0Message();

      const maliciousTx = new VersionedTransaction(maliciousCloseMsg);
      maliciousTx.sign([userKp]);

      const check = TransactionVerificationService.verifyCloseAccountRentDestination(
        maliciousTx,
        userKp.publicKey.toBase58()
      );
      expect(check.valid).toBe(false);
      expect(check.reason).toMatch(/CloseAccount rent refund destination .* does not match authorized user wallet/);
    });

    it('blocks sponsored transactions with excessive ComputeBudget priority fees', () => {
      // Set ComputeUnitPrice to 5,000,000 microLamports (above 250,000 default cap)
      const excessivePriorityMsg = new TransactionMessage({
        payerKey: mainnetSponsorKp.publicKey,
        recentBlockhash: '11111111111111111111111111111111',
        instructions: [
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000_000 }),
          SystemProgram.transfer({
            fromPubkey: userKp.publicKey,
            toPubkey: userKp.publicKey,
            lamports: 0,
          }),
        ],
      }).compileToV0Message();

      const tx = new VersionedTransaction(excessivePriorityMsg);
      tx.sign([userKp]);

      const safety = TransactionVerificationService.validateSponsorInstructionSafety(
        tx,
        mainnetSponsorKp.publicKey,
        userKp.publicKey.toBase58()
      );
      expect(safety.safe).toBe(false);
      expect(safety.reason).toMatch(/Priority fee .* exceeds maximum allowed sponsor limit/);
    });
  });

  // =========================================================================
  // 3. MAINNET JUPITER V2 ORDER + EMPTY ATA CLOSURE ORCHESTRATION
  // =========================================================================
  describe('3. Mainnet Jupiter V2 Multi-Order + Empty Account Closure Orchestration', () => {
    it('isolates each Mainnet Jupiter V2 order into its own batch while grouping empty ATA closures and separating Swap Proceeds vs Rent Reclamation', async () => {
      const bonkAsset = buildAsset({
        mintAddress: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
        symbol: 'BONK',
        decimals: 5,
        rawBalance: '10000000',
        uiBalance: 100,
      });
      const wifAsset = buildAsset({
        mintAddress: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
        symbol: 'WIF',
        decimals: 6,
        rawBalance: '1500000',
        uiBalance: 1.5,
      });
      const emptyAta1 = buildAsset({
        symbol: 'EMPTY1',
        rawBalance: '0',
        uiBalance: 0,
        estimatedValueUsd: 0,
      });
      const emptyAta2 = buildAsset({
        symbol: 'EMPTY2',
        isToken2022: true,
        rawBalance: '0',
        uiBalance: 0,
        estimatedValueUsd: 0,
      });

      const makeMockJupiterTx = () => {
        const msg = new TransactionMessage({
          payerKey: userKp.publicKey,
          recentBlockhash: '11111111111111111111111111111111',
          instructions: [
            SystemProgram.transfer({
              fromPubkey: userKp.publicKey,
              toPubkey: userKp.publicKey,
              lamports: 100,
            }),
          ],
        }).compileToV0Message();
        return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
      };

      vi.spyOn(JupiterService, 'getOrder')
        .mockResolvedValueOnce({
          mode: 'ultra',
          router: 'metis',
          requestId: 'jup-main-bonk-1',
          inAmount: '10000000',
          outAmount: '2400000', // 2.40 USDC
          otherAmountThreshold: '2376000',
          swapMode: 'ExactIn',
          slippageBps: 100,
          priceImpactPct: '0.12',
          routePlan: [],
          transaction: makeMockJupiterTx(),
          expireAt: Date.now() + 45_000,
        })
        .mockResolvedValueOnce({
          mode: 'ultra',
          router: 'jupiterz',
          requestId: 'jup-main-wif-2',
          inAmount: '1500000',
          outAmount: '3600000', // 3.60 USDC
          otherAmountThreshold: '3564000',
          swapMode: 'ExactIn',
          slippageBps: 100,
          priceImpactPct: '0.08',
          routePlan: [],
          transaction: makeMockJupiterTx(),
          expireAt: Date.now() + 45_000,
        });

      const session = await SweepOrchestrator.createSweepSession({
        walletAddress: userKp.publicKey.toBase58(),
        network: 'mainnet-beta',
        mode: 'live',
        selectedAssets: [bonkAsset, wifAsset, emptyAta1, emptyAta2],
        destinationSymbol: 'USDC',
        slippageBps: 100,
        requestGaslessSponsorship: true, // Default Mainnet policy disables sponsorship -> USER_SELF_PAID
      });

      expect(session.network).toBe('mainnet-beta');
      expect(session.destinationMint).toBe(USDC_MAINNET_MINT);
      expect(session.totalAssetsSelected).toBe(4);
      expect(session.swapAssetsCount).toBe(2);
      expect(session.closeAccountsCount).toBe(2);
      // 3 batches total: Batch #1 = BONK (Jupiter V2), Batch #2 = WIF (Jupiter V2), Batch #3 = EMPTY1 + EMPTY2 (Composite CloseAccount)
      expect(session.batches).toHaveLength(3);
      expect(session.batches[0].jupiterRequestId).toBe('jup-main-bonk-1');
      expect(session.batches[1].jupiterRequestId).toBe('jup-main-wif-2');
      expect(session.batches[2].jupiterRequestId).toBeUndefined();
      expect(session.batches[2].items).toHaveLength(2);

      // Swap proceeds ($6.00 USDC) and Rent Reclamation (~0.004078 SOL) are separated accurately
      expect(session.expectedSwapOutputUsd).toBeCloseTo(6.0, 2);
      expect(session.expectedRentReclaimSol).toBeCloseTo(0.004079, 5);
      expect(session.expectedRentReclaimUsd).toBeGreaterThan(0.7);
    });
  });
});
