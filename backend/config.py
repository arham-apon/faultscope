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
# Set GOOGLE_API_KEY in your environment and you're good to go.
# Recommended free-tier Gemini models (pick any):
#   "gemini-2.0-flash"        — fast, capable, generous free quota  (DEFAULT)
#   "gemini-2.0-flash-lite"   — fastest, lowest cost
#   "gemini-1.5-flash"        — stable, well-tested
#   "gemini-2.5-pro"          — highest quality, may hit rate limits on free tier
DEFAULT_BACKEND: str = "gemini"
DEFAULT_MODEL: str = "gemini-2.0-flash"

# Sessions persistence directory (relative to backend/ directory at runtime)
SESSIONS_DIR: str = "sessions"
