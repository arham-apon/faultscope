import React, { createContext, useCallback, useContext, useMemo, useReducer, useRef } from "react";
import * as api from "../api/client";
import { parseElementList } from "../lib/pipeline";

/**
 * Single source of truth for the whole pipeline run.
 *
 * Every stage action follows the same shape: mark the stage loading, call one
 * backend route, commit the result, unlock the next stage. Stage gating is
 * enforced server-side too (409 if a prerequisite has not run), so the UI's
 * gating is about legibility rather than safety.
 */

const ProjectContext = createContext(null);

const initialState = {
  // Inputs and source mode
  sourceType: "github", // "github" | "static"
  projectId: null,
  problemStatement: "",
  groundTruthFile: "",
  groundTruthElements: "",

  // GitHub source metadata
  repoUrl: "",
  ref: "",
  subdir: "",
  githubMeta: null, // { owner, repo, resolvedRef, resolvedCommitSha }

  // Static upload metadata
  uploadedFiles: [], // [{ name, path, lineCount, sizeBytes }]

  // Stage outputs
  treePreview: "",
  numPythonFiles: 0,
  candidateFiles: [],
  candidatesRawOutput: "",
  candidateMeta: [], // [{ path, line_count, size_bytes }]
  fileReasoning: {},
  fileRanking: [],
  fileEval: null, // { groundTruthRank, hitAtK }
  elementReasoning: {}, // { file1_elements_reasoning: { "function: write": "..." } }
  elementRanking: {}, // { similar_elements_file1: ["function: write"] }
  elementEval: null, // { "function: write": { found, file_key, position } }
  activeElement: null, // { file, identifier, fileKey }

  // Engine + UI status
  engine: null, // { default_model, default_backend, ... } from GET /meta
  currentStage: 1,
  maxStageReached: 1,
  loadingStage: null,
  loadingLabel: "",
  errorMessage: null,
};

function reducer(state, action) {
  switch (action.type) {
    case "SET_FIELD":
      return { ...state, [action.field]: action.value };

    case "SET_ENGINE":
      return { ...state, engine: action.engine };

    case "START_STAGE":
      return {
        ...state,
        loadingStage: action.stage,
        loadingLabel: action.label || "",
        errorMessage: null,
      };

    case "STAGE_FAILED":
      return { ...state, loadingStage: null, loadingLabel: "", errorMessage: action.message };

    case "COMMIT_STAGE": {
      const nextStage = action.nextStage ?? state.currentStage;
      return {
        ...state,
        ...action.values,
        loadingStage: null,
        loadingLabel: "",
        errorMessage: null,
        currentStage: nextStage,
        maxStageReached: Math.max(state.maxStageReached, nextStage),
      };
    }

    case "GO_TO_STAGE":
      return { ...state, currentStage: action.stage, errorMessage: null };

    case "CLEAR_ERROR":
      return { ...state, errorMessage: null };

    case "RESET":
      return { ...initialState, engine: state.engine };

    default:
      return state;
  }
}

