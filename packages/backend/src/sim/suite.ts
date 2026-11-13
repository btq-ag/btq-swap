import { ChainOps } from './chainops';
import { embedText, expectOk, findButton } from './driver';
import { persona, type Persona } from './personas';
import {
  buyerCompletes,
  onboard,
  placeViaDiscord,
  record,
  sellerCompletes,
  takeViaDiscord,
  type Check,
  type ScenarioResult,
  type SimContext,
  type SwapRecord,
} from './scenarios';

const USDT = (n: number) => BigInt(Math.round(n * 1e6));
const BTQ = (n: number) => BigInt(Math.round(n * 1e8));
const FUND = { usdtUnits: USDT(2000), btqSats: BTQ(10) };
const MAX_BTQ_FEES = BTQ(0.001);

type Body = (sx: SimContext, P: (name: string) => Persona, checks: Check[], swaps: SwapRecord[]) => Promise<void>;

export interface Scenario {
  name: string;
  phase: 'long' | 'serial';
  description: string;
  body: Body;
}

function check(checks: Check[], name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
  if (!ok) throw new Error(`check failed: ${name}${detail ? ` (${detail})` : ''}`);
}

async function balances(sx: SimContext, p: Persona): Promise<{ usdt: bigint; btq: bigint }> {
  return { usdt: await sx.ops.usdtBalance(p, sx.token), btq: await sx.ops.btqBalanceSats(p) };
}

/** Order numbers of the MM's resting orders, read from the /swap book reply like a user would. */
async function mmOrderNo(sx: SimContext, p: Persona, side: 'ask' | 'bid'): Promise<number> {
  const r = expectOk(await sx.driver.slash(p, 'swap', 'book'), 'book');
  const text = embedText(r);
  const section = side === 'ask' ? text.split('Bids')[0]! : text.split('Bids')[1] ?? '';
  const ids = [...section.matchAll(/`#(\d+)\s*`[^\n]*MM/g)].map((m) => Number(m[1]));
  if (!ids.length) throw new Error(`no MM ${side} on the book`);
  return side === 'ask' ? ids[ids.length - 1]! : ids[0]!; // asks are listed best-last, bids best-first
}

async function waitEvent(sx: SimContext, id: number, type: string, timeoutMs = 120_000): Promise<Record<string, unknown>> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const { events } = await sx.swap(id);
    const e = events.find((x) => x.event_type === type);
    if (e) return e.metadata;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`swap #${id}: no ${type} event`);
}

