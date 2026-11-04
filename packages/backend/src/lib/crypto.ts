import { randomBytes, createHash } from 'node:crypto';

export function generateSecret(): Buffer {
  return randomBytes(32);
}

export function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

export function secretToHash(secret: Buffer): Buffer {
  return sha256(secret);
}

export function generateSwapId(): Buffer {
  return randomBytes(32);
}

export function bufToHex(buf: Buffer): string {
  return buf.toString('hex');
}

export function hexToBuf(hex: string): Buffer {
  return Buffer.from(hex, 'hex');
}