export function ProjectProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  // Guards against a double-click firing the same expensive LLM stage twice;
  // React state updates are async, so `loadingStage` alone is not enough.
  const inFlight = useRef(false);

  const setField = useCallback((field, value) => {
    dispatch({ type: "SET_FIELD", field, value });
  }, []);

  const goToStage = useCallback((stage) => {
    dispatch({ type: "GO_TO_STAGE", stage });
  }, []);

  const clearError = useCallback(() => dispatch({ type: "CLEAR_ERROR" }), []);

  const reset = useCallback(() => {
    // Releasing the session server-side deletes its temp checkout (a GitHub
    // download, or an upload staging directory). Best-effort: a failure here
    // must never stop the user from starting a new run.
    if (state.projectId) {
      api.deleteProject(state.projectId).catch(() => {});
    }
    dispatch({ type: "RESET" });
  }, [state.projectId]);

  /** Wrap one pipeline stage: guard, mark loading, run, commit or report. */
  const runStage = useCallback(async ({ stage, label, nextStage, run }) => {
    if (inFlight.current) return null;
    inFlight.current = true;
    dispatch({ type: "START_STAGE", stage, label });
    try {
      const values = await run();
      dispatch({ type: "COMMIT_STAGE", values: values || {}, nextStage });
      return values;
    } catch (error) {
      dispatch({ type: "STAGE_FAILED", message: error.message || String(error) });
      return null;
    } finally {
      inFlight.current = false;
    }
  }, []);

  const loadEngine = useCallback(async () => {
    try {
      dispatch({ type: "SET_ENGINE", engine: await api.getMeta() });
    } catch {
      // A missing /meta is not worth blocking the UI over — the engine badge
      // simply reads "unavailable" until the backend is reachable.
      dispatch({ type: "SET_ENGINE", engine: null });
    }
  }, []);

  /** Stage 1 — GitHub ingestion. */
  const initializeFromGithub = useCallback(
    ({ repoUrl, ref, subdir, githubToken, problemStatement, groundTruthFile, groundTruthElements }) =>
      runStage({
        stage: 1,
        label: "Resolving repository and pinning commit",
        nextStage: 2,
        run: async () => {
          const payload = {
            repo_url: repoUrl.trim(),
            problem_statement: problemStatement,
          };
          if (ref?.trim()) payload.ref = ref.trim();
          if (subdir?.trim()) payload.subdir = subdir.trim();
          // Forwarded for this request only; never committed to pipeline state.
          if (githubToken?.trim()) payload.github_token = githubToken.trim();
          if (groundTruthFile?.trim()) payload.ground_truth_file = groundTruthFile.trim();

          const elements = parseElementList(groundTruthElements);
          if (elements.length) payload.ground_truth_elements = elements;

          const created = await api.createProject(payload);

          // The create response carries no commit metadata, so read it back from
          // the session — this is what makes the pinned SHA visible in the UI.
          let githubMeta = null;
          try {
            const session = await api.getProjectSession(created.project_id);
            githubMeta = {
              owner: session.owner,
              repo: session.repo_name,
              resolvedRef: session.resolved_ref,
              resolvedCommitSha: session.resolved_commit_sha,
            };
          } catch {
            githubMeta = null;
          }

          return {
            sourceType: "github",
            projectId: created.project_id,
            numPythonFiles: created.num_python_files,
            treePreview: created.tree_preview,
            githubMeta,
            problemStatement,
            groundTruthFile,
            groundTruthElements,
            repoUrl,
            ref,
            subdir,
          };
        },
      }),
    [runStage],
  );

  /** Stage 1 — static upload ingestion. */
  const initializeFromUpload = useCallback(
    ({ files, problemStatement, groundTruthFile, groundTruthElements }) =>
      runStage({
        stage: 1,
        label: "Staging uploaded files",
        nextStage: 2,
        run: async () => {
          const created = await api.createProjectFromUpload({
            files,
            problemStatement,
            groundTruthFile: groundTruthFile?.trim() || "",
            groundTruthElements: parseElementList(groundTruthElements),
          });

          // Upload mode adopts the uploaded files as candidates server-side, so
          // Stage 1 (§4) never runs. Read that candidate set back immediately.
          const session = await api.getProjectSession(created.project_id);
          const candidateFiles = session.candidates || [];
          let candidateMeta = [];
          try {
            candidateMeta = (await api.getCandidateMeta(created.project_id)).candidate_meta;
          } catch {
            candidateMeta = [];
          }

          return {
            sourceType: "static",
            projectId: created.project_id,
            numPythonFiles: created.num_python_files,
            treePreview: created.tree_preview,
            githubMeta: null,
            candidateFiles,
            candidateMeta,
            candidatesRawOutput: session.candidates_raw_output || "",
            uploadedFiles: files.map(({ file, path }) => ({
              name: file.name,
              path: path || file.name,
              sizeBytes: file.size,
            })),
            problemStatement,
            groundTruthFile,
            groundTruthElements,
          };
        },
      }),
    [runStage],
  );

  /** Stage 2 — LLM candidate selection (GitHub mode only). */
  const runCandidates = useCallback(
    (topN) =>
      runStage({
        stage: 2,
        label: "Nominating candidate files from the repository tree",
        nextStage: 2,
        run: async () => {
          const result = await api.fetchCandidates(state.projectId, topN);
          let candidateMeta = [];
          try {
            candidateMeta = (await api.getCandidateMeta(state.projectId)).candidate_meta;
          } catch {
            candidateMeta = [];
          }
          return {
            candidateFiles: result.candidates,
            candidatesRawOutput: result.raw_llm_output,
            candidateMeta,
          };
        },
      }),
    [runStage, state.projectId],
  );

  /** Stage 3 — isolated per-file reasoning. */
  const runFileReasoning = useCallback(
    () =>
      runStage({
        stage: 3,
        label: "Reasoning over each candidate file in isolation",
        nextStage: 3,
        run: async () => {
          const result = await api.fetchFileReasoning(state.projectId);
          return { fileReasoning: result.file_reasoning };
        },
      }),
    [runStage, state.projectId],
  );

  /** Stage 4 — reasoning-guided file ranking. */
  const runFileRanking = useCallback(
    () =>
      runStage({
        stage: 4,
        label: "Ranking files by their reasoning",
        nextStage: 4,
        run: async () => {
          const result = await api.fetchFileRanking(state.projectId);
          return {
            fileRanking: result.ranked_files,
            fileEval:
              result.ground_truth_rank === null && !result.hit_at_k
                ? null
                : { groundTruthRank: result.ground_truth_rank, hitAtK: result.hit_at_k },
          };
        },
      }),
    [runStage, state.projectId],
  );

  /** Stages 5 — element extraction + element-level reasoning. */
  const runElementReasoning = useCallback(
    (topKFiles) =>
      runStage({
        stage: 5,
        label: "Extracting elements and reasoning over each one",
        nextStage: 5,
        run: async () => {
          const result = await api.fetchElementReasoning(state.projectId, topKFiles);
          return { elementReasoning: result.element_reasoning };
        },
      }),
    [runStage, state.projectId],
  );

  /** Stage 6 — element ranking. */
  const runElementRanking = useCallback(
    () =>
      runStage({
        stage: 6,
        label: "Ranking elements by causal relevance",
        nextStage: 6,
        run: async () => {
          const result = await api.fetchElementRanking(state.projectId);
          return {
            elementRanking: result.element_ranking,
            elementEval: result.element_ranking_eval,
          };
        },
      }),
    [runStage, state.projectId],
  );

  /** Stage 7 — open one element in the inspector. */
  const inspectElement = useCallback(({ file, identifier, fileKey }) => {
    dispatch({
      type: "COMMIT_STAGE",
      values: { activeElement: { file, identifier, fileKey } },
      nextStage: 7,
    });
  }, []);

  const value = useMemo(
    () => ({
      ...state,
      setField,
      goToStage,
      clearError,
      reset,
      loadEngine,
      initializeFromGithub,
      initializeFromUpload,
      runCandidates,
      runFileReasoning,
      runFileRanking,
      runElementReasoning,
      runElementRanking,
      inspectElement,
    }),
    [
      state,
      setField,
      goToStage,
      clearError,
      reset,
      loadEngine,
      initializeFromGithub,
      initializeFromUpload,
      runCandidates,
      runFileReasoning,
      runFileRanking,
      runElementReasoning,
      runElementRanking,
      inspectElement,
    ],
  );

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProject() {
  const context = useContext(ProjectContext);
  if (!context) throw new Error("useProject must be used inside a ProjectProvider.");
  return context;
}
