# RGFL-Mini: Backend Implementation Spec
### A faithful, standalone reimplementation of RGFL's core file-level + element-level localization mechanism
*(Backend only — no frontend, no patch generation, no line-level localization, no SWE-bench dataset dependency)*

---

## 0. READ THIS FIRST — instructions for the LLM implementing this

You are building a FastAPI backend service. Follow this document top to bottom, in order. Every prompt string
in this document is **copied verbatim from the real RGFL research codebase** — do not paraphrase, shorten, or
"improve" any prompt text. Every parsing function described here is also taken directly from the real codebase's
behavior — implement it exactly as specified, including the specific edge-case handling, even if it looks
unusual. Where this spec **intentionally deviates** from the original code (and there are a few deliberate,
documented deviations — search for "DEVIATION" in this document), that deviation is the correct thing to
implement, not a mistake to fix back to what the original did.

Do not invent additional pipeline stages, additional LLM calls, additional files, or additional folders beyond what
is specified here. If something seems missing, it is probably intentionally out of scope (see §1.2).

---

## 1. What we are building and why

### 1.1 The real mechanism, in plain English

The RGFL paper's actual contribution (stripped of all the SWE-bench/Agentless scaffolding around it) is a
two-step pattern, applied twice — once over whole files, once over functions/classes/globals inside the
best files:

**Step A — Reason about each candidate in isolation.** For every candidate file (or code element), ask an LLM,
one at a time: "here's a bug report, here's this one file/element, explain what it does and whether it's related
to the bug." This produces one reasoning paragraph per candidate.

**Step B — Rank using the reasoning, not the raw code.** Take ALL the reasoning paragraphs collected in Step A,
serialize them together with the original bug report, and ask the LLM once: "rank these by relevance to the bug
report." This produces an ordered list.

That's it. There is no other secret mechanism. The paper's "hierarchical reasoning module" is just this A→B
pattern run once for files and once (on the top files) for elements.

### 1.2 What we are building vs. explicitly NOT building

We ARE building:
1. A way to turn a real, user-supplied local code directory into the same kind of "project structure" object
   Agentless/RGFL use internally.
2. Agentless's own file-level LLM candidate-selection step (a single LLM call that reads the bug report + the
   repo's file tree and proposes up to N candidate files). This produces our "top-K candidate files" — the exact
   thing you said you wanted to generate dynamically instead of hardcoding.
3. RGFL's file-level reasoning + reasoning-guided reranking (Step A + Step B above, at file granularity).
4. RGFL's element-level reasoning + reasoning-guided reranking (Step A + Step B above, at function/class/global
   granularity, restricted to the top-K reranked files) — this is the stretch goal, build it after file-level
   works end-to-end.
5. Optional Hit@k / rank-position evaluation IF the user supplies a known ground-truth file — this is not in the
   original per-run scripts (those evaluate over a whole benchmark dataset), but it is a trivial, faithful
   addition: it is literally comparing the ranked list position of one string against one other string.

We are explicitly NOT building:
- Agentless's embedding-based retrieval index or its "combine/merge" step (`retrieve.py`, `combine.py` in the
  original repo). We replace this two-source retrieval with a single, simpler LLM-only candidate-selection call
  (still Agentless's own real prompt — see §4). This is a deliberate, documented scope cut, not a missing feature.
- Any Agentless "irrelevant folder filtering" LLM call (`localize_irrelevant`). Skipped because it exists only to
  make the embedding index smaller, which we don't build.
- Line-level localization (`localize_function_from_compressed_files`, `localize_function_from_raw_text`, and
  everything in `transfer_arb_locs_to_locs`). Out of scope per your instructions.
- Patch generation / patch validation / repair (`repair.py`, `rerank.py`, everything in `rgfl/test/`). Out of
  scope per your instructions.
- Any dependency on the `datasets` library or SWE-bench. The user supplies the bug report and repo directly.
- Git cloning. The user supplies an already-checked-out local directory.
- The frontend. Not covered by this document.

---

## 2. Required input contract (what the user must hand the tool)

The user provides a single input folder with exactly this shape:

```
<project_input_dir>/
├── repo/                       # REQUIRED. The actual codebase to analyze.
│                               # This can be any real Python project directory,
│                               # arbitrarily nested, containing .py files.
│                               # Non-.py files are allowed and simply ignored for
│                               # content purposes (they still appear in the tree).
└── bug_report.json             # REQUIRED. See shape below.
```

`bug_report.json` shape:

```json
{
  "instance_id": "optional-free-text-id-for-your-own-bookkeeping",
  "problem_statement": "The full natural-language bug report text. This is the ONLY field that is",
  "ground_truth_file": "optional/relative/path/from/repo/root/to/the/file.py",
  "ground_truth_elements": ["function: write", "class: HTML"]
}
```

Rules:
- `problem_statement` is required and must be non-empty. Everything else is optional.
- `ground_truth_file`, if provided, MUST be a path relative to `repo/`'s own root, using forward slashes,
  e.g. `astropy/io/ascii/html.py` if that's the path inside `repo/`. This is used only for a
  "did we rank it #1? #3? not at all?" evaluation signal, never fed to the LLM as a hint.
- `ground_truth_elements`, if provided, must use the exact `"<kind>: <name>"` format described in §6.1
  (e.g. `"function: write"`, `"class: HTML"`, `"global: DEFAULT_TIMEOUT"`), matching how our own element
  extraction names things.

**Practical limits to enforce (hard-code these as constants, expose as config):**
- Only walk files ending in `.py`. Skip everything else's *content*, but still list them in the tree (matches
  original `create_structure` behavior — see §3).
