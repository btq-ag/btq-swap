import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, type SwapDescriptor } from '../src/cli.js';
import { bytesToHex, createHtlc, newPreimage, parseTx, signerFromSeed, toRecord } from '../src/index.js';

describe('CLI scoped secrets and rejected BTQ refunds (#10, #11)', () => {
  let home: string;
  let descriptor: SwapDescriptor;
  const seller = signerFromSeed(new Uint8Array(32).fill(2));
  const htlc = createHtlc('regtest', { secretHash: newPreimage().secretHash, claimPubkey: seller.publicKey,
    refundPubkey: seller.publicKey, refundLocktime: 200 });
  const id = '11111111-2222-3333-4444-555555555555';
  const outpoint = 'ab'.repeat(32) + ':3';
  beforeEach(() => {
    vi.stubEnv('BTQ_RPC_URL', '');
    home = mkdtempSync(join(tmpdir(), 'btq-cli-test-'));
    writeFileSync(join(home, 'key.json'), JSON.stringify({ seed: '02'.repeat(32) }));
    descriptor = { swap: { id, shortId: 1, status: 'awaiting_buyer_refund', network:'regtest', amountSats:'100000000', amountBtq:'1' },
      btq: { htlc: toRecord(htlc), lock: null, tipHeight: 0 }, evm: {} as SwapDescriptor['evm'], preimage:null };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('https://desk.example')) return new Response(JSON.stringify(descriptor));
      const request = JSON.parse(String(init!.body));
      return new Response(JSON.stringify({ result: request.method === 'getblockcount' ? 200 :
        { value:0.1, scriptPubKey:{ hex:bytesToHex(htlc.scriptPubKey) } } }));
    }));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(home, { recursive:true,force:true }); });
  const args = () => ['--home',home,'--api','https://desk.example/api','--swap','1'];
  it('resolves short and UUID aliases to one file and refuses silent reuse', async () => {
    await main(['secret','new',...args()]);
    await expect(main(['secret','new',...args(),'--swap',id])).rejects.toThrow(/already exists/);
    descriptor.swap.id = '11111111-2222-3333-4444-666666666666';
    await expect(main(['secret','new',...args()])).resolves.toBeUndefined();
  });
  it('refunds an underpaid explicit outpoint using its node-verified value and height', async () => {
    await main(['refund',...args(),'--to',htlc.address,'--outpoint',outpoint,'--rpc','http://node']);
    const line = vi.mocked(console.log).mock.calls.map(c=>c[0]).find(v=>typeof v==='string' && v.includes('sendrawtransaction')) as string;
    const transaction = parseTx(line.split('sendrawtransaction ')[1]!);
    expect(transaction.inputs[0]!.txid).toBe('ab'.repeat(32)); expect(transaction.inputs[0]!.vout).toBe(3);
    expect(transaction.outputs[0]!.valueSats).toBeLessThan(10_000_000n);
    expect(transaction.locktime).toBe(200);
  });
  it('requires independent node verification and rejects missing or mismatched outputs', async () => {
    await expect(main(['refund',...args(),'--to',htlc.address,'--outpoint',outpoint])).rejects.toThrow(/requires --rpc/);
    vi.stubGlobal('fetch', vi.fn(async (url:string) => new Response(JSON.stringify(url.startsWith('https://desk.example') ? descriptor : { result:null }))));
    await expect(main(['refund',...args(),'--to',htlc.address,'--outpoint',outpoint,'--rpc','http://node'])).rejects.toThrow(/missing, spent/);
  });
});
