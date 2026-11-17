-- ============================================================================
-- VACUUM — Production PostgreSQL Rollback Script (001_down_rollback.sql)
-- Safely drops all 13 VACUUM tables in reverse foreign-key dependency order.
-- ============================================================================

BEGIN;

DROP TABLE IF EXISTS analytics_events;
DROP TABLE IF EXISTS feature_flags;
DROP TABLE IF EXISTS application_configuration;
DROP TABLE IF EXISTS sponsorship_records;
DROP TABLE IF EXISTS transaction_records;
DROP TABLE IF EXISTS sweep_items;
DROP TABLE IF EXISTS transaction_batches;
DROP TABLE IF EXISTS sweep_sessions;
DROP TABLE IF EXISTS discovered_assets;
DROP TABLE IF EXISTS risk_assessments;
DROP TABLE IF EXISTS token_metadata_cache;
DROP TABLE IF EXISTS connected_wallets;
DROP TABLE IF EXISTS users;

COMMIT;
