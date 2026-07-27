import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx,mdx}'],
  theme: {
    container: {
      center: true,
      padding: { DEFAULT: '1.25rem', sm: '2rem', lg: '3rem', '2xl': '4rem' },
      screens: { '2xl': '1440px' },
    },
    extend: {
      colors: {
        /* Core surfaces — black first, always */
        ink: {
          950: '#050506',
          900: '#090909', // primary
          850: '#0d0d0f',
          800: '#121212', // secondary
          750: '#161618',
          700: '#1c1c20',
          600: '#26262c',
          500: '#33333b',
        },
        /* Accents */
        royal: {
          50: '#f3f0ff',
          200: '#d3c6ff',
          400: '#a888ff',
          500: '#8b5cf6',
          600: '#7c3aed',
          700: '#6d28d9',
          900: '#3b1a86',
        },
        abyss: {
          400: '#5b8bff',
          500: '#3b6cf6',
          600: '#2450e0',
          700: '#1a3bb5',
          900: '#0e1f66',
        },
        electric: {
          300: '#8df4ff',
          400: '#4ee6ff',
          500: '#22d3ee',
          600: '#06b6d4',
          900: '#0b4c5c',
        },
        /* Semantic */
        haze: 'rgb(255 255 255 / <alpha-value>)',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'var(--font-sans)', 'ui-sans-serif', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        'display-2xl': ['clamp(3.25rem, 9vw, 8.5rem)', { lineHeight: '0.92', letterSpacing: '-0.045em', fontWeight: '700' }],
        'display-xl': ['clamp(2.75rem, 6.5vw, 5.75rem)', { lineHeight: '0.95', letterSpacing: '-0.04em', fontWeight: '700' }],
        'display-lg': ['clamp(2.25rem, 4.5vw, 3.75rem)', { lineHeight: '1.02', letterSpacing: '-0.035em', fontWeight: '650' }],
        'display-md': ['clamp(1.75rem, 3vw, 2.5rem)', { lineHeight: '1.1', letterSpacing: '-0.03em', fontWeight: '600' }],
        'display-sm': ['clamp(1.35rem, 2vw, 1.75rem)', { lineHeight: '1.2', letterSpacing: '-0.02em', fontWeight: '600' }],
        eyebrow: ['0.6875rem', { lineHeight: '1', letterSpacing: '0.22em', fontWeight: '600' }],
      },
      borderRadius: {
        '4xl': '2rem',
        '5xl': '2.75rem',
      },
      backdropBlur: {
        xs: '2px',
        '3xl': '48px',
        '4xl': '72px',
      },
      boxShadow: {
        glass: '0 1px 0 0 rgb(255 255 255 / 0.06) inset, 0 -1px 0 0 rgb(0 0 0 / 0.4) inset, 0 24px 60px -20px rgb(0 0 0 / 0.75)',
        'glass-sm': '0 1px 0 0 rgb(255 255 255 / 0.05) inset, 0 12px 32px -16px rgb(0 0 0 / 0.7)',
        lift: '0 40px 90px -32px rgb(0 0 0 / 0.85), 0 0 0 1px rgb(255 255 255 / 0.05)',
        'glow-royal': '0 0 0 1px rgb(139 92 246 / 0.35), 0 16px 48px -12px rgb(139 92 246 / 0.45)',
        'glow-electric': '0 0 0 1px rgb(34 211 238 / 0.35), 0 16px 48px -12px rgb(34 211 238 / 0.4)',
        'inner-hairline': 'inset 0 0 0 1px rgb(255 255 255 / 0.08)',
      },
      transitionTimingFunction: {
        swift: 'cubic-bezier(0.32, 0.72, 0, 1)',
        glide: 'cubic-bezier(0.16, 1, 0.3, 1)',
        cinema: 'cubic-bezier(0.65, 0, 0.35, 1)',
      },
      keyframes: {
        'aurora-drift': {
          '0%, 100%': { transform: 'translate3d(0,0,0) rotate(0deg) scale(1)' },
          '33%': { transform: 'translate3d(6%, -8%, 0) rotate(40deg) scale(1.18)' },
          '66%': { transform: 'translate3d(-7%, 6%, 0) rotate(-25deg) scale(0.94)' },
        },
        'sheen': {
          '0%': { transform: 'translateX(-140%) skewX(-18deg)' },
          '100%': { transform: 'translateX(240%) skewX(-18deg)' },
        },
        'border-spin': {
          to: { '--angle': '360deg' },
        },
        'pulse-ring': {
          '0%': { transform: 'scale(0.85)', opacity: '0.7' },
          '80%, 100%': { transform: 'scale(1.6)', opacity: '0' },
        },
        'shimmer': {
          '100%': { transform: 'translateX(100%)' },
        },
        'float-y': {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-10px)' },
        },
        'equalize': {
          '0%, 100%': { transform: 'scaleY(0.35)' },
          '50%': { transform: 'scaleY(1)' },
        },
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(14px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'aurora-drift': 'aurora-drift 22s ease-in-out infinite',
        sheen: 'sheen 1.1s ease',
        'border-spin': 'border-spin 6s linear infinite',
        'pulse-ring': 'pulse-ring 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        shimmer: 'shimmer 1.8s infinite',
        'float-y': 'float-y 6s ease-in-out infinite',
        equalize: 'equalize 900ms ease-in-out infinite',
        'fade-up': 'fade-up 0.6s cubic-bezier(0.16, 1, 0.3, 1) both',
      },
    },
  },
  plugins: [],
};

export default config;
