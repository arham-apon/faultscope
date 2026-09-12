# RGFL-Mini Backend — Addendum: GitHub URL Support
### Extends the existing implementation (config.py, llm.py, structure.py, candidates.py, file_reasoning.py, file_ranking.py, elements.py, element_reasoning.py, element_ranking.py, store.py, main.py) — does not replace or rewrite any of it.

---

## 0. READ THIS FIRST

You already have a working backend where `POST /projects` takes `repo_root` (an absolute local filesystem
path) and everything downstream operates on that path. This addendum adds a **second way** to supply a
repository — a public GitHub URL — that resolves down to the exact same kind of local path, and then hands
off to the exact same pipeline that already exists. You are inserting one new step *before* `structure.py`'s
`create_structure()` gets called. You are not touching `create_structure()`, `filter_none_python()`,
`filter_out_test_files()`, `candidates.py`, `file_reasoning.py`, `file_ranking.py`, `elements.py`,
`element_reasoning.py`, or `element_ranking.py` in any way. If you find yourself editing those files, stop —
you've misunderstood the scope.

Only these existing files change:
- `main.py` — the `/projects` request model gains new optional fields, and the route handler gains a branch.
- `store.py` — the session dict gains a few new fields describing where the code came from.
- `config.py` — a few new constants.
- `requirements.txt` — one new dependency (`requests`).

And one new file is added:
- `github_fetch.py` — all the new logic lives here, self-contained.

---

## 1. What we're adding, in plain English

Right now, to test a repo, you have to already have it checked out on your own disk and pass its absolute path.
This addendum lets you instead pass something like `"https://github.com/astropy/astropy"` (optionally with a
branch/tag/commit and a subfolder), and the backend will:

1. Figure out the owner, repo name, and which commit you mean (resolving "give me the default branch" or
   "give me this branch name" down to one exact, pinned commit SHA — important for reproducibility, exactly the
   way the original RGFL/SWE-bench pipeline always pins to one `base_commit`, never a moving branch).
2. Download that exact commit's code as a tarball from GitHub (no `git` binary required on your machine).
3. Extract it to a temp folder.
4. Hand the resulting local folder path to the pipeline exactly as if you had typed it in as `repo_root` yourself.

Everything after that point — structure building, candidate selection, reasoning, ranking, element extraction —
is completely unchanged and doesn't know or care whether the code came from your laptop or from GitHub.

---

## 2. New request shape for `POST /projects`

The existing request body accepted (at minimum) `repo_root` and `problem_statement`. Extend the Pydantic model
so the caller now provides **exactly one of** `repo_root` **or** `repo_url` (never both, never neither):

```python
from pydantic import BaseModel, model_validator
from typing import Optional

class CreateProjectRequest(BaseModel):
    # --- existing fields, unchanged ---
    problem_statement: str
    ground_truth_file: Optional[str] = None
    ground_truth_elements: Optional[list[str]] = None
    model: str
    backend: str

    # --- existing field, now optional ---
    repo_root: Optional[str] = None

    # --- new fields for GitHub support ---
    repo_url: Optional[str] = None          # e.g. "https://github.com/astropy/astropy"
    ref: Optional[str] = None                # branch, tag, or commit SHA; omit for the repo's default branch
    subdir: Optional[str] = ""               # path INSIDE the repo to treat as the actual source root; "" = repo root
    github_token: Optional[str] = None        # optional; overrides GITHUB_TOKEN env var for this request only

    @model_validator(mode="after")
    def check_exactly_one_source(self):
        has_root = bool(self.repo_root)
        has_url = bool(self.repo_url)
        if has_root == has_url:  # both True or both False
            raise ValueError(
                "Provide exactly one of `repo_root` (a local path) or `repo_url` (a GitHub URL), not both or neither."
            )
        return self
```

`subdir` matters because many real repos have the actual importable package nested inside the checkout, e.g. a
repo whose GitHub root contains `README.md`, `setup.py`, `docs/`, and the real code under `src/astropy/`. Setting
`"subdir": "src/astropy"` means the pipeline treats `src/astropy` as the effective `repo_root` — exactly the same
concept as before, just computed after extraction instead of being something the user pre-arranges by hand.

