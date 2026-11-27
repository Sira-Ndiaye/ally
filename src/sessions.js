'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const run = (cmd, args, timeout = 1500) =>
  execFileSync(cmd, args, { timeout, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();

const isClaudeCommand = (cmd) => path.basename(cmd.split(' ')[0]) === 'claude' || cmd.includes('claude-code');

// One-shot runs (`claude -p`) are scripts, not sessions someone answers.
const isPrintMode = (args) => args.includes('-p') || args.includes('--print');

// `ps -axo pid=,tty=,command=` rows that are Claude Code sessions, in a terminal or not
// (the desktop app runs its sessions without one).
function parsePs(out) {
  const procs = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (m && isClaudeCommand(m[3]) && !isPrintMode(m[3].split(' '))) procs.push({ pid: Number(m[1]), tty: m[2] !== '??' });
  }
  return procs;
}

// `lsof -a -d cwd -Fpn` output: a "p<pid>" line, then an "n<path>" line per process.
function parseLsofCwd(out) {
  const cwds = new Map();
  let pid = 0;
  for (const line of out.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && pid) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

// lsof is slow, so it only runs for pids not seen before.
let macCwds = new Map();
function listClaudeProcessesMac() {
  try {
    const procs = parsePs(run('ps', ['-axo', 'pid=,tty=,command=']));
    const fresh = procs.map((p) => p.pid).filter((pid) => !macCwds.has(pid));
    const found = fresh.length ? parseLsofCwd(run('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', fresh.join(',')])) : new Map();
    macCwds = new Map(procs.map(({ pid }) => [pid, macCwds.get(pid) || found.get(pid) || '']));
    return procs.map((p) => ({ ...p, cwd: macCwds.get(p.pid) }));
  } catch { return null; }
}

// Claude Code session processes, with `tty` set when stdin is a terminal. null means
// "unknown" (Windows), so callers fall back to hook files alone.
function listClaudeProcesses() {
  if (process.platform === 'darwin') return listClaudeProcessesMac();
  if (process.platform !== 'linux') return null;
  const out = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const comm = fs.readFileSync(`/proc/${name}/comm`, 'utf8').trim();
      if (comm !== 'claude' && comm !== 'node') continue;
      const cmdline = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8');
      if (comm === 'node' && !cmdline.includes('claude-code')) continue;
      if (isPrintMode(cmdline.split('\0'))) continue;
      const tty = /^\/dev\/(pts|tty)/.test(fs.readlinkSync(`/proc/${name}/fd/0`));
      out.push({ pid: Number(name), cwd: fs.readlinkSync(`/proc/${name}/cwd`), tty });
    } catch {}
  }
  return out;
}

// One row per live process: its most recent hook record, or a placeholder until its
// first hook fires. /clear starts a new session id in the same process, hence "most recent".
// A process without a terminal only counts once a hook has fired: that tells a desktop app
// session apart from Claude Code's own helper processes.
function mergeSessions(records, procs) {
  if (!procs) return { sessions: records, stale: [] };
  const alive = new Map(procs.map((p) => [p.pid, p]));
  const latest = new Map();
  const stale = [];
  for (const r of records) {
    if (!r.pid || !alive.has(r.pid)) { stale.push(r.id); continue; }
    const cur = latest.get(r.pid);
    if (!cur || (r.updated || 0) > (cur.updated || 0)) {
      if (cur) stale.push(cur.id);
      latest.set(r.pid, r);
    } else {
      stale.push(r.id);
    }
  }
  const sessions = procs.filter((p) => p.tty || latest.has(p.pid)).map((p) => latest.get(p.pid) || {
    id: 'pid-' + p.pid, pid: p.pid, cwd: p.cwd, state: 'unknown', message: 'Status shows after your next prompt',
  });
  return { sessions, stale };
}

