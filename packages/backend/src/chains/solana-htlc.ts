import { createHash } from 'node:crypto';
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

export const SOL_HTLC_STATE_LEN = 179;

export interface SolHtlcState {
  partyA: PublicKey;
  partyB: PublicKey;
  mint: PublicKey;
  secretHash: Buffer;
  deadline: bigint;
  amount: bigint;
  withdrawn: boolean;
  refunded: boolean;
  preimage: Buffer;
}

export function agreementId(partyA: PublicKey, partyB: PublicKey, mint: PublicKey, amount: bigint, secretHash: Buffer, deadline: bigint): Buffer {
  const buf = Buffer.alloc(144);
  partyA.toBuffer().copy(buf, 0);
  partyB.toBuffer().copy(buf, 32);
  mint.toBuffer().copy(buf, 64);
  buf.writeBigUInt64LE(amount, 96);
  secretHash.copy(buf, 104, 0, 32);
  buf.writeBigUInt64LE(deadline, 136);
  return createHash('sha256').update(buf).digest();
}

export function htlcAddress(programId: PublicKey, id: Buffer): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('htlc'), id], programId)[0];
}

export function parseSolHtlcState(data: Buffer): SolHtlcState | null {
  if (data.length < SOL_HTLC_STATE_LEN || data[0] !== 1) return null;
  return {
    partyA: new PublicKey(data.subarray(1, 33)),
    partyB: new PublicKey(data.subarray(33, 65)),
    mint: new PublicKey(data.subarray(65, 97)),
    secretHash: Buffer.from(data.subarray(97, 129)),
    deadline: data.readBigUInt64LE(129),
    amount: data.readBigUInt64LE(137),
    withdrawn: (data[145]! & 1) === 1,
    refunded: (data[145]! & 2) === 2,
    preimage: Buffer.from(data.subarray(147, 179)),
  };
}

function u64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

export async function buildHtlcTransaction(args: {
  connection: Connection;
  programId: PublicKey;
  mint: PublicKey;
  feePayer: PublicKey;
  action: 'lock' | 'withdraw' | 'refund';
  partyA: PublicKey;
  partyB: PublicKey;
  amount: bigint;
  secretHash: Buffer;
  deadline: bigint;
  preimage?: Buffer;
}): Promise<Transaction> {
  const id = agreementId(args.partyA, args.partyB, args.mint, args.amount, args.secretHash, args.deadline);
  const state = htlcAddress(args.programId, id);
  const source = getAssociatedTokenAddressSync(args.mint, args.partyA);
  const vault = getAssociatedTokenAddressSync(args.mint, state, true);
  const sellerAta = getAssociatedTokenAddressSync(args.mint, args.partyB);
  const ixs: TransactionInstruction[] = [];
  const missing = async (ata: PublicKey, owner: PublicKey) => {
    if (!(await args.connection.getAccountInfo(ata))) {
      ixs.push(createAssociatedTokenAccountInstruction(args.feePayer, ata, owner, args.mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
    }
  };

  if (args.action === 'lock') {
    await missing(vault, state);
    const data = Buffer.concat([
      Buffer.from([0]),
      args.partyB.toBuffer(),
      args.secretHash,
      u64(args.deadline),
      u64(args.amount),
    ]);
    ixs.push(new TransactionInstruction({
      programId: args.programId,
      keys: [
        { pubkey: args.partyA, isSigner: true, isWritable: true },
        { pubkey: state, isSigner: false, isWritable: true },
        { pubkey: source, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: args.mint, isSigner: false, isWritable: false },
      ],
      data,
    }));
  } else if (args.action === 'withdraw') {
    if (!args.preimage || args.preimage.length !== 32) throw new Error('The withdraw needs the 32-byte preimage.');
    await missing(sellerAta, args.partyB);
    ixs.push(new TransactionInstruction({
      programId: args.programId,
      keys: [
        { pubkey: args.partyB, isSigner: true, isWritable: false },
        { pubkey: state, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: sellerAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([Buffer.from([1]), args.preimage]),
    }));
  } else {
    await missing(source, args.partyA);
    ixs.push(new TransactionInstruction({
      programId: args.programId,
      keys: [
        { pubkey: args.partyA, isSigner: true, isWritable: false },
        { pubkey: state, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: source, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([2]),
    }));
  }

  const tx = new Transaction().add(...ixs);
  tx.feePayer = args.feePayer;
  tx.recentBlockhash = (await args.connection.getLatestBlockhash('confirmed')).blockhash;
  return tx;
}
