export type SolanaNetwork = 'mainnet-beta' | 'devnet';

export type ExecutionMode = 'live' | 'demo';

export type AssetCategory =
  | 'VALUABLE_ESTABLISHED'
  | 'SMALL_BALANCE'
  | 'POTENTIAL_DUST'
  | 'INSUFFICIENT_LIQUIDITY'
  | 'NO_VIABLE_ROUTE'
  | 'SUSPICIOUS_UNSUPPORTED'
  | 'REQUIRES_INSPECTION';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type LiquidityStatus = 'HIGH' | 'VIABLE' | 'LOW' | 'NONE' | 'UNVERIFIED';

export type DestinationSymbol = 'VACUUM' | 'SOL' | 'USDC';

export interface DestinationAsset {
  symbol: DestinationSymbol;
  name: string;
  mintAddress: string | null; // null if $VACUUM mainnet mint is not yet configured
  decimals: number;
  logoType: 'vacuum-vortex' | 'solana' | 'usdc';
  isFlagship: boolean;
  isConfiguredForNetwork: boolean;
  statusNote?: string;
  badgeText?: string;
}

export interface TokenRiskSignal {
  code: string;
  severity: RiskLevel;
  label: string;
  description: string;
}

export interface TokenRiskAssessment {
  mintAddress: string;
  riskLevel: RiskLevel;
  riskScore: number; // 0 (safest) to 100 (highest risk)
  hasMintAuthority: boolean;
  hasFreezeAuthority: boolean;
  isToken2022: boolean;
  hasTransferFeeOrHook: boolean;
  isFrozen?: boolean;
  isNonTransferable?: boolean;
  hasWithheldTransferFees?: boolean;
  hasPermanentDelegate?: boolean;
  hasThirdPartyCloseAuthority?: boolean;
  isKnownVerified: boolean;
  priceImpactPct: number | null;
  signals: TokenRiskSignal[];
  canSweepSafely: boolean;
  requiresUserAcknowledgement: boolean;
}

export interface DiscoveredTokenAsset {
  tokenAccountAddress: string;
  mintAddress: string;
  programId: string;
  isToken2022: boolean;
  ownerAddress?: string;
  isFrozen?: boolean;
  closeAuthority?: string | null;
  withheldAmountRaw?: string;
  name: string;
  symbol: string;
  decimals: number;
  rawBalance: string;
  uiBalance: number;
  logoURI?: string;
  estimatedPriceUsd: number | null;
  estimatedValueUsd: number | null;
  reclaimableRentLamports: number;
  reclaimableRentUsd: number;
  liquidityStatus: LiquidityStatus;
  hasViableRoute: boolean;
  category: AssetCategory;
  isPotentialDust: boolean;
  isRecoverableDust: boolean;
  estimatedNetRecoveryUsd: number;
  risk: TokenRiskAssessment;
  routeSummary?: {
    router: string;
    expectedOutputRaw: string;
    expectedOutputUi: number;
    expectedOutputUsd: number;
    priceImpactPct: number;
    networkCostUsd: number;
  };
}

export interface DustThresholdConfig {
  maxUsdValue: number;
  includeZeroBalanceCloseableAccounts: boolean;
  minNetRecoveryUsd: number;
  maxPriceImpactPct: number;
  slippageBps: number;
}

export interface JupiterOrderRequest {
  inputMint: string;
  outputMint: string;
  amount: string; // raw integer string
  taker?: string;
  payer?: string; // integrator gas sponsor public key
  closeAuthority?: string; // optional close authority for newly created ATAs funded by payer
  referralAccount?: string; // optional integrator referral account for on-chain fee recovery
  referralFee?: number; // optional integrator referral fee in bps (50..255)
  slippageBps?: number;
}

export interface JupiterOrderResponse {
  mode: string;
  swapType?: string;
  router: string;
  requestId: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: Array<{
    swapInfo: {
      ammKey: string;
      label: string;
      inputMint: string;
      outputMint: string;
      inAmount: string;
      outAmount: string;
      feeAmount: string;
      feeMint: string;
    };
    percent: number;
  }>;
  feeMint?: string;
  feeBps?: number;
  gasless?: boolean;
  transaction: string | null; // Base64 serialized VersionedTransaction
  expireAt?: number;
  errorCode?: number | string;
  errorMessage?: string;
}

export interface JupiterExecuteRequest {
  signedTransaction: string;
  requestId: string;
}

export interface JupiterExecuteResponse {
  status: 'Success' | 'Failed';
  signature?: string;
  slot?: string;
  code?: number;
  error?: string;
  totalInputAmount?: string;
  totalOutputAmount?: string;
}

export interface SolFlowBreakdown {
  networkFeePayer: 'SPONSOR' | 'USER';
  priorityFeePayer: 'SPONSOR' | 'USER';
  ataCreationPayer: 'SPONSOR' | 'USER' | 'NONE';
  rentRefundRecipient: 'USER';
  swapProceedsRecipient: 'USER';
  sponsorRecoveryMechanism: 'REFERRAL_FEE' | 'SUBSIDIZED_BY_SPONSOR' | 'NONE';
}

