import { agreementId, htlcAddress, parseSolHtlcState } from '../chains/solana-htlc';
import { solanaProgramAddress, solanaProgramId, withSolana } from '../chains/solana';
import { createLogger } from '../lib/logger';
import { observeSolanaAccount } from '../domain/settlement';

const log = createLogger('solana-watcher');

export const solanaStatus = { slot: 0, lastTickAt: 0, reachable: false };

export async function solanaTick(): Promise<void> {
  if (!solanaProgramAddress()) {
    solanaStatus.reachable = false;
    return;
  }
  const programId = solanaProgramId();
  const accounts = await withSolana(async (connection) => {
    solanaStatus.slot = await connection.getSlot('confirmed');
    solanaStatus.lastTickAt = Date.now();
    solanaStatus.reachable = true;
    return connection.getProgramAccounts(programId, { commitment: 'confirmed' });
  });
  for (const row of accounts) {
    const state = parseSolHtlcState(Buffer.from(row.account.data));
    if (!state) continue;
    const computed = agreementId(state.partyA, state.partyB, state.mint, state.amount, state.secretHash, state.deadline);
    const expected = htlcAddress(programId, computed);
    if (!expected.equals(row.pubkey)) continue;
    try {
      await observeSolanaAccount({
        partyA: state.partyA.toBase58(),
        partyB: state.partyB.toBase58(),
        mint: state.mint.toBase58(),
        secretHashHex: state.secretHash.toString('hex'),
        deadline: Number(state.deadline),
        amount: state.amount,
        withdrawn: state.withdrawn,
        refunded: state.refunded,
        preimageHex: state.withdrawn ? state.preimage.toString('hex') : '',
        agreementHex: computed.toString('hex'),
        signature: null,
      });
    } catch (err) {
      log.error('solana account skipped', { account: row.pubkey.toBase58(), err: (err as Error).message });
    }
  }
}
