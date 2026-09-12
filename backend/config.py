"""
config.py — Constants and configurable defaults for RGFL-Mini backend.
All values should be treated as defaults; per-request overrides are
accepted where the API spec allows them.
"""

# ---------------------------------------------------------------------------
# Repository-walking limits (§2)
# ---------------------------------------------------------------------------
MAX_FILES: int = 800          # Cap total .py files walked; truncate + warn if exceeded
MAX_FILE_BYTES: int = 300_000 # Skip content of any .py file larger than this (~300 KB)

# Directories to prune before descending during os.walk (§2)
SKIP_DIRS: frozenset[str] = frozenset({
    ".git",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    ".tox",
    ".mypy_cache",
})

# ---------------------------------------------------------------------------
# LLM / reasoning limits (§5)
# ---------------------------------------------------------------------------
# Max characters of file content to insert into a file-reasoning prompt.
# If exceeded, content is truncated and a marker appended.
MAX_REASONING_FILE_CHARS: int = 60_000

# Thread-pool concurrency for parallel LLM calls (§5, §8)
MAX_REASONING_WORKERS: int = 5   # file-level reasoning (§5)
MAX_ELEMENT_WORKERS: int = 4     # element-level reasoning (§8)

# ---------------------------------------------------------------------------
# Pipeline stage defaults
# ---------------------------------------------------------------------------
DEFAULT_TOP_N_CANDIDATES: int = 5   # Stage 1: how many candidate files to ask for
DEFAULT_TOP_K_FILES: int = 3        # Stage 4-6: how many top files to extract elements from

# ---------------------------------------------------------------------------
# LLM defaults — Gemini free-tier
# ---------------------------------------------------------------------------
# Set GOOGLE_API_KEY in your environment or backend/.env and you're good to go.
#
# IMPORTANT — free-tier daily quota. Each model has its own allowance, and the
# pinned versions are stingy: "gemini-3.6-flash" allows 20 requests PER DAY
# (quotaId GenerateRequestsPerDayPerProjectPerModel-FreeTier). A single full
# pipeline run spends far more than that — 3-5 file-reasoning calls, 1 ranking
# call, then one call per extracted element — so a pinned model will exhaust a
# day's quota partway through one run and the rest land as "Error during
# reasoning" strings.
#
# Verified available on this key:
#   "gemini-flash-latest"   — rolling alias, its own quota bucket  (recommended)
#   "gemini-3.6-flash"      — pinned, 20 requests/day on free tier (CURRENT)
#   "gemini-3.7-flash", "gemini-3.8-flash", "gemini-3.5-flash" — other pinned versions
#   "gemini-flash-lite-latest" — cheapest, largest allowance
#
# Pin a version for reproducible research results; use the rolling alias when
# you need a run to actually finish. List what your key can reach with:
#   python -c "from google import genai; import os; \
#     print([m.name for m in genai.Client(api_key=os.environ['GOOGLE_API_KEY']).models.list()])"
DEFAULT_BACKEND: str = "gemini"
DEFAULT_MODEL: str = "gemini-3.6-flash"

# Sessions persistence directory (relative to backend/ directory at runtime)
SESSIONS_DIR: str = "sessions"

# ---------------------------------------------------------------------------
# GitHub URL support
# ---------------------------------------------------------------------------
# Maximum compressed archive size accepted from GitHub.  This keeps a public
# URL request from unexpectedly consuming excessive memory in this demo app.
MAX_REPO_DOWNLOAD_BYTES: int = 150_000_000
DOWNLOAD_TIMEOUT_SECONDS: int = 60
GITHUB_API_BASE: str = "https://api.github.com"

# ---------------------------------------------------------------------------
# Static file upload support
# ---------------------------------------------------------------------------
# Browser-uploaded candidate files are staged into a temp directory and used
# as the candidate set directly, bypassing LLM candidate selection (§4).
MAX_UPLOAD_FILES: int = 50
MAX_UPLOAD_TOTAL_BYTES: int = 20_000_000

# ---------------------------------------------------------------------------
# LLM transient-failure retry
# ---------------------------------------------------------------------------
# Free-tier Gemini enforces a requests-per-minute quota, and element-level
# reasoning issues one call per element — so a burst reliably trips it. Without
# a retry, those calls land in the pipeline as "Error during reasoning: 429"
# strings and quietly degrade the ranking they feed. Retries are bounded and
# apply only to rate-limit / transient-server errors, never to bad requests.
LLM_MAX_RETRIES: int = 4
LLM_RETRY_BASE_SECONDS: float = 8.0
LLM_RETRY_MAX_SECONDS: float = 60.0
