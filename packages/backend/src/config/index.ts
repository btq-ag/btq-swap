import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())));
const hex32 = z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/, 'must be 32 bytes of hex');
const optionalAddress = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined))
  .refine((v) => v === undefined || /^0x[0-9a-fA-F]{40}$/.test(v), 'must be a 0x address');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().default(3001),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  DATABASE_URL: z.string().min(1),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:5173'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  TRUST_PROXY: bool.default(false),
  ADMIN_TOKEN: z.string().min(24, 'ADMIN_TOKEN must be at least 24 characters'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  HEALTH_DEEP_TOKEN: z.string().min(16).optional(),
  TOS_VERSION: z.string().default('2026-11-12'),
  WORKERS_ENABLED: bool.default(true),
  DEVNET: bool.default(false),

  BTQ_NETWORK: z.enum(['mainnet', 'testnet', 'signet', 'regtest']).default('regtest'),
  BTQ_RPC_URL: z.string().url(),
  BTQ_RPC_USER: z.string().min(1),
  BTQ_RPC_PASS: z.string().min(1),
  BTQ_PLATFORM_WALLET: z.string().default('platform'),
  BTQ_TARGET_BLOCK_SEC: z.coerce.number().positive().default(600),
  BTQ_MIN_CONFIRMATIONS: z.coerce.number().int().min(1).default(6),
  BTQ_FEE_RATE_SAT_VB: z.coerce.number().positive().default(2),
  PLATFORM_HTLC_SEED: hex32,
  PLATFORM_SECRET_KEY: hex32,

  EVM_RPC_URL: z.string().url(),
  /** RPC URL shown to users in instructions (devnet: the VPS anvil endpoint). */
  PUBLIC_EVM_RPC_URL: z.string().url().optional(),
  EVM_CHAIN_ID: z.coerce.number().int().positive(),
  EVM_PRIVATE_KEY: hex32,
  HTLC_CONTRACT_ADDRESS: optionalAddress,
  USDT_TOKEN_ADDRESS: optionalAddress,
  USDT_DECIMALS: z.coerce.number().int().min(0).max(18).default(6),
  /** One URL, or a comma-separated list. Public devnet RPCs are added until there are 10. */
  SOLANA_RPC_URL: z.string().optional(),
  PUBLIC_SOLANA_RPC_URL: z.string().url().optional(),
  SOLANA_HTLC_PROGRAM_ID: z.string().optional(),
  SOLANA_TOKEN_MINT: z.string().optional(),
  /** Base58 secret key of the platform Solana wallet. Required for the platform to lock, claim, or refund on Solana. */
  SOLANA_PLATFORM_SECRET: z.string().optional(),
  EVM_MIN_CONFIRMATIONS: z.coerce.number().int().min(1).default(12),
  EVM_LOG_RANGE: z.coerce.number().int().positive().default(2000),

  SWAP_BUYER_LOCK_WINDOW_SEC: z.coerce.number().int().positive().default(1800),
  SWAP_EVM_LOCK_DURATION_SEC: z.coerce.number().int().positive().default(86400),
  SWAP_EVM_LOCK_MAX_DURATION_SEC: z.coerce.number().int().positive().default(172800),
  SWAP_SELLER_LOCK_WINDOW_SEC: z.coerce.number().int().positive().default(3600),
  SWAP_BTQ_LOCK_BLOCKS: z.coerce.number().int().positive().default(72),
  SWAP_SAFETY_MARGIN_SEC: z.coerce.number().int().positive().default(21600),
  WORKER_TICK_MS: z.coerce.number().int().positive().default(2000),

  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_GUILD_ID: z.string().optional(),
  DISCORD_SWAP_CHANNEL_ID: z.string().optional(),
  DISCORD_FEED_CHANNEL_ID: z.string().optional(),
  DISCORD_SWAP_CHANNEL_NAME: z.string().default('btq-swap'),
  DISCORD_ADMIN_IDS: z.string().default(''),
  DISCORD_ENABLE_FEED: bool.default(true),
  DISCORD_ENABLE_DMS: bool.default(true),
});

export type Config = z.infer<typeof envSchema>;

function load(): Config {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const fields = parsed.error.flatten().fieldErrors;
    throw new Error(`Invalid environment: ${JSON.stringify(fields)}`);
  }
  const c = parsed.data;
  const budget = c.SWAP_SELLER_LOCK_WINDOW_SEC + c.SWAP_BTQ_LOCK_BLOCKS * c.BTQ_TARGET_BLOCK_SEC + c.SWAP_SAFETY_MARGIN_SEC;
  if (c.SWAP_EVM_LOCK_DURATION_SEC < budget) {
    throw new Error(
      `Unsafe timing: SWAP_EVM_LOCK_DURATION_SEC (${c.SWAP_EVM_LOCK_DURATION_SEC}) must be >= seller window + BTQ lock time + margin (${budget})`,
    );
  }
  if (c.SWAP_EVM_LOCK_MAX_DURATION_SEC < c.SWAP_EVM_LOCK_DURATION_SEC) {
    throw new Error('SWAP_EVM_LOCK_MAX_DURATION_SEC must be >= SWAP_EVM_LOCK_DURATION_SEC');
  }
  return c;
}

let cached: Config | null = null;

/** Lazily parsed so unit tests can set process.env before first use. */
export function config(): Config {
  if (!cached) cached = load();
  return cached;
}

export function resetConfigForTests(): void {
  cached = null;
}

/** Minimum EVM time that must remain when the seller locks BTQ. */
export function sellerTimeBudgetSec(c: Config = config()): number {
  return c.SWAP_BTQ_LOCK_BLOCKS * c.BTQ_TARGET_BLOCK_SEC + c.SWAP_SAFETY_MARGIN_SEC;
}

export function adminDiscordIds(c: Config = config()): string[] {
  return c.DISCORD_ADMIN_IDS.split(',').map((s) => s.trim()).filter(Boolean);
}

export function feedChannelId(c: Config = config()): string | undefined {
  return c.DISCORD_FEED_CHANNEL_ID || c.DISCORD_SWAP_CHANNEL_ID;
}
