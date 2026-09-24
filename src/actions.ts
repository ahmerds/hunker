// Accept / reject for a hunk, a file, or everything.
import * as vscode from 'vscode';
import { acceptHunk as acceptText, type Hunk, minimalEdit, rejectHunk as rejectText } from './diff';
import type { FileState, ReviewModel } from './model';
import type { BaselineStore } from './store';

/** Identifies a hunk across recomputes; it's looked up again by position. */
export interface HunkRef {
  path: string;
  oldStart: number;
  newStart: number;
}

export class Actions {
  constructor(
    private readonly store: BaselineStore,
    private readonly model: ReviewModel,
  ) {}

  /** The hunk at the cursor (else the nearest one) in the active editor. */
  refAtCursor(): HunkRef | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') return;
    const state = this.model.get(editor.document.uri.fsPath);
    if (!state) return;
    const hunk = this.model.hunkAt(state, editor.selection.active.line);
    return hunk && { path: state.path, oldStart: hunk.oldStart, newStart: hunk.newStart };
  }

  private async resolve(ref: HunkRef): Promise<{ state: FileState; hunk: Hunk } | undefined> {
    const state = await this.model.refresh(ref.path);
    const hunk = state && this.model.findHunk(state, ref.oldStart, ref.newStart);
    return state && hunk ? { state, hunk } : undefined;
  }

  async acceptHunk(ref: HunkRef): Promise<void> {
    const found = await this.resolve(ref);
    if (!found) return;
    const { state, hunk } = found;
    const baseline = acceptText(state.entry.content ?? '', hunk);
    if (baseline === state.current) await this.store.remove(state.path);
    else await this.store.write(state.path, baseline);
  }

  async rejectHunk(ref: HunkRef): Promise<void> {
    const found = await this.resolve(ref);
    if (!found) return;
    const { state, hunk } = found;
    if (!state.exists) {
      await writeFile(state.uri, rejectText(state.current, hunk));
    } else {
      const doc = await vscode.workspace.openTextDocument(state.uri);
      const current = doc.getText();
      await replaceDocument(doc, current, rejectText(current, hunk));
    }
    const after = await this.model.refresh(state.path);
    if (after && after.hunks.length === 0) await this.store.remove(state.path);
  }

  async acceptFile(filePath: string): Promise<void> {
    await this.store.remove(filePath);
  }

  async rejectFile(filePath: string): Promise<void> {
    const state = await this.model.refresh(filePath);
    const entry = this.store.get(filePath);
    if (!entry) return;
    const uri = vscode.Uri.file(filePath);
    if (entry.content === null) {
      // Claude created this file: rejecting deletes it (to the trash).
      if (state?.exists) {
        await closeTabs(uri);
        try {
          await vscode.workspace.fs.delete(uri, { useTrash: true });
        } catch (err) {
          if (!(err instanceof vscode.FileSystemError && err.code === 'FileNotFound')) throw err;
        }
      }
    } else if (state?.exists) {
      const doc = await vscode.workspace.openTextDocument(uri);
      await replaceDocument(doc, doc.getText(), entry.content);
    } else {
      await writeFile(uri, entry.content);
    }
    await this.store.remove(filePath);
  }

  async acceptAll(): Promise<void> {
    for (const state of this.model.trackedFiles()) await this.store.remove(state.path);
  }

  async rejectAll(): Promise<void> {
    const files = this.model.pendingFiles();
    if (files.length === 0) return;
    const hunks = files.reduce((n, f) => n + f.hunks.length, 0);
    const choice = await vscode.window.showWarningMessage(
      `Reject all ${plural(hunks, 'change')} in ${plural(files.length, 'file')}?`,
      { modal: true, detail: 'Files Claude created will be moved to the trash. Other files go back to how they were before Claude edited them.' },
      'Reject All',
    );
    if (choice !== 'Reject All') return;
    for (const state of files) await this.rejectFile(state.path);
  }
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Apply the smallest edit (one WorkspaceEdit, so Cmd+Z works) and save. */
async function replaceDocument(doc: vscode.TextDocument, current: string, next: string): Promise<void> {
  if (current !== next) {
    const edit = minimalEdit(current, next);
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.replace(doc.uri, new vscode.Range(doc.positionAt(edit.start), doc.positionAt(edit.end)), edit.text);
    if (!(await vscode.workspace.applyEdit(workspaceEdit))) {
      throw new Error(`Couldn't edit ${vscode.workspace.asRelativePath(doc.uri)}`);
    }
  }
  if (doc.isDirty) await doc.save();
}

async function writeFile(uri: vscode.Uri, text: string): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
}

async function closeTabs(uri: vscode.Uri): Promise<void> {
  const tabs = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString());
  if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
}
