/**
 * A small Python tokenizer for the code viewer.
 *
 * Written by hand rather than pulled from a highlighting library for two
 * reasons: the palette here is four colours, not the eighty a general theme
 * ships with, and every library-based approach ends in
 * `dangerouslySetInnerHTML`. This returns plain token objects that React
 * renders as ordinary elements, so highlighted source can never inject markup.
 *
 * It tokenizes the whole source at once — triple-quoted strings and implicit
 * line continuations mean a line in isolation cannot be classified correctly —
 * and then splits the token stream back into lines.
 */

const KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break",
  "class", "continue", "def", "del", "elif", "else", "except", "finally",
  "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
  "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
  "match", "case", "self", "cls",
]);

const BUILTINS = new Set([
  "abs", "all", "any", "bool", "bytes", "callable", "dict", "dir", "enumerate",
  "filter", "float", "format", "frozenset", "getattr", "hasattr", "hash", "id",
  "int", "isinstance", "issubclass", "iter", "len", "list", "map", "max", "min",
  "next", "object", "open", "print", "property", "range", "repr", "reversed",
  "round", "set", "setattr", "sorted", "staticmethod", "str", "sum", "super",
  "tuple", "type", "zip", "Exception", "ValueError", "TypeError", "KeyError",
]);

const IDENTIFIER_START = /[A-Za-z_]/;
const IDENTIFIER_PART = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;

function classifyWord(word, previousWord) {
  // The name immediately after `def` or `class` is the declaration itself.
  if (previousWord === "def" || previousWord === "class") return "declaration";
  if (KEYWORDS.has(word)) return "keyword";
  if (BUILTINS.has(word)) return "builtin";
  return "plain";
}

function tokenizeSource(source) {
  const tokens = [];
  const text = String(source ?? "");
  let index = 0;
  let previousWord = null;

  const push = (type, value) => {
    if (value) tokens.push({ type, value });
  };

  while (index < text.length) {
    const char = text[index];

    // Comment: runs to end of line.
    if (char === "#") {
      let end = text.indexOf("\n", index);
      if (end === -1) end = text.length;
      push("comment", text.slice(index, end));
      index = end;
      continue;
    }

    // String literal, including prefixes (r, b, f, rb, ...) and triple quotes.
    const stringMatch = /^([rRbBuUfF]{0,3})("""|'''|"|')/.exec(text.slice(index));
    if (stringMatch) {
      const [, prefix, quote] = stringMatch;
      let cursor = index + prefix.length + quote.length;
      while (cursor < text.length) {
        if (text[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (text.startsWith(quote, cursor)) {
          cursor += quote.length;
          break;
        }
        cursor += 1;
      }
      push("string", text.slice(index, Math.min(cursor, text.length)));
      index = Math.min(cursor, text.length);
      previousWord = null;
      continue;
    }

    // Decorator: @ followed by a dotted name.
    if (char === "@" && IDENTIFIER_START.test(text[index + 1] || "")) {
      let cursor = index + 1;
      while (cursor < text.length && (IDENTIFIER_PART.test(text[cursor]) || text[cursor] === ".")) {
        cursor += 1;
      }
      push("decorator", text.slice(index, cursor));
      index = cursor;
      previousWord = null;
      continue;
    }

    // Number.
    if (DIGIT.test(char)) {
      let cursor = index;
      while (cursor < text.length && /[0-9a-fA-FxXoObB_.eE+-]/.test(text[cursor])) {
        // Stop at a sign that is arithmetic rather than part of an exponent.
        if (/[+-]/.test(text[cursor]) && !/[eE]/.test(text[cursor - 1])) break;
        cursor += 1;
      }
      push("number", text.slice(index, cursor));
      index = cursor;
      previousWord = null;
      continue;
    }

    // Word: keyword, builtin, declaration name, or plain identifier.
    if (IDENTIFIER_START.test(char)) {
      let cursor = index;
      while (cursor < text.length && IDENTIFIER_PART.test(text[cursor])) cursor += 1;
      const word = text.slice(index, cursor);
      push(classifyWord(word, previousWord), word);
      previousWord = word;
      index = cursor;
      continue;
    }

    // Anything else: punctuation, operators, whitespace, newlines.
    if (!/\s/.test(char)) previousWord = null;
    push("plain", char);
    index += 1;
  }

  return tokens;
}

/**
 * Tokenize Python source and return one array of tokens per line.
 * Non-Python input is returned as plain, unstyled lines.
 *
 * @returns {Array<Array<{type: string, value: string}>>}
 */
export function highlightPython(source, language = "python") {
  const text = String(source ?? "");

  if (language !== "python") {
    return text.split("\n").map((line) => [{ type: "plain", value: line }]);
  }

  const lines = [[]];
  tokenizeSource(text).forEach(({ type, value }) => {
    // A token can span newlines (triple-quoted strings); keep its type across them.
    const segments = value.split("\n");
    segments.forEach((segment, segmentIndex) => {
      if (segmentIndex > 0) lines.push([]);
      if (segment) lines[lines.length - 1].push({ type, value: segment });
    });
  });

  return lines;
}

/** Tailwind class per token type. Four colours plus the body tone. */
export const TOKEN_CLASSES = {
  keyword: "text-accent",
  declaration: "text-primary font-medium",
  builtin: "text-secondary",
  string: "text-emerald-700",
  number: "text-emerald-700",
  comment: "text-muted italic",
  plain: "text-primary",
};
