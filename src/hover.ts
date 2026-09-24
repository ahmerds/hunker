// Hovering a hunk shows its old and new lines as a ```diff block.
import * as vscode from 'vscode';
import type { ReviewModel } from './model';

const MAX_LINES = 60;
const COMMANDS = ['hunker.acceptHunk', 'hunker.rejectHunk', 'hunker.peekRemoved'];

export class HunkHoverProvider implements vscode.HoverProvider {
  constructor(private readonly model: ReviewModel) {}

  provideHover(doc: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    if (doc.uri.scheme !== 'file') return;
    const state = this.model.get(doc.uri.fsPath);
    if (!state) return;
    // A pure deletion past the end of the file is marked on the last line.
    const last = state.hunks.at(-1);
    const pastEnd = !!last && last.newLines.length === 0 && last.newStart >= doc.lineCount;
    const line = pastEnd && position.line === doc.lineCount - 1 ? last.newStart : position.line;
    const hunk = this.model.hunkAt(state, line, true);
    if (!hunk) return;

    const lines = [
      ...hunk.oldLines.map((l) => `-${stripCr(l)}`),
      ...hunk.newLines.map((l) => `+${stripCr(l)}`),
    ];
    const shown = lines.slice(0, MAX_LINES);
    const body = shown.join('\n');
    const fence = '`'.repeat(Math.max(3, longestBacktickRun(body) + 1));

    const md = new vscode.MarkdownString();
    md.isTrusted = { enabledCommands: COMMANDS };
    md.supportThemeIcons = true;
    md.appendMarkdown(`${fence}diff\n${body}\n${fence}\n`);
    if (lines.length > shown.length) md.appendMarkdown(`\n…${lines.length - shown.length} more\n`);
    const args = encodeURIComponent(JSON.stringify([state.path, hunk.oldStart, hunk.newStart]));
    const links = [
      `[$(check) Accept](command:hunker.acceptHunk?${args})`,
      `[$(close) Reject](command:hunker.rejectHunk?${args})`,
    ];
    if (hunk.oldLines.length > 0) links.push(`[$(eye) Show removed](command:hunker.peekRemoved?${args})`);
    md.appendMarkdown(`\n${links.join(' · ')}`);

    const start = Math.min(hunk.newStart, doc.lineCount - 1);
    const end = Math.min(hunk.newStart + Math.max(hunk.newLines.length, 1) - 1, doc.lineCount - 1);
    return new vscode.Hover(md, new vscode.Range(start, 0, end, doc.lineAt(end).text.length));
  }
}

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return longest;
}
