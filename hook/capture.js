#!/usr/bin/env node
// Hunker: Claude Code PreToolUse hook.
//
// Runs before Claude's Edit/Write/MultiEdit/NotebookEdit tools and saves the
// file's current contents as the review baseline, unless a baseline already
// exists (so repeated edits pile up into one review). Plain Node, no deps.
// It always exits 0 and prints nothing, so it can never block Claude.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const MAX_BYTES = 2 * 1024 * 1024;

function baselineDir() {
  return process.env.HUNKER_BASELINE_DIR || path.join(os.homedir(), '.claude', 'hunker', 'baselines');
}

/**
 * Cursor's own agent also runs hooks from ~/.claude/settings.json. Its edits
 * already go through Cursor's review, so only capture for Claude Code.
 * Cursor sends `cursor_version` and a lowercase `preToolUse` event, and
 * doesn't set CLAUDECODE.
 */
function fromClaudeCode(data) {
  if (data.cursor_version !== undefined) return false;
  return process.env.CLAUDECODE === '1' || data.hook_event_name === 'PreToolUse';
}

function capture(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }
  if (!data || typeof data !== 'object' || !fromClaudeCode(data)) return;
  const input = data.tool_input || {};
  let file = input.file_path || input.notebook_path;
  if (typeof file !== 'string' || file === '') return;
  if (!path.isAbsolute(file)) file = path.resolve(data.cwd || process.cwd(), file);
  file = path.normalize(file);

  const dir = baselineDir();
  const id = crypto.createHash('sha1').update(file).digest('hex');
  const target = path.join(dir, `${id}.json`);
  if (fs.existsSync(target)) return;

  let content = null; // null = the file doesn't exist yet (Claude is creating it)
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) return;
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) return; // binary
    content = buf.toString('utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') return;
  }

  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${id}.${process.pid}.tmp`);
  const record = {
    path: file,
    content,
    capturedAt: Date.now(),
    sessionId: data.session_id || null,
  };
  fs.writeFileSync(tmp, JSON.stringify(record));
  try {
    // link() fails if the target exists, so two hooks racing on the same file
    // can't overwrite each other's baseline.
    fs.linkSync(tmp, target);
  } catch {
    // Another hook got there first; keep its baseline.
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  try { capture(raw); } catch {}
  process.exit(0);
});
process.stdin.on('error', () => process.exit(0));
// Never hang Claude if stdin is left open.
setTimeout(() => process.exit(0), 5000).unref();