- Skip any directory literally named `.git`, `node_modules`, `__pycache__`, `.venv`, `venv`, `.tox`, `.mypy_cache`.
- Cap total number of `.py` files walked at `MAX_FILES = 800` (configurable). If exceeded, truncate and log a
  warning — do not silently hang on a huge repo.
- Cap individual file read size at `MAX_FILE_BYTES = 300_000` (~300 KB). Skip reading (treat as empty content)
  any file larger than this, but still list it in the tree.
- Read all files as UTF-8 with `errors="replace"` to avoid crashing on odd encodings.

---

## 3. Building the "structure" object (ported from `get_repo_structure/get_repo_structure.py`)

The real RGFL/Agentless codebase represents a repository as a nested Python dict called `structure`. Every
downstream stage (file listing, tree printing, candidate selection, path validation) is built on top of this one
object. We reimplement it with one deliberate simplification (see DEVIATION note below).

### 3.1 Per-file parsing (ported near-verbatim from `parse_python_file`)

For every `.py` file, parse it with Python's `ast` module and extract:
- `classes`: a list of `{"name", "start_line", "end_line", "text": [lines...], "methods": [{"name","start_line","end_line","text"} ...]}` — one entry per top-level `ast.ClassDef`, where `methods` are that class's direct `ast.FunctionDef` children.
- `functions`: a list of `{"name", "start_line", "end_line", "text": [lines...]}` — one entry per `ast.FunctionDef`
  found anywhere in the file **that is not already counted as a class method** (i.e. the same dedup rule as the
  original: track every function name seen as a class method in a `class_methods` set, and only add a
  `FunctionDef` to the top-level `functions` list if its name isn't in that set). Do not include
  `ast.AsyncFunctionDef` nodes (the original explicitly excludes them: `isinstance(node, ast.FunctionDef) and not
  isinstance(node, ast.AsyncFunctionDef)`).
- `text`: the full file content as a list of lines (`file_content.splitlines()`).

If `ast.parse` raises any exception (syntax error, encoding issue, etc.), catch it, log a warning with the
filename, and treat that file as `{"classes": [], "functions": [], "text": file_content.splitlines()}` — i.e.
still include its raw text (so it can still be reasoned about later, just with empty class/function metadata),
even though the original script has a bug here (it returns an empty string instead of a line list on error —
we fix this because it would otherwise silently break the file-content pipeline; use `file_content.splitlines()`
directly, computed before the `ast.parse` call, wrapped in its own try/except for the read).

Implementation reference (from the real source, adapt as above):

```python
import ast

def parse_python_file(file_path: str, file_content: str) -> tuple[list, list, list[str]]:
    try:
        parsed_data = ast.parse(file_content)
    except Exception as e:
        # DEVIATION from original: still return real line content on parse failure,
        # instead of the original's buggy empty string.
        return [], [], file_content.splitlines()

    class_info = []
    function_names = []
    class_methods = set()

    for node in ast.walk(parsed_data):
        if isinstance(node, ast.ClassDef):
            methods = []
            for n in node.body:
                if isinstance(n, ast.FunctionDef):
                    methods.append({
                        "name": n.name,
                        "start_line": n.lineno,
                        "end_line": n.end_lineno,
                        "text": file_content.splitlines()[n.lineno - 1 : n.end_lineno],
                    })
                    class_methods.add(n.name)
            class_info.append({
                "name": node.name,
                "start_line": node.lineno,
                "end_line": node.end_lineno,
                "text": file_content.splitlines()[node.lineno - 1 : node.end_lineno],
                "methods": methods,
            })
        elif isinstance(node, ast.FunctionDef) and not isinstance(node, ast.AsyncFunctionDef):
            if node.name not in class_methods:
                function_names.append({
                    "name": node.name,
                    "start_line": node.lineno,
                    "end_line": node.end_lineno,
                    "text": file_content.splitlines()[node.lineno - 1 : node.end_lineno],
                })

    return class_info, function_names, file_content.splitlines()
```

### 3.2 Walking the directory into a nested structure (ported from `create_structure`, with one deviation)

**DEVIATION (important, read this):** The original `create_structure(directory_path)` uses `os.path.basename(directory_path)`
as a synthetic top-level key, so every resulting file path looks like `<repo_folder_name>/sub/dir/file.py`. We
traced this through the rest of the codebase and found it is the root cause of a real bug: the reasoning stage
(`file_reasoning.py`) re-walks the repo itself with `os.path.relpath(path, repo_path)`, which does **not** include
that synthetic prefix, because in that script the repo is cloned directly into a temp directory with no extra
nesting. The result: paths produced by file-level localization (`astropy/io/ascii/html.py`) do not string-match
the paths the reasoning stage looks up locally (`io/ascii/html.py`), so in the original pipeline many files
silently fall into the `"File not found in repo"` branch.

**We fix this by using one single, consistent path convention everywhere: every file path is a POSIX-style path
relative to `repo/`'s own root, with no synthetic wrapper folder.** So if the user's `repo/` folder contains
`repo/astropy/io/ascii/html.py`, the path we use everywhere is `astropy/io/ascii/html.py` (relative to `repo/`,
not relative to some invented folder). This is functionally the same tree, just built without the
basename-duplication bug. Implement it like this:

```python
import os

SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", ".tox", ".mypy_cache"}

def create_structure(repo_root: str, max_files: int = 800, max_file_bytes: int = 300_000) -> dict:
    """
    repo_root: absolute path to the user's `repo/` folder.
    Returns a nested dict keyed by path segments RELATIVE TO repo_root (no synthetic top folder).
    Each .py file maps to {"classes": [...], "functions": [...], "text": [...]}.
    Each non-.py file maps to {} (present in the tree, but with no parsed content).
    """
    structure: dict = {}
    file_count = 0

    for root, dirs, files in os.walk(repo_root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]  # prune before descending

        relative_root = os.path.relpath(root, repo_root)
        curr = structure
        if relative_root != ".":
            for part in relative_root.split(os.sep):
                curr = curr.setdefault(part, {})

        for file_name in files:
            if file_count >= max_files:
                continue
            full_path = os.path.join(root, file_name)
            if file_name.endswith(".py"):
                try:
                    size = os.path.getsize(full_path)
                    if size > max_file_bytes:
                        curr[file_name] = {"classes": [], "functions": [], "text": []}
                    else:
                        with open(full_path, "r", encoding="utf-8", errors="replace") as f:
                            content = f.read()
                        classes, functions, lines = parse_python_file(full_path, content)
                        curr[file_name] = {"classes": classes, "functions": functions, "text": lines}
                except Exception:
                    curr[file_name] = {"classes": [], "functions": [], "text": []}
                file_count += 1
            else:
                curr[file_name] = {}

    return structure
```

### 3.3 Basic filtering (ported verbatim from `preprocess_data.py`)

Apply both of these to `structure` immediately after building it, before any LLM call:

```python
def filter_none_python(structure: dict) -> None:
    """Recursively drop dict entries that are neither a parsed .py file nor a real folder."""
    for key, value in list(structure.items()):
        is_parsed_file = (
            isinstance(value, dict)
            and "functions" in value and "classes" in value and "text" in value
            and len(value.keys()) == 3
        )
        if not is_parsed_file:
            filter_none_python(value)
            if structure[key] == {}:
                del structure[key]
        else:
            if not key.endswith(".py"):
                del structure[key]

def filter_out_test_files(structure: dict) -> None:
    """Recursively drop any key (file or folder) whose name starts with 'test'."""
    for key, value in list(structure.items()):
        if key.startswith("test"):
            del structure[key]
        elif isinstance(value, dict):
            filter_out_test_files(value)
```

Call order: `filter_none_python(structure)` then `filter_out_test_files(structure)`. This matches the original
call order in `localize.py`.

**Known quirk to be aware of (inherited on purpose, just documented):** `filter_out_test_files` deletes ANY name
starting with the literal substring `test` at every level, e.g. a folder named `testing_utils` or a file named
`test_helpers.py` used for legitimate non-test code would both get removed. This is exactly the original
behavior. Do not "fix" it — just don't be surprised when a repo with such folders loses them from the tree.

### 3.4 Flattening + pretty-printing (ported verbatim from `preprocess_data.py`)

```python
def get_full_file_paths_and_classes_and_functions(structure: dict, current_path: str = ""):
    """
    Returns (files, classes, functions):
      files: list of (path, list_of_lines) tuples for every .py file
      classes: list of {"file","name","start_line","end_line","methods"} dicts
      functions: list of {"file","name","start_line","end_line","text"} dicts
    """
    files, classes, functions = [], [], []
    for name, content in structure.items():
        if isinstance(content, dict):
            is_parsed_file = (
                "functions" in content and "classes" in content and "text" in content
                and len(content.keys()) == 3
            )
            next_path = f"{current_path}/{name}" if current_path else name
            if not is_parsed_file:
                sub_files, sub_classes, sub_functions = get_full_file_paths_and_classes_and_functions(content, next_path)
                files.extend(sub_files)
                classes.extend(sub_classes)
                functions.extend(sub_functions)
            else:
                files.append((next_path, content["text"]))
                for clazz in content["classes"]:
                    classes.append({
                        "file": next_path, "name": clazz["name"],
                        "start_line": clazz["start_line"], "end_line": clazz["end_line"],
                        "methods": [{"name": m["name"], "start_line": m["start_line"], "end_line": m["end_line"]}
                                    for m in clazz.get("methods", [])],
                    })
                for function in content["functions"]:
                    function = dict(function)
                    function["file"] = next_path
                    functions.append(function)
        else:
            next_path = f"{current_path}/{name}" if current_path else name
            files.append(next_path)
    return files, classes, functions


def show_project_structure(structure: dict, spacing: int = 0) -> str:
    """Pretty-print the tree as indented text, for use inside LLM prompts."""
    pp_string = ""
    for key, value in structure.items():
        if "." in key and not key.endswith(".py"):
            continue  # skip non-python files with extensions, matches original
        if "." in key:
            pp_string += " " * spacing + str(key) + "\n"
        else:
            pp_string += " " * spacing + str(key) + "/" + "\n"
        if isinstance(value, dict) and "classes" not in value:
            pp_string += show_project_structure(value, spacing + 4)
    return pp_string


def correct_file_paths(model_found_files: list[str], files: list) -> list[str]:
    """Keep only model-proposed paths that exactly match a real file path. Preserves model's order."""
    found_files = []
    if model_found_files:
        real_paths = {f[0] if isinstance(f, tuple) else f for f in files}
        for model_file in model_found_files:
            if model_file in real_paths:
                found_files.append(model_file)
    return found_files
```

At this point you have everything needed to print the tree, validate any file path the LLM proposes, and read
any file's raw content directly from disk (`os.path.join(repo_root, relative_path)`, using the SAME relative
path convention everywhere per the DEVIATION note in §3.2 — no extra path translation is ever needed downstream).

