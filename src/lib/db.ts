import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { getAppConfig } from '@/lib/config';

const requireBuiltin = createRequire(import.meta.url);
const { DatabaseSync } = requireBuiltin('node:sqlite') as typeof import('node:sqlite');

let dbInstance: InstanceType<typeof DatabaseSync> | null = null;
let inTransactionDepth = 0;

export function getDb(): InstanceType<typeof DatabaseSync> {
  if (dbInstance) {
    return dbInstance;
  }

  const config = getAppConfig();
  let dbPath =
    process.env.VITEST === 'true'
      ? ':memory:'
      : path.resolve(process.cwd(), config.databasePath);

  if (dbPath !== ':memory:') {
    try {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.accessSync(dir, fs.constants.W_OK);
    } catch {
      const fallbackDir = path.join(os.tmpdir(), 'vacuum-data');
      if (!fs.existsSync(fallbackDir)) {
        fs.mkdirSync(fallbackDir, { recursive: true });
      }
      dbPath = path.join(fallbackDir, 'vacuum.db');
    }
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  initializeSchema(db);
  dbInstance = db;
  inTransactionDepth = 0;
  return db;
}

/**
 * Executes a synchronous callback inside an atomic SQLite transaction (`BEGIN IMMEDIATE ... COMMIT / ROLLBACK`).
 * Supports nested calls via savepoints.
 */
export function runInTransaction<T>(fn: (db: InstanceType<typeof DatabaseSync>) => T): T {
  const db = getDb();
  const isOuter = inTransactionDepth === 0;
  const savepointName = `sp_vac_${inTransactionDepth}`;

  if (isOuter) {
    db.exec('BEGIN IMMEDIATE;');
  } else {
    db.exec(`SAVEPOINT ${savepointName};`);
  }
  inTransactionDepth++;

  try {
    const result = fn(db);
    inTransactionDepth--;
    if (isOuter) {
      db.exec('COMMIT;');
    } else {
      db.exec(`RELEASE SAVEPOINT ${savepointName};`);
    }
    return result;
  } catch (err) {
    inTransactionDepth--;
    try {
      if (isOuter) {
        db.exec('ROLLBACK;');
      } else {
        db.exec(`ROLLBACK TO SAVEPOINT ${savepointName};`);
        db.exec(`RELEASE SAVEPOINT ${savepointName};`);
      }
    } catch {
      // Ignore rollback errors if connection already rolled back
    }
    throw err;
  }
}

export function resetTestDb(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      // Ignore close error
    }
    dbInstance = null;
    inTransactionDepth = 0;
  }
}

