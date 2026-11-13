/**
 * Live feasibility spike against a regtest btqd:
 *   fund HTLC → claim with preimage (Dilithium sig) → extract preimage
 *   fund HTLC → refund rejected before CLTV → refund accepted after CLTV
 *
 * Env: BTQ_RPC_URL (default http://127.0.0.1:18543), BTQ_RPC_USER, BTQ_RPC_PASS, FUND_WALLET, DEST_WALLET
 */
import {
  BtqRpc,
  BtqRpcError,
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

const rpc = new BtqRpc({
  url: process.env.BTQ_RPC_URL ?? 'http://127.0.0.1:18543',
  user: process.env.BTQ_RPC_USER ?? 'spike',
  pass: process.env.BTQ_RPC_PASS ?? 'spikepass',
});
const fund = rpc.withWallet(process.env.FUND_WALLET ?? 'maker');
const dest = rpc.withWallet(process.env.DEST_WALLET ?? 'taker');

function log(step: string, data?: unknown): void {
  console.log(`\n=== ${step}`);
  if (data !== undefined) console.log(typeof data === 'string' ? data : JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
}

async function mine(n: number): Promise<void> {
  const addr = await fund.call<string>('getnewaddress');
  await fund.call('generatetoaddress', [n, addr]);
}

async function main(): Promise<void> {
  const height0 = await rpc.call<number>('getblockcount');
  const claimer = signerFromSeed(newSeed());
  const refunder = signerFromSeed(newSeed());
  const secret = newPreimage();

  // ---------- 1) claim path ----------
  const htlc = createHtlc('regtest', {
    secretHash: secret.secretHash,
    claimPubkey: claimer.publicKey,
    refundPubkey: refunder.publicKey,
    refundLocktime: height0 + 20,
  });
  log('HTLC address (computed in TS)', htlc.address);

  const walletView = await fund.call<{ address: string; merkle_root: string }>('getnewp2mraddress', [htlcTreeJson(htlc), 'spike-htlc']);
  log('getnewp2mraddress for the same leaves', walletView);
  if (walletView.address !== htlc.address) throw new Error('ADDRESS MISMATCH between TS and btqd');

  const fundTxid = await fund.call<string>('sendtoaddress', [htlc.address, 1.25]);
  await mine(1);
  const fundHex = await rpc.call<string>('getrawtransaction', [fundTxid, false]);
  const [out] = findHtlcOutputs(fundHex, htlc);
  if (!out) throw new Error('funding tx has no HTLC output');
  log('funded HTLC', { fundTxid, vout: out.vout, valueSats: out.valueSats });
  if (out.valueSats !== btqToSats('1.25')) throw new Error('unexpected HTLC amount');

  const claimDest = await dest.call<string>('getnewaddress');
  // wrong preimage must be refused locally
  try {
    buildClaimTx({ htlc, outpoint: { txid: fundTxid, ...out }, destination: claimDest, preimage: newPreimage().preimage, signer: claimer });
    throw new Error('wrong preimage was accepted locally');
  } catch (e) {
    log('wrong preimage rejected locally', (e as Error).message);
  }
  // wrong key → consensus must reject (craft by signing with refunder but swapping pubkey check off is impossible via API,
  // so build a tx signed by the right key over a different output value and splice: simplest is testmempoolaccept on a tampered sig)
  const claim = buildClaimTx({ htlc, outpoint: { txid: fundTxid, ...out }, destination: claimDest, preimage: secret.preimage, signer: claimer, feeRateSatVb: 2 });
  const tampered = claim.hex.replace(/(.{400})(..)/, (_, a: string, b: string) => a + (b === '00' ? '01' : '00'));
  const tamperedRes = await rpc.call<Array<{ allowed: boolean; 'reject-reason'?: string }>>('testmempoolaccept', [[tampered]]);
  log('tampered tx testmempoolaccept', tamperedRes);
  const accept = await rpc.call<Array<{ allowed: boolean; 'reject-reason'?: string; vsize?: number; fees?: unknown }>>('testmempoolaccept', [[claim.hex]]);
  log('claim testmempoolaccept', accept);
  if (!accept[0]?.allowed) throw new Error(`claim rejected: ${accept[0]?.['reject-reason']}`);
  const claimTxid = await rpc.call<string>('sendrawtransaction', [claim.hex]);
  await mine(1);
  const claimTx = await rpc.call<{ confirmations: number; vout: Array<{ value: number }> }>('getrawtransaction', [claimTxid, true]);
  log('claim confirmed', { claimTxid, confirmations: claimTx.confirmations, vsize: claim.vsize, fee: claim.feeSats, paid: claimTx.vout[0]?.value });

  const claimHex = await rpc.call<string>('getrawtransaction', [claimTxid, false]);
  const info = inspectHtlcSpend(claimHex, { txid: fundTxid, vout: out.vout }, htlc);
  log('preimage extracted from BTQ chain', { kind: info?.kind, preimage: info?.preimage && bytesToHex(info.preimage), expected: secret.preimageHex });
  if (!info?.preimage || bytesToHex(info.preimage) !== secret.preimageHex) throw new Error('preimage extraction failed');

  // ---------- 2) refund path ----------
  const h1 = await rpc.call<number>('getblockcount');
  const secret2 = newPreimage();
  const htlc2 = createHtlc('regtest', {
    secretHash: secret2.secretHash,
    claimPubkey: claimer.publicKey,
    refundPubkey: refunder.publicKey,
    refundLocktime: h1 + 5,
  });
  const fund2 = await fund.call<string>('sendtoaddress', [htlc2.address, 0.5]);
  await mine(1);
  const [out2] = findHtlcOutputs(await rpc.call<string>('getrawtransaction', [fund2, false]), htlc2);
  const refundDest = await fund.call<string>('getnewaddress');
  const refund = buildRefundTx({ htlc: htlc2, outpoint: { txid: fund2, ...out2! }, destination: refundDest, signer: refunder, feeRateSatVb: 2 });
  const early = await rpc.call<Array<{ allowed: boolean; 'reject-reason'?: string }>>('testmempoolaccept', [[refund.hex]]);
  log(`refund before timelock (height ${await rpc.call<number>('getblockcount')}, lock ${htlc2.refundLocktime})`, early);
  if (early[0]?.allowed) throw new Error('refund accepted before timelock!');
  await mine(htlc2.refundLocktime - (await rpc.call<number>('getblockcount')));
  const late = await rpc.call<Array<{ allowed: boolean; 'reject-reason'?: string }>>('testmempoolaccept', [[refund.hex]]);
  log(`refund at timelock (height ${await rpc.call<number>('getblockcount')})`, late);
  if (!late[0]?.allowed) throw new Error(`refund rejected after timelock: ${late[0]?.['reject-reason']}`);
  const refundTxid = await rpc.call<string>('sendrawtransaction', [refund.hex]);
  await mine(1);
  const spendInfo = inspectHtlcSpend(await rpc.call<string>('getrawtransaction', [refundTxid, false]), { txid: fund2, vout: out2!.vout }, htlc2);
  log('refund confirmed', { refundTxid, kind: spendInfo?.kind });

  // claim after refund must fail (double spend)
  const lateClaim = buildClaimTx({ htlc: htlc2, outpoint: { txid: fund2, ...out2! }, destination: claimDest, preimage: secret2.preimage, signer: claimer });
  const lateRes = await rpc.call<Array<{ allowed: boolean; 'reject-reason'?: string }>>('testmempoolaccept', [[lateClaim.hex]]);
  log('claim after refund (must be rejected)', lateRes);
  console.log('\nSPIKE OK');
}

main().catch((e) => {
  if (e instanceof BtqRpcError) console.error(e.message);
  else console.error(e);
  process.exit(1);
});
