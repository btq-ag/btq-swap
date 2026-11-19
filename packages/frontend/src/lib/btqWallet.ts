export interface BtqAccount {
  id: string;
  address: string;
}

export interface BtqProof {
  scheme: 'btq-wallet-message';
  version: 1;
  origin: string;
  network: string;
  address: string;
  message: string;
  publicKey: string;
  signature: string;
}

export interface BtqProvider {
  connect(): Promise<BtqAccount[]>;
  getAccounts(): Promise<BtqAccount[]>;
  getNetwork(): Promise<{ network: string; addressPrefix: string }>;
  signMessage(input: { message: string; accountId?: string }): Promise<BtqProof>;
  requestSend(input: { to: string; amountSats: string; accountId?: string }): Promise<{ txid: string }>;
}

export function btqProvider(): BtqProvider | null {
  const btq = (window as unknown as { btq?: BtqProvider }).btq;
  return btq?.connect ? btq : null;
}

export async function connectBtq(): Promise<BtqAccount> {
  const btq = btqProvider();
  if (!btq) throw new Error('The BTQ wallet extension is not installed in this browser.');
  const accounts = await btq.connect();
  const account = accounts[0];
  if (!account) throw new Error('The BTQ wallet did not grant an account.');
  return account;
}
