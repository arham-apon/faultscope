# FaultScope

Automated fault localization built on **RGFL** (Reasoning-Guided Fault Localization): give it a bug
report and a Python codebase, and it names the file — then the function, class, or global — most
likely responsible, along with the reasoning that got it there.

The method is one pattern applied twice:

1. **Reason in isolation.** One model call per candidate: *here is the bug report, here is this one
   file — explain what it does and whether it relates.*
2. **Rank on the reasoning.** One model call over all of those explanations at once: *rank these.*

Run that over whole files, then again over the elements inside the top-ranked files. That is the
entire mechanism — the paper's "hierarchical reasoning module" is this A→B pass, twice.

## Layout

```
backend/     FastAPI service — the pipeline (see RGFL-Mini-Backend-Spec.md)
frontend/    React + Vite workbench — seven stages (see frontend/README.md)
```

## Running it

Backend (needs `GOOGLE_API_KEY` in `backend/.env` — copy `backend/.env.example`):

```bash
cd backend && pip install -r requirements.txt && python -m uvicorn main:app --reload --port 8000
```

Frontend:

```bash
cd frontend && npm install && npm run dev
```

Open http://localhost:5173. API docs are at http://localhost:8000/docs.

## Supplying code

- **A public GitHub URL** — resolved to an exact commit SHA, downloaded as a tarball, no `git`
  binary required. An optional `subdir` sets the effective root.
- **Uploaded `.py` files** — staged server-side and used as the candidate set directly, skipping
  repository-wide candidate nomination.
- **A local path on the server** — the original `repo_root` form, still supported by the API.

## Evaluation

Supply `ground_truth_file` and `ground_truth_elements` and each run reports rank position and
Hit@k at file level, and found/position at element level — the paper's metrics computed for a
single instance instead of a whole benchmark.

## Specs

- `RGFL-Mini-Backend-Spec.md` — the pipeline, prompt by prompt, including what was deliberately
  simplified and the one path-convention bug in the original that this implementation fixes.
- `RGFL-Mini-GitHub-Addendum.md` — GitHub URL ingestion.
- `frontend/README.md` — the interface, and where its own spec was overruled by the backend.