---

## 4. Stage 1 — Candidate file selection (ported verbatim from `rgfl/fl/FL.py`, `LLMFL.localize`)

This is Agentless's own file-level LLM localization step — a single LLM call. This is what produces your
"top-K candidate files," replacing the hardcoded static file list from the earlier plan.

**Exact prompt template (do not alter):**

```
Please look through the following GitHub problem description and Repository structure and provide a list of files that one would need to edit to fix the problem.

### GitHub Problem Description ###
{problem_statement}

###

### Repository Structure ###
{structure}

###

Please only provide the full path and return at most 5 files.
The returned files should be separated by new lines ordered by most to least important and wrapped with ```
For example:
```
file1.py
file2.py
```
```

Where `{structure}` = `show_project_structure(structure).strip()` from §3.4, and `{problem_statement}` = the
user's bug report text.

Make "at most 5 files" configurable as a parameter `top_n_candidates` (default `5`), by string-formatting that
number into the sentence instead of hard-coding "5" — e.g. `f"Please only provide the full path and return at
most {top_n_candidates} files."` This is the only text substitution you should make to this prompt; everything
else must stay exactly as written above.

**Parsing the response (ported verbatim from `FL._parse_model_return_lines` + `correct_file_paths`):**

```python
def parse_candidate_files(raw_llm_output: str, files: list) -> list[str]:
    lines = raw_llm_output.strip().split("\n") if raw_llm_output else []
    return correct_file_paths(lines, files)
```

