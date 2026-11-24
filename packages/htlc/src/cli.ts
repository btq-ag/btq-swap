#!/usr/bin/env node
/**
 * btq-htlc — local, non-custodial signer for BTQ Swap.
 *
 * BTQ Core wallets cannot sign HTLC claim/refund leaves, so this tool holds your
 * swap key (ML-DSA-44) and your swap secrets on your machine and produces
 * ready-to-broadcast transactions. It never sends a secret anywhere except
 * inside a claim transaction you broadcast yourself.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider, Wallet } from 'ethers';
import { bytesToHex, decodeBlob, equalBytes, hexToBytes, toBase64 } from './bytes.js';
import { decodeSegwitAddress, type BtqNetwork } from './address.js';
import { buildClaimTx, buildRefundTx, fromRecord, type HtlcRecord } from './htlc.js';
import { hashPreimage, linkChallengeMessage, newPreimage, newSeed, signerFromSeed, type DilithiumSigner } from './keys.js';
import { BtqRpc, btqToSats } from './rpc.js';
import { claimRefusal, DEFAULT_CLAIM_MARGIN_BLOCKS, DEFAULT_MIN_CONFIRMATIONS } from './guards.js';
import { computeAgreementId, erc20Contract, htlcContract, readInstance } from './evm.js';

import { createSecretFile, deploymentUrl, loadSecretFile, markSecretUsed } from './secrets.js';

export const CLI_VERSION = '1.0.0';

export interface SwapDescriptor {
  swap: { id: string; shortId: number; status: string; network: BtqNetwork; amountSats: string; amountBtq: string };
  btq: {
    htlc: HtlcRecord | null;
    lock: { txid: string; vout: number; valueSats: string; confirmations: number } | null;
    tipHeight: number;
    /** Server's BTQ_MIN_CONFIRMATIONS (absent on older servers). */
    minConfirmations?: number;
    rejectedLocks?: Array<{ txid: string; vout: number; valueSats: string; htlc: HtlcRecord; reason: string }>;
  };
  evm: {
    chainId: number;
    htlcContract: string;
    token: string;
    tokenDecimals: number;
    buyer: string;
    seller: string;
    amountUnits: string;
    lockDurationSec: number;
    otherNetwork: string;
    otherAsset: string;
    otherAmount: string;
    agreementId: string | null;
    deadline: number | null;
    secretHash: string | null;
  };
  preimage: string | null;
}

type Args = { _: string[]; flags: Record<string, string | boolean> };

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2) as [string, string | undefined];
      if (v !== undefined) out.flags[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) out.flags[k] = argv[++i]!;
      else out.flags[k] = true;
    } else out._.push(a);
  }
  return out;
}

function flag(args: Args, name: string, env?: string): string | undefined {
  const v = args.flags[name];
  if (typeof v === 'string') return v;
  return env ? process.env[env] : undefined;
}

function need(args: Args, name: string, env?: string): string {
  const v = flag(args, name, env);
  if (!v) throw new Error(`missing --${name}${env ? ` (or ${env})` : ''}`);
  return v;
}

export function homeDir(args: Args): string {
  return flag(args, 'home', 'BTQ_HTLC_HOME') ?? join(homedir(), '.btq-htlc');
}

function writePrivate(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function loadSigner(home: string): DilithiumSigner {
  const p = join(home, 'key.json');
  if (!existsSync(p)) throw new Error(`no swap key at ${p} — run: btq-htlc keygen`);
  const k = JSON.parse(readFileSync(p, 'utf8')) as { seed: string };
  return signerFromSeed(hexToBytes(k.seed));
}

/** Find the local preimage for a hash (any swap file). */
export function findSecretByHash(home: string, secretHashHex: string): Uint8Array | null {
  const dir = join(home, 'secrets');
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir)) {
    try {
      const s = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { preimage: string; secretHash: string };
      if (s.secretHash.toLowerCase() === secretHashHex.toLowerCase().replace(/^0x/, '')) return hexToBytes(s.preimage);
    } catch {
      /* ignore unreadable files */
    }
  }
  return null;
}

function apiUrl(args: Args): string {
  return deploymentUrl(flag(args, 'api', 'BTQ_SWAP_API') ?? 'http://127.0.0.1:5173/api');
}

async function fetchDescriptor(args: Args): Promise<SwapDescriptor> {
  const api = apiUrl(args);
  const swap = need(args, 'swap');
  const res = await fetch(`${api}/public/swaps/${encodeURIComponent(swap)}/htlc`);
  if (!res.ok) throw new Error(`swap ${swap}: API returned ${res.status} ${await res.text()}`);
  return (await res.json()) as SwapDescriptor;
}

