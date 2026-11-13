import { Contract, Interface, sha256, solidityPacked, type ContractRunner } from 'ethers';

/** Structural log shape so callers can pass logs from any ethers v6 copy. */
export interface LogLike {
  topics: readonly string[];
  data: string;
  transactionHash: string;
  blockNumber: number;
  index: number;
}

/**
 * ABI of packages/contracts/contracts/HTLCERC20/HtlcERC20.sol (verified against the
 * compiled artifact in packages/backend/tests/evm.abi.test.ts).
 */
export const HTLC_ERC20_ABI = [
  'function createHTLCProposal((address partyB, bytes32 secretlock, uint32 deadline, address erc20Contract, uint256 tokenAmount, string otherNetwork, string otherAsset, uint256 otherAmount) params) returns (bytes32 agreementId)',
  'function withdrawTokens(bytes32 _htlcInstanceId, bytes32 _key) returns (bool)',
  'function refundTokens(bytes32 _htlcInstanceId) returns (bool)',
  'function getHTLCInstance(bytes32 _htlcInstanceId) view returns (address partyA, address partyB, address erc20Contract, uint256 tokenAmount, bytes32 secretlock, uint32 deadline, bool tokensWithdrawn, bool tokensRefunded, bytes32 key, string otherNetwork, string otherAsset, uint256 otherAmount)',
  'event HTLCERC20Lockup(bytes32 indexed agreementId, address indexed partyA, address indexed partyB, bytes32 secretlock, uint32 deadline, uint256 tokenAmount, address erc20Contract, string otherNetwork, string otherAsset, uint256 otherAmount)',
  'event HTLCERC20Claimed(bytes32 indexed agreementId)',
  'event HTLCERC20Redeemed(bytes32 indexed agreementId)',
] as const;

export const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
] as const;

export const htlcInterface = new Interface(HTLC_ERC20_ABI);
export const erc20Interface = new Interface(ERC20_ABI);

export interface HtlcLockParams {
  partyA: string;
  partyB: string;
  secretlock: string; // 0x + 32 bytes
  deadline: number; // unix seconds (uint32)
  erc20Contract: string;
  tokenAmount: bigint;
  otherNetwork: string;
  otherAsset: string;
  otherAmount: bigint;
}

/** agreementId = sha256(abi.encodePacked(msg.sender, partyB, erc20, amount, secretlock, deadline, otherNetwork, otherAsset, otherAmount)) */
export function computeAgreementId(p: HtlcLockParams): string {
  return sha256(
    solidityPacked(
      ['address', 'address', 'address', 'uint256', 'bytes32', 'uint32', 'string', 'string', 'uint256'],
      [p.partyA, p.partyB, p.erc20Contract, p.tokenAmount, p.secretlock, p.deadline, p.otherNetwork, p.otherAsset, p.otherAmount],
    ),
  ).toLowerCase();
}

/** The `otherAsset` string binds an EVM lock to exactly one swap. */
export function swapBindingAsset(swapId: string): string {
  return `BTQ swap ${swapId}`;
}

export function parseSwapBindingAsset(otherAsset: string): string | null {
  const m = /^BTQ swap ([0-9a-f-]{36})$/i.exec(otherAsset.trim());
  return m ? m[1]!.toLowerCase() : null;
}

export function btqNetworkTag(network: string): string {
  return `btq:${network}`;
}

export interface HtlcInstance {
  partyA: string;
  partyB: string;
  erc20Contract: string;
  tokenAmount: bigint;
  secretlock: string;
  deadline: number;
  tokensWithdrawn: boolean;
  tokensRefunded: boolean;
  key: string;
  otherNetwork: string;
  otherAsset: string;
  otherAmount: bigint;
  exists: boolean;
}

export function htlcContract(address: string, runner: ContractRunner): Contract {
  return new Contract(address, HTLC_ERC20_ABI, runner);
}

export function erc20Contract(address: string, runner: ContractRunner): Contract {
  return new Contract(address, ERC20_ABI, runner);
}

export async function readInstance(contract: Contract, agreementId: string): Promise<HtlcInstance> {
  const r = await contract.getFunction('getHTLCInstance').staticCall(agreementId);
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

export type HtlcEvent =
  | ({ kind: 'lockup'; agreementId: string; txHash: string; blockNumber: number; logIndex: number } & Omit<HtlcLockParams, never>)
  | { kind: 'claimed'; agreementId: string; txHash: string; blockNumber: number; logIndex: number }
  | { kind: 'redeemed'; agreementId: string; txHash: string; blockNumber: number; logIndex: number };

export function decodeHtlcLog(log: LogLike): HtlcEvent | null {
  let parsed;
  try {
    parsed = htlcInterface.parseLog({ topics: [...log.topics], data: log.data });
  } catch {
    return null;
  }
  if (!parsed) return null;
  const base = { agreementId: String(parsed.args.agreementId).toLowerCase(), txHash: log.transactionHash, blockNumber: log.blockNumber, logIndex: log.index };
  if (parsed.name === 'HTLCERC20Lockup') {
    return {
      kind: 'lockup',
      ...base,
      partyA: String(parsed.args.partyA),
      partyB: String(parsed.args.partyB),
      secretlock: String(parsed.args.secretlock).toLowerCase(),
      deadline: Number(parsed.args.deadline),
      erc20Contract: String(parsed.args.erc20Contract),
      tokenAmount: BigInt(parsed.args.tokenAmount),
      otherNetwork: String(parsed.args.otherNetwork),
      otherAsset: String(parsed.args.otherAsset),
      otherAmount: BigInt(parsed.args.otherAmount),
    };
  }
  if (parsed.name === 'HTLCERC20Claimed') return { kind: 'claimed', ...base };
  if (parsed.name === 'HTLCERC20Redeemed') return { kind: 'redeemed', ...base };
  return null;
}

export function encodeLockCalldata(p: Omit<HtlcLockParams, 'partyA'>): string {
  return htlcInterface.encodeFunctionData('createHTLCProposal', [[p.partyB, p.secretlock, p.deadline, p.erc20Contract, p.tokenAmount, p.otherNetwork, p.otherAsset, p.otherAmount]]);
}

export function encodeWithdrawCalldata(agreementId: string, preimageHex: string): string {
  return htlcInterface.encodeFunctionData('withdrawTokens', [agreementId, preimageHex.startsWith('0x') ? preimageHex : `0x${preimageHex}`]);
}

export function encodeRefundCalldata(agreementId: string): string {
  return htlcInterface.encodeFunctionData('refundTokens', [agreementId]);
}

export function encodeApproveCalldata(spender: string, amount: bigint): string {
  return erc20Interface.encodeFunctionData('approve', [spender, amount]);
}