Note exactly how this works and why it's safe: the LLM's raw output will typically include the triple-backtick
fences from the example in the prompt (e.g. a line that's just ` ``` `). Those lines simply won't match any real
file path in `correct_file_paths`, so they're automatically dropped. Do not write special backtick-stripping
logic — this is intentional, matches the original, and is simpler.

**Call parameters to use for this stage:** `temperature=0`, single sample (no retries needed for this scope).

**Output of this stage:** an ordered list of up to `top_n_candidates` real file paths (using the path convention
from §3.2), plus the raw LLM output string (keep it around for debugging/display, but it is not used again).

If the parsed list comes back empty (LLM didn't propose anything matching a real file, or repo has zero `.py`
files), stop the pipeline for this project and return a clear error — do not proceed to reasoning on an empty
candidate set.

---

## 5. Stage 2 — File-level reasoning (ported verbatim from `rgfl/fl/file_reasoning.py`)

For **every** candidate file from Stage 1 (not just the top one — all of them), call the LLM once per file with
this exact prompt:

```
A user is trying to fix a bug described in the following report:

{bug_report}

Below is a code file from a repository:

{file_content}

Explain the purpose and functionality of this code in the context of the bug report. Focus on what this file does and whether it may be related to the bug.
```

Where `{bug_report}` = `problem_statement`, and `{file_content}` = the raw file text, read directly from disk at
`os.path.join(repo_root, candidate_path)` (do NOT reconstruct it from the `structure` dict's `text` lines — read
fresh from disk, exactly like the original script does, so nothing is lost to any structure-building quirk).

If a file is larger than some reasonable prompt budget (e.g. `MAX_REASONING_FILE_CHARS = 60_000`), truncate the
content before inserting it into the prompt (append a `"\n... [truncated] ..."` marker) rather than failing the
whole request — the original script has no such guard and can genuinely blow context limits on huge files, so
this is a safe, minor, documented addition, not a deviation from the *methodology*.

Run these calls in parallel (the original uses a `ThreadPoolExecutor(max_workers=5)`; replicate that concurrency
level as a sane default, configurable).

**Output of this stage:** a dict `{file_path: reasoning_text}`, one entry per candidate file. If an individual
file's LLM call fails, store `f"Error during reasoning: {exception}"` as its value (matches original) rather than
dropping the file — Stage 3 needs an entry for every candidate, even a failed one, or ranking becomes incomparable.

---

## 6. Stage 3 — File-level reasoning-guided ranking (ported verbatim from `rgfl/fl/file_ranking.py`)

One single LLM call, given ALL of Stage 2's reasoning at once:

```
Below is a list of files from a repository and the reasonings behind the codes of these files:

{file_reasoning}

Can you rank the files based on the similarity of their reasoning to the bug report:

{bug_report}

Please just return the list of ranked files.
```

Where `{file_reasoning}` = `json.dumps(file_reasoning_dict, indent=2)` (the dict from Stage 2), and
`{bug_report}` = `problem_statement`.

**Parsing the response (ported verbatim from `file_ranking.extract_file_list`):**

```python
import re

def extract_file_list(llm_output: str) -> list[str]:
    stripped = llm_output.strip()
    if stripped.startswith("[") and stripped.endswith("]"):
        try:
            return eval(stripped)  # matches the original approach exactly
        except Exception:
            pass
    return re.findall(r"[\w\-/]+\.py", llm_output)
```

Yes, this uses `eval()` on LLM output. This is exactly what the original research code does. It is not something
you would do in a production system handling untrusted input, but it matches the source faithfully and this is a
research-reimplementation project running against LLM output you're generating yourself, not adversarial input.
State this as a known, accepted limitation in your write-up; do not silently replace it with a "safer" JSON
parser that would then behave differently from the real method being studied — if you want a safety net, add a
fallback: if `eval()` succeeds but returns something that is not a `list`, discard the result and fall through to
the regex line below.

**Output of this stage:** an ordered list of file paths — this is the final file-level ranking. Cross-reference
each item against the actual candidate set from Stage 1 (drop anything the LLM invented that wasn't a real
candidate; keep original relative order for anything valid) before returning it as the authoritative ranking.

**Optional evaluation, if `ground_truth_file` was supplied:** compute
`rank_position = ranked_list.index(ground_truth_file) + 1 if ground_truth_file in ranked_list else None`, and
`hit_at_k = {k: ground_truth_file in ranked_list[:k] for k in (1, 2, 3, 5)}`. Return these alongside the ranking.
This is a direct, tiny analogue of the paper's own Hit@k / MRR metrics (§4.2 of the paper), applied to one
instance instead of a whole benchmark — mention this explicitly in your report as the empirical hook for your
"does the paper's finding generalize beyond SWE-bench" story.

---

## 7. Stage 4 (stretch goal) — Element extraction (ported verbatim from `rgfl/fl/element_reasoning.py`)

Only run this on the **top-K files from Stage 3's ranking** (default `top_k_files_for_elements = 3`, matching
the paper's own choice — see §4.3/RQ1.1 of the paper, which explains why top-3 is used: the vast majority of
SWE-bench bugs touch a single file, and top-3 already captures nearly all of them).

