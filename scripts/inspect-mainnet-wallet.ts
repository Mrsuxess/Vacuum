import fs from 'fs';
import path from 'path';
import { VersionedTransaction } from '@solana/web3.js';
import { getAppConfig } from '../src/lib/config';
import { SponsorshipService } from '../src/services/sponsorshipService';
import { VacuumTokenService } from '../src/services/vacuumTokenService';
import { TokenDiscoveryService } from '../src/services/tokenDiscoveryService';
import { SweepOrchestrator } from '../src/services/sweepOrchestrator';
import { TransactionVerificationService } from '../src/services/transactionVerificationService';
import { WalletService } from '../src/services/walletService';

function loadEnvLocal() {
  const envPath = path.resolve(process.cwd(), '.env.local');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

/**
 * PHASE 13 — Read-Only Mainnet Wallet Inspector & Self-Paid Empty Account Closure Preparer.
 * Usage: npx tsx scripts/inspect-mainnet-wallet.ts [WALLET_PUBLIC_KEY]
 */
async function main() {
  loadEnvLocal();
  console.log('===================================================================');
  console.log('VACUUM — PHASE 13 PRE-FLIGHT & MAINNET WALLET INSPECTION');
  console.log('===================================================================');

  const config = getAppConfig();
  const sponsorKp = SponsorshipService.getServerSponsorKeypair('mainnet-beta');
  const sponsorStatus = SponsorshipService.getSponsorPublicStatus('mainnet-beta');
  const vacuumDest = VacuumTokenService.getDestinationBySymbol('VACUUM', 'mainnet-beta');

  console.log('--- 1. PRE-FLIGHT SECURITY BOUNDARY VERIFICATION ---');
  console.log(`Default Network             : ${config.defaultNetwork}`);
  console.log(`Server-Enforced Network     : ${config.serverEnforcedNetwork ?? 'NONE'}`);
  console.log(`Mainnet Sponsorship Enabled : ${sponsorStatus.enabled} (Must be false)`);
  console.log(`Devnet Sponsor Key Rejected : ${sponsorKp === null} (Must be true)`);
  console.log(`$VACUUM Mainnet Mint Set    : ${vacuumDest.isConfiguredForNetwork} (Must be false)`);

  if (sponsorStatus.enabled) {
    throw new Error('PRE-FLIGHT FAILED: Mainnet sponsorship must be disabled for Phase 13 Step 1.');
  }
  if (sponsorKp !== null) {
    throw new Error('PRE-FLIGHT FAILED: Mainnet sponsor keypair must be null.');
  }
  if (vacuumDest.isConfiguredForNetwork) {
    throw new Error('PRE-FLIGHT FAILED: $VACUUM Mainnet mint must not be configured.');
  }

  const walletAddress = process.argv[2]?.trim();
  if (!walletAddress) {
    console.log('\n[AWAITING USER MAINNET WALLET ADDRESS]');
    console.log('Connect your Phantom or Solflare Mainnet wallet at http://localhost:3000');
    console.log('or provide your public Mainnet wallet address to run Step 2 & Step 3.');
    return;
  }

  if (!WalletService.isValidWalletAddress(walletAddress)) {
    throw new Error(`Invalid Solana Mainnet wallet address: ${walletAddress}`);
  }

  console.log(`\n--- 2. INSPECTING MAINNET WALLET: ${walletAddress} ---`);
  const discovery = await TokenDiscoveryService.discoverWalletAssets(
    walletAddress,
    'mainnet-beta',
    'live'
  );

  console.log(`Native SOL Balance          : ${discovery.nativeSolBalance.toFixed(6)} SOL ($${discovery.nativeSolValueUsd.toFixed(2)})`);
  console.log(`Total Token Accounts Found  : ${discovery.assets.length}`);

  const emptyCloseable = discovery.assets.filter(
    (a) =>
      a.uiBalance === 0 &&
      BigInt(a.rawBalance || '0') === 0n &&
      a.risk.canSweepSafely &&
      !a.isFrozen &&
      (!a.closeAuthority || a.closeAuthority === walletAddress)
  );
  const routableNonZero = discovery.assets.filter(
    (a) => a.uiBalance > 0 && a.hasViableRoute && a.risk.canSweepSafely
  );
  const restrictedOrQuarantined = discovery.assets.filter(
    (a) => !a.risk.canSweepSafely || a.isFrozen || !a.hasViableRoute
  );

  console.log(`Eligible Empty Accounts     : ${emptyCloseable.length}`);
  console.log(`Routable Non-Zero Accounts  : ${routableNonZero.length}`);
  console.log(`Excluded/Restricted Accounts: ${restrictedOrQuarantined.length}`);

  for (const acc of discovery.assets) {
    console.log(
      `  • [${acc.symbol}] Account=${acc.tokenAccountAddress} | Mint=${acc.mintAddress} | Program=${
        acc.isToken2022 ? 'Token-2022' : 'SPL-Token'
      } | Balance=${acc.uiBalance} | Rent=${(acc.reclaimableRentLamports / 1e9).toFixed(6)} SOL | Category=${acc.category} | Frozen=${Boolean(acc.isFrozen)}`
    );
  }

  if (emptyCloseable.length === 0) {
    console.log('\n[STOP] No eligible empty token accounts found in this Mainnet wallet.');
    return;
  }

  // Prepare Step 3: Self-Paid CLOSE_EMPTY_ACCOUNT for the first eligible empty token account
  const targetEmpty = emptyCloseable[0];
  console.log(`\n--- 3. PREPARING SELF-PAID CLOSE_EMPTY_ACCOUNT FOR: ${targetEmpty.tokenAccountAddress} ---`);
  const session = await SweepOrchestrator.createSweepSession({
    walletAddress,
    network: 'mainnet-beta',
    mode: 'live',
    selectedAssets: [targetEmpty],
    destinationSymbol: 'SOL',
    slippageBps: 100,
    requestGaslessSponsorship: false,
  });

  const batch = session.batches[0];
  if (batch.serializedTransactionBase64) {
    const tx = VersionedTransaction.deserialize(
      Buffer.from(batch.serializedTransactionBase64, 'base64')
    );
    const rentCheck = TransactionVerificationService.verifyCloseAccountRentDestination(
      tx,
      walletAddress
    );
    console.log('Prepared Unsigned Transaction Review (STOPPED BEFORE SIGNING/BROADCAST):', {
      sessionId: session.sessionId,
      batchId: batch.batchId,
      tokenAccountToClose: targetEmpty.tokenAccountAddress,
      tokenProgram: targetEmpty.isToken2022 ? 'Token-2022' : 'SPL Token',
      authorityAndFeePayer: tx.message.staticAccountKeys[0].toBase58(),
      rentDestinationVerifiedToUser: rentCheck.valid,
      reclaimableRentLamports: targetEmpty.reclaimableRentLamports,
      reclaimableRentSol: Number((targetEmpty.reclaimableRentLamports / 1e9).toFixed(8)),
      estimatedNetworkFeeLamports: batch.estimatedFeeLamports,
      expectedNetRentRecoverySol: Number(
        ((targetEmpty.reclaimableRentLamports - batch.estimatedFeeLamports) / 1e9).toFixed(8)
      ),
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
