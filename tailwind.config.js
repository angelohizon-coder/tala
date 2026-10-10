/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Tala Official Brand Palette (Forest Green identity)
        brand: {
          50: '#f2f7f4',
          100: '#e1ede7',
          200: '#c5e3c9', // Mint highlight
          300: '#9dbba4',
          400: '#87b095', // Sage green
          500: '#427c61', // Medium forest
          600: '#2b584a',
          700: '#244c42', // Deep forest
          800: '#1c4238',
          900: '#173c34', // Canonical Tala Forest Green
          950: '#0c221d',
        },
        // Tala semantic shortcuts & focus tokens
        tala: {
          DEFAULT: '#173c34',
          green: '#173c34',
          forest: '#173c34',
          mint: '#c5e3c9',
          sage: '#87b095',
          dark: '#112d27',
        },
        'tala-green': '#173c34',
        // WCAG AA Compliant Financial Semantic Colors
        financial: {
          gain: '#1f664a',       // Darkened green: >= 4.8:1 WCAG AA/AAA contrast
          loss: '#9c3832',       // Darkened red: >= 4.6:1 WCAG AA contrast
          neutral: '#4f5e58',    // Remediated secondary text: >= 5.8:1 WCAG AA contrast (replaces #7a8782)
          purple: '#6d549e',     // FIRE purple accent
        },
        border: 'hsl(var(--border, 150 10% 92%))',
        input: 'hsl(var(--input, 150 10% 90%))',
        ring: '#173c34',
        background: 'hsl(var(--background, 220 14% 97%))',
        foreground: 'hsl(var(--foreground, 165 22% 20%))',
        primary: {
          DEFAULT: '#173c34',
          foreground: '#ffffff',
        },
        secondary: {
          DEFAULT: '#e1ede7',
          foreground: '#173c34',
        },
        muted: {
          DEFAULT: '#4f5e58',
          foreground: '#4f5e58',
        },
        accent: {
          DEFAULT: '#c5e3c9',
          foreground: '#173c34',
        },
      },
      fontFamily: {
        sans: ['DM Sans', 'system-ui', 'sans-serif'],
        display: ['Manrope', 'system-ui', 'sans-serif'],
      },
      keyframes: {
        pageFadeIn: {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        dialogEnter: {
          '0%': { opacity: '0', transform: 'scale(0.96) translateY(8px)' },
          '100%': { opacity: '1', transform: 'scale(1) translateY(0)' },
        },
        dialogExit: {
          '0%': { opacity: '1', transform: 'scale(1) translateY(0)' },
          '100%': { opacity: '0', transform: 'scale(0.96) translateY(4px)' },
        },
        backdropEnter: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        backdropExit: {
          '0%': { opacity: '1' },
          '100%': { opacity: '0' },
        },
        chartFadeIn: {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'page-fade-in': 'pageFadeIn 180ms cubic-bezier(0.16, 1, 0.3, 1) both',
        'modal-in': 'dialogEnter 200ms cubic-bezier(0.16, 1, 0.3, 1) both',
        'modal-out': 'dialogExit 150ms cubic-bezier(0.16, 1, 0.3, 1) both',
        'backdrop-in': 'backdropEnter 200ms ease-out both',
        'backdrop-out': 'backdropExit 150ms ease-in both',
        'chart-in': 'chartFadeIn 350ms cubic-bezier(0.16, 1, 0.3, 1) both',
      },
    },
  },
  plugins: [],
}
