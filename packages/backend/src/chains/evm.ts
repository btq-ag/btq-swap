import {
  Contract,
  ContractFactory,
  JsonRpcProvider,
  NonceManager,
  Wallet,
  type TransactionReceipt,
} from 'ethers';
import {
  ERC20_ABI,
  HTLC_ERC20_ABI,
  computeAgreementId,
  decodeHtlcLog,
  type HtlcEvent,
  type HtlcInstance,
  type HtlcLockParams,
} from '@btq-swap/htlc';
import { config } from '../config';
import { createLogger } from '../lib/logger';
import HtlcArtifact from './artifacts/HtlcERC20.json';
import MockUsdtArtifact from './artifacts/MockUSDT.json';

const log = createLogger('evm');

/** Serializes platform transactions so nonces never collide. */
class Mutex {
  private last: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.last.then(fn, fn);
    this.last = next.catch(() => undefined);
    return next;
  }
}

export interface EvmAddresses {
  htlc: string;
  token: string;
}

export class EvmChain {
  readonly provider: JsonRpcProvider;
  readonly platformWallet: Wallet;
  readonly signer: NonceManager;
  private readonly mutex = new Mutex();
  private addrs: EvmAddresses | null = null;

  constructor(opts?: { url: string; chainId: number; privateKey: string }) {
    const c = opts ?? { url: config().EVM_RPC_URL, chainId: config().EVM_CHAIN_ID, privateKey: config().EVM_PRIVATE_KEY };
    this.provider = new JsonRpcProvider(c.url, c.chainId, { staticNetwork: true, cacheTimeout: -1, polling: true, pollingInterval: 1000 });
    const key = c.privateKey.startsWith('0x') ? c.privateKey : `0x${c.privateKey}`;
    this.platformWallet = new Wallet(key, this.provider);
    this.signer = new NonceManager(this.platformWallet);
  }

  setAddresses(a: EvmAddresses): void {
    this.addrs = { htlc: a.htlc, token: a.token };
  }

  addresses(): EvmAddresses {
    if (!this.addrs) throw new Error('EVM contract addresses are not configured yet');
    return this.addrs;
  }

  get platformAddress(): string {
    return this.platformWallet.address;
  }

  htlc(runner: JsonRpcProvider | NonceManager | Wallet = this.provider): Contract {
    return new Contract(this.addresses().htlc, HTLC_ERC20_ABI, runner);
  }

  token(runner: JsonRpcProvider | NonceManager | Wallet = this.provider): Contract {
    return new Contract(this.addresses().token, ERC20_ABI, runner);
  }

  async blockNumber(): Promise<number> {
    return this.provider.getBlockNumber();
  }

  async latestTimestamp(): Promise<number> {
    const b = await this.provider.getBlock('latest');
    return b?.timestamp ?? Math.floor(Date.now() / 1000);
  }

  async logs(fromBlock: number, toBlock: number): Promise<HtlcEvent[]> {
    const raw = await this.provider.getLogs({ address: this.addresses().htlc, fromBlock, toBlock });
    return raw.map((l) => decodeHtlcLog(l)).filter((e): e is HtlcEvent => e !== null);
  }

  async instance(agreementId: string): Promise<HtlcInstance> {
    const r = await this.htlc().getFunction('getHTLCInstance').staticCall(agreementId);
    const partyA = String(r[0]);
    return {
      partyA,
      partyB: String(r[1]),
      erc20Contract: String(r[2]),
      tokenAmount: BigInt(r[3]),
      secretlock: String(r[4]).toLowerCase(),
      deadline: Number(r[5]),
      tokensWithdrawn: Boolean(r[6]),
      tokensRefunded: Boolean(r[7]),
      key: String(r[8]).toLowerCase(),
      otherNetwork: String(r[9]),
      otherAsset: String(r[10]),
      otherAmount: BigInt(r[11]),
      exists: partyA !== '0x0000000000000000000000000000000000000000',
    };
  }

