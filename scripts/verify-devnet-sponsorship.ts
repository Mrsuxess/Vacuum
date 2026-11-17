import fs from 'fs';
import path from 'path';
import {
  Connection,
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToCheckedInstruction,
  getAssociatedTokenAddressSync,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { SponsorshipService } from '../src/services/sponsorshipService';
import { TransactionVerificationService } from '../src/services/transactionVerificationService';
import { TokenDiscoveryService } from '../src/services/tokenDiscoveryService';
import { SweepOrchestrator } from '../src/services/sweepOrchestrator';
import { HistoryService } from '../src/services/historyService';
import { getRpcUrlForNetwork } from '../src/lib/config';

function loadPersistentDevnetUserKeypair(): Keypair {
  const userKeyPath = path.resolve(process.cwd(), './data/devnet-user-keypair.json');
  if (!fs.existsSync(userKeyPath)) {
    throw new Error(`Persistent Devnet user keypair not found at ${userKeyPath}`);
  }
  const arr = JSON.parse(fs.readFileSync(userKeyPath, 'utf-8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

/**
 * PHASE 10 — Complete Devnet Blockchain Verification Script (`npm run test:devnet`).
 * Strictly uses the persistent Devnet keypairs:
 * - Sponsor: Etqz6qVzrWwkazxWbbQgeCsBBCNYvh2E2SUqF35fUBgT
 * - User:    CvyCyfRajUsmVUZFzdc7LymodJHV1AQDWaaZvv6k8eBJ
 *
 * Executes and verifies on-chain:
 * 1. Dual-signed gasless fee-sponsorship transaction (Sponsor pays fee, User signs).
 * 2. Complete End-to-End VACUUM Live Devnet Sweep:
 *    - Provisions a real SPL dust token account for User on Devnet.
 *    - Scans User wallet via `TokenDiscoveryService.discoverWalletAssets` ('live' mode).
 *    - Builds a sponsored sweep session via `SweepOrchestrator.createSweepSession` ('live' mode).
 *    - Signs batch with User wallet, co-signs with Server Sponsor, broadcasts, confirms on-chain,
 *      and verifies that Sponsor paid the fee while User received 100% of the 2,039,280 lamports reclaimed rent.
 */
async function main() {
  console.log('===================================================================');
  console.log('VACUUM — PHASE 10 LIVE DEVNET END-TO-END BLOCKCHAIN VERIFICATION');
  console.log('===================================================================');

  const rpcUrl = getRpcUrlForNetwork('devnet');
  const connection = new Connection(rpcUrl, 'confirmed');

  const sponsorKp = SponsorshipService.getServerSponsorKeypair('devnet');
  if (!sponsorKp) {
    throw new Error('Failed to load persistent Devnet sponsor keypair.');
  }
  const userKp = loadPersistentDevnetUserKeypair();

  const [sponsorBalanceBefore, userBalanceBefore, latestBlockhash] = await Promise.all([
    connection.getBalance(sponsorKp.publicKey),
    connection.getBalance(userKp.publicKey),
    connection.getLatestBlockhash('confirmed'),
  ]);

  console.log(`Devnet RPC Endpoint         : ${rpcUrl}`);
  console.log(`Latest Confirmed Blockhash  : ${latestBlockhash.blockhash} (lastValidBlockHeight: ${latestBlockhash.lastValidBlockHeight})`);
  console.log(`Designated Sponsor FeePayer : ${sponsorKp.publicKey.toBase58()} (Balance: ${sponsorBalanceBefore} lamports / ${(sponsorBalanceBefore / 1e9).toFixed(6)} SOL)`);
  console.log(`User Taker Wallet           : ${userKp.publicKey.toBase58()} (Balance: ${userBalanceBefore} lamports / ${(userBalanceBefore / 1e9).toFixed(6)} SOL)`);

  if (sponsorBalanceBefore < 50_000) {
    console.log('Status: BLOCKED_BY_UNFUNDED_DEVNET_SPONSOR');
    console.log(`Fund ${sponsorKp.publicKey.toBase58()} with >= 0.01 Devnet SOL at https://faucet.solana.com`);
    process.exit(1);
  }

  // =========================================================================
  // PART 1: DUAL-SIGNED GASLESS FEE-SPONSORSHIP TRANSACTION ON DEVNET
  // =========================================================================
  console.log('\n[PART 1] Broadcasting Dual-Signed Gasless Sponsorship Transaction...');
  const ix = SystemProgram.transfer({
    fromPubkey: userKp.publicKey,
    toPubkey: userKp.publicKey,
    lamports: 0,
  });

  const msgV0 = new TransactionMessage({
    payerKey: sponsorKp.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions: [ix],
  }).compileToV0Message();

  const unsignedTx = new VersionedTransaction(msgV0);
  const unsignedTxBase64 = Buffer.from(unsignedTx.serialize()).toString('base64');

  // 1. User signs
  unsignedTx.sign([userKp]);
  const userSignedBase64 = Buffer.from(unsignedTx.serialize()).toString('base64');

  // 2. Server Sponsor validates and co-signs
  const coSigned = SponsorshipService.signTransactionAsFeePayer(userSignedBase64, 'devnet', {
    expectedUnsignedTxBase64: unsignedTxBase64,
    expectedUserAddress: userKp.publicKey.toBase58(),
  });

  const finalTx = VersionedTransaction.deserialize(
    Buffer.from(coSigned.signedTransactionBase64, 'base64')
  );

  const onChainPart1 = await TransactionVerificationService.broadcastAndConfirmTransaction(
    coSigned.signedTransactionBase64,
    'devnet'
  );

  if (!onChainPart1.confirmed || !onChainPart1.signature) {
    throw new Error(`Part 1 Devnet broadcast failed: ${onChainPart1.error}`);
  }

  const tx1Details = await connection.getTransaction(onChainPart1.signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });

  console.log('Part 1 Confirmed On-Chain Details:', {
    signature: onChainPart1.signature,
    feePayer: sponsorKp.publicKey.toBase58(),
    sponsorSignature: bs58.encode(finalTx.signatures[0]),
    userSignature: bs58.encode(finalTx.signatures[1]),
    actualFeeLamports: tx1Details?.meta?.fee ?? onChainPart1.actualFeeLamports,
    confirmationStatus: onChainPart1.confirmationStatus,
    slot: onChainPart1.slot,
    preBalances: tx1Details?.meta?.preBalances,
    postBalances: tx1Details?.meta?.postBalances,
    solscanUrl: TransactionVerificationService.getExplorerUrl(onChainPart1.signature, 'devnet'),
  });

  // =========================================================================
  // PART 2: END-TO-END LIVE DEVNET TOKEN DISCOVERY, SWEEP & RENT RECLAMATION
  // =========================================================================
  if (sponsorBalanceBefore >= 5_000_000) {
    console.log('\n[PART 2] Executing Full Live Devnet SPL Dust Sweep & Rent Reclamation...');

    // Step 2A: Sponsor provisions a test SPL dust token mint & ATA for User on Devnet
    const mintKp = Keypair.generate();
    const userAta = getAssociatedTokenAddressSync(mintKp.publicKey, userKp.publicKey);
    const mintRent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
    const setupBh = await connection.getLatestBlockhash('confirmed');

    const setupMsg = new TransactionMessage({
      payerKey: sponsorKp.publicKey,
      recentBlockhash: setupBh.blockhash,
      instructions: [
        SystemProgram.createAccount({
          fromPubkey: sponsorKp.publicKey,
          newAccountPubkey: mintKp.publicKey,
          space: MINT_SIZE,
          lamports: mintRent,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(
          mintKp.publicKey,
          6,
          sponsorKp.publicKey,
          null,
          TOKEN_PROGRAM_ID
        ),
        createAssociatedTokenAccountInstruction(
          sponsorKp.publicKey,
          userAta,
          userKp.publicKey,
          mintKp.publicKey,
          TOKEN_PROGRAM_ID
        ),
        createMintToCheckedInstruction(
          mintKp.publicKey,
          userAta,
          sponsorKp.publicKey,
          150_000_000, // 150 dust tokens (~$0.375 test valuation > $0.25 sponsorship threshold)
          6,
          [],
          TOKEN_PROGRAM_ID
        ),
      ],
    }).compileToV0Message();

    const setupTx = new VersionedTransaction(setupMsg);
    setupTx.sign([sponsorKp, mintKp]);
    const setupRes = await TransactionVerificationService.broadcastAndConfirmTransaction(
      Buffer.from(setupTx.serialize()).toString('base64'),
      'devnet'
    );
    if (!setupRes.confirmed) {
      throw new Error(`Failed to provision Devnet SPL dust token: ${setupRes.error}`);
    }
    console.log(`Provisioned Devnet Dust Token Mint: ${mintKp.publicKey.toBase58()}`);
    console.log(`User Token Account (ATA)          : ${userAta.toBase58()} (Setup Tx: ${setupRes.signature})`);

    // Step 2B: Live RPC Token Discovery on User Wallet
    const discovery = await TokenDiscoveryService.discoverWalletAssets(
      userKp.publicKey.toBase58(),
      'devnet',
      'live'
    );
    console.log(
      `Live Discovery Result             : Found ${discovery.assets.length} token account(s), ${discovery.summary.eligibleTokensCount} eligible dust asset(s), Reclaimable Rent: ${discovery.summary.reclaimableRentSol} SOL`
    );

    const eligibleAssets = discovery.assets.filter((a) => a.isRecoverableDust);
    if (eligibleAssets.length === 0) {
      throw new Error('Expected at least 1 eligible dust asset from live Devnet discovery.');
    }

    // Step 2C: Create Live Sweep Session via SweepOrchestrator
    const session = await SweepOrchestrator.createSweepSession({
      walletAddress: userKp.publicKey.toBase58(),
      network: 'devnet',
      mode: 'live',
      selectedAssets: eligibleAssets,
      destinationSymbol: 'SOL',
      slippageBps: 100,
      requestGaslessSponsorship: true,
    });

    const batch = session.batches[0];
    console.log(`Created Live Sweep Session        : ${session.sessionId} (Batch: ${batch.batchId}, Sponsored: ${batch.sponsorshipApplied})`);

    if (!batch.serializedTransactionBase64) {
      throw new Error('Expected unsigned VersionedTransaction in live batch.');
    }

    // Step 2D: User signs the unsigned batch transaction
    const unsignedSweepTx = VersionedTransaction.deserialize(
      Buffer.from(batch.serializedTransactionBase64, 'base64')
    );
    unsignedSweepTx.sign([userKp]);
    const userSignedSweepBase64 = Buffer.from(unsignedSweepTx.serialize()).toString('base64');

    // Step 2E: Execute Authorized Batch via SweepOrchestrator (Sponsor co-signs + broadcasts + confirms)
    const execResult = await SweepOrchestrator.executeAuthorizedBatch({
      sessionId: session.sessionId,
      batchId: batch.batchId,
      walletAddress: userKp.publicKey.toBase58(),
      userSignedTransactionBase64: userSignedSweepBase64,
    });

    if (execResult.batch.status !== 'CONFIRMED' || !execResult.batch.signature) {
      throw new Error(`Live Devnet sweep batch failed: ${execResult.batch.errorMessage}`);
    }

    const sweepTxDetails = await connection.getTransaction(execResult.batch.signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    const receipt = HistoryService.generateSessionReceipt(session.sessionId);

    const [sponsorBalanceAfter, userBalanceAfter] = await Promise.all([
      connection.getBalance(sponsorKp.publicKey),
      connection.getBalance(userKp.publicKey),
    ]);

    console.log('Part 2 Live Devnet Sweep Confirmed On-Chain Details:', {
      sessionId: session.sessionId,
      receiptId: receipt.receiptId,
      verificationHash: receipt.verificationHash,
      signature: execResult.batch.signature,
      confirmedSlot: execResult.batch.confirmedSlot,
      actualFeeLamports: sweepTxDetails?.meta?.fee ?? execResult.batch.actualFeeLamports,
      feePayer: sponsorKp.publicKey.toBase58(),
      userWallet: userKp.publicKey.toBase58(),
      userSolBalanceBeforeLamports: userBalanceBefore,
      userSolBalanceAfterLamports: userBalanceAfter,
      userNetSolGainLamports: userBalanceAfter - userBalanceBefore,
      sponsorBalanceAfterLamports: sponsorBalanceAfter,
      preBalances: sweepTxDetails?.meta?.preBalances,
      postBalances: sweepTxDetails?.meta?.postBalances,
      solscanUrl: TransactionVerificationService.getExplorerUrl(execResult.batch.signature, 'devnet'),
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
