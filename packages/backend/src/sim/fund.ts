import { parseEther } from 'ethers';
import { toBase64 } from '@btq-swap/htlc';
import { config } from '../config';
import { btqChain } from '../chains/btq';
import { EvmChain, evmChain } from '../chains/evm';
import { DEFAULT_FAUCET_KEY } from '../devnet/bootstrap';
import { createLogger } from '../lib/logger';
import type { Persona } from './personas';

const log = createLogger('sim-fund');

let faucet: EvmChain | null = null;
function faucetEvm(): EvmChain {
  if (!faucet) {
    faucet = new EvmChain({ url: config().EVM_RPC_URL, chainId: config().EVM_CHAIN_ID, privateKey: process.env.DEVNET_FAUCET_EVM_KEY ?? DEFAULT_FAUCET_KEY });
    faucet.setAddresses(evmChain().addresses());
  }
  return faucet;
}

/** Give a persona a node wallet, ETH for gas, USDT and BTQ from the devnet faucet (never the platform's keys). */
export async function fundPersona(p: Persona, opts: { usdtUnits: bigint; btqSats: bigint }): Promise<void> {
  const btq = btqChain();
  const evm = faucetEvm();
  const fw = btq.wallet('faucet');
  const w = await btq.ensureWallet(p.btqWallet);
  p.btqAddress ??= await w.call<string>('getnewaddress', ['receive']);

  const eth = await evm.ethBalance(p.evmAddress);
  if (eth < parseEther('1')) await evm.platformSendEth(p.evmAddress, parseEther('5'));
  const usdt = await evm.tokenBalance(p.evmAddress);
  if (usdt < opts.usdtUnits) await evm.platformTransferToken(p.evmAddress, opts.usdtUnits - usdt);
  const balances = async () => {
    const b = await w.call<{ mine: { trusted: number; untrusted_pending: number } }>('getbalances');
    return { trusted: BigInt(Math.round(b.mine.trusted * 1e8)), pending: BigInt(Math.round(b.mine.untrusted_pending * 1e8)) };
  };
  const b0 = await balances();
  const bal = b0.trusted + b0.pending;
  if (bal < opts.btqSats) {
    await fw.call('sendtoaddress', [p.btqAddress, ((Number(opts.btqSats - bal) + 1_000_000) / 1e8).toFixed(8), `fund ${p.name}`]);
  }
  // the persona's node wallet only spends confirmed incoming coins: wait for the next block
  for (let k = 0; k < 60 && (await balances()).trusted < opts.btqSats; k++) await new Promise((r) => setTimeout(r, 1000));
  log.info(`funded ${p.name}`, { evm: p.evmAddress, btq: p.btqAddress, network: config().BTQ_NETWORK });
}

export function linkBlobs(p: Persona, signature: Uint8Array): { pubkey: string; signature: string } {
  return { pubkey: toBase64(p.htlc.publicKey), signature: toBase64(signature) };
}
