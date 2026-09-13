# FaultScope

Automated fault localization built on **RGFL** (Reasoning-Guided Fault Localization): give it a bug
report and a Python codebase, and it names the file — then the function, class, or global — most
likely responsible, along with the reasoning that got it there.

The method is one pattern applied twice:

1. **Reason in isolation.** One model call per candidate: _here is the bug report, here is this one
   file — explain what it does and whether it relates._
2. **Rank on the reasoning.** One model call over all of those explanations at once: _rank these._

Run that over whole files, then again over the elements inside the top-ranked files. That is the
entire mechanism — the paper's "hierarchical reasoning module" is this A→B pass, twice.

## Research Methodology

FaultScope replicates the core fault localization mechanism from two papers:

1. **AGENTLESS: Demystifying LLM-based Software Engineering Agents** (ICSE 2024)
   - Introduces a two-phase approach: localization → repair
   - File-level localization uses LLM-based candidate selection + embedding retrieval
   - This implementation uses **only the LLM-based candidate selection** (simplified)

2. **RGFL: Reasoning Guided Fault Localization for Automated Program Repair Using Large Language Models** (arXiv 2026)
   - Proposes "reasoning-guided" localization: reason about each candidate in isolation, then rank by reasoning
   - Applies the A→B pattern hierarchically: file-level → element-level
   - This implementation replicates the **hierarchical reasoning module** faithfully

**Key deviation from original**: Fixed a path-convention bug where `create_structure` used a synthetic top-level folder prefix but the reasoning stage used paths relative to repo root. This implementation uses a single consistent path convention everywhere (relative to `repo/` root).

## Pipeline Flow (Code Flow)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        BACKEND PIPELINE (FastAPI)                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  STAGE 0: Structure Building (§3)                                           │
│  ├── create_structure() — AST-parse every .py file                          │
│  ├── filter_none_python() — drop non-Python content                         │
│  ├── filter_out_test_files() — drop anything starting with "test"          │
│  └── Flatten → files_flat (list of (path, lines))                          │
│                                                                             │
│  STAGE 1: Candidate Selection (§4)  [GitHub mode only]                     │
│  └── select_candidates() — 1 LLM call: bug report + tree → top-N files     │
│                                                                             │
│  STAGE 2: File-Level Reasoning (§5)                                         │
│  └── generate_file_reasoning() — 1 LLM call PER candidate file (parallel)  │
│      "Here's the bug, here's this file — explain relevance"                │
│                                                                             │
│  STAGE 3: File-Level Ranking (§6)                                           │
│  └── rank_files() — 1 LLM call: ALL reasonings → ranked file list          │
│      Optional: Hit@k evaluation against ground_truth_file                  │
│                                                                             │
│  STAGE 4: Element Extraction (§7)  [Top-K files from Stage 3]              │
│  └── extract_code_elements_from_file() — AST extract functions/classes/globals │
│                                                                             │
│  STAGE 5: Element-Level Reasoning (§8)                                      │
│  └── generate_all_element_reasoning() — 1 LLM call PER element (parallel)  │
│      "Here's the bug, here's this function — explain relevance"            │
│                                                                             │
│  STAGE 6: Element-Level Ranking (§9)                                        │
│  └── rank_all_files_elements() — 1 LLM call PER file (sequential)          │
│      Optional: evaluation against ground_truth_elements                    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Concurrency Model:**

- Stage 2 (file reasoning): `ThreadPoolExecutor(max_workers=MAX_REASONING_WORKERS=5)`
- Stage 5 (element reasoning): `ThreadPoolExecutor(max_workers=MAX_ELEMENT_WORKERS=1)` — sequential
- Stage 6 (element ranking): Sequential loop (1 call per file)

## User Flow (Frontend Workbench)

The frontend (`frontend/`) is a 7-stage React workbench that maps 1:1 to backend API routes:

| Stage | UI Title                           | Backend Route                               | What Happens                                                       |
| ----- | ---------------------------------- | ------------------------------------------- | ------------------------------------------------------------------ |
| 01    | Manifest & Code Ingestion          | `POST /projects` or `POST /projects/upload` | Enter bug report; provide GitHub URL **or** upload `.py` files     |
| 02    | Candidate Resolution               | `POST /projects/{id}/candidates`            | LLM nominates candidate files from repo tree (skipped for uploads) |
| 03    | Isolated File Reasoning            | `POST /projects/{id}/file-reasoning`        | Per-file reasoning paragraphs generated in parallel                |
| 04    | File Ranking & Boundary            | `POST /projects/{id}/file-ranking`          | Files ranked by reasoning; top-3 promoted to element level         |
| 05    | Element Extraction & Reasoning     | `POST /projects/{id}/element-reasoning`     | AST extracts elements; per-element reasoning generated             |
| 06    | Suspicious Element Ranking         | `POST /projects/{id}/element-ranking`       | Elements ranked by causal relevance per file                       |
| 07    | Localized Code & Causal Diagnostic | `GET /projects/{id}/element-source`         | Source code slice + reasoning + selection-criteria comparison      |