---

## 3. `github_fetch.py` — new file, all logic lives here

### 3.1 Parsing the URL

Accept a few common shapes people will actually paste, and be forgiving:

```python
import re

def parse_github_url(repo_url: str) -> tuple[str, str, Optional[str], str]:
    """
    Returns (owner, repo, ref_from_url_or_None, subdir_from_url).
    Accepts:
      - https://github.com/owner/repo
      - https://github.com/owner/repo.git
      - https://github.com/owner/repo/tree/BRANCH
      - https://github.com/owner/repo/tree/BRANCH/sub/dir
      - owner/repo                      (shorthand, no scheme)
    Does NOT try to handle branch names containing "/" when parsed from a tree URL —
    if the caller's branch has a slash in it, they must pass `ref` explicitly instead
    of relying on URL parsing.
    """
    url = repo_url.strip().rstrip("/")
    url = re.sub(r"^https?://(www\.)?github\.com/", "", url)
    url = url.removesuffix(".git")

    parts = url.split("/")
    if len(parts) < 2:
        raise ValueError(f"Could not parse a GitHub owner/repo from: {repo_url!r}")

    owner, repo = parts[0], parts[1]
    ref = None
    subdir = ""

    if len(parts) > 2 and parts[2] == "tree" and len(parts) > 3:
        ref = parts[3]
        if len(parts) > 4:
            subdir = "/".join(parts[4:])

    return owner, repo, ref, subdir
```

Then combine with any explicit `ref`/`subdir` the caller passed in the request body — **explicit request fields
always win over anything parsed from the URL itself**:

```python
def resolve_source_params(repo_url: str, ref_override: Optional[str], subdir_override: Optional[str]):
    owner, repo, ref_from_url, subdir_from_url = parse_github_url(repo_url)
    ref = ref_override or ref_from_url          # None is fine here; resolved to default branch next
    subdir = subdir_override if subdir_override else subdir_from_url
    return owner, repo, ref, subdir
```

### 3.2 Pinning to an exact commit SHA (do this even if the caller gave a branch name)

Never download "the branch" directly without first pinning it — branches move, and you want the exact commit
you analyzed to be recorded, the same way the original SWE-bench data always pins one `base_commit` per bug
instance rather than "whatever main currently is."

```python
import requests

GITHUB_API_BASE = "https://api.github.com"

def _auth_headers(github_token: Optional[str]) -> dict:
    import os
    token = github_token or os.environ.get("GITHUB_TOKEN")
    headers = {"Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def get_default_branch(owner: str, repo: str, github_token: Optional[str]) -> str:
    resp = requests.get(f"{GITHUB_API_BASE}/repos/{owner}/{repo}", headers=_auth_headers(github_token), timeout=15)
    if resp.status_code == 404:
        raise ValueError(f"GitHub repo not found: {owner}/{repo} (is it public? typo?)")
    resp.raise_for_status()
    return resp.json()["default_branch"]


def resolve_ref_to_sha(owner: str, repo: str, ref: str, github_token: Optional[str]) -> str:
    resp = requests.get(
        f"{GITHUB_API_BASE}/repos/{owner}/{repo}/commits/{ref}",
        headers=_auth_headers(github_token),
        timeout=15,
    )
    if resp.status_code == 404:
        raise ValueError(f"Could not resolve ref {ref!r} on {owner}/{repo} — check the branch/tag/commit exists.")
    if resp.status_code == 403:
        raise ValueError(
            "GitHub API rate limit hit (60 requests/hour unauthenticated). "
            "Set the GITHUB_TOKEN environment variable to raise this to 5000/hour."
        )
    resp.raise_for_status()
    return resp.json()["sha"]
```

### 3.3 Downloading and extracting the exact commit

Use GitHub's tarball endpoint, not `git clone` — no `git` binary dependency, and it's a single HTTP GET:

