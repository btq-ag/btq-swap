/**
 * The persona's own chain actions — exactly what a user does with btq-htlc + btq-cli + their EVM wallet.
 * Reads the public CLI descriptor from the API like the real CLI does.
 */
import { Contract, JsonRpcProvider, NonceManager, Wallet } from 'ethers';
import {
  ERC20_ABI,
  HTLC_ERC20_ABI,
  buildClaimTx,
  buildRefundTx,
  bytesToHex,
  fromRecord,
  hexToBytes,
  newPreimage,
  satsToBtq,
  sha256Bytes,
} from '@btq-swap/htlc';
import { btqChain } from '../chains/btq';
import type { Persona } from './personas';

export interface Descriptor {
  swap: { id: string; shortId: number; status: string; network: string; amountSats: string; amountBtq: string };
  btq: { htlc: Parameters<typeof fromRecord>[0] | null; lock: { txid: string; vout: number; valueSats: string; confirmations: number } | null; tipHeight: number };
  evm: {
    chainId: number; htlcContract: string; token: string; buyer: string; seller: string; amountUnits: string; lockDurationSec: number;
    otherNetwork: string; otherAsset: string; otherAmount: string; agreementId: string | null; deadline: number | null; secretHash: string | null;
  };
  preimage: string | null;
}

export class ChainOps {
  readonly provider: JsonRpcProvider;
  private signers = new Map<string, NonceManager>();

  constructor(private readonly apiUrl: string, evmRpcUrl: string, chainId: number) {
    this.provider = new JsonRpcProvider(evmRpcUrl, chainId, { staticNetwork: true, cacheTimeout: -1 });
  }

  signer(p: Persona): NonceManager {
    let s = this.signers.get(p.name);
    if (!s) {
      s = new NonceManager(new Wallet(p.evmKey, this.provider));
      this.signers.set(p.name, s);
    }
    return s;
  }

  async descriptor(shortId: number | string): Promise<Descriptor> {
    const res = await fetch(`${this.apiUrl}/public/swaps/${shortId}/htlc`);
    if (!res.ok) throw new Error(`descriptor ${shortId}: ${res.status}`);
    return (await res.json()) as Descriptor;
  }

  /** Buyer: create the secret locally (like `btq-htlc secret new`). Only the hash is ever shared. */
  newSecret(p: Persona, shortId: number | string): string {
    const key = String(shortId);
    if (!p.secrets.has(key)) p.secrets.set(key, newPreimage().preimage);
    return bytesToHex(sha256Bytes(p.secrets.get(key)!));
  }

  private async send<T>(p: Persona, fn: (s: NonceManager) => Promise<{ wait: (n?: number) => Promise<{ hash: string; status: number | null } | null> }>): Promise<string> {
    const s = this.signer(p);
    try {
      const tx = await fn(s);
      const r = await tx.wait(1);
      if (!r || r.status !== 1) throw new Error('transaction reverted');
      return r.hash;
    } catch (err) {
      s.reset();
      throw err;
    }
  }

  /** Buyer: approve + createHTLCProposal with the swap binding (like `btq-htlc evm lock`). */
  async evmLock(p: Persona, d: Descriptor, overrides: { amountUnits?: bigint; deadline?: number } = {}): Promise<string> {
    const secretHash = this.newSecret(p, d.swap.shortId);
    const latest = await this.provider.getBlock('latest');
    const deadline = overrides.deadline ?? latest!.timestamp + d.evm.lockDurationSec;
    const amount = overrides.amountUnits ?? BigInt(d.evm.amountUnits);
    const token = new Contract(d.evm.token, ERC20_ABI, this.signer(p));
    await this.send(p, () => token.getFunction('approve')(d.evm.htlcContract, amount));
    const htlc = new Contract(d.evm.htlcContract, HTLC_ERC20_ABI, this.signer(p));
    return this.send(p, () =>
      htlc.getFunction('createHTLCProposal')([d.evm.seller, `0x${secretHash}`, deadline, d.evm.token, amount, d.evm.otherNetwork, d.evm.otherAsset, BigInt(d.evm.otherAmount)]),
    );
  }

