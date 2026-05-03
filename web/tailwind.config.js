/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Editorial dev console palette. Off-black with warmth, bone
        // foreground, coral/amber accent. Status colors mapped to the
        // four task sections.
        bg: "#0E0E0F",
        surface: "#161617",
        "surface-2": "#1C1C1E",
        border: "#262628",
        "border-strong": "#3A3A3C",
        fg: "#E8E6DF",
        muted: "#8A8784",
        "muted-2": "#6B6864",
        accent: "#E8743D",
        "accent-soft": "#A85528",
        status: {
          todo: "#5B5953",
          doing: "#E8C547",
          blocked: "#D9694A",
          done: "#7BA05B",
        },
        run: {
          queued: "#5B5953",
          running: "#E8C547",
          done: "#7BA05B",
          failed: "#D9694A",
          stale: "#6B6864",
        },
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
      },
      animation: {
        "fade-up": "fade-up 360ms cubic-bezier(0.2, 0.7, 0.2, 1) both",
        "pulse-slow": "pulse 1.8s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
