import { NextRequest, NextResponse } from 'next/server';
import { ApiSecurity } from '@/lib/apiSecurity';
import { HistoryService } from '@/services/historyService';
import { AnalyticsService } from '@/services/analyticsService';
import { WalletService } from '@/services/walletService';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const walletAddress = searchParams.get('walletAddress')?.trim() || undefined;
    const sessionId = searchParams.get('sessionId')?.trim() || undefined;

    const clientId = ApiSecurity.getClientIdentifier(req, walletAddress);
    const rl = ApiSecurity.checkRateLimit(`history:${clientId}`, 60, 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { ok: false, error: 'History rate limit exceeded. Please retry shortly.' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSeconds ?? 10) } }
      );
    }

    if (sessionId) {
      if (!/^vac_[a-f0-9]{16}$/.test(sessionId)) {
        return NextResponse.json(
          { ok: false, error: 'Invalid sessionId format.' },
          { status: 400 }
        );
      }
      const receipt = HistoryService.generateSessionReceipt(sessionId);
      if (walletAddress && receipt.walletAddress !== walletAddress) {
        return NextResponse.json(
          { ok: false, error: 'Session receipt does not belong to the specified walletAddress.' },
          { status: 403 }
        );
      }
      return NextResponse.json({
        ok: true,
        receipt,
      });
    }

    if (
      walletAddress &&
      walletAddress !== 'DemoWa11etVacuumSweeperPreview1111111111111' &&
      !WalletService.isValidWalletAddress(walletAddress)
    ) {
      return NextResponse.json(
        { ok: false, error: 'Invalid walletAddress parameter.' },
        { status: 400 }
      );
    }

    const analytics = AnalyticsService.getAnalyticsSummary(walletAddress);
    return NextResponse.json({
      ok: true,
      analytics,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to load transaction history',
      },
      { status: 400 }
    );
  }
}