For each of those files, extract code elements with `ast`:

```python
import ast

def extract_code_elements_from_file(file_content: str):
    """
    Returns (elements, source) where elements is a list of
    (kind, name, start_line, end_line) tuples, kind in {"function","class","global"}.
    """
    tree = ast.parse(file_content)
    elements = []

    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            child.parent = node  # needed so visit_Assign can check node.parent below

    class CodeVisitor(ast.NodeVisitor):
        def visit_FunctionDef(self, node):
            elements.append(("function", node.name, node.lineno, node.end_lineno))
            self.generic_visit(node)

        def visit_ClassDef(self, node):
            elements.append(("class", node.name, node.lineno, node.end_lineno))
            self.generic_visit(node)

        def visit_Assign(self, node):
            if isinstance(node.parent, ast.Module):
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        elements.append(("global", target.id, node.lineno, node.end_lineno))
            self.generic_visit(node)

    CodeVisitor().visit(tree)
    return elements, file_content


def get_source_code(element: tuple, file_source: str) -> str:
    lines = file_source.splitlines()
    return "\n".join(lines[element[2] - 1 : element[3]])
```

**Important behavior to replicate exactly (easy to get wrong):** because `generic_visit` recurses into children,
this extracts **every** `FunctionDef` and `ClassDef` anywhere in the file, not just top-level ones — this
includes methods inside classes (recorded as bare `("function", method_name, ...)`, NOT qualified with the class
name), and any nested/inner functions. `global` entries are the one exception: they are restricted to `Assign`
nodes whose immediate parent is the `Module` node itself, i.e. true module-level `x = ...` statements only. If
`ast.parse` fails for one of the top-K files, skip that file's element extraction (log a warning), do not crash
the whole request.

