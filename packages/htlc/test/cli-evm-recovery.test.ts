import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Wallet } from 'ethers';
import { createSecretFile } from '../src/secrets.js';
const f=vi.hoisted(()=>({lock:vi.fn(),refund:vi.fn(),instance:vi.fn()}));
vi.mock('ethers',async original=>({...await original<typeof import('ethers')>(),JsonRpcProvider:class {
  async getNetwork(){return {chainId:31337n};} async getBlock(){return {timestamp:1800000000};}
}}));
vi.mock('../src/evm.js',async original=>({...await original<typeof import('../src/evm.js')>(),
  htlcContract:()=>({getFunction:(name:string)=>name==='createHTLCProposal'?f.lock:f.refund}),
  erc20Contract:()=>({getFunction:()=>async()=>1000000n}),readInstance:f.instance}));
import { main, type SwapDescriptor } from '../src/cli.js';

describe('EVM CLI durable recovery (#10, #11)',()=>{
  const key='0x'+'11'.repeat(32),buyer=new Wallet(key).address;
  const api='https://desk.example/api',id='11111111-2222-3333-4444-555555555555';
  let home:string,d:SwapDescriptor;
  beforeEach(()=>{
    vi.resetAllMocks();home=mkdtempSync(join(tmpdir(),'btq-cli-evm-'));
    d={swap:{id,shortId:1,status:'awaiting_buyer_lock'},evm:{chainId:31337,htlcContract:'0x'+'33'.repeat(20),token:'0x'+'44'.repeat(20),buyer,seller:'0x'+'22'.repeat(20),
      agreementId:null,amountUnits:'1000000',lockDurationSec:3600,otherNetwork:'btq:regtest',otherAsset:'BTQ swap '+id,otherAmount:'100000000'},btq:{}} as SwapDescriptor;
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(d))));vi.spyOn(console,'log').mockImplementation(()=>{});
    f.instance.mockResolvedValue({exists:true,partyA:buyer});f.refund.mockResolvedValue({wait:async()=>({hash:'refunded'})});
  });
  afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();rmSync(home,{recursive:true,force:true});});
  const args=()=>['--home',home,'--api',api,'--swap','1','--evm-rpc','http://node','--key',key];
  it('prints the agreement before an ambiguous send failure and refuses a retry with the used hash',async()=>{
    createSecretFile(home,api,id,1);
    f.lock.mockImplementation(async()=>{
      const output=vi.mocked(console.log).mock.calls.map(c=>String(c[0])).join('\n');
      expect(output).toContain('agreementId');expect(output).toMatch(/0x[a-f0-9]{64}/);
      throw new Error('broadcast timeout');
    });
    await expect(main(['evm','lock',...args()])).rejects.toThrow('broadcast timeout');
    await expect(main(['evm','lock',...args(),'--deadline','1800004000'])).rejects.toThrow(/already used/);
    expect(f.lock).toHaveBeenCalledOnce();
  });
  it.each([null,'0x'+'bb'.repeat(32)])('refunds an explicit rejected agreement when accepted agreement is %s',async accepted=>{
    d.evm.agreementId=accepted;const rejected='0x'+'aa'.repeat(32);
    await main(['evm','refund',...args(),'--agreement-id',rejected]);expect(f.refund).toHaveBeenCalledWith(rejected);
    expect(f.instance).toHaveBeenCalledWith(expect.anything(),rejected);
  });
  it.each([false,true])('does not refund an absent or foreign agreement (exists=%s)',async exists=>{
    f.instance.mockResolvedValue({exists,partyA:'0x'+'aa'.repeat(20)});
    await expect(main(['evm','refund',...args(),'--agreement-id','0x'+'cc'.repeat(32)])).rejects.toThrow(/not refundable/);
    expect(f.refund).not.toHaveBeenCalled();
  });
});
