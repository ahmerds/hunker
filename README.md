# Hunker

Review Claude Code's file edits inline in Cursor or VS Code, the way Cursor's own agent works. Claude writes straight to disk. Hunker then marks every change since your last review in the normal editor, and you accept or reject each hunk, or a whole file at a time. There is no review panel.

- **Added or changed lines**: green background.
- **Removed lines**: a thin red line where the code used to be. Hover to see the diff, or click **Show removed** to open the old code in an inline peek box.
- **Buttons above each change**: `Accept` · `Reject` · `Show removed (N)`.
- **Editor title bar** (top right, next to the tabs): `←` previous file · `☰` list of edited files · `→` next file · `↺` reject file · `✓` accept file · `⊠` reject all files · `✓✓` accept all files. The arrows only appear when more than one file has changes. Reject all asks you to confirm first.
- **Status bar**: `‹ 3 files · 7 changes ›`. Click the middle to pick a file, or the arrows to move between files.
- **Explorer and tabs**: files with pending changes get a badge.

---

## Install on a new computer

These steps are for macOS. Hunker also works on Linux and Windows; use the matching paths and `ctrl` in place of `cmd`.

### 1. Install the prerequisites

| Tool | Check with | Notes |
|---|---|---|
| **Node.js 20 or newer** | `node -v` | Needed to build Hunker, and to run its hook every time Claude edits a file. Any install method works (nvm, Homebrew, installer). |
| **Cursor** (or VS Code 1.90+) | — | |
| **`cursor` shell command** | `cursor --version` | If it's missing: in Cursor, open the Command Palette (`cmd+shift+p`) and run **Shell Command: Install 'cursor' command in PATH**. For VS Code the command is `code`. |
| **Claude Code extension** | — | Install `anthropic.claude-code` from the Extensions view. The Claude Code CLI works too. |

### 2. Get the source

Copy or clone the `hunker` folder onto the new machine, then open a terminal in it:

```sh
cd path/to/hunker
```

### 3. Build the extension

```sh
npm install
npm run package
```

`npm run package` type-checks, runs the unit tests, bundles the code, and writes **`hunker.vsix`** in the project folder.

> npm 11 may warn that esbuild's install script was skipped ("install-scripts … not yet covered by allowScripts"). You can ignore it: esbuild still works. If the build ever complains that esbuild is missing, run `npm install-scripts approve esbuild` and then `npm install` again.

### 4. Install it into Cursor

```sh
cursor --install-extension hunker.vsix
```

(For VS Code: `code --install-extension hunker.vsix`.)

Then reload the window: Command Palette → **Developer: Reload Window**.

### 5. Install the Claude Code hook

After the reload, Hunker asks: *"Hunker needs a Claude Code hook… Add it to ~/.claude/settings.json?"* Click **Install**.

If you missed the notification, run **Hunker: Install Claude Code Hook** from the Command Palette.

This does three things:

1. Copies the hook script to `~/.claude/hunker/capture.js`.
2. Makes a backup of `~/.claude/settings.json` next to it, named `settings.json.hunker-backup-<timestamp>`.
3. Adds a `PreToolUse` hook for `Edit|Write|MultiEdit|NotebookEdit` that runs the script with the absolute path to `node`.

Nothing is written into your repos. Hunker never changes your settings unless you click Install.

Check that the hook was added:

```sh
grep -A6 PreToolUse ~/.claude/settings.json
```

You should see something like:

```json
"PreToolUse": [
  {
    "matcher": "Edit|Write|MultiEdit|NotebookEdit",
    "hooks": [
      { "type": "command", "command": "/Users/you/.nvm/versions/node/v24.20.0/bin/node /Users/you/.claude/hunker/capture.js", "timeout": 10 }
    ]
  }
]
```

### 6. Set Claude Code to "Edit automatically"

In the Claude Code panel, switch the permission mode to **Edit automatically** (in the CLI: `shift+tab` until it says *accept edits on*). If you skip this, Claude Code shows its own diff prompt for every edit as well as Hunker's.

**Start a new Claude Code session.** Hooks are read when a session starts, so a session that was already open won't use the new hook.

### 7. Try it

1. Open a project folder in Cursor. Hunker only shows files inside the open workspace.
2. Ask Claude to edit a file.
3. The changed lines turn green, **Accept / Reject** buttons appear above them, and accept-file / reject-file icons appear in the editor title bar. The status bar shows `1 file · N changes`.

