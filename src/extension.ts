import * as vscode from 'vscode';
import { Actions, type HunkRef } from './actions';
import { HunkCodeLensProvider } from './codelens';
import { Decorations } from './decorations';
import { installHook, promptIfMissing, refreshScript, uninstallHook } from './hookInstaller';
import { HunkHoverProvider } from './hover';
import { RemovedLineInsets } from './insets';
import { ReviewModel } from './model';
import { Navigation, PendingFileDecorations, StatusBar } from './navigation';
import { BASE_SCHEME, BaselineContentProvider, peekRemoved } from './peek';
import { BaselineStore } from './store';

export function activate(context: vscode.ExtensionContext): void {
  try {
    refreshScript(context);
  } catch (err) {
    console.error('Hunker: could not refresh ~/.claude/hunker/capture.js', err);
  }

  const store = new BaselineStore();
  const model = new ReviewModel(store);
  const actions = new Actions(store, model);
  const navigation = new Navigation(model);
  const files = { scheme: 'file' };

  /** Lenses and hover links pass (path, oldStart, newStart); keybindings pass nothing. */
  const refFrom = (args: unknown[]): HunkRef | undefined =>
    typeof args[0] === 'string' && typeof args[1] === 'number' && typeof args[2] === 'number'
      ? { path: args[0], oldStart: args[1], newStart: args[2] }
      : actions.refAtCursor();
  const pathFrom = (arg: unknown): string | undefined => {
    if (typeof arg === 'string') return arg;
    if (arg instanceof vscode.Uri) return arg.fsPath;
    const uri = vscode.window.activeTextEditor?.document.uri;
    return uri?.scheme === 'file' ? uri.fsPath : undefined;
  };
  const command = (id: string, fn: (...args: unknown[]) => unknown) =>
    vscode.commands.registerCommand(id, async (...args: unknown[]) => {
      try {
        await fn(...args);
      } catch (err) {
        void vscode.window.showErrorMessage(`Hunker: ${(err as Error).message}`);
      }
    });

  const fileDecorations = new PendingFileDecorations(model);
  const baselines = new BaselineContentProvider(store);

  context.subscriptions.push(
    store,
    model,
    fileDecorations,
    baselines,
    new Decorations(model),
    new RemovedLineInsets(model),
    new StatusBar(model),
    vscode.window.registerFileDecorationProvider(fileDecorations),
    vscode.languages.registerCodeLensProvider(files, new HunkCodeLensProvider(model)),
    vscode.languages.registerHoverProvider(files, new HunkHoverProvider(model)),
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, baselines),
    vscode.window.onDidChangeWindowState((s) => s.focused && store.scheduleReload(0)),

    command('hunker.acceptHunk', (...args) => {
      const ref = refFrom(args);
      return ref && actions.acceptHunk(ref);
    }),
    command('hunker.rejectHunk', (...args) => {
      const ref = refFrom(args);
      return ref && actions.rejectHunk(ref);
    }),
    command('hunker.acceptFile', (arg) => {
      const p = pathFrom(arg);
      return p && actions.acceptFile(p);
    }),
    command('hunker.rejectFile', (arg) => {
      const p = pathFrom(arg);
      return p && actions.rejectFile(p);
    }),
    command('hunker.acceptAll', () => actions.acceptAll()),
    command('hunker.rejectAll', () => actions.rejectAll()),
    command('hunker.nextHunk', () => navigation.nextHunk(1)),
    command('hunker.prevHunk', () => navigation.nextHunk(-1)),
    command('hunker.nextFile', () => navigation.nextFile(1)),
    command('hunker.prevFile', () => navigation.nextFile(-1)),
    command('hunker.showFiles', () => navigation.showFiles()),
    command('hunker.peekRemoved', (p, oldStart, newStart) =>
      peekRemoved(
        model,
        typeof p === 'string' ? p : undefined,
        typeof oldStart === 'number' ? oldStart : undefined,
        typeof newStart === 'number' ? newStart : undefined,
      ),
    ),
    command('hunker.installHook', () => installHook(context)),
    command('hunker.uninstallHook', () => uninstallHook()),
  );

  store.start();
  model.updateContextKeys();
  void promptIfMissing(context);
}

export function deactivate(): void {}
