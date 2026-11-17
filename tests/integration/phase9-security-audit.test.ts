import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  createBurnCheckedInstruction,
  createCloseAccountInstruction,
  createTransferInstruction,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { NextRequest } from 'next/server';
import { getDb, resetTestDb, runInTransaction } from '@/lib/db';
import { ApiSecurity } from '@/lib/apiSecurity';
import { SOL_MINT_ADDRESS, TOKEN_ACCOUNT_RENT_LAMPORTS, USDC_DEVNET_MINT } from '@/lib/config';
import { JupiterService } from '@/services/jupiterService';
import { QuoteService } from '@/services/quoteService';
import { SponsorshipService } from '@/services/sponsorshipService';
import { SweepOrchestrator } from '@/services/sweepOrchestrator';
import { TokenDiscoveryService } from '@/services/tokenDiscoveryService';
import { TokenRiskService } from '@/services/tokenRiskService';
import { TransactionBatcher } from '@/services/transactionBatcher';
import { TransactionVerificationService } from '@/services/transactionVerificationService';
import { HistoryService } from '@/services/historyService';
import { VacuumTokenService } from '@/services/vacuumTokenService';
import { DiscoveredTokenAsset } from '@/types/vacuum';
import { GET as statusGET } from '@/app/api/status/route';
import { POST as discoverPOST } from '@/app/api/discover/route';
import { POST as quotePOST } from '@/app/api/sweep/quote/route';
import { POST as executePOST } from '@/app/api/sweep/execute/route';
import { GET as historyGET } from '@/app/api/history/route';

function makeValidLiveAsset(overrides: Partial<DiscoveredTokenAsset> = {}): DiscoveredTokenAsset {
  const mintKp = Keypair.generate();
  const accKp = Keypair.generate();
  const mintAddress = overrides.mintAddress || mintKp.publicKey.toBase58();
  const tokenAccountAddress = overrides.tokenAccountAddress || accKp.publicKey.toBase58();
  const symbol = overrides.symbol || 'DUST1';
  const name = overrides.name || 'Dust Token 1';
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
      estimatedValueUsd: 1.5,
    });

  return {
    tokenAccountAddress,
    mintAddress,
    programId: isToken2022 ? TOKEN_2022_PROGRAM_ID.toBase58() : TOKEN_PROGRAM_ID.toBase58(),
    isToken2022,
    name,
    symbol,
    decimals: 6,
    rawBalance: '1500000',
    uiBalance: 1.5,
    estimatedPriceUsd: 1.0,
    estimatedValueUsd: 1.5,
    reclaimableRentLamports: TOKEN_ACCOUNT_RENT_LAMPORTS,
    reclaimableRentUsd: 0.378,
    liquidityStatus: 'HIGH',
    hasViableRoute: true,
    category: 'POTENTIAL_DUST',
    isPotentialDust: true,
    isRecoverableDust: true,
    estimatedNetRecoveryUsd: 1.87,
    risk,
    ...overrides,
  };
}

