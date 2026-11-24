import { expect, test } from '@playwright/test';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';

test('reopens an existing swap from its URL after reload and imports its old lock receipt', async ({ page }) => {
  let recovered = false;
  let imported: unknown;
  let prepared: unknown;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => sessionStorage.setItem('btq-desk-token', 'test-session'));
  const book = { bids: [], asks: [], topBids: [], topAsks: [], bestBid: null, bestAsk: null, paused: false };
  const profile = { eth: null, sol: '11111111111111111111111111111111', btq: 'qcrt1test', solLinked: true, evmLinked: false, btqLinked: true, tos: true };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown = {};
    if (path.endsWith('/desk/me')) json = { profile };
    else if (path.endsWith('/monitor')) json = { book, stats: { volumeBtq: '0' }, settlementRail: 'evm', chains: { btq: { tip: 100, targetBlockSec: 5 }, evm: { head: 100 } } };
    else if (path.endsWith('/book')) json = book;
    else if (path.includes('/candles')) json = { candles: [] };
    else if (path.endsWith('/swaps/7')) json = { swap: { shortId: 7, evm: { deadline: new Date().toISOString() }, btq: {}, deadlines: {}, steps: [] }, events: [] };
    else if (path.endsWith('/swaps/7/plan')) json = { shortId: 7, rail: 'solana', status: recovered ? 'awaiting_buyer_refund' : 'expired', role: 'buyer', solRefund: recovered, solLock: false, solClaim: false, btqClaim: false };
    else if (path.endsWith('/swaps/7/sol/recover')) { imported = route.request().postDataJSON(); recovered = true; json = { agreementId: 'recovered' }; }
    else if (path.endsWith('/swaps/7/sol/prepare')) {
      prepared = route.request().postDataJSON();
      await route.fulfill({ status: 400, json: { error: 'Stop before opening a real wallet in this browser test.' } }); return;
    } else throw new Error(`Unexpected API call ${path}`);
    await route.fulfill({ json });
  });
  await page.goto('/?swap=7');
  await expect(page.getByRole('heading', { name: 'Swap #7', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Swap #7', exact: true })).toBeVisible();
  await page.getByText('Already locked tokens? Recover an existing transaction').click();
  await page.getByLabel('Solana lock transaction signature').fill('1'.repeat(88));
  await page.getByRole('button', { name: 'Recover existing lock', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refund tokens', exact: true })).toBeVisible();
  expect(imported).toEqual({ signature: '1'.repeat(88) });
  // A Solana-only account must be able to initiate its refund without an EVM address.
  await page.getByRole('button', { name: 'Refund tokens', exact: true }).click();
  await expect.poll(() => prepared).toEqual({ action: 'refund' });
  expect(errors).toEqual([]);
});

test('selects an existing swap by number and exposes a BTQ claim lost in a reorg', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('btq-desk-token', 'test-session'));
  const book = { bids: [], asks: [], topBids: [], topAsks: [], bestBid: null, bestAsk: null, paused: false };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown = {};
    if (path.endsWith('/desk/me')) json = { profile: { eth: '0x123', sol: null, btq: 'qcrt1test', evmLinked: true, btqLinked: true, tos: true } };
    else if (path.endsWith('/monitor')) json = { book, stats: { volumeBtq: '0' }, settlementRail: 'evm', chains: { btq: { tip: 100, targetBlockSec: 5 }, evm: { head: 100 } } };
    else if (path.endsWith('/book')) json = book;
    else if (path.includes('/candles')) json = { candles: [] };
    else if (path.endsWith('/swaps/8')) json = { swap: { shortId: 8, btq: { refundLocktime: 120 }, evm: {}, deadlines: {}, steps: [] }, events: [] };
    else if (path.endsWith('/swaps/8/plan')) json = { shortId: 8, rail: 'evm', status: 'awaiting_seller_claim', role: 'buyer', btqClaim: true };
    else throw new Error(`Unexpected API call ${path}`);
    await route.fulfill({ json });
  });
  await page.goto('/');
  await page.getByLabel('Existing swap number or ID').fill('8');
  await page.getByRole('button', { name: 'Open swap', exact: true }).click();
  await expect(page).toHaveURL(/\?swap=8$/);
  await expect(page.getByRole('heading', { name: 'Claim the BTQ', exact: true })).toBeVisible();
  await expect(page.getByText(/btq-htlc claim --swap 8/)).toBeVisible();
});