If nothing appears, see [Troubleshooting](#troubleshooting).

---

## Updating to a new version

```sh
cd path/to/hunker
npm install
npm run package
cursor --install-extension hunker.vsix --force
```

Reload the window. Hunker refreshes `~/.claude/hunker/capture.js` on every start, so you don't need to reinstall the hook.

---

## Using it

### Keyboard shortcuts

| Action | Keys |
|---|---|
| Accept change at cursor (else the nearest one) | `cmd+y` |
| Reject change at cursor (else the nearest one) | `cmd+n` |
| Accept / reject the whole file | `cmd+shift+y` / `cmd+shift+n` |
| Next / previous change (moves across files, wraps around) | `alt+]` / `alt+[` |
| Next / previous file | `alt+shift+]` / `alt+shift+[` |
| Peek removed lines at cursor | `alt+\` |

The accept and reject keys only work while the current file has pending changes, so in other files `cmd+n` still opens a new file as usual.

If `cmd+y` / `cmd+n` clash with something, set `"hunker.keybindingStyle": "alt"` in your settings. Accept and reject then use `alt+y` / `alt+n` (and `alt+shift+y` / `alt+shift+n` for the whole file).

### Commands (Command Palette → "Hunker")

- Accept / Reject Change at Cursor
- Accept / Reject All Changes in File
- Accept / Reject All Changes (All Files). Reject All asks you to confirm first.
- Next / Previous Change, Next / Previous Edited File
- Show Edited Files: a quick pick of every file with pending changes, in the order Claude touched them
- Peek Removed Lines at Cursor
- Install / Uninstall Claude Code Hook

### What accept and reject do

- **Accept** a change: Hunker stops showing it. The file on disk is not touched.
- **Reject** a change: Hunker puts the old lines back into the file and saves it. `cmd+z` undoes the reject.
- **Reject file**: restores the file to how it was before Claude's first edit. If Claude created the file, it's moved to the Trash.
- Claude can keep editing a file you haven't reviewed yet. All its edits pile up into one review against the version from before its first edit.

---

## How it works

```
Claude Code ──PreToolUse hook──▶ ~/.claude/hunker/capture.js ──▶ ~/.claude/hunker/baselines/<sha1(path)>.json
                                                                        │ (file watcher)
Cursor ◀── highlights / buttons / hover / peek ◀── Hunker: diff(baseline, current text)
```

Before each edit, the hook saves a copy of the file, unless it already has one. Hunker compares that copy with the current text (including unsaved changes) and shows the difference. Accepting updates the copy. Rejecting edits the real file. Several Cursor windows can share the store, and each one only shows files inside its own workspace.

---

## Troubleshooting

**Nothing shows up after Claude edits a file**

1. Check that baselines are being saved: `ls ~/.claude/hunker/baselines`. There should be one `.json` file per edited file.
2. If the folder is empty, the hook isn't running:
   - Did you start a **new** Claude Code session after installing the hook?
   - Run the hook's command from `~/.claude/settings.json` by hand to check that the node path works:
     `echo '{"tool_input":{"file_path":"/tmp/x"}}' | /path/to/node ~/.claude/hunker/capture.js && echo ok`
   - If you changed Node versions (for example with nvm), run **Hunker: Install Claude Code Hook** again. It replaces the old entry and doesn't add a second one.
3. If baselines exist but nothing is highlighted, check that the file is inside the folder you have open in Cursor.
4. Claude edits made through **Bash** (`sed -i`, `cat > file`, etc.) skip the hook and won't appear. See [Known limitations](#known-limitations).

**A review is stuck, or you want to start over**

Run **Hunker: Accept All Changes**, or delete the baselines by hand: `rm ~/.claude/hunker/baselines/*.json`.

**`~/.claude/settings.json` looks wrong after installing the hook**

Every install and uninstall makes a backup first. Restore the latest one:

```sh
ls -t ~/.claude/settings.json.hunker-backup-* | head -1
cp "$(ls -t ~/.claude/settings.json.hunker-backup-* | head -1)" ~/.claude/settings.json
```

---

## Uninstall

1. Command Palette → **Hunker: Uninstall Claude Code Hook** (removes only Hunker's entry from `~/.claude/settings.json`, with a backup).
2. `cursor --uninstall-extension local.hunker`
3. Optionally remove its data: `rm -rf ~/.claude/hunker`

---

## Known limitations

- Edits Claude makes through **Bash** (`sed -i`, heredocs) skip the hook and won't appear.
- Once you save your own edits to a file that has pending changes, they show up as part of the diff too.
- Removed lines aren't drawn as real lines in the editor; use hover or **Show removed**. This keeps Hunker on stable VS Code APIs, so it runs in Cursor without any `argv.json` changes.
- Claude Code must be in **Edit automatically** mode, or its own diff prompts appear as well.
- Files over 2 MB and binary files aren't tracked.

---

## Development

```sh
npm install
npm run watch      # rebuild dist/ on change
npm test           # unit tests for the diff logic (test/diff.test.ts)
npm run typecheck
```

To debug, open this folder in Cursor or VS Code and press `F5` (**Run Extension**, from `.vscode/launch.json`). It builds the extension and opens an Extension Development Host window with Hunker loaded.

| File | What it does |
|---|---|
| `hook/capture.js` | The PreToolUse hook. Plain Node, no dependencies, always exits 0. |
| `src/store.ts` | Reads and watches `~/.claude/hunker/baselines`. |
| `src/diff.ts` | Hunks, and accept/reject as pure text operations. |
| `src/model.ts` | Hunks for each file, recomputing, context keys. |
| `src/actions.ts` | Accept and reject for a hunk, a file, or everything. |
| `src/decorations.ts`, `codelens.ts`, `hover.ts`, `peek.ts` | What you see in the editor. |
| `src/navigation.ts` | Next/prev, the quick pick, the status bar, explorer badges. |
| `src/hookInstaller.ts` | Installs and removes the hook in `~/.claude/settings.json`. |
