// Per-file hunk cache: baseline vs current text, recomputed on store changes,
// document edits and file-system events. Also owns the context keys.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { computeHunks, type Hunk, hunkSpan } from './diff';
import type { BaselineEntry, BaselineStore } from './store';

export interface FileState {
  path: string;
  uri: vscode.Uri;
  entry: BaselineEntry;
  current: string;
  /** false when the file is gone from disk (Claude deleted it, or hasn't created it yet). */
  exists: boolean;
  hunks: Hunk[];
  /** When the entry was first seen with no hunks. */
  emptySince?: number;
}

const RECOMPUTE_DELAY = 150;
/**
 * The hook runs *before* the edit, so a fresh entry has no hunks for a moment.
 * Only drop an empty entry once it has stayed empty this long (covers edits
 * the user denied in Claude).
 */
const STALE_AFTER = 5 * 60 * 1000;

export class ReviewModel implements vscode.Disposable {
  private files = new Map<string, FileState>();
  private timers = new Map<string, NodeJS.Timeout>();
  private allTimer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly store: BaselineStore) {
    const fsWatcher = vscode.workspace.createFileSystemWatcher('**/*');
    const onFs = (uri: vscode.Uri) => {
      if (this.store.get(uri.fsPath)) this.schedule(uri.fsPath);
    };
    const sweep = setInterval(() => void this.sweepStale(), 60 * 1000);
    this.disposables.push(
      this.changeEmitter,
      fsWatcher,
      fsWatcher.onDidChange(onFs),
      fsWatcher.onDidCreate(onFs),
      fsWatcher.onDidDelete(onFs),
      store.onDidChange(() => this.scheduleAll(0)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme === 'file' && this.store.get(e.document.uri.fsPath)) {
          this.schedule(e.document.uri.fsPath);
        }
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        if (doc.uri.scheme === 'file' && this.store.get(doc.uri.fsPath)) this.schedule(doc.uri.fsPath);
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleAll(0)),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContextKeys()),
      { dispose: () => clearInterval(sweep) },
    );
  }

  /** Files with pending hunks, in the order Claude touched them. */
  pendingFiles(): FileState[] {
    return [...this.files.values()]
      .filter((f) => f.hunks.length > 0)
      .sort((a, b) => a.entry.capturedAt - b.entry.capturedAt || a.path.localeCompare(b.path));
  }

  /** Every tracked file in this window, including ones with no hunks right now. */
  trackedFiles(): FileState[] {
    return [...this.files.values()];
  }

  get(filePath: string): FileState | undefined {
    const state = this.files.get(filePath);
    return state && state.hunks.length > 0 ? state : undefined;
  }

  totalHunks(): number {
    return this.pendingFiles().reduce((n, f) => n + f.hunks.length, 0);
  }

  /** Recompute one file right now and return its fresh state. */
  async refresh(filePath: string): Promise<FileState | undefined> {
    const timer = this.timers.get(filePath);
    if (timer) clearTimeout(timer);
    this.timers.delete(filePath);
    await this.recompute(filePath);
    return this.files.get(filePath);
  }

  findHunk(state: FileState, oldStart: number, newStart: number): Hunk | undefined {
    return state.hunks.find((h) => h.oldStart === oldStart && h.newStart === newStart);
  }

  /** Hunk containing `line`, else the nearest one. */
  hunkAt(state: FileState, line: number, containingOnly = false): Hunk | undefined {
    let best: Hunk | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const h of state.hunks) {
      const start = h.newStart;
      const end = h.newStart + hunkSpan(h) - 1;
      const distance = line < start ? start - line : line > end ? line - end : 0;
      if (distance < bestDistance) {
        best = h;
        bestDistance = distance;
      }
    }
    return containingOnly && bestDistance > 0 ? undefined : best;
  }

  schedule(filePath: string): void {
    const existing = this.timers.get(filePath);
    if (existing) clearTimeout(existing);
    this.timers.set(
      filePath,
      setTimeout(() => {
        this.timers.delete(filePath);
        void this.recompute(filePath);
      }, RECOMPUTE_DELAY),
    );
  }

  scheduleAll(delay = RECOMPUTE_DELAY): void {
    if (this.allTimer) clearTimeout(this.allTimer);
    this.allTimer = setTimeout(() => void this.recomputeAll(), delay);
  }

  private async recomputeAll(): Promise<void> {
    const paths = new Set([...this.files.keys(), ...this.store.all().map((e) => e.path)]);
    const changed = await Promise.all([...paths].map((p) => this.recomputeQuiet(p)));
    if (changed.some(Boolean)) this.fireChange();
  }

  private async recompute(filePath: string): Promise<void> {
    if (await this.recomputeQuiet(filePath)) this.fireChange();
  }

  /** Returns true if the visible state changed. */
  private async recomputeQuiet(filePath: string): Promise<boolean> {
    const previous = this.files.get(filePath);
    const entry = this.store.get(filePath);
    if (!entry || !inWorkspace(filePath)) {
      this.files.delete(filePath);
      return !!previous && previous.hunks.length > 0;
    }
    const uri = vscode.Uri.file(filePath);
    const { text, exists } = await readCurrent(filePath);
    // A new file Claude hasn't written yet has nothing to review.
    const hunks = entry.content === null && !exists ? [] : computeHunks(entry.content ?? '', text);
    const now = Date.now();
    const state: FileState = {
      path: filePath,
      uri,
      entry,
      current: text,
      exists,
      hunks,
      emptySince: hunks.length > 0 ? undefined : (previous?.emptySince ?? now),
    };
    // The store may have changed while we were reading; don't clobber a newer result.
    if (this.store.get(filePath) !== entry) return false;
    this.files.set(filePath, state);
    return !previous || previous.current !== state.current || previous.entry !== entry || previous.exists !== exists;
  }

  private async sweepStale(): Promise<void> {
    const now = Date.now();
    for (const state of this.files.values()) {
      if (state.hunks.length === 0 && state.emptySince !== undefined && now - state.emptySince > STALE_AFTER) {
        await this.store.remove(state.path);
      }
    }
  }

  private fireChange(): void {
    this.updateContextKeys();
    this.changeEmitter.fire();
  }

  updateContextKeys(): void {
    const any = this.pendingFiles().length > 0;
    const active = vscode.window.activeTextEditor?.document.uri;
    const editorHas = !!active && active.scheme === 'file' && !!this.get(active.fsPath);
    void vscode.commands.executeCommand('setContext', 'hunker.hasAnyChanges', any);
    void vscode.commands.executeCommand('setContext', 'hunker.editorHasChanges', editorHas);
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    if (this.allTimer) clearTimeout(this.allTimer);
    for (const d of this.disposables) d.dispose();
  }
}

export function inWorkspace(filePath: string): boolean {
  return (vscode.workspace.workspaceFolders ?? []).some((folder) => {
    if (folder.uri.scheme !== 'file') return false;
    const root = folder.uri.fsPath;
    return filePath === root || filePath.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  });
}

function openDocument(filePath: string): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === filePath);
}

/** Open documents win (they include unsaved edits); otherwise read from disk. */
async function readCurrent(filePath: string): Promise<{ text: string; exists: boolean }> {
  const doc = openDocument(filePath);
  if (doc && !doc.isClosed) return { text: doc.getText(), exists: true };
  try {
    return { text: await fs.promises.readFile(filePath, 'utf8'), exists: true };
  } catch {
    return { text: '', exists: false };
  }
}
