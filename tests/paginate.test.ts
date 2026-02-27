import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { wrapLine, wrapLines, paginate, getPageText } from "../src/domain/paginate";

describe("wrapLine", () => {
  it("returns line unchanged if it fits", () => {
    assert.deepEqual(wrapLine("hello", 10), ["hello"]);
  });

  it("wraps a long line at word boundaries", () => {
    const result = wrapLine("hello world foo", 10);
    assert.deepEqual(result, ["hello", "world foo"]);
  });

  it("breaks words longer than max width", () => {
    const result = wrapLine("abcdefghij", 5);
    assert.deepEqual(result, ["abcde", "fghij"]);
  });

  it("preserves leading whitespace", () => {
    const result = wrapLine("  hello world", 10);
    assert.deepEqual(result, ["  hello", "  world"]);
  });

  it("handles empty line", () => {
    assert.deepEqual(wrapLine("", 10), [""]);
  });

  it("handles maxChars <= 0", () => {
    assert.deepEqual(wrapLine("test", 0), ["test"]);
  });
});

describe("wrapLines", () => {
  it("wraps multiple lines", () => {
    const result = wrapLines(["hello world", "foo bar"], 8);
    assert.deepEqual(result, ["hello", "world", "foo bar"]);
  });

  it("returns [''] for empty input", () => {
    assert.deepEqual(wrapLines([], 10), [""]);
  });
});

describe("paginate", () => {
  it("splits lines into pages", () => {
    const lines = ["a", "b", "c", "d", "e"];
    const pages = paginate(lines, 2);
    assert.deepEqual(pages, [["a", "b"], ["c", "d"], ["e"]]);
  });

  it("returns single page when lines fit", () => {
    const lines = ["a", "b"];
    const pages = paginate(lines, 5);
    assert.deepEqual(pages, [["a", "b"]]);
  });

  it("handles empty input", () => {
    const pages = paginate([], 5);
    assert.deepEqual(pages, [[]]);
  });
});

describe("getPageText", () => {
  it("pads short pages", () => {
    const pages = [["a", "b"]];
    const text = getPageText(pages, 0, 4);
    assert.equal(text, "a\nb\n\n");
  });

  it("clamps out-of-range index", () => {
    const pages = [["a"], ["b"]];
    const text = getPageText(pages, 10, 1);
    assert.equal(text, "b");
  });
});
