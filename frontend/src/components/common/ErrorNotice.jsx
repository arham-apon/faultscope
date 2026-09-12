import React from "react";

/**
 * Errors are reported as a hairline-bounded line of text, not a modal or a
 * coloured banner block — a failure should read as an annotation, not an alarm.
 */
export default function ErrorNotice({ message, onDismiss }) {
  if (!message) return null;
  return (
    <div className="mb-10 flex animate-rise items-start justify-between gap-6 border-l-2 border-status-error bg-red-50/40 py-3 pl-4 pr-3">
      <div className="space-y-1">
        <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-status-error">
          Pipeline error
        </div>
        <p className="max-w-prose text-sm leading-relaxed text-secondary">{message}</p>
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 font-mono text-[11px] uppercase tracking-wider text-muted hover:text-primary"
        >
          Dismiss
        </button>
      )}
    </div>
  );
}