Naming convention for downstream use: refer to each element as the string `f"{kind}: {name}"`, e.g.
`"function: write"`, `"class: HTML"`, `"global: DEFAULT_TIMEOUT"` — this is exactly the key format Stage 5 uses
and exactly the format you should ask users to use in `ground_truth_elements` (§2).

---

## 8. Stage 5 (stretch goal) — Element-level reasoning (ported verbatim from `element_reasoning.process_file`)

For each element extracted in Stage 4 (within each of the top-K files), call the LLM once with this exact prompt:

```
A user is trying to fix a bug described in the following report:

{bug_report}

Below is a code element (a function, a class, or a global variable) in a file in a repository:

{element_code}

Explain the purpose and functionality of this code element in the context of the bug report. Focus on what this element does and whether it may be related to the bug.
```

Where `{element_code}` = `get_source_code(element, file_source)` from §7, and `{bug_report}` = `problem_statement`.

Run these in parallel per file (`ThreadPoolExecutor(max_workers=4)`, matching original), and build, for each of
the top-K files, a dict keyed by `f"{kind}: {name}"` mapping to that element's reasoning text — exactly what the
original calls `file{idx+1}_elements_reasoning`. Keep that same naming convention in your internal data model
(`file1_elements_reasoning`, `file2_elements_reasoning`, `file3_elements_reasoning`, ... up to
`top_k_files_for_elements`) so your later API responses are self-describing and match the source's own vocabulary.

---

## 9. Stage 6 (stretch goal) — Element-level ranking (ported verbatim from `element_ranking.py`)

For each of the top-K files' element-reasoning dicts (from Stage 5), one LLM call each:

```
You are provided with a list of code elements (functions, classes, and global variables) from a repository, along with an explanation of what each element does:

{file_elements_reasoning}

Also you are given the following bug report:

{bug_report}

Based on the reasoning for each code element and the bug report, which of these elements are most likely related to the bug? Please just return a ranked list of the potentially buggy elements (keys in the file_elements_reasoning dictionary) without any further explanation.
```

Where `{file_elements_reasoning}` = `json.dumps(that_files_element_reasoning_dict, indent=2)`.

**Parsing the response (ported verbatim from `element_ranking.normalize_to_list` + `postprocess_keys`):**

```python
import re
import ast

def normalize_to_list(entry: str) -> list[str]:
    def clean_item(item: str) -> str:
        item = re.sub(r'^\d+\.\s*', '', item)
        return item.strip("`'\" \t\n,")

    bad_tokens = {'[', ']', 'json', '```', '```json', ''}

    entry = entry.strip()
    entry = re.sub(r'^```.*$', '', entry, flags=re.MULTILINE)
    try:
        parsed = ast.literal_eval(entry)
        if isinstance(parsed, list):
            return [clean_item(item) for item in parsed if clean_item(item) not in bad_tokens]
    except Exception:
        pass
    lines = re.split(r'[\n,]+', entry)
    return [clean_item(line) for line in lines if clean_item(line) not in bad_tokens]


def postprocess_keys(similar_elements: list[str], elem_reasoning_dict: dict) -> list[str]:
    """Fix cases where the LLM returned a bare name ('write') instead of 'function: write'
    by matching it back against the real keys in elem_reasoning_dict."""
    corrected = []
    for s in similar_elements:
        if ':' in s:
            corrected.append(s)
        else:
            for full_key in elem_reasoning_dict.keys():
                if full_key.endswith(f": {s}"):
                    corrected.append(full_key)
                    break
    return corrected if corrected else similar_elements
```

**Output of this stage:** for each of the top-K files, an ordered list of `"<kind>: <name>"` strings representing
the reasoning-ranked elements believed most related to the bug.

**Optional evaluation, if `ground_truth_elements` was supplied:** for each ground-truth element string, check
whether it appears anywhere in the combined ranked-element lists across the top-K files, and at what position —
same spirit as the file-level Hit@k check in §6, just at element granularity (echoes the paper's Exact Match
metric from §4.2/Table 3, again applied to a single instance rather than a benchmark).

---

## 10. LLM backend wrapper (consolidated from the repeated blocks in every original script)

Every original script (`file_reasoning.py`, `file_ranking.py`, `element_reasoning.py`, `element_ranking.py`, and
`FL.py`'s model calls) repeats the same three-way branch for calling Anthropic, Gemini, or OpenAI. Consolidate
this into one function used by every stage above:

```python
import os

