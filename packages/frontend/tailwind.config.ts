import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: '#0E1525', 2: '#151E33', 3: '#1B2640', line: '#24304B', soft: '#2E3B5A' },
        fog: { DEFAULT: '#E6EAF2', 2: '#B7C0D3', 3: '#8C97AE', 4: '#5F6A82' },
        btq: { DEFAULT: '#A78BFA', dim: '#6D5BC4', glow: '#C4B5FD' },
        evm: { DEFAULT: '#38BDF8', dim: '#2381AD', glow: '#7DD3FC' },
        key: { DEFAULT: '#F5C451', dim: '#B8902F' },
        ok: '#34D399',
        warn: '#F59E0B',
        bad: '#F87171',
      },
      fontFamily: {
        sans: ['"Instrument Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config;
