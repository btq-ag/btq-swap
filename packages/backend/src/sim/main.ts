/**
 * BTQ Swap simulation suite — real HTLC swaps on BTQ regtest + local EVM, driven through the Discord bot pipeline.
 *
 *   npm run sim -w packages/backend -- --scenario all [--salt run1] [--mirror-discord] [--burst 6]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, feedChannelId } from '../config';
import { DiscordRest } from '../discord/rest';
import { closePool } from '../lib/db';
import { evmChain } from '../chains/evm';
import { resolveEvmAddresses } from '../domain/runtime';
import { ChainOps } from './chainops';
import { Driver, type TranscriptLine } from './driver';
import { SimContext } from './scenarios';
import { SCENARIOS, runScenario } from './suite';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
}

class DiscordMirror {
  private buf: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private threadId: string | null = null;
  constructor(private readonly rest: DiscordRest, private readonly channel: string) {}

  async open(title: string, intro: string): Promise<void> {
    await this.rest.postMessage(this.channel, { embeds: [{ title, description: intro, color: 0x8b5cf6 }] });
    this.threadId = await this.rest.createThread(this.channel, `${title} — transcripts`);
    this.timer = setInterval(() => void this.flush(), 4000);
  }

  line(l: TranscriptLine): void {
    const icon = l.outcome.startsWith('ok') ? '✅' : '⚠️';
    this.buf.push(`${icon} **${l.persona}** \`${l.action.slice(0, 120)}\`\n> ${l.summary.replace(/\n/g, ' ').slice(0, 220)}`);
  }

  async flush(): Promise<void> {
    if (!this.threadId || !this.buf.length) return;
    let msg = '';
    while (this.buf.length && msg.length + this.buf[0]!.length < 1900) msg += this.buf.shift()! + '\n';
    if (!msg) msg = this.buf.shift()!.slice(0, 1900);
    await this.rest.postMessage(this.threadId, { content: msg, allowed_mentions: { parse: [] } }).catch(() => undefined);
  }

  async close(summary: Record<string, unknown>): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    while (this.buf.length) await this.flush();
    await this.rest.postMessage(this.channel, { embeds: [summary] }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const c = config();
  await resolveEvmAddresses();
  const apiUrl = process.env.SIM_API_URL ?? `http://127.0.0.1:${c.PORT}/api`;
  const salt = arg('salt', `run-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`)!;
  if (arg('burst')) process.env.SIM_BURST = arg('burst');
  const which = (arg('scenario', 'all') ?? 'all').split(',');
  const selected = SCENARIOS.filter((s) => which.includes('all') || which.includes(s.name));
  if (!selected.length) throw new Error(`no scenario matches ${which.join(',')}; known: ${SCENARIOS.map((s) => s.name).join(', ')}`);

  const health = await fetch(`${apiUrl}/health`).catch(() => null);
  if (!health?.ok) throw new Error(`API not reachable at ${apiUrl}`);

  const driver = new Driver();
  const ops = new ChainOps(apiUrl, c.EVM_RPC_URL, c.EVM_CHAIN_ID);
  const started = new Date();
  const logLines: string[] = [];
  const log = (m: string) => {
    const line = `${new Date().toISOString().slice(11, 19)} ${m}`;
    logLines.push(line);
    console.log(line);
  };
  driver.onLine = (l) => log(`    ${l.persona} ${l.action} → ${l.outcome}`);

  let mirror: DiscordMirror | null = null;
  const channel = feedChannelId(c);
  if (arg('mirror-discord') && c.DISCORD_BOT_TOKEN && channel) {
    mirror = new DiscordMirror(new DiscordRest(c.DISCORD_BOT_TOKEN), channel);
    await mirror.open(
      `🧪 Simulation ${salt}`,
      `Running ${selected.length} scenarios with real HTLCs on BTQ **${c.BTQ_NETWORK}** and EVM chain **${c.EVM_CHAIN_ID}**. ` +
        `Every simulated user goes through the same \`/swap\` handlers as you do; their private replies are mirrored in the thread below. ` +
        `Each swap's live card appears in this channel.\n\n${selected.map((s) => `• **${s.name}** — ${s.description}`).join('\n')}`,
    );
    const prev = driver.onLine;
    driver.onLine = (l) => {
      prev?.(l);
      mirror!.line(l);
    };
  }

  const sx = new SimContext(driver, ops, apiUrl, c.ADMIN_TOKEN, evmChain().addresses().token, log);
  log(`simulation ${salt}: ${selected.map((s) => s.name).join(', ')}`);

  const long = selected.filter((s) => s.phase === 'long');
  const serial = selected.filter((s) => s.phase === 'serial');
  const longRuns = Promise.all(long.map((s) => runScenario(sx, s, salt)));
  const serialResults = [];
  for (const s of serial) serialResults.push(await runScenario(sx, s, salt));
  const results = [...serialResults, ...(await longRuns)];

  const ok = results.every((r) => r.ok);
  const durationSec = Math.round((Date.now() - started.getTime()) / 1000);
  const allSwaps = results.flatMap((r) => r.swaps);
  const report = {
    run: salt,
    startedAt: started.toISOString(),
    durationSec,
    ok,
    networks: { btq: c.BTQ_NETWORK, evmChainId: c.EVM_CHAIN_ID, htlcContract: evmChain().addresses().htlc, token: evmChain().addresses().token },
    scenarios: results,
    swaps: allSwaps,
    interactions: driver.transcript.length,
    transcript: driver.transcript,
  };
  const dir = arg('report-dir', process.env.SIM_REPORT_DIR ?? join(process.cwd(), 'sim-reports'))!;
  mkdirSync(dir, { recursive: true });
  const base = join(dir, `sim-${salt}`);
  writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
  const md = [
    `# BTQ Swap simulation ${salt}`,
    '',
    `- Started: ${started.toISOString()} · duration ${durationSec}s · **${ok ? 'ALL PASSED' : 'FAILURES'}**`,
    `- BTQ ${c.BTQ_NETWORK} · EVM chain ${c.EVM_CHAIN_ID} · HtlcERC20 ${evmChain().addresses().htlc}`,
    `- Discord interactions executed through the bot pipeline: ${driver.transcript.length}`,
    '',
    '| Scenario | Result | Checks | Swaps | Time |',
    '|---|---|---|---|---|',
    ...results.map((r) => `| ${r.name} | ${r.ok ? '✅ pass' : `❌ ${r.error}`} | ${r.checks.filter((x) => x.ok).length}/${r.checks.length} | ${r.swaps.map((s) => `#${s.shortId} ${s.finalStatus}`).join(', ')} | ${Math.round(r.durationMs / 1000)}s |`),
    '',
    '## Swaps and on-chain transactions',
    '',
    '| Swap | Parties | Final | EVM lock | EVM claim/refund | BTQ lock | BTQ claim/refund | Preimage |',
    '|---|---|---|---|---|---|---|---|',
    ...allSwaps.map((s) => `| #${s.shortId} | ${s.role} | ${s.finalStatus} | ${s.evmLockTx ?? '—'} | ${s.evmClaimTx ?? s.evmRefundTx ?? '—'} | ${s.btqLockTxid ?? '—'} | ${s.btqClaimTxid ?? s.btqRefundTxid ?? '—'} | ${s.preimage ?? '—'} |`),
    '',
    '## Checks',
    '',
    ...results.flatMap((r) => [`### ${r.name}`, ...r.checks.map((x) => `- ${x.ok ? '✅' : '❌'} ${x.name}${x.detail ? ` — ${x.detail}` : ''}`), '']),
  ].join('\n');
  writeFileSync(`${base}.md`, md);
  console.log(`\n${md.split('## Swaps')[0]}`);
  console.log(`report: ${base}.md / .json`);

  await mirror?.close({
    title: `${ok ? '✅' : '❌'} Simulation ${salt}: ${results.filter((r) => r.ok).length}/${results.length} scenarios passed`,
    description: results.map((r) => `${r.ok ? '✅' : '❌'} **${r.name}** — ${r.swaps.map((s) => `#${s.shortId} ${s.finalStatus}`).join(', ') || 'no swap'}${r.ok ? '' : `\n> ${r.error}`}`).join('\n').slice(0, 4000),
    color: ok ? 0x10b981 : 0xef4444,
    footer: { text: `${allSwaps.length} swaps · ${driver.transcript.length} Discord interactions · ${durationSec}s` },
  });
  await closePool();
  process.exit(ok ? 0 : 1);
}

main().catch(async (err) => {
  console.error('[sim] fatal', err);
  await closePool().catch(() => undefined);
  process.exit(1);
});
