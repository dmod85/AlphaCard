/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        mono: ['JetBrains Mono', 'monospace'],
        sans: ['Space Grotesk', 'sans-serif'],
      },
      colors: {
        alpha: {
          green: '#00FF87',
          red: '#FF4444',
          gold: '#FFD700',
          cyan: '#00E5FF',
          purple: '#B388FF',
          dark: '#0A0E17',
          card: '#111827',
          border: '#1F2937',
        },
      },
    },
  },
  plugins: [],
};
