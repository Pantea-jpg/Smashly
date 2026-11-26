// Prints a fresh Ed25519 signing key as env lines. Usage:
//   pnpm --filter @tw/api keys:generate            (print)
//   pnpm --filter @tw/api keys:generate -- --kid k2 (choose key id for rotation)
// Store the output in your secret manager (or apps/api/.env for local development only).
import { generateKeyPairSync } from 'node:crypto';

const kidIndex = process.argv.indexOf('--kid');
const kid = kidIndex > -1 ? process.argv[kidIndex + 1] : 'k1';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

process.stdout.write(`JWT_KEY_ID=${kid}\n`);
process.stdout.write(`JWT_PRIVATE_KEY=${Buffer.from(privatePem).toString('base64')}\n`);
process.stdout.write(
  `# Public key (for JWT_PREVIOUS_PUBLIC_KEY during a later rotation):\n# ${Buffer.from(publicPem).toString('base64')}\n`,
);
