import React, { useEffect } from "react";
import { ProjectProvider, useProject } from "./context/ProjectContext";
import Navigation from "./components/common/Navigation";
import ErrorNotice from "./components/common/ErrorNotice";
import Stage1Manifest from "./components/stages/Stage1Manifest";
import Stage2Candidates from "./components/stages/Stage2Candidates";
import Stage3FileReason from "./components/stages/Stage3FileReason";
import Stage4FileRank from "./components/stages/Stage4FileRank";
import Stage5ElemReason from "./components/stages/Stage5ElemReason";
import Stage6ElemRank from "./components/stages/Stage6ElemRank";
import Stage7Inspector from "./components/stages/Stage7Inspector";

const STAGES = {
  1: Stage1Manifest,
  2: Stage2Candidates,
  3: Stage3FileReason,
  4: Stage4FileRank,
  5: Stage5ElemReason,
  6: Stage6ElemRank,
  7: Stage7Inspector,
};

function Workbench() {
  const {
    currentStage,
    maxStageReached,
    goToStage,
    githubMeta,
    engine,
    loadingStage,
    errorMessage,
    clearError,
    loadEngine,
    projectId,
    reset,
  } = useProject();

  useEffect(() => {
    loadEngine();
  }, [loadEngine]);

  const ActiveStage = STAGES[currentStage] || Stage1Manifest;
  const busy = loadingStage !== null;

  return (
    <div className="min-h-screen bg-canvas">
      <Navigation
        currentStage={currentStage}
        maxStageReached={maxStageReached}
        onSelectStage={goToStage}
        githubMeta={githubMeta}
        engineLabel={engine ? engine.default_model : "engine unavailable"}
        busy={busy}
      />

      <main className="mx-auto max-w-7xl px-8 py-16 md:px-12 md:py-20">
        <ErrorNotice message={errorMessage} onDismiss={clearError} />
        <ActiveStage />
      </main>

      <footer className="border-t border-hairline">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-8 py-8 font-mono text-[11px] text-muted md:px-12">
          <span>
            FaultScope · Reasoning-guided fault localization · A reimplementation of the RGFL
            file- and element-level mechanism
          </span>
          {projectId && (
            <div className="flex items-center gap-5">
              <span title={projectId}>session {projectId.slice(0, 8)}</span>
              <button
                type="button"
                onClick={reset}
                disabled={busy}
                className="uppercase tracking-wider transition-colors hover:text-status-error disabled:cursor-not-allowed disabled:opacity-50"
              >
                New run
              </button>
            </div>
          )}
        </div>
      </footer>
    </div>
  );
}

export default function App() {
  return (
    <ProjectProvider>
      <Workbench />
    </ProjectProvider>
  );
}
