import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  createBurnCheckedInstruction,
  createCloseAccountInstruction,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  SolanaNetwork,
  SweepQuoteItem,
  TransactionBatch,
} from '@/types/vacuum';
import {
  getRpcUrlForNetwork,
  SOLANA_TX_MAX_ACCOUNTS,
  SOLANA_TX_MAX_BYTES,
  SOLANA_TX_MAX_COMPUTE_UNITS,
} from '@/lib/config';

export interface BatchGroupingOptions {
  sessionId: string;
  walletAddress: string;
  network: SolanaNetwork;
  sponsorPublicKey: string | null;
  sponsorshipApplied: boolean;
  solPriceUsd: number;
}

export class TransactionBatcher {
  /**
   * Intelligently groups SweepQuoteItems into safe, executable Solana transaction batches.
   *
   * Architectural Rules Enforced:
   * 1. Pre-built Jupiter Swap API V2 transactions (`serializedTransactionBase64` present)
   *    are already optimized meta-aggregator transactions with ALTs and specific `requestId`s,
   *    so each Jupiter V2 order is placed into its own dedicated 1-item batch to guarantee landing
   *    and preserve `requestId` integrity for `/swap/v2/execute`. Never mixes managed Jupiter V2
   *    execution with custom transaction batching.
   * 2. Native account closure (`CLOSE_EMPTY_ACCOUNT`) / devnet consolidation (`DEVNET_SWAP_AND_RECLAIM`)
   *    instructions are packed into VersionedTransaction v0 batches while strictly enforcing:
   *    - Max serialized size <= 1232 bytes (with 120-byte safety margin -> 1112 bytes)
   *    - Max unique accounts <= 64 (safety margin -> 54 accounts)
   *    - Max compute units <= 1,400,000 CU (safety margin -> 1,100,000 CU)
   */
  static groupQuoteItemsIntoBatches(
    items: SweepQuoteItem[],
    options: BatchGroupingOptions
  ): TransactionBatch[] {
    if (items.length === 0) return [];

    const rawGroups: SweepQuoteItem[][] = [];
    let currentCompositeGroup: SweepQuoteItem[] = [];
    let currentBytes = 260; // Base header + signatures + blockhash + compute budget overhead
    let currentAccounts = 6; // Payer, owner, token program, token-2022 program, system program, compute budget
    let currentComputeUnits = 30_000;

    const SAFE_MAX_BYTES = SOLANA_TX_MAX_BYTES - 120; // 1112 bytes
    const SAFE_MAX_ACCOUNTS = SOLANA_TX_MAX_ACCOUNTS - 10; // 54 accounts
    const SAFE_MAX_CU = SOLANA_TX_MAX_COMPUTE_UNITS - 300_000; // 1.1M CU
    const MAX_COMPOSITE_ITEMS_PER_TX = 6; // Practical atomic instruction density limit

    for (const item of items) {
      // If item carries a pre-built Jupiter V2 transaction (`requestId`), isolate it
      // so Jupiter V2 `/execute` manages its exact unmodified transaction & requestId.
      if (item.actionType === 'JUPITER_SWAP_V2' && item.serializedTransactionBase64) {
        if (currentCompositeGroup.length > 0) {
          rawGroups.push(currentCompositeGroup);
          currentCompositeGroup = [];
          currentBytes = 260;
          currentAccounts = 6;
          currentComputeUnits = 30_000;
        }
        rawGroups.push([item]);
        continue;
      }

      const itemBytes = item.estimatedTransactionBytes || 140;
      const itemAccounts = item.accountCount || 4;
      const itemCu = item.estimatedComputeUnits || 45_000;

      const exceedsLimits =
        currentCompositeGroup.length >= MAX_COMPOSITE_ITEMS_PER_TX ||
        currentBytes + itemBytes > SAFE_MAX_BYTES ||
        currentAccounts + itemAccounts > SAFE_MAX_ACCOUNTS ||
        currentComputeUnits + itemCu > SAFE_MAX_CU;

      if (exceedsLimits && currentCompositeGroup.length > 0) {
        rawGroups.push(currentCompositeGroup);
        currentCompositeGroup = [];
        currentBytes = 260;
        currentAccounts = 6;
        currentComputeUnits = 30_000;
      }

      currentCompositeGroup.push(item);
      currentBytes += itemBytes;
      currentAccounts += itemAccounts;
      currentComputeUnits += itemCu;
    }

    if (currentCompositeGroup.length > 0) {
      rawGroups.push(currentCompositeGroup);
    }

    const totalBatches = rawGroups.length;
    const nowIso = new Date().toISOString();

    return rawGroups.map((groupItems, idx) => {
      const first = groupItems[0];
      const isSingleJupiterTx =
        groupItems.length === 1 &&
        first.actionType === 'JUPITER_SWAP_V2' &&
        Boolean(first.serializedTransactionBase64);

      const estimatedComputeUnits = groupItems.reduce(
        (sum, i) => sum + (i.estimatedComputeUnits || 60_000),
        25_000
      );
      const estimatedBytes = isSingleJupiterTx
        ? first.estimatedTransactionBytes
        : Math.min(
            SOLANA_TX_MAX_BYTES,
            260 + groupItems.reduce((sum, i) => sum + (i.estimatedTransactionBytes || 120), 0)
          );

      const estimatedFeeLamports = options.sponsorshipApplied ? 25_000 : 15_000;
      const estimatedFeeUsd = Number(
        ((estimatedFeeLamports / 1e9) * options.solPriceUsd).toFixed(5)
      );
      const minExpiresAt = Math.min(...groupItems.map((i) => i.quoteExpiresAt));

      return {
        batchId: `${options.sessionId}-batch-${idx + 1}`,
        sessionId: options.sessionId,
        batchIndex: idx + 1,
        totalBatches,
        items: groupItems,
        serializedTransactionBase64: isSingleJupiterTx
          ? first.serializedTransactionBase64 ?? null
          : null,
        jupiterRequestId: isSingleJupiterTx ? first.jupiterRequestId : undefined,
        estimatedFeeLamports,
        estimatedFeeUsd,
        estimatedComputeUnits,
        estimatedBytes,
        sponsorshipApplied: options.sponsorshipApplied,
        sponsorPublicKey: options.sponsorshipApplied ? options.sponsorPublicKey : null,
        status: 'PENDING_SIGNATURE',
        createdAt: nowIso,
        updatedAt: nowIso,
        expiresAt: minExpiresAt,
      };
    });
  }

