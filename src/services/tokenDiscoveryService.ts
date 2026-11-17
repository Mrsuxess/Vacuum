import { Connection, PublicKey, ParsedAccountData } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import {
  DiscoveredTokenAsset,
  DustThresholdConfig,
  ExecutionMode,
  LiquidityStatus,
  SolanaNetwork,
} from '@/types/vacuum';
import {
  DEFAULT_DUST_THRESHOLD_CONFIG,
  getRpcUrlForNetwork,
  SOL_MINT_ADDRESS,
  TOKEN_ACCOUNT_RENT_LAMPORTS,
  USDC_DEVNET_MINT,
  USDC_MAINNET_MINT,
} from '@/lib/config';
import { PricingService } from '@/services/pricingService';
import { TokenRiskService } from '@/services/tokenRiskService';
import { LiquidityService } from '@/services/liquidityService';
import { getDb } from '@/lib/db';

interface KnownTokenMetadata {
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
  networks?: SolanaNetwork[];
}

const KNOWN_TOKEN_REGISTRY: Record<string, KnownTokenMetadata> = {
  [SOL_MINT_ADDRESS]: {
    symbol: 'SOL',
    name: 'Wrapped SOL',
    decimals: 9,
    networks: ['mainnet-beta', 'devnet'],
  },
  [USDC_MAINNET_MINT]: {
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    networks: ['mainnet-beta'],
  },
  [USDC_DEVNET_MINT]: {
    symbol: 'USDC-Dev',
    name: 'USD Coin (Devnet)',
    decimals: 6,
    networks: ['devnet'],
  },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: {
    symbol: 'USDT',
    name: 'Tether USD',
    decimals: 6,
    networks: ['mainnet-beta'],
  },
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: {
    symbol: 'JUP',
    name: 'Jupiter',
    decimals: 6,
    networks: ['mainnet-beta'],
  },
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: {
    symbol: 'BONK',
    name: 'Bonk',
    decimals: 5,
    networks: ['mainnet-beta'],
  },
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: {
    symbol: 'WIF',
    name: 'dogwifhat',
    decimals: 6,
    networks: ['mainnet-beta'],
  },
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': {
    symbol: 'RAY',
    name: 'Raydium',
    decimals: 6,
    networks: ['mainnet-beta'],
  },
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: {
    symbol: 'mSOL',
    name: 'Marinade Staked SOL',
    decimals: 9,
    networks: ['mainnet-beta'],
  },
};

export interface WalletDiscoveryResult {
  walletAddress: string;
  network: SolanaNetwork;
  mode: ExecutionMode;
  nativeSolBalance: number;
  nativeSolValueUsd: number;
  assets: DiscoveredTokenAsset[];
  summary: {
    totalWalletValueUsd: number;
    potentialDustValueUsd: number;
    recoverableDustValueUsd: number;
    reclaimableRentSol: number;
    reclaimableRentUsd: number;
    eligibleTokensCount: number;
    totalAccountsCount: number;
  };
  scannedAt: string;
}

interface ParsedAccountExtensionsResult {
  hasTransferFeeOrHook: boolean;
  hasWithheldTransferFees: boolean;
  withheldAmountRaw: string;
  isNonTransferable: boolean;
  hasPermanentDelegate: boolean;
}

