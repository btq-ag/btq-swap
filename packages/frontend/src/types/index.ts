export type SwapDirection = 'buy_btq' | 'sell_btq';

export type SwapStatus =
  | 'pending'
  | 'btq_locked'
  | 'evm_locked'
  | 'evm_claimed'
  | 'btq_claimed'
  | 'completed'
  | 'expired'
  | 'refunded'
  | 'failed';

export type OrderSide = 'buy' | 'sell';
export type OrderStatus = 'open' | 'filled' | 'partial' | 'cancelled';

export interface User {
  id: string;
  address: string;
  role: 'user' | 'admin';
  dilithiumPubkey?: string;
  swapCount: number;
  createdAt: string;
  banned: boolean;
}

export interface Swap {
  id: string;
  userId: string;
  userAddress: string;
  direction: SwapDirection;
  status: SwapStatus;
  btqAmount: string;
  usdtAmount: string;
  rate: string;
  fee: string;
  hashlock: string;
  preimage?: string;
  btqTxid?: string;
  evmTxHash?: string;
  evmContractId?: string;
  btqLockAddress?: string;
  dilithiumPubkey?: string;
  timelockEvm: number;
  timelockBtq: number;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface Order {
  id: string;
  userId: string;
  userAddress: string;
  side: OrderSide;
  status: OrderStatus;
  price: string;
  btqAmount: string;
  filledAmount: string;
  createdAt: string;
  expiresAt?: string | null;
}

export interface SwapRate {
  bid: string;
  ask: string;
  pair: string;
}

export interface PlatformConfig {
  bidPrice: string;
  askPrice: string;
  spreadBps: number;
  minBtq: string;
  maxBtq: string;
  feeBps: number;
  paused: boolean;
}

export interface WalletStatus {
  btcBalance: string;
  ethBalance: string;
  usdtBalance: string;
  btqAddress: string;
  ethAddress: string;
}

export interface SystemHealth {
  btqCore: boolean;
  ethRpc: boolean;
  database: boolean;
  redis: boolean;
  uptime: number;
  version: string;
}

export interface DepthEntry {
  price: number;
  amount: number;
  total: number;
}

export interface AuthState {
  token: string | null;
  user: User | null;
  isAdmin: boolean;
  isAuthenticated: boolean;
}

export interface ApiResponse<T> {
  data: T;
  message?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

export interface SwapCreatePayload {
  direction: SwapDirection;
  btqAmount: string;
  dilithiumPubkey?: string;
}

export interface SwapStep {
  label: string;
  status: 'pending' | 'active' | 'completed' | 'failed';
  description: string;
}