test('ignores a recovery response after navigating back to a different swap', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let recoveryStarted = false;
  let recovered = false;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => sessionStorage.setItem('btq-desk-token', 'test-session'));
  const book = { bids: [], asks: [], topBids: [], topAsks: [], bestBid: null, bestAsk: null, paused: false };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown = {};
    if (path.endsWith('/desk/me')) json = { profile: { eth: null, sol: '11111111111111111111111111111111', btq: 'qcrt1test', solLinked: true, btqLinked: true, tos: true } };
    else if (path.endsWith('/monitor')) json = { book, stats: { volumeBtq: '0' }, settlementRail: 'evm', chains: { btq: { tip: 100 }, evm: { head: 100 } } };
    else if (path.endsWith('/book')) json = book;
    else if (path.includes('/candles')) json = { candles: [] };
    else if (/\/swaps\/[78]$/.test(path)) json = { swap: { shortId: Number(path.at(-1)), rail: 'solana', evm: {}, btq: {}, deadlines: {}, steps: [] } };
    else if (/\/swaps\/[78]\/plan$/.test(path)) {
      const id = Number(path.split('/').at(-2));
      json = { shortId: id, rail: 'solana', status: 'expired', role: 'buyer', solRefund: id === 8 && recovered };
    } else if (path.endsWith('/swaps/8/sol/recover')) { recoveryStarted = true; await pending; recovered = true; }
    else throw new Error(`Unexpected API call ${path}`);
    await route.fulfill({ json });
  });
  await page.goto('/?swap=7');
  await expect(page.getByRole('heading', { name: 'Swap #7', exact: true })).toBeVisible();
  await page.getByLabel('Existing swap number or ID').fill('8');
  await page.getByRole('button', { name: 'Open swap', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Swap #8', exact: true })).toBeVisible();
  await page.getByText('Already locked tokens? Recover an existing transaction').click();
  await page.getByLabel('Solana lock transaction signature').fill('1'.repeat(88));
  await page.getByRole('button', { name: 'Recover existing lock', exact: true }).click();
  await expect.poll(() => recoveryStarted).toBe(true);
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Swap #7', exact: true })).toBeVisible();
  const response = page.waitForResponse('**/swaps/8/sol/recover');
  release();
  await response;
  await expect(page.getByText('Existing escrow recovered. Its confirmed state is shown here.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Refund tokens', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Swap #7', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('retries a stored signed lock after reload without requesting another wallet signature', async ({ page }) => {
  const buyer = Keypair.generate();
  const transaction = new Transaction({ recentBlockhash: Keypair.generate().publicKey.toBase58(), feePayer: buyer.publicKey })
    .add(SystemProgram.transfer({ fromPubkey: buyer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
  transaction.sign(buyer);
  const signedTx = transaction.serialize().toString('base64');
  let submitted: unknown;
  await page.addInitScript(() => {
    sessionStorage.setItem('btq-desk-token', 'test-session');
    sessionStorage.setItem('btq-secret-9', JSON.stringify({ secretHash: 'ab'.repeat(32) }));
  });
  const book = { bids: [], asks: [], topBids: [], topAsks: [], bestBid: null, bestAsk: null, paused: false };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown = {};
    if (path.endsWith('/desk/me')) json = { profile: { eth: null, sol: buyer.publicKey.toBase58(), btq: 'qcrt1test', solLinked: true, btqLinked: true, tos: true } };
    else if (path.endsWith('/monitor')) json = { book, stats: { volumeBtq: '0' }, settlementRail: 'solana', chains: { btq: { tip: 100 }, evm: { head: 100 } } };
    else if (path.endsWith('/book')) json = book;
    else if (path.includes('/candles')) json = { candles: [] };
    else if (path.endsWith('/swaps/9')) json = { swap: { shortId: 9, rail: 'solana', evm: {}, btq: {}, deadlines: {}, steps: [] } };
    else if (path.endsWith('/swaps/9/plan')) json = { shortId: 9, rail: 'solana', status: 'awaiting_buyer_lock', role: 'buyer', solLock: true };
    else if (path.endsWith('/swaps/9/sol/prepare')) json = { tx: signedTx, preparationId: 'original-preparation', signed: true };
    else if (path.endsWith('/swaps/9/sol/submit')) { submitted = route.request().postDataJSON(); json = { signature: 'originalSignature' }; }
    else throw new Error(`Unexpected API call ${path}`);
    await route.fulfill({ json });
  });
  await page.goto('/?swap=9');
  await expect(page.getByRole('button', { name: 'Lock tokens', exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Lock tokens', exact: true }).click();
  await expect.poll(() => submitted).toEqual({ preparationId: 'original-preparation', signedTx });
  await expect(page.getByText('Solana transaction original confirmed.', { exact: true })).toBeVisible();
});

test('returns to wallet sign-in when recovery rejects an expired session', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('btq-desk-token', 'test-session'));
  const book = { bids: [], asks: [], topBids: [], topAsks: [], bestBid: null, bestAsk: null, paused: false };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown = {};
    if (path.endsWith('/desk/me')) json = { profile: { eth: null, sol: '11111111111111111111111111111111', btq: 'qcrt1test', solLinked: true, btqLinked: true, tos: true } };
    else if (path.endsWith('/monitor')) json = { book, stats: { volumeBtq: '0' }, settlementRail: 'solana', chains: { btq: {}, evm: {} } };
    else if (path.endsWith('/book')) json = book;
    else if (path.includes('/candles')) json = { candles: [] };
    else if (path.endsWith('/swaps/7')) json = { swap: { shortId: 7, rail: 'solana', evm: {}, btq: {}, deadlines: {}, steps: [] } };
    else if (path.endsWith('/swaps/7/plan')) json = { shortId: 7, rail: 'solana', status: 'expired', role: 'buyer' };
    else if (path.endsWith('/swaps/7/sol/recover')) { await route.fulfill({ status: 401, json: { error: 'Session expired' } }); return; }
    else throw new Error(`Unexpected API call ${path}`);
    await route.fulfill({ json });
  });
  await page.goto('/?swap=7');
  await page.getByText('Already locked tokens? Recover an existing transaction').click();
  await page.getByLabel('Solana lock transaction signature').fill('1'.repeat(88));
  await page.getByRole('button', { name: 'Recover existing lock', exact: true }).click();
  await expect(page.getByText('Connect your linked wallet to reopen an existing swap.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open swap', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => sessionStorage.getItem('btq-desk-token'))).toBeNull();
});

test('keeps wallet actions disabled while a new swap changes its own URL', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let preparations = 0;
  await page.addInitScript(() => sessionStorage.setItem('btq-desk-token', 'test-session'));
  const book = { bids: [], asks: [{ price: '1', amountBtq: '1', orders: 1 }], topBids: [], topAsks: [{ orderNo: 1, price: '1', remainingBtq: '1' }], bestBid: null, bestAsk: '1', paused: false };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown = {};
    if (path.endsWith('/desk/me')) json = { profile: { eth: null, sol: '11111111111111111111111111111111', btq: 'qcrt1test', solLinked: true, btqLinked: true, tos: true } };
    else if (path.endsWith('/monitor')) json = { book, stats: { volumeBtq: '0' }, settlementRail: 'solana', chains: { btq: {}, evm: {} } };
    else if (path.endsWith('/book')) json = book;
    else if (path.includes('/candles')) json = { candles: [] };
    else if (path.endsWith('/desk/take')) json = { shortId: 9 };
    else if (path.endsWith('/swaps/9')) json = { swap: { shortId: 9, rail: 'solana', evm: {}, btq: {}, deadlines: {}, steps: [] } };
    else if (path.endsWith('/swaps/9/plan')) json = { shortId: 9, rail: 'solana', status: 'awaiting_buyer_lock', role: 'buyer', solLock: true };
    else if (path.endsWith('/swaps/9/sol/prepare')) { preparations++; await pending; await route.fulfill({ status: 400, json: { error: 'Test stops before wallet signing' } }); return; }
    else throw new Error(`Unexpected API call ${path}`);
    await route.fulfill({ json });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Review order', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Lock USDT', exact: true }).click();
  await expect.poll(() => preparations).toBe(1);
  await expect(page).toHaveURL(/\?swap=9$/);
  await expect(page.getByRole('button', { name: 'Locking USDT', exact: true })).toBeDisabled();
  release();
  await expect(page.getByRole('button', { name: 'Lock tokens', exact: true })).toBeEnabled();
  expect(preparations).toBe(1);
});

