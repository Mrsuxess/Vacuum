import crypto from 'crypto';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  BatchStatus,
  DestinationSymbol,
  DiscoveredTokenAsset,
  ExecutionMode,
  SolanaNetwork,
  SweepSession,
  SweepSessionStatus,
  TransactionBatch,
} from '@/types/vacuum';
import { getDb, runInTransaction } from '@/lib/db';
import { TOKEN_ACCOUNT_RENT_LAMPORTS } from '@/lib/config';
import { QuoteService } from '@/services/quoteService';
import { SponsorshipService } from '@/services/sponsorshipService';
import { TransactionBatcher } from '@/services/transactionBatcher';
import { JupiterService } from '@/services/jupiterService';
import { TransactionVerificationService } from '@/services/transactionVerificationService';
import { WalletService } from '@/services/walletService';

export interface CreateSweepSessionInput {
  walletAddress: string;
  network: SolanaNetwork;
  mode: ExecutionMode;
  selectedAssets: DiscoveredTokenAsset[];
  destinationSymbol: DestinationSymbol;
  slippageBps: number;
  requestGaslessSponsorship: boolean;
}

export interface ExecuteSignedBatchInput {
  sessionId: string;
  batchId: string;
  walletAddress?: string;
  network?: SolanaNetwork;
  userSignedTransactionBase64?: string;
}

