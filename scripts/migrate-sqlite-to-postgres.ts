import fs from 'fs';
import path from 'path';
import { getDb } from '../src/lib/db';

/**
 * Exports all existing SQLite WAL records (`./data/vacuum.db`) into a deterministic,
 * transactional PostgreSQL `INSERT ... ON CONFLICT DO NOTHING` SQL dump so that
 * migrating from local/container SQLite to Vercel Postgres / Neon / Supabase
 * never silently discards existing historical sessions, receipts, or sponsorship records.
 *
 * Usage:
 *   npx tsx scripts/migrate-sqlite-to-postgres.ts > ./data/postgres-data-export.sql
 */
function escapeSqlVal(val: unknown): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number') return Number.isFinite(val) ? String(val) : '0';
  if (typeof val === 'boolean') return val ? '1' : '0';
  const str = String(val).replace(/'/g, "''");
  return `'${str}'`;
}

function exportTable(tableName: string): string[] {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM ${tableName}`).all() as Array<Record<string, unknown>>;
  if (rows.length === 0) return [];

  const statements: string[] = [];
  for (const row of rows) {
    const cols = Object.keys(row);
    const vals = cols.map((c) => escapeSqlVal(row[c]));
    statements.push(
      `INSERT INTO ${tableName} (${cols.join(', ')}) VALUES (${vals.join(', ')}) ON CONFLICT DO NOTHING;`
    );
  }
  return statements;
}

function main() {
  const schemaPath = path.resolve(process.cwd(), 'migrations/001_up_postgres_schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');

  const tablesInOrder = [
    'users',
    'connected_wallets',
    'token_metadata_cache',
    'risk_assessments',
    'discovered_assets',
    'sweep_sessions',
    'transaction_batches',
    'sweep_items',
    'transaction_records',
    'sponsorship_records',
    'application_configuration',
    'feature_flags',
    'analytics_events',
  ];

  const outputLines: string[] = [
    '-- VACUUM SQLite-to-PostgreSQL Complete Schema & Data Migration Export',
    `-- Generated at: ${new Date().toISOString()}`,
    schemaSql,
    'BEGIN;',
  ];

  let totalRowsExported = 0;
  for (const tbl of tablesInOrder) {
    const stmts = exportTable(tbl);
    if (stmts.length > 0) {
      outputLines.push(`-- Table: ${tbl} (${stmts.length} rows)`);
      outputLines.push(...stmts);
      totalRowsExported += stmts.length;
    }
  }

  outputLines.push('COMMIT;');
  outputLines.push(`-- Total rows exported safely: ${totalRowsExported}`);

  console.log(outputLines.join('\n'));
}

main();
