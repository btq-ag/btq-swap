/** Engine smoke test (no Discord layer): one persona buys BTQ from the MM through real HTLCs on both chains. */
import { Wallet } from 'ethers';
import { linkChallengeMessage, toBase64 } from '@btq-swap/htlc';
import { config } from '../config';
import { closePool } from '../lib/db';
import { resolveEvmAddresses } from '../domain/runtime';
import { acceptTos, ensureUser, finishBtqLink, finishEvmLink, startBtqLink, startEvmLink } from '../domain/identity';
import { placeOrder } from '../domain/book';
import { getSwap } from '../domain/settlement';
import { ChainOps } from './chainops';
import { fundPersona } from './fund';
import { persona } from './personas';

async function waitStatus(shortId: string, want: string[], timeoutMs = 240_000): Promise<string> {
  const end = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < end) {
    const s = await getSwap(shortId);
    if (s && s.status !== last) {
      last = s.status;
      console.log(`  swap #${shortId} → ${s.status}`);
    }
    if (s && want.includes(s.status)) return s.status;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timeout waiting for ${want.join('|')} (last ${last})`);
}

async function main(): Promise<void> {
  await resolveEvmAddresses();
  const api = process.env.SIM_API_URL ?? `http://127.0.0.1:${config().PORT}/api`;
  const ops = new ChainOps(api, config().EVM_RPC_URL, config().EVM_CHAIN_ID);
  const alice = persona('alice', process.env.SIM_SALT ?? 'smoke');
  await fundPersona(alice, { usdtUnits: 1_000_000_000n, btqSats: 5_000_000_000n });

  let u = await ensureUser(alice.discordId, alice.name, { simulated: true });
  u = await acceptTos(u.id);
  const evmLink = await startEvmLink(u, alice.evmAddress);
  u = await finishEvmLink(u, await new Wallet(alice.evmKey).signMessage(evmLink.message));
  const btqLink = await startBtqLink(u);
  u = await finishBtqLink(u, {
    pubkey: toBase64(alice.htlc.publicKey),
    signature: toBase64(alice.htlc.sign(linkChallengeMessage(btqLink.challenge))),
    btqAddress: alice.btqAddress!,
  });
  console.log('linked', { eth: u.eth_address, btq: u.btq_address });

  const usdt0 = await ops.usdtBalance(alice, (await ops.provider.getNetwork()) && (await import('../chains/evm')).evmChain().addresses().token);
  const btq0 = await ops.btqBalanceSats(alice);
  const r = await placeOrder(u.id, { side: 'buy', amountBtq: '2', price: 'market' });
  const swap = r.swaps[0];
  if (!swap) throw new Error('no fill');
  console.log(`matched swap #${swap.short_id}: ${swap.amount_btq} BTQ for ${swap.amount_usdt} USDT`);

  let d = await ops.descriptor(swap.short_id);
  console.log('  alice locks USDT', await ops.evmLock(alice, d));
  await waitStatus(swap.short_id, ['awaiting_buyer_claim']);
  d = await ops.descriptor(swap.short_id);
  console.log('  alice claims BTQ', await ops.btqClaim(alice, d));
  await waitStatus(swap.short_id, ['completed']);
  const final = await getSwap(swap.short_id);
  console.log('completed', { evmClaim: final?.evm_claim_tx, btqClaim: final?.btq_claim_txid, preimage: final?.revealed_preimage });
  const usdt1 = await ops.usdtBalance(alice, (await import('../chains/evm')).evmChain().addresses().token);
  const btq1 = await ops.btqBalanceSats(alice);
  console.log('alice deltas', { usdt: (usdt1 - usdt0).toString(), btqSats: (btq1 - btq0).toString() });
  await closePool();
}

main().catch(async (e) => {
  console.error(e);
  await closePool();
  process.exit(1);
});
