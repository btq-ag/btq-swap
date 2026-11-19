import { useEffect, useRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';

export interface Candle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
  n: number;
}

const UP = '#26a69a';
const DOWN = '#ef5350';

function n(v: string): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

interface Bar {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface Vol {
  time: UTCTimestamp;
  value: number;
  color: string;
}

/** Carry the previous close into the next open so bodies meet. Wicks still cover every trade in the bucket. */
function stitch(candles: Candle[]): { bars: Bar[]; vols: Vol[] } {
  const bars: Bar[] = [];
  const vols: Vol[] = [];
  let prevClose: number | null = null;
  for (const c of candles) {
    if (c.t <= 0) continue;
    const close = n(c.c);
    const open = prevClose ?? n(c.o);
    const high = Math.max(n(c.h), open, close);
    const low = Math.min(n(c.l), open, close);
    const up = close >= open;
    bars.push({ time: c.t as UTCTimestamp, open, high, low, close });
    vols.push({
      time: c.t as UTCTimestamp,
      value: n(c.v),
      color: up ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)',
    });
    prevClose = close;
  }
  return { bars, vols };
}

/**
 * TradingView Lightweight Charts, with price and volume in separate panes
 * so the candle bodies sit on the price scale and the volume sits on the same times.
 */
export function CandleChart({ candles, intervalSec }: { candles: Candle[]; intervalSec: number }) {
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const follow = useRef(true);
  const seen = useRef<Candle[]>([]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#131722' },
        textColor: '#d1d4dc',
        fontFamily: 'Inter, sans-serif',
        fontSize: 11,
        panes: { separatorColor: '#2a2e39', separatorHoverColor: '#434651' },
      },
      grid: {
        vertLines: { color: '#1e222d' },
        horzLines: { color: '#1e222d' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#758696', width: 1, style: 3, labelBackgroundColor: '#2a2e39' },
        horzLine: { color: '#758696', width: 1, style: 3, labelBackgroundColor: '#2a2e39' },
      },
      rightPriceScale: { borderColor: '#2a2e39' },
      timeScale: {
        borderColor: '#2a2e39',
        timeVisible: true,
        secondsVisible: intervalSec < 60,
        barSpacing: 9,
        minBarSpacing: 5,
        rightOffset: 4,
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    });
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      priceFormat: { type: 'price', precision: 4, minMove: 0.0001 },
    });
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'right',
    }, 1);
    chart.panes()[1]?.setHeight(72);
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      follow.current = chart.timeScale().scrollPosition() < 2;
    });
    chartRef.current = chart;
    candleRef.current = candleSeries;
    volumeRef.current = volumeSeries;
    seen.current = [];
    return () => {
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
    };
  }, [intervalSec]);

  useEffect(() => {
    const candleSeries = candleRef.current;
    const volumeSeries = volumeRef.current;
    const chart = chartRef.current;
    if (!candleSeries || !volumeSeries || !chart) return;
    const ordered = candles.filter((c) => c.t > 0);
    const { bars, vols } = stitch(ordered);
    const prev = seen.current;
    const sameHistory = prev.length > 0 && ordered.length >= prev.length && ordered[0]?.t === prev[0]?.t;
    if (!sameHistory) {
      candleSeries.setData(bars);
      volumeSeries.setData(vols);
      if (bars.length > 90) {
        chart.timeScale().setVisibleLogicalRange({ from: bars.length - 90, to: bars.length + 4 });
      } else {
        chart.timeScale().fitContent();
      }
    } else {
      for (let i = Math.max(0, prev.length - 1); i < bars.length; i++) {
        candleSeries.update(bars[i]!);
        volumeSeries.update(vols[i]!);
      }
      if (follow.current) chart.timeScale().scrollToRealTime();
    }
    seen.current = ordered;
  }, [candles]);

  return (
    <section className="relative flex min-h-[320px] flex-1 flex-col bg-[#131722]" aria-label="Price chart">
      <div ref={host} className="min-h-[280px] w-full flex-1" />
      {candles.length === 0 && (
        <p className="pointer-events-none absolute left-4 top-3 text-[12px] text-[#787b86]">Waiting for trades.</p>
      )}
    </section>
  );
}
