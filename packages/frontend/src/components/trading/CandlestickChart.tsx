import { useEffect, useRef, useState, useCallback } from 'react';
import { createChart, type IChartApi, type CandlestickData, type Time, ColorType } from 'lightweight-charts';
import { api } from '../../lib/api';

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const TIMEFRAMES = [
  { label: '1H', seconds: 3600 },
  { label: '4H', seconds: 14400 },
  { label: '1D', seconds: 86400 },
  { label: '1W', seconds: 604800 },
];

function generateFallbackCandles(): CandlestickData<Time>[] {
  const candles: CandlestickData<Time>[] = [];
  let price = 2.5;
  const now = Math.floor(Date.now() / 1000);
  for (let i = 200; i >= 0; i--) {
    const time = (now - i * 3600) as Time;
    const open = price;
    const v = 0.03 + Math.random() * 0.05;
    const close = Math.max(0.5, open + (Math.random() - 0.48) * v);
    const high = Math.max(open, close) + Math.random() * v * 0.5;
    const low = Math.min(open, close) - Math.random() * v * 0.5;
    candles.push({ time, open, high, low, close });
    price = close;
  }
  return candles;
}

interface Props {
  height?: number;
}

export function CandlestickChart({ height = 400 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ReturnType<IChartApi['addCandlestickSeries']> | null>(null);
  const volumeSeriesRef = useRef<ReturnType<IChartApi['addHistogramSeries']> | null>(null);
  const [activeInterval, setActiveInterval] = useState(3600);
  const [lastPrice, setLastPrice] = useState<{ price: number; change: number; pctChange: number } | null>(null);

  const fetchCandles = useCallback(async (interval: number) => {
    try {
      const res = await api.get<{ candles: Candle[] }>(`/orders/candles?interval=${interval}&limit=200`);
      if (res.candles && res.candles.length > 0) {
        const mapped: CandlestickData<Time>[] = res.candles.map((c) => ({
          time: c.time as Time,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        }));
        const volumes = res.candles.map((c) => ({
          time: c.time as Time,
          value: c.volume,
          color: c.close >= c.open ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)',
        }));
        return { candles: mapped, volumes };
      }
    } catch { /* fall through */ }
    const fallback = generateFallbackCandles();
    return {
      candles: fallback,
      volumes: fallback.map((c) => ({
        time: c.time,
        value: Math.random() * 5000 + 500,
        color: c.close >= c.open ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)',
      })),
    };
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      height,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#94a3b8',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#1e293b' },
        horzLines: { color: '#1e293b' },
      },
      crosshair: {
        vertLine: { color: '#475569', width: 1, style: 2, labelBackgroundColor: '#334155' },
        horzLine: { color: '#475569', width: 1, style: 2, labelBackgroundColor: '#334155' },
      },
      rightPriceScale: {
        borderColor: '#1e293b',
        scaleMargins: { top: 0.1, bottom: 0.2 },
      },
      timeScale: {
        borderColor: '#1e293b',
        timeVisible: true,
        secondsVisible: false,
      },
    });

    chartRef.current = chart;

    const cs = chart.addCandlestickSeries({
      upColor: '#10b981',
      downColor: '#ef4444',
      borderUpColor: '#10b981',
      borderDownColor: '#ef4444',
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444',
    });
    candleSeriesRef.current = cs;

    const vs = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    });
    vs.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    volumeSeriesRef.current = vs;

    const observer = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chart.remove();
    };
  }, [height]);

  useEffect(() => {
    if (!candleSeriesRef.current || !volumeSeriesRef.current) return;
    let cancelled = false;

    fetchCandles(activeInterval).then(({ candles, volumes }) => {
      if (cancelled) return;
      candleSeriesRef.current!.setData(candles);
      volumeSeriesRef.current!.setData(volumes);
      chartRef.current?.timeScale().fitContent();

      if (candles.length >= 2) {
        const last = candles[candles.length - 1];
        const prev = candles[candles.length - 2];
        const change = last.close - prev.close;
        setLastPrice({ price: last.close, change, pctChange: (change / prev.close) * 100 });
      }
    });

    return () => { cancelled = true; };
  }, [activeInterval, fetchCandles]);

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-slate-700/50 bg-slate-800/30">
      <div className="flex items-center justify-between border-b border-slate-700/50 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-emerald-500">
              <span className="text-[10px] font-bold text-white">B</span>
            </div>
            <span className="text-base font-bold text-white">BTQ / USDT</span>
          </div>
          {lastPrice && (
            <>
              <span className="text-lg font-bold text-white">{lastPrice.price.toFixed(4)}</span>
              <span className={`text-sm font-medium ${lastPrice.change >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {lastPrice.change >= 0 ? '+' : ''}{lastPrice.change.toFixed(4)} ({lastPrice.pctChange.toFixed(2)}%)
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.label}
              onClick={() => setActiveInterval(tf.seconds)}
              className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                activeInterval === tf.seconds
                  ? 'bg-blue-500/20 text-blue-400'
                  : 'text-slate-400 hover:bg-slate-700 hover:text-white'
              }`}
            >
              {tf.label}
            </button>
          ))}
        </div>
      </div>
      <div ref={containerRef} />
    </div>
  );
}
