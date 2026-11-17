import { NextRequest, NextResponse } from 'next/server';
import { ApiSecurity } from '@/lib/apiSecurity';
import { SweepOrchestrator } from '@/services/sweepOrchestrator';
import { HistoryService } from '@/services/historyService';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => {
      throw new Error('Malformed JSON request body');
    });

    const sessionId = String(body.sessionId || '').trim();
    const batchId = String(body.batchId || '').trim();
    const walletAddress = body.walletAddress ? String(body.walletAddress).trim() : undefined;
    const network =
      body.network !== undefined && body.network !== null && body.network !== ''
        ? ApiSecurity.validateNetwork(body.network)
        : undefined;
    const userSignedTransactionBase64 = body.userSignedTransactionBase64
      ? String(body.userSignedTransactionBase64).trim()
      : undefined;

    if (!sessionId || !batchId) {
      return NextResponse.json(
        { ok: false, error: 'sessionId and batchId are required.' },
        { status: 400 }
      );
    }

    if (!/^vac_[a-f0-9]{16}$/.test(sessionId)) {
      return NextResponse.json(
        { ok: false, error: 'Invalid sessionId format.' },
        { status: 400 }
      );
    }

    const clientId = ApiSecurity.getClientIdentifier(req, walletAddress || sessionId);
    const rl = ApiSecurity.checkRateLimit(`execute:${clientId}`, 25, 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { ok: false, error: 'Execution rate limit exceeded. Please wait before retrying.' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSeconds ?? 10) } }
      );
    }

    const { session, batch } = await SweepOrchestrator.executeAuthorizedBatch({
      sessionId,
      batchId,
      walletAddress,
      network,
      userSignedTransactionBase64,
    });

    const receipt = HistoryService.generateSessionReceipt(sessionId);

    return NextResponse.json({
      ok: true,
      session,
      batch,
      receipt,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to execute transaction batch',
      },
      { status: 400 }
    );
  }
}
