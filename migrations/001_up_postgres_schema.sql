-- ============================================================================
-- VACUUM — Production PostgreSQL Schema Migration (001_up_postgres_schema.sql)
-- Compatible with Neon Serverless Postgres, Supabase, and Vercel Postgres.
-- Preserves all 13 tables, foreign keys, UNIQUE constraints, and indexes.
-- ============================================================================

BEGIN;

-- 1. Users / Wallet Identities
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  primary_wallet_address TEXT NOT NULL UNIQUE,
  tier TEXT NOT NULL DEFAULT 'STANDARD',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Connected Wallets (supports Multi-Wallet Management)
CREATE TABLE IF NOT EXISTS connected_wallets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL UNIQUE,
  wallet_provider TEXT,
  network TEXT NOT NULL DEFAULT 'devnet',
  is_active SMALLINT NOT NULL DEFAULT 1,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_connected_wallets_user ON connected_wallets(user_id);

-- 3. Token Metadata Cache
CREATE TABLE IF NOT EXISTS token_metadata_cache (
  mint_address TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  logo_uri TEXT,
  is_token_2022 SMALLINT NOT NULL DEFAULT 0,
  price_usd DOUBLE PRECISION,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Risk Assessments
CREATE TABLE IF NOT EXISTS risk_assessments (
  mint_address TEXT PRIMARY KEY,
  risk_level TEXT NOT NULL,
  risk_score INTEGER NOT NULL,
  has_mint_authority SMALLINT NOT NULL DEFAULT 0,
  has_freeze_authority SMALLINT NOT NULL DEFAULT 0,
  is_token_2022 SMALLINT NOT NULL DEFAULT 0,
  has_transfer_restriction SMALLINT NOT NULL DEFAULT 0,
  signals_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  assessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Discovered Assets
CREATE TABLE IF NOT EXISTS discovered_assets (
  id TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  network TEXT NOT NULL,
  token_account_address TEXT NOT NULL,
  mint_address TEXT NOT NULL,
  program_id TEXT NOT NULL DEFAULT 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  is_token_2022 SMALLINT NOT NULL DEFAULT 0,
  is_frozen SMALLINT NOT NULL DEFAULT 0,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  raw_balance TEXT NOT NULL,
  ui_balance DOUBLE PRECISION NOT NULL,
  estimated_value_usd DOUBLE PRECISION,
  reclaimable_rent_lamports BIGINT NOT NULL DEFAULT 0,
  liquidity_status TEXT NOT NULL,
  category TEXT NOT NULL,
  is_recoverable_dust SMALLINT NOT NULL DEFAULT 0,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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
  total_input_value_usd DOUBLE PRECISION NOT NULL,
  expected_output_ui DOUBLE PRECISION NOT NULL,
  expected_output_usd DOUBLE PRECISION NOT NULL,
  actual_output_ui DOUBLE PRECISION NOT NULL DEFAULT 0,
  estimated_network_cost_usd DOUBLE PRECISION NOT NULL,
  estimated_net_result_usd DOUBLE PRECISION NOT NULL,
  sponsorship_json JSONB NOT NULL,
  skipped_assets_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sweep_sessions_wallet ON sweep_sessions(wallet_address, created_at DESC);

-- 7. Transaction Batches
CREATE TABLE IF NOT EXISTS transaction_batches (
  batch_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sweep_sessions(session_id) ON DELETE CASCADE,
  batch_index INTEGER NOT NULL,
  total_batches INTEGER NOT NULL,
  serialized_transaction_base64 TEXT,
  jupiter_request_id TEXT,
  estimated_fee_lamports BIGINT NOT NULL,
  actual_fee_lamports BIGINT,
  estimated_fee_usd DOUBLE PRECISION NOT NULL,
  estimated_compute_units INTEGER NOT NULL,
  estimated_bytes INTEGER NOT NULL,
  sponsorship_applied SMALLINT NOT NULL DEFAULT 0,
  sponsor_public_key TEXT,
  status TEXT NOT NULL,
  signature TEXT,
  confirmed_slot BIGINT,
  error_message TEXT,
  expires_at BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_batches_session ON transaction_batches(session_id, batch_index);

-- 8. Sweep Items
CREATE TABLE IF NOT EXISTS sweep_items (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sweep_sessions(session_id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL REFERENCES transaction_batches(batch_id) ON DELETE CASCADE,
  mint_address TEXT NOT NULL,
  token_account_address TEXT NOT NULL,
  program_id TEXT NOT NULL DEFAULT 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  is_token_2022 SMALLINT NOT NULL DEFAULT 0,
  reclaimable_rent_lamports BIGINT NOT NULL DEFAULT 0,
  reclaimable_rent_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  input_raw_amount TEXT NOT NULL,
  input_ui_amount DOUBLE PRECISION NOT NULL,
  input_value_usd DOUBLE PRECISION NOT NULL,
  destination_mint TEXT NOT NULL,
  destination_symbol TEXT NOT NULL,
  expected_output_raw TEXT NOT NULL,
  expected_output_ui DOUBLE PRECISION NOT NULL,
  min_output_raw TEXT NOT NULL,
  min_output_ui DOUBLE PRECISION NOT NULL,
  expected_output_usd DOUBLE PRECISION NOT NULL,
  price_impact_pct DOUBLE PRECISION NOT NULL,
  router_label TEXT NOT NULL,
  jupiter_request_id TEXT,
  serialized_transaction_base64 TEXT,
  estimated_compute_units INTEGER NOT NULL DEFAULT 60000,
  estimated_bytes INTEGER NOT NULL DEFAULT 180,
  account_count INTEGER NOT NULL DEFAULT 6,
  uses_lookup_table SMALLINT NOT NULL DEFAULT 0,
  action_type TEXT NOT NULL DEFAULT 'JUPITER_SWAP_V2',
  status TEXT NOT NULL DEFAULT 'PENDING'
);
CREATE INDEX IF NOT EXISTS idx_sweep_items_session ON sweep_items(session_id);

-- 9. Transaction Records
CREATE TABLE IF NOT EXISTS transaction_records (
  signature TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sweep_sessions(session_id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  network TEXT NOT NULL,
  mode TEXT NOT NULL,
  destination_symbol TEXT NOT NULL,
  output_amount_ui DOUBLE PRECISION NOT NULL,
  network_fee_lamports BIGINT NOT NULL,
  sponsored_lamports BIGINT NOT NULL DEFAULT 0,
  confirmation_status TEXT NOT NULL,
  slot BIGINT,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
  lamports_sponsored BIGINT NOT NULL,
  usd_value_sponsored DOUBLE PRECISION NOT NULL,
  is_subsidized SMALLINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  signature TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sponsorship_wallet_date ON sponsorship_records(wallet_address, created_at);
CREATE INDEX IF NOT EXISTS idx_sponsorship_date ON sponsorship_records(created_at);

-- 11. Application Configuration
CREATE TABLE IF NOT EXISTS application_configuration (
  config_key TEXT PRIMARY KEY,
  config_value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 12. Feature Flags
CREATE TABLE IF NOT EXISTS feature_flags (
  flag_key TEXT PRIMARY KEY,
  enabled SMALLINT NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO feature_flags (flag_key, enabled, description) VALUES
  ('FEATURE_VACUUM_FEE_DISCOUNT', 0, '50% platform fee reduction for verified $VACUUM holders'),
  ('FEATURE_VACUUM_PRO_TIER', 0, 'Premium sweeping limits and multi-wallet orchestration'),
  ('FEATURE_AUTO_SWEEP', 0, 'Scheduled recurring wallet scans with explicit authorization'),
  ('FEATURE_SMART_MERGER', 1, 'Multi-token consolidation into $VACUUM, SOL, or USDC')
ON CONFLICT (flag_key) DO NOTHING;

-- 13. Analytics Events
CREATE TABLE IF NOT EXISTS analytics_events (
  id TEXT PRIMARY KEY,
  wallet_address TEXT,
  event_type TEXT NOT NULL,
  network TEXT NOT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_analytics_event_type ON analytics_events(event_type, created_at);

COMMIT;
