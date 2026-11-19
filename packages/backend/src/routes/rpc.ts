import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config';
import { btqChain } from '../chains/btq';

/**
 * Public, method-whitelisted JSON-RPC proxy for the devnet EVM chain. Never forwards anvil_*, evm_*,
 * hardhat_*, debug_*, personal_* or eth_sendTransaction (anvil dev accounts are unlocked).
 */
const ALLOWED = new Set([
  'web3_clientVersion', 'net_version', 'eth_chainId', 'eth_blockNumber', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory',
  'eth_getBalance', 'eth_getTransactionCount', 'eth_getCode', 'eth_call', 'eth_estimateGas', 'eth_getBlockByNumber', 'eth_getBlockByHash',
  'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getLogs', 'eth_sendRawTransaction', 'eth_syncing', 'eth_accounts',
]);

interface RpcReq { jsonrpc?: string; id?: unknown; method: string; params?: unknown }

/**
 * Validate a JSON-RPC body from the public internet. Every entry must be a non-null object whose
 * method is whitelisted; anything else is rejected before any entry is touched.
 */
export function checkRpcBatch(body: unknown): { batch: RpcReq[] } | { status: number; error: { code: number; message: string }; id: unknown } {
  const batch: unknown[] = Array.isArray(body) ? body : [body];
  if (!batch.length || batch.length > 20) return { status: 400, error: { code: -32600, message: 'invalid batch' }, id: null };
  for (const r of batch) {
    if (typeof r !== 'object' || r === null || Array.isArray(r)) return { status: 400, error: { code: -32600, message: 'invalid request' }, id: null };
    const { method, id } = r as { method?: unknown; id?: unknown };
    if (typeof method !== 'string' || !ALLOWED.has(method)) {
      return { status: 200, error: { code: -32601, message: `method ${String(method)} is not available on this endpoint` }, id: id ?? null };
    }
  }
  return { batch: batch as RpcReq[] };
}

export const rpcRoutes = Router();
rpcRoutes.use(rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false }));

// Express 4 does not catch rejected async handlers, and an escaped rejection exits the process: pass errors to next().
rpcRoutes.post('/rpc/evm', async (req, res, next) => {
  try {
    const body = req.body as unknown;
    const checked = checkRpcBatch(body);
    if (!('batch' in checked)) {
      res.status(checked.status).json({ jsonrpc: '2.0', id: checked.id, error: checked.error });
      return;
    }
    const { batch } = checked;
    // eth_accounts must never reveal the node's unlocked dev accounts
    const forward = batch.filter((r) => r.method !== 'eth_accounts');
    const answers: unknown[] = batch.filter((r) => r.method === 'eth_accounts').map((r) => ({ jsonrpc: '2.0', id: r.id, result: [] }));
    if (forward.length) {
      const upstream = await fetch(config().EVM_RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(forward) });
      const out = (await upstream.json()) as unknown[];
      answers.push(...out);
    }
    res.json(Array.isArray(body) ? answers : answers[0]);
  } catch (err) {
    next(err);
  }
});

/** Broadcast a fully signed BTQ transaction (e.g. a btq-htlc claim) after a mempool dry run. */
rpcRoutes.post('/public/btq/tx', async (req, res, next) => {
  try {
    const hex = String(req.body?.hex ?? '').trim();
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length > 400_000) {
      res.status(400).json({ error: 'hex must be a raw transaction' });
      return;
    }
    const accept = await btqChain().testAccept(hex).catch((e: Error) => ({ allowed: false, 'reject-reason': e.message, txid: '' }));
    if (!accept.allowed) {
      res.status(400).json({ error: `rejected: ${accept['reject-reason']}` });
      return;
    }
    const txid = await btqChain().broadcast(hex);
    res.json({ txid });
  } catch (err) {
    next(err);
  }
});
