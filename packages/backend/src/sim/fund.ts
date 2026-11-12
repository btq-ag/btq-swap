import { parseEther } from 'ethers';
import { toBase64 } from '@btq-swap/htlc';
import { config } from '../config';
import { btqChain } from '../chains/btq';
import { evmChain } from '../chains/evm';
import { createLogger } from '../lib/logger';
import type { Persona } from './personas';

const log = createLogger('sim-fund');

/** Give a persona a node wallet, ETH for gas, USDT and BTQ (devnet faucet = the platform). */
export async function fundPersona(p: Persona, opts: { usdtUnits: bigint; btqSats: bigint }): Promise<void> {
  const btq = btqChain();
  const evm = evmChain();
  const w = await btq.ensureWallet(p.btqWallet);
  p.btqAddress ??= await w.call<string>('getnewaddress', ['receive']);

  const eth = await evm.ethBalance(p.evmAddress);
  if (eth < parseEther('1')) await evm.platformSendEth(p.evmAddress, parseEther('5'));
  const usdt = await evm.tokenBalance(p.evmAddress);
  if (usdt < opts.usdtUnits) await evm.platformTransferToken(p.evmAddress, opts.usdtUnits - usdt);
  const bal = BigInt(Math.round((await w.call<number>('getbalance', ['*', 0])) * 1e8));
  if (bal < opts.btqSats) {
    await btq.platformSend(p.btqAddress, opts.btqSats - bal + 1_000_000n, `fund ${p.name}`);
  }
  log.info(`funded ${p.name}`, { evm: p.evmAddress, btq: p.btqAddress, network: config().BTQ_NETWORK });
}

export function linkBlobs(p: Persona, signature: Uint8Array): { pubkey: string; signature: string } {
  return { pubkey: toBase64(p.htlc.publicKey), signature: toBase64(signature) };
}
