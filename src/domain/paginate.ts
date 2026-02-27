/**
 * Word-wrap a single line to fit within maxChars, preserving leading whitespace.
 * Words longer than the effective width are broken character-by-character.
 */
export function wrapLine(line: string, maxChars: number): string[] {
  if (maxChars <= 0) {
    return [line];
  }

  if (line.length <= maxChars) {
    return [line];
  }

  const leadingWhitespace = line.match(/^\s*/)?.[0] ?? "";
  const content = line.trimStart();
  const effectiveWidth = Math.max(1, maxChars - leadingWhitespace.length);
  const words = content.split(/\s+/).filter((w) => w.length > 0);

  if (words.length === 0) {
    return [line.slice(0, maxChars)];
  }

  const wrapped: string[] = [];
  let current = "";

  const pushCurrent = (): void => {
    if (current.length > 0) {
      wrapped.push(`${leadingWhitespace}${current}`.slice(0, maxChars));
      current = "";
    }
  };

  for (const word of words) {
    // Word is longer than effective width — break it
    if (word.length > effectiveWidth) {
      pushCurrent();
      let remaining = word;
      while (remaining.length > effectiveWidth) {
        wrapped.push(`${leadingWhitespace}${remaining.slice(0, effectiveWidth)}`);
        remaining = remaining.slice(effectiveWidth);
      }
      current = remaining;
      continue;
    }

    if (current.length === 0) {
      current = word;
      continue;
    }

    if (current.length + 1 + word.length <= effectiveWidth) {
      current = `${current} ${word}`;
      continue;
    }

    pushCurrent();
    current = word;
  }

  pushCurrent();
  return wrapped.length > 0 ? wrapped : [""];
}

/**
 * Word-wrap an array of lines.
 */
export function wrapLines(lines: string[], maxChars: number): string[] {
  const wrapped: string[] = [];
  for (const line of lines) {
    wrapped.push(...wrapLine(line, maxChars));
  }
  return wrapped.length > 0 ? wrapped : [""];
}

/**
 * Split wrapped lines into pages of linesPerPage each.
 */
export function paginate(
  wrappedLines: string[],
  linesPerPage: number,
): string[][] {
  if (linesPerPage <= 0 || wrappedLines.length === 0) {
    return [wrappedLines];
  }

  const pages: string[][] = [];
  for (let i = 0; i < wrappedLines.length; i += linesPerPage) {
    pages.push(wrappedLines.slice(i, i + linesPerPage));
  }

  return pages.length > 0 ? pages : [[""]];
}

/**
 * Get the display text for a specific page, joining lines with newlines.
 * Pads with empty lines if the page is shorter than linesPerPage.
 */
export function getPageText(
  pages: string[][],
  index: number,
  linesPerPage: number,
): string {
  const safeIndex = Math.max(0, Math.min(index, pages.length - 1));
  const page = pages[safeIndex] ?? [""];
  const padded = [...page];
  while (padded.length < linesPerPage) {
    padded.push("");
  }
  return padded.join("\n");
}