export interface SponsorshipEvaluation {
  eligible: boolean;
  mode: 'JUPITER_NATIVE_GASLESS' | 'VACUUM_SPONSOR_PAYER' | 'SUBSIDIZED_PROMO' | 'USER_SELF_PAID';
  sponsorPublicKey: string | null;
  estimatedLiquidationUsd: number;
  estimatedNetworkFeeLamports: number;
  estimatedPriorityFeeLamports: number;
  estimatedAtaCreationLamports: number;
  reclaimableRentLamports: number;
  platformServiceFeeUsd: number;
  platformServiceFeeBps: number;
  expectedExecutionRiskUsd: number;
  estimatedNetRecoveryUsd: number;
  sponsorshipCostLamports: number;
  sponsorshipCostUsd: number;
  isSubsidized: boolean;
  subsidyAmountUsd: number;
  reason: string;
  remainingWalletAllowanceLamports: number;
  remainingDailyBudgetLamports: number;
  solFlowBreakdown?: SolFlowBreakdown;
}

export type BatchStatus =
  | 'PENDING_SIGNATURE'
  | 'SIGNED'
  | 'SUBMITTING'
  | 'CONFIRMED'
  | 'FAILED'
  | 'SKIPPED'
  | 'EXPIRED';

export interface SweepQuoteItem {
  mintAddress: string;
  tokenAccountAddress: string;
  programId?: string;
  isToken2022?: boolean;
  reclaimableRentLamports?: number;
  reclaimableRentUsd?: number;
  symbol: string;
  name: string;
  decimals: number;
  inputRawAmount: string;
  inputUiAmount: number;
  inputValueUsd: number;
  destinationMint: string;
  destinationSymbol: DestinationSymbol;
  expectedOutputRaw: string;
  expectedOutputUi: number;
  minOutputRaw: string;
  minOutputUi: number;
  expectedOutputUsd: number;
  priceImpactPct: number;
  routerLabel: string;
  jupiterRequestId?: string;
  serializedTransactionBase64?: string | null;
  estimatedComputeUnits: number;
  estimatedTransactionBytes: number;
  accountCount: number;
  usesLookupTable: boolean;
  quoteExpiresAt: number;
  actionType: 'JUPITER_SWAP_V2' | 'DEVNET_SWAP_AND_RECLAIM' | 'CLOSE_EMPTY_ACCOUNT';
}

export interface TransactionBatch {
  batchId: string;
  sessionId: string;
  batchIndex: number;
  totalBatches: number;
  items: SweepQuoteItem[];
  serializedTransactionBase64: string | null;
  jupiterRequestId?: string;
  estimatedFeeLamports: number;
  actualFeeLamports?: number;
  estimatedFeeUsd: number;
  estimatedComputeUnits: number;
  estimatedBytes: number;
  sponsorshipApplied: boolean;
  sponsorPublicKey: string | null;
  status: BatchStatus;
  signature?: string;
  confirmedSlot?: number;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
}

export type SweepSessionStatus =
  | 'DRAFT'
  | 'QUOTED'
  | 'AWAITING_AUTHORIZATION'
  | 'EXECUTING'
  | 'COMPLETED'
  | 'PARTIAL_SUCCESS'
  | 'FAILED'
  | 'CANCELLED';

export interface SweepSession {
  sessionId: string;
  walletAddress: string;
  network: SolanaNetwork;
  mode: ExecutionMode;
  destinationSymbol: DestinationSymbol;
  destinationMint: string;
  slippageBps: number;
  status: SweepSessionStatus;
  totalAssetsSelected: number;
  swapAssetsCount?: number;
  closeAccountsCount?: number;
  totalInputValueUsd: number;
  expectedSwapOutputUsd?: number;
  expectedRentReclaimSol?: number;
  expectedRentReclaimUsd?: number;
  expectedDestinationOutputUi: number;
  expectedDestinationOutputUsd: number;
  actualDestinationOutputUi: number;
  estimatedNetworkCostUsd: number;
  estimatedNetResultUsd: number;
  sponsorshipEvaluation: SponsorshipEvaluation;
  batches: TransactionBatch[];
  skippedAssets: Array<{
    mintAddress: string;
    symbol: string;
    reason: string;
  }>;
  createdAt: string;
  completedAt?: string;
}

export interface SweepReceipt {
  receiptId: string;
  sessionId: string;
  walletAddress: string;
  network: SolanaNetwork;
  mode: ExecutionMode;
  timestamp: string;
  destinationSymbol: DestinationSymbol;
  destinationMint: string;
  totalAssetsAttempted: number;
  totalAssetsSwept: number;
  totalAssetsFailedOrSkipped: number;
  totalValueConvertedUsd: number;
  finalDestinationAmountUi: number;
  totalNetworkFeesLamports: number;
  totalSponsoredLamports: number;
  platformFeeUsd: number;
  batches: Array<{
    batchNumber: number;
    status: BatchStatus;
    signature?: string;
    explorerUrl?: string;
    inputSymbols: string[];
    outputUi: number;
    failureReason?: string;
  }>;
  verificationHash: string;
}

export interface PlatformAnalyticsSummary {
  walletAddress?: string;
  totalValueSweptUsd: number;
  totalVacuumAcquiredUi: number;
  totalTokensCleaned: number;
  totalSuccessfulSweeps: number;
  totalFeesSponsoredLamports: number;
  totalFeesSponsoredUsd: number;
  estimatedNetValueRecoveredUsd: number;
  recentSessions: SweepSession[];
}
