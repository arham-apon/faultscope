import React from "react";

export default function SectionHeading({ step, title, description, aside }) {
  return (
    <div className="mb-12 flex flex-wrap items-end justify-between gap-6 border-b border-hairline pb-6">
      <div className="space-y-3">
        <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
          <span>{step}</span>
          <span>/</span>
          <span>FaultScope Pipeline</span>
        </div>
        <h2 className="text-2xl font-medium tracking-section text-primary md:text-3xl">{title}</h2>
        {description && (
          <p className="max-w-prose text-base leading-relaxed text-secondary">{description}</p>
        )}
      </div>
      {aside && <div className="shrink-0 pb-1">{aside}</div>}
    </div>
  );
}
