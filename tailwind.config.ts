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
        /* ------------------------------------------------------------------
           Primary product accent — warm gold.
           One expressive accent, used for selected states, primary actions and
           restrained brand moments. Deliberately NOT a gold-themed UI: most
           surfaces stay neutral and gold appears as projector-like warmth.
           gold-400 measures 10.05:1 on the ink-900 canvas and 5.12:1 on the
           lightest high-contrast surface, so it is safe for text, icons and
           focus rings everywhere it appears.
           ------------------------------------------------------------------ */
        gold: {
          200: '#F5E4B8',
          300: '#EBD08A',
          400: '#DDB25C', // primary — icons, links, focus, selected states
          500: '#C9963E', // filled control at rest
          600: '#A87A2B', // pressed
        },
        /* Legacy accents. Retained so existing components keep compiling while
           usages migrate; they are no longer used decoratively by the token
           layer. `electric` survives long-term ONLY as realtime/sync status. */
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
      /* --------------------------------------------------------------------
         Semantic text tiers.

         Replaces nine ad-hoc white-opacity values with five named tiers.
         Measured contrast (white at alpha, worst case across every surface
         these land on — canvas, ink-800, glass, glass-deep, ink-700):

           primary     1.00   >= 16.7:1
           secondary   0.72   >=  9.2:1
           supporting  0.58   >=  6.4:1
           muted       0.50   >=  5.1:1   <- AA floor for informational text
           decorative  0.34   ~   3.0:1   <- NON-informational only

         `decorative` must never carry instructions, status, timestamps needed
         for comprehension, field descriptions or actionable labels.

         High-contrast mode lifts the lower tiers — see globals.css, which must
         list these class names or the existing override silently stops working.
         -------------------------------------------------------------------- */
      textColor: {
        primary: 'rgb(255 255 255)',
        secondary: 'rgb(255 255 255 / 0.72)',
        supporting: 'rgb(255 255 255 / 0.58)',
        muted: 'rgb(255 255 255 / 0.50)',
        decorative: 'rgb(255 255 255 / 0.34)',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'var(--font-sans)', 'ui-sans-serif', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        'display-2xl': ['clamp(3.25rem, 9vw, 8.5rem)', { lineHeight: '0.92', letterSpacing: '-0.045em', fontWeight: '700' }],
        'display-xl': ['clamp(2.75rem, 6.5vw, 5.75rem)', { lineHeight: '0.95', letterSpacing: '-0.04em', fontWeight: '700' }],
        // 650 is not a weight the shipped font exposes: browsers silently fall
        // back (or synthesise), so the rendered weight was never the intended
        // one. 600 is a real weight in the family.
        'display-lg': ['clamp(2.25rem, 4.5vw, 3.75rem)', { lineHeight: '1.02', letterSpacing: '-0.035em', fontWeight: '600' }],
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
      /* --------------------------------------------------------------------
         Four elevation levels, neutral and low-saturation.

         Previously six shadows were defined and exactly one rendered, so every
         surface sat on the same plane. These four are assigned to distinct
         component families in globals.css:

           e-inset    inputs, wells, internal recesses      (.glass-soft)
           e-raised   cards, side panels, persistent nav    (.glass)
           e-float    dropdowns, popovers, tooltips         (.elev-float)
           e-overlay  modals, dialogs, major temp panels    (.glass-deep)

         Coloured glow is never a substitute for elevation.
         -------------------------------------------------------------------- */
      boxShadow: {
        'e-inset': 'inset 0 1px 2px 0 rgb(0 0 0 / 0.45), inset 0 0 0 1px rgb(255 255 255 / 0.04)',
        'e-raised': '0 1px 0 0 rgb(255 255 255 / 0.05) inset, 0 8px 24px -12px rgb(0 0 0 / 0.7)',
        'e-float': '0 1px 0 0 rgb(255 255 255 / 0.06) inset, 0 20px 48px -20px rgb(0 0 0 / 0.8)',
        'e-overlay': '0 1px 0 0 rgb(255 255 255 / 0.08) inset, 0 40px 90px -32px rgb(0 0 0 / 0.85)',

        /* Focus / selected affordances — gold, not neon. Replaces the former
           royal and cyan glows; the ring carries the meaning, not a halo. */
        'focus-gold': '0 0 0 1px rgb(221 178 92 / 0.55), 0 8px 28px -14px rgb(221 178 92 / 0.35)',
        'select-gold': '0 0 0 1px rgb(221 178 92 / 0.65), 0 10px 30px -16px rgb(221 178 92 / 0.4)',

        /* Aliases kept so existing components compile unchanged during the
           migration. Same values as above — no component still gets a neon
           glow. Remove once every usage has been renamed. */
        glass: '0 1px 0 0 rgb(255 255 255 / 0.05) inset, 0 8px 24px -12px rgb(0 0 0 / 0.7)',
        'glass-sm': 'inset 0 1px 2px 0 rgb(0 0 0 / 0.45), inset 0 0 0 1px rgb(255 255 255 / 0.04)',
        lift: '0 1px 0 0 rgb(255 255 255 / 0.08) inset, 0 40px 90px -32px rgb(0 0 0 / 0.85)',
        'glow-royal': '0 0 0 1px rgb(221 178 92 / 0.55), 0 8px 28px -14px rgb(221 178 92 / 0.35)',
        'glow-electric': '0 0 0 1px rgb(221 178 92 / 0.65), 0 10px 30px -16px rgb(221 178 92 / 0.4)',
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
