import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: '#0F1116', 2: '#161920', 3: '#1E2129', line: '#2A2F3A', soft: '#282C36' },
        fog: { DEFAULT: '#F5F6F8', 2: '#B2BCC6', 3: '#7C8694', 4: '#5C6775' },
        btq: { DEFAULT: '#8B7CFF', dim: '#6A5BD4', glow: '#C4B8FF' },
        evm: { DEFAULT: '#4C82FB', dim: '#0052FF', glow: '#9CB8FF' },
        key: { DEFAULT: '#F0B90B', dim: '#C4920A' },
        ok: '#00C882',
        warn: '#F0B90B',
        bad: '#F44656',
        accent: '#0052FF',
        positive: '#00C882',
        negative: '#F44656',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      borderRadius: {
        card: '8px',
        control: '6px',
      },
    },
  },
  plugins: [],
} satisfies Config;
