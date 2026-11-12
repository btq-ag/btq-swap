import { bytesToHex, concatBytes, equalBytes, hexToBytes } from './bytes.js';
import {
  buildTwoLeafTree,
  decodeSegwitAddress,
  encodeP2mrAddress,
  merkleRootFromControlBlock,
  p2mrScriptPubKey,
  type BtqNetwork,
} from './address.js';
import { hashPreimage, type DilithiumSigner } from './keys.js';
import {
  buildClaimLeaf,
  buildRefundLeaf,
  DILITHIUM2_SIG_SIZE,
  LEAF_VERSION_TAPSCRIPT,
  parseClaimLeaf,
  PREIMAGE_SIZE,
  SIGHASH_ALL,
  tapleafHash,
  type HtlcLeafParams,
} from './script.js';
import { p2mrSighash, parseTx, txHex, txid, vsize, type Transaction } from './tx.js';

export const SEQUENCE_FINAL = 0xffffffff;
/** Non-final sequence so nLockTime (and therefore CLTV) is enforced. */
export const SEQUENCE_LOCKTIME_ENABLED = 0xfffffffe;
export const DEFAULT_FEE_RATE_SAT_VB = 2;

export interface HtlcDescriptor {
  network: BtqNetwork;
  secretHash: Uint8Array;
  claimPubkey: Uint8Array;
  refundPubkey: Uint8Array;
  refundLocktime: number;
  claimLeaf: Uint8Array;
  refundLeaf: Uint8Array;
  claimControlBlock: Uint8Array;
  refundControlBlock: Uint8Array;
  merkleRoot: Uint8Array;
  scriptPubKey: Uint8Array;
  address: string;
}

export function createHtlc(network: BtqNetwork, params: HtlcLeafParams): HtlcDescriptor {
  const claimLeaf = buildClaimLeaf(params.secretHash, params.claimPubkey);
  const refundLeaf = buildRefundLeaf(params.refundLocktime, params.refundPubkey);
  const tree = buildTwoLeafTree(claimLeaf, refundLeaf);
  return {
    network,
    secretHash: params.secretHash,
    claimPubkey: params.claimPubkey,
    refundPubkey: params.refundPubkey,
    refundLocktime: params.refundLocktime,
    claimLeaf,
    refundLeaf,
    claimControlBlock: tree.controlBlocks[0],
    refundControlBlock: tree.controlBlocks[1],
    merkleRoot: tree.merkleRoot,
    scriptPubKey: p2mrScriptPubKey(tree.merkleRoot),
    address: encodeP2mrAddress(network, tree.merkleRoot),
  };
}

/** JSON tree accepted by `btq-cli getnewp2mraddress` (DFS order, both leaves at depth 1). */
export function htlcTreeJson(htlc: HtlcDescriptor): Array<{ depth: number; leaf_version: number; script: string }> {
  return [
    { depth: 1, leaf_version: LEAF_VERSION_TAPSCRIPT, script: bytesToHex(htlc.claimLeaf) },
    { depth: 1, leaf_version: LEAF_VERSION_TAPSCRIPT, script: bytesToHex(htlc.refundLeaf) },
  ];
}

/** Serializable form for storage / transport (all hex). */
export interface HtlcRecord {
  network: BtqNetwork;
  secretHashHex: string;
  claimPubkeyHex: string;
  refundPubkeyHex: string;
  refundLocktime: number;
  address: string;
  scriptPubKeyHex: string;
  claimLeafHex: string;
  refundLeafHex: string;
  claimControlBlockHex: string;
  refundControlBlockHex: string;
}

export function toRecord(h: HtlcDescriptor): HtlcRecord {
  return {
    network: h.network,
    secretHashHex: bytesToHex(h.secretHash),
    claimPubkeyHex: bytesToHex(h.claimPubkey),
    refundPubkeyHex: bytesToHex(h.refundPubkey),
    refundLocktime: h.refundLocktime,
    address: h.address,
    scriptPubKeyHex: bytesToHex(h.scriptPubKey),
    claimLeafHex: bytesToHex(h.claimLeaf),
    refundLeafHex: bytesToHex(h.refundLeaf),
    claimControlBlockHex: bytesToHex(h.claimControlBlock),
    refundControlBlockHex: bytesToHex(h.refundControlBlock),
  };
}

