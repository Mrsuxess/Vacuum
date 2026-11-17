import { NextRequest, NextResponse } from 'next/server';
import { getAppConfig } from '@/lib/config';
import { getDatabaseHealthStatus } from '@/lib/db';
import { ApiSecurity } from '@/lib/apiSecurity';
import { VacuumTokenService } from '@/services/vacuumTokenService';
import { JupiterService } from '@/services/jupiterService';
import { SponsorshipService } from '@/services/sponsorshipService';

export async function GET(req: NextRequest) {
  try {
    const clientId = ApiSecurity.getClientIdentifier(req);
    const rl = ApiSecurity.checkRateLimit(`status:${clientId}`, 60, 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { ok: false, error: 'Rate limit exceeded. Please retry shortly.' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSeconds ?? 10) } }
      );
    }

    const { searchParams } = new URL(req.url);
    const network = ApiSecurity.validateNetwork(searchParams.get('network'));

    const config = getAppConfig();
    const dbHealth = getDatabaseHealthStatus();
    const destinations = VacuumTokenService.getSupportedDestinations(network);
    const vacuumUtilities = VacuumTokenService.getTokenUtilityStatus(network);
    const jupiterStatus = JupiterService.getIntegrationStatus();
    const sponsorshipStatus = SponsorshipService.getSponsorPublicStatus(network);

    return NextResponse.json({
      ok: dbHealth.healthy,
      status: dbHealth.healthy ? 'healthy' : 'degraded',
      network,
      serverEnforcedNetwork: config.serverEnforcedNetwork,
      rpcEndpointConfigured: Boolean(config.rpc[network]),
      persistence: dbHealth,
      destinations,
      vacuumToken: vacuumUtilities,
      jupiter: jupiterStatus,
      sponsorship: sponsorshipStatus,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'Invalid status request parameters',
      },
      { status: 400 }
    );
  }
}
