import { describe, expect, it } from 'vitest';
import { consumeChallenge, issueChallenge } from '../src/domain/challenges';
import { db, tx } from '../src/lib/db';
import { databaseEnabled, testDatabase, testUser } from './database';

describe.skipIf(!databaseEnabled)('single-use challenge transactions (#12)', () => {
  testDatabase();
  it('selects the exact challenge and allows only one concurrent consumer', async () => {
    const user = await testUser();
    const issue = () => issueChallenge({ user_id: user.id, kind: 'sol', purpose: 'desk_signin',
      challenge: crypto.randomUUID(), message: 'message', target_address: 'address', expires_at: new Date(Date.now() + 60_000) });
    const id = await issue();
    const newer = await issue();
    const results = await Promise.allSettled([1, 2].map(() => tx(c => consumeChallenge(c, id, user.id, 'sol', 'desk_signin'))));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await db().query('SELECT consumed_at FROM link_challenges WHERE id = $1', [newer])).rows[0].consumed_at).toBeNull();
  });
  it('rolls back consumption with failed verification and rejects the wrong purpose', async () => {
    const user = await testUser();
    const id = await issueChallenge({ user_id: user.id, kind: 'evm', purpose: 'desk_link',
      challenge: crypto.randomUUID(), message: 'message', target_address: 'address', expires_at: new Date(Date.now() + 60_000) });
    await expect(tx(c => consumeChallenge(c, id, user.id, 'evm', 'desk_signin'))).rejects.toThrow(/challenge/);
    await expect(tx(async c => { await consumeChallenge(c, id, user.id, 'evm', 'desk_link'); throw new Error('bad signature'); })).rejects.toThrow('bad signature');
    await expect(tx(c => consumeChallenge(c, id, user.id, 'evm', 'desk_link'))).resolves.toMatchObject({ id });
  });
});
