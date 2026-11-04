export const API_URL = import.meta.env.VITE_API_URL || '/api';
export const WS_URL = import.meta.env.VITE_WS_URL || '';

export const HTLC_CONTRACT_ADDRESS = (import.meta.env.VITE_HTLC_CONTRACT || '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512') as `0x${string}`;
export const USDT_CONTRACT_ADDRESS = (import.meta.env.VITE_USDT_CONTRACT || '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707') as `0x${string}`;

export const SUPPORTED_CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID || 31337);

export const BTQ_EXPLORER_URL = import.meta.env.VITE_BTQ_EXPLORER || 'https://explorer.bitcoinquantum.com';
export const ETH_EXPLORER_URL = import.meta.env.VITE_ETH_EXPLORER || 'https://etherscan.io';

export const HTLC_ABI = [
  {
    inputs: [
      { name: '_receiver', type: 'address' },
      { name: '_hashlock', type: 'bytes32' },
      { name: '_timelock', type: 'uint256' },
      { name: '_tokenContract', type: 'address' },
      { name: '_amount', type: 'uint256' },
    ],
    name: 'newContract',
    outputs: [{ name: 'contractId', type: 'bytes32' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: '_contractId', type: 'bytes32' },
      { name: '_preimage', type: 'bytes32' },
    ],
    name: 'withdraw',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: '_contractId', type: 'bytes32' }],
    name: 'refund',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: '_contractId', type: 'bytes32' }],
    name: 'getContract',
    outputs: [
      {
        components: [
          { name: 'sender', type: 'address' },
          { name: 'receiver', type: 'address' },
          { name: 'tokenContract', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'hashlock', type: 'bytes32' },
          { name: 'timelock', type: 'uint256' },
          { name: 'withdrawn', type: 'bool' },
          { name: 'refunded', type: 'bool' },
          { name: 'preimage', type: 'bytes32' },
        ],
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'contractId', type: 'bytes32' },
      { indexed: true, name: 'sender', type: 'address' },
      { indexed: true, name: 'receiver', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'hashlock', type: 'bytes32' },
      { name: 'timelock', type: 'uint256' },
    ],
    name: 'HTLCNew',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [{ indexed: true, name: 'contractId', type: 'bytes32' }],
    name: 'HTLCWithdraw',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [{ indexed: true, name: 'contractId', type: 'bytes32' }],
    name: 'HTLCRefund',
    type: 'event',
  },
] as const;

export const ERC20_ABI = [
  {
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    name: 'allowance',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

export const SWAP_STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  btq_locked: 'BTQ Locked',
  evm_locked: 'USDT Locked',
  evm_claimed: 'USDT Claimed',
  btq_claimed: 'BTQ Claimed',
  completed: 'Completed',
  expired: 'Expired',
  refunded: 'Refunded',
  failed: 'Failed',
};

export const SWAP_STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-500/20 text-yellow-400',
  btq_locked: 'bg-blue-500/20 text-blue-400',
  evm_locked: 'bg-blue-500/20 text-blue-400',
  evm_claimed: 'bg-emerald-500/20 text-emerald-400',
  btq_claimed: 'bg-emerald-500/20 text-emerald-400',
  completed: 'bg-emerald-500/20 text-emerald-400',
  expired: 'bg-red-500/20 text-red-400',
  refunded: 'bg-orange-500/20 text-orange-400',
  failed: 'bg-red-500/20 text-red-400',
};
