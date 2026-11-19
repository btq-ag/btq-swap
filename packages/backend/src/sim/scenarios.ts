import { Wallet } from 'ethers';
import { linkChallengeMessage, toBase64 } from '@btq-swap/htlc';
import { ChainOps, type Descriptor } from './chainops';
import { Driver, embedText, expectOk, findButton, swapIdsFrom, type InteractionResult } from './driver';
import { fundPersona } from './fund';
import type { Persona } from './personas';

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface SwapRecord {
  shortId: number;
  role: string;
  finalStatus: string;
  durationSec: number | null;
  evmLockTx?: string | null;
  evmClaimTx?: string | null;
  evmRefundTx?: string | null;
  btqLockTxid?: string | null;
  btqClaimTxid?: string | null;
  btqRefundTxid?: string | null;
  preimage?: string | null;
}

export interface ScenarioResult {
  name: string;
  description: string;
  ok: boolean;
  durationMs: number;
  checks: Check[];
  swaps: SwapRecord[];
  error?: string;
}

interface SwapView {
  shortId: number;
  status: string;
  durationSec: number | null;
  preimage: string | null;
  secretHash: string | null;
  evm: { lockTx: string | null; claimTx: string | null; refundTx: string | null; agreementId: string | null };
  btq: { lockTxid: string | null; claimTxid: string | null; refundTxid: string | null; htlcAddress: string | null };
}

export class SimContext {
  constructor(
    readonly driver: Driver,
    readonly ops: ChainOps,
    readonly apiUrl: string,
    readonly adminToken: string,
    readonly token: string,
    readonly log: (m: string) => void,
  ) {}

  async swap(shortId: number): Promise<{ swap: SwapView; events: Array<{ event_type: string; metadata: Record<string, unknown> }> }> {
    const res = await fetch(`${this.apiUrl}/public/swaps/${shortId}`);
    if (!res.ok) throw new Error(`swap ${shortId}: ${res.status}`);
    return (await res.json()) as never;
  }

  async waitFor(shortId: number, statuses: string[], timeoutMs = 600_000): Promise<SwapView> {
    const end = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < end) {
      const { swap } = await this.swap(shortId);
      if (swap.status !== last) {
        last = swap.status;
        this.log(`  swap #${shortId} → ${swap.status}`);
      }
      if (statuses.includes(swap.status)) return swap;
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error(`swap #${shortId}: timed out waiting for ${statuses.join('|')} (last ${last})`);
  }

  async descriptor(shortId: number): Promise<Descriptor> {
    return this.ops.descriptor(shortId);
  }

