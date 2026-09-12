import React, { useMemo, useState } from "react";
import { highlightPython, TOKEN_CLASSES } from "../../lib/highlight";

/**
 * Line-numbered source viewer.
 *
 * Highlighting is done by our own tokenizer (lib/highlight.js) and rendered as
 * React elements, so no markup from the analyzed repository can reach the DOM
 * as HTML.
 */
export default function CodeViewer({
  code = "",
  startLine = 1,
  language = "python",
  filePath,
  maxHeight = "32rem",
}) {
  const [copied, setCopied] = useState(false);
  const lines = useMemo(() => highlightPython(code, language), [code, language]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied; the code is selectable either way.
    }
  };

  const gutterWidth = `${String(startLine + lines.length).length + 1}ch`;

  return (
    <div className="border border-hairline bg-surface">
      <div className="flex items-center justify-between gap-4 border-b border-hairline bg-subtle/50 px-4 py-2 font-mono text-[11px] text-muted">
        <span className="truncate" title={filePath || language}>
          {filePath || language.toUpperCase()}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="shrink-0 uppercase tracking-[0.14em] transition-colors hover:text-primary"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <div className="overflow-auto p-4 font-mono text-sm" style={{ maxHeight }}>
        {lines.map((tokens, index) => (
          // eslint-disable-next-line react/no-array-index-key -- line order is stable
          <div key={index} className="flex hover:bg-subtle/40">
            <span
              className="shrink-0 select-none pr-4 text-right text-xs leading-relaxed text-muted/70"
              style={{ width: gutterWidth }}
            >
              {startLine + index}
            </span>
            <code className="whitespace-pre leading-relaxed">
              {tokens.length === 0 ? (
                " "
              ) : (
                tokens.map((token, tokenIndex) => (
                  // eslint-disable-next-line react/no-array-index-key -- token order is stable
                  <span key={tokenIndex} className={TOKEN_CLASSES[token.type] || TOKEN_CLASSES.plain}>
                    {token.value}
                  </span>
                ))
              )}
            </code>
          </div>
        ))}
      </div>
    </div>
  );
}