export class SweepOrchestrator {
  /**
   * STEP 1-7 of the VACUUM Sweep Workflow:
   * Evaluates selected assets, requests executable quotes, checks sponsorship eligibility
   * against exact batch counts, groups into safe transaction batches, builds unsigned
   * VersionedTransactions (for live mode), reserves sponsorship budget atomically in SQLite,
   * and returns the proposed sweep for explicit user authorization.
   */
  static async createSweepSession(
    input: CreateSweepSessionInput
  ): Promise<SweepSession> {
    if (!input.selectedAssets || input.selectedAssets.length === 0) {
      throw new Error('At least one eligible asset must be selected to create a sweep session.');
    }
    if (input.selectedAssets.length > 50) {
      throw new Error('Cannot sweep more than 50 assets in a single session.');
    }
    if (input.mode === 'live' && !WalletService.isValidWalletAddress(input.walletAddress)) {
      throw new Error(`Invalid Solana wallet address: ${input.walletAddress}`);
    }
    if (!Number.isFinite(input.slippageBps) || input.slippageBps < 1 || input.slippageBps > 5000) {
      throw new Error(`Invalid slippageBps (${input.slippageBps}): must be between 1 and 5000.`);
    }

    const sessionId = `vac_${crypto.randomBytes(8).toString('hex')}`;
    const sponsorKeypair = SponsorshipService.getServerSponsorKeypair(input.network);
    const candidateSponsorPubkey =
      input.requestGaslessSponsorship && sponsorKeypair
        ? sponsorKeypair.publicKey.toBase58()
        : null;

    // 1. Build executable quotes with server-side risk re-evaluation & failure isolation
    let quotesResult = await QuoteService.buildExecutableQuotes({
      walletAddress: input.walletAddress,
      network: input.network,
      mode: input.mode,
      selectedAssets: input.selectedAssets,
      destinationSymbol: input.destinationSymbol,
      slippageBps: input.slippageBps,
      sponsorPublicKey: candidateSponsorPubkey,
    });

    if (quotesResult.quoteItems.length === 0) {
      const reasons = quotesResult.skippedAssets.map((s) => `${s.symbol}: ${s.reason}`).join('; ');
      throw new Error(`No selected assets have viable executable routes (${reasons}).`);
    }

    // 2. Group quote items into preliminary batches to determine the EXACT batch count
    const preliminaryBatches = TransactionBatcher.groupQuoteItemsIntoBatches(
      quotesResult.quoteItems,
      {
        sessionId,
        walletAddress: input.walletAddress,
        network: input.network,
        sponsorPublicKey: candidateSponsorPubkey,
        sponsorshipApplied: Boolean(candidateSponsorPubkey),
        solPriceUsd: quotesResult.solPriceUsd,
      }
    );

    const exactBatchCount = Math.max(1, preliminaryBatches.length);

    const totalInputValueUsd = Number(
      quotesResult.quoteItems.reduce((sum, q) => sum + q.inputValueUsd, 0).toFixed(4)
    );
    const expectedDestinationOutputUi = Number(
      quotesResult.quoteItems.reduce((sum, q) => sum + q.expectedOutputUi, 0).toFixed(6)
    );
    const expectedDestinationOutputUsd = Number(
      quotesResult.quoteItems.reduce((sum, q) => sum + q.expectedOutputUsd, 0).toFixed(4)
    );

    // Sum reclaimable rent strictly over valid quoteItems (never over quarantined/skipped assets)
    const totalReclaimableRentLamports = quotesResult.quoteItems.reduce(
      (sum, q) => sum + (q.reclaimableRentLamports ?? 0),
      0
    );
    const expectedRentReclaimSol = Number((totalReclaimableRentLamports / 1e9).toFixed(6));
    const expectedRentReclaimUsd = Number(
      (expectedRentReclaimSol * quotesResult.solPriceUsd).toFixed(4)
    );
    const expectedSwapOutputUsd = Number(
      Math.max(0, expectedDestinationOutputUsd - expectedRentReclaimUsd).toFixed(4)
    );
    const closeAccountsCount = quotesResult.quoteItems.filter(
      (q) => q.actionType === 'CLOSE_EMPTY_ACCOUNT'
    ).length;
    const swapAssetsCount = quotesResult.quoteItems.length - closeAccountsCount;

    // 3. Evaluate sponsorship eligibility using exact batch count and verified quote proceeds
    const sponsorshipEval = input.requestGaslessSponsorship
      ? SponsorshipService.evaluateSponsorshipEligibility({
          walletAddress: input.walletAddress,
          network: input.network,
          estimatedLiquidationUsd: expectedDestinationOutputUsd,
          batchCount: exactBatchCount,
          requiresDestinationAtaCreation: false,
          reclaimableRentLamports: totalReclaimableRentLamports,
          solPriceUsd: quotesResult.solPriceUsd,
        })
      : {
          eligible: false,
          mode: 'USER_SELF_PAID' as const,
          sponsorPublicKey: null,
          estimatedLiquidationUsd: expectedDestinationOutputUsd,
          estimatedNetworkFeeLamports: exactBatchCount * 10_000,
          estimatedPriorityFeeLamports: exactBatchCount * 15_000,
          estimatedAtaCreationLamports: 0,
          reclaimableRentLamports: totalReclaimableRentLamports,
          platformServiceFeeUsd: 0,
          platformServiceFeeBps: 0,
          expectedExecutionRiskUsd: 0,
          estimatedNetRecoveryUsd: expectedDestinationOutputUsd,
          sponsorshipCostLamports: 0,
          sponsorshipCostUsd: 0,
          isSubsidized: false,
          subsidyAmountUsd: 0,
          reason: 'User opted for self-paid network fees.',
          remainingWalletAllowanceLamports: 0,
          remainingDailyBudgetLamports: 0,
          solFlowBreakdown: {
            networkFeePayer: 'USER' as const,
            priorityFeePayer: 'USER' as const,
            ataCreationPayer: 'NONE' as const,
            rentRefundRecipient: 'USER' as const,
            swapProceedsRecipient: 'USER' as const,
            sponsorRecoveryMechanism: 'NONE' as const,
          },
        };

    // 4. If sponsorship was requested with a candidate sponsor key on mainnet live mode,
    //    but sponsorshipEval determined the sweep is NOT eligible, re-request Jupiter orders
    //    without `payer` so the transaction fee payer matches the user's wallet.
    if (
      candidateSponsorPubkey &&
      !sponsorshipEval.eligible &&
      input.mode === 'live' &&
      input.network === 'mainnet-beta'
    ) {
      quotesResult = await QuoteService.buildExecutableQuotes({
        walletAddress: input.walletAddress,
        network: input.network,
        mode: input.mode,
        selectedAssets: input.selectedAssets,
        destinationSymbol: input.destinationSymbol,
        slippageBps: input.slippageBps,
        sponsorPublicKey: null,
      });
    }

    // 5. Group quote items into final Solana transaction batches with confirmed sponsorship state
    const batches = TransactionBatcher.groupQuoteItemsIntoBatches(quotesResult.quoteItems, {
      sessionId,
      walletAddress: input.walletAddress,
      network: input.network,
      sponsorPublicKey: sponsorshipEval.eligible ? sponsorshipEval.sponsorPublicKey : null,
      sponsorshipApplied: sponsorshipEval.eligible,
      solPriceUsd: quotesResult.solPriceUsd,
    });

    // 6. For Live Composite batches (Devnet or Mainnet CloseAccount batches), build the unsigned VersionedTransaction
    if (input.mode === 'live') {
      for (const batch of batches) {
        if (!batch.serializedTransactionBase64) {
          try {
            batch.serializedTransactionBase64 =
              await TransactionBatcher.buildCompositeVersionedTransaction({
                batch,
                userWalletAddress: input.walletAddress,
                network: input.network,
              });
          } catch {
            // If offline or RPC unreachable during unit test, leave null until execution
          }
        }
      }
    }

    const estimatedNetworkCostUsd = sponsorshipEval.eligible
      ? 0
      : Number(
          batches.reduce((sum, b) => sum + b.estimatedFeeUsd, 0).toFixed(4)
        );
    const estimatedNetResultUsd = Number(
      (
        expectedDestinationOutputUsd -
        estimatedNetworkCostUsd -
        sponsorshipEval.platformServiceFeeUsd
      ).toFixed(4)
    );

    const session: SweepSession = {
      sessionId,
      walletAddress: input.walletAddress,
      network: input.network,
      mode: input.mode,
      destinationSymbol: input.destinationSymbol,
      destinationMint: quotesResult.destinationMint,
      slippageBps: input.slippageBps,
      status: 'AWAITING_AUTHORIZATION',
      totalAssetsSelected: quotesResult.quoteItems.length,
      swapAssetsCount,
      closeAccountsCount,
      totalInputValueUsd,
      expectedSwapOutputUsd,
      expectedRentReclaimSol,
      expectedRentReclaimUsd,
      expectedDestinationOutputUi,
      expectedDestinationOutputUsd,
      actualDestinationOutputUi: 0,
      estimatedNetworkCostUsd,
      estimatedNetResultUsd,
      sponsorshipEvaluation: sponsorshipEval,
      batches,
      skippedAssets: quotesResult.skippedAssets,
      createdAt: new Date().toISOString(),
    };

    // 7. Atomically persist session, batches, items, and sponsorship budget reservations
    this.persistSession(session);
    return session;
  }