  private cookie: string | null = null;
  async admin(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!this.cookie) {
      const r = await fetch(`${this.apiUrl}/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: this.adminToken }) });
      if (!r.ok) throw new Error(`admin login failed ${r.status}`);
      this.cookie = (r.headers.get('set-cookie') ?? '').split(';')[0]!;
    }
    const r = await fetch(`${this.apiUrl}/admin${path}`, { method, headers: { 'content-type': 'application/json', cookie: this.cookie, 'x-btq-request': '1' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (!r.ok) throw new Error(`admin ${path}: ${r.status} ${JSON.stringify(j)}`);
    return j;
  }
}

export function record(v: SwapView, role: string): SwapRecord {
  return {
    shortId: v.shortId,
    role,
    finalStatus: v.status,
    durationSec: v.durationSec,
    evmLockTx: v.evm.lockTx,
    evmClaimTx: v.evm.claimTx,
    evmRefundTx: v.evm.refundTx,
    btqLockTxid: v.btq.lockTxid,
    btqClaimTxid: v.btq.claimTxid,
    btqRefundTxid: v.btq.refundTxid,
    preimage: v.preimage,
  };
}

// ───────────────────────── persona flows through Discord ─────────────────────────

const onboarded = new Set<string>();

export async function onboard(sx: SimContext, p: Persona, fund: { usdtUnits: bigint; btqSats: bigint }): Promise<void> {
  await fundPersona(p, fund);
  if (onboarded.has(p.name)) return;
  const d = sx.driver;
  const start = expectOk(await d.slash(p, 'swap', 'start'), 'start');
  if (!embedText(start).includes('You are registered')) {
    expectOk(await d.click(p, findButton(start, (l) => l.startsWith('Accept')), 'Accept terms'), 'accept');
  }
  const m1 = expectOk(await d.slash(p, 'swap', 'link-evm'), 'link-evm');
  if (!m1.modal) throw new Error('link-evm did not open a modal');
  const msgReply = expectOk(await d.submit(p, m1.modal.custom_id, { address: p.evmAddress }, 'EVM address'), 'evm address');
  const message = /```\n([\s\S]+?)\n```/.exec(embedText(msgReply))?.[1];
  if (!message) throw new Error('SIWE message not found in reply');
  const sig = await new Wallet(p.evmKey).signMessage(message);
  const m2 = expectOk(await d.click(p, findButton(msgReply, (l) => l === 'Paste signature'), 'Paste signature'), 'paste sig');
  expectOk(await d.submit(p, m2.modal!.custom_id, { signature: sig }, 'signature'), 'evm signature');

  const btqReply = expectOk(await d.slash(p, 'swap', 'link-btq'), 'link-btq');
  const challenge = /btq-htlc\.mjs link (\S+)/.exec(embedText(btqReply))?.[1];
  if (!challenge) throw new Error('challenge not found');
  const m3 = expectOk(await d.click(p, findButton(btqReply, (l) => l === 'Submit key'), 'Submit key'), 'submit key');
  expectOk(
    await d.submit(p, m3.modal!.custom_id, {
      pubkey: toBase64(p.htlc.publicKey),
      signature: toBase64(p.htlc.sign(linkChallengeMessage(challenge))),
      address: p.btqAddress!,
    }, 'BTQ key'),
    'btq key',
  );
  const prof = expectOk(await d.slash(p, 'swap', 'profile'), 'profile');
  if ((embedText(prof).match(/✅/g) ?? []).length < 3) throw new Error(`profile not fully linked: ${embedText(prof)}`);
  onboarded.add(p.name);
}

export async function placeViaDiscord(sx: SimContext, p: Persona, side: 'buy' | 'sell', amount: string, price = 'market'): Promise<{ result: InteractionResult; swapIds: number[]; orderId: number | null }> {
  const form = expectOk(await sx.driver.slash(p, 'swap', side), side);
  if (!form.modal) throw new Error(`${side} did not open a modal`);
  const result = expectOk(await sx.driver.submit(p, form.modal.custom_id, { amount, price }, `${side} ${amount} @ ${price}`), `${side} submit`);
  const orderId = Number(/Order #(\d+)/.exec(embedText(result))?.[1] ?? NaN);
  return { result, swapIds: swapIdsFrom(result), orderId: Number.isFinite(orderId) ? orderId : null };
}

export async function takeViaDiscord(sx: SimContext, p: Persona, orderId: number, amount: string): Promise<number[]> {
  const form = expectOk(await sx.driver.slash(p, 'swap', 'take', { order: orderId }), 'take');
  const r = expectOk(await sx.driver.submit(p, form.modal!.custom_id, { amount }, `take #${orderId} ${amount}`), 'take submit');
  return swapIdsFrom(r);
}

/** Buyer path: lock USDT, wait for the seller's BTQ, claim it. */
export async function buyerCompletes(sx: SimContext, p: Persona, id: number, opts: { claim?: boolean } = {}): Promise<SwapView> {
  expectOk(await sx.driver.slash(p, 'swap', 'fund', { id }), 'fund (buyer)');
  const lockTx = await sx.ops.evmLock(p, await sx.descriptor(id));
  sx.log(`  ${p.name} locked USDT for #${id}: ${lockTx}`);
  const st = await sx.waitFor(id, ['awaiting_buyer_claim', 'awaiting_buyer_refund', 'refunded', 'expired']);
  if (st.status !== 'awaiting_buyer_claim' || opts.claim === false) return st;
  expectOk(await sx.driver.slash(p, 'swap', 'claim', { id }), 'claim (buyer)');
  const claimTxid = await sx.ops.btqClaim(p, await sx.descriptor(id));
  sx.log(`  ${p.name} claimed BTQ for #${id}: ${claimTxid}`);
  return sx.waitFor(id, ['awaiting_seller_claim', 'completed']);
}

/** Seller path: lock BTQ once the buyer's USDT is confirmed, then collect USDT with the revealed secret. */
export async function sellerCompletes(sx: SimContext, p: Persona, id: number, opts: { lock?: boolean; hint?: boolean } = {}): Promise<SwapView> {
  const st = await sx.waitFor(id, ['awaiting_seller_lock', 'expired', 'awaiting_buyer_refund']);
  if (st.status !== 'awaiting_seller_lock' || opts.lock === false) return st;
  const fund = expectOk(await sx.driver.slash(p, 'swap', 'fund', { id }), 'fund (seller)');
  const txid = await sx.ops.btqLock(p, await sx.descriptor(id));
  sx.log(`  ${p.name} locked BTQ for #${id}: ${txid}`);
  if (opts.hint) {
    const m = expectOk(await sx.driver.click(p, findButton(fund, (l) => l === 'I sent the BTQ'), 'I sent the BTQ'), 'hint button');
    expectOk(await sx.driver.submit(p, m.modal!.custom_id, { txid }, 'lock txid'), 'hint submit');
  }
  const st2 = await sx.waitFor(id, ['awaiting_seller_claim', 'completed', 'awaiting_refunds', 'refunded']);
  if (st2.status !== 'awaiting_seller_claim') return st2;
  expectOk(await sx.driver.slash(p, 'swap', 'claim', { id }), 'claim (seller)');
  const claim = await sx.ops.evmClaim(p, await sx.descriptor(id));
  sx.log(`  ${p.name} withdrew USDT for #${id}: ${claim}`);
  return sx.waitFor(id, ['completed']);
}
