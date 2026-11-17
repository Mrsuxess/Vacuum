import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        obsidian: {
          950: '#05060B',
          900: '#090B14',
          850: '#0E1220',
          800: '#14192D',
          700: '#1F2744',
        },
        ultraviolet: {
          400: '#A855F7',
          500: '#8B5CF6',
          600: '#7C3AED',
          700: '#6D28D9',
        },
        cyan: {
          400: '#22D3EE',
          500: '#06B6D4',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      backgroundImage: {
        'vortex-radial': 'radial-gradient(circle at 50% 0%, rgba(139, 92, 246, 0.16) 0%, rgba(6, 182, 212, 0.05) 45%, transparent 75%)',
      },
    },
  },
  plugins: [],
};

export default config;
