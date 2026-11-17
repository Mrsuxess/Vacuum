import { NextRequest } from 'next/server';
import {
  DestinationSymbol,
  DiscoveredTokenAsset,
  ExecutionMode,
  SolanaNetwork,
} from '@/types/vacuum';
import {
  getAppConfig,
  USDC_DEVNET_MINT,
  USDC_MAINNET_MINT,
} from '@/lib/config';
import { WalletService } from '@/services/walletService';

interface RateLimitBucket {
  timestamps: number[];
}

const rateLimitStore = new Map<string, RateLimitBucket>();

export const MAX_ASSETS_PER_SWEEP_REQUEST = 50;

export class ApiSecurity {
  /**
   * Sliding-window rate limiter to protect API endpoints from flooding and DoS.
   */
  static checkRateLimit(
    key: string,
    maxRequests: number,
    windowMs: number = 60_000
  ): { allowed: boolean; retryAfterSeconds?: number } {
    if (process.env.VITEST === 'true' && !key.startsWith('test_rl:')) {
      return { allowed: true };
    }

    const now = Date.now();
    const cutoff = now - windowMs;
    const bucket = rateLimitStore.get(key) || { timestamps: [] };
    bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);

    if (bucket.timestamps.length >= maxRequests) {
      const oldest = bucket.timestamps[0];
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
      rateLimitStore.set(key, bucket);
      return { allowed: false, retryAfterSeconds };
    }

