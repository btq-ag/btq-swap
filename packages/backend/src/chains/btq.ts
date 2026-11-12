import { BtqRpc, btqToSats, satsToBtq } from '@btq-swap/htlc';
import { config } from '../config';

export interface BtqBlockTx {
  txid: string;
  hex: string;
  vin: Array<{ txid?: string; vout?: number; coinbase?: string }>;
  vout: Array<{ value: number; n: number; scriptPubKey: { hex: string; address?: string; type?: string } }>;
}

export interface BtqBlock {
  hash: string;
  height: number;
  time: number;
  previousblockhash?: string;
  tx: BtqBlockTx[];
}

export interface MempoolAccept {
  txid: string;
  allowed: boolean;
  'reject-reason'?: string;
  vsize?: number;
}

/** Thin adapter over btqd JSON-RPC used by watchers, the platform agent and the devnet tools. */
export class BtqChain {
  readonly rpc: BtqRpc;
  readonly platform: BtqRpc;

  constructor(opts?: { url: string; user: string; pass: string; platformWallet: string }) {
    const c = opts ?? {
      url: config().BTQ_RPC_URL,
      user: config().BTQ_RPC_USER,
      pass: config().BTQ_RPC_PASS,
      platformWallet: config().BTQ_PLATFORM_WALLET,
    };
    this.rpc = new BtqRpc({ url: c.url, user: c.user, pass: c.pass, timeoutMs: 60_000 });
    this.platform = this.rpc.withWallet(c.platformWallet);
  }

  wallet(name: string): BtqRpc {
    return this.rpc.withWallet(name);
  }

  async tip(): Promise<{ height: number; hash: string; time: number }> {
    const info = await this.rpc.call<{ blocks: number; bestblockhash: string; time?: number; mediantime: number }>('getblockchaininfo');
    return { height: info.blocks, hash: info.bestblockhash, time: info.time ?? info.mediantime };
  }

  async blockHash(height: number): Promise<string> {
    return this.rpc.call<string>('getblockhash', [height]);
  }

  async block(hash: string): Promise<BtqBlock> {
    return this.rpc.call<BtqBlock>('getblock', [hash, 2]);
  }

  async rawTx(txid: string): Promise<string> {
    return this.rpc.call<string>('getrawtransaction', [txid, false]);
  }

  async txConfirmations(txid: string): Promise<{ confirmations: number; blockhash?: string; height?: number }> {
    const t = await this.rpc.call<{ confirmations?: number; blockhash?: string }>('getrawtransaction', [txid, true]);
    let height: number | undefined;
    if (t.blockhash) {
      const h = await this.rpc.call<{ height: number }>('getblockheader', [t.blockhash, true]);
      height = h.height;
    }
    return { confirmations: t.confirmations ?? 0, blockhash: t.blockhash, height };
  }

  async mempoolTxids(): Promise<string[]> {
    return this.rpc.call<string[]>('getrawmempool', [false]);
  }

  async txOutUnspent(txid: string, vout: number, includeMempool = true): Promise<boolean> {
    const r = await this.rpc.call<unknown>('gettxout', [txid, vout, includeMempool]);
    return r !== null;
  }

  async testAccept(hex: string): Promise<MempoolAccept> {
    const r = await this.rpc.call<MempoolAccept[]>('testmempoolaccept', [[hex]]);
    return r[0]!;
  }

  async broadcast(hex: string): Promise<string> {
    return this.rpc.call<string>('sendrawtransaction', [hex]);
  }

  // ── platform wallet ──
  async platformAddress(label = 'btq-swap'): Promise<string> {
    return this.platform.call<string>('getnewaddress', [label]);
  }

  async platformBalanceSats(minConf = 1): Promise<bigint> {
    const b = await this.platform.call<number>('getbalance', ['*', minConf]);
    return btqToSats(b.toFixed(8));
  }

  /** Pay an exact amount to an address from the platform wallet (fee on top). */
  async platformSend(address: string, sats: bigint, comment = ''): Promise<string> {
    return this.platform.call<string>('sendtoaddress', [address, satsToBtq(sats), comment]);
  }

  /** Load or create a wallet; safe when several processes race to do the same. */
  async ensureWallet(name: string): Promise<BtqRpc> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const loaded = await this.rpc.call<string[]>('listwallets');
      if (loaded.includes(name)) return this.wallet(name);
      try {
        await this.rpc.call('loadwallet', [name]);
        return this.wallet(name);
      } catch (e) {
        if (/already loaded/i.test((e as Error).message)) return this.wallet(name);
      }
      try {
        await this.rpc.call('createwallet', [name]);
        return this.wallet(name);
      } catch (e) {
        if (!/already exists|already loaded/i.test((e as Error).message)) throw e;
      }
      await new Promise((r) => setTimeout(r, 300 + attempt * 200));
    }
    throw new Error(`could not load or create wallet ${name}`);
  }
}

let _chain: BtqChain | null = null;
export function btqChain(): BtqChain {
  if (!_chain) _chain = new BtqChain();
  return _chain;
}

export function btqCliNetworkFlag(network = config().BTQ_NETWORK): string {
  if (network === 'mainnet') return '';
  if (network === 'testnet') return '-testnet ';
  return `-${network} `;
}
