/**
 * Pure helpers for reading the backend's pipeline vocabulary.
 *
 * The backend speaks in the original research code's own terms —
 * "file1_elements_reasoning", "similar_elements_file2", "<kind>: <name>" — so
 * every translation into something displayable lives here rather than being
 * re-derived inside components.
 */

/**
 * Map an element-stage key back to the file path it describes.
 *
 * Backend contract (element_reasoning.generate_all_element_reasoning): keys are
 * numbered by position in the ranked list, so `fileN` is always
 * `fileRanking[N - 1]`. Files whose AST parse fails produce no key at all
 * rather than shifting the numbering, which is why indexing stays reliable.
 */
export function fileKeyIndex(key) {
  const match = String(key).match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

export function pathForFileKey(key, fileRanking) {
  const index = fileKeyIndex(key);
  if (!index || !Array.isArray(fileRanking)) return null;
  return fileRanking[index - 1] ?? null;
}

/** "file2_elements_reasoning" -> "similar_elements_file2" */
export function rankingKeyForReasoningKey(key) {
  const index = fileKeyIndex(key);
  return index ? `similar_elements_file${index}` : null;
}

/** Split "function: write" into its parts. */
export function parseElementKey(identifier) {
  const [kind, ...rest] = String(identifier).split(": ");
  const name = rest.join(": ");
  return name ? { kind, name } : { kind: "element", name: String(identifier) };
}

/** Accept comma- or newline-separated ground-truth elements from a text field. */
export function parseElementList(raw) {
  return String(raw || "")
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Last path segment, for display alongside the full path. */
export function basename(path) {
  return String(path || "").split("/").pop();
}

/**
 * Heuristic: does this paragraph describe a *causal* discrepancy rather than a
 * neutral description of behaviour?
 *
 * RGFL's central claim is that reasoning surfaces elements which bypass or break
 * an expected pipeline, so paragraphs making that kind of statement earn a
 * cobalt rule in the margin. This is a reading aid over the model's prose — it
 * marks language, not a judgement by the model, and it never reorders anything.
 */
const CAUSAL_SIGNALS = [
  "bypass",
  "bypasses",
  "ignores",
  "ignored",
  "does not apply",
  "does not respect",
  "never applies",
  "fails to",
  "skips",
  "skipping",
  "without applying",
  "overrides",
  "circumvent",
  "instead of using",
  "directly accesses",
  "responsible for the bug",
  "root cause",
  "likely culprit",
  "this is the bug",
];

export function hasCausalSignal(text) {
  const lowered = String(text || "").toLowerCase();
  return CAUSAL_SIGNALS.some((signal) => lowered.includes(signal));
}

/**
 * A surface-similarity pick, used as the baseline half of the Stage 7 comparison.
 *
 * This is NOT a second pipeline run and must never be presented as one. It is a
 * deliberately naive proxy for the failure mode the RGFL paper describes in its
 * Figure 1: a name-matching localizer nominates whichever element *reads* like
 * the bug report, while the reasoning-guided ranking nominates the element whose
 * described behaviour actually causes it. When both pick the same element, the
 * comparison simply says so.
 */
export function surfaceSimilarityPick(identifiers, problemStatement) {
  const words = new Set(
    String(problemStatement || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 3),
  );
  if (!identifiers?.length) return null;

  let best = null;
  let bestScore = -1;

  identifiers.forEach((identifier) => {
    const { name } = parseElementKey(identifier);
    // Split identifiers on snake_case and camelCase boundaries before matching.
    const tokens = name
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[^a-zA-Z0-9]+/)
      .map((token) => token.toLowerCase())
      .filter(Boolean);

    const overlap = tokens.filter((token) => words.has(token)).length;
    // Ties break toward the element the file defines first, which is what a
    // shallow top-down scan would reach first.
    if (overlap > bestScore) {
      bestScore = overlap;
      best = identifier;
    }
  });

  return bestScore > 0 ? best : identifiers[0];
}

export function formatBytes(bytes) {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}
