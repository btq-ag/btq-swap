import { createHash } from 'node:crypto';
import { Wallet } from 'ethers';
import { signerFromSeed, type DilithiumSigner } from '@btq-swap/htlc';

export const PERSONA_NAMES = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi', 'ivan', 'judy'] as const;
export type PersonaName = (typeof PERSONA_NAMES)[number] | string;

export interface Persona {
  name: string;
  /** Synthetic Discord snowflake (>= 9e17, never a real account). */
  discordId: string;
  evmKey: string;
  evmAddress: string;
  btqWallet: string;
  htlc: DilithiumSigner;
  /** Preimages this persona generated as a buyer, keyed by swap short id. Never leaves the persona. */
  secrets: Map<string, Uint8Array>;
  btqAddress?: string;
}

function h(label: string): Buffer {
  return createHash('sha256').update(label).digest();
}

/** Deterministic personas so repeated runs reuse the same identities and wallets. */
export function persona(name: string, runSalt = 'v1'): Persona {
  const evmKey = '0x' + h(`btq-swap-sim:evm:${runSalt}:${name}`).toString('hex');
  const idNum = 900_000_000_000_000_000n + BigInt('0x' + h(`btq-swap-sim:discord:${runSalt}:${name}`).toString('hex').slice(0, 12));
  return {
    name,
    discordId: idNum.toString(),
    evmKey,
    evmAddress: new Wallet(evmKey).address,
    btqWallet: `sim-${runSalt}-${name}`,
    htlc: signerFromSeed(new Uint8Array(h(`btq-swap-sim:htlc:${runSalt}:${name}`))),
    secrets: new Map(),
  };
}
