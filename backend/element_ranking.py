"""
element_ranking.py — Stage 6: Element-level ranking (§9).

Ported verbatim from rgfl/fl/element_ranking.py.

For each of the top-K files' element-reasoning dicts (from Stage 5), one LLM
call ranks which elements are most likely related to the bug.

The prompt text and both parsing functions are copied verbatim from the real
RGFL research codebase.
"""

from __future__ import annotations

import ast
import json
import logging
import re

from llm import call_llm

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Prompt template — verbatim from element_ranking.py (§9). Do NOT alter.
# ---------------------------------------------------------------------------
_ELEMENT_RANKING_PROMPT_TEMPLATE = """\
You are provided with a list of code elements (functions, classes, and global variables) from a repository, along with an explanation of what each element does:

{file_elements_reasoning}

Also you are given the following bug report:

{bug_report}

Based on the reasoning for each code element and the bug report, which of these elements are most likely related to the bug? Please just return a ranked list of the potentially buggy elements (keys in the file_elements_reasoning dictionary) without any further explanation.
"""


# ---------------------------------------------------------------------------
# Parsing helpers — verbatim from element_ranking.normalize_to_list +
#                   element_ranking.postprocess_keys (§9)
# ---------------------------------------------------------------------------

def normalize_to_list(entry: str) -> list[str]:
    """
    Parse the LLM's element-ranking response into a plain list of strings.

    Strategy (verbatim from original):
    1. Strip markdown code fences, then try ast.literal_eval on the result.
       If it evaluates to a list, clean each item and return.
    2. Otherwise, split on newlines/commas and clean each item.

    'Clean' means: strip leading numbering (e.g. "1. "), strip surrounding
    backticks/quotes/spaces/commas/newlines, and drop known bad tokens.
    """
    def clean_item(item: str) -> str:
        item = re.sub(r'^\d+\.\s*', '', item)
        return item.strip("`'\" \t\n,")

    bad_tokens = {'[', ']', 'json', '```', '```json', ''}

    entry = entry.strip()
    entry = re.sub(r'^```.*$', '', entry, flags=re.MULTILINE)

    try:
        parsed = ast.literal_eval(entry)
        if isinstance(parsed, list):
            return [
                clean_item(item)
                for item in parsed
                if clean_item(item) not in bad_tokens
            ]
    except Exception:
        pass

    lines = re.split(r'[\n,]+', entry)
    return [
        clean_item(line)
        for line in lines
        if clean_item(line) not in bad_tokens
    ]


def postprocess_keys(
    similar_elements: list[str],
    elem_reasoning_dict: dict[str, str],
) -> list[str]:
    """
    Fix cases where the LLM returned a bare name ('write') instead of the
    full key ('function: write') by matching it back against the real dict keys.

    If no corrections can be made at all, returns the original list unchanged.
    (Verbatim from original — do not alter the fallback behaviour.)
    """
    corrected: list[str] = []
    for s in similar_elements:
        if ':' in s:
            corrected.append(s)
        else:
            for full_key in elem_reasoning_dict.keys():
                if full_key.endswith(f": {s}"):
                    corrected.append(full_key)
                    break
    return corrected if corrected else similar_elements


# ---------------------------------------------------------------------------
# Element-level evaluation helper (§9 optional evaluation)
# ---------------------------------------------------------------------------

def element_hit_at_k(
    all_ranked_elements: dict[str, list[str]],
    ground_truth_elements: list[str] | None,
) -> dict | None:
    """
    Compute element-level Hit@k analogous to the file-level check in §6.

    For each ground-truth element, checks whether it appears in the combined
    ranked-element lists across all top-K files (echoes the paper's Exact Match
    metric from §4.2 / Table 3, applied to one instance).

    Args:
        all_ranked_elements: {similar_elements_file1: [...], ...} from Stage 6.
        ground_truth_elements: list of "<kind>: <name>" strings, or None.

    Returns:
        None if no ground truth was provided.
        Otherwise a dict mapping each ground-truth element to its evaluation:
          {
            "<elem>": {
              "found": bool,
              "file_key": str | None,      # which file's list it appears in
              "position": int | None        # 1-indexed position within that file's list
            }
          }
    """
    if not ground_truth_elements:
        return None

    # Flatten all ranked lists for lookup
    evaluation: dict[str, dict] = {}

    for gt_elem in ground_truth_elements:
        found = False
        found_file_key: str | None = None
        position: int | None = None

        for file_key, ranked_list in all_ranked_elements.items():
            if gt_elem in ranked_list:
                found = True
                found_file_key = file_key
                position = ranked_list.index(gt_elem) + 1
                break

        evaluation[gt_elem] = {
            "found": found,
            "file_key": found_file_key,
            "position": position,
        }

    return evaluation


# ---------------------------------------------------------------------------
# Main stage function
# ---------------------------------------------------------------------------

def rank_elements(
    elem_reasoning_dict: dict[str, str],
    problem_statement: str,
    model: str,
    backend: str,
) -> list[str]:
    """
    Run Stage 6 for one file: one LLM call to rank its elements by bug relevance.

    Args:
        elem_reasoning_dict: {element_key: reasoning_text} for one file.
        problem_statement:   Bug report text.
        model:               LLM model identifier.
        backend:             LLM backend name.

    Returns:
        Ordered list of "<kind>: <name>" strings (may be a subset of the input
        keys if the LLM omits some).

    Raises:
        Any exception from call_llm — caller handles.
    """
    file_elements_reasoning_json = json.dumps(elem_reasoning_dict, indent=2)

    prompt = _ELEMENT_RANKING_PROMPT_TEMPLATE.format(
        file_elements_reasoning=file_elements_reasoning_json,
        bug_report=problem_statement,
    )

    raw_output = call_llm(prompt, model=model, backend=backend, temperature=0.0)

    similar_elements = normalize_to_list(raw_output)
    similar_elements = postprocess_keys(similar_elements, elem_reasoning_dict)

    return similar_elements


def rank_all_files_elements(
    element_reasoning: dict[str, dict[str, str]],
    problem_statement: str,
    model: str,
    backend: str,
) -> dict[str, list[str]]:
    """
    Run Stage 6 for every file in the element_reasoning dict.

    element_reasoning keys are "file1_elements_reasoning", "file2_elements_reasoning", etc.
    Output keys are "similar_elements_file1", "similar_elements_file2", etc. — matching
    the naming convention in the original source and the spec (§9).

    On LLM call failure for an individual file, stores an empty list and logs a warning.
    """
    output: dict[str, list[str]] = {}

    for file_reasoning_key, elem_dict in element_reasoning.items():
        # "file1_elements_reasoning" -> "similar_elements_file1"
        # Extract the index digit(s) from the key name.
        idx_str = file_reasoning_key.replace("file", "").replace("_elements_reasoning", "")
        out_key = f"similar_elements_file{idx_str}"

        if not elem_dict:
            logger.info("No elements to rank for %s", file_reasoning_key)
            output[out_key] = []
            continue

        logger.info("Stage 6: ranking elements for %s", file_reasoning_key)
        try:
            ranked = rank_elements(elem_dict, problem_statement, model, backend)
            output[out_key] = ranked
        except Exception as exc:
            logger.warning(
                "Element ranking LLM call failed for %s: %s", file_reasoning_key, exc
            )
            output[out_key] = []

    return output
