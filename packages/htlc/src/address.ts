import { bech32, bech32m } from 'bech32';
import { compareBytes, concatBytes } from './bytes.js';
import { LEAF_VERSION_TAPSCRIPT, OP_0, OP_1, pushData, taggedHash, tapleafHash } from './script.js';

export type BtqNetwork = 'mainnet' | 'testnet' | 'signet' | 'regtest';

/** BTQ Core bech32 HRPs (src/kernel/chainparams.cpp). */
export const BECH32_HRP: Record<BtqNetwork, string> = {
  mainnet: 'qbtc',
  testnet: 'tbtq',
  signet: 'qtb',
  regtest: 'qcrt',
};

export const P2MR_WITNESS_VERSION = 2;
export const P2MR_PROGRAM_SIZE = 32;
/** BIP360: the low bit of the P2MR control byte must be 1. */
export const P2MR_CONTROL_BYTE = LEAF_VERSION_TAPSCRIPT | 1;

export function tapbranchHash(a: Uint8Array, b: Uint8Array): Uint8Array {
  return compareBytes(a, b) < 0
    ? taggedHash('TapBranch', concatBytes(a, b))
    : taggedHash('TapBranch', concatBytes(b, a));
}

export interface P2mrTwoLeafTree {
  leaves: [Uint8Array, Uint8Array];
  leafHashes: [Uint8Array, Uint8Array];
  merkleRoot: Uint8Array;
  /** controlBlocks[i] proves leaves[i] (control byte + sibling hash). */
  controlBlocks: [Uint8Array, Uint8Array];
}

/** Depth-1/depth-1 P2MR tree, identical to getnewp2mraddress '[{depth:1,...},{depth:1,...}]'. */
export function buildTwoLeafTree(leafA: Uint8Array, leafB: Uint8Array): P2mrTwoLeafTree {
  const hA = tapleafHash(leafA);
  const hB = tapleafHash(leafB);
  return {
    leaves: [leafA, leafB],
    leafHashes: [hA, hB],
    merkleRoot: tapbranchHash(hA, hB),
    controlBlocks: [concatBytes(Uint8Array.of(P2MR_CONTROL_BYTE), hB), concatBytes(Uint8Array.of(P2MR_CONTROL_BYTE), hA)],
  };
}

/** Recompute the P2MR merkle root from a leaf script and a control block (mirrors ComputeP2MRMerkleRoot). */
export function merkleRootFromControlBlock(leafScript: Uint8Array, controlBlock: Uint8Array): Uint8Array {
  if (controlBlock.length < 1 || (controlBlock.length - 1) % 32 !== 0) throw new Error('invalid P2MR control block size');
  if ((controlBlock[0]! & 1) !== 1) throw new Error('P2MR control block parity bit must be 1');
  let k = tapleafHash(leafScript, controlBlock[0]! & 0xfe);
  for (let i = 1; i < controlBlock.length; i += 32) {
    k = tapbranchHash(k, controlBlock.subarray(i, i + 32));
  }
  return k;
}

export function witnessScriptPubKey(version: number, program: Uint8Array): Uint8Array {
  if (version < 0 || version > 16) throw new Error('invalid witness version');
  return concatBytes(Uint8Array.of(version === 0 ? OP_0 : OP_1 + version - 1), pushData(program));
}

export function p2mrScriptPubKey(merkleRoot: Uint8Array): Uint8Array {
  if (merkleRoot.length !== P2MR_PROGRAM_SIZE) throw new Error('P2MR program must be 32 bytes');
  return witnessScriptPubKey(P2MR_WITNESS_VERSION, merkleRoot);
}

export function encodeSegwitAddress(network: BtqNetwork, version: number, program: Uint8Array): string {
  const words = [version, ...bech32.toWords(program)];
  return version === 0 ? bech32.encode(BECH32_HRP[network], words) : bech32m.encode(BECH32_HRP[network], words, 120);
}

export function encodeP2mrAddress(network: BtqNetwork, merkleRoot: Uint8Array): string {
  if (merkleRoot.length !== P2MR_PROGRAM_SIZE) throw new Error('P2MR program must be 32 bytes');
  return encodeSegwitAddress(network, P2MR_WITNESS_VERSION, merkleRoot);
}

export interface DecodedAddress {
  network: BtqNetwork;
  version: number;
  program: Uint8Array;
  scriptPubKey: Uint8Array;
}

/** Decode a BTQ segwit address (v0 bech32, v1+ bech32m) into its scriptPubKey. */
export function decodeSegwitAddress(address: string, expectedNetwork?: BtqNetwork): DecodedAddress {
  const lower = address.trim().toLowerCase();
  const sep = lower.lastIndexOf('1');
  if (sep < 1) throw new Error('not a bech32 address');
  const hrp = lower.slice(0, sep);
  const network = (Object.keys(BECH32_HRP) as BtqNetwork[]).find((n) => BECH32_HRP[n] === hrp);
  if (!network) throw new Error(`unknown BTQ address prefix "${hrp}"`);
  if (expectedNetwork && network !== expectedNetwork) {
    throw new Error(`address is for ${network}, expected ${expectedNetwork}`);
  }
  let decoded: { prefix: string; words: number[] };
  let usedBech32m = false;
  try {
    decoded = bech32m.decode(lower, 120);
    usedBech32m = true;
  } catch {
    decoded = bech32.decode(lower, 120);
  }
  const version = decoded.words[0]!;
  const program = Uint8Array.from(bech32.fromWords(decoded.words.slice(1)));
  if (version === 0 && usedBech32m) throw new Error('witness v0 address must use bech32');
  if (version !== 0 && !usedBech32m) throw new Error('witness v1+ address must use bech32m');
  if (version === 0 && program.length !== 20 && program.length !== 32) throw new Error('invalid v0 program length');
  if (version === P2MR_WITNESS_VERSION && program.length !== P2MR_PROGRAM_SIZE) throw new Error('invalid P2MR program length');
  if (program.length < 2 || program.length > 40) throw new Error('invalid witness program length');
  return { network, version, program, scriptPubKey: witnessScriptPubKey(version, program) };
}
