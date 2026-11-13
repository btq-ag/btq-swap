import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from '../config';

/** Public devnet RPCs whose genesis hash matches https://api.devnet.solana.com. Capped at 10. */
export const PUBLIC_SOLANA_RPCS = [
  'https://api.devnet.solana.com',
  'https://devnet.rpcpool.com',
  'https://solana-devnet.api.onfinality.io/public',
];

/** Circle devnet USDC. */
export const PUBLIC_SOLANA_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

const MAX_RPCS = 10;
let cursor = 0;
const connections = new Map<string, Connection>();

export function solanaRpcUrls(): string[] {
  const fromEnv = (config().SOLANA_RPC_URL ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('http'));
  // An explicit list is one cluster. Do not mix it with the public devnet endpoints.
  const list = fromEnv.length > 0 ? fromEnv : PUBLIC_SOLANA_RPCS;
  return [...new Set(list)].slice(0, MAX_RPCS);
}

export function solanaMintAddress(): string {
  return config().SOLANA_TOKEN_MINT || PUBLIC_SOLANA_MINT;
}

export function solanaProgramAddress(): string | undefined {
  const id = config().SOLANA_HTLC_PROGRAM_ID?.trim();
  return id || undefined;
}

function connectionFor(url: string): Connection {
  let connection = connections.get(url);
  if (!connection) {
    connection = new Connection(url, 'confirmed');
    connections.set(url, connection);
  }
  return connection;
}

/** Run a call against the next public RPC, moving on when that endpoint fails. */
export async function withSolana<T>(fn: (connection: Connection, url: string) => Promise<T>): Promise<T> {
  const urls = solanaRpcUrls();
  let last = 'No public Solana RPC responded';
  for (let n = 0; n < urls.length; n++) {
    const url = urls[(cursor + n) % urls.length]!;
    try {
      const value = await fn(connectionFor(url), url);
      cursor = (cursor + n) % urls.length;
      return value;
    } catch (err) {
      last = (err as Error).message;
    }
  }
  throw new Error(last);
}

export function solanaConfigured(): boolean {
  return solanaRpcUrls().length > 0 && !!solanaProgramAddress();
}

export function solanaConnection(): Connection {
  return connectionFor(solanaRpcUrls()[cursor] ?? solanaRpcUrls()[0]!);
}

export function solanaProgramId(): PublicKey {
  const id = solanaProgramAddress();
  if (!id) throw new Error('SOLANA_HTLC_PROGRAM_ID is not set');
  return new PublicKey(id);
}

export function solanaMint(): PublicKey {
  return new PublicKey(solanaMintAddress());
}

export function platformSolanaKeypair(): Keypair {
  const raw = config().SOLANA_PLATFORM_SECRET?.trim();
  if (!raw) throw new Error('SOLANA_PLATFORM_SECRET is not set');
  const bytes = raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw) as number[]) : bs58.decode(raw);
  return Keypair.fromSecretKey(bytes);
}

/** Null when the Solana rail can take new swaps. Otherwise the reason it cannot. */
export async function solanaReady(): Promise<string | null> {
  if (!solanaProgramAddress()) {
    return 'The Solana HTLC program is not deployed on devnet yet. Public RPCs and the devnet USDC mint are already in use.';
  }
  try {
    await withSolana(async (connection) => {
      await connection.getSlot('confirmed');
      const program = await connection.getAccountInfo(solanaProgramId());
      if (!program?.executable) throw new Error('The Solana HTLC program is not deployed on that cluster.');
      const mint = await connection.getAccountInfo(solanaMint());
      if (!mint) throw new Error('The Solana token mint does not exist on that cluster.');
    });
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}