```python
import io
import os
import tarfile
import tempfile

MAX_REPO_DOWNLOAD_BYTES = 150_000_000  # ~150 MB; refuse anything bigger, this is a demo tool not a CI system
DOWNLOAD_TIMEOUT_SECONDS = 60

def download_and_extract(owner: str, repo: str, sha: str, github_token: Optional[str], dest_parent: str) -> str:
    """
    Downloads the tarball for an exact commit SHA and extracts it under dest_parent.
    Returns the path to the single top-level extracted directory
    (GitHub tarballs always contain exactly one top folder, named like "{repo}-{sha[:7]}").
    """
    url = f"{GITHUB_API_BASE}/repos/{owner}/{repo}/tarball/{sha}"
    resp = requests.get(
        url, headers=_auth_headers(github_token), stream=True, timeout=DOWNLOAD_TIMEOUT_SECONDS, allow_redirects=True
    )
    resp.raise_for_status()

    content_length = resp.headers.get("Content-Length")
    if content_length and int(content_length) > MAX_REPO_DOWNLOAD_BYTES:
        raise ValueError(
            f"Repo archive is {int(content_length)/1e6:.0f} MB, exceeding the {MAX_REPO_DOWNLOAD_BYTES/1e6:.0f} MB "
            "limit for this tool. Point `subdir` at a smaller portion of the repo if you only need part of it, "
            "or raise MAX_REPO_DOWNLOAD_BYTES in config.py if you know what you're doing."
        )

    buffer = io.BytesIO()
    downloaded = 0
    for chunk in resp.iter_content(chunk_size=1 << 20):  # 1 MB chunks
        downloaded += len(chunk)
        if downloaded > MAX_REPO_DOWNLOAD_BYTES:
            raise ValueError("Repo archive exceeded the size limit mid-download; aborting.")
        buffer.write(chunk)
    buffer.seek(0)

    with tarfile.open(fileobj=buffer, mode="r:gz") as tar:
        tar.extractall(dest_parent, filter="data")  # filter="data" guards against unsafe archive entries

    extracted_entries = [
        e for e in os.listdir(dest_parent)
        if os.path.isdir(os.path.join(dest_parent, e))
    ]
    if len(extracted_entries) != 1:
        raise RuntimeError(
            f"Expected exactly one top-level folder after extraction, found {len(extracted_entries)}: "
            f"{extracted_entries}"
        )
    return os.path.join(dest_parent, extracted_entries[0])
```

Notes:
- `tarfile.extractall(..., filter="data")` requires Python 3.12+; if your runtime is older, use
  `filter="tar"` at minimum, and never call `extractall()` with no filter at all on untrusted archives (path
  traversal risk). Since anyone can put any public repo URL in here, treat the archive as untrusted input.
- `allow_redirects=True` matters: `.../tarball/{sha}` on `api.github.com` returns a redirect to the actual
  `codeload.github.com` download URL; `requests` follows redirects by default with `get()`, but be explicit
  since you're also streaming.

### 3.4 Top-level orchestration function

This is the one function `main.py` calls:

```python
def get_repo_source(
    repo_url: str,
    ref: Optional[str],
    subdir: Optional[str],
    github_token: Optional[str],
) -> dict:
    """
    Returns:
      {
        "effective_root": str,      # local path to hand to structure.create_structure()
        "download_dir": str,        # the temp dir that should be cleaned up later
        "owner": str, "repo": str,
        "resolved_ref": str,        # what the caller asked for (or "default branch")
        "resolved_commit_sha": str, # the exact pinned commit actually downloaded
      }
    """
    owner, repo, ref_final, subdir_final = resolve_source_params(repo_url, ref, subdir)

    ref_display = ref_final or "(default branch)"
    if ref_final is None:
        ref_final = get_default_branch(owner, repo, github_token)

    sha = resolve_ref_to_sha(owner, repo, ref_final, github_token)

    download_dir = tempfile.mkdtemp(prefix="rgfl_mini_")
    extracted_root = download_and_extract(owner, repo, sha, github_token, download_dir)

    effective_root = os.path.join(extracted_root, subdir_final) if subdir_final else extracted_root
    if not os.path.isdir(effective_root):
        raise ValueError(
            f"`subdir` {subdir_final!r} does not exist inside the downloaded repo. "
            f"Top-level contents were: {os.listdir(extracted_root)}"
        )

    return {
        "effective_root": effective_root,
        "download_dir": download_dir,
        "owner": owner,
        "repo": repo,
        "resolved_ref": ref_display,
        "resolved_commit_sha": sha,
    }
```

