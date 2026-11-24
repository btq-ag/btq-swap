import { sha256 } from '@noble/hashes/sha2.js';
import {
  bytesToHex,
  compactSize,
  concatBytes,
  hexToBytes,
  reverseBytes,
  writeI32LE,
  writeI64LE,
  writeU32LE,
} from './bytes.js';
import { taggedHash } from './script.js';

export interface TxInput {
  /** Display-order (RPC) txid of the output being spent. */
  txid: string;
  vout: number;
  scriptSig: Uint8Array;
  sequence: number;
  witness: Uint8Array[];
}

export interface TxOutput {
  valueSats: bigint;
  scriptPubKey: Uint8Array;
}

export interface Transaction {
  version: number;
  inputs: TxInput[];
  outputs: TxOutput[];
  locktime: number;
}

export interface SpentOutput {
  valueSats: bigint;
  scriptPubKey: Uint8Array;
}

export function encodeVector(data: Uint8Array): Uint8Array {
  return concatBytes(compactSize(data.length), data);
}

function outpointBytes(input: Pick<TxInput, 'txid' | 'vout'>): Uint8Array {
  const raw = hexToBytes(input.txid);
  if (raw.length !== 32) throw new Error('txid must be 32 bytes');
  return concatBytes(reverseBytes(raw), writeU32LE(input.vout));
}

export function serializeTxOut(o: TxOutput): Uint8Array {
  return concatBytes(writeI64LE(o.valueSats), encodeVector(o.scriptPubKey));
}

export function serializeTx(tx: Transaction, includeWitness = true): Uint8Array {
  const witness = includeWitness && tx.inputs.some((i) => i.witness.length > 0);
  const parts: Uint8Array[] = [writeI32LE(tx.version)];
  if (witness) parts.push(Uint8Array.of(0x00, 0x01));
  parts.push(compactSize(tx.inputs.length));
  for (const i of tx.inputs) parts.push(outpointBytes(i), encodeVector(i.scriptSig), writeU32LE(i.sequence));
  parts.push(compactSize(tx.outputs.length));
  for (const o of tx.outputs) parts.push(serializeTxOut(o));
  if (witness) {
    for (const i of tx.inputs) {
      parts.push(compactSize(i.witness.length));
      for (const item of i.witness) parts.push(encodeVector(item));
    }
  }
  parts.push(writeU32LE(tx.locktime));
  return concatBytes(...parts);
}

export function txHex(tx: Transaction): string {
  return bytesToHex(serializeTx(tx, true));
}

export function txid(tx: Transaction): string {
  return bytesToHex(reverseBytes(sha256(sha256(serializeTx(tx, false)))));
}

/**
 * BTQ restores the witness discount with WITNESS_SCALE_FACTOR = 16
 * (src/consensus/consensus.h), so Dilithium witnesses stay cheap.
 */
export const WITNESS_SCALE_FACTOR = 16;

/** Virtual size of a fully-signed transaction, BTQ weight rules (weight = base*(16-1) + total). */
export function vsize(tx: Transaction): number {
  const base = serializeTx(tx, false).length;
  const total = serializeTx(tx, true).length;
  const weight = base * (WITNESS_SCALE_FACTOR - 1) + total;
  return Math.ceil(weight / WITNESS_SCALE_FACTOR);
}

/**
 * BIP341 SignatureHash with the BIP342 tapscript extension, SigVersion::P2MR_TAPSCRIPT
 * (BTQ Core src/script/interpreter.cpp SignatureHashSchnorr). SIGHASH_ALL only, no annex.
 */
export function p2mrSighash(args: {
  tx: Transaction;
  spent: SpentOutput[];
  inputIndex: number;
  tapleafHash: Uint8Array;
  hashType?: number;
}): Uint8Array {
  const hashType = args.hashType ?? 0x01;
  if (hashType !== 0x01) throw new Error('only SIGHASH_ALL is supported');
  const { tx, spent } = args;
  if (spent.length !== tx.inputs.length) throw new Error('spent outputs must match inputs');
  if (args.inputIndex < 0 || args.inputIndex >= tx.inputs.length) throw new Error('input index out of range');
  if (args.tapleafHash.length !== 32) throw new Error('tapleaf hash must be 32 bytes');

  const shaPrevouts = sha256(concatBytes(...tx.inputs.map(outpointBytes)));
  const shaAmounts = sha256(concatBytes(...spent.map((s) => writeI64LE(s.valueSats))));
  const shaScriptPubKeys = sha256(concatBytes(...spent.map((s) => encodeVector(s.scriptPubKey))));
  const shaSequences = sha256(concatBytes(...tx.inputs.map((i) => writeU32LE(i.sequence))));
  const shaOutputs = sha256(concatBytes(...tx.outputs.map(serializeTxOut)));
  const extFlag = 1;
  const spendType = extFlag << 1; // no annex

  return taggedHash(
    'TapSighash',
    concatBytes(
      Uint8Array.of(0x00), // epoch
      Uint8Array.of(hashType),
      writeI32LE(tx.version),
      writeU32LE(tx.locktime),
      shaPrevouts,
      shaAmounts,
      shaScriptPubKeys,
      shaSequences,
      shaOutputs,
      Uint8Array.of(spendType),
      writeU32LE(args.inputIndex),
      args.tapleafHash,
      Uint8Array.of(0x00), // key_version
      writeU32LE(0xffffffff), // codesep_pos
    ),
  );
}

/** Minimal parser for a raw (witness-serialized) transaction. */
export function parseTx(hex: string): Transaction {
  const b = hexToBytes(hex);
  let at = 0;
  const take = (n: number): Uint8Array => {
    if (at + n > b.length) throw new Error('truncated transaction');
    const out = b.subarray(at, at + n);
    at += n;
    return out;
  };
  const u32 = (): number => new DataView(take(4).slice().buffer).getUint32(0, true);
  const i32 = (): number => new DataView(take(4).slice().buffer).getInt32(0, true);
  const i64 = (): bigint => new DataView(take(8).slice().buffer).getBigInt64(0, true);
  const cs = (): number => {
    const h = take(1)[0]!;
    if (h < 0xfd) return h;
    if (h === 0xfd) return new DataView(take(2).slice().buffer).getUint16(0, true);
    if (h === 0xfe) return u32();
    throw new Error('compactSize too large');
  };
  const version = i32();
  let segwit = false;
  if (b[at] === 0x00 && b[at + 1] === 0x01) {
    segwit = true;
    at += 2;
  }
  const nIn = cs();
  const inputs: TxInput[] = [];
  for (let k = 0; k < nIn; k++) {
    const prev = reverseBytes(take(32));
    const vout = u32();
    const scriptSig = take(cs()).slice();
    const sequence = u32();
    inputs.push({ txid: bytesToHex(prev), vout, scriptSig, sequence, witness: [] });
  }
  const nOut = cs();
  const outputs: TxOutput[] = [];
  for (let k = 0; k < nOut; k++) {
    const valueSats = i64();
    outputs.push({ valueSats, scriptPubKey: take(cs()).slice() });
  }
  if (segwit) {
    for (const input of inputs) {
      const items = cs();
      for (let k = 0; k < items; k++) input.witness.push(take(cs()).slice());
    }
  }
  const locktime = u32();
  if (at !== b.length) throw new Error('trailing bytes after transaction');
  return { version, inputs, outputs, locktime };
}
