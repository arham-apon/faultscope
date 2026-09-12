/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "#FBFBF9",
        surface: "#FFFFFF",
        subtle: "#F2F1ED",
        hairline: "#E6E4DD",
        primary: "#111111",
        secondary: "#5A5955",
        muted: "#9B9890",
        accent: {
          DEFAULT: "#1D4ED8",
          hover: "#1E40AF",
          tint: "#EFF4FE",
        },
        status: {
          error: "#B91C1C",
        },
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      fontSize: {
        // Body copy sits at 15px rather than Tailwind's 16px default, per §1.2.
        base: ["0.9375rem", { lineHeight: "1.75" }],
        sm: ["0.8125rem", { lineHeight: "1.6" }],
      },
      letterSpacing: {
        display: "-0.03em",
        section: "-0.02em",
      },
      maxWidth: {
        prose: "68ch",
      },
      keyframes: {
        // A single hairline sweeping left to right — the only motion in the
        // interface, used to signal an in-flight LLM stage.
        sweep: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(400%)" },
        },
        rise: {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        sweep: "sweep 1.6s cubic-bezier(0.4, 0, 0.2, 1) infinite",
        rise: "rise 0.4s ease-out both",
      },
    },
  },
  plugins: [],
};
