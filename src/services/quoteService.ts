import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  DestinationSymbol,
  DiscoveredTokenAsset,
  ExecutionMode,
  SolanaNetwork,
  SweepQuoteItem,
} from '@/types/vacuum';
import { SOL_MINT_ADDRESS, TOKEN_ACCOUNT_RENT_LAMPORTS } from '@/lib/config';
import { ApiSecurity } from '@/lib/apiSecurity';
import { getDb } from '@/lib/db';
import { VacuumTokenService } from '@/services/vacuumTokenService';
import { JupiterService } from '@/services/jupiterService';
import { PricingService } from '@/services/pricingService';
import { TokenRiskService } from '@/services/tokenRiskService';

export interface BuildQuotesRequest {
  walletAddress: string;
  network: SolanaNetwork;
  mode: ExecutionMode;
  selectedAssets: DiscoveredTokenAsset[];
  destinationSymbol: DestinationSymbol;
  slippageBps: number;
  sponsorPublicKey: string | null;
}

export interface BuildQuotesResult {
  quoteItems: SweepQuoteItem[];
  skippedAssets: Array<{
    mintAddress: string;
    symbol: string;
    reason: string;
  }>;
  destinationMint: string;
  destinationDecimals: number;
  solPriceUsd: number;
}

export class QuoteService {
  /**
   * Builds executable SweepQuoteItems for all selected assets.
   * Performs server-side cross-network mint isolation, risk re-evaluation, deduplication,
   * stale-balance verification, and isolates failures so a single illiquid or unroutable
   * asset never blocks the rest of the sweep.
   */
  static async buildExecutableQuotes(
    request: BuildQuotesRequest
  ): Promise<BuildQuotesResult> {
    const destAsset = VacuumTokenService.getDestinationBySymbol(
      request.destinationSymbol,
      request.network
    );

    // If $VACUUM is selected in live mode before its official mint address is configured,
    // fail safely with an explicit configuration notice rather than inventing a fake mint.
    if (!destAsset.mintAddress && request.mode === 'live') {
      throw new Error(
        `$VACUUM official mint address is not yet configured for ${request.network}. Please configure NEXT_PUBLIC_VACUUM_TOKEN_MINT or select SOL / USDC for live execution.`
      );
    }

    const destinationMint =
      destAsset.mintAddress || 'VacuumDemoMint11111111111111111111111111111';
    const destinationDecimals = destAsset.decimals;

    const allMints = [
      SOL_MINT_ADDRESS,
      destinationMint,
      ...request.selectedAssets.map((a) => a.mintAddress).filter(Boolean),
    ];
    const priceMap = await PricingService.fetchTokenPricesUsd(allMints);
    const solPriceUsd = PricingService.getSolPriceUsd(priceMap);
    const destPriceUsd =
      request.destinationSymbol === 'SOL'
        ? solPriceUsd
        : request.destinationSymbol === 'USDC'
          ? 1.0
          : priceMap[destinationMint] || 0.045;

    const quoteItems: SweepQuoteItem[] = [];
    const skippedAssets: Array<{ mintAddress: string; symbol: string; reason: string }> = [];
    const seenTokenAccounts = new Set<string>();

    const db = getDb();

    for (const asset of request.selectedAssets) {
      const symbol = String(asset.symbol || 'UNKNOWN').slice(0, 24);
      const name = String(asset.name || symbol).slice(0, 64);

      // 0. Deduplicate tokenAccountAddress so the same account is never processed twice
      if (seenTokenAccounts.has(asset.tokenAccountAddress)) {
        skippedAssets.push({
          mintAddress: asset.mintAddress,
          symbol,
          reason: 'Duplicate token account in selection was ignored',
        });
        continue;
      }
      seenTokenAccounts.add(asset.tokenAccountAddress);

      // 0a. Cross-network mint isolation check
      if (request.mode === 'live') {
        const crossCheck = ApiSecurity.isCrossNetworkMintViolation(
          asset.mintAddress,
          request.network
        );
        if (crossCheck.violated) {
          skippedAssets.push({
            mintAddress: asset.mintAddress,
            symbol,
            reason: crossCheck.reason || `Cross-network mint violation on ${request.network}`,
          });
          continue;
        }
      }

      // 0b. Validate addresses and ownership in live mode
      if (request.mode === 'live') {
        try {
          new PublicKey(asset.mintAddress);
          new PublicKey(asset.tokenAccountAddress);
        } catch {
          skippedAssets.push({
            mintAddress: asset.mintAddress,
            symbol,
            reason: 'Malformed mintAddress or tokenAccountAddress',
          });
          continue;
        }

        if (asset.ownerAddress && asset.ownerAddress !== request.walletAddress) {
          skippedAssets.push({
            mintAddress: asset.mintAddress,
            symbol,
            reason: `Token account owner (${asset.ownerAddress}) does not match session wallet (${request.walletAddress})`,
          });
          continue;
        }
      }

      // 0c. Check against persisted discovered_assets for stale balance or cross-network replay
      const persistedRow = db
        .prepare(
          `SELECT raw_balance, is_frozen, is_token_2022, program_id
           FROM discovered_assets
           WHERE wallet_address = ? AND network = ? AND token_account_address = ?`
        )
        .get(request.walletAddress, request.network, asset.tokenAccountAddress) as
        | {
            raw_balance: string;
            is_frozen: number;
            is_token_2022: number;
            program_id: string;
          }
        | undefined;

      if (!persistedRow && request.mode === 'live') {
        const oppositeNetwork: SolanaNetwork =
          request.network === 'mainnet-beta' ? 'devnet' : 'mainnet-beta';
        const oppositeRow = db
          .prepare(
            `SELECT network FROM discovered_assets
             WHERE wallet_address = ? AND network = ? AND token_account_address = ?`
          )
          .get(request.walletAddress, oppositeNetwork, asset.tokenAccountAddress) as
          | { network: string }
          | undefined;
        if (oppositeRow) {
          skippedAssets.push({
            mintAddress: asset.mintAddress,
            symbol,
            reason: `Cross-network asset replay blocked: token account was discovered on ${oppositeNetwork}, not ${request.network}.`,
          });
          continue;
        }
      }

      if (persistedRow && persistedRow.raw_balance !== String(asset.rawBalance || '0')) {
        skippedAssets.push({
          mintAddress: asset.mintAddress,
          symbol,
          reason: `Stale token balance detected (submitted ${asset.rawBalance}, latest known on-chain balance is ${persistedRow.raw_balance}). Please re-scan wallet.`,
        });
        continue;
      }

      // 1. Server-side re-evaluation of TokenRiskService (never blindly trust client risk flags)
      const isFrozen = Boolean(asset.isFrozen || asset.risk?.isFrozen || persistedRow?.is_frozen === 1);
      const isToken2022 = Boolean(
        asset.isToken2022 ||
          asset.programId === TOKEN_2022_PROGRAM_ID.toBase58() ||
          persistedRow?.is_token_2022 === 1
      );
      const resolvedProgramId = isToken2022
        ? TOKEN_2022_PROGRAM_ID.toBase58()
        : asset.programId || persistedRow?.program_id || TOKEN_PROGRAM_ID.toBase58();

      const hasWithheldFees = Boolean(
        asset.risk?.hasWithheldTransferFees ||
          (asset.withheldAmountRaw &&
            /^\d+$/.test(asset.withheldAmountRaw) &&
            BigInt(asset.withheldAmountRaw) > 0n)
      );
      const hasThirdPartyCloseAuthority = Boolean(
        asset.risk?.hasThirdPartyCloseAuthority ||
          (asset.closeAuthority && asset.closeAuthority !== request.walletAddress)
      );

      const serverRisk = TokenRiskService.assessTokenRisk({
        mintAddress: asset.mintAddress,
        symbol,
        name,
        hasMintAuthority: Boolean(asset.risk?.hasMintAuthority),
        hasFreezeAuthority: Boolean(asset.risk?.hasFreezeAuthority),
        isToken2022,
        hasTransferFeeOrHook: Boolean(asset.risk?.hasTransferFeeOrHook),
        isFrozen,
        isNonTransferable: Boolean(asset.risk?.isNonTransferable),
        hasWithheldTransferFees: hasWithheldFees,
        hasPermanentDelegate: Boolean(asset.risk?.hasPermanentDelegate),
        hasThirdPartyCloseAuthority,
        priceImpactPct: asset.risk?.priceImpactPct ?? asset.routeSummary?.priceImpactPct ?? null,
        hasViableRoute: Boolean(asset.hasViableRoute),
        estimatedValueUsd: asset.estimatedValueUsd,
      });

      if (
        !serverRisk.canSweepSafely ||
        serverRisk.riskLevel === 'CRITICAL' ||
        !asset.risk?.canSweepSafely ||
        asset.risk?.riskLevel === 'CRITICAL'
      ) {
        const primarySignal = serverRisk.signals[0]?.label || 'critical security indicator';
        skippedAssets.push({
          mintAddress: asset.mintAddress,
          symbol,
          reason: `Quarantined by TokenRiskService (${primarySignal})`,
        });
        continue;
      }

      if (hasThirdPartyCloseAuthority) {
        skippedAssets.push({
          mintAddress: asset.mintAddress,
          symbol,
          reason: 'Token account has an external closeAuthority and cannot be safely closed',
        });
        continue;
      }

      const rawBalanceStr = String(asset.rawBalance || '0').trim();
      if (!/^\d+$/.test(rawBalanceStr)) {
        skippedAssets.push({
          mintAddress: asset.mintAddress,
          symbol,
          reason: 'Invalid raw token balance format',
        });
        continue;
      }
      const rawBalanceBig = BigInt(rawBalanceStr);
      const verifiedUiBalance = PricingService.normalizeBalance(rawBalanceStr, asset.decimals);

      // 2. Skip if asset is already the destination mint (and has non-zero balance)
      if (asset.mintAddress === destinationMint && rawBalanceBig > 0n) {
        skippedAssets.push({
          mintAddress: asset.mintAddress,
          symbol,
          reason: `Asset is already the selected destination (${request.destinationSymbol})`,
        });
        continue;
      }

      const reclaimableRentLamports =
        asset.reclaimableRentLamports && asset.reclaimableRentLamports > 0
          ? asset.reclaimableRentLamports
          : TOKEN_ACCOUNT_RENT_LAMPORTS;
      const rentSol = reclaimableRentLamports / 1e9;
      const rentUsd = Number((rentSol * solPriceUsd).toFixed(4));

      // 3. Zero-balance SPL token account -> pure CloseAccount rent reclamation
      // Reclaimed rent is refunded in native SOL directly to the user's wallet.
      if (rawBalanceBig === 0n || verifiedUiBalance === 0) {
        const outputUi = Number((rentUsd / destPriceUsd).toFixed(Math.min(6, destinationDecimals)));
        const outputRaw = PricingService.toRawAmount(outputUi, destinationDecimals);

        quoteItems.push({
          mintAddress: asset.mintAddress,
          tokenAccountAddress: asset.tokenAccountAddress,
          programId: resolvedProgramId,
          isToken2022,
          reclaimableRentLamports,
          reclaimableRentUsd: rentUsd,
          symbol,
          name,
          decimals: asset.decimals,
          inputRawAmount: '0',
          inputUiAmount: 0,
          inputValueUsd: 0,
          destinationMint,
          destinationSymbol: request.destinationSymbol,
          expectedOutputRaw: outputRaw,
          expectedOutputUi: outputUi,
          minOutputRaw: outputRaw,
          minOutputUi: outputUi,
          expectedOutputUsd: rentUsd,
          priceImpactPct: 0,
          routerLabel: 'SPL CloseAccount Rent Recovery (Native SOL to User)',
          estimatedComputeUnits: 25_000,
          estimatedTransactionBytes: 96,
          accountCount: 3,
          usesLookupTable: false,
          quoteExpiresAt: Date.now() + 90_000,
          actionType: 'CLOSE_EMPTY_ACCOUNT',
        });
        continue;
      }

      // 4. Mainnet Live Execution via Jupiter Swap API V2 (`/swap/v2/order`)
      // Never falls back to burning non-zero balances on Mainnet!
      if (request.mode === 'live' && request.network === 'mainnet-beta') {
        try {
          const order = await JupiterService.getOrder({
            inputMint: asset.mintAddress,
            outputMint: destinationMint,
            amount: rawBalanceStr,
            taker: request.walletAddress,
            payer: request.sponsorPublicKey || undefined,
            slippageBps: request.slippageBps,
          });

          const validation = JupiterService.validateOrderQuote(order, 10.0, true);
          if (!validation.valid) {
            skippedAssets.push({
              mintAddress: asset.mintAddress,
              symbol,
              reason: validation.reason || 'Invalid Jupiter V2 quote',
            });
            continue;
          }

          const expectedOutputUi = PricingService.normalizeBalance(
            order.outAmount,
            destinationDecimals
          );
          const minOutputUi = PricingService.normalizeBalance(
            order.otherAmountThreshold || order.outAmount,
            destinationDecimals
          );
          const expectedOutputUsd = Number((expectedOutputUi * destPriceUsd).toFixed(4));

          quoteItems.push({
            mintAddress: asset.mintAddress,
            tokenAccountAddress: asset.tokenAccountAddress,
            programId: resolvedProgramId,
            isToken2022,
            reclaimableRentLamports: 0, // Standard Jupiter V2 swap does not close input ATA automatically
            reclaimableRentUsd: 0,
            symbol,
            name,
            decimals: asset.decimals,
            inputRawAmount: rawBalanceStr,
            inputUiAmount: verifiedUiBalance,
            inputValueUsd: expectedOutputUsd,
            destinationMint,
            destinationSymbol: request.destinationSymbol,
            expectedOutputRaw: order.outAmount,
            expectedOutputUi,
            minOutputRaw: order.otherAmountThreshold || order.outAmount,
            minOutputUi,
            expectedOutputUsd,
            priceImpactPct: Math.abs(Number(order.priceImpactPct || 0)),
            routerLabel: `Jupiter V2 (${order.router.toUpperCase()})`,
            jupiterRequestId: order.requestId,
            serializedTransactionBase64: order.transaction,
            estimatedComputeUnits: 180_000,
            estimatedTransactionBytes: order.transaction
              ? Buffer.from(order.transaction, 'base64').length
              : 580,
            accountCount: 18,
            usesLookupTable: true,
            quoteExpiresAt: order.expireAt || Date.now() + 45_000,
            actionType: 'JUPITER_SWAP_V2',
          });
        } catch (err) {
          skippedAssets.push({
            mintAddress: asset.mintAddress,
            symbol,
            reason: err instanceof Error ? err.message : 'No viable Jupiter V2 route',
          });
        }
        continue;
      }

      // 5. Devnet Live Mode or Explicit Demo Mode
      if (!asset.hasViableRoute || asset.liquidityStatus === 'NONE') {
        skippedAssets.push({
          mintAddress: asset.mintAddress,
          symbol,
          reason: 'Insufficient liquidity / no executable route found',
        });
        continue;
      }

      const verifiedUnitPrice =
        priceMap[asset.mintAddress] !== undefined
          ? priceMap[asset.mintAddress]
          : asset.estimatedPriceUsd ?? (request.network === 'devnet' ? 0.0025 : 0);
      const inputValUsd =
        PricingService.calculateUsdValue(verifiedUiBalance, verifiedUnitPrice) ??
        asset.estimatedValueUsd ??
        0;

      const impactPct = asset.routeSummary?.priceImpactPct ?? 0.25;
      const netValueUsd = Number(
        (inputValUsd * (1 - impactPct / 100) + rentUsd).toFixed(4)
      );
      const expectedOutputUi = Number(
        (netValueUsd / destPriceUsd).toFixed(Math.min(6, destinationDecimals))
      );
      const minOutputUi = Number(
        (expectedOutputUi * (1 - request.slippageBps / 10_000)).toFixed(
          Math.min(6, destinationDecimals)
        )
      );

      quoteItems.push({
        mintAddress: asset.mintAddress,
        tokenAccountAddress: asset.tokenAccountAddress,
        programId: resolvedProgramId,
        isToken2022,
        reclaimableRentLamports,
        reclaimableRentUsd: rentUsd,
        symbol,
        name,
        decimals: asset.decimals,
        inputRawAmount: rawBalanceStr,
        inputUiAmount: verifiedUiBalance,
        inputValueUsd: inputValUsd,
        destinationMint,
        destinationSymbol: request.destinationSymbol,
        expectedOutputRaw: PricingService.toRawAmount(expectedOutputUi, destinationDecimals),
        expectedOutputUi,
        minOutputRaw: PricingService.toRawAmount(minOutputUi, destinationDecimals),
        minOutputUi,
        expectedOutputUsd: netValueUsd,
        priceImpactPct: impactPct,
        routerLabel:
          request.mode === 'demo'
            ? asset.routeSummary?.router || 'Jupiter V2 Meta-Aggregator (Demo)'
            : 'Solana Devnet Burn & Rent Reclaim Consolidator',
        estimatedComputeUnits: 55_000,
        estimatedTransactionBytes: 135,
        accountCount: 4,
        usesLookupTable: false,
        quoteExpiresAt: Date.now() + 90_000,
        actionType:
          request.mode === 'demo' ? 'JUPITER_SWAP_V2' : 'DEVNET_SWAP_AND_RECLAIM',
      });
    }

    return {
      quoteItems,
      skippedAssets,
      destinationMint,
      destinationDecimals,
      solPriceUsd,
    };
  }
}
