import { expect, test } from '@playwright/test';

test('takes the resting order by short_id, not ladder rank', async ({ page }) => {
  let taken: unknown;
  await page.addInitScript(() => sessionStorage.setItem('btq-desk-token', 'test-session'));
  const book = {
    bids: [{ price: '1.00', amountBtq: '15', orders: 2, mm: false }],
    asks: [{ price: '1.10', amountBtq: '5', orders: 1, mm: true }],
    topBids: [
      { orderNo: 42, side: 'buy', price: '1.00', remainingBtq: '10', mm: false },
      { orderNo: 99, side: 'buy', price: '1.00', remainingBtq: '5', mm: false },
    ],
    topAsks: [{ orderNo: 7, side: 'sell', price: '1.10', remainingBtq: '5', mm: true }],
    bestBid: '1.00',
    bestAsk: '1.10',
    paused: false,
  };
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown = {};
    if (path.endsWith('/desk/me')) {
      json = { profile: { eth: '0x123', sol: null, btq: 'qcrt1test', evmLinked: true, btqLinked: true, tos: true } };
    } else if (path.endsWith('/monitor')) {
      json = { book, stats: { volumeBtq: '0' }, settlementRail: 'evm', chains: { btq: { tip: 100, targetBlockSec: 5 }, evm: { head: 100 } } };
    } else if (path.endsWith('/book')) json = book;
    else if (path.includes('/candles')) json = { candles: [] };
    else if (path.endsWith('/desk/take')) {
      taken = route.request().postDataJSON();
      json = { shortId: 99, status: 'awaiting_seller_lock' };
    } else if (path.endsWith('/swaps/99/plan') || path.endsWith('/swaps/99')) {
      json = { shortId: 99, rail: 'evm', status: 'awaiting_seller_lock', role: 'seller', btqSend: { address: 'qcrt1htlc', amountSats: '1000000000', amountBtq: '10' } };
    } else throw new Error(`Unexpected API call ${path}`);
    await route.fulfill({ json });
  });
  await page.goto('/');
  await page.getByRole('tab', { name: 'Sell BTQ' }).click();
  await page.getByRole('button', { name: /1\.00/ }).nth(1).click();
  await page.getByRole('button', { name: 'Review order' }).click();
  await page.getByRole('button', { name: 'Lock BTQ' }).click();
  await expect.poll(() => taken).toMatchObject({ orderNo: 99 });
});
