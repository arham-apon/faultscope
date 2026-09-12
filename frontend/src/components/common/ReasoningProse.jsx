import React, { useMemo } from "react";
import { hasCausalSignal } from "../../lib/pipeline";

/**
 * Renders model reasoning as readable prose.
 *
 * Gemini answers these prompts in Markdown even though nothing asks it to, so
 * rendering the raw string leaves `###` and `**` scattered through what is
 * supposed to be editorial body copy. This parses the small subset the models
 * actually emit — headings, bold, inline code, fenced code, and lists — and
 * returns React elements. Nothing is ever injected as HTML: the reasoning text
 * quotes source code from an arbitrary repository, so treating it as markup
 * would be handing that repository the DOM.
 *
 * Deliberately not a Markdown library. The subset is tiny, the output has to
 * match this page's typography rather than a generic stylesheet, and one more
 * dependency to render four syntaxes is a poor trade.
 */

const ERROR_PREFIX = "Error during reasoning:";

/** Split into blocks, keeping fenced code intact. */
function toBlocks(text) {
  const source = String(text || "").replace(/\r\n/g, "\n");
  const blocks = [];
  const fence = /```([\w+-]*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = fence.exec(source)) !== null) {
    if (match.index > lastIndex) {
      blocks.push({ type: "prose", value: source.slice(lastIndex, match.index) });
    }
    blocks.push({ type: "code", value: match[2].replace(/\n$/, ""), language: match[1] });
    lastIndex = fence.lastIndex;
  }

  // An unterminated fence still gets rendered as code rather than leaking ```.
  if (lastIndex < source.length) {
    blocks.push({ type: "prose", value: source.slice(lastIndex) });
  }

  return blocks;
}

/** Inline formatting: **bold**, *italic*, `code`. */
function renderInline(text, keyPrefix) {
  // Alternation order matters: **bold** must be tried before *italic*, or the
  // italic branch would claim the opening pair of a bold run. Written without a
  // lookbehind on purpose — a regex that only parses in newer engines would
  // throw at module-parse time and take the whole page down with it.
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g;
  const nodes = [];
  let lastIndex = 0;
  let match;
  let index = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${keyPrefix}-i${index++}`;

    if (token.startsWith("**")) {
      nodes.push(
        <strong key={key} className="font-medium text-primary">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith("`")) {
      nodes.push(
        <code key={key} className="bg-subtle px-1 py-0.5 font-mono text-[0.85em] text-primary">
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      nodes.push(
        <em key={key} className="italic">
          {token.slice(1, -1)}
        </em>,
      );
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

/** Group a prose block's lines into paragraphs, headings, and lists. */
function parseProse(value) {
  const groups = [];
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      groups.push({ type: "paragraph", value: paragraph.join(" ") });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      groups.push(list);
      list = null;
    }
  };

  value.split("\n").forEach((rawLine) => {
    const line = rawLine.trim();

    if (!line) {
      flushParagraph();
      flushList();
      return;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      groups.push({ type: "heading", value: heading[2].replace(/[*`]/g, "") });
      return;
    }

    // A horizontal rule is a section break; the hairline already does that job.
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flushParagraph();
      flushList();
      return;
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    const numbered = /^(\d+)[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { type: "list", ordered, items: [] };
      }
      list.items.push((bullet ? bullet[1] : numbered[2]).trim());
      return;
    }

    flushList();
    paragraph.push(line);
  });

  flushParagraph();
  flushList();
  return groups;
}

export default function ReasoningProse({ text, accentCausal = true, className = "" }) {
  const blocks = useMemo(() => toBlocks(text), [text]);
  const isError = String(text || "").startsWith(ERROR_PREFIX);

  if (!String(text || "").trim()) {
    return <p className="text-base text-muted">No reasoning was recorded.</p>;
  }

  if (isError) {
    return (
      <div className="border-l-2 border-status-error py-3 pl-4">
        <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-status-error">
          Reasoning failed for this item
        </div>
        {/* break-all: provider errors embed long unbroken URLs that would
            otherwise push the whole page sideways. */}
        <p className="max-w-prose break-all font-mono text-xs leading-relaxed text-secondary">
          {String(text).slice(ERROR_PREFIX.length).trim()}
        </p>
      </div>
    );
  }

  return (
    <div className={`space-y-5 ${className}`}>
      {blocks.map((block, blockIndex) => {
        if (block.type === "code") {
          return (
            <pre
              key={`b${blockIndex}`}
              className="overflow-x-auto border-l-2 border-hairline bg-surface px-4 py-3 font-mono text-xs leading-relaxed text-secondary"
            >
              {block.value}
            </pre>
          );
        }

        return parseProse(block.value).map((group, groupIndex) => {
          const key = `b${blockIndex}-g${groupIndex}`;

          if (group.type === "heading") {
            return (
              <h4 key={key} className="label-meta pt-2">
                {group.value}
              </h4>
            );
          }

          if (group.type === "list") {
            const ListTag = group.ordered ? "ol" : "ul";
            return (
              <ListTag key={key} className="max-w-prose space-y-2 pl-5">
                {group.items.map((item, itemIndex) => (
                  <li
                    key={`${key}-${itemIndex}`}
                    className={`break-words text-base leading-relaxed text-secondary ${
                      group.ordered ? "list-decimal" : "list-disc"
                    }`}
                  >
                    {renderInline(item, `${key}-${itemIndex}`)}
                  </li>
                ))}
              </ListTag>
            );
          }

          const causal = accentCausal && hasCausalSignal(group.value);
          return (
            <p
              key={key}
              className={`max-w-prose break-words text-base leading-relaxed ${
                causal ? "border-l-2 border-accent pl-4 text-primary" : "text-secondary"
              }`}
            >
              {renderInline(group.value, key)}
            </p>
          );
        });
      })}
    </div>
  );
}
