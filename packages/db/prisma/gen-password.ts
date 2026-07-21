/**
 * gen-password — one-shot CLI that bcrypt-hashes a plaintext password for
 * pasting into ADMIN_PASSWORD_HASH in .env.
 *
 * Usage:
 *   pnpm --filter @vantage/db gen-password <plaintext>
 *
 * Emits the hash on stdout (no newline between hash and trailing newline so a
 * shell pipe like `| xclip` works cleanly).
 */

import bcrypt from 'bcryptjs';

async function main(): Promise<void> {
  const plaintext = process.argv[2];
  if (!plaintext || plaintext.length < 4) {
    console.error(
      'usage: pnpm --filter @vantage/db gen-password <plaintext (min 4 chars)>',
    );
    process.exit(1);
  }
  const hash = await bcrypt.hash(plaintext, 12);
  // Hash goes on stdout, meta-output on stderr.
  process.stderr.write(
    `Bcrypted with 12 rounds. Paste the following into .env as ADMIN_PASSWORD_HASH:\n`,
  );
  process.stdout.write(`${hash}\n`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
