"""Resolve a public GitHub repository URL to a pinned local source directory."""

from __future__ import annotations

import io
import os
import re
import shutil
import tarfile
import tempfile
from typing import Optional

import requests

from config import (
    DOWNLOAD_TIMEOUT_SECONDS,
    GITHUB_API_BASE,
    MAX_REPO_DOWNLOAD_BYTES,
)


def parse_github_url(repo_url: str) -> tuple[str, str, Optional[str], str]:
    """Return ``(owner, repo, ref_from_url, subdir_from_url)`` for a GitHub URL.

    Supported inputs are ``https://github.com/owner/repo`` (optionally ending
    in ``.git``), a GitHub ``/tree/<ref>[/subdir]`` URL, and ``owner/repo``
    shorthand.  Tree URLs intentionally do not infer refs containing slashes;
    callers should supply those through the explicit ``ref`` field.
    """
    url = repo_url.strip().rstrip("/")
    url = re.sub(r"^https?://(www\.)?github\.com/", "", url, flags=re.IGNORECASE)
    url = url.removesuffix(".git")

    parts = url.split("/")
    if len(parts) < 2 or not parts[0] or not parts[1]:
        raise ValueError(f"Could not parse a GitHub owner/repo from: {repo_url!r}")

    owner, repo = parts[0], parts[1]
    if any(part in ("", ".", "..") for part in (owner, repo)):
        raise ValueError(f"Could not parse a GitHub owner/repo from: {repo_url!r}")

    ref: Optional[str] = None
    subdir = ""
    if len(parts) > 2 and parts[2] == "tree" and len(parts) > 3:
        ref = parts[3]
        if len(parts) > 4:
            subdir = "/".join(parts[4:])

    return owner, repo, ref, subdir


def resolve_source_params(
    repo_url: str,
    ref_override: Optional[str],
    subdir_override: Optional[str],
) -> tuple[str, str, Optional[str], str]:
    """Combine parsed URL fields with explicit request fields (which win)."""
    owner, repo, ref_from_url, subdir_from_url = parse_github_url(repo_url)
    ref = ref_override or ref_from_url
    subdir = subdir_override if subdir_override else subdir_from_url
    return owner, repo, ref, subdir


def _auth_headers(github_token: Optional[str]) -> dict[str, str]:
    token = github_token or os.environ.get("GITHUB_TOKEN")
    headers = {"Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def get_default_branch(owner: str, repo: str, github_token: Optional[str]) -> str:
    """Look up a repository's default branch through the GitHub API."""
    response = requests.get(
        f"{GITHUB_API_BASE}/repos/{owner}/{repo}",
        headers=_auth_headers(github_token),
        timeout=15,
    )
    if response.status_code == 404:
        raise ValueError(f"GitHub repo not found: {owner}/{repo} (is it public? typo?)")
    response.raise_for_status()
    return response.json()["default_branch"]


def resolve_ref_to_sha(
    owner: str, repo: str, ref: str, github_token: Optional[str]
) -> str:
    """Resolve a branch, tag, or SHA to an immutable commit SHA."""
    response = requests.get(
        f"{GITHUB_API_BASE}/repos/{owner}/{repo}/commits/{ref}",
        headers=_auth_headers(github_token),
        timeout=15,
    )
    if response.status_code == 404:
        raise ValueError(
            f"Could not resolve ref {ref!r} on {owner}/{repo} — "
            "check the branch/tag/commit exists."
        )
    if response.status_code == 403:
        raise ValueError(
            "GitHub API rate limit hit (60 requests/hour unauthenticated). "
            "Set the GITHUB_TOKEN environment variable to raise this to 5000/hour."
        )
    response.raise_for_status()
    return response.json()["sha"]


def _safe_extract(tar: tarfile.TarFile, destination: str) -> None:
    """Extract an untrusted archive with Python-version compatible filtering."""
    try:
        tar.extractall(destination, filter="data")
    except TypeError:  # Python < 3.12 has no ``data`` extraction filter.
        tar.extractall(destination, filter="tar")


def download_and_extract(
    owner: str,
    repo: str,
    sha: str,
    github_token: Optional[str],
    dest_parent: str,
) -> str:
    """Download one commit tarball and return its sole extracted top directory."""
    response = requests.get(
        f"{GITHUB_API_BASE}/repos/{owner}/{repo}/tarball/{sha}",
        headers=_auth_headers(github_token),
        stream=True,
        timeout=DOWNLOAD_TIMEOUT_SECONDS,
        allow_redirects=True,
    )
    response.raise_for_status()

    content_length = response.headers.get("Content-Length")
    if content_length and int(content_length) > MAX_REPO_DOWNLOAD_BYTES:
        raise ValueError(
            f"Repo archive is {int(content_length) / 1e6:.0f} MB, exceeding the "
            f"{MAX_REPO_DOWNLOAD_BYTES / 1e6:.0f} MB limit for this tool."
        )

    buffer = io.BytesIO()
    downloaded = 0
    for chunk in response.iter_content(chunk_size=1 << 20):
        if not chunk:
            continue
        downloaded += len(chunk)
        if downloaded > MAX_REPO_DOWNLOAD_BYTES:
            raise ValueError("Repo archive exceeded the size limit mid-download; aborting.")
        buffer.write(chunk)
    buffer.seek(0)

    with tarfile.open(fileobj=buffer, mode="r:gz") as tar:
        _safe_extract(tar, dest_parent)

    extracted_entries = [
        entry
        for entry in os.listdir(dest_parent)
        if os.path.isdir(os.path.join(dest_parent, entry))
    ]
    if len(extracted_entries) != 1:
        raise RuntimeError(
            "Expected exactly one top-level folder after extraction, found "
            f"{len(extracted_entries)}: {extracted_entries}"
        )
    return os.path.join(dest_parent, extracted_entries[0])


def get_repo_source(
    repo_url: str,
    ref: Optional[str],
    subdir: Optional[str],
    github_token: Optional[str],
) -> dict[str, str]:
    """Download a pinned GitHub source tree and describe its local location."""
    owner, repo, ref_final, subdir_final = resolve_source_params(repo_url, ref, subdir)
    ref_display = ref_final or "(default branch)"
    if ref_final is None:
        ref_final = get_default_branch(owner, repo, github_token)

    sha = resolve_ref_to_sha(owner, repo, ref_final, github_token)
    download_dir = tempfile.mkdtemp(prefix="rgfl_mini_")
    try:
        extracted_root = download_and_extract(owner, repo, sha, github_token, download_dir)
        effective_root = os.path.abspath(
            os.path.join(extracted_root, subdir_final) if subdir_final else extracted_root
        )
        # ``subdir`` is request input, so it must stay inside the extracted
        # checkout even if it contains traversal components.
        if os.path.commonpath([os.path.abspath(extracted_root), effective_root]) != os.path.abspath(extracted_root):
            raise ValueError("`subdir` must point inside the downloaded repository.")
        if not os.path.isdir(effective_root):
            raise ValueError(
                f"`subdir` {subdir_final!r} does not exist inside the downloaded repo. "
                f"Top-level contents were: {os.listdir(extracted_root)}"
            )
    except Exception:
        shutil.rmtree(download_dir, ignore_errors=True)
        raise

    return {
        "effective_root": effective_root,
        "download_dir": download_dir,
        "owner": owner,
        "repo": repo,
        "resolved_ref": ref_display,
        "resolved_commit_sha": sha,
    }
