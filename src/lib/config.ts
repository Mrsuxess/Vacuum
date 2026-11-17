import { SolanaNetwork, DustThresholdConfig } from '@/types/vacuum';

export const SOL_MINT_ADDRESS = 'So11111111111111111111111111111111111111112';
export const USDC_MAINNET_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDC_DEVNET_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

export const DEVNET_KNOWN_SPONSOR_PUBKEY = 'Etqz6qVzrWwkazxWbbQgeCsBBCNYvh2E2SUqF35fUBgT';

export const SOLANA_TX_MAX_BYTES = 1232;
export const SOLANA_TX_MAX_ACCOUNTS = 64;
export const SOLANA_TX_MAX_COMPUTE_UNITS = 1_400_000;
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280; // ~0.00203928 SOL standard SPL token account rent

export const DEFAULT_DUST_THRESHOLD_CONFIG: DustThresholdConfig = {
  maxUsdValue: 5.0,
  includeZeroBalanceCloseableAccounts: true,
  minNetRecoveryUsd: 0.02,
  maxPriceImpactPct: 8.0,
  slippageBps: 100, // 1.0%
};

export const DUST_PRESET_THRESHOLDS = [0.1, 0.5, 1.0, 5.0, 10.0];

function parseSafeNumber(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

export function getAppConfig() {
  const rawNetwork = process.env.NEXT_PUBLIC_SOLANA_NETWORK?.trim();
  const defaultNetwork: SolanaNetwork =
    rawNetwork === 'mainnet-beta' ? 'mainnet-beta' : 'devnet';

  const rawEnforced = process.env.SERVER_ENFORCED_NETWORK?.trim();
  const serverEnforcedNetwork: SolanaNetwork | null =
    rawEnforced === 'devnet' || rawEnforced === 'mainnet-beta' ? rawEnforced : null;

  const mainnetRpc =
    process.env.SOLANA_MAINNET_RPC_URL?.trim() ||
    process.env.NEXT_PUBLIC_SOLANA_MAINNET_RPC_URL?.trim() ||
    'https://api.mainnet-beta.solana.com';
  const devnetRpc =
    process.env.SOLANA_DEVNET_RPC_URL?.trim() ||
    process.env.NEXT_PUBLIC_SOLANA_DEVNET_RPC_URL?.trim() ||
    'https://api.devnet.solana.com';

  const jupiterApiBaseUrl = (
    process.env.JUPITER_API_BASE_URL || 'https://api.jup.ag/swap/v2'
  ).replace(/\/+$/, '');
  const jupiterPriceApiUrl = (
    process.env.JUPITER_PRICE_API_URL || 'https://api.jup.ag/price/v3'
  ).replace(/\/+$/, '');
  const jupiterApiKey = process.env.JUPITER_API_KEY?.trim() || '';
  const jupiterReferralAccount = process.env.JUPITER_REFERRAL_ACCOUNT?.trim() || null;
  const jupiterReferralFeeBps = parseSafeNumber(
    process.env.JUPITER_REFERRAL_FEE_BPS,
    0,
    50,
    255
  );

  // $VACUUM Token Configuration — Strictly separated between Mainnet and Devnet; never invent a fake mint
  const vacuumMainnetMint = process.env.NEXT_PUBLIC_VACUUM_TOKEN_MINT?.trim() || null;
  const vacuumDevnetMint = process.env.NEXT_PUBLIC_VACUUM_DEVNET_MINT?.trim() || null;
  const vacuumDecimals = parseSafeNumber(
    process.env.NEXT_PUBLIC_VACUUM_TOKEN_DECIMALS,
    6,
    0,
    18
  );

  // Sponsorship policy
  const sponsorshipEnabled = process.env.SPONSORSHIP_ENABLED !== 'false';
  // On Mainnet-Beta, gasless sponsorship requires explicit opt-in via MAINNET_SPONSORSHIP_ENABLED=true
  const mainnetSponsorshipEnabled =
    process.env.MAINNET_SPONSORSHIP_ENABLED === 'true' && sponsorshipEnabled;

  const minSweepUsd = parseSafeNumber(process.env.SPONSORSHIP_MIN_SWEEP_USD, 0.25, 0.01, 10000);
  const maxPerWalletLamports = parseSafeNumber(
    process.env.SPONSORSHIP_MAX_PER_WALLET_LAMPORTS,
    5_000_000,
    10_000,
    1_000_000_000
  );
  const maxDailyBudgetLamports = parseSafeNumber(
    process.env.SPONSORSHIP_MAX_DAILY_BUDGET_LAMPORTS,
    100_000_000,
    10_000,
    100_000_000_000
  );
  const minNetRecoveryUsd = parseSafeNumber(
    process.env.SPONSORSHIP_MIN_NET_RECOVERY_USD,
    0.05,
    0.0,
    1000
  );
  const platformFeeBps = parseSafeNumber(
    process.env.SPONSORSHIP_PLATFORM_FEE_BPS,
    50,
    0,
    1000
  ); // 0.50%
  const rateLimitPerHour = parseSafeNumber(
    process.env.SPONSORSHIP_RATE_LIMIT_PER_HOUR,
    10,
    1,
    1000
  );
  const maxPriorityMicroLamports = parseSafeNumber(
    process.env.SPONSORSHIP_MAX_PRIORITY_MICRO_LAMPORTS,
    250_000,
    1_000,
    5_000_000
  );
  const sponsorCloseAuthority = process.env.SPONSOR_CLOSE_AUTHORITY?.trim() || null;

  return {
    defaultNetwork,
    serverEnforcedNetwork,
    rpc: {
      'mainnet-beta': mainnetRpc,
      devnet: devnetRpc,
      helius: process.env.HELIUS_RPC_URL?.trim() || null,
    },
    jupiter: {
      baseUrl: jupiterApiBaseUrl,
      priceUrl: jupiterPriceApiUrl,
      apiKey: jupiterApiKey,
      hasApiKey: Boolean(jupiterApiKey && jupiterApiKey.length > 5),
      referralAccount: jupiterReferralAccount,
      referralFeeBps: jupiterReferralAccount ? jupiterReferralFeeBps : 0,
    },
    vacuumToken: {
      mainnetMint: vacuumMainnetMint,
      devnetMint: vacuumDevnetMint,
      decimals: vacuumDecimals,
      symbol: 'VACUUM' as const,
      features: {
        feeDiscount: process.env.FEATURE_VACUUM_FEE_DISCOUNT === 'true',
        proTier: process.env.FEATURE_VACUUM_PRO_TIER === 'true',
        autoSweep: process.env.FEATURE_AUTO_SWEEP === 'true',
      },
    },
    sponsorship: {
      enabled: sponsorshipEnabled,
      mainnetSponsorshipEnabled,
      hasServerSponsorKey: Boolean(
        process.env.SPONSOR_MAINNET_FEE_PAYER_SECRET_KEY?.trim() ||
          process.env.SPONSOR_DEVNET_FEE_PAYER_SECRET_KEY?.trim() ||
          process.env.SPONSOR_FEE_PAYER_SECRET_KEY?.trim()
      ),
      minSweepUsd,
      maxPerWalletLamports,
      maxDailyBudgetLamports,
      minNetRecoveryUsd,
      platformFeeBps,
      rateLimitPerHour,
      maxPriorityMicroLamports,
      closeAuthority: sponsorCloseAuthority,
    },
    databasePath: process.env.DATABASE_PATH || './data/vacuum.db',
  };
}

export function getRpcUrlForNetwork(network: SolanaNetwork): string {
  const cfg = getAppConfig();
  return cfg.rpc[network];
}
