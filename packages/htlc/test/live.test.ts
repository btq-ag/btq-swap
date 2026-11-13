/**
 * Live consensus tests against a regtest btqd. Opt-in:
 *   BTQ_LIVE=1 BTQ_RPC_URL=http://127.0.0.1:18443 BTQ_RPC_USER=.. BTQ_RPC_PASS=.. BTQ_LIVE_WALLET=.. npx vitest run test/live.test.ts
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BtqRpc,
  btqToSats,
  buildClaimTx,
  buildRefundTx,
  bytesToHex,
  createHtlc,
  findHtlcOutputs,
  htlcTreeJson,
  inspectHtlcSpend,
  newPreimage,
  newSeed,
  signerFromSeed,
} from '../src/index.js';

const LIVE = process.env.BTQ_LIVE === '1';
const rpc = new BtqRpc({
  url: process.env.BTQ_RPC_URL ?? 'http://127.0.0.1:18543',
  user: process.env.BTQ_RPC_USER ?? 'spike',
  pass: process.env.BTQ_RPC_PASS ?? 'spikepass',
});
const walletName = process.env.BTQ_LIVE_WALLET ?? 'htlc-live-test';
const wallet = rpc.withWallet(walletName);

type Accept = Array<{ allowed: boolean; 'reject-reason'?: string; vsize?: number }>;

async function mine(n: number): Promise<void> {
  const addr = await wallet.call<string>('getnewaddress');
  await wallet.call('generatetoaddress', [n, addr]);
}

describe.skipIf(!LIVE)('live regtest HTLC consensus', () => {
  beforeAll(async () => {
    const loaded = await rpc.call<string[]>('listwallets');
    if (!loaded.includes(walletName)) {
      try {
        await rpc.call('loadwallet', [walletName]);
      } catch {
        await rpc.call('createwallet', [walletName]);
      }
    }
    const bal = await wallet.call<number>('getbalance');
    if (bal < 5) await mine(110);
  });

  it('getnewp2mraddress derives the same address as the TS builder', async () => {
    const h = createHtlc('regtest', {
      secretHash: newPreimage().secretHash,
      claimPubkey: signerFromSeed(newSeed()).publicKey,
      refundPubkey: signerFromSeed(newSeed()).publicKey,
      refundLocktime: (await rpc.call<number>('getblockcount')) + 10,
    });
    const node = await wallet.call<{ address: string }>('getnewp2mraddress', [htlcTreeJson(h), 'live-test']);
    expect(node.address).toBe(h.address);
  });

  it('claim with preimage is accepted, mined and the preimage is recoverable', async () => {
    const buyer = signerFromSeed(newSeed());
    const seller = signerFromSeed(newSeed());
    const s = newPreimage();
    const h = createHtlc('regtest', {
      secretHash: s.secretHash,
      claimPubkey: buyer.publicKey,
      refundPubkey: seller.publicKey,
      refundLocktime: (await rpc.call<number>('getblockcount')) + 50,
    });
    const fundTxid = await wallet.call<string>('sendtoaddress', [h.address, 0.75]);
    await mine(1);
    const [out] = findHtlcOutputs(await rpc.call<string>('getrawtransaction', [fundTxid, false]), h);
    expect(out?.valueSats).toBe(btqToSats('0.75'));
    const dest = await wallet.call<string>('getnewaddress');
    const claim = buildClaimTx({ htlc: h, outpoint: { txid: fundTxid, ...out! }, destination: dest, preimage: s.preimage, signer: buyer, feeRateSatVb: 1 });
    const accept = await rpc.call<Accept>('testmempoolaccept', [[claim.hex]]);
    expect(accept[0]).toMatchObject({ allowed: true });
    expect(Math.abs((accept[0]!.vsize ?? 0) - claim.vsize)).toBeLessThanOrEqual(2);
    const txid = await rpc.call<string>('sendrawtransaction', [claim.hex]);
    expect(txid).toBe(claim.txid);
    await mine(1);
    const info = inspectHtlcSpend(await rpc.call<string>('getrawtransaction', [txid, false]), { txid: fundTxid, vout: out!.vout }, h);
    expect(info?.kind).toBe('claim');
    expect(bytesToHex(info!.preimage!)).toBe(s.preimageHex);
  });

  it('a signature over different outputs is rejected by consensus', async () => {
    const buyer = signerFromSeed(newSeed());
    const s = newPreimage();
    const h = createHtlc('regtest', {
      secretHash: s.secretHash,
      claimPubkey: buyer.publicKey,
      refundPubkey: signerFromSeed(newSeed()).publicKey,
      refundLocktime: (await rpc.call<number>('getblockcount')) + 50,
    });
    const fundTxid = await wallet.call<string>('sendtoaddress', [h.address, 0.3]);
    await mine(1);
    const [out] = findHtlcOutputs(await rpc.call<string>('getrawtransaction', [fundTxid, false]), h);
    const dest = await wallet.call<string>('getnewaddress');
    const good = buildClaimTx({ htlc: h, outpoint: { txid: fundTxid, ...out! }, destination: dest, preimage: s.preimage, signer: buyer, feeSats: 1000n });
    const other = buildClaimTx({ htlc: h, outpoint: { txid: fundTxid, ...out! }, destination: dest, preimage: s.preimage, signer: buyer, feeSats: 2000n });
    // splice the signature of `other` into `good` (same layout, different output value)
    const { parseTx, txHex } = await import('../src/tx.js');
    const t1 = parseTx(good.hex);
    const t2 = parseTx(other.hex);
    t1.inputs[0]!.witness[0] = t2.inputs[0]!.witness[0]!;
    const res = await rpc.call<Accept>('testmempoolaccept', [[txHex(t1)]]);
    expect(res[0]?.allowed).toBe(false);
    expect(res[0]?.['reject-reason']).toMatch(/script-verify|signature/i);
  });

  it('refund is non-final before the CLTV height and accepted at it', async () => {
    const seller = signerFromSeed(newSeed());
    const lock = (await rpc.call<number>('getblockcount')) + 4;
    const h = createHtlc('regtest', {
      secretHash: newPreimage().secretHash,
      claimPubkey: signerFromSeed(newSeed()).publicKey,
      refundPubkey: seller.publicKey,
      refundLocktime: lock,
    });
    const fundTxid = await wallet.call<string>('sendtoaddress', [h.address, 0.2]);
    await mine(1);
    const [out] = findHtlcOutputs(await rpc.call<string>('getrawtransaction', [fundTxid, false]), h);
    const dest = await wallet.call<string>('getnewaddress');
    const refund = buildRefundTx({ htlc: h, outpoint: { txid: fundTxid, ...out! }, destination: dest, signer: seller, feeRateSatVb: 1 });
    expect((await rpc.call<Accept>('testmempoolaccept', [[refund.hex]]))[0]).toMatchObject({ allowed: false, 'reject-reason': 'non-final' });
    await mine(lock - (await rpc.call<number>('getblockcount')));
    expect((await rpc.call<Accept>('testmempoolaccept', [[refund.hex]]))[0]).toMatchObject({ allowed: true });
    await rpc.call('sendrawtransaction', [refund.hex]);
    await mine(1);
    const spent = await rpc.call<unknown>('gettxout', [fundTxid, out!.vout, true]);
    expect(spent).toBeNull();
  });
});
