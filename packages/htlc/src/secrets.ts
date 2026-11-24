import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bytesToHex, hexToBytes } from './bytes.js';
import { hashPreimage, newPreimage } from './keys.js';
import { UUID_RE } from './evm.js';

export interface SecretFile {
  version: 2;
  deployment: string;
  swapId: string;
  shortId: number;
  preimage: string;
  secretHash: string;
  created: string;
}

export function deploymentUrl(api: string): string {
  const url = new URL(api);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('deployment API must be an HTTP(S) URL without credentials, query or fragment');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function scopedSecretPath(home: string, api: string, swapId: string): string {
  if (!UUID_RE.test(swapId)) throw new Error('secret storage requires the full swap UUID');
  const scope = `${deploymentUrl(api)}\n${swapId.toLowerCase()}`;
  return join(home, 'secrets', `${createHash('sha256').update(scope).digest('hex')}.json`);
}

/** Exclusive creation plus fsync prevents overwrite races and ambiguous broadcast retries. */
function writeExclusive(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  const dir = openSync(dirname(path), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

export function createSecretFile(home: string, api: string, swapId: string, shortId: number): SecretFile {
  const p = newPreimage();
  const secret: SecretFile = { version: 2, deployment: deploymentUrl(api), swapId: swapId.toLowerCase(), shortId,
    preimage: p.preimageHex, secretHash: p.secretHashHex, created: new Date().toISOString() };
  try { writeExclusive(scopedSecretPath(home, api, swapId), secret); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('a secret already exists for this deployment and swap UUID; use secret show to inspect it'); throw e; }
  return secret;
}

export function loadSecretFile(home: string, api: string, swapId: string): SecretFile {
  const s = JSON.parse(readFileSync(scopedSecretPath(home, api, swapId), 'utf8')) as SecretFile;
  if (s.version !== 2 || s.deployment !== deploymentUrl(api) || s.swapId !== swapId.toLowerCase() ||
      !/^[0-9a-f]{64}$/.test(s.preimage) || !/^[0-9a-f]{64}$/.test(s.secretHash) ||
      bytesToHex(hashPreimage(hexToBytes(s.preimage))) !== s.secretHash) throw new Error('secret file scope or hash does not match');
  return s;
}

export function markSecretUsed(home: string, secret: SecretFile, agreementId: string): void {
  try { writeExclusive(join(home, 'used-hashes', `${secret.secretHash}.json`), {
    deployment: secret.deployment, swapId: secret.swapId, agreementId, attemptedAt: new Date().toISOString(),
  }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('refusing to lock: this secret hash was already used in a lock attempt; inspect that transaction before creating a new swap'); throw e; }
}
