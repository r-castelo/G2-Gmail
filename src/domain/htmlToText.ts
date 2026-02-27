/**
 * Convert HTML email body to plain text lines suitable for the G2 display.
 *
 * Uses DOMParser (available in WebView) rather than regex.
 * Handles block elements, entity decoding, and ASCII filtering.
 */

/** Block-level elements that should produce line breaks. */
const BLOCK_TAGS = new Set([
  "P", "DIV", "BR", "HR", "H1", "H2", "H3", "H4", "H5", "H6",
  "LI", "OL", "UL", "TABLE", "TR", "BLOCKQUOTE", "PRE", "SECTION",
  "ARTICLE", "HEADER", "FOOTER", "NAV", "ASIDE", "DT", "DD",
]);

/** Tags whose content should be stripped entirely. */
const STRIP_TAGS = new Set(["SCRIPT", "STYLE", "HEAD", "SVG", "NOSCRIPT"]);

/**
 * Replace non-ASCII characters that the G2 monochrome display can't render.
 * Keeps printable ASCII (0x20-0x7E) and tab.
 */
function stripNonAscii(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[^\x09\x20-\x7E]/g, "");
}

/**
 * Collapse consecutive blank lines into at most one.
 */
function collapseBlankLines(lines: string[]): string[] {
  const result: string[] = [];
  let prevBlank = false;

  for (const line of lines) {
    const trimmed = line.trimEnd();
    const isBlank = trimmed.trim().length === 0;

    if (isBlank) {
      if (!prevBlank) {
        result.push("");
      }
      prevBlank = true;
      continue;
    }

    prevBlank = false;
    result.push(trimmed);
  }

  // Trim leading/trailing blanks
  while (result[0] === "") {
    result.shift();
  }
  while (result[result.length - 1] === "") {
    result.pop();
  }

  return result;
}

/**
 * Recursively extract text from a DOM node, inserting newlines for block elements.
 */
function extractText(node: Node, output: string[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? "";
    // Collapse whitespace within text nodes
    const normalized = text.replace(/\s+/g, " ");
    if (normalized.trim().length > 0) {
      output.push(normalized);
    }
    return;
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return;
  }

  const el = node as Element;
  const tagName = el.tagName;

  // Skip stripped tags entirely
  if (STRIP_TAGS.has(tagName)) {
    return;
  }

  const isBlock = BLOCK_TAGS.has(tagName);

  // Insert newline before block element
  if (isBlock) {
    output.push("\n");
  }

  // Handle BR specially
  if (tagName === "BR") {
    output.push("\n");
    return;
  }

  // Handle HR as a separator
  if (tagName === "HR") {
    output.push("\n---\n");
    return;
  }

  // Handle list items with bullet
  if (tagName === "LI") {
    output.push("\n- ");
    for (const child of el.childNodes) {
      extractText(child, output);
    }
    return;
  }

  // Recurse into children
  for (const child of el.childNodes) {
    extractText(child, output);
  }

  // Insert newline after block element
  if (isBlock) {
    output.push("\n");
  }
}

/**
 * Convert an HTML email body to an array of plain text lines.
 *
 * @param html - Raw HTML string from the email body
 * @param plainFallback - Optional plain text body to use if HTML parsing yields nothing
 * @returns Array of plain text lines ready for word-wrapping and pagination
 */
export function htmlToPlainText(html: string, plainFallback?: string): string[] {
  // If no HTML, fall back to plain text
  if (!html || html.trim().length === 0) {
    if (plainFallback && plainFallback.trim().length > 0) {
      const lines = plainFallback.replace(/\r\n?/g, "\n").split("\n");
      return collapseBlankLines(lines.map((l) => stripNonAscii(l)));
    }
    return ["(empty)"];
  }

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    const parts: string[] = [];
    extractText(doc.body, parts);

    const rawText = parts.join("");
    const lines = rawText.split("\n").map((line) => stripNonAscii(line.trim()));
    const collapsed = collapseBlankLines(lines);

    if (collapsed.length === 0 || (collapsed.length === 1 && collapsed[0] === "")) {
      // HTML parsed but produced no text — try plain fallback
      if (plainFallback && plainFallback.trim().length > 0) {
        const fallbackLines = plainFallback.replace(/\r\n?/g, "\n").split("\n");
        return collapseBlankLines(fallbackLines.map((l) => stripNonAscii(l)));
      }
      return ["(empty)"];
    }

    return collapsed;
  } catch {
    // DOMParser failed — try plain fallback
    if (plainFallback && plainFallback.trim().length > 0) {
      const lines = plainFallback.replace(/\r\n?/g, "\n").split("\n");
      return collapseBlankLines(lines.map((l) => stripNonAscii(l)));
    }
    return ["(empty)"];
  }
}
