import { btqRpc } from '../lib/btqRpc';
import { config } from '../config';
import {
  BtqBlockchainInfo,
  BtqTransaction,
  BtqWalletInfo,
  P2MRLeaf,
} from '../types/btq.types';

export class BtqService {
  async getBlockchainInfo(): Promise<BtqBlockchainInfo> {
    return btqRpc.call<BtqBlockchainInfo>('getblockchaininfo');
  }

  async getBlockCount(): Promise<number> {
    return btqRpc.call<number>('getblockcount');
  }

  async getWalletInfo(): Promise<BtqWalletInfo> {
    return btqRpc.call<BtqWalletInfo>('getwalletinfo');
  }

  async getBalance(): Promise<number> {
    return btqRpc.call<number>('getbalance');
  }

  async getAddressBalance(address: string): Promise<number | null> {
    try {
      const result = await btqRpc.call<{ total_amount?: number }>('scantxoutset', [
        'start',
        [`addr(${address})`],
      ]);
      const balance = Number(result?.total_amount ?? 0);
      console.log('[BtqService] getAddressBalance success', {
        address,
        balance,
      });
      return balance;
    } catch (err) {
      console.error('[BtqService] getAddressBalance failed', {
        address,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async getNewP2MRAddress(leaves: P2MRLeaf[], label: string): Promise<string> {
    return btqRpc.call<string>('getnewp2mraddress', [leaves, label]);
  }

  async sendToAddress(address: string, amount: number): Promise<string> {
    return btqRpc.call<string>('sendtoaddress', [address, amount]);
  }

  async getTransaction(txid: string): Promise<BtqTransaction> {
    return btqRpc.call<BtqTransaction>('gettransaction', [txid]);
  }

  async getRawTransaction(txid: string, verbose?: boolean): Promise<BtqTransaction | string> {
    return btqRpc.call<BtqTransaction | string>('getrawtransaction', [
      txid,
      verbose ?? true,
    ]);
  }

  async getTransactionConfirmations(txid: string): Promise<number> {
    try {
      const tx = await this.getRawTransaction(txid, true) as BtqTransaction;
      return tx.confirmations ?? 0;
    } catch {
      return 0;
    }
  }

  async createP2MRSpend(
    txid: string,
    vout: number,
    destination: string,
    feeRate: number,
  ): Promise<string> {
    return btqRpc.call<string>('createp2mrspend', [txid, vout, destination, feeRate]);
  }

  async signP2MRTransaction(
    hex: string,
    witnessArgs: string[],
    leafScript: string,
    controlBlock: string,
  ): Promise<string> {
    return btqRpc.call<string>('signp2mrtransaction', [
      hex,
      witnessArgs,
      leafScript,
      controlBlock,
    ]);
  }

  async sendRawTransaction(hex: string): Promise<string> {
    return btqRpc.call<string>('sendrawtransaction', [hex]);
  }

  async validateAddress(address: string): Promise<{ isvalid: boolean }> {
    return btqRpc.call<{ isvalid: boolean }>('validateaddress', [address]);
  }

  async listUnspent(minConf = 0, maxConf = 9999999): Promise<unknown[]> {
    return btqRpc.call<unknown[]>('listunspent', [minConf, maxConf]);
  }

  async createHtlcAddress(
    claimLeaf: P2MRLeaf,
    refundLeaf: P2MRLeaf,
    swapId: string,
  ): Promise<string> {
    return this.getNewP2MRAddress(
      [claimLeaf, refundLeaf],
      `htlc-${swapId}`,
    );
  }

  async fundHtlc(address: string, amountBtq: number): Promise<string> {
    return this.sendToAddress(address, amountBtq);
  }

  async claimHtlc(
    txid: string,
    vout: number,
    destination: string,
    feeRate: number,
    secret: string,
    claimLeafHex: string,
    controlBlockHex: string,
  ): Promise<string> {
    const unsignedHex = await this.createP2MRSpend(txid, vout, destination, feeRate);
    const signedHex = await this.signP2MRTransaction(
      unsignedHex,
      [secret],
      claimLeafHex,
      controlBlockHex,
    );
    return this.sendRawTransaction(signedHex);
  }

  async refundHtlc(
    txid: string,
    vout: number,
    destination: string,
    feeRate: number,
    refundLeafHex: string,
    controlBlockHex: string,
  ): Promise<string> {
    const unsignedHex = await this.createP2MRSpend(txid, vout, destination, feeRate);
    const signedHex = await this.signP2MRTransaction(
      unsignedHex,
      [],
      refundLeafHex,
      controlBlockHex,
    );
    return this.sendRawTransaction(signedHex);
  }
}

export const btqService = new BtqService();
