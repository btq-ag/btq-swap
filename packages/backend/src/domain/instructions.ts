import { btqNetworkTag, swapBindingAsset } from '@btq-swap/htlc';
import { config, sellerTimeBudgetSec } from '../config';
import { btqCliNetworkFlag } from '../chains/btq';
import { fromUnits } from './money';
import { STATUS_LABEL, type Role, type SwapRow } from './types';

export interface Instruction {
  role: Role;
  actionable: boolean;
  headline: string;
  detail: string;
  commands: string[];
  deadline: Date | null;
}

export function publicApiUrl(): string {
  return `${config().PUBLIC_BASE_URL.replace(/\/+$/, '')}/api`;
}

export function cliUrl(): string {
  return `${config().PUBLIC_BASE_URL.replace(/\/+$/, '')}/downloads/btq-htlc.mjs`;
}

function evmRpc(): string {
  return config().PUBLIC_EVM_RPC_URL ?? config().EVM_RPC_URL;
}

function cli(args: string): string {
  return `node btq-htlc.mjs ${args} --api ${publicApiUrl()}`;
}

export function usdtDisplay(swap: Pick<SwapRow, 'amount_usdt_units'>): string {
  return fromUnits(BigInt(swap.amount_usdt_units), config().USDT_DECIMALS);
}

export function lockParams(swap: SwapRow): Record<string, string> {
  return {
    htlcContract: swap.evm_htlc_contract,
    token: swap.evm_token,
    partyB: swap.seller_eth,
    tokenAmountUnits: swap.amount_usdt_units,
    otherNetwork: btqNetworkTag(swap.btq_network),
    otherAsset: swapBindingAsset(swap.id),
    otherAmount: swap.amount_sats,
    deadline: `now + ${config().SWAP_EVM_LOCK_DURATION_SEC}s (max ${config().SWAP_EVM_LOCK_MAX_DURATION_SEC}s)`,
  };
}

