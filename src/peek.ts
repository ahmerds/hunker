// Removed lines open in an inline peek box. The baseline is served under the
// hunker-base: scheme with the same file path, so the language (and syntax
// highlighting) is picked up from the extension.
import * as vscode from 'vscode';
import { anchorLine } from './diff';
import type { ReviewModel } from './model';
import type { BaselineStore } from './store';

export const BASE_SCHEME = 'hunker-base';

export function baseUri(filePath: string): vscode.Uri {
  return vscode.Uri.file(filePath).with({ scheme: BASE_SCHEME });
}

export class BaselineContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changeEmitter.event;
  private known = new Map<string, string | null>();
  private readonly subscription: vscode.Disposable;

  constructor(private readonly store: BaselineStore) {
    this.subscription = store.onDidChange(() => {
      const next = new Map(store.all().map((e) => [e.path, e.content] as const));
      for (const p of new Set([...this.known.keys(), ...next.keys()])) {
        if (this.known.get(p) !== next.get(p)) this.changeEmitter.fire(baseUri(p));
      }
      this.known = next;
    });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.store.get(uri.fsPath)?.content ?? '';
  }

  dispose(): void {
    this.subscription.dispose();
    this.changeEmitter.dispose();
  }
}

export async function peekRemoved(model: ReviewModel, target?: string, oldStart?: number, newStart?: number): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const filePath = target ?? (editor?.document.uri.scheme === 'file' ? editor.document.uri.fsPath : undefined);
  if (filePath === undefined) return;
  const state = await model.refresh(filePath);
  if (!state || state.hunks.length === 0) return;

  let hunk =
    oldStart !== undefined && newStart !== undefined
      ? model.findHunk(state, oldStart, newStart)
      : undefined;
  if (!hunk && filePath === editor?.document.uri.fsPath) {
    // At cursor, else the nearest hunk that removed something.
    const line = editor.selection.active.line;
    const withRemovals = { ...state, hunks: state.hunks.filter((h) => h.oldLines.length > 0) };
    hunk = model.hunkAt(withRemovals, line);
  }
  if (!hunk || hunk.oldLines.length === 0) {
    void vscode.window.setStatusBarMessage('Hunker: no removed lines here', 2000);
    return;
  }

  const doc = await vscode.workspace.openTextDocument(state.uri);
  if (vscode.window.activeTextEditor?.document !== doc) await vscode.window.showTextDocument(doc);
  const anchor = new vscode.Position(anchorLine(hunk, doc.lineCount), 0);
  const lastOld = hunk.oldLines.length - 1;
  const oldRange = new vscode.Range(
    hunk.oldStart,
    0,
    hunk.oldStart + lastOld,
    hunk.oldLines[lastOld].replace(/\r$/, '').length,
  );
  await vscode.commands.executeCommand(
    'editor.action.peekLocations',
    doc.uri,
    anchor,
    [new vscode.Location(baseUri(state.path), oldRange)],
    'peek',
  );
}
