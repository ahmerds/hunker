// Removed lines drawn between the editor's lines, the way Cursor shows them.
// Each block is a webview inset from the editorInsets proposed API, which only
// works when the extension may use proposed APIs ("enable-proposed-api" in
// argv.json). Without it the first call throws, this switches itself off, and
// the deletion markers, hover and peek carry on as before. Webviews aren't
// free, so only hunks that removed lines and sit near the visible range get one.
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { insetLine } from './diff';
import type { ReviewModel } from './model';

/** New insets are made for hunks this many lines outside the visible range... */
const CREATE_MARGIN = 40;
/** ...and kept until they're this far out, so scrolling near the edge doesn't churn. */
const KEEP_MARGIN = 120;
const MAX_INSETS_PER_EDITOR = 10;
/** Longer deletions show this many lines, then a link to the peek box. */
const MAX_LINES = 20;
const UPDATE_DELAY = 100;
/** Wheel steps closer together than this build on the last target; visibleRanges lag behind. */
const SCROLL_CHAIN = 300;

interface Wanted {
  key: string;
  line: number;
  distance: number;
  lines: string[];
  tabSize: number;
  args: [string, number, number];
}

export class RemovedLineInsets implements vscode.Disposable {
  private readonly insets = new Map<vscode.TextEditor, Map<string, vscode.WebviewEditorInset>>();
  /** Set once the proposed API turns out to be off or gone; stays off until reload. */
  private unavailable = false;
  private timer: NodeJS.Timeout | undefined;
  private scrollTarget: { editor: vscode.TextEditor; line: number; at: number } | undefined;
  private readonly disposables: vscode.Disposable[];

  constructor(private readonly model: ReviewModel) {
    this.disposables = [
      model.onDidChange(() => this.schedule()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.schedule()),
      vscode.window.onDidChangeTextEditorVisibleRanges(() => this.schedule()),
      vscode.window.onDidChangeTextEditorOptions(() => this.schedule()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('hunker.inlineRemovedLines')) this.schedule(0);
      }),
    ];
    this.schedule(0);
  }

  private schedule(delay = UPDATE_DELAY): void {
    if (this.unavailable) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.updateAll(), delay);
  }

  private updateAll(): void {
    this.timer = undefined;
    const enabled = vscode.workspace.getConfiguration('hunker').get<boolean>('inlineRemovedLines', true);
    const visible = new Set(enabled ? vscode.window.visibleTextEditors : []);
    for (const editor of [...this.insets.keys()]) if (!visible.has(editor)) this.clear(editor);
    for (const editor of visible) {
      if (this.unavailable) return;
      this.update(editor);
    }
  }

  private update(editor: vscode.TextEditor): void {
    const doc = editor.document;
    const state = doc.uri.scheme === 'file' ? this.model.get(doc.uri.fsPath) : undefined;
    const current = this.insets.get(editor) ?? new Map<string, vscode.WebviewEditorInset>();
    const tabSize = typeof editor.options.tabSize === 'number' ? editor.options.tabSize : 4;

    const wanted: Wanted[] = [];
    for (const h of state?.hunks ?? []) {
      if (h.oldLines.length === 0) continue;
      const line = insetLine(h, doc.lineCount);
      const distance = distanceToVisible(editor, line + 1);
      const key = `${line}:${tabSize}:${h.oldLines.join('\n')}`;
      if (distance <= CREATE_MARGIN || (distance <= KEEP_MARGIN && current.has(key))) {
        wanted.push({ key, line, distance, lines: h.oldLines, tabSize, args: [state!.path, h.oldStart, h.newStart] });
      }
    }
    wanted.sort((a, b) => a.distance - b.distance).splice(MAX_INSETS_PER_EDITOR);

    const keys = new Set(wanted.map((w) => w.key));
    for (const [key, inset] of current) {
      if (keys.has(key)) continue;
      current.delete(key);
      inset.dispose();
    }
    this.insets.set(editor, current);
    for (const w of wanted) {
      if (current.has(w.key)) continue;
      const inset = this.create(editor, w);
      if (this.unavailable) return;
      if (inset) current.set(w.key, inset);
    }
    if (current.size === 0) this.insets.delete(editor);
  }

  private create(editor: vscode.TextEditor, w: Wanted): vscode.WebviewEditorInset | undefined {
    const shown = w.lines.slice(0, MAX_LINES);
    const more = w.lines.length - shown.length;
    const height = shown.length + (more > 0 ? 1 : 0);
    let inset: vscode.WebviewEditorInset;
    try {
      inset = vscode.window.createWebviewTextEditorInset(editor, w.line, height, {
        enableScripts: true,
        enableCommandUris: ['hunker.peekRemoved'],
      });
    } catch (err) {
      // The editor went away since the update was scheduled; the next one sorts it out.
      if (/visible editor/i.test(String(err))) return undefined;
      this.unavailable = true;
      console.log(`Hunker: inline removed lines are off, using markers instead (${String(err)})`);
      this.clearAll();
      return undefined;
    }
    inset.webview.html = render(shown, more, height, w.tabSize, w.args);
    inset.webview.onDidReceiveMessage((msg: { scroll?: unknown }) => {
      if (typeof msg?.scroll === 'number') this.scroll(editor, msg.scroll);
    });
    inset.onDidDispose(() => {
      const map = this.insets.get(editor);
      if (map?.get(w.key) === inset) map.delete(w.key);
    });
    return inset;
  }

  /** Insets swallow the mouse wheel, so their script forwards it here in whole lines. */
  private scroll(editor: vscode.TextEditor, lines: number): void {
    const now = Date.now();
    const last = this.scrollTarget;
    const from = last?.editor === editor && now - last.at < SCROLL_CHAIN ? last.line : (editor.visibleRanges[0]?.start.line ?? 0);
    const line = Math.max(0, Math.min(from + lines, editor.document.lineCount - 1));
    this.scrollTarget = { editor, line, at: now };
    editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.AtTop);
  }

  private clear(editor: vscode.TextEditor): void {
    const map = this.insets.get(editor);
    this.insets.delete(editor);
    for (const inset of map?.values() ?? []) inset.dispose();
  }

  private clearAll(): void {
    for (const editor of [...this.insets.keys()]) this.clear(editor);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.clearAll();
    for (const d of this.disposables) d.dispose();
  }
}