/** What the viewer has to do next for this swap. Never contains a preimage before it is public on-chain. */
export function instructionFor(swap: SwapRow, role: Role, tipHeight?: number): Instruction {
  const n = swap.short_id;
  const btq = `${swap.amount_btq} BTQ`;
  const usdt = `${usdtDisplay(swap)} USDT`;
  const wait = (headline: string, deadline: Date | null = null): Instruction => ({ role, actionable: false, headline, detail: STATUS_LABEL[swap.status], commands: [], deadline });

  switch (swap.status) {
    case 'awaiting_buyer_lock':
      if (role === 'buyer') {
        return {
          role,
          actionable: true,
          headline: `Lock ${usdt} for the seller`,
          detail:
            `1) Create your swap secret locally (only its hash leaves your machine).\n` +
            `2) Lock ${usdt} in the HTLC with partyB = seller \`${swap.seller_eth}\`. ` +
            `The lock must carry \`otherAsset = "${swapBindingAsset(swap.id)}"\`.\n` +
            `Lock before <t:${Math.floor(swap.buyer_lock_by.getTime() / 1000)}:R> or the swap expires.`,
          commands: [
            `curl -fsSLO ${cliUrl()}`,
            cli(`secret new --swap ${n}`),
            cli(`evm lock --swap ${n} --evm-rpc ${evmRpc()} --key env:EVM_PRIVATE_KEY`),
          ],
          deadline: swap.buyer_lock_by,
        };
      }
      return wait(`Waiting for the buyer to lock ${usdt}`, swap.buyer_lock_by);
    case 'buyer_lock_confirming':
      return wait(`Buyer's ${usdt} lock is confirming (${swap.evm_lock_confs}/${config().EVM_MIN_CONFIRMATIONS})`);
    case 'awaiting_seller_lock':
      if (role === 'seller') {
        return {
          role,
          actionable: true,
          headline: `Lock ${btq} in the BTQ HTLC`,
          detail:
            `The buyer's ${usdt} is locked on-chain for you until <t:${Math.floor((swap.evm_deadline?.getTime() ?? 0) / 1000)}:f>.\n` +
            `Send exactly **${btq}** to the HTLC address below from any BTQ wallet. ` +
            `You can refund it yourself after block ${swap.btq_refund_locktime} if the buyer never claims.\n` +
            `Lock before <t:${Math.floor((swap.seller_lock_by?.getTime() ?? 0) / 1000)}:R>.`,
          commands: [`btq-cli ${btqCliNetworkFlag(swap.btq_network as never)}sendtoaddress ${swap.btq_htlc_address} ${swap.amount_btq}`],
          deadline: swap.seller_lock_by,
        };
      }
      return wait(`Waiting for the seller to lock ${btq}`, swap.seller_lock_by);
    case 'seller_lock_confirming':
      return wait(`Seller's ${btq} lock is confirming (${swap.btq_lock_confs}/${config().BTQ_MIN_CONFIRMATIONS})`);
    case 'awaiting_buyer_claim':
      if (role === 'buyer') {
        return {
          role,
          actionable: true,
          headline: `Claim your ${btq}`,
          detail:
            `The seller's BTQ is locked for your swap key. Claim it before block **${swap.btq_refund_locktime}**` +
            (tipHeight ? ` (now ${tipHeight})` : '') +
            `. Claiming reveals your secret, which lets the seller collect the USDT.`,
          commands: [cli(`claim --swap ${n} --to ${swap.buyer_btq_address ?? '<your BTQ address>'}`), `btq-cli ${btqCliNetworkFlag(swap.btq_network as never)}sendrawtransaction <hex printed above>`],
          deadline: null,
        };
      }
      return wait(`Waiting for the buyer to claim ${btq} (before block ${swap.btq_refund_locktime})`);
    case 'awaiting_seller_claim':
      if (role === 'seller') {
        return {
          role,
          actionable: true,
          headline: `Collect your ${usdt}`,
          detail:
            `The buyer claimed the BTQ and revealed the secret \`${swap.revealed_preimage}\`. ` +
            `Withdraw the USDT before <t:${Math.floor((swap.evm_deadline?.getTime() ?? 0) / 1000)}:R>.`,
          commands: [cli(`evm claim --swap ${n} --evm-rpc ${evmRpc()} --key env:EVM_PRIVATE_KEY`)],
          deadline: swap.evm_deadline,
        };
      }
      return wait(`You received ${btq}. The seller is collecting the USDT.`);
    case 'awaiting_buyer_refund':
      if (role === 'buyer') {
        return {
          role,
          actionable: true,
          headline: `Refund your ${usdt}`,
          detail: `The seller did not lock BTQ in time. Your USDT unlocks at <t:${Math.floor((swap.evm_deadline?.getTime() ?? 0) / 1000)}:f>; refund it then.`,
          commands: [cli(`evm refund --swap ${n} --evm-rpc ${evmRpc()} --key env:EVM_PRIVATE_KEY`)],
          deadline: swap.evm_deadline,
        };
      }
      return wait('You did not lock BTQ in time; the buyer will refund.');
    case 'awaiting_refunds':
      if (role === 'seller' && swap.btq_lock_txid && !swap.btq_refund_txid && !swap.btq_claim_txid) {
        return {
          role,
          actionable: true,
          headline: `Refund your ${btq}`,
          detail: `The buyer never claimed. Your BTQ refund opened at block ${swap.btq_refund_locktime}.`,
          commands: [cli(`refund --swap ${n} --to ${swap.seller_btq_address ?? '<your BTQ address>'}`), `btq-cli ${btqCliNetworkFlag(swap.btq_network as never)}sendrawtransaction <hex printed above>`],
          deadline: null,
        };
      }
      if (role === 'buyer' && swap.evm_agreement_id && !swap.evm_refund_tx && !swap.evm_claim_tx) {
        return {
          role,
          actionable: true,
          headline: `Refund your ${usdt}`,
          detail: `The swap timed out. Your USDT unlocks at <t:${Math.floor((swap.evm_deadline?.getTime() ?? 0) / 1000)}:f>.`,
          commands: [cli(`evm refund --swap ${n} --evm-rpc ${evmRpc()} --key env:EVM_PRIVATE_KEY`)],
          deadline: swap.evm_deadline,
        };
      }
      return wait('Waiting for the remaining refund.');
    default:
      return wait(STATUS_LABEL[swap.status]);
  }
}

export function timingSummary(): string {
  const c = config();
  return `buyer lock window ${c.SWAP_BUYER_LOCK_WINDOW_SEC}s · USDT lock ${c.SWAP_EVM_LOCK_DURATION_SEC}s · seller window ${c.SWAP_SELLER_LOCK_WINDOW_SEC}s · BTQ lock ${c.SWAP_BTQ_LOCK_BLOCKS} blocks · seller budget ${sellerTimeBudgetSec()}s`;
}