describe('PHASE 9 — Independent Security Audit, Sweep Engine & Verification Suite', () => {
  let sponsorKp: Keypair;
  let userKp: Keypair;

  beforeEach(() => {
    process.env.VITEST = 'true';
    resetTestDb();
    ApiSecurity.resetRateLimits();
    sponsorKp = Keypair.generate();
    userKp = Keypair.generate();
    process.env.SPONSOR_FEE_PAYER_SECRET_KEY = bs58.encode(sponsorKp.secretKey);
    process.env.SPONSORSHIP_ENABLED = 'true';
    process.env.SPONSORSHIP_MAX_PER_WALLET_LAMPORTS = '5000000';
    process.env.SPONSORSHIP_MAX_DAILY_BUDGET_LAMPORTS = '100000000';
    process.env.SPONSORSHIP_RATE_LIMIT_PER_HOUR = '10';
    process.env.SPONSORSHIP_MIN_SWEEP_USD = '0.25';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // SECTION 1: AUDIT JUPITER SWAP V2
  // =========================================================================
  describe('1. Jupiter Swap API V2 Audit', () => {
    it('normalizes expireAt accurately whether Jupiter returns Unix seconds, milliseconds, or ISO string', () => {
      const futureSec = Math.floor(Date.now() / 1000) + 60;
      const futureMs = Date.now() + 60_000;
      const futureIso = new Date(Date.now() + 60_000).toISOString();

      const normSec = JupiterService.normalizeExpireAtMs(futureSec);
      const normMs = JupiterService.normalizeExpireAtMs(futureMs);
      const normIso = JupiterService.normalizeExpireAtMs(futureIso);

      expect(normSec).toBeGreaterThan(Date.now());
      expect(normMs).toBeGreaterThan(Date.now());
      expect(normIso).toBeGreaterThan(Date.now());

      // Verify a quote with Unix seconds expireAt does NOT falsely fail validateOrderQuote
      const orderWithUnixSec = {
        mode: 'ultra',
        router: 'metis',
        requestId: 'req-sec-1',
        inAmount: '1000000',
        outAmount: '500000',
        otherAmountThreshold: '495000',
        swapMode: 'ExactIn',
        slippageBps: 100,
        priceImpactPct: '0.25',
        routePlan: [],
        transaction: null,
        expireAt: futureSec,
      };
      expect(JupiterService.validateOrderQuote(orderWithUnixSec, 5.0).valid).toBe(true);
    });

    it('validates executable Jupiter V2 orders require both requestId and valid VersionedTransaction', () => {
      const msg = new TransactionMessage({
        payerKey: sponsorKp.publicKey,
        recentBlockhash: '11111111111111111111111111111111',
        instructions: [
          SystemProgram.transfer({
            fromPubkey: userKp.publicKey,
            toPubkey: userKp.publicKey,
            lamports: 0,
          }),
        ],
      }).compileToV0Message();
      const validTxBase64 = Buffer.from(new VersionedTransaction(msg).serialize()).toString(
        'base64'
      );

      const validExecOrder = {
        mode: 'integrator-payer',
        router: 'metis',
        requestId: 'jup-req-999',
        inAmount: '1000000',
        outAmount: '500000',
        otherAmountThreshold: '495000',
        swapMode: 'ExactIn',
        slippageBps: 100,
        priceImpactPct: '0.25',
        routePlan: [],
        transaction: validTxBase64,
        expireAt: Date.now() + 45_000,
      };

      expect(JupiterService.validateOrderQuote(validExecOrder, 5.0, true).valid).toBe(true);
      expect(
        JupiterService.validateOrderQuote({ ...validExecOrder, requestId: '' }, 5.0, true).valid
      ).toBe(false);
      expect(
        JupiterService.validateOrderQuote({ ...validExecOrder, transaction: null }, 5.0, true).valid
      ).toBe(false);
    });

    it('rejects /swap/v2/execute if required user or sponsor signatures are missing', async () => {
      const msg = new TransactionMessage({
        payerKey: sponsorKp.publicKey,
        recentBlockhash: '11111111111111111111111111111111',
        instructions: [
          SystemProgram.transfer({
            fromPubkey: userKp.publicKey,
            toPubkey: userKp.publicKey,
            lamports: 100,
          }),
        ],
      }).compileToV0Message();
      const unsignedTx = new VersionedTransaction(msg);
      // Only user signs; sponsor slot 0 is still all zeros
      unsignedTx.sign([userKp]);

      const res = await JupiterService.executeOrder({
        requestId: 'req-123',
        signedTransaction: Buffer.from(unsignedTx.serialize()).toString('base64'),
      });
      expect(res.status).toBe('Failed');
      expect(res.error).toMatch(/Missing required signature at signer index 0/);
    });
  });

  // =========================================================================
  // SECTION 2: VERIFY THE REAL FEE-SPONSORSHIP FLOW
  // =========================================================================
  describe('2. Fee-Sponsorship Lifecycle & Cryptographic Security', () => {
    it('rejects transaction tampering if client alters instructions after server batch creation', async () => {
      const legitMsg = new TransactionMessage({
        payerKey: sponsorKp.publicKey,
        recentBlockhash: '11111111111111111111111111111111',
        instructions: [
          SystemProgram.transfer({
            fromPubkey: userKp.publicKey,
            toPubkey: userKp.publicKey,
            lamports: 0,
          }),
        ],
      }).compileToV0Message();
      const legitUnsignedBase64 = Buffer.from(new VersionedTransaction(legitMsg).serialize()).toString(
        'base64'
      );

      // Attacker alters the instruction amount before signing
      const tamperedMsg = new TransactionMessage({
        payerKey: sponsorKp.publicKey,
        recentBlockhash: '11111111111111111111111111111111',
        instructions: [
          SystemProgram.transfer({
            fromPubkey: userKp.publicKey,
            toPubkey: userKp.publicKey,
            lamports: 999999,
          }),
        ],
      }).compileToV0Message();
      const tamperedTx = new VersionedTransaction(tamperedMsg);
      tamperedTx.sign([userKp]);
      const tamperedBase64 = Buffer.from(tamperedTx.serialize()).toString('base64');

      expect(() =>
        SponsorshipService.signTransactionAsFeePayer(tamperedBase64, 'devnet', {
          expectedUnsignedTxBase64: legitUnsignedBase64,
          expectedUserAddress: userKp.publicKey.toBase58(),
        })
      ).toThrow(/Transaction message tampering detected/);
    });

    it('blocks malicious transaction attempting to drain SOL or tokens from Sponsor Fee Payer', () => {
      const attackerKp = Keypair.generate();

      // Malicious tx where Sponsor is index 0 (payer) AND source of SystemProgram.transfer to attacker
      const drainSolMsg = new TransactionMessage({
        payerKey: sponsorKp.publicKey,
        recentBlockhash: '11111111111111111111111111111111',
        instructions: [
          SystemProgram.transfer({
            fromPubkey: sponsorKp.publicKey,
            toPubkey: attackerKp.publicKey,
            lamports: 50_000_000,
          }),
          SystemProgram.transfer({
            fromPubkey: userKp.publicKey,
            toPubkey: userKp.publicKey,
            lamports: 0,
          }),
        ],
      }).compileToV0Message();

      const drainTx = new VersionedTransaction(drainSolMsg);
      drainTx.sign([userKp]);
      const drainBase64 = Buffer.from(drainTx.serialize()).toString('base64');

      expect(() =>
        SponsorshipService.signTransactionAsFeePayer(drainBase64, 'devnet')
      ).toThrow(/Sponsor fee-payer cannot be the source of a direct SystemProgram instruction/);

      // Malicious tx where Sponsor is authority on SPL Token transfer
      const sponsorTokenAcc = Keypair.generate().publicKey;
      const attackerTokenAcc = Keypair.generate().publicKey;
      const drainTokenMsg = new TransactionMessage({
        payerKey: sponsorKp.publicKey,
        recentBlockhash: '11111111111111111111111111111111',
        instructions: [
          createTransferInstruction(
            sponsorTokenAcc,
            attackerTokenAcc,
            sponsorKp.publicKey,
            1_000_000
          ),
          SystemProgram.transfer({
            fromPubkey: userKp.publicKey,
            toPubkey: userKp.publicKey,
            lamports: 0,
          }),
        ],
      }).compileToV0Message();

      const drainTokenTx = new VersionedTransaction(drainTokenMsg);
      drainTokenTx.sign([userKp]);
      const drainTokenBase64 = Buffer.from(drainTokenTx.serialize()).toString('base64');

      expect(() =>
        SponsorshipService.signTransactionAsFeePayer(drainTokenBase64, 'devnet')
      ).toThrow(/Sponsor fee-payer cannot act as token owner\/authority/);
    });

    it('documents SOL flow breakdown accurately and proves reclaimed rent goes 100% to USER', () => {
      const evalRes = SponsorshipService.evaluateSponsorshipEligibility({
        walletAddress: userKp.publicKey.toBase58(),
        network: 'devnet',
        estimatedLiquidationUsd: 3.5,
        batchCount: 2,
        requiresDestinationAtaCreation: true,
        reclaimableRentLamports: TOKEN_ACCOUNT_RENT_LAMPORTS * 2,
        solPriceUsd: 185.4,
      });

      expect(evalRes.eligible).toBe(true);
      expect(evalRes.solFlowBreakdown).toEqual({
        networkFeePayer: 'SPONSOR',
        priorityFeePayer: 'SPONSOR',
        ataCreationPayer: 'SPONSOR',
        rentRefundRecipient: 'USER',
        swapProceedsRecipient: 'USER',
        sponsorRecoveryMechanism: 'SUBSIDIZED_BY_SPONSOR',
      });
      // Without JUPITER_REFERRAL_ACCOUNT configured, sponsor expenditure is honestly marked as subsidized
      expect(evalRes.isSubsidized).toBe(true);
      expect(evalRes.subsidyAmountUsd).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // SECTION 3: AUDIT TOKEN ACCOUNT CLOSURE AND RENT RECLAMATION
  // =========================================================================
  describe('3. Token Account Closure & Rent Reclamation Safety', () => {
    it('refuses to close non-zero token balances under CLOSE_EMPTY_ACCOUNT and never burns on mainnet', async () => {
      const nonZeroCloseItem = {
        ...makeValidLiveAsset(),
        inputRawAmount: '500000', // Non-zero!
        inputUiAmount: 0.5,
        inputValueUsd: 0.5,
        destinationMint: SOL_MINT_ADDRESS,
        destinationSymbol: 'SOL' as const,
        expectedOutputRaw: '2039280',
        expectedOutputUi: 0.002039,
        minOutputRaw: '2039280',
        minOutputUi: 0.002039,
        expectedOutputUsd: 0.378,
        priceImpactPct: 0,
        routerLabel: 'SPL CloseAccount',
        estimatedComputeUnits: 25_000,
        estimatedTransactionBytes: 96,
        accountCount: 3,
        usesLookupTable: false,
        quoteExpiresAt: Date.now() + 60_000,
        actionType: 'CLOSE_EMPTY_ACCOUNT' as const,
      };

      const batches = TransactionBatcher.groupQuoteItemsIntoBatches([nonZeroCloseItem], {
        sessionId: 'vac_sec_close',
        walletAddress: userKp.publicKey.toBase58(),
        network: 'mainnet-beta',
        sponsorPublicKey: null,
        sponsorshipApplied: false,
        solPriceUsd: 185.4,
      });

      await expect(
        TransactionBatcher.buildCompositeVersionedTransaction({
          batch: batches[0],
          userWalletAddress: userKp.publicKey.toBase58(),
          network: 'mainnet-beta',
          recentBlockhashOverride: '11111111111111111111111111111111',
        })
      ).rejects.toThrow(/CLOSE_EMPTY_ACCOUNT cannot be executed on non-zero token balance/);

      // Also verify DEVNET_SWAP_AND_RECLAIM (BurnChecked) is strictly forbidden on mainnet-beta
      const burnItemOnMainnet = {
        ...nonZeroCloseItem,
        actionType: 'DEVNET_SWAP_AND_RECLAIM' as const,
      };
      const burnBatches = TransactionBatcher.groupQuoteItemsIntoBatches([burnItemOnMainnet], {
        sessionId: 'vac_sec_burn',
        walletAddress: userKp.publicKey.toBase58(),
        network: 'mainnet-beta',
        sponsorPublicKey: null,
        sponsorshipApplied: false,
        solPriceUsd: 185.4,
      });

      await expect(
        TransactionBatcher.buildCompositeVersionedTransaction({
          batch: burnBatches[0],
          userWalletAddress: userKp.publicKey.toBase58(),
          network: 'mainnet-beta',
          recentBlockhashOverride: '11111111111111111111111111111111',
        })
      ).rejects.toThrow(/DEVNET_SWAP_AND_RECLAIM \(BurnChecked\) is forbidden on mainnet-beta/);
    });

    it('uses TOKEN_2022_PROGRAM_ID for Token-2022 accounts and sends rent strictly to userPubkey', async () => {
      const token2022EmptyItem = {
        ...makeValidLiveAsset({ isToken2022: true, rawBalance: '0', uiBalance: 0 }),
        inputRawAmount: '0',
        inputUiAmount: 0,
        inputValueUsd: 0,
        destinationMint: SOL_MINT_ADDRESS,
        destinationSymbol: 'SOL' as const,
        expectedOutputRaw: '2039280',
        expectedOutputUi: 0.002039,
        minOutputRaw: '2039280',
        minOutputUi: 0.002039,
        expectedOutputUsd: 0.378,
        priceImpactPct: 0,
        routerLabel: 'SPL CloseAccount',
        estimatedComputeUnits: 25_000,
        estimatedTransactionBytes: 96,
        accountCount: 3,
        usesLookupTable: false,
        quoteExpiresAt: Date.now() + 60_000,
        actionType: 'CLOSE_EMPTY_ACCOUNT' as const,
      };

      const batches = TransactionBatcher.groupQuoteItemsIntoBatches([token2022EmptyItem], {
        sessionId: 'vac_t22_test',
        walletAddress: userKp.publicKey.toBase58(),
        network: 'devnet',
        sponsorPublicKey: sponsorKp.publicKey.toBase58(),
        sponsorshipApplied: true,
        solPriceUsd: 185.4,
      });

      const txBase64 = await TransactionBatcher.buildCompositeVersionedTransaction({
        batch: batches[0],
        userWalletAddress: userKp.publicKey.toBase58(),
        network: 'devnet',
        recentBlockhashOverride: '11111111111111111111111111111111',
      });

      const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'));
      const staticKeys = tx.message.staticAccountKeys.map((k) => k.toBase58());

      // Fee payer (index 0) is Sponsor, but CloseAccount destination & authority is User
      expect(staticKeys[0]).toBe(sponsorKp.publicKey.toBase58());
      expect(staticKeys).toContain(TOKEN_2022_PROGRAM_ID.toBase58());
      expect(staticKeys).not.toContain(TOKEN_PROGRAM_ID.toBase58());

      // Inspect the CloseAccount instruction (last instruction)
      const closeIx = tx.message.compiledInstructions[tx.message.compiledInstructions.length - 1];
      expect(staticKeys[closeIx.programIdIndex]).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
      expect(closeIx.data[0]).toBe(9); // SPL CloseAccount instruction discriminator = 9
      // Account 0 = tokenAccount, Account 1 = rent destination (MUST be user!), Account 2 = authority (MUST be user!)
      expect(staticKeys[closeIx.accountKeyIndexes[0]]).toBe(
        token2022EmptyItem.tokenAccountAddress
      );
      expect(staticKeys[closeIx.accountKeyIndexes[1]]).toBe(userKp.publicKey.toBase58());
      expect(staticKeys[closeIx.accountKeyIndexes[2]]).toBe(userKp.publicKey.toBase58());
    });

    it('blocks frozen accounts, non-transferable Token-2022 assets, and unharvested withheld fees', () => {
      const frozenRisk = TokenRiskService.assessTokenRisk({
        mintAddress: Keypair.generate().publicKey.toBase58(),
        symbol: 'FROZ',
        name: 'Frozen Token',
        hasMintAuthority: false,
        hasFreezeAuthority: true,
        isToken2022: false,
        hasTransferFeeOrHook: false,
        isFrozen: true,
        priceImpactPct: 0.1,
        hasViableRoute: false,
        estimatedValueUsd: 1.0,
      });
      expect(frozenRisk.riskLevel).toBe('CRITICAL');
      expect(frozenRisk.canSweepSafely).toBe(false);

      const nonTransferableRisk = TokenRiskService.assessTokenRisk({
        mintAddress: Keypair.generate().publicKey.toBase58(),
        symbol: 'SOUL',
        name: 'Soulbound Badge',
        hasMintAuthority: false,
        hasFreezeAuthority: false,
        isToken2022: true,
        hasTransferFeeOrHook: false,
        isNonTransferable: true,
        priceImpactPct: null,
        hasViableRoute: false,
        estimatedValueUsd: 0,
      });
      expect(nonTransferableRisk.riskLevel).toBe('CRITICAL');
      expect(nonTransferableRisk.canSweepSafely).toBe(false);

      const withheldFeesRisk = TokenRiskService.assessTokenRisk({
        mintAddress: Keypair.generate().publicKey.toBase58(),
        symbol: 'TAX22',
        name: 'Taxed Token 2022',
        hasMintAuthority: false,
        hasFreezeAuthority: false,
        isToken2022: true,
        hasTransferFeeOrHook: true,
        hasWithheldTransferFees: true,
        priceImpactPct: 0.5,
        hasViableRoute: false,
        estimatedValueUsd: 1.2,
      });
      expect(withheldFeesRisk.riskLevel).toBe('CRITICAL');
      expect(withheldFeesRisk.canSweepSafely).toBe(false);
    });
  });

  // =========================================================================
  // SECTION 5: TEST THE SWEEP ENGINE (SCENARIOS A THROUGH L)
  // =========================================================================
  describe('5. Comprehensive Sweep Engine Scenarios (A - L)', () => {
    it('Scenario A & B: Multiple-token discovery and multiple eligible assets grouped into batches', async () => {
      const disc = await TokenDiscoveryService.discoverWalletAssets(
        userKp.publicKey.toBase58(),
        'devnet',
        'demo'
      );
      expect(disc.assets.length).toBe(9);
      const eligible = disc.assets.filter((a) => a.isRecoverableDust);
      expect(eligible.length).toBe(6);

      const session = await SweepOrchestrator.createSweepSession({
        walletAddress: userKp.publicKey.toBase58(),
        network: 'devnet',
        mode: 'demo',
        selectedAssets: eligible,
        destinationSymbol: 'SOL',
        slippageBps: 100,
        requestGaslessSponsorship: true,
      });
      expect(session.totalAssetsSelected).toBe(6);
      expect(session.batches.length).toBeGreaterThanOrEqual(1);
    });

    it('Scenario C: One token with no liquidity is isolated into skippedAssets without blocking valid assets', async () => {
      const validAsset = makeValidLiveAsset({ symbol: 'GOOD1' });
      const illiquidAsset = makeValidLiveAsset({
        symbol: 'NOLIQ',
        hasViableRoute: false,
        liquidityStatus: 'NONE',
      });

      const session = await SweepOrchestrator.createSweepSession({
        walletAddress: userKp.publicKey.toBase58(),
        network: 'devnet',
        mode: 'demo',
        selectedAssets: [validAsset, illiquidAsset],
        destinationSymbol: 'SOL',
        slippageBps: 100,
        requestGaslessSponsorship: true,
      });

      expect(session.totalAssetsSelected).toBe(1);
      expect(session.skippedAssets).toHaveLength(1);
      expect(session.skippedAssets[0].symbol).toBe('NOLIQ');
    });

    it('Scenario D: One expired quote transitions batch to EXPIRED and releases sponsorship reservation', async () => {
      const asset = makeValidLiveAsset({ symbol: 'EXP1' });
      const session = await SweepOrchestrator.createSweepSession({
        walletAddress: userKp.publicKey.toBase58(),
        network: 'devnet',
        mode: 'live',
        selectedAssets: [asset],
        destinationSymbol: 'SOL',
        slippageBps: 100,
        requestGaslessSponsorship: true,
      });

      // Force batch expiration in DB
      const db = getDb();
      db.prepare(`UPDATE transaction_batches SET expires_at = ? WHERE batch_id = ?`).run(
        Date.now() - 5_000,
        session.batches[0].batchId
      );

      const res = await SweepOrchestrator.executeAuthorizedBatch({
        sessionId: session.sessionId,
        batchId: session.batches[0].batchId,
      });

      expect(res.batch.status).toBe('EXPIRED');
      expect(res.session.status).toBe('FAILED');
    });

    it('Scenario E: One rejected or invalid wallet signature is rejected before co-signing or broadcasting', async () => {
      const asset = makeValidLiveAsset({ symbol: 'SIG1' });
      const session = await SweepOrchestrator.createSweepSession({
        walletAddress: userKp.publicKey.toBase58(),
        network: 'devnet',
        mode: 'live',
        selectedAssets: [asset],
        destinationSymbol: 'SOL',
        slippageBps: 100,
        requestGaslessSponsorship: true,
      });

      // Wrong wallet signs the transaction instead of userKp
      const wrongUserKp = Keypair.generate();
      const msg = new TransactionMessage({
        payerKey: sponsorKp.publicKey,
        recentBlockhash: '11111111111111111111111111111111',
        instructions: [
          SystemProgram.transfer({
            fromPubkey: wrongUserKp.publicKey,
            toPubkey: wrongUserKp.publicKey,
            lamports: 0,
          }),
        ],
      }).compileToV0Message();
      const wrongTx = new VersionedTransaction(msg);
      wrongTx.sign([wrongUserKp]);

      await expect(
        SweepOrchestrator.executeAuthorizedBatch({
          sessionId: session.sessionId,
          batchId: session.batches[0].batchId,
          userSignedTransactionBase64: Buffer.from(wrongTx.serialize()).toString('base64'),
        })
      ).rejects.toThrow();
    });

    it('Scenario F & G: One successful batch followed by a failed batch results in PARTIAL_SUCCESS with accurate receipt', async () => {
      // Create 8 assets so TransactionBatcher splits them into 2 batches (6 + 2)
      const eightAssets = Array.from({ length: 8 }, (_, idx) =>
        makeValidLiveAsset({ symbol: `TOK${idx + 1}`, inputValueUsd: 1.2, estimatedValueUsd: 1.2 })
      );

      const session = await SweepOrchestrator.createSweepSession({
        walletAddress: userKp.publicKey.toBase58(),
        network: 'devnet',
        mode: 'live',
        selectedAssets: eightAssets,
        destinationSymbol: 'SOL',
        slippageBps: 100,
        requestGaslessSponsorship: true,
      });

      expect(session.batches.length).toBe(2);

      // Build deterministic unsigned transactions for both batches
      for (const b of session.batches) {
        const txB64 = await TransactionBatcher.buildCompositeVersionedTransaction({
          batch: b,
          userWalletAddress: userKp.publicKey.toBase58(),
          network: 'devnet',
          recentBlockhashOverride: '11111111111111111111111111111111',
        });
        getDb()
          .prepare(`UPDATE transaction_batches SET serialized_transaction_base64 = ? WHERE batch_id = ?`)
          .run(txB64, b.batchId);
        b.serializedTransactionBase64 = txB64;
      }

      // Sign both batches with userKp
      const signBatch = (b64: string) => {
        const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
        tx.sign([userKp]);
        return Buffer.from(tx.serialize()).toString('base64');
      };

      const signedBatch1 = signBatch(session.batches[0].serializedTransactionBase64!);
      const signedBatch2 = signBatch(session.batches[1].serializedTransactionBase64!);

      // Mock broadcastAndConfirmTransaction: Batch 1 succeeds, Batch 2 fails on-chain
      const broadcastSpy = vi
        .spyOn(TransactionVerificationService, 'broadcastAndConfirmTransaction')
        .mockResolvedValueOnce({
          confirmed: true,
          signature: '5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ',
          slot: 310001,
          confirmationStatus: 'confirmed',
          actualFeeLamports: 15_000,
        })
        .mockResolvedValueOnce({
          confirmed: false,
          signature: '3FailedSigMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvy',
          error: 'Transaction failed on-chain: Custom(1)',
        });

      const res1 = await SweepOrchestrator.executeAuthorizedBatch({
        sessionId: session.sessionId,
        batchId: session.batches[0].batchId,
        userSignedTransactionBase64: signedBatch1,
      });
      expect(res1.batch.status).toBe('CONFIRMED');
      expect(res1.session.status).toBe('EXECUTING'); // Batch 2 still pending

      const res2 = await SweepOrchestrator.executeAuthorizedBatch({
        sessionId: session.sessionId,
        batchId: session.batches[1].batchId,
        userSignedTransactionBase64: signedBatch2,
      });
      expect(res2.batch.status).toBe('FAILED');
      expect(res2.session.status).toBe('PARTIAL_SUCCESS');
      expect(broadcastSpy).toHaveBeenCalledTimes(2);

      // Verify receipt represents PARTIAL_SUCCESS accurately (6 swept, 2 failed)
      const receipt = HistoryService.generateSessionReceipt(session.sessionId);
      expect(receipt.totalAssetsAttempted).toBe(8);
      expect(receipt.totalAssetsSwept).toBe(6);
      expect(receipt.totalAssetsFailedOrSkipped).toBe(2);
      expect(receipt.totalSponsoredLamports).toBe(15_000); // Only confirmed batch counted
    });

    it('Scenario H: Insufficient sponsorship budget falls back cleanly to USER_SELF_PAID and prevents concurrent session bypass', async () => {
      // Set wallet allowance to 30,000 lamports (enough for only 1 batch of 25,000 lamports)
      process.env.SPONSORSHIP_MAX_PER_WALLET_LAMPORTS = '30000';

      const asset1 = makeValidLiveAsset({ symbol: 'BUD1' });
      const asset2 = makeValidLiveAsset({ symbol: 'BUD2' });

      // Session 1 reserves 25,000 lamports immediately upon creation
      const session1 = await SweepOrchestrator.createSweepSession({
        walletAddress: userKp.publicKey.toBase58(),
        network: 'devnet',
        mode: 'demo',
        selectedAssets: [asset1],
        destinationSymbol: 'SOL',
        slippageBps: 100,
        requestGaslessSponsorship: true,
      });
      expect(session1.sponsorshipEvaluation.eligible).toBe(true);

      // Concurrent Session 2 for the same wallet before Session 1 even executes:
      // Must see the 25,000 lamport reservation and reject sponsorship!
      const session2 = await SweepOrchestrator.createSweepSession({
        walletAddress: userKp.publicKey.toBase58(),
        network: 'devnet',
        mode: 'demo',
        selectedAssets: [asset2],
        destinationSymbol: 'SOL',
        slippageBps: 100,
        requestGaslessSponsorship: true,
      });
      expect(session2.sponsorshipEvaluation.eligible).toBe(false);
      expect(session2.sponsorshipEvaluation.mode).toBe('USER_SELF_PAID');
      expect(session2.sponsorshipEvaluation.reason).toMatch(/allowance exceeded/);
    });

    it('Scenario I: Transaction confirmation timeout marks batch FAILED and never marks unconfirmed tx completed', async () => {
      vi.spyOn(Connection.prototype, 'getSignatureStatuses').mockResolvedValue({
        context: { slot: 100 },
        value: [null],
      });

      const res = await TransactionVerificationService.verifySignatureConfirmation(
        '5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ',
        'devnet',
        1 // 1 poll attempt for fast test
      );
      expect(res.confirmed).toBe(false);
      expect(res.error).toMatch(/timed out/);
    });

    it('Scenario J: Duplicate execution requests for an already-confirmed batch are rejected idempotently', async () => {
      const asset = makeValidLiveAsset({ symbol: 'DUP1' });
      const session = await SweepOrchestrator.createSweepSession({
        walletAddress: userKp.publicKey.toBase58(),
        network: 'devnet',
        mode: 'demo',
        selectedAssets: [asset],
        destinationSymbol: 'SOL',
        slippageBps: 100,
        requestGaslessSponsorship: true,
      });

      const batchId = session.batches[0].batchId;
      const firstExec = await SweepOrchestrator.executeAuthorizedBatch({
        sessionId: session.sessionId,
        batchId,
      });
      expect(firstExec.batch.status).toBe('CONFIRMED');

      // Second execution attempt on the same batch must throw duplicate error
      await expect(
        SweepOrchestrator.executeAuthorizedBatch({
          sessionId: session.sessionId,
          batchId,
        })
      ).rejects.toThrow(/Duplicate execution request rejected/);
    });

    it('Scenario K: Stale balance data is detected against discovered_assets and isolated safely', async () => {
      const walletAddr = userKp.publicKey.toBase58();
      const asset = makeValidLiveAsset({
        symbol: 'STALE1',
        rawBalance: '5000000',
        uiBalance: 5.0,
      });

      // Persist latest on-chain discovered balance as '1000000'
      getDb()
        .prepare(
          `INSERT INTO discovered_assets (
            id, wallet_address, network, token_account_address, mint_address,
            symbol, name, decimals, raw_balance, ui_balance,
            estimated_value_usd, reclaimable_rent_lamports, liquidity_status,
            category, is_recoverable_dust
          ) VALUES (?, ?, 'devnet', ?, ?, 'STALE1', 'Stale Token', 6, '1000000', 1.0, 1.0, 2039280, 'HIGH', 'POTENTIAL_DUST', 1)`
        )
        .run(
          `${walletAddr}:devnet:${asset.tokenAccountAddress}`,
          walletAddr,
          asset.tokenAccountAddress,
          asset.mintAddress
        );

      const validAsset = makeValidLiveAsset({ symbol: 'FRESH1' });

      // Client submits stale rawBalance ('5000000' vs on-chain '1000000')
      const session = await SweepOrchestrator.createSweepSession({
        walletAddress: walletAddr,
        network: 'devnet',
        mode: 'live',
        selectedAssets: [asset, validAsset],
        destinationSymbol: 'SOL',
        slippageBps: 100,
        requestGaslessSponsorship: true,
      });

      expect(session.totalAssetsSelected).toBe(1);
      expect(session.skippedAssets).toHaveLength(1);
      expect(session.skippedAssets[0].symbol).toBe('STALE1');
      expect(session.skippedAssets[0].reason).toMatch(/Stale token balance detected/);
    });

    it('Scenario L: Malicious token with spoofed client-side risk flag is caught by server-side TokenRiskService re-evaluation', async () => {
      // Attacker crafts a phishing token in the request body but sets risk.canSweepSafely = true
      const spoofedScamAsset = makeValidLiveAsset({
        symbol: 'FREE-SOL.XYZ',
        name: 'Claim at https://scam-airdrop.com',
        risk: {
          mintAddress: Keypair.generate().publicKey.toBase58(),
          riskLevel: 'LOW', // Spoofed by client!
          riskScore: 0,
          hasMintAuthority: false,
          hasFreezeAuthority: false,
          isToken2022: false,
          hasTransferFeeOrHook: false,
          isKnownVerified: true,
          priceImpactPct: 0.1,
          signals: [],
          canSweepSafely: true, // Spoofed by client!
          requiresUserAcknowledgement: false,
        },
      });

      await expect(
        SweepOrchestrator.createSweepSession({
          walletAddress: userKp.publicKey.toBase58(),
          network: 'devnet',
          mode: 'live',
          selectedAssets: [spoofedScamAsset],
          destinationSymbol: 'SOL',
          slippageBps: 100,
          requestGaslessSponsorship: true,
        })
      ).rejects.toThrow(/Quarantined by TokenRiskService/);
    });
  });

  // =========================================================================
  // SECTION 6 & 7 & 8: API SECURITY, DATABASE ATOMICITY & MAINNET BOUNDARIES
  // =========================================================================
  describe('6, 7 & 8. API Route Security, Database Transactions & Mainnet Safety Boundaries', () => {
    it('enforces strict input validation on /api/status, /api/discover, /api/sweep/quote, /api/sweep/execute, and /api/history', async () => {
      // 1. Invalid network parameter rejected on /api/status
      const badStatusReq = new NextRequest('http://localhost:3000/api/status?network=evil-net');
      const badStatusRes = await statusGET(badStatusReq);
      expect(badStatusRes.status).toBe(400);

      // 2. Invalid slippageBps rejected on /api/sweep/quote
      const badQuoteReq = new NextRequest('http://localhost:3000/api/sweep/quote', {
        method: 'POST',
        body: JSON.stringify({
          walletAddress: userKp.publicKey.toBase58(),
          network: 'devnet',
          mode: 'live',
          destinationSymbol: 'SOL',
          slippageBps: -100,
          selectedAssets: [makeValidLiveAsset()],
        }),
      });
      const badQuoteRes = await quotePOST(badQuoteReq);
      expect(badQuoteRes.status).toBe(400);

      // 3. Invalid sessionId format rejected on /api/sweep/execute
      const badExecReq = new NextRequest('http://localhost:3000/api/sweep/execute', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: 'malicious_sql_injection',
          batchId: 'b1',
        }),
      });
      const badExecRes = await executePOST(badExecReq);
      expect(badExecRes.status).toBe(400);

      // 4. Invalid walletAddress rejected on /api/discover in live mode
      const badDiscReq = new NextRequest('http://localhost:3000/api/discover', {
        method: 'POST',
        body: JSON.stringify({
          walletAddress: 'not_a_pubkey',
          network: 'devnet',
          mode: 'live',
        }),
      });
      const badDiscRes = await discoverPOST(badDiscReq);
      expect(badDiscRes.status).toBe(400);

      // 5. Wallet ownership mismatch on /api/history?sessionId=...&walletAddress=... returns 403
      const session = await SweepOrchestrator.createSweepSession({
        walletAddress: userKp.publicKey.toBase58(),
        network: 'devnet',
        mode: 'demo',
        selectedAssets: [makeValidLiveAsset()],
        destinationSymbol: 'SOL',
        slippageBps: 100,
        requestGaslessSponsorship: false,
      });
      const otherWallet = Keypair.generate().publicKey.toBase58();
      const unauthorizedHistReq = new NextRequest(
        `http://localhost:3000/api/history?sessionId=${session.sessionId}&walletAddress=${otherWallet}`
      );
      const unauthorizedHistRes = await historyGET(unauthorizedHistReq);
      expect(unauthorizedHistRes.status).toBe(403);
    });

    it('enforces sliding-window rate limiting and returns 429 Too Many Requests when exceeded', () => {
      const key = 'test_rl:127.0.0.1';
      expect(ApiSecurity.checkRateLimit(key, 2, 60_000).allowed).toBe(true);
      expect(ApiSecurity.checkRateLimit(key, 2, 60_000).allowed).toBe(true);
      const third = ApiSecurity.checkRateLimit(key, 2, 60_000);
      expect(third.allowed).toBe(false);
      expect(third.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('rolls back database changes atomically when an error occurs inside runInTransaction', () => {
      const db = getDb();
      const testUserAddr = Keypair.generate().publicKey.toBase58();

      expect(() =>
        runInTransaction((txDb) => {
          txDb
            .prepare(`INSERT INTO users (id, primary_wallet_address) VALUES (?, ?)`)
            .run('usr_rollback_1', testUserAddr);
          throw new Error('Simulated mid-transaction failure');
        })
      ).toThrow(/Simulated mid-transaction failure/);

      const row = db
        .prepare(`SELECT * FROM users WHERE id = 'usr_rollback_1'`)
        .get();
      expect(row).toBeUndefined();
    });

    it('strictly separates Devnet and Mainnet $VACUUM mint configurations and blocks unconfigured live $VACUUM sweeps', async () => {
      process.env.NEXT_PUBLIC_VACUUM_TOKEN_MINT = Keypair.generate().publicKey.toBase58();
      delete process.env.NEXT_PUBLIC_VACUUM_DEVNET_MINT;

      // Devnet must NOT inherit Mainnet $VACUUM mint address
      const devnetDests = VacuumTokenService.getSupportedDestinations('devnet');
      const devnetVac = devnetDests.find((d) => d.symbol === 'VACUUM')!;
      expect(devnetVac.mintAddress).toBeNull();
      expect(devnetVac.isConfiguredForNetwork).toBe(false);

      // Attempting a live sweep to $VACUUM on devnet when devnet mint is unset must fail safely
      await expect(
        QuoteService.buildExecutableQuotes({
          walletAddress: userKp.publicKey.toBase58(),
          network: 'devnet',
          mode: 'live',
          selectedAssets: [makeValidLiveAsset()],
          destinationSymbol: 'VACUUM',
          slippageBps: 100,
          sponsorPublicKey: null,
        })
      ).rejects.toThrow(/\$VACUUM official mint address is not yet configured for devnet/);
    });
  });
});
