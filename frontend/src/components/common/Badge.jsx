import React from "react";

const STYLES = {
  default: "bg-subtle text-secondary border-hairline",
  accent: "bg-accent-tint text-accent border-accent/20 font-medium",
  success: "bg-emerald-50 text-emerald-800 border-emerald-200",
  error: "bg-red-50 text-status-error border-red-200",
  muted: "bg-canvas text-muted border-hairline",
};

export default function Badge({ variant = "default", title, children }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center border px-2.5 py-0.5 font-mono text-xs ${
        STYLES[variant] || STYLES.default
      }`}
    >
      {children}
    </span>
  );
}
