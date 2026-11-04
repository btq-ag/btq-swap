export interface BtqRpcConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  wallet: string;
}

export interface P2MRLeaf {
  depth: number;
  leaf_version: number;
  script: string;
}

export interface HTLCParams {
  secretHash: Buffer;
  claimPubkey: string;
  refundPubkey: string;
  timelockBlocks: number;
}

export interface CliCommands {
  createAddress: string;
  sendToAddress: string;
  createSpend: string;
  signTransaction: string;
  broadcastTransaction: string;
}

export interface BtqBlockchainInfo {
  chain: string;
  blocks: number;
  headers: number;
  bestblockhash: string;
  difficulty: number;
  mediantime: number;
}

export interface BtqTransaction {
  txid: string;
  hash: string;
  version: number;
  size: number;
  vsize: number;
  weight: number;
  locktime: number;
  vin: BtqTxInput[];
  vout: BtqTxOutput[];
  hex: string;
  blockhash?: string;
  confirmations?: number;
  time?: number;
  blocktime?: number;
}

export interface BtqTxInput {
  txid: string;
  vout: number;
  scriptSig: { asm: string; hex: string };
  sequence: number;
}

export interface BtqTxOutput {
  value: number;
  n: number;
  scriptPubKey: {
    asm: string;
    hex: string;
    type: string;
    address?: string;
  };
}

export interface BtqWalletInfo {
  walletname: string;
  balance: number;
  unconfirmed_balance: number;
  immature_balance: number;
  txcount: number;
}

export interface BtqRpcError {
  code: number;
  message: string;
}