def call_llm(prompt: str, model: str, backend: str, max_tokens: int = 1024, temperature: float = 0.0) -> str:
    if backend == "anthropic":
        import anthropic
        client = anthropic.Anthropic()
        response = client.messages.create(
            model=model,
            max_tokens=max_tokens,
            messages=[{"role": "user", "content": prompt}],
        )
        return response.content[0].text

    elif backend == "openai":
        import openai
        client = openai.OpenAI()
        response = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
        )
        return response.choices[0].message.content

    elif backend == "gemini":
        from google import genai
        google_api_key = os.environ.get("GOOGLE_API_KEY")
        if google_api_key:
            client = genai.Client(api_key=google_api_key)
        else:
            project = os.environ.get("VERTEXAI_PROJECT", "")
            location = os.environ.get("VERTEXAI_LOCATION", "us-central1")
            client = genai.Client(vertexai=True, project=project, location=location)
        response = client.models.generate_content(model=model, contents=prompt)
        return response.text

    else:
        raise ValueError(f"Unknown backend: {backend}")
```

`backend` must be one of `"anthropic" | "openai" | "gemini"`, matching the original's `argparse` choices exactly.
`model` and `backend` should be configurable per-request (or per-project, set once at project creation) — do not
hard-code a single model. Reasonable defaults per the paper's own findings (§5.1/RQ1.1 of the paper): Gemini
2.5 Pro or Claude 4-family models performed best; `o4-mini` is a cheaper fallback. Pick any one as your service
default and expose the others as options.

Wrap every `call_llm` invocation in a `try/except`, log the error, and propagate a clear per-stage error message
rather than crashing the whole pipeline — a single failed file's reasoning call (Stage 2/5) should not prevent
the rest of the files from completing (see §5's note about storing an error string instead of dropping the file).

**Required environment variables** (only set the one(s) matching your chosen backend):
```
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GOOGLE_API_KEY=...                 # or, for Vertex AI:
GOOGLE_APPLICATION_CREDENTIALS=... # path to service account json
VERTEXAI_PROJECT=...
VERTEXAI_LOCATION=...              # e.g. us-central1
```

---

## 11. Backend project layout

```
backend/
├── main.py                    # FastAPI app + all routes (§12)
├── config.py                  # constants: MAX_FILES, MAX_FILE_BYTES, SKIP_DIRS, defaults for model/backend
├── llm.py                     # call_llm() from §10
├── structure.py                # §3: parse_python_file, create_structure, filter_none_python,
│                               #      filter_out_test_files, get_full_file_paths_and_classes_and_functions,
│                               #      show_project_structure, correct_file_paths
├── candidates.py               # §4: build_candidate_prompt, parse_candidate_files, select_candidates()
├── file_reasoning.py            # §5: generate_file_reasoning()
├── file_ranking.py              # §6: rank_files(), extract_file_list(), hit_at_k()
├── elements.py                  # §7: extract_code_elements_from_file, get_source_code
├── element_reasoning.py          # §8: generate_element_reasoning()
├── element_ranking.py            # §9: rank_elements(), normalize_to_list(), postprocess_keys()
├── store.py                     # in-memory (or simple on-disk JSON) project/session store, keyed by project_id
└── requirements.txt
```

`requirements.txt` should include: `fastapi`, `uvicorn`, `anthropic` and/or `openai` and/or `google-genai`
(whichever backend(s) you support), `pydantic`. No `datasets`, no `git`, no embedding/vector-store libraries —
none of those are used anywhere in this scope.

### Project/session store (`store.py`)

No database needed. A simple in-memory dict keyed by a generated `project_id` (uuid4) is sufficient for a 2-day
build, holding:

```python
{
  "project_id": str,
  "repo_root": str,              # absolute path to the repo/ folder
  "problem_statement": str,
  "ground_truth_file": str | None,
  "ground_truth_elements": list[str] | None,
  "model": str,
  "backend": str,
  "structure": dict | None,       # set after §3
  "files_flat": list | None,       # set after §3 (output of get_full_file_paths_and_classes_and_functions)
  "candidates": list[str] | None,  # set after §4
  "candidates_raw_output": str | None,
  "file_reasoning": dict | None,   # set after §5
  "file_ranking": list[str] | None, # set after §6
  "file_ranking_eval": dict | None, # set after §6, if ground_truth_file given
  "element_reasoning": dict | None,  # set after §8, keyed file1_elements_reasoning, file2_..., etc.
  "element_ranking": dict | None,    # set after §9, keyed similar_elements_file1, similar_elements_file2, etc.
  "element_ranking_eval": dict | None, # set after §9, if ground_truth_elements given
}
```

If you'd rather persist across server restarts for demo reliability, just serialize this dict to
`./sessions/{project_id}.json` after every stage — do not build a real database for this scope.

---

## 12. API routes

Design routes as separate stages (not one giant "run everything" call) — this matches how RGFL's own pipeline is
staged, makes each step independently testable/curl-able, and keeps you ready to wire a frontend onto these
exact stage boundaries later, even though the frontend itself is out of scope for this document.

```
POST /projects
  body: { repo_root: str (absolute path on the server), problem_statement: str,
          ground_truth_file: str|null, ground_truth_elements: list[str]|null,
          model: str, backend: "anthropic"|"openai"|"gemini" }
  -> builds `structure` (§3), applies both filters, flattens it
  -> returns { project_id, num_python_files, tree_preview (show_project_structure output) }