    bucket.timestamps.push(now);
    rateLimitStore.set(key, bucket);
    return { allowed: true };
  }

  static resetRateLimits(): void {
    rateLimitStore.clear();
  }

  static getClientIdentifier(req: NextRequest, walletAddress?: string): string {
    const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    const realIp = req.headers.get('x-real-ip')?.trim();
    const ip = forwarded || realIp || 'local';
    return walletAddress ? `${ip}:${walletAddress}` : ip;
  }

  /**
   * Strictly validates Solana network parameter and enforces SERVER_ENFORCED_NETWORK
   * when configured on the backend so frontend selection can never override server policy.
   */
  static validateNetwork(raw: unknown, defaultNetwork?: SolanaNetwork): SolanaNetwork {
    const config = getAppConfig();
    const effectiveDefault = config.serverEnforcedNetwork || defaultNetwork || config.defaultNetwork;

    let resolved: SolanaNetwork;
    if (raw === undefined || raw === null || raw === '') {
      resolved = effectiveDefault;
    } else if (raw === 'devnet' || raw === 'mainnet-beta') {
      resolved = raw;
    } else {
      throw new Error(`Invalid network "${String(raw)}". Must be "devnet" or "mainnet-beta".`);
    }

    if (config.serverEnforcedNetwork && resolved !== config.serverEnforcedNetwork) {
      throw new Error(
        `Network isolation violation: server is locked to "${config.serverEnforcedNetwork}", rejecting client request for "${resolved}".`
      );
    }

    return resolved;
  }

  /**
   * Checks whether a mint address is known to belong exclusively to the opposite Solana cluster.
   */
  static isCrossNetworkMintViolation(
    mintAddress: string,
    targetNetwork: SolanaNetwork
  ): { violated: boolean; reason?: string } {
    const config = getAppConfig();
    if (targetNetwork === 'mainnet-beta') {
      if (mintAddress === USDC_DEVNET_MINT) {
        return {
          violated: true,
          reason: `Devnet USDC mint (${USDC_DEVNET_MINT}) cannot be used on mainnet-beta.`,
        };
      }
      if (config.vacuumToken.devnetMint && mintAddress === config.vacuumToken.devnetMint) {
        return {
          violated: true,
          reason: `Devnet $VACUUM mint (${mintAddress}) cannot be used on mainnet-beta.`,
        };
      }
    } else if (targetNetwork === 'devnet') {
      if (
        config.vacuumToken.mainnetMint &&
        config.vacuumToken.mainnetMint !== config.vacuumToken.devnetMint &&
        mintAddress === config.vacuumToken.mainnetMint
      ) {
        return {
          violated: true,
          reason: `Mainnet $VACUUM mint (${mintAddress}) cannot be used on devnet.`,
        };
      }
    }
    return { violated: false };
  }

  /**
   * Strictly validates ExecutionMode (`live` or `demo`).
   */
  static validateMode(raw: unknown, defaultMode: ExecutionMode = 'live'): ExecutionMode {
    if (raw === undefined || raw === null || raw === '') {
      return defaultMode;
    }
    if (raw === 'live' || raw === 'demo') {
      return raw;
    }
    throw new Error(`Invalid execution mode "${String(raw)}". Must be "live" or "demo".`);
  }

  /**
   * Strictly validates DestinationSymbol (`VACUUM`, `SOL`, or `USDC`).
   */
  static validateDestinationSymbol(
    raw: unknown,
    defaultSymbol: DestinationSymbol = 'VACUUM'
  ): DestinationSymbol {
    if (raw === undefined || raw === null || raw === '') {
      return defaultSymbol;
    }
    if (raw === 'VACUUM' || raw === 'SOL' || raw === 'USDC') {
      return raw;
    }
    throw new Error(
      `Unsupported destination symbol "${String(raw)}". Must be "VACUUM", "SOL", or "USDC".`
    );
  }

  /**
   * Validates slippage in basis points (1 to 5000 bps -> 0.01% to 50.00%).
   */
  static validateSlippageBps(raw: unknown, defaultBps: number = 100): number {
    if (raw === undefined || raw === null || raw === '') {
      return defaultBps;
    }
    const num = Number(raw);
    if (!Number.isFinite(num) || !Number.isInteger(num) || num < 1 || num > 5000) {
      throw new Error(
        `Invalid slippageBps (${String(raw)}). Must be an integer between 1 and 5000 bps.`
      );
    }
    return num;
  }

  /**
   * Validates a bounded finite number parameter.
   */
  static validateBoundedNumber(
    raw: unknown,
    fieldName: string,
    defaultVal: number,
    min: number,
    max: number
  ): number {
    if (raw === undefined || raw === null || raw === '') {
      return defaultVal;
    }
    const num = Number(raw);
    if (!Number.isFinite(num) || num < min || num > max) {
      throw new Error(
        `Invalid ${fieldName} (${String(raw)}). Must be a number between ${min} and ${max}.`
      );
    }
    return num;
  }

  /**
   * Validates and sanitizes client-supplied selectedAssets array.
   */
  static validateSelectedAssets(
    rawAssets: unknown,
    mode: ExecutionMode
  ): DiscoveredTokenAsset[] {
    if (!Array.isArray(rawAssets) || rawAssets.length === 0) {
      throw new Error('At least one eligible asset must be selected.');
    }
    if (rawAssets.length > MAX_ASSETS_PER_SWEEP_REQUEST) {
      throw new Error(
        `Selected assets count (${rawAssets.length}) exceeds maximum allowed per sweep (${MAX_ASSETS_PER_SWEEP_REQUEST}).`
      );
    }

    for (const item of rawAssets) {
      if (!item || typeof item !== 'object') {
        throw new Error('Malformed asset entry in selectedAssets.');
      }
      const a = item as DiscoveredTokenAsset;
      if (!a.mintAddress || typeof a.mintAddress !== 'string') {
        throw new Error('Each selected asset must have a valid mintAddress.');
      }
      if (!a.tokenAccountAddress || typeof a.tokenAccountAddress !== 'string') {
        throw new Error('Each selected asset must have a valid tokenAccountAddress.');
      }
      if (mode === 'live') {
        if (!WalletService.isValidWalletAddress(a.mintAddress)) {
          throw new Error(`Invalid token mint address: ${a.mintAddress}`);
        }
        if (!WalletService.isValidWalletAddress(a.tokenAccountAddress)) {
          throw new Error(`Invalid token account address: ${a.tokenAccountAddress}`);
        }
      }
      if (typeof a.decimals !== 'number' || !Number.isInteger(a.decimals) || a.decimals < 0 || a.decimals > 18) {
        throw new Error(`Invalid token decimals for ${a.symbol || a.mintAddress}`);
      }
      if (typeof a.rawBalance !== 'string' || !/^\d+$/.test(a.rawBalance.trim())) {
        throw new Error(`Invalid rawBalance for ${a.symbol || a.mintAddress}`);
      }
    }

    return rawAssets as DiscoveredTokenAsset[];
  }
}
