/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Tajawal", "ui-sans-serif", "system-ui", "sans-serif"],
        'arabic-calligraphy': ['"Aref Ruqaa"', 'serif'],
      },
      colors: {
        background: {
          light: '#FFFFFF',
          dark: '#F8F9FA'
        },
        primary: {
          DEFAULT: '#D4AF37',
          dark: '#C5A059'
        },
        secondary: '#000000'
      }
    },
  },
  plugins: [],
}

