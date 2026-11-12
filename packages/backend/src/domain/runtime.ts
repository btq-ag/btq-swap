import { signerFromSeedHex, type DilithiumSigner } from '@btq-swap/htlc';
import { config } from '../config';
import { evmChain } from '../chains/evm';
import { db, one } from '../lib/db';
import { createLogger } from '../lib/logger';

const log = createLogger('runtime');

let platformSigner: DilithiumSigner | null = null;

export function platformHtlcSigner(): DilithiumSigner {
  if (!platformSigner) platformSigner = signerFromSeedHex(config().PLATFORM_HTLC_SEED.replace(/^0x/, ''));
  return platformSigner;
}

/**
 * Resolve EVM contract addresses: explicit env wins; on devnet fall back to the addresses
 * the bootstrap deployed (devnet_state). Waits until they exist.
 */
export async function resolveEvmAddresses(opts: { waitMs?: number } = {}): Promise<{ htlc: string; token: string }> {
  const c = config();
  const deadline = Date.now() + (opts.waitMs ?? 0);
  for (;;) {
    let htlc = c.HTLC_CONTRACT_ADDRESS;
    let token = c.USDT_TOKEN_ADDRESS;
    if ((!htlc || !token) && c.DEVNET) {
      const row = await one<{ value: { htlc: string; token: string } }>(db(), `SELECT value FROM devnet_state WHERE key = 'evm_contracts'`).catch(() => null);
      htlc = htlc ?? row?.value.htlc;
      token = token ?? row?.value.token;
    }
    if (htlc && token) {
      evmChain().setAddresses({ htlc, token });
      return { htlc, token };
    }
    if (Date.now() > deadline) throw new Error('HTLC_CONTRACT_ADDRESS / USDT_TOKEN_ADDRESS are not configured (and no devnet deployment found)');
    log.info('waiting for devnet contract deployment…');
    await new Promise((r) => setTimeout(r, 3000));
  }
}
