import { useEffect, useRef, useState } from 'react';

/** Poll a JSON endpoint; keeps the last good value on transient errors. */
export function usePoll<T>(fn: () => Promise<T>, everyMs: number, deps: unknown[] = []): { data: T | null; error: string | null; at: number } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const d = await fnRef.current();
        if (!alive) return;
        setData(d);
        setError(null);
        setAt(Date.now());
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) timer = setTimeout(tick, everyMs);
      }
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, at };
}

/** Re-render every `ms` so countdowns stay live between polls. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function ago(iso: string | number, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function countdown(targetMs: number, now: number): string {
  const s = Math.round((targetMs - now) / 1000);
  if (s <= 0) return 'passed';
  const m = Math.floor(s / 60);
  return m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

export function trimAmount(v: string, dp = 4): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return n.toLocaleString('en-US', { maximumFractionDigits: dp, minimumFractionDigits: 0 });
}

export function short(v: string | null | undefined, head = 8, tail = 6): string {
  if (!v) return '—';
  return v.length <= head + tail + 1 ? v : `${v.slice(0, head)}…${v.slice(-tail)}`;
}
