// Notes are untrusted and the Markdown parser recurses once per nesting level, so a few KB of
// ">>>>>…" or "- - - …" overflows the JS stack while rendering. Inputs past these limits are
// shown as plain text instead of being parsed.
export const MAX_MARKDOWN_CHARS = 64_000;
export const MAX_BLOCK_NESTING = 100;

// Block-quote / list markers stacked at the start of a line, counted without a regex so the
// check stays linear. ">" nests on its own; list bullets and "1." need a following space or tab,
// which keeps "-----" and "*****" (thematic breaks) from counting.
const lineNesting = (line: string): number => {
  let depth = 0;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === " " || ch === "\t") {
      i += 1;
    } else if (ch === ">") {
      depth += 1;
      i += 1;
    } else if (ch === "*" || ch === "+" || ch === "-") {
      const next = line[i + 1];
      if (next !== " " && next !== "\t") break;
      depth += 1;
      i += 1;
    } else if (ch >= "0" && ch <= "9") {
      let j = i;
      while (j < line.length && line[j] >= "0" && line[j] <= "9") j += 1;
      const delimiter = line[j];
      const next = line[j + 1];
      if ((delimiter !== "." && delimiter !== ")") || (next !== " " && next !== "\t")) break;
      depth += 1;
      i = j + 1;
    } else {
      break;
    }
    if (depth > MAX_BLOCK_NESTING) return depth;
  }
  return depth;
};

// True when the note is too big or too deeply nested to parse safely.
export function exceedsMarkdownLimits(source: string): boolean {
  if (source.length > MAX_MARKDOWN_CHARS) return true;
  for (const line of source.split("\n")) {
    if (lineNesting(line) > MAX_BLOCK_NESTING) return true;
  }
  return false;
}
