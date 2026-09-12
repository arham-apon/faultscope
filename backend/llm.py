"""
llm.py — Unified LLM backend wrapper (§10).

Consolidated from the repeated three-way branch in the original scripts
(file_reasoning.py, file_ranking.py, element_reasoning.py, element_ranking.py, FL.py).

Supports: anthropic | openai | gemini
"""

from __future__ import annotations

import os


def call_llm(
    prompt: str,
    model: str,
    backend: str,
    max_tokens: int = 1024,
    temperature: float = 0.0,
) -> str:
    """
    Call the specified LLM backend with a single user prompt.

    Args:
        prompt:      The full prompt string to send.
        model:       Model identifier (e.g. "claude-sonnet-4-5", "gpt-4o", "gemini-2.5-pro").
        backend:     One of "anthropic", "openai", "gemini".
        max_tokens:  Maximum tokens in the response.
        temperature: Sampling temperature (0.0 = deterministic).

    Returns:
        The model's response text as a plain string.

    Raises:
        ValueError:  For an unknown backend string.
        Any exception from the underlying SDK is propagated — callers must wrap in try/except.
    """
    if backend == "anthropic":
        import anthropic  # type: ignore[import]

        client = anthropic.Anthropic()
        response = client.messages.create(
            model=model,
            max_tokens=max_tokens,
            messages=[{"role": "user", "content": prompt}],
        )
        return response.content[0].text

    elif backend == "openai":
        import openai  # type: ignore[import]

        client = openai.OpenAI()
        response = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=temperature,
            max_tokens=max_tokens,
        )
        return response.choices[0].message.content

    elif backend == "gemini":
        from google import genai  # type: ignore[import]

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
        raise ValueError(
            f"Unknown backend: {backend!r}. Must be one of 'anthropic', 'openai', 'gemini'."
        )
