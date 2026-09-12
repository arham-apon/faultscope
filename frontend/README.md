# FaultScope — Frontend

An editorial interface for the RGFL-Mini backend: a seven-stage workbench that walks a bug report
from "here is a repository" to "here is the function responsible, and here is the argument for why."

React 18 + JSX + Vite + Tailwind. No TypeScript.

## Running it

The backend must be running first — the UI is a thin client and does no reasoning of its own.

```bash
cd backend && python -m uvicorn main:app --reload --port 8000
```

```bash
cd frontend && npm install && npm run dev
```

Then open http://localhost:5173.

To point at a backend somewhere other than `http://localhost:8000`, copy `.env.example` to `.env`
and set `VITE_API_BASE_URL`.

## The seven stages

| Stage | What it shows | Backend route |
| --- | --- | --- |
| 01 Manifest | Bug report + source (GitHub URL or uploaded files) | `POST /projects` or `POST /projects/upload` |
| 02 Candidates | Resolved tree, nominated candidate files | `POST /projects/{id}/candidates` |
| 03 File reasoning | One independent explanation per candidate | `POST /projects/{id}/file-reasoning` |
| 04 File ranking | Files reordered by reasoning, top-3 boundary | `POST /projects/{id}/file-ranking` |
| 05 Element reasoning | AST-extracted elements + per-element analysis | `POST /projects/{id}/element-reasoning` |
| 06 Element ranking | Ranked suspicious elements per file | `POST /projects/{id}/element-ranking` |
| 07 Inspector | Source slice beside the causal rationale | `GET /projects/{id}/element-source` |

Stages unlock in order. The backend enforces the same gating independently (HTTP 409 if a
prerequisite has not run), so the UI's gating is for legibility, not safety.

## Two ingestion modes

**Public GitHub repository.** The backend resolves the ref to an exact commit SHA before
downloading, so a run is reproducible and the pinned SHA is displayed in the header. `subdir` sets
the effective root — with `subdir: "astropy"`, a ground-truth path is `io/ascii/html.py`, not
`astropy/io/ascii/html.py`.

**Static upload.** Dropped `.py` files (or a whole folder, with its structure preserved) are staged
server-side and adopted as the candidate set directly. Stage 2's LLM nomination is skipped — the
user has already made that choice — and the pipeline resumes at Stage 3.

## Where the spec was overruled by the backend

The implementation spec was written ahead of the backend it targets. Where the two disagreed, the
backend won:

- **Model.** The spec pins `gemini-2.5-pro` in the API client. The server owns that choice
  (`config.DEFAULT_MODEL`), so the client sends no model at all and the UI reads `GET /meta` to
  label itself. The engine badge always names the model that will actually be called.
- **Static upload.** The spec describes upload as a frontend-only concern, but a browser cannot
  hand a server a filesystem path. `POST /projects/upload` was added to the backend for this.
- **Element source.** Stage 7 needs line numbers and a source slice that no existing route
  returned; `GET /projects/{id}/element-source` was added, re-running the same AST walk.
- **Evaluation shapes.** `fileEval` is `{ groundTruthRank, hitAtK }` and `elementEval` is
  `{ "<kind>: <name>": { found, file_key, position } }`, matching what the backend returns rather
  than the shapes the spec sketched.
- **Stage 3 progress.** The spec asks for a per-file progress bar. The backend runs the whole stage
  as one blocking call with an internal thread pool and emits no progress events, so the UI shows
  an indeterminate sweep and elapsed time instead of inventing a percentage.

## Notes on a few deliberate choices

- **`lib/highlight.js`** is a hand-written Python tokenizer rather than a highlighting library.
  The palette here is four colours, and every library approach ends in `dangerouslySetInnerHTML` —
  which, for source pulled from an arbitrary GitHub repository, is not a good trade.
- **`ReasoningProse`** renders the Markdown subset the models actually emit (headings, bold, inline
  code, fences, lists) as React elements. Same reasoning: no HTML injection, and the output matches
  this page's typography instead of a generic stylesheet.
- **The cobalt margin rule** marks reasoning paragraphs containing causal language ("bypasses",
  "ignores", "fails to"). It is a reading aid over the model's own prose and never reorders
  anything.
- **Stage 7's comparison panel** computes its "surface similarity" column in the browser by lexical
  overlap between element names and the bug report. It stands in for a name-matching localizer to
  illustrate the contrast the RGFL paper draws — it is not a second pipeline run, and the panel
  says so.

## Rate limits worth knowing about

- **Gemini free tier** allows a few requests per minute. Element reasoning issues one call per
  element, so a burst trips it. The backend retries rate-limit failures with backoff
  (`LLM_MAX_RETRIES` in `backend/config.py`); anything that still fails is stored as an error
  string for that element and rendered as a failure notice rather than silently dropped.
- **Unauthenticated GitHub API** allows 60 requests per hour and each run spends two. Set
  `GITHUB_TOKEN` in the backend environment, or paste a token into the optional field in Stage 1,
  to raise it to 5,000.

## Structure

```
src/
├── api/client.js              Fetch layer; one function per backend route
├── context/ProjectContext.jsx Pipeline state; one action per stage
├── lib/
│   ├── pipeline.js            Backend vocabulary → display helpers
│   └── highlight.js           Python tokenizer for the code viewer
└── components/
    ├── common/                Navigation, SectionHeading, Badge, Button,
    │                          CodeViewer, ReasoningProse, StageStatus, ErrorNotice
    └── stages/                Stage1Manifest … Stage7Inspector
```
