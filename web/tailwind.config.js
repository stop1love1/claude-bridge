/** @type {import('tailwindcss').Config} */
export default {
  // Tailwind v3 supports an array selector form: when the second
  // element matches, the `dark:` variant resolves. Aligning it with
  // `:root[data-theme="dark"]` lets the data-attribute toggle drive
  // both CSS-var palette swaps AND `dark:`-prefixed classes.
  darkMode: ["selector", ':root[data-theme="dark"]'],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // EVERY colour pulls from a CSS var so swapping `data-theme`
      // on <html> repaints the whole UI without a re-render. Hex
      // values live exclusively in `index.css` (one source of truth).
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        card: {
          DEFAULT: "var(--card)",
          foreground: "var(--card-foreground)",
        },
        popover: {
          DEFAULT: "var(--popover)",
          foreground: "var(--popover-foreground)",
        },
        primary: {
          DEFAULT: "var(--primary)",
          foreground: "var(--primary-foreground)",
        },
        secondary: {
          DEFAULT: "var(--secondary)",
          foreground: "var(--secondary-foreground)",
        },
        muted: {
          DEFAULT: "var(--muted)",
          foreground: "var(--muted-foreground)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          foreground: "var(--accent-foreground)",
        },
        destructive: {
          DEFAULT: "var(--destructive)",
          foreground: "var(--destructive-foreground)",
        },
        border: "var(--border)",
        input: "var(--input)",
        ring: "var(--ring)",
        success: "var(--success)",
        warning: "var(--warning)",
        info: "var(--info)",
        "fg-dim": "var(--fg-dim)",
        // Status / run shorthands stay so the kanban dots and run
        // pills don't have to inline `var(--success)` everywhere.
        status: {
          todo: "var(--fg-dim)",
          doing: "var(--warning)",
          blocked: "var(--destructive)",
          done: "var(--success)",
        },
        run: {
          queued: "var(--fg-dim)",
          running: "var(--warning)",
          done: "var(--success)",
          failed: "var(--destructive)",
          stale: "var(--muted-foreground)",
        },
      },
      borderRadius: {
        sm: "calc(var(--radius) - 4px)",
        md: "calc(var(--radius) - 2px)",
        lg: "var(--radius)",
        xl: "calc(var(--radius) + 4px)",
      },
      fontFamily: {
        mono: [
          "JetBrains Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
        sans: [
          "Inter",
          "Inter Tight",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
      },
      fontSize: {
        micro: ["11px", { lineHeight: "1.4", letterSpacing: "0.04em" }],
        small: ["12px", { lineHeight: "1.4", letterSpacing: "0.02em" }],
        base: ["14px", { lineHeight: "1.55" }],
        display: ["24px", { lineHeight: "1.15", letterSpacing: "-0.01em" }],
      },
      letterSpacing: {
        tightish: "-0.005em",
        wideish: "0.06em",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        pulse: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.4" },
        },
        "slide-in": {
          from: { opacity: "0", transform: "translateY(-6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "fade-up": "fade-up 360ms cubic-bezier(0.2, 0.7, 0.2, 1) both",
        "pulse-slow": "pulse 1.8s ease-in-out infinite",
        "slide-in": "slide-in 0.18s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
