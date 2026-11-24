import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { newPreimage, swapBindingAsset } from '@btq-swap/htlc';
import { BtqChain } from '../src/chains/btq';
import { EvmChain } from '../src/chains/evm';
vi.mock('../src/config',()=>({config:()=>({LOG_LEVEL:'error'})}));
const live=process.env.CHAIN_LIVE==='1';

describe.skipIf(!live)('chain adapters against isolated local nodes',()=>{
  it('never infers BTQ confirmation from an orphaned block height and restores reconsidered evidence',async()=>{
    const wallet='reorg-'+randomUUID();
    const chain=new BtqChain({url:process.env.BTQ_LIVE_RPC!,user:'swap_test',pass:'local_test_only',platformWallet:wallet});
    await chain.rpc.call('createwallet',[wallet]);
    const address=await chain.platformAddress('mining');await chain.platform.call('generatetoaddress',[101,address]);
    const txid=await chain.platformSend(await chain.platformAddress('recipient'),100000000n,'reorg test');
    const hashes=await chain.platform.call<string[]>('generatetoaddress',[6,address]);
    expect(await chain.txConfirmations(txid)).toMatchObject({confirmations:6,blockhash:hashes[0]});
    const raw=await chain.rawTx(txid,hashes[0]);expect(raw.length).toBeGreaterThan(100);
    await chain.rpc.call('invalidateblock',[hashes[0]]);
    expect(await chain.txConfirmations(txid)).toEqual({confirmations:0,blockhash:undefined,height:undefined});
    await chain.rpc.call('reconsiderblock',[hashes[0]]);
    expect(await chain.txConfirmations(txid)).toMatchObject({confirmations:6,blockhash:hashes[0]});
  },120000);
  it('reads canonical EVM receipts and block-tagged instances across a snapshot rollback',async()=>{
    const chain=new EvmChain({url:process.env.EVM_LIVE_RPC!,chainId:31337,privateKey:'0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'});
    try {
      chain.setAddresses(await chain.deployDevContracts(1000000000000n));
      const snapshot=await chain.provider.send('evm_snapshot',[]);
      const secret=newPreimage();const now=await chain.latestTimestamp();
      const p={partyB:chain.platformAddress,secretlock:'0x'+secret.secretHashHex,deadline:now+3600,erc20Contract:chain.addresses().token,tokenAmount:1000000n,
        otherNetwork:'btq:regtest',otherAsset:swapBindingAsset(randomUUID()),otherAmount:100000000n};
      const lock=await chain.platformLock(p);const receipt=(await chain.receipt(lock.txHash))!;
      expect((await chain.block(receipt.blockNumber)).hash).toBe(receipt.blockHash);
      expect((await chain.instance(lock.agreementId,receipt.blockNumber)).tokensWithdrawn).toBe(false);
      const claim=await chain.platformWithdraw(lock.agreementId,secret.preimageHex);
      expect((await chain.receipt(claim))!.status).toBe(1);
      expect((await chain.instance(lock.agreementId)).key).toBe('0x'+secret.preimageHex);
      expect((await chain.instance(lock.agreementId,receipt.blockNumber)).key).not.toBe('0x'+secret.preimageHex);
      await chain.provider.send('evm_revert',[snapshot]);chain.signer.reset();
      expect(await chain.receipt(lock.txHash)).toBeNull();expect(await chain.receipt(claim)).toBeNull();
      expect((await chain.instance(lock.agreementId)).exists).toBe(false);
      const replacement=await chain.platformLock(p);expect(replacement.agreementId).toBe(lock.agreementId);
      expect((await chain.logs(replacement.blockNumber,replacement.blockNumber))[0]!.blockHash).toBe((await chain.block(replacement.blockNumber)).hash);
    } finally {chain.provider.destroy();}
  },120000);
});