  async tokenBalance(address: string): Promise<bigint> {
    return BigInt(await this.token().getFunction('balanceOf')(address));
  }

  async ethBalance(address: string): Promise<bigint> {
    return this.provider.getBalance(address);
  }

  async receipt(txHash: string): Promise<TransactionReceipt | null> {
    return this.provider.getTransactionReceipt(txHash);
  }

  private async send(label: string, fn: () => Promise<{ hash: string; wait: (c?: number) => Promise<TransactionReceipt | null> }>): Promise<TransactionReceipt> {
    return this.mutex.run(async () => {
      try {
        const tx = await fn();
        log.info(`platform tx sent: ${label}`, { hash: tx.hash });
        const r = await tx.wait(1);
        if (!r || r.status !== 1) throw new Error(`${label} reverted (${tx.hash})`);
        return r;
      } catch (err) {
        this.signer.reset();
        throw err;
      }
    });
  }

  /** Platform as buyer: approve (if needed) + createHTLCProposal. Returns the agreement id and receipt. */
  async platformLock(p: Omit<HtlcLockParams, 'partyA'>): Promise<{ agreementId: string; txHash: string; blockNumber: number }> {
    const { htlc } = this.addresses();
    const allowance = BigInt(await this.token().getFunction('allowance')(this.platformAddress, htlc));
    if (allowance < p.tokenAmount) {
      await this.send('approve', () => this.token(this.signer).getFunction('approve')(htlc, p.tokenAmount * 1000n));
    }
    const r = await this.send('createHTLCProposal', () =>
      this.htlc(this.signer).getFunction('createHTLCProposal')([
        p.partyB, p.secretlock, p.deadline, p.erc20Contract, p.tokenAmount, p.otherNetwork, p.otherAsset, p.otherAmount,
      ]),
    );
    const agreementId = computeAgreementId({ ...p, partyA: this.platformAddress });
    return { agreementId, txHash: r.hash, blockNumber: r.blockNumber };
  }

  async platformWithdraw(agreementId: string, preimageHex: string): Promise<string> {
    const key = preimageHex.startsWith('0x') ? preimageHex : `0x${preimageHex}`;
    const r = await this.send('withdrawTokens', () => this.htlc(this.signer).getFunction('withdrawTokens')(agreementId, key));
    return r.hash;
  }

  async platformRefund(agreementId: string): Promise<string> {
    const r = await this.send('refundTokens', () => this.htlc(this.signer).getFunction('refundTokens')(agreementId));
    return r.hash;
  }

  async platformTransferToken(to: string, amount: bigint): Promise<string> {
    const r = await this.send('transfer', () => this.token(this.signer).getFunction('transfer')(to, amount));
    return r.hash;
  }

  async platformSendEth(to: string, wei: bigint): Promise<string> {
    const r = await this.send('sendEth', () => this.signer.sendTransaction({ to, value: wei }) as never);
    return r.hash;
  }

  /** Devnet only: deploy MockUSDT + HtlcERC20 from the compiled artifacts. */
  async deployDevContracts(initialSupplyUnits: bigint): Promise<EvmAddresses> {
    return this.mutex.run(async () => {
      const usdt = await new ContractFactory(MockUsdtArtifact.abi, MockUsdtArtifact.bytecode, this.signer).deploy(initialSupplyUnits);
      await usdt.waitForDeployment();
      const htlc = await new ContractFactory(HtlcArtifact.abi, HtlcArtifact.bytecode, this.signer).deploy();
      await htlc.waitForDeployment();
      return { token: await usdt.getAddress(), htlc: await htlc.getAddress() };
    });
  }

  async hasCode(address: string): Promise<boolean> {
    const code = await this.provider.getCode(address);
    return code !== '0x';
  }
}

let _evm: EvmChain | null = null;
export function evmChain(): EvmChain {
  if (!_evm) _evm = new EvmChain();
  return _evm;
}
