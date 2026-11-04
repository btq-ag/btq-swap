import { getOne, query } from '../lib/db';

interface ConfigRow {
  key: string;
  value: unknown;
}

export class PriceService {
  async getConfig(key: string): Promise<unknown> {
    const row = await getOne<ConfigRow>('SELECT value FROM config WHERE key = $1', [key]);
    return row?.value ?? null;
  }

  async setConfig(key: string, value: unknown, updatedBy?: string): Promise<void> {
    await query(
      `INSERT INTO config (key, value, updated_by, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = now()`,
      [key, JSON.stringify(value), updatedBy ?? null],
    );
  }

  async getBidPrice(): Promise<string> {
    const val = await this.getConfig('btq_usdt_bid');
    return String(val ?? '0');
  }

  async getAskPrice(): Promise<string> {
    const val = await this.getConfig('btq_usdt_ask');
    return String(val ?? '0');
  }

  async getSpread(): Promise<string> {
    const val = await this.getConfig('spread_pct');
    return String(val ?? '0');
  }

  async getPriceForDirection(direction: 'buy_btq' | 'sell_btq'): Promise<string> {
    return direction === 'buy_btq' ? this.getAskPrice() : this.getBidPrice();
  }

  async getMinSwapBtq(): Promise<string> {
    const val = await this.getConfig('min_swap_btq');
    return String(val ?? '1.0');
  }

  async getMaxSwapBtq(): Promise<string> {
    const val = await this.getConfig('max_swap_btq');
    return String(val ?? '10000.0');
  }

  async getPlatformFeePct(): Promise<string> {
    const val = await this.getConfig('platform_fee_pct');
    return String(val ?? '0.001');
  }

  async isSwapsPaused(): Promise<boolean> {
    const val = await this.getConfig('swaps_paused');
    return val === true || val === 'true';
  }

  async getAllConfig(): Promise<Record<string, unknown>> {
    const rows = await query<ConfigRow>('SELECT key, value FROM config ORDER BY key');
    const result: Record<string, unknown> = {};
    for (const row of rows.rows) {
      result[row.key] = row.value;
    }
    return result;
  }
}

export const priceService = new PriceService();