  /** Seller: withdraw USDT with the preimage revealed on the BTQ chain (like `btq-htlc evm claim`). */
  async evmClaim(p: Persona, d: Descriptor): Promise<string> {
    if (!d.preimage || !d.evm.agreementId) throw new Error('nothing to claim yet');
    const htlc = new Contract(d.evm.htlcContract, HTLC_ERC20_ABI, this.signer(p));
    return this.send(p, () => htlc.getFunction('withdrawTokens')(d.evm.agreementId, `0x${d.preimage}`));
  }

  /** Buyer: refund USDT after the deadline (like `btq-htlc evm refund`). */
  async evmRefund(p: Persona, d: Descriptor): Promise<string> {
    if (!d.evm.agreementId) throw new Error('no EVM lock');
    const htlc = new Contract(d.evm.htlcContract, HTLC_ERC20_ABI, this.signer(p));
    return this.send(p, () => htlc.getFunction('refundTokens')(d.evm.agreementId));
  }

  /** Seller: send BTQ to the HTLC address from the persona's own node wallet (like `btq-cli sendtoaddress`). */
  async btqLock(p: Persona, d: Descriptor, sats?: bigint): Promise<string> {
    if (!d.btq.htlc) throw new Error('HTLC not ready');
    const htlc = fromRecord(d.btq.htlc);
    const w = btqChain().wallet(p.btqWallet);
    return w.call<string>('sendtoaddress', [htlc.address, satsToBtq(sats ?? BigInt(d.swap.amountSats)), `swap ${d.swap.shortId}`]);
  }

  /** Buyer: claim BTQ with the local secret (like `btq-htlc claim` + `btq-cli sendrawtransaction`). */
  async btqClaim(p: Persona, d: Descriptor): Promise<string> {
    if (!d.btq.htlc || !d.btq.lock) throw new Error('no BTQ lock to claim');
    const htlc = fromRecord(d.btq.htlc);
    const preimage = p.secrets.get(String(d.swap.shortId));
    if (!preimage) throw new Error(`persona ${p.name} has no secret for swap ${d.swap.shortId}`);
    const to = await btqChain().wallet(p.btqWallet).call<string>('getnewaddress', ['swap-claim']);
    const signed = buildClaimTx({ htlc, outpoint: { txid: d.btq.lock.txid, vout: d.btq.lock.vout, valueSats: BigInt(d.btq.lock.valueSats) }, destination: to, preimage, signer: p.htlc, feeRateSatVb: 2 });
    return btqChain().broadcast(signed.hex);
  }

  /** Seller: refund BTQ after the CLTV height (like `btq-htlc refund`). */
  async btqRefund(p: Persona, d: Descriptor): Promise<string> {
    if (!d.btq.htlc || !d.btq.lock) throw new Error('no BTQ lock to refund');
    const htlc = fromRecord(d.btq.htlc);
    const to = await btqChain().wallet(p.btqWallet).call<string>('getnewaddress', ['swap-refund']);
    const signed = buildRefundTx({ htlc, outpoint: { txid: d.btq.lock.txid, vout: d.btq.lock.vout, valueSats: BigInt(d.btq.lock.valueSats) }, destination: to, signer: p.htlc, feeRateSatVb: 2 });
    return btqChain().broadcast(signed.hex);
  }

  async usdtBalance(p: Persona, token: string): Promise<bigint> {
    return BigInt(await new Contract(token, ERC20_ABI, this.provider).getFunction('balanceOf')(p.evmAddress));
  }

  async btqBalanceSats(p: Persona): Promise<bigint> {
    const b = await btqChain().wallet(p.btqWallet).call<{ mine: { trusted: number; untrusted_pending: number } }>('getbalances');
    return BigInt(Math.round((b.mine.trusted + b.mine.untrusted_pending) * 1e8));
  }

  /** Cheap helper for "secret matches hash" assertions in scenarios. */
  static hashOf(preimageHex: string): string {
    return bytesToHex(sha256Bytes(hexToBytes(preimageHex)));
  }
}
