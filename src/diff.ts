// Pure text operations: hunks between a baseline and the current text, and
// accept/reject on single hunks. No vscode imports, so it can be unit-tested.
import { diffArrays } from 'diff';

export interface Hunk {
  /** 0-based line in the baseline where the hunk starts. */
  oldStart: number;
  oldLines: string[];
  /** 0-based line in the current text where the hunk starts. */
  newStart: number;
  newLines: string[];
}

/**
 * Splits on '\n' only, so '\r' stays on the line (CRLF survives a round
 * trip) and `joinLines(splitLines(t)) === t`. The empty text has no lines.
 * Indices line up with VS Code's document line numbers.
 */
export function splitLines(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}

export function joinLines(lines: string[]): string {
  return lines.join('\n');
}

export function computeHunks(oldText: string, newText: string): Hunk[] {
  if (oldText === newText) return [];
  const parts = diffArrays(splitLines(oldText), splitLines(newText));
  const hunks: Hunk[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  let current: Hunk | undefined;
  for (const part of parts) {
    const count = part.value.length;
    if (part.added || part.removed) {
      current ??= { oldStart: oldIndex, oldLines: [], newStart: newIndex, newLines: [] };
      if (part.added) {
        current.newLines.push(...part.value);
        newIndex += count;
      } else {
        current.oldLines.push(...part.value);
        oldIndex += count;
      }
    } else {
      if (current) hunks.push(current);
      current = undefined;
      oldIndex += count;
      newIndex += count;
    }
  }
  if (current) hunks.push(current);
  return hunks;
}

/** New baseline after accepting `hunk`. */
export function acceptHunk(baseline: string, hunk: Hunk): string {
  const lines = splitLines(baseline);
  lines.splice(hunk.oldStart, hunk.oldLines.length, ...hunk.newLines);
  return joinLines(lines);
}

/** New current text after rejecting `hunk`. */
export function rejectHunk(current: string, hunk: Hunk): string {
  const lines = splitLines(current);
  lines.splice(hunk.newStart, hunk.newLines.length, ...hunk.oldLines);
  return joinLines(lines);
}

export interface TextEdit {
  /** Offset range in `from` to replace. */
  start: number;
  end: number;
  text: string;
}

/** Smallest single replacement that turns `from` into `to`. */
export function minimalEdit(from: string, to: string): TextEdit {
  let prefix = 0;
  const max = Math.min(from.length, to.length);
  while (prefix < max && from.charCodeAt(prefix) === to.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    from.charCodeAt(from.length - 1 - suffix) === to.charCodeAt(to.length - 1 - suffix)
  ) {
    suffix++;
  }
  // Don't split a CRLF pair or a surrogate pair at either edge.
  const splits = (s: string, i: number) =>
    i > 0 && i < s.length &&
    ((s[i - 1] === '\r' && s[i] === '\n') || isHighSurrogate(s.charCodeAt(i - 1)));
  while (prefix > 0 && (splits(from, prefix) || splits(to, prefix))) prefix--;
  while (suffix > 0 && (splits(from, from.length - suffix) || splits(to, to.length - suffix))) suffix--;
  return { start: prefix, end: from.length - suffix, text: to.slice(prefix, to.length - suffix) };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Number of lines a hunk covers in the current text (a pure deletion covers its marker line). */
export function hunkSpan(hunk: Hunk): number {
  return Math.max(hunk.newLines.length, 1);
}

/** Line the hunk's CodeLens and deletion marker sit on, clamped to the document. */
export function anchorLine(hunk: Hunk, lineCount: number): number {
  return Math.max(0, Math.min(hunk.newStart, lineCount - 1));
}

/**
 * Line the removed-lines inset is drawn below, so it sits just above the
 * hunk's new lines. -1 puts it above the first line; a deletion past the end
 * of the file goes below the last line.
 */
export function insetLine(hunk: Hunk, lineCount: number): number {
  return Math.min(hunk.newStart, lineCount) - 1;
}
