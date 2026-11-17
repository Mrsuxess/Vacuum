import { Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import fs from 'fs';
import path from 'path';
import {
  SolanaNetwork,
  SolFlowBreakdown,
  SponsorshipEvaluation,
  TransactionBatch,
} from '@/types/vacuum';
import { DEVNET_KNOWN_SPONSOR_PUBKEY, getAppConfig } from '@/lib/config';
import { getDb } from '@/lib/db';
import { TransactionVerificationService } from '@/services/transactionVerificationService';

export interface SponsorshipRequestInput {
  walletAddress: string;
  network: SolanaNetwork;
  estimatedLiquidationUsd: number;
  batchCount: number;
  requiresDestinationAtaCreation: boolean;
  reclaimableRentLamports: number;
  solPriceUsd: number;
}

export interface SponsorCoSignOptions {
  expectedUnsignedTxBase64?: string | null;
  expectedUserAddress?: string;
}

export class SponsorshipService {
  private static cachedDevnetKeypair: Keypair | null = null;

  private static decodeSecretKeyString(rawSecret: string): Keypair | null {
    try {
      if (rawSecret.startsWith('[')) {
        const arr = JSON.parse(rawSecret) as number[];
        return Keypair.fromSecretKey(Uint8Array.from(arr));
      }
      return Keypair.fromSecretKey(bs58.decode(rawSecret));
    } catch {
      return null;
    }
  }

  /**
   * Loads the server-side designated fee-payer Keypair with strict Devnet vs Mainnet credential isolation:
   * - On Mainnet (`mainnet-beta`):
   *   1. Looks for `SPONSOR_MAINNET_FEE_PAYER_SECRET_KEY` (or `SPONSOR_FEE_PAYER_SECRET_KEY`).
   *   2. NEVER loads `./data/devnet-sponsor-keypair.json`.
   *   3. Strictly rejects the keypair if its public key matches the known Devnet sponsor keypair (`Etqz6qVzrWwkazxWbbQgeCsBBCNYvh2E2SUqF35fUBgT`)
   *      or matches `./data/devnet-sponsor-keypair.json` on disk.
   * - On Devnet (`devnet`):
   *   1. Looks for `SPONSOR_DEVNET_FEE_PAYER_SECRET_KEY` or `SPONSOR_FEE_PAYER_SECRET_KEY` or `./data/devnet-sponsor-keypair.json`.
   *   2. Strictly rejects any keypair that matches `SPONSOR_MAINNET_FEE_PAYER_SECRET_KEY`.
   * NEVER exposes private key bytes to the frontend.
   */
  static getServerSponsorKeypair(network: SolanaNetwork): Keypair | null {
    const mainnetSecret = process.env.SPONSOR_MAINNET_FEE_PAYER_SECRET_KEY?.trim();
    const devnetSecret = process.env.SPONSOR_DEVNET_FEE_PAYER_SECRET_KEY?.trim();
    const genericSecret = process.env.SPONSOR_FEE_PAYER_SECRET_KEY?.trim();

    if (network === 'mainnet-beta') {
      const candidateSecret = mainnetSecret || genericSecret;
      if (!candidateSecret) return null;

      const kp = this.decodeSecretKeyString(candidateSecret);
      if (!kp) return null;

      // Cross-Network Credential Isolation Guard: Never allow the Devnet sponsor keypair on Mainnet
      if (kp.publicKey.toBase58() === DEVNET_KNOWN_SPONSOR_PUBKEY) {
        return null;
      }
      if (devnetSecret) {
        const devKp = this.decodeSecretKeyString(devnetSecret);
        if (devKp && devKp.publicKey.equals(kp.publicKey)) {
          return null;
        }
      }
      try {
        const keyFile = path.resolve(process.cwd(), './data/devnet-sponsor-keypair.json');
        if (fs.existsSync(keyFile)) {
          const arr = JSON.parse(fs.readFileSync(keyFile, 'utf-8')) as number[];
          const fileDevKp = Keypair.fromSecretKey(Uint8Array.from(arr));
          if (fileDevKp.publicKey.equals(kp.publicKey)) {
            return null;
          }
        }
      } catch {
        // Ignore file check error
      }

      return kp;
    }

    // DEVNET keypair resolution
    const candidateDevSecret = devnetSecret || genericSecret;
    if (candidateDevSecret) {
      const kp = this.decodeSecretKeyString(candidateDevSecret);
      if (kp) {
        // Never allow explicit Mainnet sponsor keypair to be used on Devnet
        if (mainnetSecret) {
          const mainKp = this.decodeSecretKeyString(mainnetSecret);
          if (mainKp && mainKp.publicKey.equals(kp.publicKey)) {
            return null;
          }
        }
        return kp;
      }
    }

    if (this.cachedDevnetKeypair) {
      return this.cachedDevnetKeypair;
    }
    try {
      const dataDir = path.resolve(process.cwd(), './data');
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      const keyFile = path.join(dataDir, 'devnet-sponsor-keypair.json');
      if (fs.existsSync(keyFile)) {
        const arr = JSON.parse(fs.readFileSync(keyFile, 'utf-8')) as number[];
        this.cachedDevnetKeypair = Keypair.fromSecretKey(Uint8Array.from(arr));
        return this.cachedDevnetKeypair;
      }
      const generated = Keypair.generate();
      fs.writeFileSync(keyFile, JSON.stringify(Array.from(generated.secretKey)), {
        mode: 0o600,
      });
      this.cachedDevnetKeypair = generated;
      return generated;
    } catch {
      return null;
    }
  }

  /**
   * Returns only the public key and operational status of the sponsor wallet.
   * Private key material never leaves the server.
   */
  static getSponsorPublicStatus(network: SolanaNetwork) {
    const config = getAppConfig();
    const kp = this.getServerSponsorKeypair(network);
    const usage = this.getSponsorshipBudgetUsage();
    const enabledForNetwork =
      network === 'mainnet-beta'
        ? config.sponsorship.mainnetSponsorshipEnabled
        : config.sponsorship.enabled;

    return {
      enabled: enabledForNetwork,
      network,
      sponsorPublicKey: kp ? kp.publicKey.toBase58() : null,
      isConfigured: Boolean(kp) && enabledForNetwork,
      policy: {
        minSweepUsd: config.sponsorship.minSweepUsd,
        maxPerWalletLamports: config.sponsorship.maxPerWalletLamports,
        maxDailyBudgetLamports: config.sponsorship.maxDailyBudgetLamports,
        minNetRecoveryUsd: config.sponsorship.minNetRecoveryUsd,
        platformFeeBps: config.sponsorship.platformFeeBps,
        rateLimitPerHour: config.sponsorship.rateLimitPerHour,
        maxPriorityMicroLamports: config.sponsorship.maxPriorityMicroLamports,
      },
      dailyUsedLamports: usage.dailyUsedLamports,
      remainingDailyBudgetLamports: Math.max(
        0,
        config.sponsorship.maxDailyBudgetLamports - usage.dailyUsedLamports
      ),
    };
  }

  /**
   * Evaluates economic viability, SOL flow ownership, and anti-abuse controls before sponsoring a sweep.
   */
  static evaluateSponsorshipEligibility(
    input: SponsorshipRequestInput
  ): SponsorshipEvaluation {
    const config = getAppConfig();
    const kp = this.getServerSponsorKeypair(input.network);
    const sponsorPublicKey = kp ? kp.publicKey.toBase58() : null;

    const batches = Math.max(1, input.batchCount);
    const baseFeePerBatch = 10_000; // 2 signatures (user + sponsor) * 5,000 lamports
    const priorityFeePerBatch = 15_000; // 15,000 lamports priority fee
    const estimatedNetworkFeeLamports = batches * baseFeePerBatch;
    const estimatedPriorityFeeLamports = batches * priorityFeePerBatch;
    const estimatedAtaCreationLamports = input.requiresDestinationAtaCreation ? 2_039_280 : 0;

    const totalSponsorOutlayLamports =
      estimatedNetworkFeeLamports +
      estimatedPriorityFeeLamports +
      estimatedAtaCreationLamports;

    const sponsorshipCostUsd = Number(
      ((totalSponsorOutlayLamports / 1e9) * input.solPriceUsd).toFixed(4)
    );
    const reclaimableRentUsd = Number(
      ((input.reclaimableRentLamports / 1e9) * input.solPriceUsd).toFixed(4)
    );

    const hasOnChainReferralRecovery = Boolean(
      config.jupiter.referralAccount && config.jupiter.referralFeeBps >= 50
    );
    const platformServiceFeeBps = config.sponsorship.platformFeeBps;
    const platformServiceFeeUsd = Number(
      ((input.estimatedLiquidationUsd * platformServiceFeeBps) / 10_000).toFixed(4)
    );
    const expectedExecutionRiskUsd = Number(
      (input.estimatedLiquidationUsd * 0.0035).toFixed(4)
    );

    const grossEconomicProceedsUsd = input.estimatedLiquidationUsd + reclaimableRentUsd;
    const totalCostsAndBuffersUsd =
      sponsorshipCostUsd + platformServiceFeeUsd + expectedExecutionRiskUsd;

    const estimatedNetRecoveryUsd = Number(
      (grossEconomicProceedsUsd - totalCostsAndBuffersUsd).toFixed(4)
    );

    const usage = this.getWalletAndDailyUsage(input.walletAddress);
    const remainingWalletAllowanceLamports = Math.max(
      0,
      config.sponsorship.maxPerWalletLamports - usage.walletUsedLamports
    );
    const remainingDailyBudgetLamports = Math.max(
      0,
      config.sponsorship.maxDailyBudgetLamports - usage.dailyUsedLamports
    );

    const selfPaidSolFlow: SolFlowBreakdown = {
      networkFeePayer: 'USER',
      priorityFeePayer: 'USER',
      ataCreationPayer: input.requiresDestinationAtaCreation ? 'USER' : 'NONE',
      rentRefundRecipient: 'USER',
      swapProceedsRecipient: 'USER',
      sponsorRecoveryMechanism: 'NONE',
    };

    const buildIneligible = (reason: string): SponsorshipEvaluation => ({
      eligible: false,
      mode: 'USER_SELF_PAID',
      sponsorPublicKey,
      estimatedLiquidationUsd: input.estimatedLiquidationUsd,
      estimatedNetworkFeeLamports,
      estimatedPriorityFeeLamports,
      estimatedAtaCreationLamports,
      reclaimableRentLamports: input.reclaimableRentLamports,
      platformServiceFeeUsd: 0,
      platformServiceFeeBps: 0,
      expectedExecutionRiskUsd,
      estimatedNetRecoveryUsd,
      sponsorshipCostLamports: totalSponsorOutlayLamports,
      sponsorshipCostUsd,
      isSubsidized: false,
      subsidyAmountUsd: 0,
      reason,
      remainingWalletAllowanceLamports,
      remainingDailyBudgetLamports,
      solFlowBreakdown: selfPaidSolFlow,
    });

    // 1. Check if sponsorship is enabled for the target network
    if (!config.sponsorship.enabled) {
      return {
        ...buildIneligible('Fee sponsorship is currently disabled by administrator policy.'),
        sponsorPublicKey: null,
      };
    }

    if (input.network === 'mainnet-beta' && !config.sponsorship.mainnetSponsorshipEnabled) {
      return {
        ...buildIneligible(
          'Mainnet-Beta gasless sponsorship is disabled by default safety policy (MAINNET_SPONSORSHIP_ENABLED=false). User self-paid execution is active.'
        ),
        sponsorPublicKey: null,
      };
    }

    if (!sponsorPublicKey) {
      return buildIneligible(
        `Server fee-payer keypair is not configured for ${input.network}. User self-paid execution remains available.`
      );
    }

    // 2. Check hourly rate limit per wallet (Anti-Sybil / Anti-Abuse)
    if (usage.walletHourlyCount >= config.sponsorship.rateLimitPerHour) {
      return buildIneligible(
        `Hourly rate limit reached (${config.sponsorship.rateLimitPerHour} sponsored sweeps/hour). User self-paid execution remains available.`
      );
    }

    // 3. Check minimum sweep value
    if (grossEconomicProceedsUsd < config.sponsorship.minSweepUsd) {
      return buildIneligible(
        `Total sweep value ($${grossEconomicProceedsUsd.toFixed(2)}) is below minimum sponsorship threshold ($${config.sponsorship.minSweepUsd.toFixed(2)}).`
      );
    }

    // 4. Check per-wallet and daily sponsorship budgets
    if (totalSponsorOutlayLamports > remainingWalletAllowanceLamports) {
      return buildIneligible('Wallet sponsorship allowance exceeded for current 24h period.');
    }

    if (totalSponsorOutlayLamports > remainingDailyBudgetLamports) {
      return buildIneligible('Global daily sponsorship budget exhausted.');
    }

    // 5. Check positive net recovery
    if (estimatedNetRecoveryUsd < config.sponsorship.minNetRecoveryUsd) {
      return buildIneligible(
        `Net economic recovery ($${estimatedNetRecoveryUsd.toFixed(4)}) is below minimum viable threshold ($${config.sponsorship.minNetRecoveryUsd.toFixed(2)}).`
      );
    }

    const sponsorRecoveredUsd = hasOnChainReferralRecovery ? platformServiceFeeUsd : 0;
    const isSubsidized = sponsorRecoveredUsd < sponsorshipCostUsd;
    const subsidyAmountUsd = isSubsidized
      ? Number((sponsorshipCostUsd - sponsorRecoveredUsd).toFixed(4))
      : 0;

    const sponsoredSolFlow: SolFlowBreakdown = {
      networkFeePayer: 'SPONSOR',
      priorityFeePayer: 'SPONSOR',
      ataCreationPayer: input.requiresDestinationAtaCreation ? 'SPONSOR' : 'NONE',
      rentRefundRecipient: 'USER',
      swapProceedsRecipient: 'USER',
      sponsorRecoveryMechanism: hasOnChainReferralRecovery
        ? 'REFERRAL_FEE'
        : 'SUBSIDIZED_BY_SPONSOR',
    };

    return {
      eligible: true,
      mode: 'VACUUM_SPONSOR_PAYER',
      sponsorPublicKey,
      estimatedLiquidationUsd: input.estimatedLiquidationUsd,
      estimatedNetworkFeeLamports,
      estimatedPriorityFeeLamports,
      estimatedAtaCreationLamports,
      reclaimableRentLamports: input.reclaimableRentLamports,
      platformServiceFeeUsd,
      platformServiceFeeBps,
      expectedExecutionRiskUsd,
      estimatedNetRecoveryUsd,
      sponsorshipCostLamports: totalSponsorOutlayLamports,
      sponsorshipCostUsd,
      isSubsidized,
      subsidyAmountUsd,
      reason: isSubsidized
        ? `Eligible for Gasless Sponsorship (Sponsor covers gas; reclaimed rent goes 100% to user; subsidized $${subsidyAmountUsd.toFixed(4)} within daily budget)`
        : 'Eligible for Gasless Sponsorship (Covered by configured on-chain integrator referral fee; reclaimed rent goes 100% to user)',
      remainingWalletAllowanceLamports:
        remainingWalletAllowanceLamports - totalSponsorOutlayLamports,
      remainingDailyBudgetLamports:
        remainingDailyBudgetLamports - totalSponsorOutlayLamports,
      solFlowBreakdown: sponsoredSolFlow,
    };
  }

  /**
   * Co-signs a serialized VersionedTransaction on the server using the designated fee-payer Keypair.
   */
  static signTransactionAsFeePayer(
    serializedTxBase64: string,
    network: SolanaNetwork,
    options?: SponsorCoSignOptions
  ): { signedTransactionBase64: string; sponsorPublicKey: string } {
    const sponsorKeypair = this.getServerSponsorKeypair(network);
    if (!sponsorKeypair) {
      throw new Error(
        `Server fee-payer keypair is not configured or isolated for ${network}.`
      );
    }

    const txBuffer = Buffer.from(serializedTxBase64, 'base64');
    const tx = VersionedTransaction.deserialize(txBuffer);

    const staticKeys = tx.message.staticAccountKeys;
    if (!staticKeys || staticKeys.length === 0) {
      throw new Error('Malformed VersionedTransaction: missing static account keys');
    }

    const feePayerKey = staticKeys[0];
    if (!feePayerKey.equals(sponsorKeypair.publicKey)) {
      throw new Error(
        `Fee payer mismatch: transaction expects ${feePayerKey.toBase58()}, but sponsor is ${sponsorKeypair.publicKey.toBase58()}`
      );
    }

    // Enforce instruction-level safety (ComputeBudget caps, SystemProgram source block, SPL Token authority block, CloseAccount rent destination)
    const safetyCheck = TransactionVerificationService.validateSponsorInstructionSafety(
      tx,
      sponsorKeypair.publicKey,
      options?.expectedUserAddress
    );
    if (!safetyCheck.safe) {
      throw new Error(safetyCheck.reason || 'Sponsor instruction safety check failed');
    }

    // If expectedUnsignedTxBase64 or expectedUserAddress is provided, verify message integrity & user Ed25519 signature
    if (options?.expectedUnsignedTxBase64 || options?.expectedUserAddress) {
      const userAddr =
        options.expectedUserAddress ||
        (staticKeys.length > 1 ? staticKeys[1].toBase58() : '');
      const preCheck = TransactionVerificationService.verifySignedTransactionIntegrity({
        signedTxBase64: serializedTxBase64,
        expectedUnsignedTxBase64: options.expectedUnsignedTxBase64,
        expectedUserAddress: userAddr,
        expectedFeePayerAddress: sponsorKeypair.publicKey.toBase58(),
        requireSponsorSignature: false,
      });
      if (!preCheck.valid) {
        throw new Error(preCheck.error || 'User signature or message integrity check failed');
      }
    } else {
      const messageBytes = tx.message.serialize();
      const numRequired = tx.message.header.numRequiredSignatures;
      let foundValidUserSig = false;
      for (let i = 1; i < numRequired; i++) {
        const signerPk = staticKeys[i];
        const sig = tx.signatures[i];
        if (
          signerPk &&
          sig &&
          TransactionVerificationService.verifyEd25519Signature(signerPk, messageBytes, sig)
        ) {
          foundValidUserSig = true;
          break;
        }
      }
      if (!foundValidUserSig) {
        throw new Error(
          'Refusing to co-sign as fee payer: transaction does not contain a valid user cryptographic signature.'
        );
      }
    }

    tx.sign([sponsorKeypair]);

    const messageBytesAfter = tx.message.serialize();
    if (
      !TransactionVerificationService.verifyEd25519Signature(
        sponsorKeypair.publicKey,
        messageBytesAfter,
        tx.signatures[0]
      )
    ) {
      throw new Error('Failed to verify sponsor Ed25519 signature after co-signing');
    }

    return {
      signedTransactionBase64: Buffer.from(tx.serialize()).toString('base64'),
      sponsorPublicKey: sponsorKeypair.publicKey.toBase58(),
    };
  }

  static reserveSponsorshipForBatches(params: {
    sessionId: string;
    walletAddress: string;
    network: SolanaNetwork;
    isSubsidized: boolean;
    batches: TransactionBatch[];
  }): void {
    for (const b of params.batches) {
      if (b.sponsorshipApplied && b.sponsorPublicKey) {
        this.recordSponsorshipExpenditure({
          id: `spon_${b.batchId}`,
          sessionId: params.sessionId,
          batchId: b.batchId,
          walletAddress: params.walletAddress,
          sponsorPublicKey: b.sponsorPublicKey,
          network: params.network,
          lamportsSponsored: b.estimatedFeeLamports,
          usdValueSponsored: b.estimatedFeeUsd,
          isSubsidized: params.isSubsidized,
          status: 'RESERVED',
        });
      }
    }
  }

  static recordSponsorshipExpenditure(params: {
    id: string;
    sessionId: string;
    batchId?: string;
    walletAddress: string;
    sponsorPublicKey: string;
    network: SolanaNetwork;
    lamportsSponsored: number;
    usdValueSponsored: number;
    isSubsidized: boolean;
    status: 'RESERVED' | 'CONFIRMED' | 'FAILED';
    signature?: string;
  }): void {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO sponsorship_records (
        id, session_id, batch_id, wallet_address, sponsor_public_key,
        network, lamports_sponsored, usd_value_sponsored, is_subsidized,
        status, signature, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    stmt.run(
      params.id,
      params.sessionId,
      params.batchId ?? null,
      params.walletAddress,
      params.sponsorPublicKey,
      params.network,
      params.lamportsSponsored,
      params.usdValueSponsored,
      params.isSubsidized ? 1 : 0,
      params.status,
      params.signature ?? null
    );
  }

  static getWalletAndDailyUsage(walletAddress: string): {
    walletUsedLamports: number;
    dailyUsedLamports: number;
    walletHourlyCount: number;
  } {
    try {
      const db = getDb();
      const walletRow = db
        .prepare(
          `SELECT COALESCE(SUM(lamports_sponsored), 0) as total
           FROM sponsorship_records
           WHERE wallet_address = ? AND status != 'FAILED'
           AND created_at >= datetime('now', '-1 day')`
        )
        .get(walletAddress) as { total: number } | undefined;

      const dailyRow = db
        .prepare(
          `SELECT COALESCE(SUM(lamports_sponsored), 0) as total
           FROM sponsorship_records
           WHERE status != 'FAILED'
           AND created_at >= datetime('now', '-1 day')`
        )
        .get() as { total: number } | undefined;

      const hourlyRow = db
        .prepare(
          `SELECT COUNT(DISTINCT session_id) as cnt
           FROM sponsorship_records
           WHERE wallet_address = ?
           AND created_at >= datetime('now', '-1 hour')`
        )
        .get(walletAddress) as { cnt: number } | undefined;

      return {
        walletUsedLamports: Number(walletRow?.total ?? 0),
        dailyUsedLamports: Number(dailyRow?.total ?? 0),
        walletHourlyCount: Number(hourlyRow?.cnt ?? 0),
      };
    } catch {
      return {
        walletUsedLamports: 0,
        dailyUsedLamports: 0,
        walletHourlyCount: 0,
      };
    }
  }

  static getSponsorshipBudgetUsage(): { dailyUsedLamports: number } {
    const u = this.getWalletAndDailyUsage('');
    return { dailyUsedLamports: u.dailyUsedLamports };
  }
}
