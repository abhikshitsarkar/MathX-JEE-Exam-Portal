// Applies every migration (and optionally the sample data) to your Neon database.
// Works on Windows, macOS and Linux — only Node.js is needed.
//
//   cd db
//   npm install
//   node apply.mjs "postgresql://neondb_owner:...@ep-....neon.tech/neondb?sslmode=require" --seed
//
// Run the Neon Auth + Data API setup FIRST (see README, step 2).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = process.argv[2];
const seed = process.argv.includes('--seed');
if (!raw || !raw.startsWith('postgres')) {
  console.error('Usage: node apply.mjs "<Neon connection string>" [--seed]');
  process.exit(1);
}

// node-postgres handles TLS itself; drop URL options it does not understand.
const url = new URL(raw);
url.searchParams.delete('channel_binding');
url.searchParams.delete('sslmode');

const local = ['localhost', '127.0.0.1'].includes(url.hostname);
const client = new pg.Client({ connectionString: url.toString(), ssl: local ? false : { rejectUnauthorized: true } });
const files = fs.readdirSync(path.join(here, 'migrations')).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => path.join(here, 'migrations', f));
if (seed) files.push(path.join(here, 'seed.sql'));

try {
  await client.connect();
  const { rows } = await client.query(
    "select to_regprocedure('auth.user_id()') is not null as auth_ok, exists (select 1 from pg_roles where rolname = 'authenticated') as role_ok, to_regclass('public.profiles') is not null as already");
  if (!rows[0].auth_ok || !rows[0].role_ok) {
    console.error('Neon Auth / Data API are not set up on this branch yet (auth.user_id() or the "authenticated" role is missing).');
    console.error('Do README step 2 first: enable Neon Auth, then enable the Data API with Neon Auth as the provider.');
    process.exit(1);
  }
  if (rows[0].already) {
    console.error('The tables already exist — the migrations have been applied before. Nothing was changed.');
    process.exit(1);
  }
  for (const file of files) {
    process.stdout.write(`applying ${path.basename(file)} ... `);
    await client.query('begin');
    try {
      await client.query(fs.readFileSync(file, 'utf8'));
      await client.query('commit');
      console.log('ok');
    } catch (e) {
      await client.query('rollback');
      console.log('FAILED');
      throw e;
    }
  }
  console.log('\nDone. Now refresh the Data API schema cache: Neon Console → Data API → Refresh schema cache.');
} catch (e) {
  console.error(`\nError: ${e.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
