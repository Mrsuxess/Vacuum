import { NextRequest, NextResponse } from 'next/server';
import { DustThresholdConfig } from '@/types/vacuum';
import { DEFAULT_DUST_THRESHOLD_CONFIG } from '@/lib/config';
import { ApiSecurity } from '@/lib/apiSecurity';
import { TokenDiscoveryService } from '@/services/tokenDiscoveryService';
import { WalletService } from '@/services/walletService';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => {
      throw new Error('Malformed JSON request body');
    });

    const walletAddress = String(body.walletAddress || '').trim();
    const network = ApiSecurity.validateNetwork(body.network, 'devnet');
    const mode = ApiSecurity.validateMode(body.mode, 'live');

    const clientId = ApiSecurity.getClientIdentifier(req, walletAddress);
    const rl = ApiSecurity.checkRateLimit(`discover:${clientId}`, 30, 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { ok: false, error: 'Discovery rate limit exceeded. Please wait before scanning again.' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSeconds ?? 10) } }
      );
    }

    if (mode === 'live' && !WalletService.isValidWalletAddress(walletAddress)) {
      return NextResponse.json(
        { ok: false, error: 'Valid Solana wallet address is required for live discovery.' },
        { status: 400 }
      );
    }

    if (mode === 'live') {
      const providerName = String(body.walletProvider || 'Solana Wallet Standard')
        .trim()
        .slice(0, 64);
      WalletService.registerConnectedWallet({
        walletAddress,
        walletProvider: providerName,
        network,
      });
    }

    const thresholdConfig: DustThresholdConfig = {
      maxUsdValue: ApiSecurity.validateBoundedNumber(
        body.maxUsdValue,
        'maxUsdValue',
        DEFAULT_DUST_THRESHOLD_CONFIG.maxUsdValue,
        0.01,
        1000
      ),
      includeZeroBalanceCloseableAccounts:
        body.includeZeroBalanceCloseableAccounts !== undefined
          ? Boolean(body.includeZeroBalanceCloseableAccounts)
          : DEFAULT_DUST_THRESHOLD_CONFIG.includeZeroBalanceCloseableAccounts,
      minNetRecoveryUsd: ApiSecurity.validateBoundedNumber(
        body.minNetRecoveryUsd,
        'minNetRecoveryUsd',
        DEFAULT_DUST_THRESHOLD_CONFIG.minNetRecoveryUsd,
        0,
        500
      ),
      maxPriceImpactPct: ApiSecurity.validateBoundedNumber(
        body.maxPriceImpactPct,
        'maxPriceImpactPct',
        DEFAULT_DUST_THRESHOLD_CONFIG.maxPriceImpactPct,
        0.1,
        50
      ),
      slippageBps: ApiSecurity.validateSlippageBps(
        body.slippageBps,
        DEFAULT_DUST_THRESHOLD_CONFIG.slippageBps
      ),
    };

    const result = await TokenDiscoveryService.discoverWalletAssets(
      walletAddress,
      network,
      mode,
      thresholdConfig
    );

    return NextResponse.json({
      ok: true,
      discovery: result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to discover wallet assets';
    const isClientErr =
      message.includes('Invalid ') ||
      message.includes('Malformed ') ||
      message.includes('Unsupported ');
    return NextResponse.json(
      {
        ok: false,
        error: message,
      },
      { status: isClientErr ? 400 : 500 }
    );
  }
}
