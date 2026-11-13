import { createLogger } from '../lib/logger';

const log = createLogger('discord-rest');
const API = 'https://discord.com/api/v10';

export class DiscordApiError extends Error {
  constructor(readonly status: number, readonly code: number | undefined, message: string) {
    super(message);
    this.name = 'DiscordApiError';
  }
}

/** Minimal Discord REST client with serialized requests and 429 handling. */
export class DiscordRest {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly token: string) {}

  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const run = async (): Promise<T> => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const res = await fetch(`${API}${path}`, {
          method,
          headers: {
            Authorization: `Bot ${this.token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'DiscordBot (https://github.com/btq-ag/btq-swap, 0.2)',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (res.status === 429) {
          const j = (await res.json().catch(() => ({}))) as { retry_after?: number };
          const wait = Math.ceil((j.retry_after ?? 1) * 1000) + 100;
          log.warn('rate limited', { path, wait });
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        const text = await res.text();
        const json = text ? (JSON.parse(text) as unknown) : undefined;
        if (!res.ok) {
          const j = (json ?? {}) as { code?: number; message?: string };
          throw new DiscordApiError(res.status, j.code, `${method} ${path} → ${res.status} ${j.message ?? text}`);
        }
        const remaining = res.headers.get('x-ratelimit-remaining');
        const resetAfter = Number(res.headers.get('x-ratelimit-reset-after') ?? '0');
        if (remaining === '0' && resetAfter > 0) await new Promise((r) => setTimeout(r, Math.ceil(resetAfter * 1000)));
        return json as T;
      }
      throw new DiscordApiError(429, undefined, `${method} ${path} rate limited repeatedly`);
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async dm(userId: string, payload: unknown): Promise<string> {
    const ch = await this.request<{ id: string }>('POST', '/users/@me/channels', { recipient_id: userId });
    const msg = await this.request<{ id: string }>('POST', `/channels/${ch.id}/messages`, payload);
    return msg.id;
  }

  async postMessage(channelId: string, payload: unknown): Promise<string> {
    const msg = await this.request<{ id: string }>('POST', `/channels/${channelId}/messages`, payload);
    return msg.id;
  }

  async editMessage(channelId: string, messageId: string, payload: unknown): Promise<void> {
    await this.request('PATCH', `/channels/${channelId}/messages/${messageId}`, payload);
  }

  async createThread(channelId: string, name: string): Promise<string> {
    const t = await this.request<{ id: string }>('POST', `/channels/${channelId}/threads`, { name: name.slice(0, 95), type: 11, auto_archive_duration: 1440 });
    return t.id;
  }
}
