import { Interface } from 'ethers';

const htlc = new Interface([
  'function createHTLCProposal((address partyB, bytes32 secretlock, uint32 deadline, address erc20Contract, uint256 tokenAmount, string otherNetwork, string otherAsset, uint256 otherAmount) params) returns (bytes32 agreementId)',
  'function withdrawTokens(bytes32 _htlcInstanceId, bytes32 _key) returns (bool)',
  'function refundTokens(bytes32 _htlcInstanceId) returns (bool)',
]);

const erc20 = new Interface(['function approve(address spender, uint256 amount) returns (bool)']);

export interface EvmLock {
  chainId: number;
  htlc: string;
  token: string;
  partyB: string;
  amountUnits: string;
  otherNetwork: string;
  otherAsset: string;
  otherAmount: string;
  deadline: number;
}

export function approveCalldata(spender: string, amountUnits: string): string {
  return erc20.encodeFunctionData('approve', [spender, BigInt(amountUnits)]);
}

export function lockCalldata(lock: EvmLock, secretHashHex: string): string {
  const secretlock = secretHashHex.startsWith('0x') ? secretHashHex : `0x${secretHashHex}`;
  return htlc.encodeFunctionData('createHTLCProposal', [[
    lock.partyB,
    secretlock,
    lock.deadline,
    lock.token,
    BigInt(lock.amountUnits),
    lock.otherNetwork,
    lock.otherAsset,
    BigInt(lock.otherAmount),
  ]]);
}

export function withdrawCalldata(agreementId: string, preimageHex: string): string {
  const key = preimageHex.startsWith('0x') ? preimageHex : `0x${preimageHex}`;
  return htlc.encodeFunctionData('withdrawTokens', [agreementId, key]);
}

export function refundCalldata(agreementId: string): string {
  return htlc.encodeFunctionData('refundTokens', [agreementId]);
}