**Stage gating**: Enforced server-side (HTTP 409 if prerequisite missing) + UI gating.

**Two ingestion modes:**

- **GitHub**: Public repo URL + optional ref (branch/tag/commit SHA) + optional subdir
- **Static upload**: Drag-and-drop `.py` files → become candidate set directly (skips Stage 2)

## Test Run: Astropy HTML Formatting Bug

### Credentials

- **Repository**: https://github.com/astropy/astropy
- **Base commit**: `19cc80471739bcb67b7e8099246b391c355023ee`
- **Bug report**:
  ```
  Issue: HTML output ignores the formats argument.
  Symptom: Formatted values appear correctly in CSV and RST outputs, but HTML shows full-precision values.
  Expected: HTML output should respect user-supplied formatting functions.
  ```
- **Ground truth (for manual evaluation at end)**:
  - File: `astropy/io/ascii/html.py`
  - Elements: `function: write`, `class: HTML`

### How to Run

1. **Backend** (needs API key in `backend/.env`):

   ```bash
   cd backend
   cp .env.example .env
   # Add GOOGLE_API_KEY or ANTHROPIC_API_KEY or OPENAI_API_KEY
   pip install -r requirements.txt
   python -m uvicorn main:app --reload --port 8000
   ```

2. **Frontend**:

   ```bash
   cd frontend
   npm install
   npm run dev
   ```

3. **Open**: http://localhost:5173

4. **Stage 1 — Manifest**:
   - Source: "Public GitHub Repository"
   - Repository URL: `https://github.com/astropy/astropy`
   - Target ref: `19cc80471739bcb67b7e8099246b391c355023ee`
   - Source subdirectory: `astropy`
   - Paste the bug report above
   - (Optional) Ground truth file: `astropy/io/ascii/html.py`
   - (Optional) Ground truth elements: `function: write, class: HTML`
   - Click **"Initialize Localization Pipeline →"**

5. **Stages 2–6**: Click the "→" button on each stage to proceed

6. **Stage 7 — Inspector**: Click "Inspect code & causal chain →" on any ranked element to see source + reasoning + comparison panel

### Expected Qualitative Outcome (per RGFL paper §1 / Figure 1)

- **Plain Agentless-style** tends to surface superficially related elements: `HTML.__init__`, `HTMLOutputter.__call__`
- **RGFL reasoning-guided** should surface `HTML.write` (via `class: HTML` at file level, `function: write` at element level) because the reasoning explicitly traces that `HTML.write` **bypasses the standard formatting pipeline** used by CSV/RST writers

> The paper reports that reasoning-guided ranking correctly identifies the causal element (`write` method) because the isolated reasoning step surfaces that it "ignores the formatter" / "bypasses the formatting logic" — not because the name matches the bug report.

## Running with Different LLM Backends

Edit `backend/config.py`:

```python
DEFAULT_BACKEND: str = "gemini"        # or "openai", "anthropic", "gemini"
DEFAULT_MODEL: str = "gemini-3.5-flash-lite" # model identifier for that backend
```

Add corresponding API key to `backend/.env`:

```bash
GROQ_API_KEY=gsk_...        # for Groq (recommended: generous free tier)
OPENAI_API_KEY=sk-...       # for OpenAI
ANTHROPIC_API_KEY=sk-...    # for Anthropic
GOOGLE_API_KEY=...          # for Gemini
```

## Configuration Knobs (`backend/config.py`)

| Constant                   | Default | Purpose                                                                   |
| -------------------------- | ------- | ------------------------------------------------------------------------- |
| `MAX_ELEMENT_WORKERS`      | 1       | Concurrency for Stage 5 (element reasoning) — reduce to avoid rate limits |
| `MAX_REASONING_WORKERS`    | 5       | Concurrency for Stage 2 (file reasoning)                                  |
| `DEFAULT_TOP_N_CANDIDATES` | 5       | Stage 1: how many files LLM nominates                                     |
| `DEFAULT_TOP_K_FILES`      | 3       | Stage 4-6: how many top files promoted to element level                   |
| `MAX_REASONING_FILE_CHARS` | 60,000  | Truncate large files before sending to LLM                                |
| `LLM_MAX_RETRIES`          | 4       | Retry attempts for rate limits (429) / transient errors                   |

## Specs & References

- `RGFL-Mini-Backend-Spec.md` — Full pipeline spec, prompt by prompt, with deviations documented
- `RGFL-Mini-GitHub-Addendum.md` — GitHub URL ingestion details
- `frontend/README.md` — Frontend architecture, UI decisions, rate-limit notes

**Papers:**

1. **AGENTLESS**: https://dl.acm.org/doi/10.1145/3715754
2. **RGFL**: https://arxiv.org/abs/2601.18044
