// Installs the PreToolUse hook into user-level ~/.claude/settings.json, so
// nothing is written into repos. Settings are only changed on an explicit click.
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { HUNKER_DIR } from './store';

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const SCRIPT = path.join(HUNKER_DIR, 'capture.js');
const MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';
const DONT_ASK_KEY = 'hunker.dontAskToInstallHook';

interface HookCommand {
  type: string;
  command?: string;
  [key: string]: unknown;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookCommand[];
  [key: string]: unknown;
}
interface Settings {
  hooks?: Record<string, HookGroup[] | undefined>;
  [key: string]: unknown;
}

const isOurs = (h: HookCommand) => typeof h.command === 'string' && h.command.includes('hunker/capture.js');

/** Copy the bundled hook script to ~/.claude/hunker/capture.js if it changed. */
export function refreshScript(context: vscode.ExtensionContext): void {
  const source = path.join(context.extensionPath, 'hook', 'capture.js');
  const bundled = fs.readFileSync(source, 'utf8');
  let installed: string | undefined;
  try {
    installed = fs.readFileSync(SCRIPT, 'utf8');
  } catch {}
  if (installed === bundled) return;
  fs.mkdirSync(HUNKER_DIR, { recursive: true });
  const tmp = `${SCRIPT}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, bundled, { mode: 0o755 });
  fs.renameSync(tmp, SCRIPT);
}

function readSettings(): Settings {
  let text: string;
  try {
    text = fs.readFileSync(SETTINGS, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text) as Settings;
  } catch {
    throw new Error(`${SETTINGS} isn't valid JSON, so Hunker won't touch it. Fix it and try again.`);
  }
}

export function isHookInstalled(): boolean {
  try {
    const groups = readSettings().hooks?.PreToolUse ?? [];
    return groups.some((g) => g.hooks?.some(isOurs));
  } catch {
    return false;
  }
}

export async function installHook(context: vscode.ExtensionContext): Promise<void> {
  try {
    refreshScript(context);
    const node = await findNode();
    const settings = readSettings();
    backupSettings();

    const hooks = settings.hooks ?? {};
    // Drop any earlier Hunker entry first, so reinstalling updates the node path
    // instead of adding the hook twice.
    const groups = removeOurs(hooks.PreToolUse ?? []);
    groups.push({
      matcher: MATCHER,
      hooks: [{ type: 'command', command: `${shellQuote(node)} ${shellQuote(SCRIPT)}`, timeout: 10 }],
    });
    hooks.PreToolUse = groups;
    settings.hooks = hooks;
    writeSettings(settings);

    const nodeNote = node === 'node' ? ' Couldn\'t find an absolute path to node, so it uses "node" from PATH.' : '';
    void vscode.window.showInformationMessage(
      `Hunker: hook installed in ~/.claude/settings.json.${nodeNote} Start a new Claude Code session for it to take effect.`,
    );
  } catch (err) {
    void vscode.window.showErrorMessage(`Hunker: couldn't install the hook. ${(err as Error).message}`);
  }
}

export async function uninstallHook(): Promise<void> {
  try {
    const settings = readSettings();
    const groups = settings.hooks?.PreToolUse;
    if (!settings.hooks || !groups?.some((g) => g.hooks?.some(isOurs))) {
      void vscode.window.showInformationMessage('Hunker: the hook isn\'t installed.');
      return;
    }
    backupSettings();
    const remaining = removeOurs(groups);
    if (remaining.length) settings.hooks.PreToolUse = remaining;
    else delete settings.hooks.PreToolUse;
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    writeSettings(settings);
    void vscode.window.showInformationMessage('Hunker: hook removed from ~/.claude/settings.json.');
  } catch (err) {
    void vscode.window.showErrorMessage(`Hunker: couldn't remove the hook. ${(err as Error).message}`);
  }
}

/** On activation: if the hook is missing, offer to install it (never install silently). */
export async function promptIfMissing(context: vscode.ExtensionContext): Promise<void> {
  if (isHookInstalled() || context.globalState.get<boolean>(DONT_ASK_KEY)) return;
  const choice = await vscode.window.showInformationMessage(
    'Hunker needs a Claude Code hook to record files before Claude edits them. Add it to ~/.claude/settings.json?',
    'Install',
    "Don't Ask Again",
  );
  if (choice === 'Install') await installHook(context);
  else if (choice === "Don't Ask Again") await context.globalState.update(DONT_ASK_KEY, true);
}

function removeOurs(groups: HookGroup[]): HookGroup[] {
  return groups
    .map((g) => (g.hooks?.some(isOurs) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h)) } : g))
    .filter((g) => !Array.isArray(g.hooks) || g.hooks.length > 0);
}

function backupSettings(): void {
  if (!fs.existsSync(SETTINGS)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(SETTINGS, `${SETTINGS}.hunker-backup-${stamp}`);
}

function writeSettings(settings: Settings): void {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  const tmp = `${SETTINGS}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  fs.renameSync(tmp, SETTINGS);
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Absolute path to node. When Cursor is opened from the Dock its PATH may not
 * include nvm's node, so ask a login shell (then an interactive one, which
 * reads ~/.zshrc where nvm usually lives), then try common locations.
 */
async function findNode(): Promise<string> {
  const shell = process.platform === 'darwin' ? '/bin/zsh' : process.env.SHELL || '/bin/sh';
  for (const flags of ['-lc', '-ilc']) {
    const found = await run(shell, [flags, 'command -v node']);
    const line = found
      ?.split('\n')
      .map((l) => l.trim())
      .reverse()
      .find((l) => path.isAbsolute(l) && isExecutable(l));
    if (line) return line;
  }
  for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
    if (isExecutable(candidate)) return candidate;
  }
  return 'node';
}

function run(cmd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout) => resolve(err ? undefined : stdout));
  });
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}
