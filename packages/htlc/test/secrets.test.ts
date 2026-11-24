import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSecretFile, deploymentUrl, loadSecretFile, markSecretUsed, scopedSecretPath } from '../src/secrets.js';

describe('deployment and UUID scoped secrets (#11)', () => {
  let home: string;
  const api = 'https://swap.example/api';
  const id = '11111111-2222-3333-4444-555555555555';
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'btq-secret-test-')); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  it('separates equal short IDs across deployments and database resets', () => {
    const a = createSecretFile(home, api, id, 1);
    const b = createSecretFile(home, 'https://other.example/api', id, 1);
    const c = createSecretFile(home, api, '11111111-2222-3333-4444-666666666666', 1);
    expect(new Set([a.secretHash, b.secretHash, c.secretHash]).size).toBe(3);
    expect(loadSecretFile(home, api + '/', id)).toEqual(a);
    expect(statSync(scopedSecretPath(home, api, id)).mode & 0o777).toBe(0o600);
  });
  it('refuses reuse or overwrite and persists the original secret', () => {
    const a = createSecretFile(home, api, id, 1);
    expect(() => createSecretFile(home, api, id, 1)).toThrow(/already exists/);
    expect(loadSecretFile(home, api, id)).toEqual(a);
    markSecretUsed(home, a, 'agreement');
    expect(() => markSecretUsed(home, a, 'different-deadline')).toThrow(/already used/);
    expect(JSON.parse(readFileSync(join(home, 'used-hashes', `${a.secretHash}.json`), 'utf8')).agreementId).toBe('agreement');
  });
  it.each(['preimage', 'secretHash', 'swapId', 'deployment', 'version'])('rejects a corrupted %s', field => {
    const a = createSecretFile(home, api, id, 1);
    writeFileSync(scopedSecretPath(home, api, id), JSON.stringify({ ...a, [field]: '00'.repeat(32) }));
    expect(() => loadSecretFile(home, api, id)).toThrow(/scope or hash/);
  });
  it('does not load legacy short-id files and rejects unsafe scopes', () => {
    expect(() => loadSecretFile(home, api, id)).toThrow();
    expect(() => scopedSecretPath(home, api, '../1')).toThrow(/UUID/);
    expect(() => deploymentUrl('https://a:b@example/api')).toThrow();
    expect(() => deploymentUrl(api + '?secret=x')).toThrow();
  });
});