function safeAddColumn(
  db: InstanceType<typeof DatabaseSync>,
  table: string,
  columnDef: string
): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef};`);
  } catch {
    // Column already exists
  }
}

function initializeSchema(db: InstanceType<typeof DatabaseSync>): void {
  db.exec(`
    -- 1. Users / Wallet Identities
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      primary_wallet_address TEXT NOT NULL UNIQUE,
      tier TEXT NOT NULL DEFAULT 'STANDARD',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 2. Connected Wallets (supports Multi-Wallet Management)
    CREATE TABLE IF NOT EXISTS connected_wallets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      wallet_address TEXT NOT NULL UNIQUE,
      wallet_provider TEXT,
      network TEXT NOT NULL DEFAULT 'devnet',
      is_active INTEGER NOT NULL DEFAULT 1,
      connected_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_connected_wallets_user ON connected_wallets(user_id);

    -- 3. Token Metadata Cache
    CREATE TABLE IF NOT EXISTS token_metadata_cache (
      mint_address TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      symbol TEXT NOT NULL,
      decimals INTEGER NOT NULL,
      logo_uri TEXT,
      is_token_2022 INTEGER NOT NULL DEFAULT 0,
      price_usd REAL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 4. Risk Assessments
    CREATE TABLE IF NOT EXISTS risk_assessments (
      mint_address TEXT PRIMARY KEY,
      risk_level TEXT NOT NULL,
      risk_score INTEGER NOT NULL,
      has_mint_authority INTEGER NOT NULL DEFAULT 0,
      has_freeze_authority INTEGER NOT NULL DEFAULT 0,
      is_token_2022 INTEGER NOT NULL DEFAULT 0,
      has_transfer_restriction INTEGER NOT NULL DEFAULT 0,
      signals_json TEXT NOT NULL DEFAULT '[]',
      assessed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 5. Discovered Assets
    CREATE TABLE IF NOT EXISTS discovered_assets (
      id TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL,
      network TEXT NOT NULL,
      token_account_address TEXT NOT NULL,
      mint_address TEXT NOT NULL,
      program_id TEXT NOT NULL DEFAULT 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      is_token_2022 INTEGER NOT NULL DEFAULT 0,
      is_frozen INTEGER NOT NULL DEFAULT 0,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      decimals INTEGER NOT NULL,
      raw_balance TEXT NOT NULL,
      ui_balance REAL NOT NULL,
      estimated_value_usd REAL,
      reclaimable_rent_lamports INTEGER NOT NULL DEFAULT 0,
      liquidity_status TEXT NOT NULL,
      category TEXT NOT NULL,
      is_recoverable_dust INTEGER NOT NULL DEFAULT 0,
      discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(wallet_address, network, token_account_address)
    );
    CREATE INDEX IF NOT EXISTS idx_discovered_assets_wallet ON discovered_assets(wallet_address, network);

    -- 6. Sweep Sessions
    CREATE TABLE IF NOT EXISTS sweep_sessions (
      session_id TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL,
      network TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'live',
      destination_symbol TEXT NOT NULL,
      destination_mint TEXT NOT NULL,
      slippage_bps INTEGER NOT NULL,
      status TEXT NOT NULL,
      total_assets_selected INTEGER NOT NULL,
      total_input_value_usd REAL NOT NULL,
      expected_output_ui REAL NOT NULL,
      expected_output_usd REAL NOT NULL,
      actual_output_ui REAL NOT NULL DEFAULT 0,
      estimated_network_cost_usd REAL NOT NULL,
      estimated_net_result_usd REAL NOT NULL,
      sponsorship_json TEXT NOT NULL,
      skipped_assets_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sweep_sessions_wallet ON sweep_sessions(wallet_address, created_at DESC);

    -- 7. Transaction Batches
    CREATE TABLE IF NOT EXISTS transaction_batches (
      batch_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      batch_index INTEGER NOT NULL,
      total_batches INTEGER NOT NULL,
      serialized_transaction_base64 TEXT,
      jupiter_request_id TEXT,
      estimated_fee_lamports INTEGER NOT NULL,
      actual_fee_lamports INTEGER,
      estimated_fee_usd REAL NOT NULL,
      estimated_compute_units INTEGER NOT NULL,
      estimated_bytes INTEGER NOT NULL,
      sponsorship_applied INTEGER NOT NULL DEFAULT 0,
      sponsor_public_key TEXT,
      status TEXT NOT NULL,
      signature TEXT,
      confirmed_slot INTEGER,
      error_message TEXT,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sweep_sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_batches_session ON transaction_batches(session_id, batch_index);

    -- 8. Sweep Items
    CREATE TABLE IF NOT EXISTS sweep_items (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      mint_address TEXT NOT NULL,
      token_account_address TEXT NOT NULL,
      program_id TEXT NOT NULL DEFAULT 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      is_token_2022 INTEGER NOT NULL DEFAULT 0,
      reclaimable_rent_lamports INTEGER NOT NULL DEFAULT 0,
      reclaimable_rent_usd REAL NOT NULL DEFAULT 0,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      decimals INTEGER NOT NULL,
      input_raw_amount TEXT NOT NULL,
      input_ui_amount REAL NOT NULL,
      input_value_usd REAL NOT NULL,
      destination_mint TEXT NOT NULL,
      destination_symbol TEXT NOT NULL,
      expected_output_raw TEXT NOT NULL,
      expected_output_ui REAL NOT NULL,
      min_output_raw TEXT NOT NULL,
      min_output_ui REAL NOT NULL,
      expected_output_usd REAL NOT NULL,
      price_impact_pct REAL NOT NULL,
      router_label TEXT NOT NULL,
      jupiter_request_id TEXT,
      serialized_transaction_base64 TEXT,
      estimated_compute_units INTEGER NOT NULL DEFAULT 60000,
      estimated_bytes INTEGER NOT NULL DEFAULT 180,
      account_count INTEGER NOT NULL DEFAULT 6,
      uses_lookup_table INTEGER NOT NULL DEFAULT 0,
      action_type TEXT NOT NULL DEFAULT 'JUPITER_SWAP_V2',
      status TEXT NOT NULL DEFAULT 'PENDING',
      FOREIGN KEY (session_id) REFERENCES sweep_sessions(session_id) ON DELETE CASCADE,
      FOREIGN KEY (batch_id) REFERENCES transaction_batches(batch_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sweep_items_session ON sweep_items(session_id);

    -- 9. Transaction Records
    CREATE TABLE IF NOT EXISTS transaction_records (
      signature TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      network TEXT NOT NULL,
      mode TEXT NOT NULL,
      destination_symbol TEXT NOT NULL,
      output_amount_ui REAL NOT NULL,
      network_fee_lamports INTEGER NOT NULL,
      sponsored_lamports INTEGER NOT NULL DEFAULT 0,
      confirmation_status TEXT NOT NULL,
      slot INTEGER,
      failure_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sweep_sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_tx_records_wallet ON transaction_records(wallet_address, created_at DESC);

    -- 10. Sponsorship Records
    CREATE TABLE IF NOT EXISTS sponsorship_records (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      batch_id TEXT,
      wallet_address TEXT NOT NULL,
      sponsor_public_key TEXT NOT NULL,
      network TEXT NOT NULL,
      lamports_sponsored INTEGER NOT NULL,
      usd_value_sponsored REAL NOT NULL,
      is_subsidized INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      signature TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sponsorship_wallet_date ON sponsorship_records(wallet_address, created_at);
    CREATE INDEX IF NOT EXISTS idx_sponsorship_date ON sponsorship_records(created_at);

    -- 11. Application Configuration
    CREATE TABLE IF NOT EXISTS application_configuration (
      config_key TEXT PRIMARY KEY,
      config_value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 12. Feature Flags
    CREATE TABLE IF NOT EXISTS feature_flags (
      flag_key TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      description TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 13. Analytics Events
    CREATE TABLE IF NOT EXISTS analytics_events (
      id TEXT PRIMARY KEY,
      wallet_address TEXT,
      event_type TEXT NOT NULL,
      network TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_analytics_event_type ON analytics_events(event_type, created_at);
  `);

  // Ensure backward-compatible schema migrations if an older ./data/vacuum.db file exists on disk
  safeAddColumn(db, 'discovered_assets', "program_id TEXT NOT NULL DEFAULT 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'");
  safeAddColumn(db, 'discovered_assets', 'is_token_2022 INTEGER NOT NULL DEFAULT 0');
  safeAddColumn(db, 'discovered_assets', 'is_frozen INTEGER NOT NULL DEFAULT 0');
  safeAddColumn(db, 'transaction_batches', 'actual_fee_lamports INTEGER');
  safeAddColumn(db, 'sweep_items', "program_id TEXT NOT NULL DEFAULT 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'");
  safeAddColumn(db, 'sweep_items', 'is_token_2022 INTEGER NOT NULL DEFAULT 0');
  safeAddColumn(db, 'sweep_items', 'reclaimable_rent_lamports INTEGER NOT NULL DEFAULT 0');
  safeAddColumn(db, 'sweep_items', 'reclaimable_rent_usd REAL NOT NULL DEFAULT 0');
  safeAddColumn(db, 'sweep_items', 'jupiter_request_id TEXT');
  safeAddColumn(db, 'sweep_items', 'serialized_transaction_base64 TEXT');
  safeAddColumn(db, 'sweep_items', 'estimated_compute_units INTEGER NOT NULL DEFAULT 60000');
  safeAddColumn(db, 'sweep_items', 'estimated_bytes INTEGER NOT NULL DEFAULT 180');
  safeAddColumn(db, 'sweep_items', 'account_count INTEGER NOT NULL DEFAULT 6');
  safeAddColumn(db, 'sweep_items', 'uses_lookup_table INTEGER NOT NULL DEFAULT 0');

  const insertFlag = db.prepare(`
    INSERT OR IGNORE INTO feature_flags (flag_key, enabled, description)
    VALUES (?, ?, ?)
  `);
  insertFlag.run('FEATURE_VACUUM_FEE_DISCOUNT', 0, '50% platform fee reduction for verified $VACUUM holders');
  insertFlag.run('FEATURE_VACUUM_PRO_TIER', 0, 'Premium sweeping limits and multi-wallet orchestration');
  insertFlag.run('FEATURE_AUTO_SWEEP', 0, 'Scheduled recurring wallet scans with explicit authorization');
  insertFlag.run('FEATURE_SMART_MERGER', 1, 'Multi-token consolidation into $VACUUM, SOL, or USDC');
}
