import type { Config } from "tailwindcss";

export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "var(--zpp-background)",
        card: "var(--zpp-card)",
        muted: "var(--zpp-muted-surface)",
        foreground: "var(--zpp-foreground)",
        "muted-foreground": "var(--zpp-muted-foreground)",
        border: "var(--zpp-border)",
        ring: "var(--zpp-ring)",
        zpp: {
          navy: "#071A32",
          "navy-soft": "#0B1F3A",
          teal: "#145C63",
          surface: "#F6F4EE",
          border: "#D8DEE8"
        }
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"]
      },
      boxShadow: {
        panel: "0 1px 2px rgba(15, 23, 42, 0.05), 0 14px 36px rgba(15, 23, 42, 0.07)"
      }
    }
  },
  plugins: []
} satisfies Config;