test('resumes BTQ funding for a Solana-only seller', async ({ page }) => {
  let sent: unknown;
  let noted: unknown;
  await page.exposeFunction('sendTestBtq', (input: unknown) => { sent = input; return { txid: 'ab'.repeat(32) }; });
  await page.addInitScript(() => {
    sessionStorage.setItem('btq-desk-token', 'test-session');
    Object.assign(window, { btq: { connect: async () => [], requestSend: (input: unknown) => (window as any).sendTestBtq(input) } });
  });
  const book = { bids: [], asks: [], topBids: [], topAsks: [], bestBid: null, bestAsk: null, paused: false };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown = {};
    if (path.endsWith('/desk/me')) json = { profile: { eth: null, sol: '11111111111111111111111111111111', btq: 'qcrt1test', solLinked: true, btqLinked: true, tos: true } };
    else if (path.endsWith('/monitor')) json = { book, stats: { volumeBtq: '0' }, settlementRail: 'solana', chains: { btq: {}, evm: {} } };
    else if (path.endsWith('/book')) json = book;
    else if (path.includes('/candles')) json = { candles: [] };
    else if (path.endsWith('/swaps/7')) json = { swap: { shortId: 7, rail: 'solana', evm: {}, btq: {}, deadlines: {}, steps: [] } };
    else if (path.endsWith('/swaps/7/plan')) json = { shortId: 7, rail: 'solana', status: 'awaiting_seller_lock', role: 'seller', btqSend: { address: 'qcrt1escrow', amountSats: '100000000', amountBtq: '1' } };
    else if (path.endsWith('/swaps/7/btq-lock')) { noted = route.request().postDataJSON(); json = { ok: true }; }
    else throw new Error(`Unexpected API call ${path}`);
    await route.fulfill({ json });
  });
  await page.goto('/?swap=7');
  await page.getByRole('button', { name: 'Send BTQ', exact: true }).click();
  await expect.poll(() => sent).toEqual({ to: 'qcrt1escrow', amountSats: '100000000' });
  await expect.poll(() => noted).toEqual({ txid: 'ab'.repeat(32) });
});
