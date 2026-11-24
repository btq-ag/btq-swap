/**
 * Deploys the SPL HTLC to a local test validator and runs lock, withdraw, and refund.
 *   npx tsx packages/backend/scripts/solana-htlc-e2e.ts
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Connection, Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { buildHtlcTransaction, htlcAddress, agreementId, parseSolHtlcState } from '../src/chains/solana-htlc';

const tool = (name: string) => process.env.SOLANA_TOOLS_DIR ? join(process.env.SOLANA_TOOLS_DIR, name) : name;
const RPC = process.env.SOLANA_E2E_RPC ?? 'http://127.0.0.1:18999';
const PROGRAM_SO = new URL('../../solana-htlc/target/deploy/btq_sol_htlc.so', import.meta.url);
const PROGRAM_KEY = new URL('../../solana-htlc/target/deploy/btq_sol_htlc-keypair.json', import.meta.url);

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function waitForRpc(connection: Connection): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      await connection.getSlot();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error('validator did not start');
}

async function send(connection: Connection, payer: Keypair, tx: Awaited<ReturnType<typeof buildHtlcTransaction>>, signers: Keypair[]): Promise<string> {
  tx.partialSign(...signers);
  const sig = await connection.sendRawTransaction(tx.serialize());
  const result = await connection.confirmTransaction(sig, 'confirmed');
  if (result.value.err) throw new Error(`transaction failed: ${JSON.stringify(result.value.err)}`);
  return sig;
}

async function main(): Promise<void> {
  const url = new URL(RPC);
  const ledger = mkdtempSync(join(tmpdir(), 'btq-sol-ledger-'));
  const validator = spawn(tool('solana-test-validator'), ['--reset', '--ledger', ledger, '--rpc-port', url.port, '--faucet-port', '19900', '--bind-address', '127.0.0.1'], {
    stdio: 'ignore',
  });
  const connection = new Connection(RPC, 'confirmed');
  try {
    await waitForRpc(connection);
    const deployer = Keypair.generate();
    const deployerPath = join(mkdtempSync(join(tmpdir(), 'btq-sol-')), 'id.json');
    writeFileSync(deployerPath, JSON.stringify(Array.from(deployer.secretKey)));
    const airdrop = await connection.requestAirdrop(deployer.publicKey, 5_000_000_000);
    await connection.confirmTransaction(airdrop, 'confirmed');
    await run(tool('solana'), ['program', 'deploy', PROGRAM_SO.pathname, '--program-id', PROGRAM_KEY.pathname, '--keypair', deployerPath, '--url', RPC]);
    const programId = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(PROGRAM_KEY, 'utf8')) as number[])).publicKey;
    const buyer = Keypair.generate();
    const seller = Keypair.generate();
    for (const who of [buyer, seller]) {
      const sig = await connection.requestAirdrop(who.publicKey, 2_000_000_000);
      await connection.confirmTransaction(sig, 'confirmed');
    }
    const mint = await createMint(connection, buyer, buyer.publicKey, null, 6);
    const buyerAta = await getOrCreateAssociatedTokenAccount(connection, buyer, mint, buyer.publicKey);
    await mintTo(connection, buyer, mint, buyerAta.address, buyer, 5_000_000n);

    const secret = createHash('sha256').update('solana-htlc-e2e').digest().subarray(0, 32);
    const secretHash = createHash('sha256').update(secret).digest();
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
    const amount = 1_500_000n;
    const id = agreementId(buyer.publicKey, seller.publicKey, mint, amount, secretHash, deadline);
    const statePk = htlcAddress(programId, id);
    const vault = getAssociatedTokenAddressSync(mint, statePk, true);
    // Exercise the actual ATA and system programs against both prefunded addresses.
    const emptyAccountRent = await connection.getMinimumBalanceForRentExemption(0);
    const prefund = new Transaction().add(...[statePk, vault].map(toPubkey => SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey, lamports: emptyAccountRent })));
    prefund.feePayer = deployer.publicKey; prefund.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    await send(connection, deployer, prefund, [deployer]);
    const lock = await buildHtlcTransaction({
      connection, programId, mint, feePayer: buyer.publicKey, action: 'lock',
      partyA: buyer.publicKey, partyB: seller.publicKey, amount, secretHash, deadline,
    });
    await send(connection, buyer, lock, [buyer]);
    const locked = parseSolHtlcState(Buffer.from((await connection.getAccountInfo(statePk))!.data));
    if (!locked || locked.amount !== amount || locked.withdrawn) throw new Error('lock did not land');

    await mintTo(connection, buyer, mint, vault, buyer, 17n);
    const buyerBefore = await connection.getBalance(buyer.publicKey);
    const returnedRent = await connection.getBalance(statePk) + await connection.getBalance(vault);
    const withdraw = await buildHtlcTransaction({
      connection, programId, mint, feePayer: seller.publicKey, action: 'withdraw',
      partyA: buyer.publicKey, partyB: seller.publicKey, amount, secretHash, deadline, preimage: secret,
    });
    await send(connection, seller, withdraw, [seller]);
    const sellerAta = await getOrCreateAssociatedTokenAccount(connection, seller, mint, seller.publicKey);
    const received = await getAccount(connection, sellerAta.address);
    if (received.amount !== amount + 17n) throw new Error(`seller received ${received.amount}`);

    if (await connection.getAccountInfo(statePk) || await connection.getAccountInfo(vault)) throw new Error('claim left escrow accounts open');
    if (await connection.getBalance(buyer.publicKey) !== buyerBefore + returnedRent) throw new Error('claim did not return all rent to buyer');

    const refundHash = createHash('sha256').update('refund-preimage-32-bytes-pad!!').digest().subarray(0, 32);
    const refundDeadline = BigInt(Math.floor(Date.now() / 1000) + 2);
    const refundAmount = 250_000n;
    const lock2 = await buildHtlcTransaction({
      connection, programId, mint, feePayer: buyer.publicKey, action: 'lock',
      partyA: buyer.publicKey, partyB: seller.publicKey, amount: refundAmount, secretHash: refundHash, deadline: refundDeadline,
    });
    await send(connection, buyer, lock2, [buyer]);
    await new Promise((r) => setTimeout(r, 3000));
    const refund = await buildHtlcTransaction({
      connection, programId, mint, feePayer: buyer.publicKey, action: 'refund',
      partyA: buyer.publicKey, partyB: seller.publicKey, amount: refundAmount, secretHash: refundHash, deadline: refundDeadline,
    });
    await send(connection, buyer, refund, [buyer]);
    const refundedState = htlcAddress(programId, agreementId(buyer.publicKey, seller.publicKey, mint, refundAmount, refundHash, refundDeadline));
    if (await connection.getAccountInfo(refundedState) || await connection.getAccountInfo(getAssociatedTokenAddressSync(mint, refundedState, true))) throw new Error('refund left escrow accounts open');
    console.log('solana htlc e2e passed', programId.toBase58());
  } finally {
    validator.kill('SIGTERM');
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
