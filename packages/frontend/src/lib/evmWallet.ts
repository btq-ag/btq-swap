export interface EthereumProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, cb: (...args: unknown[]) => void): void;
  removeListener?(event: string, cb: (...args: unknown[]) => void): void;
}

let chosen: EthereumProvider | null = null;

/** Remember which injected EVM wallet the desk should sign with. */
export function selectEthereumProvider(provider: EthereumProvider): void {
  chosen = provider;
}

export function ethereumProvider(): EthereumProvider | null {
  if (chosen?.request) return chosen;
  const eth = (window as unknown as { ethereum?: EthereumProvider }).ethereum;
  return eth?.request ? eth : null;
}

export async function connectMetaMask(): Promise<string> {
  const eth = ethereumProvider();
  if (!eth) throw new Error('MetaMask is not installed in this browser.');
  const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
  const address = accounts[0];
  if (!address) throw new Error('MetaMask did not return an account.');
  return address;
}

export async function signMessage(address: string, message: string): Promise<string> {
  const eth = ethereumProvider();
  if (!eth) throw new Error('MetaMask is not installed in this browser.');
  const signature = (await eth.request({ method: 'personal_sign', params: [message, address] })) as string;
  if (!signature) throw new Error('MetaMask did not return a signature.');
  return signature;
}

export async function chainId(): Promise<number> {
  const eth = ethereumProvider();
  if (!eth) throw new Error('MetaMask is not installed in this browser.');
  const hex = (await eth.request({ method: 'eth_chainId' })) as string;
  return Number.parseInt(hex, 16);
}

export async function switchChain(id: number): Promise<void> {
  const eth = ethereumProvider();
  if (!eth) throw new Error('MetaMask is not installed in this browser.');
  const hex = `0x${id.toString(16)}`;
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code !== 4902) throw err;
    await eth.request({
      method: 'wallet_addEthereumChain',
      params: [{ chainId: hex, chainName: `EVM ${id}`, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: [`${location.origin}/api/rpc/evm`] }],
    });
  }
}

export async function sendTx(from: string, to: string, data: string): Promise<string> {
  const eth = ethereumProvider();
  if (!eth) throw new Error('MetaMask is not installed in this browser.');
  const hash = (await eth.request({ method: 'eth_sendTransaction', params: [{ from, to, data }] })) as string;
  if (!hash) throw new Error('MetaMask did not return a transaction.');
  return hash;
}

export function walletError(err: unknown): string {
  const e = err as { code?: number; message?: string };
  if (e.code === 4001) return 'You rejected the request in the wallet.';
  return e.message || 'The wallet request failed.';
}
