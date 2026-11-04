import { HTLCParams, P2MRLeaf, CliCommands } from '../types/btq.types';
import { bufToHex } from '../lib/crypto';

const OP_SHA256 = 0xa8;
const OP_EQUALVERIFY = 0x88;
const OP_CHECKSIGDILITHIUM = 0xbb;
const OP_CHECKLOCKTIMEVERIFY = 0xb1;
const OP_DROP = 0x75;
const OP_PUSHDATA2 = 0x4d;

const LEAF_VERSION = 192;

function pushData(data: Buffer): Buffer {
  const len = data.length;
  if (len <= 75) {
    return Buffer.concat([Buffer.from([len]), data]);
  }
  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16LE(len);
  return Buffer.concat([Buffer.from([OP_PUSHDATA2]), lenBuf, data]);
}

function encodeScriptNum(value: number): Buffer {
  if (value === 0) return Buffer.alloc(0);

  const negative = value < 0;
  let absValue = Math.abs(value);
  const result: number[] = [];

  while (absValue > 0) {
    result.push(absValue & 0xff);
    absValue >>= 8;
  }

  if (result[result.length - 1] & 0x80) {
    result.push(negative ? 0x80 : 0x00);
  } else if (negative) {
    result[result.length - 1] |= 0x80;
  }

  return Buffer.from(result);
}

export class ScriptBuilderService {
  buildClaimLeaf(secretHash: Buffer, claimPubkey: string): Buffer {
    const pubkeyBuf = Buffer.from(claimPubkey, 'hex');
    const hashPush = pushData(secretHash);
    const pubkeyPush = pushData(pubkeyBuf);

    return Buffer.concat([
      Buffer.from([OP_SHA256]),
      hashPush,
      Buffer.from([OP_EQUALVERIFY]),
      pubkeyPush,
      Buffer.from([OP_CHECKSIGDILITHIUM]),
    ]);
  }

  buildRefundLeaf(timelockBlocks: number, refundPubkey: string): Buffer {
    const pubkeyBuf = Buffer.from(refundPubkey, 'hex');
    const timelockNum = encodeScriptNum(timelockBlocks);
    const timelockPush = pushData(timelockNum);
    const pubkeyPush = pushData(pubkeyBuf);

    return Buffer.concat([
      timelockPush,
      Buffer.from([OP_CHECKLOCKTIMEVERIFY]),
      Buffer.from([OP_DROP]),
      pubkeyPush,
      Buffer.from([OP_CHECKSIGDILITHIUM]),
    ]);
  }

  buildLeaves(params: HTLCParams): { claimLeaf: P2MRLeaf; refundLeaf: P2MRLeaf } {
    const claimScript = this.buildClaimLeaf(params.secretHash, params.claimPubkey);
    const refundScript = this.buildRefundLeaf(params.timelockBlocks, params.refundPubkey);

    return {
      claimLeaf: {
        depth: 1,
        leaf_version: LEAF_VERSION,
        script: bufToHex(claimScript),
      },
      refundLeaf: {
        depth: 1,
        leaf_version: LEAF_VERSION,
        script: bufToHex(refundScript),
      },
    };
  }

  generateCliCommands(
    swapId: string,
    claimLeaf: P2MRLeaf,
    refundLeaf: P2MRLeaf,
    p2mrAddress: string,
    amountBtq: number,
    txid: string,
    vout: number,
    destination: string,
    feeRate: number,
    secretHex: string,
    controlBlockHex: string,
  ): CliCommands {
    const leavesJson = JSON.stringify([claimLeaf, refundLeaf]);

    return {
      createAddress: `btq-cli getnewp2mraddress '${leavesJson}' "htlc-${swapId}"`,
      sendToAddress: `btq-cli sendtoaddress ${p2mrAddress} ${amountBtq}`,
      createSpend: `btq-cli createp2mrspend ${txid} ${vout} ${destination} ${feeRate}`,
      signTransaction: `btq-cli signp2mrtransaction <hex> --witness_args '["${secretHex}"]' --leaf_script '${claimLeaf.script}' --control_block '${controlBlockHex}'`,
      broadcastTransaction: 'btq-cli sendrawtransaction <hex>',
    };
  }

  generateClaimCommands(
    _txid: string,
    _vout: number,
    destination: string,
    feeRate: number,
    secretHex: string,
    claimLeafHex: string,
    controlBlockHex: string,
  ): { createSpend: string; signTransaction: string; broadcastTransaction: string } {
    return {
      createSpend: `btq-cli -regtest -rpcwallet=swap-wallet createp2mrspend "<p2mr_id>" "${destination}" <amount_minus_fee> ${feeRate}`,
      signTransaction: `btq-cli -regtest -rpcwallet=swap-wallet signp2mrtransaction "<unsigned_hex>" "<p2mr_id>" '["${secretHex}"]' "${claimLeafHex}" "${controlBlockHex}"`,
      broadcastTransaction: 'btq-cli sendrawtransaction <hex>',
    };
  }

  generateRefundCommands(
    _txid: string,
    _vout: number,
    destination: string,
    feeRate: number,
    refundLeafHex: string,
    controlBlockHex: string,
  ): { createSpend: string; signTransaction: string; broadcastTransaction: string } {
    return {
      createSpend: `btq-cli -regtest -rpcwallet=swap-wallet createp2mrspend "<p2mr_id>" "${destination}" <amount_minus_fee> ${feeRate}`,
      signTransaction: `btq-cli -regtest -rpcwallet=swap-wallet signp2mrtransaction "<unsigned_hex>" "<p2mr_id>" '[]' "${refundLeafHex}" "${controlBlockHex}"`,
      broadcastTransaction: 'btq-cli sendrawtransaction <hex>',
    };
  }
}

export const scriptBuilderService = new ScriptBuilderService();
