// Added lines (green background + left border) and deletion markers (thin red line).
import * as vscode from 'vscode';
import type { ReviewModel } from './model';

export class Decorations implements vscode.Disposable {
  private readonly added = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    borderWidth: '0 0 0 3px',
    borderStyle: 'solid',
    borderColor: new vscode.ThemeColor('hunker.addedLineBorder'),
    overviewRulerColor: new vscode.ThemeColor('hunker.addedLineBorder'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  /** Pure deletion: the removed code used to sit just above this line. */
  private readonly removedAbove = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderWidth: '1px 0 0 0',
    borderStyle: 'solid',
    borderColor: new vscode.ThemeColor('hunker.removedMarker'),
    overviewRulerColor: new vscode.ThemeColor('hunker.removedMarker'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  /** Pure deletion past the end of the file: marked below the last line. */
  private readonly removedBelow = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderWidth: '0 0 1px 0',
    borderStyle: 'solid',
    borderColor: new vscode.ThemeColor('hunker.removedMarker'),
    overviewRulerColor: new vscode.ThemeColor('hunker.removedMarker'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly disposables: vscode.Disposable[];

  constructor(private readonly model: ReviewModel) {
    this.disposables = [
      this.added,
      this.removedAbove,
      this.removedBelow,
      model.onDidChange(() => this.updateAll()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.updateAll()),
    ];
    this.updateAll();
  }

  private updateAll(): void {
    for (const editor of vscode.window.visibleTextEditors) this.update(editor);
  }

  private update(editor: vscode.TextEditor): void {
    const doc = editor.document;
    const state = doc.uri.scheme === 'file' ? this.model.get(doc.uri.fsPath) : undefined;
    const added: vscode.Range[] = [];
    const above: vscode.Range[] = [];
    const below: vscode.Range[] = [];
    const last = doc.lineCount - 1;
    for (const h of state?.hunks ?? []) {
      if (h.newLines.length > 0) {
        const start = Math.min(h.newStart, last);
        const end = Math.min(h.newStart + h.newLines.length - 1, last);
        added.push(new vscode.Range(start, 0, end, 0));
      } else if (h.newStart <= last) {
        above.push(new vscode.Range(h.newStart, 0, h.newStart, 0));
      } else {
        below.push(new vscode.Range(last, 0, last, 0));
      }
    }
    editor.setDecorations(this.added, added);
    editor.setDecorations(this.removedAbove, above);
    editor.setDecorations(this.removedBelow, below);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
