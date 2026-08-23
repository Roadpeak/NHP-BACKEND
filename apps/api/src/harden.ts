/**
 * Applies prisma/sql/harden.sql — the Phase 0 guarantees.
 *
 * Runs as the OWNER (superuser), because it creates roles, revokes grants
 * and defines SECURITY DEFINER functions. The application never connects
 * with these credentials.
 *
 *   pnpm harden
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(__dirname, '..', 'prisma', 'sql', 'harden.sql');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env');
  process.exit(1);
}

const sql = readFileSync(sqlPath, 'utf8');
const client = new pg.Client({ connectionString: url });

try {
  await client.connect();
  console.log('applying harden.sql ...');
  await client.query(sql);
  console.log('hardening applied.');

  // Report what actually landed, rather than assuming.
  const { rows: triggers } = await client.query(`
    SELECT c.relname AS table_name, t.tgname AS trigger_name
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
     WHERE NOT t.tgisinternal
       AND t.tgname LIKE 'trg_%'
     ORDER BY 1, 2
  `);
  console.log(`\ntriggers installed: ${triggers.length}`);
  for (const t of triggers) console.log(`  ${t.table_name.padEnd(22)} ${t.trigger_name}`);

  const { rows: revoked } = await client.query(`
    SELECT table_name,
           bool_or(privilege_type = 'UPDATE') AS has_update,
           bool_or(privilege_type = 'DELETE') AS has_delete
      FROM information_schema.table_privileges
     WHERE grantee = 'nhp_app'
       AND table_name IN ('encounter','condition','allergy','medication','access_log')
     GROUP BY table_name
     ORDER BY 1
  `);
  console.log('\nnhp_app grants on append-only tables:');
  for (const r of revoked) {
    const ok = !r.has_update && !r.has_delete ? 'OK' : 'STILL WRITABLE';
    console.log(
      `  ${r.table_name.padEnd(22)} update=${r.has_update} delete=${r.has_delete}  ${ok}`,
    );
  }

  const { rows: analyst } = await client.query(`
    SELECT count(*)::int AS n
      FROM information_schema.table_privileges
     WHERE grantee = 'nhp_analyst'
       AND table_name IN ('person','encounter','condition','allergy','medication')
  `);
  console.log(
    `\nnhp_analyst grants on clinical tables: ${analyst[0].n} ` +
      (analyst[0].n === 0 ? '(correct — must be zero)' : '(WRONG — must be zero)'),
  );
} catch (err) {
  console.error('hardening failed:', err instanceof Error ? err.message : err);
  process.exit(1);
} finally {
  await client.end();
}