---

## 4. Changes to `main.py`

In the `/projects` route handler, branch on which source type was given, **before** calling
`structure.create_structure()`:

```python
from github_fetch import get_repo_source

@app.post("/projects")
def create_project(req: CreateProjectRequest):
    github_meta = None

    if req.repo_url:
        try:
            github_meta = get_repo_source(
                repo_url=req.repo_url,
                ref=req.ref,
                subdir=req.subdir,
                github_token=req.github_token,
            )
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Failed to fetch GitHub repo: {e}")
        effective_repo_root = github_meta["effective_root"]
    else:
        effective_repo_root = req.repo_root
        if not os.path.isdir(effective_repo_root):
            raise HTTPException(status_code=400, detail=f"repo_root does not exist or is not a directory: {effective_repo_root!r}")

    # --- everything below this line is your EXISTING, UNCHANGED logic ---
    # structure = create_structure(effective_repo_root)
    # filter_none_python(structure); filter_out_test_files(structure)
    # ... store session, return project_id, num_python_files, tree_preview ...

    session["source_type"] = "github" if req.repo_url else "local"
    if github_meta:
        session["repo_url"] = req.repo_url
        session["owner"] = github_meta["owner"]
        session["repo_name"] = github_meta["repo"]
        session["resolved_ref"] = github_meta["resolved_ref"]
        session["resolved_commit_sha"] = github_meta["resolved_commit_sha"]
        session["download_dir"] = github_meta["download_dir"]  # needed for cleanup later
    session["repo_root"] = effective_repo_root  # store the RESOLVED local path either way
```

Every existing downstream route (`/candidates`, `/file-reasoning`, `/file-ranking`, `/element-reasoning`,
`/element-ranking`, `GET /projects/{id}`) keeps reading `session["repo_root"]` exactly as it already does —
**no changes needed in any of those routes.**

### 4.1 `GET /projects/{project_id}` — surface the resolved commit info

Add the new session fields to whatever this route already returns, so a user (or your report/demo) can see
exactly which commit was analyzed:

```python
{
  ...(everything already returned)...,
  "source_type": session["source_type"],
  "repo_url": session.get("repo_url"),
  "resolved_ref": session.get("resolved_ref"),
  "resolved_commit_sha": session.get("resolved_commit_sha"),
}
```

### 4.2 (Recommended, not mandatory) `DELETE /projects/{project_id}` — cleanup

GitHub-sourced projects create a real temp directory on disk (`session["download_dir"]`) that nothing currently
deletes. For a short demo/class-project lifespan this is survivable (a few dozen MB per test, cleaned up when
the machine reboots or you clear your temp folder), but it's good practice to add:

```python
import shutil

@app.delete("/projects/{project_id}")
def delete_project(project_id: str):
    session = store.get_or_404(project_id)
    download_dir = session.get("download_dir")
    if download_dir and os.path.isdir(download_dir):
        shutil.rmtree(download_dir, ignore_errors=True)
    store.delete(project_id)
    return {"deleted": project_id}
```

---

## 5. Changes to `store.py`

Just widen the session dict schema (no logic changes) to include the new optional fields from §4:
`source_type`, `repo_url`, `owner`, `repo_name`, `resolved_ref`, `resolved_commit_sha`, `download_dir`. All
default to `None` for locally-sourced projects.

---

## 6. Changes to `config.py`

Add:

```python
# ---------------------------------------------------------------------------
# GitHub URL support
# ---------------------------------------------------------------------------
MAX_REPO_DOWNLOAD_BYTES: int = 150_000_000   # refuse archives bigger than this (~150 MB)
DOWNLOAD_TIMEOUT_SECONDS: int = 60
GITHUB_API_BASE: str = "https://api.github.com"
```

