// Baselines written by the hook to ~/.claude/hunker/baselines/<sha1(path)>.json.
// The directory is outside the workspace, so it's watched with Node's fs.watch.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

export interface BaselineEntry {
  path: string;
  /** null = the file didn't exist before Claude created it. */
  content: string | null;
  capturedAt: number;
  sessionId?: string | null;
}

export const HUNKER_DIR = path.join(os.homedir(), '.claude', 'hunker');
export const BASELINE_DIR = path.join(HUNKER_DIR, 'baselines');

export function baselineFile(filePath: string): string {
  const id = crypto.createHash('sha1').update(filePath).digest('hex');
  return path.join(BASELINE_DIR, `${id}.json`);
}

export class BaselineStore implements vscode.Disposable {
  private entries = new Map<string, BaselineEntry>();
  /** Raw file contents from the last load, to skip no-op change events. */
  private raw = new Map<string, string>();
  private watcher: fs.FSWatcher | undefined;
  private reloadTimer: NodeJS.Timeout | undefined;
  private disposed = false;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  start(): void {
    fs.mkdirSync(BASELINE_DIR, { recursive: true });
    this.watch();
    void this.reload();
  }

  get(filePath: string): BaselineEntry | undefined {
    return this.entries.get(filePath);
  }

  all(): BaselineEntry[] {
    return [...this.entries.values()];
  }

  /** Replace an entry's baseline (after accepting a hunk). */
  async write(filePath: string, content: string): Promise<void> {
    const entry = this.entries.get(filePath);
    if (!entry) return;
    const updated: BaselineEntry = { ...entry, content };
    const file = baselineFile(filePath);
    const json = JSON.stringify(updated);
    const tmp = path.join(BASELINE_DIR, `.${path.basename(file)}.${process.pid}.tmp`);
    await fs.promises.writeFile(tmp, json);
    await fs.promises.rename(tmp, file);
    this.entries.set(filePath, updated);
    this.raw.set(path.basename(file), json);
    this.changeEmitter.fire();
  }

  async remove(filePath: string): Promise<void> {
    const file = baselineFile(filePath);
    try {
      await fs.promises.unlink(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    this.raw.delete(path.basename(file));
    if (this.entries.delete(filePath)) this.changeEmitter.fire();
  }

  /** Re-read the directory soon; cheap, it's small. */
  scheduleReload(delay = 100): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => void this.reload(), delay);
  }

  private watch(): void {
    try {
      this.watcher = fs.watch(BASELINE_DIR, () => this.scheduleReload());
      this.watcher.on('error', () => this.rewatch());
    } catch {
      this.rewatch();
    }
  }

  private rewatch(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.disposed) return;
    setTimeout(() => {
      if (this.disposed) return;
      fs.mkdirSync(BASELINE_DIR, { recursive: true });
      this.watch();
      this.scheduleReload(0);
    }, 1000);
  }

  private async reload(): Promise<void> {
    let names: string[];
    try {
      names = (await fs.promises.readdir(BASELINE_DIR)).filter((n) => n.endsWith('.json') && !n.startsWith('.'));
    } catch {
      names = [];
    }
    const raw = new Map<string, string>();
    const entries = new Map<string, BaselineEntry>();
    await Promise.all(
      names.map(async (name) => {
        try {
          const text = await fs.promises.readFile(path.join(BASELINE_DIR, name), 'utf8');
          const entry = JSON.parse(text) as BaselineEntry;
          if (typeof entry.path !== 'string') return;
          if (entry.content !== null && typeof entry.content !== 'string') return;
          raw.set(name, text);
          entries.set(entry.path, entry);
        } catch {
          // Half-written or corrupt; the next change event will pick it up.
        }
      }),
    );
    if (this.disposed) return;
    const changed = raw.size !== this.raw.size || [...raw].some(([name, text]) => this.raw.get(name) !== text);
    if (!changed) return;
    this.raw = raw;
    this.entries = entries;
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.close();
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.changeEmitter.dispose();
  }
}
