import type { Transaction } from '@solana/web3.js';
import { deskApi, saveDeskToken, type DeskProfile } from './deskApi';
import { connectMetaMask, selectEthereumProvider, signMessage, type EthereumProvider } from './evmWallet';

export type SettlementRail = 'evm' | 'solana';

export interface SolanaProvider {
  isPhantom?: boolean;
  isSolflare?: boolean;
  isBackpack?: boolean;
  connect: () => Promise<{ publicKey: { toBase58: () => string } }>;
  signMessage: (message: Uint8Array, display: string) => Promise<{ signature: Uint8Array }>;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
}

export interface DetectedWallet {
  id: string;
  name: string;
  rail: SettlementRail;
}

interface EvmChoice extends DetectedWallet {
  rail: 'evm';
  provider: EthereumProvider;
}

interface SolChoice extends DetectedWallet {
  rail: 'solana';
  provider: SolanaProvider;
}

type Choice = EvmChoice | SolChoice;

let chosenSol: SolanaProvider | null = null;

function windowWallets(): {
  ethereum?: EthereumProvider & { providers?: EthereumProvider[]; isMetaMask?: boolean; isPhantom?: boolean; isRabby?: boolean; isCoinbaseWallet?: boolean };
  solana?: Partial<SolanaProvider>;
  phantom?: { solana?: SolanaProvider };
  solflare?: SolanaProvider;
  backpack?: SolanaProvider;
} {
  return window as unknown as ReturnType<typeof windowWallets>;
}

function evmName(provider: EthereumProvider & { isMetaMask?: boolean; isPhantom?: boolean; isRabby?: boolean; isCoinbaseWallet?: boolean }): string {
  if (provider.isPhantom) return 'Phantom';
  if (provider.isRabby) return 'Rabby';
  if (provider.isCoinbaseWallet) return 'Coinbase';
  if (provider.isMetaMask) return 'MetaMask';
  return 'EVM wallet';
}

function solName(provider: SolanaProvider, fallback: string): string {
  if (provider.isPhantom) return 'Phantom';
  if (provider.isSolflare) return 'Solflare';
  if (provider.isBackpack) return 'Backpack';
  return fallback;
}

function isSolana(provider: Partial<SolanaProvider> | undefined): provider is SolanaProvider {
  return !!provider?.connect && !!provider.signMessage && !!provider.signTransaction;
}

function choices(): Choice[] {
  const found: Choice[] = [];
  const win = windowWallets();
  const evmProviders = win.ethereum?.providers?.length ? win.ethereum.providers : win.ethereum ? [win.ethereum] : [];
  const seenEvm = new Set<EthereumProvider>();
  evmProviders.forEach((provider, index) => {
    if (!provider?.request || seenEvm.has(provider)) return;
    seenEvm.add(provider);
    const name = evmName(provider);
    found.push({ id: `evm:${name}:${index}`, name, rail: 'evm', provider });
  });

  const solCandidates: Array<[string, Partial<SolanaProvider> | undefined]> = [
    ['Phantom', win.phantom?.solana],
    ['Solflare', win.solflare],
    ['Backpack', win.backpack],
    ['Solana wallet', win.solana],
  ];
  const seenSol = new Set<SolanaProvider>();
  solCandidates.forEach(([fallback, provider]) => {
    if (!isSolana(provider) || seenSol.has(provider)) return;
    seenSol.add(provider);
    const name = solName(provider, fallback);
    found.push({ id: `sol:${name}`, name, rail: 'solana', provider });
  });
  return found;
}

export function walletsFor(rail: SettlementRail): DetectedWallet[] {
  return choices().filter((wallet) => wallet.rail === rail).map(({ id, name, rail: walletRail }) => ({ id, name, rail: walletRail }));
}

export function bytesToBase64(bytes: Uint8Array): string {
  let raw = '';
  bytes.forEach((b) => { raw += String.fromCharCode(b); });
  return btoa(raw);
}

export function base64ToBytes(value: string): Uint8Array {
  const raw = atob(value);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function connectWallet(id: string): Promise<DeskProfile> {
  const wallet = choices().find((item) => item.id === id);
  if (!wallet) throw new Error('That wallet is no longer available. Refresh and try again.');
  if (wallet.rail === 'evm') {
    selectEthereumProvider(wallet.provider);
    const address = await connectMetaMask();
    const started = await deskApi.evmStart(address);
    const signature = await signMessage(address, started.message);
    const done = await deskApi.evmFinish(address, signature);
    saveDeskToken(done.token);
    return done.profile;
  }
  chosenSol = wallet.provider;
  const connected = await wallet.provider.connect();
  const address = connected.publicKey.toBase58();
  const started = await deskApi.solStart(address);
  const signed = await wallet.provider.signMessage(new TextEncoder().encode(started.message), 'utf8');
  const done = await deskApi.solFinish(address, bytesToBase64(signed.signature));
  if (done.token) saveDeskToken(done.token);
  return done.profile;
}

export async function signSolanaTransaction(tx: Transaction): Promise<Transaction> {
  const provider = chosenSol ?? choices().find((item): item is SolChoice => item.rail === 'solana')?.provider;
  if (!provider) throw new Error('Connect a Solana wallet first.');
  chosenSol = provider;
  return provider.signTransaction(tx);
}
