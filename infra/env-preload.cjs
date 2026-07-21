/**
 * Loads the project-root `.env` into `process.env` before the PM2-managed
 * process starts. Wired via `NODE_OPTIONS="--require <abs-path>"` in
 * `ecosystem.config.cjs` because PM2 6.x `env_file` behavior is
 * inconsistent.
 *
 * Deliberately dependency-free — pnpm doesn't link `dotenv` at the project
 * root, and we don't want PM2 boot to depend on any single package being
 * hoisted. Parses the KEY=VALUE format that the rest of the stack already
 * expects. Values set upstream (by PM2's `env:` block, by the OS, or by
 * `pm2 reload --update-env`) are never overwritten.
 */

const path = require('node:path');
const fs = require('node:fs');

const envPath = path.resolve(__dirname, '..', '.env');

if (!fs.existsSync(envPath)) {
  console.error(`[env-preload] ${envPath} not found — skipping`);
  return;
}

try {
  const raw = fs.readFileSync(envPath, 'utf8');
  let loaded = 0;
  for (const line of raw.split(/\r?\n/)) {
    // Skip blanks and comments
    if (!line || /^\s*#/.test(line)) continue;
    // Tolerate optional `export ` prefix
    const stripped = line.replace(/^\s*export\s+/, '');
    const eq = stripped.indexOf('=');
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = stripped.slice(eq + 1).trim();
    // Strip matched surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Don't clobber existing env
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded += 1;
    }
  }
  if (process.env.VANTAGE_DEBUG_ENV === '1') {
    console.log(`[env-preload] loaded ${loaded} keys from ${envPath}`);
  }
} catch (err) {
  console.error(`[env-preload] failed to read ${envPath}: ${err.message}`);
}
