import { API_URL } from './constants';

class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private getToken(): string | null {
    return localStorage.getItem('btq_swap_token');
  }

  private headers(extra: Record<string, string> = {}): HeadersInit {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      ...extra,
    };
    const token = this.getToken();
    if (token) {
      h['Authorization'] = `Bearer ${token}`;
    }
    return h;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const startedAt = Date.now();
    console.log('[API] request', { method, path, url, body: body ?? null });

    const res = await fetch(url, {
      method,
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
    });

    const elapsedMs = Date.now() - startedAt;
    const raw = await res.text();
    let parsed: Record<string, unknown> | null = null;
    if (raw.trim().length > 0) {
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }

    if (!res.ok) {
      const errMessage = (parsed?.message as string | undefined)
        || (parsed?.error as string | undefined)
        || raw
        || `Request failed: ${res.status}`;
      console.error('[API] error', {
        method,
        path,
        status: res.status,
        elapsedMs,
        response: parsed ?? raw ?? null,
      });
      throw new Error(errMessage);
    }

    console.log('[API] success', {
      method,
      path,
      status: res.status,
      elapsedMs,
      response: parsed ?? null,
    });
    return (parsed ?? {}) as T;
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  async del<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }
}

export const api = new ApiClient(API_URL);
