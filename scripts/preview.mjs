// Explicit, local-only developer commands. Never imported by application startup.
import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const action = process.argv[2];
if (!['setup', 'seed', 'reset', 'api', 'web'].includes(action)) throw new Error('Expected setup, seed, reset, api or web');
if (process.env.NODE_ENV === 'production') throw new Error('Preview is development-only');
const url = new URL(process.env.PREVIEW_DATABASE_URL ?? `postgresql://${encodeURIComponent(userInfo().username)}@localhost:5432/zpp_connect_preview`);
if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname !== '/zpp_connect_preview' || [...url.searchParams].some(([key, value]) => key !== 'schema' || value !== 'public')) {
  throw new Error('Preview requires a loopback PostgreSQL URL, exact database zpp_connect_preview and public schema');
}
const connection = new URL(url); connection.search = '';
const maintenance = new URL(connection); maintenance.pathname = '/postgres';
const env = { ...process.env, DATABASE_URL: url.href, NODE_ENV: 'development', AUTH_MODE: 'dev', PERSISTENCE_MODE: 'postgres', APP_ORIGIN: 'http://localhost:5173', API_PORT: '4000', DEV_USER_EMAIL: 'coordinator@lot.pl', DATA_DIR: path.join(root, 'storage/local-preview'), VITE_API_URL: 'http://localhost:4000/api', VITE_DEFAULT_USER_EMAIL: 'coordinator@lot.pl' };
// No inherited PG service/options may redirect or change the intended target.
for (const key of Object.keys(env)) if (key.startsWith('PG') || /^(ENTRA_|JWT_|JWKS_)/.test(key)) delete env[key];
function run(command, args, capture = false) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
  return result.stdout?.trim();
}
const sql = (target, query) => run('psql', ['-X', '--no-password', target.href, '-v', 'ON_ERROR_STOP=1', '-Atc', query], true);
const marker = 'ZPP Connect disposable synthetic local preview';
function verify() {
  if (sql(connection, "SELECT current_database() || '|' || coalesce(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datname=current_database()") !== `zpp_connect_preview|${marker}`) throw new Error('Refusing unmarked database: use a new dedicated preview database');
}
if (action === 'web') {
  run('npm', ['run', 'dev', '-w', '@zpp/web', '--', '--host', '127.0.0.1', '--port', '5173', '--strictPort']);
} else {
  if (action === 'setup') {
    const exists = sql(maintenance, "SELECT 1 FROM pg_database WHERE datname='zpp_connect_preview'");
    if (!exists) {
      run('createdb', ['--maintenance-db', maintenance.href, 'zpp_connect_preview']);
      sql(connection, `COMMENT ON DATABASE zpp_connect_preview IS '${marker}'`);
    }
  }
  verify();
  if (action === 'api') run('npm', ['run', 'dev', '-w', '@zpp/api']);
  else {
    if (action === 'setup') {
      run('npm', ['ci']);
      run('npm', ['run', 'db:generate']);
      run('npm', ['run', 'build', '-w', '@zpp/shared']);
    }
    if (action === 'reset') {
      // Exact marked target only; no wildcard, no other database, no default URL.
      run('dropdb', ['--maintenance-db', maintenance.href, 'zpp_connect_preview']);
      run('createdb', ['--maintenance-db', maintenance.href, 'zpp_connect_preview']);
      sql(connection, `COMMENT ON DATABASE zpp_connect_preview IS '${marker}'`);
    }
    run('npm', ['run', 'prisma:deploy', '-w', '@zpp/api']);
    run('npm', ['exec', '-w', '@zpp/api', '--', 'prisma', 'validate', '--schema', 'prisma/schema.prisma']);
    run('npm', ['run', 'db:seed']);
    run('npm', ['exec', '-w', '@zpp/api', '--', 'tsx', 'prisma/preview-seed.ts']);
  }
}
