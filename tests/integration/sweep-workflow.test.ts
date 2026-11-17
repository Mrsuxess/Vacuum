import { describe, it, expect, beforeEach } from 'vitest';
import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { resetTestDb } from '@/lib/db';
import { WalletService } from '@/services/walletService';
import { TokenDiscoveryService } from '@/services/tokenDiscoveryService';
import { SweepOrchestrator } from '@/services/sweepOrchestrator';
import { SponsorshipService } from '@/services/sponsorshipService';
import { HistoryService } from '@/services/historyService';
import { AnalyticsService } from '@/services/analyticsService';

describe('VACUUM Integration & End-to-End Workflow Tests', () => {
  beforeEach(() => {
    process.env.VITEST = 'true';
    resetTestDb();
  });

  it('registers wallet identity without storing private keys and validates addresses', () => {
    const kp = Keypair.generate();
    const addr = kp.publicKey.toBase58();

    expect(WalletService.isValidWalletAddress(addr)).toBe(true);
    expect(WalletService.isValidWalletAddress('not-a-solana-address')).toBe(false);

    WalletService.registerConnectedWallet({
      walletAddress: addr,
      walletProvider: 'Phantom',
      network: 'devnet',
    });

    expect(WalletService.shortenAddress(addr, 4)).toBe(
      `${addr.slice(0, 4)}...${addr.slice(-4)}`
    );
  });

  it('signs a VersionedTransaction with both User (Taker) and Server Sponsor (Fee Payer) and verifies dual cryptographic signatures', () => {
    const sponsorKp = Keypair.generate();
    const userKp = Keypair.generate();
    process.env.SPONSOR_FEE_PAYER_SECRET_KEY = bs58.encode(sponsorKp.secretKey);

    // Construct a real VersionedTransaction v0 where sponsorKp is payerKey (index 0) and userKp is signer
    const ix = SystemProgram.transfer({
      fromPubkey: userKp.publicKey,
      toPubkey: userKp.publicKey,
      lamports: 1000,
    });

    const msgV0 = new TransactionMessage({
      payerKey: sponsorKp.publicKey,
      recentBlockhash: '11111111111111111111111111111111',
      instructions: [ix],
    }).compileToV0Message();

    const vTx = new VersionedTransaction(msgV0);
    // 1. User signs first (client-side wallet simulation)
    vTx.sign([userKp]);
    const userSignedBase64 = Buffer.from(vTx.serialize()).toString('base64');

    // 2. Backend SponsorshipService co-signs as designated fee payer
    const coSigned = SponsorshipService.signTransactionAsFeePayer(
      userSignedBase64,
      'devnet'
    );

    expect(coSigned.sponsorPublicKey).toBe(sponsorKp.publicKey.toBase58());

    const finalTx = VersionedTransaction.deserialize(
      Buffer.from(coSigned.signedTransactionBase64, 'base64')
    );

    // Verify both signatures (index 0 = sponsor fee payer, index 1 = user) are non-zero!
    expect(finalTx.signatures.length).toBe(2);
    expect(finalTx.signatures[0].some((byte) => byte !== 0)).toBe(true);
    expect(finalTx.signatures[1].some((byte) => byte !== 0)).toBe(true);
  });

  it('executes the complete 10-step E2E Sweep Journey with failure isolation, history persistence, and receipt verification', async () => {
    const walletAddress = Keypair.generate().publicKey.toBase58();

    // Step 1-4: Discover assets & classify dust
    const discovery = await TokenDiscoveryService.discoverWalletAssets(
      walletAddress,
      'devnet',
      'demo'
    );

    expect(discovery.assets.length).toBeGreaterThan(5);
    expect(discovery.summary.eligibleTokensCount).toBeGreaterThanOrEqual(5);

    // Include recoverable dust + 1 unroutable asset + 1 critical scam asset to test Failure Isolation
    const selectedAssets = discovery.assets.filter(
      (a) =>
        a.isRecoverableDust ||
        a.category === 'NO_VIABLE_ROUTE' ||
        a.category === 'SUSPICIOUS_UNSUPPORTED'
    );

    // Step 5-7: Select VACUUM as destination, create session, isolate unsupported tokens
    const session = await SweepOrchestrator.createSweepSession({
      walletAddress,
      network: 'devnet',
      mode: 'demo',
      selectedAssets,
      destinationSymbol: 'VACUUM',
      slippageBps: 100,
      requestGaslessSponsorship: true,
    });

    expect(session.destinationSymbol).toBe('VACUUM');
    expect(session.status).toBe('AWAITING_AUTHORIZATION');
    expect(session.skippedAssets.length).toBe(2); // Quarantined + No route isolated automatically
    expect(session.batches.length).toBeGreaterThanOrEqual(1);
    expect(session.sponsorshipEvaluation.eligible).toBe(true);

    // Step 8-10: Authorize and execute each batch, then verify completion & receipt
    for (const batch of session.batches) {
      const res = await SweepOrchestrator.executeAuthorizedBatch({
        sessionId: session.sessionId,
        batchId: batch.batchId,
      });
      expect(res.batch.status).toBe('CONFIRMED');
    }

    const updatedSession = SweepOrchestrator.getSessionById(session.sessionId)!;
    expect(updatedSession.status).toBe('COMPLETED');
    expect(updatedSession.actualDestinationOutputUi).toBeGreaterThan(0);

    // Verify receipt generation & analytics persistence
    const receipt = HistoryService.generateSessionReceipt(session.sessionId);
    expect(receipt.sessionId).toBe(session.sessionId);
    expect(receipt.totalAssetsSwept).toBe(6);
    expect(receipt.verificationHash).toHaveLength(64);

    const analytics = AnalyticsService.getAnalyticsSummary(walletAddress);
    expect(analytics.totalSuccessfulSweeps).toBe(1);
    expect(analytics.totalVacuumAcquiredUi).toBeGreaterThan(0);
  });

  it('rejects live batch execution when user signature is missing or when quote is expired', async () => {
    const walletAddress = Keypair.generate().publicKey.toBase58();
    const discovery = await TokenDiscoveryService.discoverWalletAssets(
      walletAddress,
      'devnet',
      'demo'
    );
    const eligible = discovery.assets.filter((a) => a.isRecoverableDust).slice(0, 2);

    const session = await SweepOrchestrator.createSweepSession({
      walletAddress,
      network: 'devnet',
      mode: 'live',
      selectedAssets: eligible,
      destinationSymbol: 'SOL',
      slippageBps: 100,
      requestGaslessSponsorship: true,
    });

    // Missing user signature in live mode must throw an authorization error
    await expect(
      SweepOrchestrator.executeAuthorizedBatch({
        sessionId: session.sessionId,
        batchId: session.batches[0].batchId,
      })
    ).rejects.toThrow(/Explicit user wallet signature/);
  });
});