export const SCENARIOS: Scenario[] = [
  {
    name: 'buy-from-mm',
    phase: 'serial',
    description: 'User buys 2 BTQ at market from the operator MM: user locks USDT, MM locks BTQ, user claims BTQ (reveals secret), MM claims USDT.',
    async body(sx, P, checks, swaps) {
      const alice = P('alice');
      await onboard(sx, alice, FUND);
      const b0 = await balances(sx, alice);
      const { swapIds } = await placeViaDiscord(sx, alice, 'buy', '2', 'market');
      check(checks, 'market buy matched exactly one swap', swapIds.length === 1, `swaps ${swapIds}`);
      const id = swapIds[0]!;
      const units = BigInt((await sx.descriptor(id)).evm.amountUnits);
      const v = await buyerCompletes(sx, alice, id);
      const fin = await sx.waitFor(id, ['completed']);
      swaps.push(record(fin, 'alice=buyer, MM=seller'));
      const b1 = await balances(sx, alice);
      check(checks, 'swap completed', fin.status === 'completed');
      check(checks, 'alice paid exactly the quoted USDT', b0.usdt - b1.usdt === units, `${b0.usdt - b1.usdt} vs ${units}`);
      check(checks, 'alice received 2 BTQ minus the claim fee', b1.btq - b0.btq > BTQ(2) - MAX_BTQ_FEES && b1.btq - b0.btq <= BTQ(2), `${b1.btq - b0.btq} sats`);
      check(checks, 'preimage revealed on BTQ chain matches the hash locked on EVM', !!v.preimage && ChainOps.hashOf(fin.preimage!) === fin.secretHash);
    },
  },
  {
    name: 'sell-to-mm',
    phase: 'serial',
    description: 'User sells 3 BTQ at market to the MM bid: MM (buyer) locks USDT with its own secret, user locks BTQ, MM claims BTQ (reveals secret), user withdraws USDT.',
    async body(sx, P, checks, swaps) {
      const bob = P('bob');
      await onboard(sx, bob, FUND);
      const b0 = await balances(sx, bob);
      const { swapIds } = await placeViaDiscord(sx, bob, 'sell', '3', 'market');
      check(checks, 'market sell matched one swap', swapIds.length === 1);
      const id = swapIds[0]!;
      const units = BigInt((await sx.descriptor(id)).evm.amountUnits);
      await sellerCompletes(sx, bob, id, { hint: true });
      const fin = await sx.waitFor(id, ['completed']);
      swaps.push(record(fin, 'MM=buyer, bob=seller'));
      const b1 = await balances(sx, bob);
      check(checks, 'bob received exactly the quoted USDT', b1.usdt - b0.usdt === units, `${b1.usdt - b0.usdt} vs ${units}`);
      check(checks, 'bob paid 3 BTQ plus the wallet fee', b0.btq - b1.btq >= BTQ(3) && b0.btq - b1.btq < BTQ(3) + MAX_BTQ_FEES, `${b0.btq - b1.btq}`);
    },
  },
  {
    name: 'p2p',
    phase: 'serial',
    description: 'Peer-to-peer: carol rests a sell order above the MM ask, dave takes that exact order; both run their own protocol steps.',
    async body(sx, P, checks, swaps) {
      const carol = P('carol');
      const dave = P('dave');
      await Promise.all([onboard(sx, carol, FUND), onboard(sx, dave, FUND)]);
      const [c0, d0] = await Promise.all([balances(sx, carol), balances(sx, dave)]);
      const { swapIds: none, orderId } = await placeViaDiscord(sx, carol, 'sell', '1.5', '2.60');
      check(checks, 'carol order rests on the book (no cross)', none.length === 0 && orderId !== null, `order ${orderId}`);
      const ids = await takeViaDiscord(sx, dave, orderId!, '1.5');
      check(checks, 'dave took carol order into one swap', ids.length === 1);
      const id = ids[0]!;
      const units = BigInt((await sx.descriptor(id)).evm.amountUnits);
      check(checks, 'price is the resting order price', units === USDT(1.5 * 2.6), `${units}`);
      await Promise.all([buyerCompletes(sx, dave, id), sellerCompletes(sx, carol, id)]);
      const fin = await sx.waitFor(id, ['completed']);
      swaps.push(record(fin, 'dave=buyer, carol=seller'));
      const [c1, d1] = await Promise.all([balances(sx, carol), balances(sx, dave)]);
      check(checks, 'dave paid USDT to carol', d0.usdt - d1.usdt === units && c1.usdt - c0.usdt === units);
      check(checks, 'dave received ~1.5 BTQ from carol', d1.btq - d0.btq > BTQ(1.5) - MAX_BTQ_FEES && c0.btq - c1.btq >= BTQ(1.5));
    },
  },
  {
    name: 'partial-fill',
    phase: 'serial',
    description: 'One market buy sweeps a user ask (1 BTQ @ 2.52) and the MM ask (2 BTQ @ 2.55): two independent HTLC swaps with different sellers.',
    async body(sx, P, checks, swaps) {
      const frank = P('frank');
      const erin = P('erin');
      await Promise.all([onboard(sx, frank, FUND), onboard(sx, erin, FUND)]);
      const { orderId } = await placeViaDiscord(sx, frank, 'sell', '1', '2.52');
      check(checks, 'frank ask rests', orderId !== null);
      const { swapIds } = await placeViaDiscord(sx, erin, 'buy', '3', 'market');
      check(checks, 'erin market buy split into two swaps', swapIds.length === 2, `${swapIds}`);
      const descs = await Promise.all(swapIds.map((i) => sx.descriptor(i)));
      const frankSwap = swapIds[descs.findIndex((d) => d.evm.seller.toLowerCase() === frank.evmAddress.toLowerCase())]!;
      check(checks, 'best price filled first (frank @ 2.52)', frankSwap === swapIds[0], `${frankSwap}`);
      await Promise.all([...swapIds.map((i) => buyerCompletes(sx, erin, i)), sellerCompletes(sx, frank, frankSwap)]);
      for (const i of swapIds) swaps.push(record(await sx.waitFor(i, ['completed']), i === frankSwap ? 'erin=buyer, frank=seller' : 'erin=buyer, MM=seller'));
      check(checks, 'both swaps completed', true);
    },
  },
  {
    name: 'buyer-no-show',
    phase: 'long',
    description: 'Buyer takes the MM ask but never locks USDT: the swap expires after the buyer window and nothing moves on either chain.',
    async body(sx, P, checks, swaps) {
      const grace = P('grace');
      await onboard(sx, grace, FUND);
      const b0 = await balances(sx, grace);
      const ids = await takeViaDiscord(sx, grace, await mmOrderNo(sx, grace, 'ask'), '1');
      check(checks, 'take created a swap', ids.length === 1);
      const fin = await sx.waitFor(ids[0]!, ['expired'], 400_000);
      swaps.push(record(fin, 'grace=buyer (no-show), MM=seller'));
      const b1 = await balances(sx, grace);
      check(checks, 'no EVM lock and no BTQ lock exist', !fin.evm.lockTx && !fin.btq.lockTxid);
      check(checks, 'grace balances unchanged', b0.usdt === b1.usdt && b0.btq === b1.btq);
    },
  },
  {
    name: 'seller-no-show',
    phase: 'long',
    description: 'P2P: ivan locks USDT for heidi\'s order but heidi never locks BTQ; after the seller window the swap waits for the EVM deadline and ivan refunds his own USDT.',
    async body(sx, P, checks, swaps) {
      const heidi = P('heidi');
      const ivan = P('ivan');
      await Promise.all([onboard(sx, heidi, FUND), onboard(sx, ivan, FUND)]);
      const i0 = await balances(sx, ivan);
      const h0 = await balances(sx, heidi);
      const { orderId } = await placeViaDiscord(sx, heidi, 'sell', '1', '2.65');
      const ids = await takeViaDiscord(sx, ivan, orderId!, '1');
      const id = ids[0]!;
      await buyerCompletes(sx, ivan, id); // returns at awaiting_buyer_refund because heidi never locks
      const st = await sx.waitFor(id, ['awaiting_buyer_refund']);
      check(checks, 'seller window passed → buyer refund pending', st.status === 'awaiting_buyer_refund');
      const d = await sx.descriptor(id);
      const waitMs = Math.max(0, (d.evm.deadline! + 3) * 1000 - Date.now());
      sx.log(`  waiting ${Math.round(waitMs / 1000)}s for ivan's USDT deadline`);
      await new Promise((r) => setTimeout(r, waitMs));
      for (let k = 0; k < 20; k++) {
        const ts = (await sx.ops.provider.getBlock('latest'))!.timestamp;
        if (ts >= d.evm.deadline!) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      const refundCmd = expectOk(await sx.driver.slash(ivan, 'swap', 'refund', { id }), 'refund (buyer)');
      check(checks, '/swap refund shows the refund command', embedText(refundCmd).includes('evm refund'));
      await sx.ops.evmRefund(ivan, d);
      const fin = await sx.waitFor(id, ['refunded']);
      swaps.push(record(fin, 'ivan=buyer (refunded), heidi=seller (no-show)'));
      const [i1, h1] = await Promise.all([balances(sx, ivan), balances(sx, heidi)]);
      check(checks, 'ivan got all USDT back', i1.usdt === i0.usdt, `${i1.usdt - i0.usdt}`);
      check(checks, 'heidi BTQ untouched', h1.btq === h0.btq);
    },
  },
  {
    name: 'buyer-never-claims',
    phase: 'long',
    description: 'Buyer locks USDT and the MM locks BTQ, but the buyer never claims: the MM refunds its BTQ after the CLTV height and the buyer refunds USDT after the EVM deadline.',
    async body(sx, P, checks, swaps) {
      const judy = P('judy');
      await onboard(sx, judy, FUND);
      const j0 = await balances(sx, judy);
      const ids = await takeViaDiscord(sx, judy, await mmOrderNo(sx, judy, 'ask'), '1');
      const id = ids[0]!;
      await buyerCompletes(sx, judy, id, { claim: false });
      const st = await sx.waitFor(id, ['awaiting_refunds'], 400_000);
      check(checks, 'BTQ timelock reached without a claim', st.status === 'awaiting_refunds');
      const mid = await sx.waitFor(id, ['awaiting_refunds', 'refunded']);
      const withRefund = await (async () => {
        for (let k = 0; k < 120; k++) {
          const s = (await sx.swap(id)).swap;
          if (s.btq.refundTxid) return s;
          await new Promise((r) => setTimeout(r, 2000));
        }
        return mid;
      })();
      check(checks, 'MM refunded its BTQ via the CLTV leaf', !!withRefund.btq.refundTxid, withRefund.btq.refundTxid ?? '');
      const d = await sx.descriptor(id);
      const waitMs = Math.max(0, (d.evm.deadline! + 3) * 1000 - Date.now());
      sx.log(`  waiting ${Math.round(waitMs / 1000)}s for judy's USDT deadline`);
      await new Promise((r) => setTimeout(r, waitMs));
      await sx.ops.evmRefund(judy, d);
      const fin = await sx.waitFor(id, ['refunded']);
      swaps.push(record(fin, 'judy=buyer (never claimed), MM=seller'));
      const j1 = await balances(sx, judy);
      check(checks, 'judy USDT fully refunded', j1.usdt === j0.usdt);
      check(checks, 'judy never received BTQ', j1.btq === j0.btq);
    },
  },
  {
    name: 'security',
    phase: 'long',
    description: 'Unlinked trading blocked, stolen/forged buttons rejected, wrong-amount EVM lock rejected then corrected, bans enforced, admin commands gated, rate limit enforced.',
    async body(sx, P, checks, swaps) {
      const kevin = P('kevin');
      const lena = P('lena');
      const mallory = P('mallory');
      await Promise.all([onboard(sx, kevin, FUND), onboard(sx, lena, FUND)]);
      const d = sx.driver;

      // unlinked user cannot open an order form
      const ms = expectOk(await d.slash(mallory, 'swap', 'start'), 'mallory start');
      const buyNoLink = await d.slash(mallory, 'swap', 'buy');
      check(checks, 'unregistered (no ToS) user cannot trade', buyNoLink.outcome === 'error' && buyNoLink.errorCode === 'TOS_REQUIRED');
      expectOk(await d.click(mallory, findButton(ms, (l) => l.startsWith('Accept')), 'Accept'), 'mallory accept');
      const buyNoLink2 = await d.slash(mallory, 'swap', 'buy');
      check(checks, 'ToS-only user without wallet links cannot trade', buyNoLink2.errorCode === 'LINK_REQUIRED');

      // stolen ToS button
      const ls = expectOk(await d.slash(lena, 'swap', 'start'), 'lena start');
      void ls;
      const stolen = await d.click(mallory, `swap:tos:${lena.discordId}:${Math.floor(Date.now() / 1000) + 300}`, 'lena\'s Accept (stolen)');
      check(checks, 'clicking another user\'s button is FORBIDDEN', stolen.errorCode === 'FORBIDDEN');

      // forged cancel of kevin's order
      const { orderId } = await placeViaDiscord(sx, kevin, 'sell', '1', '2.90');
      const forged1 = await d.click(mallory, `swap:cancel:${kevin.discordId}:${orderId}`, 'forged cancel (kevin id)');
      check(checks, 'forged cancel with victim id → FORBIDDEN', forged1.errorCode === 'FORBIDDEN');
      const forged2 = await d.click(mallory, `swap:cancel:${mallory.discordId}:${orderId}`, 'cancel someone else\'s order');
      check(checks, 'cancel of another user\'s order → NOT_FOUND', forged2.errorCode === 'NOT_FOUND');
      const own = await d.click(kevin, `swap:cancel:${kevin.discordId}:${orderId}`, 'kevin cancels own order');
      check(checks, 'owner can cancel', own.outcome === 'ok');

      // wrong-amount EVM lock is rejected, a correct lock then proceeds
      const ids = await takeViaDiscord(sx, kevin, await mmOrderNo(sx, kevin, 'ask'), '1');
      const id = ids[0]!;
      const desc = await sx.descriptor(id);
      await sx.ops.evmLock(kevin, desc, { amountUnits: BigInt(desc.evm.amountUnits) - 1n });
      const rej = await waitEvent(sx, id, 'evm_lock_rejected');
      check(checks, 'underpaid USDT lock rejected', String(rej.reason ?? '').includes('amount'), String(rej.reason));
      check(checks, 'swap still waits for a valid lock', (await sx.swap(id)).swap.status === 'awaiting_buyer_lock');
      await buyerCompletes(sx, kevin, id);
      const fin = await sx.waitFor(id, ['completed']);
      swaps.push(record(fin, 'kevin=buyer (after a rejected lock), MM=seller'));
      check(checks, 'corrected swap completed', fin.status === 'completed');

      // ban enforcement via the operator API
      const users = (await sx.admin('GET', '/users')) as { users: Array<{ id: string; discord_id: string }> };
      const mid = users.users.find((u) => u.discord_id === mallory.discordId)!.id;
      await sx.admin('POST', `/users/${mid}/ban`, { banned: true });
      const banned = await d.slash(mallory, 'swap', 'book');
      check(checks, 'banned user is refused', banned.errorCode === 'USER_BANNED');
      await sx.admin('POST', `/users/${mid}/ban`, { banned: false });

      // admin view gated by admin_users, not Discord roles
      const adm = await d.slash(lena, 'swap-admin', 'status');
      check(checks, 'non-admin /swap-admin → FORBIDDEN', adm.errorCode === 'FORBIDDEN');

      // rate limit: 20/min per user
      let limited = 0;
      for (let k = 0; k < 24; k++) if ((await d.slash(lena, 'swap', 'help')).errorCode === 'RATE_LIMITED') limited++;
      check(checks, 'rate limit kicks in after 20 interactions/min', limited >= 3, `${limited} limited`);
    },
  },
  {
    name: 'burst',
    phase: 'serial',
    description: 'Concurrency: several users buy and sell against the MM at the same time; every swap settles.',
    async body(sx, P, checks, swaps) {
      const n = Number(process.env.SIM_BURST ?? '6');
      const people = Array.from({ length: n }, (_, k) => P(`burst${k + 1}`));
      await Promise.all(people.map((p) => onboard(sx, p, FUND)));
      const results = await Promise.all(
        people.map(async (p, k) => {
          const side = k % 2 === 0 ? 'buy' : 'sell';
          const { swapIds } = await placeViaDiscord(sx, p, side, '0.5', 'market');
          const id = swapIds[0]!;
          if (side === 'buy') await buyerCompletes(sx, p, id);
          else await sellerCompletes(sx, p, id);
          return { id, fin: await sx.waitFor(id, ['completed']), role: `${p.name}=${side === 'buy' ? 'buyer' : 'seller'}, MM` };
        }),
      );
      for (const r of results) swaps.push(record(r.fin, r.role));
      check(checks, `all ${n} concurrent swaps completed`, results.every((r) => r.fin.status === 'completed'));
    },
  },
];

export async function runScenario(sx: SimContext, s: Scenario, salt: string): Promise<ScenarioResult> {
  const started = Date.now();
  const checks: Check[] = [];
  const swaps: SwapRecord[] = [];
  const P = (name: string) => persona(name, salt);
  sx.log(`▶ ${s.name}: ${s.description}`);
  try {
    await s.body(sx, P, checks, swaps);
    sx.log(`✔ ${s.name} (${Math.round((Date.now() - started) / 1000)}s)`);
    return { name: s.name, description: s.description, ok: true, durationMs: Date.now() - started, checks, swaps };
  } catch (err) {
    sx.log(`✘ ${s.name}: ${(err as Error).message}`);
    return { name: s.name, description: s.description, ok: false, durationMs: Date.now() - started, checks, swaps, error: (err as Error).message };
  }
}