function out(obj: unknown): void {
  console.log(typeof obj === 'string' ? obj : JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
}

function rpcFrom(args: Args): BtqRpc | null {
  const url = flag(args, 'rpc', 'BTQ_RPC_URL');
  if (!url) return null;
  return new BtqRpc({ url, user: flag(args, 'rpcuser', 'BTQ_RPC_USER') ?? '', pass: flag(args, 'rpcpass', 'BTQ_RPC_PASS') ?? '' });
}

function networkFlag(n: BtqNetwork): string {
  return n === 'mainnet' ? '' : `-${n === 'testnet' ? 'testnet' : n} `;
}

async function cmdClaimOrRefund(kind: 'claim' | 'refund', args: Args): Promise<void> {
  const home = homeDir(args);
  const signer = loadSigner(home);
  const d = await fetchDescriptor(args);
  const explicit = flag(args, 'outpoint');
  if (explicit && kind !== 'refund') throw new Error('--outpoint is only supported for refunds');
  const match = explicit ? /^([0-9a-fA-F]{64}):(\d+)$/.exec(explicit) : null;
  if (explicit && (!match || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) > 0xffffffff)) throw new Error('--outpoint must be txid:vout');
  const rejected = match ? d.btq.rejectedLocks?.find(o => o.txid.toLowerCase() === match[1]!.toLowerCase() && o.vout === Number(match[2])) : null;
  const record = rejected?.htlc ?? d.btq.htlc;
  if (!record || (!d.btq.lock && !match)) throw new Error(`swap ${d.swap.shortId} has no accepted BTQ lock; use --outpoint txid:vout --rpc URL for a rejected lock`);
  const htlc = fromRecord(record); // rebuilds from parameters and checks the address
  const to = need(args, 'to');
  decodeSegwitAddress(to, htlc.network);
  let outpoint = d.btq.lock ? { txid: d.btq.lock.txid, vout: d.btq.lock.vout, valueSats: BigInt(d.btq.lock.valueSats) } : null;
  if (match) {
    const node = rpcFrom(args);
    if (!node) throw new Error('an explicit refund outpoint requires --rpc to verify its script and actual value');
    const txid = match[1]!.toLowerCase(); const vout = Number(match[2]);
    const output = await node.call<{ value: number; scriptPubKey: { hex: string } } | null>('gettxout', [txid, vout, true]);
    if (!output || output.scriptPubKey.hex.toLowerCase() !== bytesToHex(htlc.scriptPubKey)) throw new Error('the explicit outpoint is missing, spent, or does not pay this HTLC');
    outpoint = { txid, vout, valueSats: btqToSats(output.value.toFixed(8)) };
  }
  if (!outpoint) throw new Error('no refundable outpoint');
  const feeRate = Number(flag(args, 'fee-rate') ?? '2');
  let signed;
  if (kind === 'claim') {
    if (!equalBytes(signer.publicKey, htlc.claimPubkey)) throw new Error('this HTLC is not claimable by your key (you are not the buyer)');
    const preimage = findSecretByHash(home, bytesToHex(htlc.secretHash));
    if (!preimage) throw new Error(`no local secret matches hash ${bytesToHex(htlc.secretHash)} — did you run "btq-htlc secret new" on this machine?`);
    const minConfirmations = Math.max(Number(flag(args, 'min-confirmations') ?? 0), d.btq.minConfirmations ?? DEFAULT_MIN_CONFIRMATIONS);
    const marginBlocks = Number(flag(args, 'claim-margin-blocks') ?? DEFAULT_CLAIM_MARGIN_BLOCKS);
    let lockConfirmations = d.btq.lock!.confirmations;
    let tipHeight = d.btq.tipHeight;
    const node = rpcFrom(args);
    if (node) {
      // Trust your own node over the server: the output must exist unspent, at the HTLC script, with the agreed value.
      const out = await node.call<{ confirmations: number; value: number; scriptPubKey: { hex: string } } | null>('gettxout', [outpoint.txid, outpoint.vout, false]);
      if (!out) throw new Error(`your node has no unspent confirmed output ${outpoint.txid}:${outpoint.vout}; do not claim`);
      if (out.scriptPubKey.hex.toLowerCase() !== bytesToHex(htlc.scriptPubKey)) throw new Error('the lock output does not pay the HTLC script; do not claim');
      if (btqToSats(out.value.toFixed(8)) !== outpoint.valueSats) throw new Error(`the lock output holds ${out.value} BTQ, not ${outpoint.valueSats} sats; do not claim`);
      lockConfirmations = out.confirmations;
      tipHeight = await node.call<number>('getblockcount');
    }
    const refusal = claimRefusal({ lockConfirmations, minConfirmations, tipHeight, refundLocktime: htlc.refundLocktime, marginBlocks });
    if (refusal) throw new Error(`refusing to claim: ${refusal}`);
    signed = buildClaimTx({ htlc, outpoint, destination: to, preimage, signer, feeRateSatVb: feeRate });
  } else {
    if (!equalBytes(signer.publicKey, htlc.refundPubkey)) throw new Error('this HTLC is not refundable by your key (you are not the seller)');
    const refundNode = rpcFrom(args);
    const tipHeight = refundNode ? await refundNode.call<number>('getblockcount') : d.btq.tipHeight;
    if (!Number.isSafeInteger(tipHeight) || tipHeight < htlc.refundLocktime) {
      throw new Error(`refund opens at BTQ height ${htlc.refundLocktime} (tip ${tipHeight}); try again later`);
    }
    signed = buildRefundTx({ htlc, outpoint, destination: to, signer, feeRateSatVb: feeRate });
  }
  const rpc = rpcFrom(args);
  if (args.flags.broadcast) {
    let txid: string;
    if (rpc) {
      txid = await rpc.call<string>('sendrawtransaction', [signed.hex]);
    } else {
      const api = (flag(args, 'api', 'BTQ_SWAP_API') ?? 'http://127.0.0.1:5173/api').replace(/\/+$/, '');
      const r = await fetch(`${api}/public/btq/tx`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hex: signed.hex }) });
      const j = (await r.json()) as { txid?: string; error?: string };
      if (!r.ok || !j.txid) throw new Error(`broadcast failed: ${j.error ?? r.status}`);
      txid = j.txid;
    }
    out({ broadcast: true, txid, feeSats: signed.feeSats, outputSats: signed.outputSats });
    return;
  }
  out({ txid: signed.txid, feeSats: signed.feeSats, outputSats: signed.outputSats, vsize: signed.vsize });
  out(`\nBroadcast with:\n  btq-cli ${networkFlag(htlc.network)}sendrawtransaction ${signed.hex}`);
}

