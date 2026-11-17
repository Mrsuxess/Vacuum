import { PublicKey } from '@solana/web3.js';
import { SolanaNetwork } from '@/types/vacuum';
import { getDb } from '@/lib/db';

export class WalletService {
  /**
   * Validates a base58 Solana wallet address.
   */
  static isValidWalletAddress(address: string): boolean {
    if (!address || typeof address !== 'string') return false;
    try {
      const pk = new PublicKey(address.trim());
      return Boolean(pk.toBase58());
    } catch {
      return false;
    }
  }

  /**
   * Formats a Solana address for clean UI presentation (`7xKX...9b2P`).
   */
  static shortenAddress(address: string, chars: number = 4): string {
    if (!address || address.length <= chars * 2 + 3) return address;
    return `${address.slice(0, chars)}...${address.slice(-chars)}`;
  }

  /**
   * Registers or updates a connected wallet identity in the database.
   * Never stores private keys or seed phrases.
   */
  static registerConnectedWallet(params: {
    walletAddress: string;
    walletProvider?: string;
    network: SolanaNetwork;
  }): void {
    if (!this.isValidWalletAddress(params.walletAddress)) {
      throw new Error(`Invalid Solana wallet address: ${params.walletAddress}`);
    }

    const db = getDb();
    const userId = `usr_${params.walletAddress.slice(0, 16)}`;

    db.prepare(`
      INSERT INTO users (id, primary_wallet_address, tier, created_at, last_seen_at)
      VALUES (?, ?, 'STANDARD', datetime('now'), datetime('now'))
      ON CONFLICT(primary_wallet_address) DO UPDATE SET last_seen_at = datetime('now')
    `).run(userId, params.walletAddress);

    const existingUser = db
      .prepare(`SELECT id FROM users WHERE primary_wallet_address = ?`)
      .get(params.walletAddress) as { id: string } | undefined;

    const resolvedUserId = existingUser?.id || userId;

    db.prepare(`
      INSERT INTO connected_wallets (
        id, user_id, wallet_address, wallet_provider, network, is_active, connected_at
      ) VALUES (?, ?, ?, ?, ?, 1, datetime('now'))
      ON CONFLICT(wallet_address) DO UPDATE SET
        wallet_provider = excluded.wallet_provider,
        network = excluded.network,
        is_active = 1
    `).run(
      `cw_${params.walletAddress.slice(0, 16)}`,
      resolvedUserId,
      params.walletAddress,
      params.walletProvider || 'Solana Wallet Standard',
      params.network
    );
  }
}
