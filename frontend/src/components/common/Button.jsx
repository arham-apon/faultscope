import React from "react";

/**
 * Two weights only. The primary action is a solid cobalt rectangle — the single
 * saturated element on the page — and everything else is a quiet outline.
 * No pills, no shadows.
 */
const VARIANTS = {
  primary:
    "bg-accent text-white hover:bg-accent-hover disabled:bg-muted/40 disabled:text-white/70",
  secondary:
    "border border-hairline text-primary hover:border-accent hover:text-accent disabled:text-muted disabled:hover:border-hairline",
  ghost: "text-secondary hover:text-accent disabled:text-muted",
};

export default function Button({
  variant = "primary",
  type = "button",
  disabled = false,
  onClick,
  className = "",
  children,
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-2 px-5 py-2.5 font-mono text-xs uppercase tracking-[0.12em]
        transition-colors duration-150 disabled:cursor-not-allowed ${VARIANTS[variant]} ${className}`}
    >
      {children}
    </button>
  );
}
