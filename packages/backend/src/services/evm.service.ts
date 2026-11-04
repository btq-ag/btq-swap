import { ethers } from 'ethers';
import { config } from '../config';
import {
  getHtlcContract,
  getReadOnlyHtlcContract,
  getProvider,
  getSigner,
  parseEvmSwapData,
  EvmSwapData,
  EvmSwapState,
} from '../lib/htlcContract';

export class EvmService {
  async createSwapERC20(
    swapId: string,
    recipient: string,
    tokenAddress: string,
    amount: bigint,
    hashlock: string,
    timelockSeconds: number,
  ): Promise<string> {
    const contract = getHtlcContract();
    const timelock = BigInt(Math.floor(Date.now() / 1000) + timelockSeconds);

    const tx = await contract.createSwapERC20(
      swapId,
      recipient,
      tokenAddress,
      amount,
      hashlock,
      timelock,
    );
    const receipt = await tx.wait();
    return receipt.hash;
  }

  async createSwapETH(
    swapId: string,
    recipient: string,
    hashlock: string,
    timelockSeconds: number,
    valueWei: bigint,
  ): Promise<string> {
    const contract = getHtlcContract();
    const timelock = BigInt(Math.floor(Date.now() / 1000) + timelockSeconds);

    const tx = await contract.createSwapETH(swapId, recipient, hashlock, timelock, {
      value: valueWei,
    });
    const receipt = await tx.wait();
    return receipt.hash;
  }

  async claimSwap(swapId: string, secret: string): Promise<string> {
    const contract = getHtlcContract();
    const tx = await contract.claim(swapId, secret);
    const receipt = await tx.wait();
    return receipt.hash;
  }

  async refundSwap(swapId: string): Promise<string> {
    const contract = getHtlcContract();
    const tx = await contract.refund(swapId);
    const receipt = await tx.wait();
    return receipt.hash;
  }

  async getSwap(swapId: string): Promise<EvmSwapData> {
    const contract = getReadOnlyHtlcContract();
    const raw = await contract.getSwap(swapId);
    return parseEvmSwapData(raw);
  }

  async isSwapOpen(swapId: string): Promise<boolean> {
    const swap = await this.getSwap(swapId);
    return swap.state === EvmSwapState.OPEN;
  }

  async isSwapClaimed(swapId: string): Promise<boolean> {
    const swap = await this.getSwap(swapId);
    return swap.state === EvmSwapState.CLOSED;
  }

  async isSwapExpired(swapId: string): Promise<boolean> {
    const swap = await this.getSwap(swapId);
    return swap.state === EvmSwapState.EXPIRED;
  }

  async getSecretFromClaim(swapId: string): Promise<string | null> {
    const contract = getReadOnlyHtlcContract();
    const filter = contract.filters.SwapClaimed(swapId);
    const events = await contract.queryFilter(filter);
    if (events.length === 0) return null;
    const event = events[0] as ethers.EventLog;
    return event.args[1] as string;
  }

  async getPlatformAddress(): Promise<string> {
    return getSigner().address;
  }

  async getPlatformBalance(): Promise<string> {
    const provider = getProvider();
    const balance = await provider.getBalance(getSigner().address);
    return ethers.formatEther(balance);
  }

  async getTokenBalance(tokenAddress: string): Promise<string> {
    const erc20Abi = ['function balanceOf(address) view returns (uint256)'];
    const contract = new ethers.Contract(tokenAddress, erc20Abi, getProvider());
    const balance: bigint = await contract.balanceOf(getSigner().address);
    return ethers.formatUnits(balance, 6); // USDT has 6 decimals
  }

  async approveToken(
    tokenAddress: string,
    spender: string,
    amount: bigint,
  ): Promise<string> {
    const erc20Abi = ['function approve(address, uint256) returns (bool)'];
    const contract = new ethers.Contract(tokenAddress, erc20Abi, getSigner());
    const tx = await contract.approve(spender, amount);
    const receipt = await tx.wait();
    return receipt.hash;
  }

  onSwapCreated(
    callback: (
      swapId: string,
      initiator: string,
      recipient: string,
      token: string,
      amount: bigint,
      hashlock: string,
      timelock: bigint,
    ) => void,
  ): void {
    const contract = getReadOnlyHtlcContract();
    contract.on(
      'SwapCreated',
      (swapId, initiator, recipient, token, amount, hashlock, timelock) => {
        callback(swapId, initiator, recipient, token, amount, hashlock, timelock);
      },
    );
  }

  onSwapClaimed(callback: (swapId: string, secret: string) => void): void {
    const contract = getReadOnlyHtlcContract();
    contract.on('SwapClaimed', (swapId, secret) => {
      callback(swapId, secret);
    });
  }

  onSwapRefunded(callback: (swapId: string) => void): void {
    const contract = getReadOnlyHtlcContract();
    contract.on('SwapRefunded', (swapId) => {
      callback(swapId);
    });
  }

  removeAllListeners(): void {
    const contract = getReadOnlyHtlcContract();
    contract.removeAllListeners();
  }
}

export const evmService = new EvmService();
