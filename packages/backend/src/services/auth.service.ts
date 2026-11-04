import { SiweMessage } from 'siwe';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import Redis from 'ioredis';
import { config } from '../config';
import { query, getOne } from '../lib/db';
import { AuthPayload } from '../middleware/auth';

const redis = new Redis(config.REDIS_URL);

const NONCE_PREFIX = 'siwe:nonce:';
const NONCE_TTL = 300; // 5 minutes
const REVOKED_TOKEN_PREFIX = 'btq:revoked_token:';

interface UserRow {
  id: string;
  eth_address: string;
  role: string;
  is_banned: boolean;
}

export class AuthService {
  async generateNonce(): Promise<string> {
    const nonce = randomBytes(16).toString('hex');
    await redis.setex(`${NONCE_PREFIX}${nonce}`, NONCE_TTL, '1');
    return nonce;
  }

  async verify(message: string, signature: string): Promise<{ token: string; user: UserRow }> {
    const siweMessage = new SiweMessage(message);
    const { data: fields } = await siweMessage.verify({ signature });

    const nonce = fields.nonce;
    const stored = await redis.get(`${NONCE_PREFIX}${nonce}`);
    if (!stored) {
      throw new Error('Invalid or expired nonce');
    }
    await redis.del(`${NONCE_PREFIX}${nonce}`);

    const ethAddress = fields.address.toLowerCase();
    const user = await this.upsertUser(ethAddress);

    if (user.is_banned) {
      throw new Error('Account is banned');
    }

    const payload: AuthPayload = {
      userId: user.id,
      ethAddress: user.eth_address,
      role: user.role,
    };

    const signOpts: SignOptions = {
      expiresIn: config.JWT_EXPIRES_IN as SignOptions['expiresIn'],
    };
    const token = jwt.sign(payload, config.JWT_SECRET, signOpts);

    return { token, user };
  }

  async logout(token: string): Promise<void> {
    try {
      const decoded = jwt.decode(token) as { exp?: number } | null;
      if (decoded?.exp) {
        const ttl = decoded.exp - Math.floor(Date.now() / 1000);
        if (ttl > 0) {
          await redis.setex(`${REVOKED_TOKEN_PREFIX}${token}`, ttl, '1');
        }
      }
    } catch {
      // token already invalid, nothing to block
    }
  }

  private async upsertUser(ethAddress: string): Promise<UserRow> {
    const existing = await getOne<UserRow>(
      'SELECT id, eth_address, role, is_banned FROM users WHERE eth_address = $1',
      [ethAddress],
    );

    if (existing) {
      await query('UPDATE users SET last_login_at = now() WHERE id = $1', [existing.id]);
      return existing;
    }

    const result = await getOne<UserRow>(
      `INSERT INTO users (eth_address, last_login_at)
       VALUES ($1, now())
       RETURNING id, eth_address, role, is_banned`,
      [ethAddress],
    );

    return result!;
  }
}

export const authService = new AuthService();