const branchCache = new Map();
function gitBranch(cwd) {
  const hit = branchCache.get(cwd);
  if (hit && Date.now() - hit.at < 60000) return hit.branch;
  let branch = '';
  try {
    branch = execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      timeout: 800, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch {}
  branchCache.set(cwd, { branch, at: Date.now() });
  return branch;
}

function parentOf(pid) {
  if (process.platform === 'darwin') return Number(run('ps', ['-o', 'ppid=', '-p', String(pid)]));
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
}

function ancestors(pid) {
  const list = [];
  for (let p = pid, i = 0; p > 1 && i < 12; i++) {
    list.push(p);
    try { p = parentOf(p); } catch { break; }
  }
  return list;
}

const xdo = (args) => run('xdotool', args);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const GT = ['--session', '--dest', 'org.gnome.Terminal'];
const gtWindow = (n) => [...GT, '--object-path', '/org/gnome/Terminal/window/' + n];
const gtActiveTab = (n) => Number(/<(\d+)>/.exec(run('gdbus', ['call', ...gtWindow(n), '--method', 'org.gtk.Actions.Describe', 'active-tab']))[1]);
const gtSetTab = (n, i) => run('gdbus', ['call', ...gtWindow(n), '--method', 'org.gtk.Actions.Activate', 'active-tab', `[<int32 ${i}>]`, '{}']);

function findWindowNamed(name) {
  for (let i = 0; i < 6; i++) {
    try { const w = xdo(['search', '--name', name]).split('\n')[0]; if (w) return w; } catch {}
    sleep(25);
  }
  return '';
}

// gnome-terminal keeps every tab in one process and has no "tab of this tty" call.
// So the session's tty gets a temporary unique title (pushed on the terminal's title
// stack, popped afterwards), and tabs are tried in turn until a window shows that title.
function focusGnomeTerminalTab(pid) {
  const tty = fs.readlinkSync(`/proc/${pid}/fd/0`);
  const mark = 'ally-' + pid + '-' + Date.now();
  const windows = [...run('gdbus', ['introspect', ...GT, '--object-path', '/org/gnome/Terminal/window']).matchAll(/node (\d+)/g)].map((m) => m[1]);
  fs.writeFileSync(tty, `\x1b[22;0t\x1b]0;${mark}\x07`);
  try {
    let wid = findWindowNamed(mark);
    for (const n of windows) {
      if (wid) break;
      const original = gtActiveTab(n);
      for (let i = 0; i < 40 && !wid; i++) {
        if (i === original) continue;
        gtSetTab(n, i);
        if (gtActiveTab(n) !== i) break;
        wid = findWindowNamed(mark);
      }
      if (!wid) gtSetTab(n, original);
    }
    if (!wid) return false;
    xdo(['windowactivate', wid]);
    return true;
  } finally {
    fs.writeFileSync(tty, '\x1b[23;0t');
  }
}

const TERMINAL_TAB = (tty) => `tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "${tty}" then
        set selected of t to true
        set index of w to 1
        activate
        return "ok"
      end if
    end repeat
  end repeat
end tell`;

const ITERM_TAB = (tty) => `tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is "${tty}" then
          select w
          select t
          select s
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
end tell`;

// Terminal and iTerm2 can select a tab by tty; any other terminal app is just raised.
function focusSessionMac(pid) {
  const chain = ancestors(pid);
  try {
    const tty = '/dev/' + run('ps', ['-o', 'tty=', '-p', String(pid)]);
    const apps = run('ps', ['-o', 'command=', '-p', chain.join(',')]);
    const script = /iTerm/.test(apps) ? ITERM_TAB(tty) : /Terminal\.app/.test(apps) ? TERMINAL_TAB(tty) : '';
    if (script && run('osascript', ['-e', script], 5000) === 'ok') return { ok: true };
  } catch {}
  for (const a of chain) {
    try {
      run('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${a}) to true`], 5000);
      return { ok: true };
    } catch {}
  }
  return { ok: false, reason: 'No window found for this session (tmux or SSH?).' };
}

// Raises the terminal window that owns a session. One terminal app often owns several
// windows (gnome-terminal, VS Code), so prefer the window whose title names the project.
function focusSession(pid, cwd) {
  if (process.platform === 'darwin') return focusSessionMac(pid);
  if (process.platform !== 'linux') return { ok: false, reason: 'Jumping to a session is not available on this system yet.' };
  try { xdo(['version']); } catch {
    return { ok: false, reason: 'Install xdotool to jump to a session: sudo apt install xdotool' };
  }
  const project = path.basename(cwd || '');
  for (const a of ancestors(pid)) {
    try {
      if (fs.readFileSync(`/proc/${a}/comm`, 'utf8').startsWith('gnome-terminal') && focusGnomeTerminalTab(pid)) return { ok: true };
    } catch {}
    let wins = [];
    try { wins = xdo(['search', '--onlyvisible', '--pid', String(a)]).split('\n').filter(Boolean); } catch {}
    if (!wins.length) continue;
    let target = wins[wins.length - 1];
    if (wins.length > 1 && project) {
      const named = wins.find((wid) => { try { return xdo(['getwindowname', wid]).includes(project); } catch { return false; } });
      if (named) target = named;
    }
    try { xdo(['windowactivate', target]); return { ok: true }; } catch {}
  }
  return { ok: false, reason: 'No window found for this session (tmux or SSH?).' };
}

module.exports = { parsePs, parseLsofCwd, listClaudeProcesses, mergeSessions, gitBranch, focusSession };
