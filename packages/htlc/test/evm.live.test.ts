/**
 * Live tests against an anvil/hardhat node. Opt-in: EVM_LIVE=1 EVM_RPC_URL=http://127.0.0.1:18545
 * Uses anvil's default funded dev accounts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContractFactory, JsonRpcProvider, Wallet, hexlify, randomBytes, sha256 } from 'ethers';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  computeAgreementId,
  decodeHtlcLog,
  erc20Contract,
  htlcContract,
  htlcInterface,
  parseSwapBindingAsset,
  readInstance,
  swapBindingAsset,
} from '../src/evm.js';

const LIVE = process.env.EVM_LIVE === '1';
const URL = process.env.EVM_RPC_URL ?? 'http://127.0.0.1:18545';
const KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
];
const artifact = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, '..', '..', 'backend', 'src', 'chains', 'artifacts', `${name}.json`), 'utf8')) as { abi: unknown[]; bytecode: string };

describe.skipIf(!LIVE)('HtlcERC20 on a live dev chain', () => {
  const provider = new JsonRpcProvider(URL, undefined, { cacheTimeout: -1 });
  const deployer = new Wallet(KEYS[0]!, provider);
  const buyer = new Wallet(KEYS[1]!, provider);
  const seller = new Wallet(KEYS[2]!, provider);
  let usdtAddr = '';
  let htlcAddr = '';

  beforeAll(async () => {
    const usdtF = new ContractFactory(artifact('MockUSDT').abi as never, artifact('MockUSDT').bytecode, deployer);
    const usdt = await usdtF.deploy(10_000_000n * 10n ** 6n);
    await usdt.waitForDeployment();
    usdtAddr = await usdt.getAddress();
    const htlcF = new ContractFactory(artifact('HtlcERC20').abi as never, artifact('HtlcERC20').bytecode, deployer);
    const htlc = await htlcF.deploy();
    await htlc.waitForDeployment();
    htlcAddr = await htlc.getAddress();
    await (await erc20Contract(usdtAddr, deployer).getFunction('transfer')(buyer.address, 1000n * 10n ** 6n)).wait();
  });

  it('human-readable ABI matches the compiled artifact selectors', () => {
    const compiled = artifact('HtlcERC20').abi as Array<{ type: string; name?: string }>;
    for (const fn of ['createHTLCProposal', 'withdrawTokens', 'refundTokens', 'getHTLCInstance']) {
      expect(compiled.some((e) => e.type === 'function' && e.name === fn)).toBe(true);
      expect(htlcInterface.getFunction(fn)).toBeTruthy();
    }
  });

  async function lock(deadline: number, preimage: string) {
    const amount = 25n * 10n ** 6n;
    const swapId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    const params = {
      partyA: buyer.address,
      partyB: seller.address,
      secretlock: sha256(preimage),
      deadline,
      erc20Contract: usdtAddr,
      tokenAmount: amount,
      otherNetwork: 'btq:regtest',
      otherAsset: swapBindingAsset(swapId),
      otherAmount: 1_000_000_000n,
    };
    await (await erc20Contract(usdtAddr, buyer).getFunction('approve')(htlcAddr, amount)).wait();
    const tx = await htlcContract(htlcAddr, buyer).getFunction('createHTLCProposal')([
      params.partyB, params.secretlock, params.deadline, params.erc20Contract, params.tokenAmount, params.otherNetwork, params.otherAsset, params.otherAmount,
    ]);
    const receipt = await tx.wait();
    const ev = receipt!.logs.map(decodeHtlcLog).find((e: unknown) => e && (e as { kind: string }).kind === 'lockup');
    return { params, ev: ev as Extract<ReturnType<typeof decodeHtlcLog>, { kind: 'lockup' }>, swapId };
  }

  it('lock → withdraw by partyB reveals the key on the instance', async () => {
    const block = await provider.getBlock('latest');
    const preimage = hexlify(randomBytes(32));
    const { params, ev, swapId } = await lock(block!.timestamp + 3600, preimage);
    expect(ev.agreementId).toBe(computeAgreementId(params));
    expect(parseSwapBindingAsset(ev.otherAsset)).toBe(swapId);
    expect(ev.partyB).toBe(seller.address);

    const contract = htlcContract(htlcAddr, provider);
    const before = await readInstance(contract, ev.agreementId);
    expect(before).toMatchObject({ exists: true, tokensWithdrawn: false, tokenAmount: params.tokenAmount });
    await expect(htlcContract(htlcAddr, buyer).getFunction('withdrawTokens')(ev.agreementId, preimage)).rejects.toThrow();
    const r = await (await htlcContract(htlcAddr, seller).getFunction('withdrawTokens')(ev.agreementId, preimage)).wait();
    expect(r!.logs.map(decodeHtlcLog).some((e) => e?.kind === 'claimed')).toBe(true);
    const after = await readInstance(contract, ev.agreementId);
    expect(after.tokensWithdrawn).toBe(true);
    expect(after.key).toBe(preimage.toLowerCase());
    expect(await erc20Contract(usdtAddr, provider).getFunction('balanceOf')(seller.address)).toBe(params.tokenAmount);
  });

  it('refund only after the deadline and only by partyA', async () => {
    const block = await provider.getBlock('latest');
    const { ev } = await lock(block!.timestamp + 120, hexlify(randomBytes(32)));
    await expect(htlcContract(htlcAddr, buyer).getFunction('refundTokens')(ev.agreementId)).rejects.toThrow();
    await provider.send('evm_increaseTime', [180]);
    await provider.send('evm_mine', []);
    await expect(htlcContract(htlcAddr, seller).getFunction('refundTokens')(ev.agreementId)).rejects.toThrow();
    const r = await (await htlcContract(htlcAddr, buyer).getFunction('refundTokens')(ev.agreementId)).wait();
    expect(r!.logs.map(decodeHtlcLog).some((e) => e?.kind === 'redeemed')).toBe(true);
  });
});
