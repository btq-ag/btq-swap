import { getJson } from '../api';
import type { BtqProof } from './btqWallet';
import type { EvmLock } from './htlcTx';

const TOKEN_KEY = 'btq-desk-token';

export interface DeskProfile {
  eth: string | null;
  sol: string | null;
  btq: string | null;
  evmLinked: boolean;
  solLinked: boolean;
  btqLinked: boolean;
  tos: boolean;
}

export interface TakenSwap {
  shortId: number;
  status: string;
  role: 'buyer' | 'seller';
  price: string;
  amountBtq: string;
  amountUsdt: string;
}

export interface LockPlan {
  shortId: number;
  status: string;
  role: 'buyer' | 'seller';
  evmLock: EvmLock | null;
  btqSend: { address: string; amountSats: string; amountBtq: string } | null;
  usdtClaim: { agreementId: string; preimage: string } | null;
  usdtRefund: { agreementId: string } | null;
  solLock: boolean;
  solClaim: boolean;
  solRefund: boolean;
  contract: string;
  chainId: number;
}

export function deskToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function saveDeskToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearDeskToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

function authHeaders(): Record<string, string> {
  const token = deskToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

function post<T>(path: string, body: unknown, auth = false): Promise<T> {
  return getJson<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? authHeaders() : {}) },
    body: JSON.stringify(body),
  });
}

export const deskApi = {
  evmStart: (address: string) => post<{ message: string; expiresAt: string; profile: DeskProfile }>('/public/desk/evm/start', { address, acceptTos: true }),
  evmFinish: (address: string, signature: string) => post<{ token: string; expiresAt: string; profile: DeskProfile }>('/public/desk/evm/finish', { address, signature }),
  me: () => getJson<{ profile: DeskProfile }>('/public/desk/me', { headers: authHeaders() }),
  btqStart: () => post<{ challenge: string; expiresAt: string }>('/public/desk/btq/start', {}, true),
  btqFinish: (proof: BtqProof) => post<{ profile: DeskProfile }>('/public/desk/btq/finish', proof, true),
  take: (orderNo: number, amountBtq: string) => post<TakenSwap>('/public/desk/take', { orderNo, amountBtq }, true),
  plan: (ref: number | string) => getJson<LockPlan>(`/public/desk/swaps/${ref}/plan`, { headers: authHeaders() }),
  btqLock: (ref: number | string, txid: string) => post<{ ok: boolean }>(`/public/desk/swaps/${ref}/btq-lock`, { txid }, true),
  solStart: (address: string) => post<{ message: string; profile: DeskProfile }>('/public/desk/sol/start', { address, acceptTos: true }, !!deskToken()),
  solFinish: (address: string, signature: string) => post<{ token?: string; profile: DeskProfile }>('/public/desk/sol/finish', { address, signature }, !!deskToken()),
  solPrepare: (ref: number | string, action: 'lock' | 'withdraw' | 'refund', secretHash?: string) =>
    post<{ tx: string }>(`/public/desk/swaps/${ref}/sol/prepare`, { action, secretHash }, true),
  solSubmit: (ref: number | string, signedTx: string) => post<{ signature: string }>(`/public/desk/swaps/${ref}/sol/submit`, { signedTx }, true),
};
