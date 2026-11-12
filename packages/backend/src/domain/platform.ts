import { bytesToHex } from '@btq-swap/htlc';
import { config } from '../config';
import { btqChain } from '../chains/btq';
import { evmChain } from '../chains/evm';
import { db, one } from '../lib/db';
import { createLogger } from '../lib/logger';
import { platformHtlcSigner } from './runtime';
import type { UserRow } from './types';

const log = createLogger('platform');

/** The operator's market maker is an ordinary user row with is_platform = true. */
export async function ensurePlatformUser(): Promise<UserRow> {
  const c = config();
  await btqChain().ensureWallet(c.BTQ_PLATFORM_WALLET);
  const pk = bytesToHex(platformHtlcSigner().publicKey);
  const eth = evmChain().platformAddress.toLowerCase();
  const existing = await one<UserRow>(db(), 'SELECT * FROM users WHERE is_platform = true');
  const btqAddress = existing?.btq_address ?? (await btqChain().platformAddress('btq-swap-platform'));
  const row = existing
    ? await one<UserRow>(
        db(),
        `UPDATE users SET eth_address = $2, dilithium_pubkey = $3, btq_address = $4, eth_verified_at = COALESCE(eth_verified_at, now()),
                btq_pubkey_verified_at = COALESCE(btq_pubkey_verified_at, now()), tos_accepted_at = COALESCE(tos_accepted_at, now()),
                tos_version = $5, discord_username = 'BTQ MM', updated_at = now()
          WHERE id = $1 RETURNING *`,
        [existing.id, eth, pk, btqAddress, c.TOS_VERSION],
      )
    : await one<UserRow>(
        db(),
        `INSERT INTO users (discord_username, is_platform, eth_address, eth_verified_at, dilithium_pubkey, btq_pubkey_verified_at, btq_address, tos_accepted_at, tos_version)
         VALUES ('BTQ MM', true, $1, now(), $2, now(), $3, now(), $4) RETURNING *`,
        [eth, pk, btqAddress, c.TOS_VERSION],
      );
  log.info('platform user ready', { eth, btqAddress });
  return row!;
}
