// Moving between hunks and files: next/prev, quick pick, status bar, explorer badges.
import * as vscode from 'vscode';
import { plural } from './actions';
import { anchorLine, type Hunk, hunkSpan } from './diff';
import type { FileState, ReviewModel } from './model';

export class Navigation {
  constructor(private readonly model: ReviewModel) {}

  async nextHunk(direction: 1 | -1): Promise<void> {
    const files = this.model.pendingFiles();
    if (files.length === 0) return;
    const editor = vscode.window.activeTextEditor;
    const index = editor ? files.findIndex((f) => f.path === editor.document.uri.fsPath) : -1;
    if (index >= 0 && editor) {
      const line = editor.selection.active.line;
      const hunks = files[index].hunks;
      const inFile =
        direction === 1
          ? hunks.find((h) => h.newStart > line)
          : [...hunks].reverse().find((h) => h.newStart + hunkSpan(h) - 1 < line);
      if (inFile) return reveal(files[index], inFile);
    }
    // Move to the next/previous file, wrapping around.
    const target = files[wrap(index < 0 ? (direction === 1 ? -1 : 0) : index, direction, files.length)];
    await reveal(target, direction === 1 ? target.hunks[0] : target.hunks[target.hunks.length - 1]);
  }

  async nextFile(direction: 1 | -1): Promise<void> {
    const files = this.model.pendingFiles();
    if (files.length === 0) return;
    const active = vscode.window.activeTextEditor?.document.uri.fsPath;
    const index = files.findIndex((f) => f.path === active);
    const target = files[wrap(index < 0 ? (direction === 1 ? -1 : 0) : index, direction, files.length)];
    await reveal(target, target.hunks[0]);
  }

  async showFiles(): Promise<void> {
    const files = this.model.pendingFiles();
    if (files.length === 0) {
      void vscode.window.showInformationMessage('Hunker: nothing to review.');
      return;
    }
    const active = vscode.window.activeTextEditor?.document.uri.fsPath;
    const items = files.map((f) => ({
      label: `$(file) ${vscode.workspace.asRelativePath(f.uri)}`,
      description: [plural(f.hunks.length, 'change'), f.entry.content === null ? 'new file' : '', f.exists ? '' : 'deleted']
        .filter(Boolean)
        .join(' · '),
      picked: f.path === active,
      file: f,
    }));
    const pick = await vscode.window.showQuickPick(items, {
      title: `Claude edited ${plural(files.length, 'file')}`,
      placeHolder: 'Pick a file to review',
      matchOnDescription: true,
    });
    if (pick) await reveal(pick.file, pick.file.hunks[0]);
  }
}

function wrap(index: number, direction: 1 | -1, length: number): number {
  return (index + direction + length) % length;
}

async function reveal(state: FileState, hunk: Hunk): Promise<void> {
  if (!state.exists) {
    const choice = await vscode.window.showWarningMessage(
      `${vscode.workspace.asRelativePath(state.uri)} was deleted.`,
      'Restore File',
      'Accept Deletion',
    );
    if (choice === 'Restore File') await vscode.commands.executeCommand('hunker.rejectFile', state.path);
    if (choice === 'Accept Deletion') await vscode.commands.executeCommand('hunker.acceptFile', state.path);
    return;
  }
  const editor = await vscode.window.showTextDocument(state.uri, { preview: false });
  const line = anchorLine(hunk, editor.document.lineCount);
  const pos = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

export class StatusBar implements vscode.Disposable {
  private readonly prev = vscode.window.createStatusBarItem('hunker.prev', vscode.StatusBarAlignment.Left, 102);
  private readonly main = vscode.window.createStatusBarItem('hunker.summary', vscode.StatusBarAlignment.Left, 101);
  private readonly next = vscode.window.createStatusBarItem('hunker.next', vscode.StatusBarAlignment.Left, 100);
  private readonly subscription: vscode.Disposable;

  constructor(private readonly model: ReviewModel) {
    this.prev.name = 'Hunker: Previous File';
    this.prev.text = '‹';
    this.prev.tooltip = 'Previous edited file';
    this.prev.command = 'hunker.prevFile';
    this.main.name = 'Hunker';
    this.main.command = 'hunker.showFiles';
    this.main.tooltip = 'Files Claude edited — click to pick one';
    this.next.name = 'Hunker: Next File';
    this.next.text = '›';
    this.next.tooltip = 'Next edited file';
    this.next.command = 'hunker.nextFile';
    this.subscription = model.onDidChange(() => this.update());
    this.update();
  }

  private update(): void {
    const files = this.model.pendingFiles();
    if (files.length === 0) {
      this.prev.hide();
      this.main.hide();
      this.next.hide();
      return;
    }
    this.main.text = `$(diff) ${plural(files.length, 'file')} · ${plural(this.model.totalHunks(), 'change')}`;
    this.prev.show();
    this.main.show();
    this.next.show();
  }

  dispose(): void {
    this.subscription.dispose();
    this.prev.dispose();
    this.main.dispose();
    this.next.dispose();
  }
}

export class PendingFileDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.changeEmitter.event;
  private shown: vscode.Uri[] = [];
  private readonly subscription: vscode.Disposable;

  constructor(private readonly model: ReviewModel) {
    this.subscription = model.onDidChange(() => {
      const now = model.pendingFiles().map((f) => f.uri);
      this.changeEmitter.fire([...this.shown, ...now]);
      this.shown = now;
    });
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') return;
    const state = this.model.get(uri.fsPath);
    if (!state) return;
    const count = state.hunks.length;
    return {
      badge: count > 9 ? '9+' : String(count),
      tooltip: `Claude: ${plural(count, 'change')} to review`,
      color: new vscode.ThemeColor('hunker.fileDecoration'),
    };
  }

  dispose(): void {
    this.subscription.dispose();
    this.changeEmitter.dispose();
  }
}
