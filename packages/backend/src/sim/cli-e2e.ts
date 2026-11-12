/**
 * Real-user path: the persona uses ONLY the published btq-htlc CLI + public endpoints
 * (public API, whitelisted EVM RPC proxy, BTQ broadcast endpoint) for every chain action,
 * and the Discord bot pipeline for every interaction. Two swaps: buy from the MM, sell to the MM.
 *
 *   SIM_PUBLIC_URL=http://208.85.23.103:5173 CLI_PATH=/app/packages/htlc/dist/btq-htlc.mjs node dist/sim/cli-e2e.js
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { config } from '../config';
import { btqChain } from '../chains/btq';
import { closePool } from '../lib/db';
import { resolveEvmAddresses } from '../domain/runtime';
import { Driver, embedText, expectOk, findButton, swapIdsFrom } from './driver';
import { fundPersona } from './fund';
import { persona } from './personas';

const pub = (process.env.SIM_PUBLIC_URL ?? 'http://127.0.0.1:5173').replace(/\/+$/, '');
const api = `${pub}/api`;
const rpc = `${api}/rpc/evm`;
const cliPath = process.env.CLI_PATH ?? '/app/packages/htlc/dist/btq-htlc.mjs';

function cli(home: string, args: string[], env: Record<string, string> = {}): Record<string, unknown> {
  const out = execFileSync('node', [cliPath, ...args, '--home', home, '--api', api], { encoding: 'utf8', env: { ...process.env, ...env } });
  console.log(`  $ btq-htlc ${args.join(' ')}\n${out.split('\n').map((l) => `    ${l}`).join('\n')}`);
  const json = /^\{[\s\S]*?\n\}/m.exec(out);
  return json ? (JSON.parse(json[0]) as Record<string, unknown>) : {};
}

async function status(id: number): Promise<string> {
  const r = await fetch(`${api}/public/swaps/${id}`);
  return ((await r.json()) as { swap: { status: string } }).swap.status;
}

async function waitFor(id: number, want: string[], ms = 300_000): Promise<string> {
  const end = Date.now() + ms;
  let last = '';
  while (Date.now() < end) {
    const s = await status(id);
    if (s !== last) console.log(`  swap #${id} → ${(last = s)}`);
    if (want.includes(s)) return s;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`swap #${id} stuck at ${last}`);
}

async function main(): Promise<void> {
  await resolveEvmAddresses();
  const home = mkdtempSync(join(tmpdir(), 'btq-htlc-'));
  const p = persona('cli-user', process.env.SIM_SALT ?? `cli-${Date.now()}`);
  await fundPersona(p, { usdtUnits: 100_000_000n, btqSats: 1_000_000_000n });
  const d = new Driver();
  d.onLine = (l) => console.log(`  [discord] ${l.persona} ${l.action} → ${l.outcome}`);

  // 1. swap key comes from the CLI, not from the simulator
  cli(home, ['keygen']);
  const key = JSON.parse(readFileSync(join(home, 'key.json'), 'utf8')) as { pubkey: string };

  // 2. onboarding through the bot
  const st = expectOk(await d.slash(p, 'swap', 'start'), 'start');
  expectOk(await d.click(p, findButton(st, (l) => l.startsWith('Accept')), 'Accept'), 'accept');
  const m1 = expectOk(await d.slash(p, 'swap', 'link-evm'), 'link-evm');
  const r1 = expectOk(await d.submit(p, m1.modal!.custom_id, { address: p.evmAddress }, 'EVM address'), 'evm addr');
  const message = /```\n([\s\S]+?)\n```/.exec(embedText(r1))![1]!;
  const m2 = expectOk(await d.click(p, findButton(r1, (l) => l === 'Paste signature'), 'Paste signature'), 'sig btn');
  expectOk(await d.submit(p, m2.modal!.custom_id, { signature: await new Wallet(p.evmKey).signMessage(message) }, 'signature'), 'evm sig');
  const r2 = expectOk(await d.slash(p, 'swap', 'link-btq'), 'link-btq');
  const challenge = /btq-htlc\.mjs link (\S+)/.exec(embedText(r2))![1]!;
  const link = cli(home, ['link', challenge]) as { pubkey: string; signature: string };
  if (link.pubkey !== key.pubkey) throw new Error('CLI link pubkey differs from key.json');
  const m3 = expectOk(await d.click(p, findButton(r2, (l) => l === 'Submit key'), 'Submit key'), 'key btn');
  expectOk(await d.submit(p, m3.modal!.custom_id, { pubkey: link.pubkey, signature: link.signature, address: p.btqAddress! }, 'BTQ key'), 'btq key');

  // 3. BUY from the MM: CLI secret + CLI EVM lock (through the public RPC proxy) + CLI claim (API broadcast)
  const form = expectOk(await d.slash(p, 'swap', 'buy'), 'buy');
  const placed = expectOk(await d.submit(p, form.modal!.custom_id, { amount: '1.25', price: 'market' }, 'buy 1.25'), 'buy submit');
  const buyId = swapIdsFrom(placed)[0]!;
  const fundReply = expectOk(await d.slash(p, 'swap', 'fund', { id: buyId }), 'fund');
  if (!embedText(fundReply).includes(`btq-htlc.mjs secret new --swap ${buyId}`)) throw new Error('fund reply lacks the CLI command');
  cli(home, ['secret', 'new', '--swap', String(buyId)]);
  cli(home, ['evm', 'lock', '--swap', String(buyId), '--evm-rpc', rpc, '--key', 'env:CLI_EVM_KEY'], { CLI_EVM_KEY: p.evmKey });
  await waitFor(buyId, ['awaiting_buyer_claim']);
  expectOk(await d.slash(p, 'swap', 'claim', { id: buyId }), 'claim');
  const claimed = cli(home, ['claim', '--swap', String(buyId), '--to', p.btqAddress!, '--broadcast']);
  if (!claimed.broadcast) throw new Error('CLI claim did not broadcast');
  await waitFor(buyId, ['completed']);

  // 4. SELL to the MM: BTQ from the user's own wallet (btq-cli equivalent), USDT collected with CLI evm claim
  const sform = expectOk(await d.slash(p, 'swap', 'sell'), 'sell');
  const splaced = expectOk(await d.submit(p, sform.modal!.custom_id, { amount: '0.75', price: 'market' }, 'sell 0.75'), 'sell submit');
  const sellId = swapIdsFrom(splaced)[0]!;
  await waitFor(sellId, ['awaiting_seller_lock']);
  const sfund = expectOk(await d.slash(p, 'swap', 'fund', { id: sellId }), 'fund seller');
  const cmd = /btq-cli -regtest sendtoaddress (\S+) (\S+)/.exec(embedText(sfund));
  if (!cmd) throw new Error('seller fund reply lacks the btq-cli command');
  const txid = await btqChain().wallet(p.btqWallet).call<string>('sendtoaddress', [cmd[1], cmd[2]]);
  console.log(`  $ btq-cli -regtest sendtoaddress ${cmd[1]} ${cmd[2]}\n    ${txid}`);
  await waitFor(sellId, ['awaiting_seller_claim']);
  cli(home, ['evm', 'claim', '--swap', String(sellId), '--evm-rpc', rpc, '--key', 'env:CLI_EVM_KEY'], { CLI_EVM_KEY: p.evmKey });
  await waitFor(sellId, ['completed']);
  console.log(`\nCLI E2E OK: swap #${buyId} (buy) and #${sellId} (sell) completed using only btq-htlc + public endpoints. config network=${config().BTQ_NETWORK}`);
  await closePool();
}

main().catch(async (e) => {
  console.error('CLI E2E FAILED:', e);
  await closePool().catch(() => undefined);
  process.exit(1);
});
