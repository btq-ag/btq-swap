import { ethers, Contract, JsonRpcProvider, Wallet } from 'ethers';
import { config } from '../config';

export const HTLC_ABI = [
  'function createSwapERC20(bytes32 swapId, address recipient, address token, uint256 amount, bytes32 hashlock, uint256 timelock) external',
  'function createSwapETH(bytes32 swapId, address recipient, bytes32 hashlock, uint256 timelock) external payable',
  'function claim(bytes32 swapId, bytes32 secret) external',
  'function refund(bytes32 swapId) external',
  'function getSwap(bytes32 swapId) external view returns (tuple(address initiator, address recipient, address token, uint256 amount, bytes32 hashlock, uint256 timelock, uint8 state))',
  'event SwapCreated(bytes32 indexed swapId, address indexed initiator, address indexed recipient, address token, uint256 amount, bytes32 hashlock, uint256 timelock)',
  'event SwapClaimed(bytes32 indexed swapId, bytes32 secret)',
  'event SwapRefunded(bytes32 indexed swapId)',
];

export enum EvmSwapState {
  INVALID = 0,
  OPEN = 1,
  CLOSED = 2,
  EXPIRED = 3,
}

export interface EvmSwapData {
  initiator: string;
  recipient: string;
  token: string;
  amount: bigint;
  hashlock: string;
  timelock: bigint;
  state: EvmSwapState;
}

let _provider: JsonRpcProvider | null = null;
let _signer: Wallet | null = null;
let _contract: Contract | null = null;
let _readContract: Contract | null = null;

export function getProvider(): JsonRpcProvider {
  if (!_provider) {
    _provider = new JsonRpcProvider(config.EVM_RPC_URL, config.EVM_CHAIN_ID, {
      staticNetwork: ethers.Network.from(config.EVM_CHAIN_ID),
    });
  }
  return _provider;
}

export function getSigner(): Wallet {
  if (!_signer) {
    _signer = new Wallet(config.EVM_PRIVATE_KEY, getProvider());
  }
  return _signer;
}

export function getHtlcContract(): Contract {
  if (!_contract) {
    _contract = new Contract(config.HTLC_CONTRACT_ADDRESS, HTLC_ABI, getSigner());
  }
  return _contract;
}

export function getReadOnlyHtlcContract(): Contract {
  if (!_readContract) {
    _readContract = new Contract(config.HTLC_CONTRACT_ADDRESS, HTLC_ABI, getProvider());
  }
  return _readContract;
}

export function parseEvmSwapData(raw: ethers.Result): EvmSwapData {
  return {
    initiator: raw[0],
    recipient: raw[1],
    token: raw[2],
    amount: raw[3],
    hashlock: raw[4],
    timelock: raw[5],
    state: Number(raw[6]) as EvmSwapState,
  };
}