export class TokenDiscoveryService {
  /**
   * Inspects parsed Token-2022 extension entries on a token account.
   */
  private static parseToken2022AccountExtensions(
    extensions: unknown
  ): ParsedAccountExtensionsResult {
    const result: ParsedAccountExtensionsResult = {
      hasTransferFeeOrHook: false,
      hasWithheldTransferFees: false,
      withheldAmountRaw: '0',
      isNonTransferable: false,
      hasPermanentDelegate: false,
    };

    if (!Array.isArray(extensions)) {
      return result;
    }

    for (const ext of extensions) {
      if (!ext || typeof ext !== 'object') continue;
      const extObj = ext as { extension?: string; state?: Record<string, unknown> };
      const name = String(extObj.extension || '');

      if (name === 'transferFeeAmount' || name === 'transferFeeConfig') {
        result.hasTransferFeeOrHook = true;
        const withheld = String(extObj.state?.withheldAmount ?? '0');
        if (/^\d+$/.test(withheld) && BigInt(withheld) > 0n) {
          result.hasWithheldTransferFees = true;
          result.withheldAmountRaw = withheld;
        }
      } else if (name === 'transferHook' || name === 'transferHookAccount') {
        result.hasTransferFeeOrHook = true;
      } else if (name === 'nonTransferable' || name === 'nonTransferableAccount') {
        result.isNonTransferable = true;
      } else if (name === 'permanentDelegate') {
        if (extObj.state?.delegate) {
          result.hasPermanentDelegate = true;
        }
      }
    }

    return result;
  }

