import React from "react";

const STAGES = [
  { num: 1, label: "Manifest" },
  { num: 2, label: "Candidates" },
  { num: 3, label: "File Reasoning" },
  { num: 4, label: "File Ranking" },
  { num: 5, label: "Element Reasoning" },
  { num: 6, label: "Element Ranking" },
  { num: 7, label: "Inspector" },
];

export default function Navigation({
  currentStage,
  maxStageReached,
  onSelectStage,
  githubMeta,
  engineLabel,
  busy,
}) {
  return (
    <header className="sticky top-0 z-50 border-b border-hairline bg-canvas/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-8 px-8 md:px-12">
        <div className="flex shrink-0 items-center gap-3">
          <span className="text-sm font-medium uppercase tracking-tight text-primary">
            FaultScope
          </span>
          <span className="font-mono text-xs text-muted">/</span>
          <span className="font-mono text-xs text-secondary">{engineLabel}</span>
          {githubMeta?.resolvedCommitSha && (
            <span
              className="ml-1 border border-hairline px-2 py-0.5 font-mono text-xs text-muted"
              title={`${githubMeta.owner}/${githubMeta.repo} @ ${githubMeta.resolvedCommitSha}`}
            >
              sha {githubMeta.resolvedCommitSha.slice(0, 7)}
            </span>
          )}
        </div>

        {/* min-w-0 + overflow-x-auto: at exactly the lg breakpoint the seven
            labels plus the commit badge are wider than the row, and without
            these the nav pushes the whole page sideways instead of shrinking. */}
        <nav className="hidden min-w-0 flex-1 items-center justify-end gap-5 overflow-x-auto lg:flex">
          {STAGES.map((stage) => {
            const reachable = stage.num <= maxStageReached;
            const active = currentStage === stage.num;
            return (
              <button
                key={stage.num}
                type="button"
                onClick={() => reachable && !busy && onSelectStage(stage.num)}
                disabled={!reachable || busy}
                className={`flex shrink-0 items-center gap-1.5 font-mono text-xs transition-colors duration-150 ${
                  active
                    ? "font-medium text-accent"
                    : reachable
                      ? "text-primary hover:text-accent"
                      : "cursor-not-allowed text-muted/60"
                }`}
              >
                <span className="hidden text-[10px] opacity-70 xl:inline">0{stage.num}</span>
                <span>{stage.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Compact stage indicator below the lg breakpoint. */}
        <div className="shrink-0 whitespace-nowrap text-right font-mono text-[11px] text-muted lg:hidden">
          0{currentStage} / 07
        </div>
      </div>

      {/* One hairline sweeping the full width whenever a stage is in flight. */}
      <div className="relative h-px w-full overflow-hidden bg-transparent">
        {busy && <div className="absolute inset-y-0 w-1/4 animate-sweep bg-accent" />}
      </div>
    </header>
  );
}