/** Rebuild (and re-verify) an HTLC from its parameters. Never trust stored leaves blindly. */
export function fromRecord(r: Pick<HtlcRecord, 'network' | 'secretHashHex' | 'claimPubkeyHex' | 'refundPubkeyHex' | 'refundLocktime'> & Partial<HtlcRecord>): HtlcDescriptor {
  const h = createHtlc(r.network, {
    secretHash: hexToBytes(r.secretHashHex),
    claimPubkey: hexToBytes(r.claimPubkeyHex),
    refundPubkey: hexToBytes(r.refundPubkeyHex),
    refundLocktime: r.refundLocktime,
  });
  if (r.address && r.address !== h.address) throw new Error('HTLC record address does not match its parameters');
  return h;
}

export interface HtlcOutpoint {
  txid: string;
  vout: number;
  valueSats: bigint;
}

export interface SignedSpend {
  hex: string;
  txid: string;
  vsize: number;
  feeSats: bigint;
  outputSats: bigint;
}

function placeholderWitness(kind: 'claim' | 'refund', h: HtlcDescriptor): Uint8Array[] {
  const sig = new Uint8Array(DILITHIUM2_SIG_SIZE + 1);
  return kind === 'claim'
    ? [sig, new Uint8Array(PREIMAGE_SIZE), h.claimLeaf, h.claimControlBlock]
    : [sig, h.refundLeaf, h.refundControlBlock];
}

function buildSpend(args: {
  kind: 'claim' | 'refund';
  htlc: HtlcDescriptor;
  outpoint: HtlcOutpoint;
  destination: string | Uint8Array;
  signer: DilithiumSigner;
  preimage?: Uint8Array;
  feeRateSatVb?: number;
  feeSats?: bigint;
  locktime?: number;
}): SignedSpend {
  const { kind, htlc, outpoint, signer } = args;
  const expectedPk = kind === 'claim' ? htlc.claimPubkey : htlc.refundPubkey;
  if (!equalBytes(signer.publicKey, expectedPk)) {
    throw new Error(`signer key does not match the HTLC ${kind} public key`);
  }
  if (kind === 'claim') {
    if (!args.preimage) throw new Error('preimage required to claim');
    if (!equalBytes(hashPreimage(args.preimage), htlc.secretHash)) throw new Error('preimage does not match the HTLC secret hash');
  }
  const destSpk = typeof args.destination === 'string'
    ? decodeSegwitAddress(args.destination, htlc.network).scriptPubKey
    : args.destination;

  const locktime = kind === 'refund' ? (args.locktime ?? htlc.refundLocktime) : 0;
  if (kind === 'refund' && locktime < htlc.refundLocktime) throw new Error('refund locktime is below the HTLC timelock');

  const tx: Transaction = {
    version: 2,
    inputs: [{
      txid: outpoint.txid,
      vout: outpoint.vout,
      scriptSig: new Uint8Array(0),
      sequence: kind === 'refund' ? SEQUENCE_LOCKTIME_ENABLED : SEQUENCE_FINAL,
      witness: placeholderWitness(kind, htlc),
    }],
    outputs: [{ valueSats: outpoint.valueSats, scriptPubKey: destSpk }],
    locktime,
  };
  const size = vsize(tx);
  const fee = args.feeSats ?? BigInt(Math.ceil(size * (args.feeRateSatVb ?? DEFAULT_FEE_RATE_SAT_VB)));
  const outValue = outpoint.valueSats - fee;
  if (outValue < 330n) throw new Error(`HTLC value ${outpoint.valueSats} sats is too small to cover fee ${fee}`);
  tx.outputs[0]!.valueSats = outValue;

  const leaf = kind === 'claim' ? htlc.claimLeaf : htlc.refundLeaf;
  const msg = p2mrSighash({
    tx,
    spent: [{ valueSats: outpoint.valueSats, scriptPubKey: htlc.scriptPubKey }],
    inputIndex: 0,
    tapleafHash: tapleafHash(leaf),
  });
  const sig = concatBytes(signer.sign(msg), Uint8Array.of(SIGHASH_ALL));
  tx.inputs[0]!.witness = kind === 'claim'
    ? [sig, args.preimage!, htlc.claimLeaf, htlc.claimControlBlock]
    : [sig, htlc.refundLeaf, htlc.refundControlBlock];

  return { hex: txHex(tx), txid: txid(tx), vsize: vsize(tx), feeSats: fee, outputSats: outValue };
}