  /**
   * STEP 8-11 of the VACUUM Sweep Workflow:
   * Executes an explicitly authorized transaction batch with cross-network isolation,
   * replay/idempotency protection, cryptographic Ed25519 signature verification,
   * byte-for-byte transaction tampering detection, fee-payer co-signing, and on-chain confirmation verification.
   */
  static async executeAuthorizedBatch(
    input: ExecuteSignedBatchInput
  ): Promise<{
    session: SweepSession;
    batch: TransactionBatch;
  }> {
    const session = this.getSessionById(input.sessionId);
    if (!session) {
      throw new Error(`Sweep session not found: ${input.sessionId}`);
    }

    if (input.network && input.network !== session.network) {
      throw new Error(
        `Network isolation violation: session ${session.sessionId} is bound to ${session.network}, rejecting execution request for ${input.network}.`
      );
    }

    if (input.walletAddress && input.walletAddress !== session.walletAddress) {
      throw new Error(
        `Wallet ownership mismatch: request wallet (${input.walletAddress}) does not own session (${session.walletAddress}).`
      );
    }

    const batch = session.batches.find((b) => b.batchId === input.batchId);
    if (!batch) {
      throw new Error(`Transaction batch not found: ${input.batchId}`);
    }

    // 0. Idempotency & Duplicate Execution Guard
    if (batch.status === 'CONFIRMED') {
      throw new Error(
        `Duplicate execution request rejected: batch ${batch.batchId} has already been confirmed (${batch.signature}).`
      );
    }
    if (batch.status === 'SUBMITTING') {
      throw new Error(
        `Concurrent duplicate execution rejected: batch ${batch.batchId} is currently submitting.`
      );
    }
    if (session.status === 'COMPLETED' || session.status === 'CANCELLED') {
      throw new Error(
        `Cannot execute batch: session ${session.sessionId} is already ${session.status}.`
      );
    }

    // 1. Check quote expiration
    if (Date.now() > batch.expiresAt) {
      batch.status = 'EXPIRED';
      batch.errorMessage = 'Batch quote expired before execution. Please refresh quotes.';
      if (batch.sponsorshipApplied && batch.sponsorPublicKey) {
        SponsorshipService.recordSponsorshipExpenditure({
          id: `spon_${batch.batchId}`,
          sessionId: session.sessionId,
          batchId: batch.batchId,
          walletAddress: session.walletAddress,
          sponsorPublicKey: batch.sponsorPublicKey,
          network: session.network,
          lamportsSponsored: 0,
          usdValueSponsored: 0,
          isSubsidized: session.sponsorshipEvaluation.isSubsidized,
          status: 'FAILED',
        });
      }
      this.updateBatchAndSessionState(session, batch);
      return { session, batch };
    }

    // 2. Handle explicit Demo Mode vs Live Blockchain Mode
    if (session.mode === 'demo') {
      batch.status = 'CONFIRMED';
      // Explicitly marked demo reference — NEVER a fake base58 blockchain signature
      batch.signature = `DEMO_SIMULATION_ONLY_${batch.batchId}`;
      batch.confirmedSlot = 0;
      batch.actualFeeLamports = batch.estimatedFeeLamports;
      if (batch.sponsorshipApplied && batch.sponsorPublicKey) {
        SponsorshipService.recordSponsorshipExpenditure({
          id: `spon_${batch.batchId}`,
          sessionId: session.sessionId,
          batchId: batch.batchId,
          walletAddress: session.walletAddress,
          sponsorPublicKey: batch.sponsorPublicKey,
          network: session.network,
          lamportsSponsored: batch.estimatedFeeLamports,
          usdValueSponsored: batch.estimatedFeeUsd,
          isSubsidized: session.sponsorshipEvaluation.isSubsidized,
          status: 'CONFIRMED',
          signature: batch.signature,
        });
      }
      this.updateBatchAndSessionState(session, batch);
      return { session, batch };
    }

    // LIVE MODE REQUIREMENT: Must have user-signed transaction
    if (!input.userSignedTransactionBase64 || input.userSignedTransactionBase64.trim().length === 0) {
      throw new Error(
        'Explicit user wallet signature (userSignedTransactionBase64) is required for live execution.'
      );
    }

    const expectedFeePayer =
      batch.sponsorshipApplied && batch.sponsorPublicKey
        ? batch.sponsorPublicKey
        : session.walletAddress;

    // 3. Verify User Cryptographic Signature & Byte-for-Byte Message Integrity BEFORE Co-Signing or Broadcasting
    const integrityCheck = TransactionVerificationService.verifySignedTransactionIntegrity({
      signedTxBase64: input.userSignedTransactionBase64,
      expectedUnsignedTxBase64: batch.serializedTransactionBase64,
      expectedUserAddress: session.walletAddress,
      expectedFeePayerAddress: expectedFeePayer,
      requireSponsorSignature: false,
    });

    if (!integrityCheck.valid) {
      batch.status = 'FAILED';
      batch.errorMessage =
        integrityCheck.error || 'Signed transaction failed cryptographic integrity verification';
      if (batch.sponsorshipApplied && batch.sponsorPublicKey) {
        SponsorshipService.recordSponsorshipExpenditure({
          id: `spon_${batch.batchId}`,
          sessionId: session.sessionId,
          batchId: batch.batchId,
          walletAddress: session.walletAddress,
          sponsorPublicKey: batch.sponsorPublicKey,
          network: session.network,
          lamportsSponsored: 0,
          usdValueSponsored: 0,
          isSubsidized: session.sponsorshipEvaluation.isSubsidized,
          status: 'FAILED',
        });
      }
      this.updateBatchAndSessionState(session, batch);
      throw new Error(batch.errorMessage);
    }

    // Atomically lock batch in SUBMITTING state before network broadcast
    batch.status = 'SUBMITTING';
    this.updateBatchAndSessionState(session, batch);

    let finalSignedTxBase64 = input.userSignedTransactionBase64;

    try {
      // 4. Server-side Fee-Payer Co-signing if Sponsored
      if (batch.sponsorshipApplied && batch.sponsorPublicKey) {
        const coSigned = SponsorshipService.signTransactionAsFeePayer(
          finalSignedTxBase64,
          session.network,
          {
            expectedUnsignedTxBase64: batch.serializedTransactionBase64,
            expectedUserAddress: session.walletAddress,
          }
        );
        finalSignedTxBase64 = coSigned.signedTransactionBase64;
      }

      // 5. Execute via Jupiter Swap API V2 `/swap/v2/execute` if this is a Jupiter V2 order batch
      if (batch.jupiterRequestId && session.network === 'mainnet-beta') {
        const execRes = await JupiterService.executeOrder({
          signedTransaction: finalSignedTxBase64,
          requestId: batch.jupiterRequestId,
        });

        if (execRes.status === 'Failed' || !execRes.signature) {
          batch.status = 'FAILED';
          batch.signature = execRes.signature || undefined;
          batch.errorMessage = execRes.error || 'Jupiter Swap API V2 execution failed';
          this.recordBatchSponsorshipOutcome(session, batch, 'FAILED');
          this.updateBatchAndSessionState(session, batch);
          return { session, batch };
        }

        // Verify confirmation on-chain
        const verifyRes = await TransactionVerificationService.verifySignatureConfirmation(
          execRes.signature,
          session.network
        );

        if (!verifyRes.confirmed) {
          batch.status = 'FAILED';
          batch.signature = execRes.signature;
          batch.actualFeeLamports = verifyRes.actualFeeLamports;
          batch.errorMessage = verifyRes.error || 'Transaction failed on-chain verification';
          this.recordBatchSponsorshipOutcome(session, batch, 'FAILED');
          this.updateBatchAndSessionState(session, batch);
          return { session, batch };
        }

        batch.status = 'CONFIRMED';
        batch.signature = execRes.signature;
        batch.confirmedSlot = verifyRes.slot;
        batch.actualFeeLamports = verifyRes.actualFeeLamports ?? batch.estimatedFeeLamports;
      } else {
        // 6. Direct Solana RPC Broadcast + On-Chain Confirmation Verification
        const verifyRes =
          await TransactionVerificationService.broadcastAndConfirmTransaction(
            finalSignedTxBase64,
            session.network
          );

        if (!verifyRes.confirmed) {
          batch.status = 'FAILED';
          batch.signature = verifyRes.signature || undefined;
          batch.actualFeeLamports = verifyRes.actualFeeLamports;
          batch.errorMessage = verifyRes.error || 'Transaction failed RPC confirmation';
          this.recordBatchSponsorshipOutcome(session, batch, 'FAILED');
          this.updateBatchAndSessionState(session, batch);
          return { session, batch };
        }

        batch.status = 'CONFIRMED';
        batch.signature = verifyRes.signature;
        batch.confirmedSlot = verifyRes.slot;
        batch.actualFeeLamports = verifyRes.actualFeeLamports ?? batch.estimatedFeeLamports;
      }

      // 7. Finalize Sponsorship Expenditure Record as CONFIRMED
      this.recordBatchSponsorshipOutcome(session, batch, 'CONFIRMED');
    } catch (err) {
      batch.status = 'FAILED';
      batch.errorMessage = err instanceof Error ? err.message : String(err);
      this.recordBatchSponsorshipOutcome(session, batch, 'FAILED');
    }

    this.updateBatchAndSessionState(session, batch);
    return { session, batch };
  }

