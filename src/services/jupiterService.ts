import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import {
  JupiterExecuteRequest,
  JupiterExecuteResponse,
  JupiterOrderRequest,
  JupiterOrderResponse,
} from '@/types/vacuum';
import { getAppConfig } from '@/lib/config';

export class JupiterService {
  /**
   * Normalizes Jupiter `expireAt` values (which may be Unix seconds, Unix milliseconds, or ISO-8601 strings)
   * into Unix milliseconds (`Date.now()` compatible).
   */
  static normalizeExpireAtMs(rawExpireAt: unknown, defaultTtlMs: number = 45_000): number {
    if (rawExpireAt === undefined || rawExpireAt === null || rawExpireAt === '') {
      return Date.now() + defaultTtlMs;
    }

    if (typeof rawExpireAt === 'number' && Number.isFinite(rawExpireAt) && rawExpireAt > 0) {
      // Unix timestamp in seconds is < 1e11 (year 5138); milliseconds is >= 1e11
      return rawExpireAt < 1e11 ? Math.floor(rawExpireAt * 1000) : Math.floor(rawExpireAt);
    }

    if (typeof rawExpireAt === 'string') {
      const trimmed = rawExpireAt.trim();
      if (/^\d+(\.\d+)?$/.test(trimmed)) {
        const num = Number(trimmed);
        if (Number.isFinite(num) && num > 0) {
          return num < 1e11 ? Math.floor(num * 1000) : Math.floor(num);
        }
      }
      const parsedDate = Date.parse(trimmed);
      if (!Number.isNaN(parsedDate) && parsedDate > 0) {
        return parsedDate;
      }
    }

    return Date.now() + defaultTtlMs;
  }

  /**
   * Returns current Jupiter Swap API V2 configuration and credential status.
   */
  static getIntegrationStatus() {
    const config = getAppConfig();
    return {
      version: 'v2',
      orderEndpoint: `${config.jupiter.baseUrl}/order`,
      executeEndpoint: `${config.jupiter.baseUrl}/execute`,
      hasApiKey: config.jupiter.hasApiKey,
      hasReferralAccount: Boolean(config.jupiter.referralAccount),
      referralFeeBps: config.jupiter.referralFeeBps,
      statusNote: config.jupiter.hasApiKey
        ? 'Authenticated Jupiter Swap API V2 active'
        : 'Public Jupiter Swap API V2 endpoint configured (Set JUPITER_API_KEY in .env for dedicated production rate limits)',
    };
  }

