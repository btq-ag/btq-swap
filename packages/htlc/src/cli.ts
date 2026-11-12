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
import { BtqRpc } from './rpc.js';
import { erc20Contract, htlcContract, readInstance } from './evm.js';

export const CLI_VERSION = '1.0.0';

export interface SwapDescriptor {
  swap: { id: string; shortId: number; status: string; network: BtqNetwork; amountSats: string; amountBtq: string };
  btq: {
    htlc: HtlcRecord | null;
    lock: { txid: string; vout: number; valueSats: string; confirmations: number } | null;
    tipHeight: number;
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

function secretPath(home: string, swap: string): string {
  return join(home, 'secrets', `${swap}.json`);
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

async function fetchDescriptor(args: Args): Promise<SwapDescriptor> {
  const api = (flag(args, 'api', 'BTQ_SWAP_API') ?? 'http://127.0.0.1:5173/api').replace(/\/+$/, '');
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
  if (!d.btq.htlc || !d.btq.lock) throw new Error(`swap ${d.swap.shortId} has no confirmed BTQ lock yet (status ${d.swap.status})`);
  const htlc = fromRecord(d.btq.htlc); // rebuilds from parameters and checks the address
  const to = need(args, 'to');
  decodeSegwitAddress(to, htlc.network);
  const outpoint = { txid: d.btq.lock.txid, vout: d.btq.lock.vout, valueSats: BigInt(d.btq.lock.valueSats) };
  const feeRate = Number(flag(args, 'fee-rate') ?? '2');
  let signed;
  if (kind === 'claim') {
    if (!equalBytes(signer.publicKey, htlc.claimPubkey)) throw new Error('this HTLC is not claimable by your key (you are not the buyer)');
    const preimage = findSecretByHash(home, bytesToHex(htlc.secretHash));
    if (!preimage) throw new Error(`no local secret matches hash ${bytesToHex(htlc.secretHash)} — did you run "btq-htlc secret new" on this machine?`);
    signed = buildClaimTx({ htlc, outpoint, destination: to, preimage, signer, feeRateSatVb: feeRate });
  } else {
    if (!equalBytes(signer.publicKey, htlc.refundPubkey)) throw new Error('this HTLC is not refundable by your key (you are not the seller)');
    if (d.btq.tipHeight < htlc.refundLocktime) {
      throw new Error(`refund opens at BTQ height ${htlc.refundLocktime} (tip ${d.btq.tipHeight}); try again later`);
    }
    signed = buildRefundTx({ htlc, outpoint, destination: to, signer, feeRateSatVb: feeRate });
  }
  const rpc = rpcFrom(args);
  if (args.flags.broadcast && rpc) {
    const txid = await rpc.call<string>('sendrawtransaction', [signed.hex]);
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
    const file = secretPath(home, String(d.swap.shortId));
    if (!existsSync(file)) throw new Error(`no secret for swap ${d.swap.shortId} — run: btq-htlc secret new --swap ${d.swap.shortId}`);
    const s = JSON.parse(readFileSync(file, 'utf8')) as { secretHash: string };
    const latest = await provider.getBlock('latest');
    const deadline = Number(flag(args, 'deadline') ?? (latest!.timestamp + d.evm.lockDurationSec));
    const amount = BigInt(d.evm.amountUnits);
    const token = erc20Contract(d.evm.token, wallet);
    const allowance: bigint = await token.getFunction('allowance')(wallet.address, d.evm.htlcContract);
    if (allowance < amount) await (await token.getFunction('approve')(d.evm.htlcContract, amount)).wait();
    const tx = await htlc.getFunction('createHTLCProposal')([
      d.evm.seller, `0x${s.secretHash}`, deadline, d.evm.token, amount, d.evm.otherNetwork, d.evm.otherAsset, BigInt(d.evm.otherAmount),
    ]);
    const r = await tx.wait();
    out({ locked: true, txHash: r!.hash, deadline, secretHash: s.secretHash });
    return;
  }
  if (!d.evm.agreementId) throw new Error('swap has no EVM lock yet');
  if (sub === 'claim') {
    const pre = flag(args, 'preimage') ?? d.preimage;
    if (!pre) throw new Error('preimage not revealed yet — wait until the buyer claims BTQ');
    const inst = await readInstance(htlc, d.evm.agreementId);
    if (wallet.address.toLowerCase() !== inst.partyB.toLowerCase()) throw new Error(`key ${wallet.address} is not partyB ${inst.partyB}`);
    if (!equalBytes(hashPreimage(hexToBytes(pre)), hexToBytes(inst.secretlock))) throw new Error('preimage does not open this lock');
    const r = await (await htlc.getFunction('withdrawTokens')(d.evm.agreementId, pre.startsWith('0x') ? pre : `0x${pre}`)).wait();
    out({ claimed: true, txHash: r!.hash });
    return;
  }
  if (sub === 'refund') {
    const r = await (await htlc.getFunction('refundTokens')(d.evm.agreementId)).wait();
    out({ refunded: true, txHash: r!.hash });
    return;
  }
  throw new Error(`unknown evm subcommand ${sub}`);
}

const HELP = `btq-htlc ${CLI_VERSION} — non-custodial BTQ Swap signer

  btq-htlc keygen                        create your swap key (~/.btq-htlc/key.json)
  btq-htlc pubkey                        print your swap public key (base64)
  btq-htlc link <challenge>              sign the /swap link-btq challenge
  btq-htlc secret new --swap <n>         create the swap secret (buyer); prints its SHA-256
  btq-htlc secret show --swap <n>
  btq-htlc claim  --swap <n> --to <btq address> [--api URL] [--broadcast --rpc URL --rpcuser U --rpcpass P]
  btq-htlc refund --swap <n> --to <btq address> [...]
  btq-htlc evm lock|claim|refund --swap <n> --evm-rpc URL --key env:VAR   (wallets without MetaMask)

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
      const swap = need(args, 'swap');
      mkdirSync(join(home, 'secrets'), { recursive: true, mode: 0o700 });
      const file = secretPath(home, swap);
      if (sub === 'new') {
        if (existsSync(file)) {
          const s = JSON.parse(readFileSync(file, 'utf8')) as { secretHash: string };
          out({ swap, secretHash: s.secretHash, note: 'existing secret reused' });
          return;
        }
        const p = newPreimage();
        writePrivate(file, { swap, preimage: p.preimageHex, secretHash: p.secretHashHex, created: new Date().toISOString() });
        out({ swap, secretHash: p.secretHashHex });
        return;
      }
      if (sub === 'show') {
        out(JSON.parse(readFileSync(file, 'utf8')));
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
