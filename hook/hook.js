#!/usr/bin/env node
'use strict';
// Runs as a Claude Code hook. Must stay fast and must never fail the session:
// every error is swallowed and the exit code is always 0.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { applyEvent } = require('./state');

const DIR = path.join(os.homedir(), '.ally', 'sessions');
const ANSWERS = path.join(os.homedir(), '.ally', 'answers');

function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return null; }
}

// The hook runs under a shell spawned by Claude Code; walk up to the claude process
// so the widget can tell when a session died without sending SessionEnd.
// Match on the process name: the shell's own command line contains "claude" paths too.
function isClaudeProcess(pid) {
  const comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
  if (comm === 'claude') return true;
  return comm === 'node' && fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('claude-code');
}

function findClaudePidMac() {
  let pid = process.ppid;
  for (let i = 0; i < 6 && pid > 1; i++) {
    try {
      const row = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { timeout: 800 }).toString();
      const m = /^\s*(\d+)\s+(.+)$/m.exec(row);
      if (!m) break;
      if (path.basename(m[2].split(' ')[0]) === 'claude' || m[2].includes('claude-code')) return pid;
      pid = Number(m[1]);
    } catch { break; }
  }
  return 0;
}

function findClaudePid() {
  if (process.platform === 'darwin') return findClaudePidMac();
  if (process.platform !== 'linux') return 0;
  let pid = process.ppid;
  for (let i = 0; i < 6 && pid > 1; i++) {
    try {
      if (isClaudeProcess(pid)) return pid;
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    } catch { break; }
  }
  return 0;
}

function gitBranch(cwd) {
  try {
    return execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      timeout: 800, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch { return ''; }
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

function writeRecord(file, record) {
  // ~/.ally and its folders are private to you (a first hook may run before the app).
  fs.mkdirSync(path.dirname(DIR), { recursive: true, mode: 0o700 });
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  // Windows refuses the rename while the widget is reading the file: try again briefly.
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (i === 4) { try { fs.unlinkSync(tmp); } catch {} throw e; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

// Claude Code keeps its own prompt open in the terminal while this hook runs, and takes
// whichever answer comes first. So this waits for the widget's answer and gives up when the
// prompt is settled in the terminal: an approval shows as the prompt leaving the record
// (PostToolUse), a refusal as SIGTERM.
function waitForAnswer(file, at) {
  const answerFile = path.join(ANSWERS, path.basename(file));
  try { fs.unlinkSync(answerFile); } catch {}
  const pending = () => { const r = readJson(file); return r && r.ask && r.ask.at === at ? r : null; };
  const settle = (state, message) => {
    const r = pending();
    if (!r) return;
    delete r.ask;
    const now = Date.now();
    writeRecord(file, { ...r, state, message, since: now, updated: now });
  };
  process.on('SIGTERM', () => { settle('idle', 'Waiting for your next prompt'); process.exit(0); });
  setInterval(() => {
    if (!pending()) process.exit(0);
    const answer = readJson(answerFile);
    if (!answer || answer.at !== at) return;
    try { fs.unlinkSync(answerFile); } catch {}
    settle('working', 'Working');
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: answer.decision } }));
    process.exit(0);
  }, 200);
}

// Returns true when the process must stay alive to wait for an answer.
function main() {
  const input = readStdin();
  if (!input || !input.session_id || !/^[\w-]+$/.test(input.session_id)) return;
  const file = path.join(DIR, input.session_id + '.json');

  const prev = readJson(file);

  const next = applyEvent(prev, input, Date.now());
  if (!next) return;
  if (next.remove) { try { fs.unlinkSync(file); } catch {} return; }

  if (!next.pid) next.pid = findClaudePid();
  if (next.cwd && input.hook_event_name !== 'PostToolUse') next.branch = gitBranch(next.cwd);

  writeRecord(file, next);
  if (input.hook_event_name !== 'PermissionRequest') return;
  waitForAnswer(file, next.ask.at);
  return true;
}

let waiting = false;
try { waiting = main(); } catch {}
if (!waiting) process.exit(0);
