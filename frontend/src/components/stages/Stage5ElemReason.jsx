import React, { useEffect, useMemo, useState } from "react";
import { useProject } from "../../context/ProjectContext";
import Badge from "../common/Badge";
import Button from "../common/Button";
import SectionHeading from "../common/SectionHeading";
import StageStatus from "../common/StageStatus";
import ReasoningProse from "../common/ReasoningProse";
import {
  basename,
  fileKeyIndex,
  parseElementKey,
  pathForFileKey,
} from "../../lib/pipeline";

const KIND_ORDER = { class: 0, function: 1, global: 2 };

export default function Stage5ElemReason() {
  const {
    elementReasoning,
    fileRanking,
    groundTruthElements,
    engine,
    loadingStage,
    loadingLabel,
    runElementReasoning,
    runElementRanking,
  } = useProject();

  const fileKeys = useMemo(
    () =>
      Object.keys(elementReasoning || {}).sort(
        (a, b) => (fileKeyIndex(a) ?? 0) - (fileKeyIndex(b) ?? 0),
      ),
    [elementReasoning],
  );

  const [activeFileKey, setActiveFileKey] = useState(null);
  const [activeIdentifier, setActiveIdentifier] = useState(null);

  const currentKey = activeFileKey && fileKeys.includes(activeFileKey) ? activeFileKey : fileKeys[0];
  const elements = useMemo(
    () => Object.keys(elementReasoning?.[currentKey] || {}),
    [elementReasoning, currentKey],
  );

  const sortedElements = useMemo(
    () =>
      [...elements].sort((a, b) => {
        const left = parseElementKey(a);
        const right = parseElementKey(b);
        const byKind = (KIND_ORDER[left.kind] ?? 9) - (KIND_ORDER[right.kind] ?? 9);
        return byKind || left.name.localeCompare(right.name);
      }),
    [elements],
  );

  // Selecting the first element of a newly-activated file keeps the reading
  // panel populated instead of dropping to an empty state on every tab change.
  useEffect(() => {
    if (sortedElements.length && !sortedElements.includes(activeIdentifier)) {
      setActiveIdentifier(sortedElements[0]);
    }
  }, [sortedElements, activeIdentifier]);

  const busy = loadingStage !== null;
  const hasReasoning = fileKeys.length > 0;
  const reasoning = elementReasoning?.[currentKey]?.[activeIdentifier] || "";
  const groundTruthSet = useMemo(
    () =>
      new Set(
        String(groundTruthElements || "")
          .split(/[\n,]+/)
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    [groundTruthElements],
  );

  return (
    <div>
      <SectionHeading
        step="05"
        title="Element Extraction & Causal Reasoning"
        description="Every function, class, and module-level assignment in the promoted files, each explained on its own terms."
      />

      <StageStatus active={busy} label={loadingLabel} />

      {!hasReasoning && !busy && (
        <div className="space-y-8 py-6">
          <p className="max-w-prose text-base leading-relaxed text-secondary">
            Elements have not been extracted yet. This stage runs one model call per element, so it
            is the longest step in the pipeline.
          </p>
          <Button
            onClick={() => runElementReasoning(engine?.default_top_k_files ?? 3)}
            disabled={busy}
          >
            Extract & Reason Over Elements →
          </Button>
        </div>
      )}

      {hasReasoning && (
        <div className="animate-rise">
          {/* File tabs */}
          <div className="mb-10 flex flex-wrap items-center gap-8 border-b border-hairline pb-3">
            {fileKeys.map((key) => {
              const path = pathForFileKey(key, fileRanking);
              const index = fileKeyIndex(key);
              const active = key === currentKey;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    setActiveFileKey(key);
                    setActiveIdentifier(null);
                  }}
                  className={`relative flex items-baseline gap-2 pb-3 transition-colors ${
                    active ? "text-accent" : "text-muted hover:text-secondary"
                  }`}
                >
                  <span className="font-mono text-[10px] opacity-70">0{index}</span>
                  <span className="font-mono text-xs">{path ? basename(path) : key}</span>
                  <span className="font-mono text-[10px] text-muted">
                    {Object.keys(elementReasoning[key] || {}).length}
                  </span>
                  {active && <span className="absolute -bottom-[13px] left-0 h-px w-full bg-accent" />}
                </button>
              );
            })}
          </div>

          <div className="grid grid-cols-1 gap-12 lg:grid-cols-12">
            {/* Left — element index */}
            <div className="lg:col-span-4">
              <div className="mb-4 flex items-baseline justify-between border-b border-hairline pb-3">
                <span className="label-meta">Elements</span>
                <span className="font-mono text-[11px] text-muted">{sortedElements.length}</span>
              </div>
              <ul className="max-h-[36rem] overflow-auto">
                {sortedElements.map((identifier) => {
                  const { kind, name } = parseElementKey(identifier);
                  const active = identifier === activeIdentifier;
                  const isGroundTruth = groundTruthSet.has(identifier);
                  return (
                    <li key={identifier}>
                      <button
                        type="button"
                        onClick={() => setActiveIdentifier(identifier)}
                        className={`flex w-full items-baseline gap-3 border-b border-hairline/70 py-2.5 pr-2 text-left transition-colors ${
                          active ? "bg-accent-tint" : "hover:bg-subtle/60"
                        }`}
                      >
                        <span
                          className={`w-16 shrink-0 font-mono text-[10px] uppercase tracking-wider ${
                            active ? "text-accent" : "text-muted"
                          }`}
                        >
                          {kind}
                        </span>
                        <span
                          className={`min-w-0 flex-1 truncate font-mono text-sm ${
                            active ? "font-medium text-accent" : "text-primary"
                          }`}
                        >
                          {name}
                        </span>
                        {isGroundTruth && (
                          <span className="shrink-0 font-mono text-[10px] uppercase text-accent">
                            gt
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>

            {/* Right — the reading room */}
            <div className="min-w-0 lg:col-span-8">
              {activeIdentifier ? (
                <>
                  <div className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-hairline pb-3">
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-sm font-medium text-primary">
                        {activeIdentifier}
                      </span>
                      {groundTruthSet.has(activeIdentifier) && (
                        <Badge variant="accent">ground truth</Badge>
                      )}
                    </div>
                    <span className="break-all font-mono text-[11px] text-muted">
                      {pathForFileKey(currentKey, fileRanking)}
                    </span>
                  </div>

                  <ReasoningProse text={reasoning} />

                  <p className="mt-8 max-w-prose font-mono text-[11px] leading-relaxed text-muted">
                    A cobalt rule marks a paragraph describing bypassed or broken behaviour — the
                    kind of statement reasoning-guided ranking is built to surface. It annotates
                    language only, and changes no ordering.
                  </p>
                </>
              ) : (
                <p className="text-base text-muted">Select an element to read its analysis.</p>
              )}
            </div>
          </div>

          <div className="mt-12 flex items-center gap-6 border-t border-hairline pt-8">
            <Button onClick={runElementRanking} disabled={busy}>
              Rank Elements by Causal Relevance →
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