  private static recordBatchSponsorshipOutcome(
    session: SweepSession,
    batch: TransactionBatch,
    status: 'CONFIRMED' | 'FAILED'
  ): void {
    if (!batch.sponsorshipApplied || !batch.sponsorPublicKey) return;

    const feeLamports =
      status === 'CONFIRMED'
        ? batch.actualFeeLamports ?? batch.estimatedFeeLamports
        : batch.signature
          ? batch.actualFeeLamports ?? 5_000
          : 0;

    SponsorshipService.recordSponsorshipExpenditure({
      id: `spon_${batch.batchId}`,
      sessionId: session.sessionId,
      batchId: batch.batchId,
      walletAddress: session.walletAddress,
      sponsorPublicKey: batch.sponsorPublicKey,
      network: session.network,
      lamportsSponsored: feeLamports,
      usdValueSponsored: batch.estimatedFeeUsd,
      isSubsidized: session.sponsorshipEvaluation.isSubsidized,
      status,
      signature: batch.signature,
    });
  }

  /**
   * Computes the overall SweepSession status from individual batch statuses (Failure Isolation).
   */
  static computeSessionStatusFromBatches(batches: TransactionBatch[]): SweepSessionStatus {
    if (batches.length === 0) return 'FAILED';

    const statuses = batches.map((b) => b.status);
    const allConfirmed = statuses.every((s) => s === 'CONFIRMED');
    if (allConfirmed) return 'COMPLETED';

    const anyPending = statuses.some(
      (s) => s === 'PENDING_SIGNATURE' || s === 'SIGNED' || s === 'SUBMITTING'
    );
    if (anyPending) return 'EXECUTING';

    const someConfirmed = statuses.some((s) => s === 'CONFIRMED');
    if (someConfirmed) return 'PARTIAL_SUCCESS';

    return 'FAILED';
  }