`GITHUB_TOKEN` is read from the environment (not hard-coded here) — optional, but recommended, since
unauthenticated GitHub API access is capped at 60 requests/hour, and each `/projects` call with a `repo_url`
uses 2–3 of those (repo lookup, ref resolution, sometimes both). A token bumps this to 5,000/hour and is also
required if you ever want to point this at a private repo you have access to.

---

## 7. Changes to `requirements.txt`

Add one line: `requests`. Nothing else in your stack changes — no `git` binary dependency, no new heavy
libraries.

---

## 8. Manual test plan for this addendum specifically

Run these in order; each should succeed before moving to the next.

**Test 1 — smallest possible public repo, default branch, no subdir.**
Pick a small, well-known public repo (a few hundred KB, not a giant monorepo) so the download is fast, e.g. a
small personal utility repo you know the layout of. Call:
```json
{
  "repo_url": "https://github.com/<owner>/<small-repo>",
  "problem_statement": "placeholder for smoke test",
  "model": "gpt-4o-mini",
  "backend": "openai"
}
```
Check: response includes `num_python_files > 0` and a sane `tree_preview`, and `GET /projects/{id}` shows
`"source_type": "github"`, a real-looking 40-character `resolved_commit_sha`, and `"resolved_ref"` equal to
whatever that repo's actual default branch is (e.g. `"main"`).

**Test 2 — explicit branch/tag via `ref`.**
Same repo, but pass an explicit `"ref": "<some-other-branch-or-tag>"`. Check the returned `resolved_commit_sha`
differs from Test 1's (assuming that branch has diverged from default), confirming `ref` is actually being
honored and not ignored.

**Test 3 — `subdir` handling.**
Pick a repo where the real package lives under a subfolder (many do, e.g. `src/<package_name>/`), and pass that
as `"subdir"`. Check `tree_preview` shows only that subfolder's contents, not the whole repo (i.e. no `README.md`,
no `setup.py` at the top of the preview — those live one level up, outside `effective_root`).

**Test 4 — the actual Astropy case from the original spec's §13.**
Now that you don't need to hand-place files anymore, just point directly at the real repo:
```json
{
  "repo_url": "https://github.com/astropy/astropy",
  "ref": "<a commit or tag from around when the HTML-formats bug was reported>",
  "subdir": "astropy",
  "problem_statement": "<the real bug report text>",
  "ground_truth_file": "io/ascii/html.py",
  "ground_truth_elements": ["function: write", "class: HTML"],
  "model": "...", "backend": "..."
}
```
Note `ground_truth_file` is `"io/ascii/html.py"`, not `"astropy/io/ascii/html.py"` — because `subdir` was set to
`"astropy"`, that becomes the new effective root, and paths are always relative to the effective root (same rule
as before, just automatically computed now instead of something you arranged by hand). Run the full pipeline
(`/candidates` → `/file-reasoning` → `/file-ranking` → `/element-reasoning` → `/element-ranking`) and check
whether `html.py` and `function: write` surface, exactly as described in the original spec's §13.

**Test 5 — error handling.**
Deliberately pass a malformed or nonexistent `repo_url` (e.g. a typo'd repo name) and confirm you get a clean
`400` with a readable message, not a raw traceback or a `500`.

---

## 9. What did NOT change (for your write-up)

- The core RGFL mechanism (Stages 1–6 from the original spec) is byte-for-byte the same code, same prompts,
  same parsers. This addendum only changes *where the bytes on disk came from* before that mechanism runs.
- No pipeline stage was made "GitHub-aware" — `structure.py` still has no idea whether the folder it's walking
  came from your laptop or from a download five seconds ago, which is exactly the point: the seam you designed
  originally (`repo_root` as the one shared input) is what made this addition a pure addition rather than a
  refactor.
- This is a legitimate, small extension of the tool's practical usefulness (test any public GitHub bug against
  RGFL's mechanism without manually staging files), and is worth one sentence in your "future work made real"
  section of the report — it turns the original static-fixture demo idea into something that works on arbitrary
  live repositories, which was your original ambition from the very first conversation about this project.