POST /projects/{project_id}/candidates
  body: { top_n_candidates: int = 5 }
  -> runs §4
  -> returns { candidates: [str], raw_llm_output: str }

POST /projects/{project_id}/file-reasoning
  -> runs §5 over the stored candidates
  -> returns { file_reasoning: {path: reasoning_text} }

POST /projects/{project_id}/file-ranking
  -> runs §6 over the stored file_reasoning
  -> returns { ranked_files: [str], ground_truth_rank: int|null, hit_at_k: {1:bool,2:bool,3:bool,5:bool}|null }

POST /projects/{project_id}/element-reasoning
  body: { top_k_files: int = 3 }
  -> runs §7 + §8 on the top_k_files of the stored file ranking
  -> returns { "file1_elements_reasoning": {...}, "file2_elements_reasoning": {...}, ... }

POST /projects/{project_id}/element-ranking
  -> runs §9 over the stored element_reasoning
  -> returns { "similar_elements_file1": [...], "similar_elements_file2": [...], ...,
               element_ranking_eval: {...}|null }

GET  /projects/{project_id}
  -> returns the full stored session state (useful for debugging and for a future frontend to hydrate from)
```

Each POST route must validate that its prerequisite stage has already run for that `project_id` (e.g.
`/file-ranking` requires `file_reasoning` to already be populated) and return a `409`-style error with a clear
message if not, rather than silently running on empty data.

---

## 13. Manual end-to-end test case (use this to verify correctness before calling it done)

Use the paper's own Figure 1 motivating example to sanity-check your implementation, since you already know
the expected outcome from the paper text (§1 of the paper):

- Repo: Astropy, file `astropy/io/ascii/html.py` (this is the ground-truth fault location; the ground-truth
  faulty element is `function: write` inside the `HTML` class).
- Bug report (paraphrase into your own `problem_statement`, based on the paper's description): exporting an
  astropy `Table` to HTML with a `formats` argument for column formatting is ignored — HTML output shows
  full-precision values while CSV and reStructuredText outputs correctly respect `formats`.
- Expected qualitative outcome per the paper: a plain Agentless-style pass tends to surface superficially
  related elements like `HTML.__init__` or `HTMLOutputter.__call__`; RGFL's reasoning-guided approach is
  reported to correctly surface `HTML.write` (via `class: HTML` at file granularity and `function: write` at
  element granularity) because the reasoning step explicitly traces that `HTML.write` bypasses the standard
  formatting pipeline.

To run this test: fetch the real `astropy/io/ascii/html.py` (and a couple of neighboring files, e.g.
`astropy/io/ascii/core.py`, `astropy/table/pprint.py`) at a commit around the time of this reported issue, place
them under `repo/astropy/...` matching their real repo-relative paths, write the bug report above into
`bug_report.json` with `"ground_truth_file": "astropy/io/ascii/html.py"` and
`"ground_truth_elements": ["function: write", "class: HTML"]`, and run the full pipeline end to end. You are not
required to reproduce the paper's exact numeric outcome (that depends on model choice, is why it's a research
result rather than a certainty) — you are checking that every stage runs, returns well-formed data, and that the
mechanism is at least plausible (i.e. `astropy/io/ascii/html.py` should realistically show up somewhere in the
candidate list from Stage 1, since it's directly file-name-relevant to "HTML output").

---

## 14. Summary table — faithful vs. simplified vs. fixed

| Aspect | Original RGFL/Agentless | This spec |
|---|---|---|
| File-level candidate source | LLM-based + embedding-based, merged via `combine.py` | LLM-based only (Agentless's own prompt, verbatim) — embedding retrieval intentionally cut |
| Irrelevant-folder pre-filter | Separate LLM call (`localize_irrelevant`) | Skipped — only existed to shrink the embedding index we don't build |
| File-level reasoning | Verbatim prompt, per file, threaded | Identical |
| File-level ranking | Verbatim prompt + `eval()`-based parsing | Identical, same accepted risk |
| Element extraction | `ast`-based, recursive (methods/nested defs included) | Identical |
| Element-level reasoning/ranking | Verbatim prompts | Identical |
| File path convention | Basename-prefixed in structure stage, unprefixed in reasoning stage (inconsistent — a real bug) | Single consistent convention everywhere: relative to `repo/`, no synthetic prefix (see §3.2 DEVIATION) |
| Line localization, repair, validation | Full pipeline | Out of scope entirely |
| Dataset dependency | SWE-bench via `datasets` library | None — user supplies bug report + repo directly |
| Evaluation | Hit@k / Recall@k / MRR / Exact Match over a whole benchmark (Table 2, 3) | Same metrics, computed for one instance at a time against a user-supplied ground truth, when provided |

Use this table directly in your DP-2 write-up's "what we reimplemented vs. what we simplified vs. what we fixed"
section — it is the honest, precise answer to exactly that question.