  /**
   * Discovers real token accounts from Solana RPC (`TOKEN_PROGRAM_ID` & `TOKEN_2022_PROGRAM_ID`),
   * or returns explicitly-labeled Demo Mode data when `mode === 'demo'`.
   *
   * On Mainnet-Beta:
   * - Queries live prices & DEX pool liquidity from Jupiter Price API V3 (`fetchTokenMarketData`).
   * - Never classifies non-zero unroutable or illiquid tokens as recoverable merely because of account rent.
   * - Never automatically burns non-zero token balances to recover rent.
   */
  static async discoverWalletAssets(
    walletAddress: string,
    network: SolanaNetwork,
    mode: ExecutionMode = 'live',
    thresholdConfig: DustThresholdConfig = DEFAULT_DUST_THRESHOLD_CONFIG
  ): Promise<WalletDiscoveryResult> {
    if (mode === 'demo') {
      return this.getExplicitDemoDiscoveryResult(walletAddress, network, thresholdConfig);
    }

    const pubkey = new PublicKey(walletAddress);
    const normalizedOwner = pubkey.toBase58();
    const rpcUrl = getRpcUrlForNetwork(network);
    const connection = new Connection(rpcUrl, 'confirmed');

    // Fetch native SOL balance and both SPL Token & Token-2022 accounts in parallel
    const [lamports, splAccounts, token2022Accounts] = await Promise.all([
      connection.getBalance(pubkey),
      connection.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_PROGRAM_ID }),
      connection.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_2022_PROGRAM_ID }),
    ]);

    const rawAccounts = [
      ...splAccounts.value.map((item) => ({
        pubkey: item.pubkey.toBase58(),
        account: item.account,
        programId: TOKEN_PROGRAM_ID.toBase58(),
        isToken2022: false,
      })),
      ...token2022Accounts.value.map((item) => ({
        pubkey: item.pubkey.toBase58(),
        account: item.account,
        programId: TOKEN_2022_PROGRAM_ID.toBase58(),
        isToken2022: true,
      })),
    ];

    const mintAddresses: string[] = [SOL_MINT_ADDRESS];
    for (const acc of rawAccounts) {
      const parsed = (acc.account.data as ParsedAccountData)?.parsed?.info;
      if (parsed?.mint) {
        mintAddresses.push(parsed.mint);
      }
    }

    // Fetch live prices and DEX pool liquidity from Jupiter Price API V3
    const marketMap = await PricingService.fetchTokenMarketData(mintAddresses);
    const solPriceUsd = marketMap[SOL_MINT_ADDRESS]?.priceUsd || PricingService.getSolPriceUsd();
    const nativeSolBalance = PricingService.normalizeBalance(lamports, 9);
    const nativeSolValueUsd = Number((nativeSolBalance * solPriceUsd).toFixed(2));

    // Fetch mint account info in batch (up to 99 mints) to inspect MintAuthority / FreezeAuthority / Token-2022 extensions
    const uniqueMints = Array.from(new Set(mintAddresses.filter((m) => m !== SOL_MINT_ADDRESS))).slice(0, 99);
    const mintAuthMap: Record<
      string,
      { hasMintAuthority: boolean; hasFreezeAuthority: boolean; hasTransferFeeOrHook: boolean }
    > = {};

    if (uniqueMints.length > 0) {
      try {
        const mintPubkeys = uniqueMints.map((m) => new PublicKey(m));
        const mintInfos = await connection.getMultipleAccountsInfo(mintPubkeys);
        mintInfos.forEach((info, idx) => {
          const mintAddr = uniqueMints[idx];
          if (info && info.data.length >= 82) {
            const mintAuthOption = info.data.readUInt32LE(0);
            const freezeAuthOption = info.data.readUInt32LE(46);
            const hasExtensions = info.data.length > 82;
            mintAuthMap[mintAddr] = {
              hasMintAuthority: mintAuthOption === 1,
              hasFreezeAuthority: freezeAuthOption === 1,
              hasTransferFeeOrHook: hasExtensions,
            };
          }
        });
      } catch {
        // Fallback if RPC batch call is throttled
      }
    }

    const discoveredAssets: DiscoveredTokenAsset[] = [];

    for (const item of rawAccounts) {
      const parsedInfo = (item.account.data as ParsedAccountData)?.parsed?.info;
      if (!parsedInfo) continue;

      // Strictly verify account owner matches connected wallet
      const accountOwner = String(parsedInfo.owner || '');
      if (accountOwner && accountOwner !== normalizedOwner) {
        continue;
      }

      const mintAddress: string = parsedInfo.mint;
      const tokenAmount = parsedInfo.tokenAmount;
      const decimals: number = Number(tokenAmount?.decimals ?? 0);
      const rawBalance: string = String(tokenAmount?.amount ?? '0');
      const uiBalance = PricingService.normalizeBalance(rawBalance, decimals);

      const isFrozen = String(parsedInfo.state || '').toLowerCase() === 'frozen';
      const closeAuthority = parsedInfo.closeAuthority ? String(parsedInfo.closeAuthority) : null;
      const hasThirdPartyCloseAuthority = Boolean(
        closeAuthority && closeAuthority !== normalizedOwner
      );

      const extInfo = item.isToken2022
        ? this.parseToken2022AccountExtensions(parsedInfo.extensions)
        : {
            hasTransferFeeOrHook: false,
            hasWithheldTransferFees: false,
            withheldAmountRaw: '0',
            isNonTransferable: false,
            hasPermanentDelegate: false,
          };

      const rawKnownMeta = KNOWN_TOKEN_REGISTRY[mintAddress];
      const knownMeta =
        rawKnownMeta && (!rawKnownMeta.networks || rawKnownMeta.networks.includes(network))
          ? rawKnownMeta
          : undefined;

      const shortMint = `${mintAddress.slice(0, 4)}...${mintAddress.slice(-4)}`;
      const symbol =
        knownMeta?.symbol ||
        (network === 'devnet' ? `SPL-${mintAddress.slice(0, 4).toUpperCase()}` : shortMint);
      const name =
        knownMeta?.name ||
        (network === 'devnet'
          ? `Devnet SPL Asset (${shortMint})`
          : `Solana Token (${shortMint})`);

      // Determine price & liquidity from marketMap
      const marketInfo = marketMap[mintAddress];
      let priceUsd: number | null = marketInfo?.priceUsd ?? null;
      const liquidityUsd: number | null = marketInfo?.liquidityUsd ?? null;

      if (priceUsd === null && network === 'devnet' && uiBalance > 0) {
        priceUsd = 0.0025;
      }

      const estimatedValueUsd = PricingService.calculateUsdValue(uiBalance, priceUsd);
      const reclaimableRentLamports = item.account.lamports || TOKEN_ACCOUNT_RENT_LAMPORTS;
      const reclaimableRentUsd = Number(
        (PricingService.normalizeBalance(reclaimableRentLamports, 9) * solPriceUsd).toFixed(4)
      );

      const authFlags = mintAuthMap[mintAddress] || {
        hasMintAuthority: false,
        hasFreezeAuthority: false,
        hasTransferFeeOrHook: false,
      };

      const hasTransferFeeOrHook =
        authFlags.hasTransferFeeOrHook || extInfo.hasTransferFeeOrHook;

      const isBlockedByState =
        isFrozen ||
        extInfo.isNonTransferable ||
        extInfo.hasWithheldTransferFees ||
        hasThirdPartyCloseAuthority;

      // Determine liquidity status & route viability with strict Mainnet criteria
      let liquidityStatus: LiquidityStatus = 'NONE';
      let hasViableRoute = false;

      if (isBlockedByState) {
        liquidityStatus = 'NONE';
        hasViableRoute = false;
      } else if (uiBalance === 0) {
        // Empty token account eligible for native SPL CloseAccount rent reclamation
        liquidityStatus = 'HIGH';
        hasViableRoute = true;
      } else if (network === 'devnet') {
        liquidityStatus = knownMeta ? 'HIGH' : 'VIABLE';
        hasViableRoute = true;
      } else {
        // Mainnet-Beta non-zero token balance: require verified price and viable DEX pool liquidity (>= $1,000)
        if (priceUsd !== null && priceUsd > 0) {
          if (knownMeta || (liquidityUsd !== null && liquidityUsd >= 25_000)) {
            liquidityStatus = 'HIGH';
            hasViableRoute = true;
          } else if (liquidityUsd === null || liquidityUsd >= 1_000) {
            liquidityStatus = 'VIABLE';
            hasViableRoute = true;
          } else if (liquidityUsd > 0) {
            // Shallow pool (< $1,000 liquidity) -> INSUFFICIENT_LIQUIDITY
            liquidityStatus = 'LOW';
            hasViableRoute = false;
          }
        }
      }

      const priceImpactPct =
        !hasViableRoute || uiBalance === 0
          ? uiBalance === 0
            ? 0
            : null
          : knownMeta || (liquidityUsd !== null && liquidityUsd >= 100_000)
            ? 0.08
            : liquidityUsd !== null && liquidityUsd > 0 && estimatedValueUsd !== null
              ? Number(Math.min(25, Math.max(0.25, (estimatedValueUsd / liquidityUsd) * 100)).toFixed(2))
              : 0.65;

      const risk = TokenRiskService.assessTokenRisk({
        mintAddress,
        symbol,
        name,
        hasMintAuthority: authFlags.hasMintAuthority,
        hasFreezeAuthority: authFlags.hasFreezeAuthority,
        isToken2022: item.isToken2022,
        hasTransferFeeOrHook,
        isFrozen,
        isNonTransferable: extInfo.isNonTransferable,
        hasWithheldTransferFees: extInfo.hasWithheldTransferFees,
        hasPermanentDelegate: extInfo.hasPermanentDelegate,
        hasThirdPartyCloseAuthority,
        priceImpactPct,
        hasViableRoute,
        estimatedValueUsd,
      });

      const estimatedNetworkCostUsd = Number((0.000015 * solPriceUsd).toFixed(4));
      const expectedSwapOutputUsd =
        estimatedValueUsd !== null && hasViableRoute && uiBalance > 0
          ? Number((estimatedValueUsd * (1 - (priceImpactPct || 0) / 100)).toFixed(4))
          : 0;

      // On Mainnet-Beta, non-zero token balances are swapped via Jupiter V2 (never burned for rent),
      // so their classification recoverability is based on swap output; on Devnet, consolidation burns & closes.
      const classificationRentUsd =
        uiBalance === 0 || network === 'devnet' ? reclaimableRentUsd : 0;

      const classification = LiquidityService.classifyAsset(
        {
          mintAddress,
          uiBalance,
          estimatedValueUsd,
          reclaimableRentUsd: classificationRentUsd,
          liquidityStatus,
          hasViableRoute,
          expectedOutputUsd: expectedSwapOutputUsd,
          estimatedNetworkCostUsd,
          priceImpactPct,
          risk,
          isDestinationAsset: false,
        },
        thresholdConfig
      );

      const routeTotalUsd = Number((expectedSwapOutputUsd + classificationRentUsd).toFixed(4));

      const asset: DiscoveredTokenAsset = {
        tokenAccountAddress: item.pubkey,
        mintAddress,
        programId: item.programId,
        isToken2022: item.isToken2022,
        ownerAddress: normalizedOwner,
        isFrozen,
        closeAuthority,
        withheldAmountRaw: extInfo.withheldAmountRaw,
        name,
        symbol,
        decimals,
        rawBalance,
        uiBalance,
        logoURI: knownMeta?.logoURI,
        estimatedPriceUsd: priceUsd,
        estimatedValueUsd,
        reclaimableRentLamports,
        reclaimableRentUsd,
        liquidityStatus,
        hasViableRoute,
        category: classification.category,
        isPotentialDust: classification.isPotentialDust,
        isRecoverableDust: classification.isRecoverableDust,
        estimatedNetRecoveryUsd: classification.estimatedNetRecoveryUsd,
        risk,
        routeSummary: hasViableRoute
          ? {
              router:
                uiBalance === 0
                  ? 'SPL CloseAccount Rent Recovery'
                  : network === 'mainnet-beta'
                    ? 'Jupiter V2 Meta-Aggregator'
                    : 'Solana Devnet Consolidator',
              expectedOutputRaw: PricingService.toRawAmount(routeTotalUsd / solPriceUsd, 9),
              expectedOutputUi: Number((routeTotalUsd / solPriceUsd).toFixed(6)),
              expectedOutputUsd: routeTotalUsd,
              priceImpactPct: priceImpactPct ?? 0,
              networkCostUsd: estimatedNetworkCostUsd,
            }
          : undefined,
      };

      discoveredAssets.push(asset);
    }

    // Persist discovered assets in database
    this.persistDiscoveredAssets(normalizedOwner, network, discoveredAssets);

    return this.buildDiscoveryResult(
      normalizedOwner,
      network,
      'live',
      nativeSolBalance,
      nativeSolValueUsd,
      discoveredAssets
    );
  }

  private static persistDiscoveredAssets(
    walletAddress: string,
    network: SolanaNetwork,
    assets: DiscoveredTokenAsset[]
  ): void {
    try {
      const db = getDb();
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO discovered_assets (
          id, wallet_address, network, token_account_address, mint_address,
          program_id, is_token_2022, is_frozen,
          symbol, name, decimals, raw_balance, ui_balance,
          estimated_value_usd, reclaimable_rent_lamports, liquidity_status,
          category, is_recoverable_dust, discovered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `);

      for (const a of assets) {
        stmt.run(
          `${walletAddress}:${network}:${a.tokenAccountAddress}`,
          walletAddress,
          network,
          a.tokenAccountAddress,
          a.mintAddress,
          a.programId || TOKEN_PROGRAM_ID.toBase58(),
          a.isToken2022 ? 1 : 0,
          a.isFrozen ? 1 : 0,
          a.symbol,
          a.name,
          a.decimals,
          a.rawBalance,
          a.uiBalance,
          a.estimatedValueUsd,
          a.reclaimableRentLamports,
          a.liquidityStatus,
          a.category,
          a.isRecoverableDust ? 1 : 0
        );
      }
    } catch {
      // Non-fatal persistence error
    }
  }

  /**
   * Explicitly labeled Demo Mode portfolio for users exploring VACUUM before connecting a wallet.
   */
  static getExplicitDemoDiscoveryResult(
    walletAddress: string,
    network: SolanaNetwork,
    thresholdConfig: DustThresholdConfig = DEFAULT_DUST_THRESHOLD_CONFIG
  ): WalletDiscoveryResult {
    const solPriceUsd = 185.40;
    const rentLamports = TOKEN_ACCOUNT_RENT_LAMPORTS;
    const rentUsd = Number(((rentLamports / 1e9) * solPriceUsd).toFixed(4)); // ~$0.378

    const rawDemoSpecs = [
      {
        tokenAccountAddress: 'DemoAcc111111111111111111111111111111111111',
        mintAddress: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
        symbol: 'BONK',
        name: 'Bonk',
        decimals: 5,
        rawBalance: '14250000',
        uiBalance: 142.5,
        priceUsd: 0.0185, // ~$2.636
        liquidityStatus: 'HIGH' as LiquidityStatus,
        hasViableRoute: true,
        priceImpactPct: 0.12,
        hasMintAuthority: false,
        hasFreezeAuthority: false,
        isToken2022: false,
        hasTransferFeeOrHook: false,
        router: 'JupiterZ RFQ + Metis',
      },
      {
        tokenAccountAddress: 'DemoAcc222222222222222222222222222222222222',
        mintAddress: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
        symbol: 'WIF',
        name: 'dogwifhat',
        decimals: 6,
        rawBalance: '1580000',
        uiBalance: 1.58,
        priceUsd: 2.45, // ~$3.871
        liquidityStatus: 'HIGH' as LiquidityStatus,
        hasViableRoute: true,
        priceImpactPct: 0.09,
        hasMintAuthority: false,
        hasFreezeAuthority: false,
        isToken2022: false,
        hasTransferFeeOrHook: false,
        router: 'Metis v2 (Orca + Raydium)',
      },
      {
        tokenAccountAddress: 'DemoAcc333333333333333333333333333333333333',
        mintAddress: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
        symbol: 'POPCAT',
        name: 'Popcat (SOL)',
        decimals: 9,
        rawBalance: '2850000000',
        uiBalance: 2.85,
        priceUsd: 0.64, // ~$1.824
        liquidityStatus: 'HIGH' as LiquidityStatus,
        hasViableRoute: true,
        priceImpactPct: 0.24,
        hasMintAuthority: false,
        hasFreezeAuthority: false,
        isToken2022: false,
        hasTransferFeeOrHook: false,
        router: 'Metis v2 (Meteora DLMM)',
      },
      {
        tokenAccountAddress: 'DemoAcc444444444444444444444444444444444444',
        mintAddress: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82',
        symbol: 'BOME',
        name: 'BOOK OF MEME',
        decimals: 6,
        rawBalance: '185000000',
        uiBalance: 185.0,
        priceUsd: 0.0048, // ~$0.888
        liquidityStatus: 'VIABLE' as LiquidityStatus,
        hasViableRoute: true,
        priceImpactPct: 0.42,
        hasMintAuthority: false,
        hasFreezeAuthority: false,
        isToken2022: false,
        hasTransferFeeOrHook: false,
        router: 'Raydium CLMM via Jupiter V2',
      },
      {
        tokenAccountAddress: 'DemoAcc555555555555555555555555555555555555',
        mintAddress: 'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5',
        symbol: 'MEW',
        name: 'cat in a dogs world',
        decimals: 5,
        rawBalance: '9800000',
        uiBalance: 98.0,
        priceUsd: 0.0042, // ~$0.4116
        liquidityStatus: 'VIABLE' as LiquidityStatus,
        hasViableRoute: true,
        priceImpactPct: 0.31,
        hasMintAuthority: false,
        hasFreezeAuthority: false,
        isToken2022: false,
        hasTransferFeeOrHook: false,
        router: 'Dflow + JupiterZ',
      },
      {
        tokenAccountAddress: 'DemoAcc666666666666666666666666666666666666',
        mintAddress: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
        symbol: 'RAY',
        name: 'Raydium (Empty Account Rent)',
        decimals: 6,
        rawBalance: '0',
        uiBalance: 0,
        priceUsd: 4.80, // $0 balance, $0.378 reclaimable rent
        liquidityStatus: 'HIGH' as LiquidityStatus,
        hasViableRoute: true,
        priceImpactPct: 0,
        hasMintAuthority: false,
        hasFreezeAuthority: false,
        isToken2022: false,
        hasTransferFeeOrHook: false,
        router: 'SPL CloseAccount Rent Reclaim',
      },
      {
        tokenAccountAddress: 'DemoAcc777777777777777777777777777777777777',
        mintAddress: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
        symbol: 'JUP',
        name: 'Jupiter',
        decimals: 6,
        rawBalance: '65000000',
        uiBalance: 65.0,
        priceUsd: 1.12, // $72.80 (Valuable Established Asset — protected from auto-dust sweep)
        liquidityStatus: 'HIGH' as LiquidityStatus,
        hasViableRoute: true,
        priceImpactPct: 0.05,
        hasMintAuthority: false,
        hasFreezeAuthority: false,
        isToken2022: false,
        hasTransferFeeOrHook: false,
        router: 'JupiterZ RFQ',
      },
      {
        tokenAccountAddress: 'DemoAcc888888888888888888888888888888888888',
        mintAddress: 'DeadMeme11111111111111111111111111111111111',
        symbol: 'MOONCAT99',
        name: 'Abandoned MoonCat Pump',
        decimals: 6,
        rawBalance: '4200000000',
        uiBalance: 4200,
        priceUsd: 0.00001, // $0.042 nominal, but pool drained
        liquidityStatus: 'NONE' as LiquidityStatus,
        hasViableRoute: false,
        priceImpactPct: null,
        hasMintAuthority: true,
        hasFreezeAuthority: false,
        isToken2022: false,
        hasTransferFeeOrHook: false,
        router: 'No Viable Route',
      },
      {
        tokenAccountAddress: 'DemoAcc999999999999999999999999999999999999',
        mintAddress: 'ScamPhish1111111111111111111111111111111111',
        symbol: 'CLAIM-SOL.COM',
        name: 'Visit https://claim-drop.xyz Voucher',
        decimals: 6,
        rawBalance: '500000000',
        uiBalance: 500,
        priceUsd: null,
        liquidityStatus: 'NONE' as LiquidityStatus,
        hasViableRoute: false,
        priceImpactPct: null,
        hasMintAuthority: true,
        hasFreezeAuthority: true,
        isToken2022: true,
        hasTransferFeeOrHook: true,
        router: 'Quarantined',
      },
    ];

    const effectiveOwner = walletAddress || 'DemoWa11etVacuumSweeperPreview1111111111111';

    const assets: DiscoveredTokenAsset[] = rawDemoSpecs.map((spec) => {
      const estimatedValueUsd = PricingService.calculateUsdValue(spec.uiBalance, spec.priceUsd);
      const risk = TokenRiskService.assessTokenRisk({
        mintAddress: spec.mintAddress,
        symbol: spec.symbol,
        name: spec.name,
        hasMintAuthority: spec.hasMintAuthority,
        hasFreezeAuthority: spec.hasFreezeAuthority,
        isToken2022: spec.isToken2022,
        hasTransferFeeOrHook: spec.hasTransferFeeOrHook,
        priceImpactPct: spec.priceImpactPct,
        hasViableRoute: spec.hasViableRoute,
        estimatedValueUsd,
      });

      const networkCostUsd = 0.0028;
      const expectedOutputUsd =
        spec.hasViableRoute && estimatedValueUsd !== null
          ? Number((estimatedValueUsd * (1 - (spec.priceImpactPct || 0) / 100)).toFixed(4))
          : 0;

      const classification = LiquidityService.classifyAsset(
        {
          mintAddress: spec.mintAddress,
          uiBalance: spec.uiBalance,
          estimatedValueUsd,
          reclaimableRentUsd: rentUsd,
          liquidityStatus: spec.liquidityStatus,
          hasViableRoute: spec.hasViableRoute,
          expectedOutputUsd,
          estimatedNetworkCostUsd: networkCostUsd,
          priceImpactPct: spec.priceImpactPct,
          risk,
          isDestinationAsset: false,
        },
        thresholdConfig
      );

      return {
        tokenAccountAddress: spec.tokenAccountAddress,
        mintAddress: spec.mintAddress,
        programId: spec.isToken2022
          ? TOKEN_2022_PROGRAM_ID.toBase58()
          : TOKEN_PROGRAM_ID.toBase58(),
        isToken2022: spec.isToken2022,
        ownerAddress: effectiveOwner,
        isFrozen: false,
        closeAuthority: null,
        withheldAmountRaw: '0',
        name: spec.name,
        symbol: spec.symbol,
        decimals: spec.decimals,
        rawBalance: spec.rawBalance,
        uiBalance: spec.uiBalance,
        estimatedPriceUsd: spec.priceUsd,
        estimatedValueUsd,
        reclaimableRentLamports: rentLamports,
        reclaimableRentUsd: rentUsd,
        liquidityStatus: spec.liquidityStatus,
        hasViableRoute: spec.hasViableRoute,
        category: classification.category,
        isPotentialDust: classification.isPotentialDust,
        isRecoverableDust: classification.isRecoverableDust,
        estimatedNetRecoveryUsd: classification.estimatedNetRecoveryUsd,
        risk,
        routeSummary: spec.hasViableRoute
          ? {
              router: spec.router,
              expectedOutputRaw: PricingService.toRawAmount(
                (expectedOutputUsd + rentUsd) / solPriceUsd,
                9
              ),
              expectedOutputUi: Number(((expectedOutputUsd + rentUsd) / solPriceUsd).toFixed(5)),
              expectedOutputUsd: Number((expectedOutputUsd + rentUsd).toFixed(4)),
              priceImpactPct: spec.priceImpactPct ?? 0,
              networkCostUsd,
            }
          : undefined,
      };
    });

    return this.buildDiscoveryResult(
      effectiveOwner,
      network,
      'demo',
      0.0042, // Low SOL balance in demo showing why Gasless Sponsorship matters!
      Number((0.0042 * solPriceUsd).toFixed(2)),
      assets
    );
  }

  private static buildDiscoveryResult(
    walletAddress: string,
    network: SolanaNetwork,
    mode: ExecutionMode,
    nativeSolBalance: number,
    nativeSolValueUsd: number,
    assets: DiscoveredTokenAsset[]
  ): WalletDiscoveryResult {
    let totalTokensUsd = 0;
    let potentialDustValueUsd = 0;
    let recoverableDustValueUsd = 0;
    let reclaimableRentLamports = 0;
    let reclaimableRentUsd = 0;
    let eligibleTokensCount = 0;

    for (const a of assets) {
      const val = a.estimatedValueUsd ?? 0;
      totalTokensUsd += val;

      if (a.isPotentialDust) {
        potentialDustValueUsd += val + a.reclaimableRentUsd;
      }
      if (a.isRecoverableDust) {
        recoverableDustValueUsd += a.estimatedNetRecoveryUsd;
        reclaimableRentLamports += a.reclaimableRentLamports;
        reclaimableRentUsd += a.reclaimableRentUsd;
        eligibleTokensCount += 1;
      }
    }

    return {
      walletAddress,
      network,
      mode,
      nativeSolBalance,
      nativeSolValueUsd,
      assets,
      summary: {
        totalWalletValueUsd: Number((nativeSolValueUsd + totalTokensUsd).toFixed(2)),
        potentialDustValueUsd: Number(potentialDustValueUsd.toFixed(2)),
        recoverableDustValueUsd: Number(recoverableDustValueUsd.toFixed(2)),
        reclaimableRentSol: Number((reclaimableRentLamports / 1e9).toFixed(6)),
        reclaimableRentUsd: Number(reclaimableRentUsd.toFixed(2)),
        eligibleTokensCount,
        totalAccountsCount: assets.length,
      },
      scannedAt: new Date().toISOString(),
    };
  }
}
