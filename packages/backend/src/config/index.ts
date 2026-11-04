import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(3001),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  HEALTH_DEEP_TOKEN: z.string().optional(),

  DATABASE_URL: z.string().url(),

  REDIS_URL: z.string().default('redis://localhost:6379'),

  JWT_SECRET: z.string().min(16),
  JWT_EXPIRES_IN: z.string().default('24h'),

  BTQ_RPC_HOST: z.string().default('127.0.0.1'),
  BTQ_RPC_PORT: z.coerce.number().default(8332),
  BTQ_RPC_USER: z.string().default('btqrpc'),
  BTQ_RPC_PASS: z.string().default('btqrpcpass'),
  BTQ_RPC_WALLET: z.string().default('platform_wallet'),
  BTQ_NETWORK: z.enum(['mainnet', 'testnet', 'regtest']).default('mainnet'),

  PLATFORM_BTQ_ADDRESS: z.string().default(''),
  PLATFORM_DILITHIUM_PUBKEY: z.string().default(''),

  EVM_RPC_URL: z.string().url(),
  EVM_CHAIN_ID: z.coerce.number().default(1),
  EVM_PRIVATE_KEY: z.string().startsWith('0x'),
  HTLC_CONTRACT_ADDRESS: z.string().startsWith('0x'),
  USDT_TOKEN_ADDRESS: z.string().startsWith('0x'),

  BTQ_TIMELOCK_BLOCKS: z.coerce.number().default(144),
  EVM_TIMELOCK_SECONDS: z.coerce.number().default(3600),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;

export type Config = z.infer<typeof envSchema>;
