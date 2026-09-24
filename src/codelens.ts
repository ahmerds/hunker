// Lenses above each hunk: Accept · Reject · Show removed.
import * as vscode from 'vscode';
import { anchorLine } from './diff';
import type { ReviewModel } from './model';

export class HunkCodeLensProvider implements vscode.CodeLensProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changeEmitter.event;

  constructor(private readonly model: ReviewModel) {
    model.onDidChange(() => this.changeEmitter.fire());
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (doc.uri.scheme !== 'file') return [];
    const state = this.model.get(doc.uri.fsPath);
    if (!state) return [];

    // File-level actions live in the editor title bar; lenses are per hunk only.
    const path = state.path;
    const lenses: vscode.CodeLens[] = [];
    for (const h of state.hunks) {
      const line = anchorLine(h, doc.lineCount);
      const range = new vscode.Range(line, 0, line, 0);
      const args = [path, h.oldStart, h.newStart];
      lenses.push(
        new vscode.CodeLens(range, { title: '$(check) Accept', command: 'hunker.acceptHunk', arguments: args }),
        new vscode.CodeLens(range, { title: '$(close) Reject', command: 'hunker.rejectHunk', arguments: args }),
      );
      if (h.oldLines.length > 0) {
        const label = h.newLines.length > 0 ? `$(eye) Show removed (−${h.oldLines.length})` : `$(eye) Show removed (${h.oldLines.length})`;
        lenses.push(new vscode.CodeLens(range, { title: label, command: 'hunker.peekRemoved', arguments: args }));
      }
    }
    return lenses;
  }
}