  /**
   * Requests an order/quote from Jupiter Swap API V2 (`GET /swap/v2/order`).
   * Supports:
   * - Quote-only inspection when `taker` is omitted
   * - Ready-to-sign VersionedTransaction when `taker` is provided
   * - Integrator gasless fee sponsorship when `payer` is provided (forces Metis routing & supports `closeAuthority`, `referralAccount`, `referralFee`)
   */
  static async getOrder(params: JupiterOrderRequest): Promise<JupiterOrderResponse> {
    if (!params.inputMint || !params.outputMint) {
      throw new Error('inputMint and outputMint are required for Jupiter V2 /order');
    }
    try {
      new PublicKey(params.inputMint);
      new PublicKey(params.outputMint);
    } catch {
      throw new Error('Invalid inputMint or outputMint public key format');
    }
    if (params.inputMint === params.outputMint) {
      throw new Error('inputMint and outputMint cannot be identical');
    }
    if (!params.amount || !/^[1-9]\d*$/.test(String(params.amount).trim())) {
      throw new Error(`Invalid swap amount "${params.amount}": must be a positive integer string`);
    }

    const config = getAppConfig();
    const url = new URL(`${config.jupiter.baseUrl}/order`);
    url.searchParams.set('inputMint', params.inputMint);
    url.searchParams.set('outputMint', params.outputMint);
    url.searchParams.set('amount', String(params.amount).trim());

    if (params.slippageBps !== undefined) {
      const bps = Number(params.slippageBps);
      if (!Number.isFinite(bps) || bps < 0 || bps > 5000) {
        throw new Error(`Invalid slippageBps (${params.slippageBps}): must be between 0 and 5000`);
      }
      url.searchParams.set('slippageBps', String(Math.floor(bps)));
    }

    if (params.taker) {
      try {
        new PublicKey(params.taker);
      } catch {
        throw new Error(`Invalid taker wallet address: ${params.taker}`);
      }
      url.searchParams.set('taker', params.taker);
    }

    if (params.payer) {
      try {
        new PublicKey(params.payer);
      } catch {
        throw new Error(`Invalid payer sponsor wallet address: ${params.payer}`);
      }
      url.searchParams.set('payer', params.payer);

      const closeAuthority = params.closeAuthority || config.sponsorship.closeAuthority;
      if (closeAuthority) {
        try {
          new PublicKey(closeAuthority);
          url.searchParams.set('closeAuthority', closeAuthority);
        } catch {
          // Ignore malformed optional closeAuthority
        }
      }
    }

    const referralAccount = params.referralAccount || config.jupiter.referralAccount;
    const referralFee = params.referralFee ?? config.jupiter.referralFeeBps;
    if (referralAccount && referralFee >= 50 && referralFee <= 255) {
      try {
        new PublicKey(referralAccount);
        url.searchParams.set('referralAccount', referralAccount);
        url.searchParams.set('referralFee', String(Math.floor(referralFee)));
      } catch {
        // Ignore malformed optional referralAccount
      }
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (config.jupiter.hasApiKey) {
      headers['x-api-key'] = config.jupiter.apiKey;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const errMsg =
          data?.error ||
          data?.message ||
          data?.errorMessage ||
          `Jupiter Swap API V2 /order returned HTTP ${response.status}`;
        throw new Error(errMsg);
      }

      return {
        mode: data.mode || (params.payer ? 'integrator-payer' : 'ultra'),
        swapType: data.swapType,
        router: data.router || 'metis',
        requestId: data.requestId || '',
        inAmount: String(data.inAmount || params.amount),
        outAmount: String(data.outAmount || '0'),
        otherAmountThreshold: String(data.otherAmountThreshold || data.outAmount || '0'),
        swapMode: data.swapMode || 'ExactIn',
        slippageBps: Number(data.slippageBps ?? params.slippageBps ?? 100),
        priceImpactPct: String(data.priceImpactPct ?? '0'),
        routePlan: Array.isArray(data.routePlan) ? data.routePlan : [],
        feeMint: data.feeMint,
        feeBps: data.feeBps !== undefined ? Number(data.feeBps) : undefined,
        gasless: Boolean(data.gasless || params.payer),
        transaction: data.transaction ?? null,
        expireAt: this.normalizeExpireAtMs(data.expireAt, 45_000),
        errorCode: data.errorCode,
        errorMessage: data.errorMessage,
      };
    } catch (err) {
      clearTimeout(timeout);
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /**
   * Submits a signed base64 transaction to Jupiter Swap API V2 (`POST /swap/v2/execute`).
   * Validates that `requestId` is present and `signedTransaction` is a valid VersionedTransaction
   * with all required signature slots populated before transmitting.
   */
  static async executeOrder(payload: JupiterExecuteRequest): Promise<JupiterExecuteResponse> {
    if (!payload.requestId || payload.requestId.trim().length === 0) {
      return {
        status: 'Failed',
        error: 'Missing Jupiter V2 requestId for /swap/v2/execute',
      };
    }
    if (!payload.signedTransaction || payload.signedTransaction.trim().length === 0) {
      return {
        status: 'Failed',
        error: 'Missing signedTransaction payload for /swap/v2/execute',
      };
    }

    try {
      const txBytes = Buffer.from(payload.signedTransaction, 'base64');
      const tx = VersionedTransaction.deserialize(txBytes);
      if (tx.version !== 0 && tx.version !== 'legacy') {
        return {
          status: 'Failed',
          error: `Unsupported transaction version: ${String(tx.version)}`,
        };
      }
      const numRequired = tx.message.header.numRequiredSignatures;
      for (let i = 0; i < numRequired; i++) {
        const sig = tx.signatures[i];
        if (!sig || !sig.some((b) => b !== 0)) {
          return {
            status: 'Failed',
            error: `Missing required signature at signer index ${i} before submitting to Jupiter /execute`,
          };
        }
      }
    } catch (err) {
      return {
        status: 'Failed',
        error: `Invalid VersionedTransaction for Jupiter /execute: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    const config = getAppConfig();
    const url = `${config.jupiter.baseUrl}/execute`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (config.jupiter.hasApiKey) {
      headers['x-api-key'] = config.jupiter.apiKey;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          signedTransaction: payload.signedTransaction,
          requestId: payload.requestId,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.status === 'Failed') {
        return {
          status: 'Failed',
          signature: data.signature,
          code: data.code ?? response.status,
          error:
            data.error ||
            data.message ||
            data.errorMessage ||
            `Jupiter V2 /execute failed with HTTP ${response.status}`,
        };
      }

      return {
        status: 'Success',
        signature: data.signature,
        slot: data.slot ? String(data.slot) : undefined,
        totalInputAmount: data.totalInputAmount ?? data.inputAmountResult,
        totalOutputAmount: data.totalOutputAmount ?? data.outputAmountResult,
      };
    } catch (err) {
      clearTimeout(timeout);
      return {
        status: 'Failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Validates a quote/order response for viability, positive output, supported transaction version,
   * and non-expiration.
   */
  static validateOrderQuote(
    order: JupiterOrderResponse,
    maxPriceImpactPct: number = 10.0,
    requireExecutableTransaction: boolean = false
  ): { valid: boolean; reason?: string } {
    if (!order || !order.outAmount) {
      return { valid: false, reason: 'Empty quote output amount' };
    }

    if (order.errorMessage || order.errorCode) {
      return {
        valid: false,
        reason: order.errorMessage || `Jupiter order error code ${String(order.errorCode)}`,
      };
    }

    try {
      const inBig = BigInt(order.inAmount || '0');
      const outBig = BigInt(order.outAmount);
      const minOutBig = BigInt(order.otherAmountThreshold || order.outAmount);
      if (inBig <= 0n) {
        return { valid: false, reason: 'Zero input amount in order quote' };
      }
      if (outBig <= 0n || minOutBig <= 0n) {
        return { valid: false, reason: 'Zero output amount returned by route' };
      }
      if (minOutBig > outBig) {
        return { valid: false, reason: 'Malformed slippage threshold exceeds expected output' };
      }
    } catch {
      return { valid: false, reason: 'Malformed output amount' };
    }

    const impactNum = Number(order.priceImpactPct ?? 0);
    if (!Number.isFinite(impactNum)) {
      return { valid: false, reason: 'Malformed priceImpactPct in quote' };
    }
    const impact = Math.abs(impactNum);
    if (impact > maxPriceImpactPct) {
      return {
        valid: false,
        reason: `Price impact (${impact.toFixed(2)}%) exceeds maximum allowed threshold (${maxPriceImpactPct.toFixed(2)}%)`,
      };
    }

    const normalizedExpireAt = order.expireAt
      ? this.normalizeExpireAtMs(order.expireAt)
      : undefined;
    if (normalizedExpireAt && Date.now() > normalizedExpireAt) {
      return { valid: false, reason: 'Quote has expired' };
    }

    if (requireExecutableTransaction) {
      if (!order.requestId || order.requestId.trim().length === 0) {
        return { valid: false, reason: 'Missing requestId in executable Jupiter V2 order' };
      }
      if (!order.transaction || order.transaction.trim().length === 0) {
        return {
          valid: false,
          reason: 'Missing serialized transaction in executable Jupiter V2 order',
        };
      }
      try {
        const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'));
        if (tx.version !== 0 && tx.version !== 'legacy') {
          return {
            valid: false,
            reason: `Unsupported transaction version returned by Jupiter: ${String(tx.version)}`,
          };
        }
      } catch {
        return {
          valid: false,
          reason: 'Malformed base64 VersionedTransaction returned by Jupiter V2 /order',
        };
      }
    }

    return { valid: true };
  }
}