function evmWallet(args: Args): { wallet: Wallet; provider: JsonRpcProvider } {
  const provider = new JsonRpcProvider(need(args, 'evm-rpc', 'EVM_RPC_URL'), undefined, { cacheTimeout: -1 });
  const keyArg = need(args, 'key', 'EVM_PRIVATE_KEY');
  const key = keyArg.startsWith('env:') ? process.env[keyArg.slice(4)] ?? '' : keyArg;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('EVM key must be 0x + 64 hex (use --key env:VAR to read from the environment)');
  return { wallet: new Wallet(key, provider), provider };
}

async function cmdEvm(sub: string, args: Args): Promise<void> {
  const d = await fetchDescriptor(args);
  const { wallet, provider } = evmWallet(args);
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== d.evm.chainId) throw new Error(`EVM RPC is chain ${net.chainId}, swap expects ${d.evm.chainId}`);
  const htlc = htlcContract(d.evm.htlcContract, wallet);
  if (sub === 'lock') {
    if (wallet.address.toLowerCase() !== d.evm.buyer.toLowerCase()) throw new Error(`key ${wallet.address} is not the swap buyer ${d.evm.buyer}`);
    const home = homeDir(args);
    if (d.swap.status !== 'awaiting_buyer_lock' || d.evm.agreementId) throw new Error('this swap is not awaiting a new EVM lock');
    const s = loadSecretFile(home, apiUrl(args), d.swap.id);
    const latest = await provider.getBlock('latest');
    const deadline = Number(flag(args, 'deadline') ?? (latest!.timestamp + d.evm.lockDurationSec));
    const amount = BigInt(d.evm.amountUnits);
    const token = erc20Contract(d.evm.token, wallet);
    const allowance: bigint = await token.getFunction('allowance')(wallet.address, d.evm.htlcContract);
    if (allowance < amount) await (await token.getFunction('approve')(d.evm.htlcContract, amount)).wait();
    const agreementId = computeAgreementId({ partyA: wallet.address, partyB: d.evm.seller,
      secretlock: `0x${s.secretHash}`, deadline, erc20Contract: d.evm.token, tokenAmount: amount,
      otherNetwork: d.evm.otherNetwork, otherAsset: d.evm.otherAsset, otherAmount: BigInt(d.evm.otherAmount) });
    markSecretUsed(home, s, agreementId);
    // Print recovery information before submission, including when the receipt request later fails.
    out({ lockAttempt: true, agreementId, deadline, secretHash: s.secretHash });
    const tx = await htlc.getFunction('createHTLCProposal')([
      d.evm.seller, `0x${s.secretHash}`, deadline, d.evm.token, amount, d.evm.otherNetwork, d.evm.otherAsset, BigInt(d.evm.otherAmount),
    ]);
    const r = await tx.wait();
    out({ locked: true, agreementId, txHash: r!.hash, deadline, secretHash: s.secretHash });
    return;
  }
  const agreementId = sub === 'refund' ? (flag(args, 'agreement-id') ?? d.evm.agreementId) : d.evm.agreementId;
  if (!agreementId || !/^0x[0-9a-fA-F]{64}$/.test(agreementId)) throw new Error('no accepted EVM lock; specify --agreement-id for a rejected lock');
  if (sub === 'claim') {
    const pre = flag(args, 'preimage') ?? d.preimage;
    if (!pre) throw new Error('preimage not revealed yet — wait until the buyer claims BTQ');
    const inst = await readInstance(htlc, agreementId);
    if (wallet.address.toLowerCase() !== inst.partyB.toLowerCase()) throw new Error(`key ${wallet.address} is not partyB ${inst.partyB}`);
    if (!equalBytes(hashPreimage(hexToBytes(pre)), hexToBytes(inst.secretlock))) throw new Error('preimage does not open this lock');
    const r = await (await htlc.getFunction('withdrawTokens')(agreementId, pre.startsWith('0x') ? pre : `0x${pre}`)).wait();
    out({ claimed: true, txHash: r!.hash });
    return;
  }
  if (sub === 'refund') {
    const inst = await readInstance(htlc, agreementId);
    if (!inst.exists || wallet.address.toLowerCase() !== inst.partyA.toLowerCase()) throw new Error('this agreement is not refundable by your wallet');
    const r = await (await htlc.getFunction('refundTokens')(agreementId)).wait();
    out({ refunded: true, txHash: r!.hash });
    return;
  }
  throw new Error(`unknown evm subcommand ${sub}`);
}