  private static persistSession(session: SweepSession): void {
    runInTransaction((db) => {
      const insertSession = db.prepare(`
        INSERT INTO sweep_sessions (
          session_id, wallet_address, network, mode, destination_symbol,
          destination_mint, slippage_bps, status, total_assets_selected,
          total_input_value_usd, expected_output_ui, expected_output_usd,
          actual_output_ui, estimated_network_cost_usd, estimated_net_result_usd,
          sponsorship_json, skipped_assets_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insertSession.run(
        session.sessionId,
        session.walletAddress,
        session.network,
        session.mode,
        session.destinationSymbol,
        session.destinationMint,
        session.slippageBps,
        session.status,
        session.totalAssetsSelected,
        session.totalInputValueUsd,
        session.expectedDestinationOutputUi,
        session.expectedDestinationOutputUsd,
        session.actualDestinationOutputUi,
        session.estimatedNetworkCostUsd,
        session.estimatedNetResultUsd,
        JSON.stringify(session.sponsorshipEvaluation),
        JSON.stringify(session.skippedAssets),
        session.createdAt
      );

      const insertBatch = db.prepare(`
        INSERT INTO transaction_batches (
          batch_id, session_id, batch_index, total_batches,
          serialized_transaction_base64, jupiter_request_id,
          estimated_fee_lamports, actual_fee_lamports, estimated_fee_usd,
          estimated_compute_units, estimated_bytes,
          sponsorship_applied, sponsor_public_key,
          status, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertItem = db.prepare(`
        INSERT INTO sweep_items (
          id, session_id, batch_id, mint_address, token_account_address,
          program_id, is_token_2022, reclaimable_rent_lamports, reclaimable_rent_usd,
          symbol, name, decimals, input_raw_amount, input_ui_amount,
          input_value_usd, destination_mint, destination_symbol,
          expected_output_raw, expected_output_ui, min_output_raw,
          min_output_ui, expected_output_usd, price_impact_pct,
          router_label, jupiter_request_id, serialized_transaction_base64,
          estimated_compute_units, estimated_bytes, account_count, uses_lookup_table,
          action_type, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const b of session.batches) {
        insertBatch.run(
          b.batchId,
          session.sessionId,
          b.batchIndex,
          b.totalBatches,
          b.serializedTransactionBase64,
          b.jupiterRequestId ?? null,
          b.estimatedFeeLamports,
          b.actualFeeLamports ?? null,
          b.estimatedFeeUsd,
          b.estimatedComputeUnits,
          b.estimatedBytes,
          b.sponsorshipApplied ? 1 : 0,
          b.sponsorPublicKey,
          b.status,
          b.expiresAt,
          b.createdAt,
          b.updatedAt
        );

        for (const item of b.items) {
          insertItem.run(
            `${b.batchId}:${item.tokenAccountAddress}`,
            session.sessionId,
            b.batchId,
            item.mintAddress,
            item.tokenAccountAddress,
            item.programId || TOKEN_PROGRAM_ID.toBase58(),
            item.isToken2022 ? 1 : 0,
            item.reclaimableRentLamports ?? TOKEN_ACCOUNT_RENT_LAMPORTS,
            item.reclaimableRentUsd ?? 0,
            item.symbol,
            item.name,
            item.decimals,
            item.inputRawAmount,
            item.inputUiAmount,
            item.inputValueUsd,
            item.destinationMint,
            item.destinationSymbol,
            item.expectedOutputRaw,
            item.expectedOutputUi,
            item.minOutputRaw,
            item.minOutputUi,
            item.expectedOutputUsd,
            item.priceImpactPct,
            item.routerLabel,
            item.jupiterRequestId ?? null,
            item.serializedTransactionBase64 ?? null,
            item.estimatedComputeUnits,
            item.estimatedTransactionBytes,
            item.accountCount,
            item.usesLookupTable ? 1 : 0,
            item.actionType,
            'PENDING'
          );
        }
      }

      // Reserve sponsorship budget immediately upon session creation
      if (session.sponsorshipEvaluation.eligible) {
        SponsorshipService.reserveSponsorshipForBatches({
          sessionId: session.sessionId,
          walletAddress: session.walletAddress,
          network: session.network,
          isSubsidized: session.sponsorshipEvaluation.isSubsidized,
          batches: session.batches,
        });
      }
    });
  }

  private static updateBatchAndSessionState(
    session: SweepSession,
    batch: TransactionBatch
  ): void {
    runInTransaction((db) => {
      const nowIso = new Date().toISOString();
      batch.updatedAt = nowIso;

      db.prepare(`
        UPDATE transaction_batches
        SET status = ?, signature = ?, confirmed_slot = ?, actual_fee_lamports = ?, error_message = ?, updated_at = ?
        WHERE batch_id = ?
      `).run(
        batch.status,
        batch.signature ?? null,
        batch.confirmedSlot ?? null,
        batch.actualFeeLamports ?? null,
        batch.errorMessage ?? null,
        nowIso,
        batch.batchId
      );

      db.prepare(`
        UPDATE sweep_items
        SET status = ?
        WHERE batch_id = ?
      `).run(batch.status === 'CONFIRMED' ? 'CONFIRMED' : batch.status, batch.batchId);

      // Record both CONFIRMED and terminal FAILED/EXPIRED batch executions in transaction_records
      if (
        batch.signature ||
        batch.status === 'FAILED' ||
        batch.status === 'EXPIRED'
      ) {
        const recordSig = batch.signature || `FAILED_NO_SIG_${batch.batchId}`;
        const batchOutputUi = batch.items.reduce((s, i) => s + i.expectedOutputUi, 0);
        const feeLamports = batch.actualFeeLamports ?? batch.estimatedFeeLamports;
        db.prepare(`
          INSERT OR REPLACE INTO transaction_records (
            signature, session_id, batch_id, wallet_address, network, mode,
            destination_symbol, output_amount_ui, network_fee_lamports,
            sponsored_lamports, confirmation_status, slot, failure_reason, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          recordSig,
          session.sessionId,
          batch.batchId,
          session.walletAddress,
          session.network,
          session.mode,
          session.destinationSymbol,
          batch.status === 'CONFIRMED' ? batchOutputUi : 0,
          feeLamports,
          batch.sponsorshipApplied && batch.status === 'CONFIRMED' ? feeLamports : 0,
          batch.status,
          batch.confirmedSlot ?? null,
          batch.errorMessage ?? null,
          nowIso
        );
      }

      // Recompute session totals
      session.status = this.computeSessionStatusFromBatches(session.batches);
      session.actualDestinationOutputUi = Number(
        session.batches
          .filter((b) => b.status === 'CONFIRMED')
          .reduce(
            (sum, b) => sum + b.items.reduce((isum, i) => isum + i.expectedOutputUi, 0),
            0
          )
          .toFixed(6)
      );

      if (
        session.status === 'COMPLETED' ||
        session.status === 'PARTIAL_SUCCESS' ||
        session.status === 'FAILED'
      ) {
        session.completedAt = nowIso;
      }

      db.prepare(`
        UPDATE sweep_sessions
        SET status = ?, actual_output_ui = ?, completed_at = ?
        WHERE session_id = ?
      `).run(
        session.status,
        session.actualDestinationOutputUi,
        session.completedAt ?? null,
        session.sessionId
      );
    });
  }

  static getSessionById(sessionId: string): SweepSession | null {
    const db = getDb();
    const row = db
      .prepare(`SELECT * FROM sweep_sessions WHERE session_id = ?`)
      .get(sessionId) as Record<string, unknown> | undefined;

    if (!row) return null;

    const batchRows = db
      .prepare(`SELECT * FROM transaction_batches WHERE session_id = ? ORDER BY batch_index ASC`)
      .all(sessionId) as Array<Record<string, unknown>>;

    const itemRows = db
      .prepare(`SELECT * FROM sweep_items WHERE session_id = ?`)
      .all(sessionId) as Array<Record<string, unknown>>;

    const batches: TransactionBatch[] = batchRows.map((b) => {
      const bId = String(b.batch_id);
      const items = itemRows
        .filter((i) => String(i.batch_id) === bId)
        .map((i) => ({
          mintAddress: String(i.mint_address),
          tokenAccountAddress: String(i.token_account_address),
          programId: i.program_id ? String(i.program_id) : TOKEN_PROGRAM_ID.toBase58(),
          isToken2022: Number(i.is_token_2022 || 0) === 1,
          reclaimableRentLamports: Number(
            i.reclaimable_rent_lamports ?? TOKEN_ACCOUNT_RENT_LAMPORTS
          ),
          reclaimableRentUsd: Number(i.reclaimable_rent_usd ?? 0),
          symbol: String(i.symbol),
          name: String(i.name),
          decimals: Number(i.decimals),
          inputRawAmount: String(i.input_raw_amount),
          inputUiAmount: Number(i.input_ui_amount),
          inputValueUsd: Number(i.input_value_usd),
          destinationMint: String(i.destination_mint),
          destinationSymbol: String(i.destination_symbol) as DestinationSymbol,
          expectedOutputRaw: String(i.expected_output_raw),
          expectedOutputUi: Number(i.expected_output_ui),
          minOutputRaw: String(i.min_output_raw),
          minOutputUi: Number(i.min_output_ui),
          expectedOutputUsd: Number(i.expected_output_usd),
          priceImpactPct: Number(i.price_impact_pct),
          routerLabel: String(i.router_label),
          jupiterRequestId: i.jupiter_request_id ? String(i.jupiter_request_id) : undefined,
          serializedTransactionBase64: i.serialized_transaction_base64
            ? String(i.serialized_transaction_base64)
            : null,
          estimatedComputeUnits: Number(i.estimated_compute_units || 60_000),
          estimatedTransactionBytes: Number(i.estimated_bytes || 180),
          accountCount: Number(i.account_count || 6),
          usesLookupTable: Number(i.uses_lookup_table || 0) === 1,
          quoteExpiresAt: Number(b.expires_at),
          actionType: String(i.action_type) as
            | 'JUPITER_SWAP_V2'
            | 'DEVNET_SWAP_AND_RECLAIM'
            | 'CLOSE_EMPTY_ACCOUNT',
        }));

      return {
        batchId: bId,
        sessionId,
        batchIndex: Number(b.batch_index),
        totalBatches: Number(b.total_batches),
        items,
        serializedTransactionBase64: b.serialized_transaction_base64
          ? String(b.serialized_transaction_base64)
          : null,
        jupiterRequestId: b.jupiter_request_id ? String(b.jupiter_request_id) : undefined,
        estimatedFeeLamports: Number(b.estimated_fee_lamports),
        actualFeeLamports:
          b.actual_fee_lamports !== null && b.actual_fee_lamports !== undefined
            ? Number(b.actual_fee_lamports)
            : undefined,
        estimatedFeeUsd: Number(b.estimated_fee_usd),
        estimatedComputeUnits: Number(b.estimated_compute_units),
        estimatedBytes: Number(b.estimated_bytes),
        sponsorshipApplied: Number(b.sponsorship_applied) === 1,
        sponsorPublicKey: b.sponsor_public_key ? String(b.sponsor_public_key) : null,
        status: String(b.status) as BatchStatus,
        signature: b.signature ? String(b.signature) : undefined,
        confirmedSlot:
          b.confirmed_slot !== null && b.confirmed_slot !== undefined
            ? Number(b.confirmed_slot)
            : undefined,
        errorMessage: b.error_message ? String(b.error_message) : undefined,
        createdAt: String(b.created_at),
        updatedAt: String(b.updated_at),
        expiresAt: Number(b.expires_at),
      };
    });

    const allItems = batches.flatMap((b) => b.items);
    const closeAccountsCount = allItems.filter(
      (i) => i.actionType === 'CLOSE_EMPTY_ACCOUNT'
    ).length;
    const swapAssetsCount = allItems.length - closeAccountsCount;
    const totalRentLamports = allItems.reduce(
      (sum, i) => sum + (i.reclaimableRentLamports ?? 0),
      0
    );
    const expectedRentReclaimSol = Number((totalRentLamports / 1e9).toFixed(6));
    const expectedRentReclaimUsd = Number(
      allItems.reduce((sum, i) => sum + (i.reclaimableRentUsd ?? 0), 0).toFixed(4)
    );
    const expectedDestinationOutputUsd = Number(row.expected_output_usd);
    const expectedSwapOutputUsd = Number(
      Math.max(0, expectedDestinationOutputUsd - expectedRentReclaimUsd).toFixed(4)
    );

    return {
      sessionId: String(row.session_id),
      walletAddress: String(row.wallet_address),
      network: String(row.network) as SolanaNetwork,
      mode: String(row.mode) as ExecutionMode,
      destinationSymbol: String(row.destination_symbol) as DestinationSymbol,
      destinationMint: String(row.destination_mint),
      slippageBps: Number(row.slippage_bps),
      status: String(row.status) as SweepSessionStatus,
      totalAssetsSelected: Number(row.total_assets_selected),
      swapAssetsCount,
      closeAccountsCount,
      totalInputValueUsd: Number(row.total_input_value_usd),
      expectedSwapOutputUsd,
      expectedRentReclaimSol,
      expectedRentReclaimUsd,
      expectedDestinationOutputUi: Number(row.expected_output_ui),
      expectedDestinationOutputUsd,
      actualDestinationOutputUi: Number(row.actual_output_ui),
      estimatedNetworkCostUsd: Number(row.estimated_network_cost_usd),
      estimatedNetResultUsd: Number(row.estimated_net_result_usd),
      sponsorshipEvaluation: JSON.parse(String(row.sponsorship_json)),
      batches,
      skippedAssets: JSON.parse(String(row.skipped_assets_json || '[]')),
      createdAt: String(row.created_at),
      completedAt: row.completed_at ? String(row.completed_at) : undefined,
    };
  }
}