function distanceToVisible(editor: vscode.TextEditor, line: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (const r of editor.visibleRanges) {
    const distance = line < r.start.line ? r.start.line - line : line > r.end.line ? line - r.end.line : 0;
    best = Math.min(best, distance);
  }
  return best;
}

/**
 * Plain text in the editor's font, one row per editor line: the inset is
 * `height` editor lines tall, so each row gets an equal share of it.
 */
function render(lines: string[], more: number, height: number, tabSize: number, args: unknown[]): string {
  const nonce = randomBytes(16).toString('base64');
  const rows = lines.map((l) => `<div class="line">${escapeHtml(l.endsWith('\r') ? l.slice(0, -1) : l)}</div>`);
  if (more > 0) {
    const href = `command:hunker.peekRemoved?${encodeURIComponent(JSON.stringify(args))}`;
    rows.push(`<div class="more"><a href="${escapeHtml(href)}">… ${more} more removed line${more === 1 ? '' : 's'}</a></div>`);
  }
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: var(--vscode-editor-background); }
  body {
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
    font-weight: var(--vscode-editor-font-weight);
  }
  .line, .more { height: calc(100vh / ${height}); line-height: calc(100vh / ${height}); white-space: pre; tab-size: ${tabSize}; }
  .line { background: var(--vscode-diffEditor-removedLineBackground, rgba(255, 0, 0, 0.2)); }
  .more a { color: var(--vscode-textLink-foreground); text-decoration: none; }
</style>
</head>
<body>${rows.join('')}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let pending = 0;
  addEventListener('wheel', (e) => {
    const lineHeight = innerHeight / ${height};
    const px = e.deltaMode === 1 ? e.deltaY * lineHeight : e.deltaMode === 2 ? e.deltaY * innerHeight : e.deltaY;
    pending += px / lineHeight;
    const lines = Math.trunc(pending);
    if (lines !== 0) {
      pending -= lines;
      vscode.postMessage({ scroll: lines });
    }
  }, { passive: true });
</script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