const HELP = `btq-htlc ${CLI_VERSION} — non-custodial BTQ Swap signer

  btq-htlc keygen                        create your swap key (~/.btq-htlc/key.json)
  btq-htlc pubkey                        print your swap public key (base64)
  btq-htlc link <challenge>              sign the /swap link-btq challenge
  btq-htlc secret new --swap <n>         create a deployment + UUID scoped secret; prints its SHA-256
  btq-htlc secret show --swap <n>
  btq-htlc claim  --swap <n> --to <btq address> [--api URL] [--broadcast [--rpc URL --rpcuser U --rpcpass P]]
  btq-htlc refund --swap <n> --to <btq address> [--outpoint txid:vout --rpc URL] [...]
  btq-htlc evm lock|claim|refund --swap <n> --evm-rpc URL --key env:VAR   (wallets without MetaMask)

  Rejected EVM lock: evm refund --swap <n> --agreement-id <0x...> --evm-rpc URL --key env:VAR

  Global: --home DIR (or BTQ_HTLC_HOME), --api URL (or BTQ_SWAP_API)`;

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const [cmd, sub] = args._;
  const home = homeDir(args);
  switch (cmd) {
    case 'keygen': {
      mkdirSync(home, { recursive: true, mode: 0o700 });
      const p = join(home, 'key.json');
      if (existsSync(p) && !args.flags.force) throw new Error(`${p} exists (use --force to replace — you would lose access to open swaps)`);
      const seed = newSeed();
      const signer = signerFromSeed(seed);
      writePrivate(p, { version: 1, seed: bytesToHex(seed), pubkey: toBase64(signer.publicKey), created: new Date().toISOString() });
      out({ keyFile: p, pubkey: toBase64(signer.publicKey) });
      return;
    }
    case 'pubkey':
      out(toBase64(loadSigner(home).publicKey));
      return;
    case 'link': {
      const challenge = sub ?? need(args, 'challenge');
      const signer = loadSigner(home);
      out({ pubkey: toBase64(signer.publicKey), signature: toBase64(signer.sign(linkChallengeMessage(challenge))) });
      return;
    }
    case 'secret': {
      const d = await fetchDescriptor(args);
      const api = apiUrl(args);
      if (sub === 'new') {
        const p = createSecretFile(home, api, d.swap.id, d.swap.shortId);
        out({ swapId: p.swapId, shortId: p.shortId, deployment: p.deployment, secretHash: p.secretHash });
        return;
      }
      if (sub === 'show') {
        out(loadSecretFile(home, api, d.swap.id));
        return;
      }
      throw new Error('usage: btq-htlc secret new|show --swap <n>');
    }
    case 'claim':
      return cmdClaimOrRefund('claim', args);
    case 'refund':
      return cmdClaimOrRefund('refund', args);
    case 'evm':
      return cmdEvm(sub ?? '', args);
    case 'decode': {
      out({ bytes: decodeBlob(need(args, 'data')).length });
      return;
    }
    case 'version':
      out(CLI_VERSION);
      return;
    default:
      out(HELP);
  }
}

const invokedDirectly = (() => {
  try {
    if (!process.argv[1]) return false;
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((e: unknown) => {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  });
}
