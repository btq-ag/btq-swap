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

interface RpcReq { jsonrpc?: string; id?: unknown; method?: string; params?: unknown }

export const rpcRoutes = Router();
rpcRoutes.use(rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false }));

rpcRoutes.post('/rpc/evm', async (req, res) => {
  const body = req.body as RpcReq | RpcReq[];
  const batch = Array.isArray(body) ? body : [body];
  if (!batch.length || batch.length > 20) {
    res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid batch' } });
    return;
  }
  const denied = batch.find((r) => !r || typeof r.method !== 'string' || !ALLOWED.has(r.method));
  if (denied) {
    res.json({ jsonrpc: '2.0', id: denied?.id ?? null, error: { code: -32601, message: `method ${denied?.method} is not available on this endpoint` } });
    return;
  }
  // eth_accounts must never reveal the node's unlocked dev accounts
  const forward = batch.filter((r) => r.method !== 'eth_accounts');
  const answers: unknown[] = batch.filter((r) => r.method === 'eth_accounts').map((r) => ({ jsonrpc: '2.0', id: r.id, result: [] }));
  if (forward.length) {
    const upstream = await fetch(config().EVM_RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(forward) });
    const out = (await upstream.json()) as unknown[];
    answers.push(...out);
  }
  res.json(Array.isArray(body) ? answers : answers[0]);
});

/** Broadcast a fully signed BTQ transaction (e.g. a btq-htlc claim) after a mempool dry run. */
rpcRoutes.post('/public/btq/tx', async (req, res) => {
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
});