  /**
   * Builds a real, executable Solana VersionedTransaction (v0) for composite batches
   * (Mainnet/Devnet empty ATA closures or Devnet-only dust consolidation),
   * setting the designated `feePayerKey` (either the VACUUM sponsor wallet or the user's wallet).
   *
   * Safety Invariants:
   * - Never processes `JUPITER_SWAP_V2` items here (those use Jupiter's `/swap/v2/order` transaction).
   * - Never emits `BurnChecked` on `mainnet-beta` or for `CLOSE_EMPTY_ACCOUNT`.
   * - Respects `TOKEN_2022_PROGRAM_ID` vs `TOKEN_PROGRAM_ID` per token account.
   * - Sends reclaimed rent lamports strictly to `userPubkey` (the wallet owner).
   */
  static async buildCompositeVersionedTransaction(params: {
    batch: TransactionBatch;
    userWalletAddress: string;
    network: SolanaNetwork;
    recentBlockhashOverride?: string;
  }): Promise<string> {
    if (params.batch.serializedTransactionBase64) {
      return params.batch.serializedTransactionBase64;
    }

    if (!params.batch.items || params.batch.items.length === 0) {
      throw new Error('Cannot build composite transaction for an empty batch.');
    }

    const userPubkey = new PublicKey(params.userWalletAddress);
    const feePayerPubkey =
      params.batch.sponsorshipApplied && params.batch.sponsorPublicKey
        ? new PublicKey(params.batch.sponsorPublicKey)
        : userPubkey;

    const instructions: TransactionInstruction[] = [];

    // 1. Add ComputeBudget instructions for reliable inclusion
    instructions.push(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: Math.min(SOLANA_TX_MAX_COMPUTE_UNITS, params.batch.estimatedComputeUnits + 50_000),
      }),
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: 10_000,
      })
    );

    const processedTokenAccounts = new Set<string>();

    // 2. Add token account closure / devnet consolidation instructions for each explicitly selected item
    for (const item of params.batch.items) {
      if (item.actionType === 'JUPITER_SWAP_V2') {
        throw new Error(
          `Cannot mix managed Jupiter Swap V2 item (${item.symbol}) into custom composite transaction builder.`
        );
      }

      if (processedTokenAccounts.has(item.tokenAccountAddress)) {
        continue;
      }
      processedTokenAccounts.add(item.tokenAccountAddress);

      const tokenAccountPubkey = new PublicKey(item.tokenAccountAddress);
      const mintPubkey = new PublicKey(item.mintAddress);
      const rawAmountBig = BigInt(item.inputRawAmount || '0');

      const tokenProgramId =
        item.isToken2022 || item.programId === TOKEN_2022_PROGRAM_ID.toBase58()
          ? TOKEN_2022_PROGRAM_ID
          : TOKEN_PROGRAM_ID;

      if (item.actionType === 'CLOSE_EMPTY_ACCOUNT') {
        if (rawAmountBig > 0n) {
          throw new Error(
            `Security violation: CLOSE_EMPTY_ACCOUNT cannot be executed on non-zero token balance (${item.symbol}: ${item.inputRawAmount}).`
          );
        }
      } else if (item.actionType === 'DEVNET_SWAP_AND_RECLAIM') {
        if (params.network !== 'devnet') {
          throw new Error(
            `Security violation: DEVNET_SWAP_AND_RECLAIM (BurnChecked) is forbidden on ${params.network}. Mainnet non-zero balances must be swapped via Jupiter V2.`
          );
        }
        if (rawAmountBig > 0n) {
          instructions.push(
            createBurnCheckedInstruction(
              tokenAccountPubkey,
              mintPubkey,
              userPubkey, // Strictly requires user wallet owner signature
              rawAmountBig,
              item.decimals,
              [],
              tokenProgramId
            )
          );
        }
      } else {
        throw new Error(`Unsupported composite batch actionType: ${String(item.actionType)}`);
      }

      // Close the emptied token account and send reclaimed SOL rent directly to the user's wallet
      instructions.push(
        createCloseAccountInstruction(
          tokenAccountPubkey,
          userPubkey, // Destination of reclaimed rent lamports is strictly the user!
          userPubkey, // Owner authority is strictly the user!
          [],
          tokenProgramId
        )
      );
    }

    let blockhash = params.recentBlockhashOverride;
    if (!blockhash) {
      const rpcUrl = getRpcUrlForNetwork(params.network);
      const connection = new Connection(rpcUrl, 'confirmed');
      const latestBlockhash = await connection.getLatestBlockhash('confirmed');
      blockhash = latestBlockhash.blockhash;
    }

    const messageV0 = new TransactionMessage({
      payerKey: feePayerPubkey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    const versionedTx = new VersionedTransaction(messageV0);
    const serialized = versionedTx.serialize();

    if (serialized.length > SOLANA_TX_MAX_BYTES) {
      throw new Error(
        `Constructed transaction size (${serialized.length} bytes) exceeds Solana limit (${SOLANA_TX_MAX_BYTES} bytes)`
      );
    }

    return Buffer.from(serialized).toString('base64');
  }
}
