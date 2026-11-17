import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  getRpcUrlForNetwork,
  SOL_MINT_ADDRESS,
  TOKEN_ACCOUNT_RENT_LAMPORTS,
  USDC_DEVNET_MINT,
  USDC_MAINNET_MINT,
} from '../src/lib/config';
import { PricingService } from '../src/services/pricingService';
import { JupiterService } from '../src/services/jupiterService';
import { SponsorshipService } from '../src/services/sponsorshipService';
import { TransactionBatcher } from '../src/services/transactionBatcher';
import { TransactionVerificationService } from '../src/services/transactionVerificationService';
import { VacuumTokenService } from '../src/services/vacuumTokenService';
import { ApiSecurity } from '../src/lib/apiSecurity';

/**
 * PHASE 12 — Read-Only Mainnet-Beta Verification Script (`npm run test:mainnet-readonly`).
 *
 * Strictly Read-Only:
 * - Connects to Solana Mainnet-Beta RPC and official Jupiter V3 Price & V2 Swap APIs.
 * - Verifies live Mainnet quotes, market liquidity, network isolation, and unsigned transaction construction.
 * - STOPS before signing or broadcasting any Mainnet transaction. Zero Mainnet funds are spent.
 */
async function main() {
  console.log('===================================================================');
  console.log('VACUUM — PHASE 12 READ-ONLY MAINNET-BETA VERIFICATION (NO SPEND)');
  console.log('===================================================================');

  const mainnetRpc = getRpcUrlForNetwork('mainnet-beta');
  const connection = new Connection(mainnetRpc, 'confirmed');

  // 1. Verify Mainnet RPC Connection
  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  console.log(`1. Mainnet RPC Connected     : ${mainnetRpc}`);
  console.log(`   Latest Mainnet Blockhash  : ${latestBlockhash.blockhash} (lastValidBlockHeight: ${latestBlockhash.lastValidBlockHeight})`);

  // 2. Verify Live Jupiter Price API V3 Market Data & Liquidity
  const marketData = await PricingService.fetchTokenMarketData([
    SOL_MINT_ADDRESS,
    USDC_MAINNET_MINT,
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
    'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', // JUP
  ]);
  console.log('\n2. Live Mainnet Market Data (Jupiter Price API V3):');
  for (const [mint, info] of Object.entries(marketData)) {
    console.log(
      `   - ${mint.slice(0, 8)}... : price=$${info.priceUsd.toFixed(6)} | poolLiquidity=$${(info.liquidityUsd ?? 0).toLocaleString()}`
    );
  }

  // 3. Verify Live Jupiter Swap API V2 Quote Retrieval & Validation
  const jupOrder = await JupiterService.getOrder({
    inputMint: USDC_MAINNET_MINT,
    outputMint: SOL_MINT_ADDRESS,
    amount: '1000000', // 1.00 USDC
    slippageBps: 100,
  });
  const quoteValidation = JupiterService.validateOrderQuote(jupOrder, 5.0, false);
  console.log('\n3. Live Jupiter Swap API V2 Quote (/swap/v2/order):', {
    mode: jupOrder.mode,
    router: jupOrder.router,
    inAmountRaw: jupOrder.inAmount,
    outAmountRaw: jupOrder.outAmount,
    minOutputThresholdRaw: jupOrder.otherAmountThreshold,
    priceImpactPct: jupOrder.priceImpactPct,
    expireAtMs: jupOrder.expireAt,
    validation: quoteValidation,
  });

  // 4. Verify Mainnet Network & Credential Isolation
  const mainnetSponsorKp = SponsorshipService.getServerSponsorKeypair('mainnet-beta');
  const mainnetSponsorStatus = SponsorshipService.getSponsorPublicStatus('mainnet-beta');
  const vacuumDestinations = VacuumTokenService.getSupportedDestinations('mainnet-beta');
  const crossMintCheck = ApiSecurity.isCrossNetworkMintViolation(USDC_DEVNET_MINT, 'mainnet-beta');

  console.log('\n4. Mainnet Safety & Network Isolation Checks:', {
    devnetKeyRejectedOnMainnet: mainnetSponsorKp === null,
    mainnetSponsorshipEnabledByDefault: mainnetSponsorStatus.enabled,
    devnetUsdcBlockedOnMainnet: crossMintCheck.violated,
    vacuumMainnetDestinationConfigured: vacuumDestinations.find((d) => d.symbol === 'VACUUM')
      ?.isConfiguredForNetwork,
    supportedMainnetLiveDestinations: vacuumDestinations
      .filter((d) => d.isConfiguredForNetwork)
      .map((d) => d.symbol),
  });

  // 5. Prepare Unsigned Mainnet Rent-Reclamation Transaction (STOP BEFORE SIGNING/BROADCASTING)
  const sampleMainnetUser = Keypair.generate().publicKey;
  const sampleEmptyTokenAccount = Keypair.generate().publicKey;

  const batches = TransactionBatcher.groupQuoteItemsIntoBatches(
    [
      {
        mintAddress: USDC_MAINNET_MINT,
        tokenAccountAddress: sampleEmptyTokenAccount.toBase58(),
        programId: TOKEN_PROGRAM_ID.toBase58(),
        isToken2022: false,
        reclaimableRentLamports: TOKEN_ACCOUNT_RENT_LAMPORTS,
        reclaimableRentUsd: 0.15,
        symbol: 'USDC',
        name: 'USD Coin (Empty ATA)',
        decimals: 6,
        inputRawAmount: '0',
        inputUiAmount: 0,
        inputValueUsd: 0,
        destinationMint: SOL_MINT_ADDRESS,
        destinationSymbol: 'SOL',
        expectedOutputRaw: String(TOKEN_ACCOUNT_RENT_LAMPORTS),
        expectedOutputUi: TOKEN_ACCOUNT_RENT_LAMPORTS / 1e9,
        minOutputRaw: String(TOKEN_ACCOUNT_RENT_LAMPORTS),
        minOutputUi: TOKEN_ACCOUNT_RENT_LAMPORTS / 1e9,
        expectedOutputUsd: 0.15,
        priceImpactPct: 0,
        routerLabel: 'SPL CloseAccount Rent Recovery',
        estimatedComputeUnits: 25_000,
        estimatedTransactionBytes: 96,
        accountCount: 3,
        usesLookupTable: false,
        quoteExpiresAt: Date.now() + 90_000,
        actionType: 'CLOSE_EMPTY_ACCOUNT',
      },
    ],
    {
      sessionId: 'vac_mainnet_readonly',
      walletAddress: sampleMainnetUser.toBase58(),
      network: 'mainnet-beta',
      sponsorPublicKey: null,
      sponsorshipApplied: false,
      solPriceUsd: marketData[SOL_MINT_ADDRESS]?.priceUsd || 185.4,
    }
  );

  const unsignedMainnetTxB64 = await TransactionBatcher.buildCompositeVersionedTransaction({
    batch: batches[0],
    userWalletAddress: sampleMainnetUser.toBase58(),
    network: 'mainnet-beta',
    recentBlockhashOverride: latestBlockhash.blockhash,
  });

  const deserializedTx = VersionedTransaction.deserialize(
    Buffer.from(unsignedMainnetTxB64, 'base64')
  );
  const rentDestCheck = TransactionVerificationService.verifyCloseAccountRentDestination(
    deserializedTx,
    sampleMainnetUser.toBase58()
  );

  console.log('\n5. Prepared Mainnet Unsigned Transaction Inspection (STOPPED BEFORE SIGN/BROADCAST):', {
    status: 'PREPARED_NOT_EXECUTED',
    txVersion: deserializedTx.version,
    serializedBytes: Buffer.from(unsignedMainnetTxB64, 'base64').length,
    feePayer: deserializedTx.message.staticAccountKeys[0].toBase58(),
    instructionCount: deserializedTx.message.compiledInstructions.length,
    closeAccountRentDestinationVerified: rentDestCheck.valid,
    expectedBasePlusPriorityFeeLamports: batches[0].estimatedFeeLamports,
    expectedRentReclaimedLamports: TOKEN_ACCOUNT_RENT_LAMPORTS,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
