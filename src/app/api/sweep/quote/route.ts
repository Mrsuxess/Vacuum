import { NextRequest, NextResponse } from 'next/server';
import { ApiSecurity } from '@/lib/apiSecurity';
import { SweepOrchestrator } from '@/services/sweepOrchestrator';
import { WalletService } from '@/services/walletService';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => {
      throw new Error('Malformed JSON request body');
    });

    const walletAddress = String(body.walletAddress || '').trim();
    const network = ApiSecurity.validateNetwork(body.network, 'devnet');
    const mode = ApiSecurity.validateMode(body.mode, 'live');
    const destinationSymbol = ApiSecurity.validateDestinationSymbol(
      body.destinationSymbol,
      'VACUUM'
    );
    const slippageBps = ApiSecurity.validateSlippageBps(body.slippageBps, 100);
    const requestGaslessSponsorship = body.requestGaslessSponsorship !== false;

    const clientId = ApiSecurity.getClientIdentifier(req, walletAddress);
    const rl = ApiSecurity.checkRateLimit(`quote:${clientId}`, 20, 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { ok: false, error: 'Quote rate limit exceeded. Please wait before requesting new quotes.' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSeconds ?? 10) } }
      );
    }

    if (mode === 'live' && !WalletService.isValidWalletAddress(walletAddress)) {
      return NextResponse.json(
        { ok: false, error: 'Invalid Solana wallet address.' },
        { status: 400 }
      );
    }

    const selectedAssets = ApiSecurity.validateSelectedAssets(body.selectedAssets, mode);

    const session = await SweepOrchestrator.createSweepSession({
      walletAddress: walletAddress || 'DemoWa11etVacuumSweeperPreview1111111111111',
      network,
      mode,
      selectedAssets,
      destinationSymbol,
      slippageBps,
      requestGaslessSponsorship,
    });

    return NextResponse.json({
      ok: true,
      session,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to create sweep quote session',
      },
      { status: 400 }
    );
  }
}
