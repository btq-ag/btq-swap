import { config } from '../config';
import { BtqRpcError } from '../types/btq.types';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface RpcResponse<T = unknown> {
  result: T | null;
  error: { code: number; message: string } | null;
  id: string | number;
}

export class BtqRpcClient {
  private baseUrl: string;
  private authHeader: string;
  private cookieAuthHeader: string | null = null;
  private idCounter = 0;

  constructor(
    host = config.BTQ_RPC_HOST,
    port = config.BTQ_RPC_PORT,
    user = config.BTQ_RPC_USER,
    pass = config.BTQ_RPC_PASS,
    private wallet = config.BTQ_RPC_WALLET,
  ) {
    this.baseUrl = `http://${host}:${port}`;
    this.authHeader = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  }

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const url = this.wallet
      ? `${this.baseUrl}/wallet/${this.wallet}`
      : this.baseUrl;

    const body = JSON.stringify({
      jsonrpc: '1.0',
      id: ++this.idCounter,
      method,
      params,
    });

    const requestWithAuth = async (authorization: string) => fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authorization,
      },
      body,
    });

    let response = await requestWithAuth(this.authHeader);
    if (response.status === 401) {
      const fallbackAuth = this.getCookieAuthHeader();
      if (fallbackAuth) {
        console.warn('[BtqRpc] RPC basic auth rejected, retrying with cookie auth');
        response = await requestWithAuth(fallbackAuth);
      }
    }

    if (!response.ok && response.status !== 500) {
      throw new BtqRpcError_(
        -1,
        `RPC HTTP error: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as RpcResponse<T>;

    if (data.error) {
      throw new BtqRpcError_(data.error.code, data.error.message);
    }

    return data.result as T;
  }

  private getCookieAuthHeader(): string | null {
    if (this.cookieAuthHeader) return this.cookieAuthHeader;
    const networkDir = config.BTQ_NETWORK === 'testnet'
      ? 'test'
      : config.BTQ_NETWORK === 'regtest'
        ? 'regtest'
        : '';
    const candidatePaths = [
      join(homedir(), '.btq', networkDir, '.cookie'),
      join(homedir(), '.btq', '.cookie'),
    ];
    for (const filePath of candidatePaths) {
      if (!existsSync(filePath)) continue;
      try {
        const cookie = readFileSync(filePath, 'utf8').trim();
        if (!cookie.includes(':')) continue;
        this.cookieAuthHeader = 'Basic ' + Buffer.from(cookie).toString('base64');
        return this.cookieAuthHeader;
      } catch {
        // try next path
      }
    }
    return null;
  }
}

export class BtqRpcError_ extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(`BTQ RPC Error (${code}): ${message}`);
    this.name = 'BtqRpcError';
  }

  toJSON(): BtqRpcError {
    return { code: this.code, message: this.message };
  }
}

export const btqRpc = new BtqRpcClient();