export function buildClaimTx(args: {
  htlc: HtlcDescriptor;
  outpoint: HtlcOutpoint;
  destination: string | Uint8Array;
  preimage: Uint8Array;
  signer: DilithiumSigner;
  feeRateSatVb?: number;
  feeSats?: bigint;
}): SignedSpend {
  return buildSpend({ ...args, kind: 'claim' });
}

export function buildRefundTx(args: {
  htlc: HtlcDescriptor;
  outpoint: HtlcOutpoint;
  destination: string | Uint8Array;
  signer: DilithiumSigner;
  feeRateSatVb?: number;
  feeSats?: bigint;
  locktime?: number;
}): SignedSpend {
  return buildSpend({ ...args, kind: 'refund' });
}

export type HtlcSpendKind = 'claim' | 'refund' | 'unknown';

export interface HtlcSpendInfo {
  kind: HtlcSpendKind;
  inputIndex: number;
  /** Present for claim spends: the revealed 32-byte preimage (already checked against the leaf hash). */
  preimage?: Uint8Array;
}

/**
 * Inspect a transaction that spends an HTLC outpoint and classify the spend.
 * For claims, returns the preimage after verifying sha256(preimage) matches the hash committed in the leaf,
 * and that the leaf + control block commit to the expected P2MR merkle root.
 */
export function inspectHtlcSpend(rawTxHex: string, outpoint: { txid: string; vout: number }, htlc?: HtlcDescriptor): HtlcSpendInfo | null {
  const tx = parseTx(rawTxHex);
  const idx = tx.inputs.findIndex((i) => i.txid === outpoint.txid.toLowerCase() && i.vout === outpoint.vout);
  if (idx < 0) return null;
  const w = tx.inputs[idx]!.witness;
  if (w.length === 4) {
    const [, preimage, leaf, control] = w as [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
    const parsed = parseClaimLeaf(leaf);
    if (!parsed || preimage.length !== PREIMAGE_SIZE) return { kind: 'unknown', inputIndex: idx };
    if (!equalBytes(hashPreimage(preimage), parsed.secretHash)) return { kind: 'unknown', inputIndex: idx };
    if (htlc) {
      if (!equalBytes(merkleRootFromControlBlock(leaf, control), htlc.merkleRoot)) return { kind: 'unknown', inputIndex: idx };
      if (!equalBytes(parsed.secretHash, htlc.secretHash)) return { kind: 'unknown', inputIndex: idx };
    }
    return { kind: 'claim', inputIndex: idx, preimage };
  }
  if (w.length === 3) {
    const [, leaf] = w as [Uint8Array, Uint8Array, Uint8Array];
    if (htlc && !equalBytes(leaf, htlc.refundLeaf)) return { kind: 'unknown', inputIndex: idx };
    return { kind: 'refund', inputIndex: idx };
  }
  return { kind: 'unknown', inputIndex: idx };
}

/** Find the vout paying the HTLC scriptPubKey in a decoded funding transaction (raw hex). */
export function findHtlcOutputs(rawTxHex: string, htlc: HtlcDescriptor): Array<{ vout: number; valueSats: bigint }> {
  const tx = parseTx(rawTxHex);
  const out: Array<{ vout: number; valueSats: bigint }> = [];
  tx.outputs.forEach((o, vout) => {
    if (equalBytes(o.scriptPubKey, htlc.scriptPubKey)) out.push({ vout, valueSats: o.valueSats });
  });
  return out;
}
