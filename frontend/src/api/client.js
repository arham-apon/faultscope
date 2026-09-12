/**
 * Thin fetch layer over the FaultScope FastAPI backend.
 *
 * Two deliberate departures from the frontend spec, both resolved toward the
 * backend as it actually exists:
 *
 *  1. No `model` / `backend` field is sent. The spec pins "gemini-2.5-pro" in
 *     the client, but the server already owns that choice (config.DEFAULT_MODEL)
 *     and its Pydantic models default to it. Sending a hard-coded model from the
 *     browser would silently override the server's configuration, so the UI asks
 *     `GET /meta` what engine is running and labels itself from the answer.
 *
 *  2. Static upload posts multipart to `POST /projects/upload`. A browser cannot
 *     hand the server a filesystem path, so uploaded files are staged server-side
 *     and adopted as the candidate set there.
 */

const BASE_URL = (import.meta.env.VITE_API_BASE_URL || "http://localhost:8000").replace(/\/$/, "");

/**
 * FastAPI reports errors in three different shapes depending on where the
 * failure happened: a plain `detail` string from our own HTTPExceptions, an
 * array of validation objects from Pydantic, or nothing at all when a proxy
 * fails. Flatten all of them into one readable line.
 */
function extractDetail(payload, fallback) {
  if (!payload) return fallback;
  const { detail } = payload;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        const field = Array.isArray(item.loc) ? item.loc.filter((p) => p !== "body").join(".") : "";
        return field ? `${field}: ${item.msg}` : item.msg;
      })
      .filter(Boolean)
      .join(" · ");
  }
  if (typeof payload === "string") return payload;
  return fallback;
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, options);
  } catch (networkError) {
    throw new Error(
      `Cannot reach the FaultScope backend at ${BASE_URL}. Start it with ` +
        `\`uvicorn main:app --reload\` from the backend/ directory.`,
    );
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(extractDetail(payload, `${response.status} ${response.statusText}`));
  }

  return response.json();
}

function postJson(path, body) {
  return request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

/** Server defaults — engine label and stage sizes. */
export function getMeta() {
  return request("/meta");
}

/**
 * Stage 0 from a GitHub URL or a server-local path.
 * Accepts { repo_url, ref, subdir, problem_statement, ground_truth_file, ground_truth_elements }
 * or { repo_root, ... }.
 */
export function createProject(payload) {
  return postJson("/projects", payload);
}

/**
 * Stage 0 from uploaded files.
 * `files` is an array of { file, path } — `path` preserves folder structure when
 * the browser reports one (drag-and-drop of a directory, or a webkitdirectory input).
 */
export function createProjectFromUpload({
  files,
  problemStatement,
  groundTruthFile,
  groundTruthElements,
}) {
  const form = new FormData();
  const paths = [];

  files.forEach(({ file, path }) => {
    form.append("files", file, file.name);
    paths.push(path || file.name);
  });

  form.append("problem_statement", problemStatement);
  form.append("relative_paths", JSON.stringify(paths));
  if (groundTruthFile) form.append("ground_truth_file", groundTruthFile);
  if (groundTruthElements?.length) {
    form.append("ground_truth_elements", JSON.stringify(groundTruthElements));
  }

  // No Content-Type header: the browser must set the multipart boundary itself.
  return request("/projects/upload", { method: "POST", body: form });
}

export function fetchCandidates(projectId, topNCandidates = 5) {
  return postJson(`/projects/${projectId}/candidates`, { top_n_candidates: topNCandidates });
}

export function fetchFileReasoning(projectId) {
  return postJson(`/projects/${projectId}/file-reasoning`);
}

export function fetchFileRanking(projectId) {
  return postJson(`/projects/${projectId}/file-ranking`);
}

export function fetchElementReasoning(projectId, topKFiles = 3) {
  return postJson(`/projects/${projectId}/element-reasoning`, { top_k_files: topKFiles });
}

export function fetchElementRanking(projectId) {
  return postJson(`/projects/${projectId}/element-ranking`);
}

export function getProjectSession(projectId) {
  return request(`/projects/${projectId}`);
}

/** Line and byte counts for the stored candidates. */
export function getCandidateMeta(projectId) {
  return request(`/projects/${projectId}/candidate-meta`);
}

/** Source slice plus real line numbers for one "<kind>: <name>" element. */
export function getElementSource(projectId, path, element) {
  const query = new URLSearchParams({ path, element });
  return request(`/projects/${projectId}/element-source?${query}`);
}

export function deleteProject(projectId) {
  return request(`/projects/${projectId}`, { method: "DELETE" });
}

export { BASE_URL };
