'use strict';
// Opens a terminal running a command in a folder, on macOS, Linux and Windows. Used by
// Plan with Claude. The prompt can hold quotes, $, backticks, ; and new lines, so no
// system builds a shell line out of it (checked by scripts/terminal-probe.js):
//   macOS    a script file `exec`s the command; Terminal (or iTerm2 when it runs) runs `sh <file>`
//   Linux    the terminal gets the command and its arguments as separate argv entries
//   Windows  Windows Terminal (or a new console) runs node terminal-wrapper.js <json file>
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { home } = require('./home');

const safeName = (s) => String(s).replace(/[^\w.-]/g, '_').slice(0, 40);
const itermRunning = () => spawnSync('pgrep', ['-xq', 'iTerm2']).status === 0;

const RUN = path.join(home(), 'run');

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const appleString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const has = (cmd) => spawnSync(process.platform === 'win32' ? 'where' : 'sh',
  process.platform === 'win32' ? [cmd] : ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;

function writeRunFile(name, content, mode) {
  fs.mkdirSync(RUN, { recursive: true });
  const file = path.join(RUN, name);
  fs.writeFileSync(file, content, { mode });
  return file;
}

// macOS and Konsole: the script removes itself, then replaces the shell with claude.
function macScript({ cwd, bin, args }) {
  return `#!/bin/sh\nrm -f "$0"\ncd ${sq(cwd)} || exit 1\nexec ${[bin, ...args].map(sq).join(' ')}\n`;
}

function macPlan(terminal, script) {
  const line = `sh ${sq(script)}`;
  if (terminal === 'iterm') {
    return ['osascript', ['-e', `tell application "iTerm"
  activate
  set w to (create window with default profile)
  tell current session of w to write text ${appleString(line)}
end tell`]];
  }
  return ['osascript', ['-e', `tell application "Terminal"
  activate
  do script ${appleString(line)}
end tell`]];
}

// Linux: which terminal, from the desktop, then whatever the system points to.
function linuxTerminal() {
  const desktop = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();
  const order = desktop.includes('kde') ? ['konsole', 'gnome-terminal'] : ['gnome-terminal', 'konsole'];
  return [...order, 'x-terminal-emulator', 'xterm'].find(has) || '';
}

// Konsole expands $VARIABLES in the command after -e, so it gets a script to run instead.
function linuxPlan(terminal, { cwd, bin, args, title }, script) {
  switch (terminal) {
    case 'gnome-terminal': return ['gnome-terminal', [`--working-directory=${cwd}`, `--title=${title}`, '--', bin, ...args]];
    case 'konsole': return ['konsole', ['--workdir', cwd, '-p', `tabtitle=${title}`, '-e', '/bin/sh', script]];
    // Debian's alternative and xterm take the command and its arguments after -e; no folder flag.
    default: return [terminal, ['-T', title, '-e', bin, ...args], { cwd }];
  }
}

// Windows: wt splits its command line on ';' unless escaped, so only fixed paths go there.
function windowsPlan(terminal, { cwd, title }, jsonFile) {
  const wrapper = path.join(__dirname, 'terminal-wrapper.js');
  if (terminal === 'wt') {
    const esc = (s) => s.replace(/;/g, '\\;');
    return ['wt.exe', ['-w', 'new', '--title', esc(title), '-d', esc(cwd), esc(process.execPath), esc(wrapper), esc(jsonFile)]];
  }
  // A detached child gets its own console window.
  return [process.execPath, [wrapper, jsonFile], { cwd, detached: true }];
}

function plan({ cwd, bin, args, title, terminal }) {
  if (process.platform === 'darwin') {
    const t = terminal || (itermRunning() ? 'iterm' : 'terminal');
    const script = writeRunFile(`${safeName(title)}-${Date.now()}.sh`, macScript({ cwd, bin, args }), 0o700);
    return { terminal: t, run: macPlan(t, script) };
  }
  if (process.platform === 'linux') {
    const t = terminal || linuxTerminal();
    if (!t) throw new Error('No terminal found (tried gnome-terminal, konsole, x-terminal-emulator, xterm)');
    const script = t === 'konsole' ? writeRunFile(`${safeName(title)}-${Date.now()}.sh`, macScript({ cwd, bin, args }), 0o700) : '';
    return { terminal: t, run: linuxPlan(t, { cwd, bin, args, title }, script) };
  }
  if (process.platform === 'win32') {
    const t = terminal || (has('wt.exe') ? 'wt' : 'console');
    const json = writeRunFile(`${safeName(title)}-${Date.now()}.json`, JSON.stringify({ cwd, bin, args }));
    return { terminal: t, run: windowsPlan(t, { cwd, title }, json) };
  }
  throw new Error('Unsupported system: ' + process.platform);
}

function open(opts) {
  const p = plan(opts);
  const [cmd, args, extra = {}] = p.run;
  const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: !extra.detached, ...extra });
  child.on('error', (e) => console.error(`${cmd}: ${e.message}`));
  child.unref();
  return p;
}


// The `claude` to run. On macOS the command runs inside the terminal's own interactive
// shell, so the bare name finds the same claude as typing it. Elsewhere the terminal gets
// a path: an app started at login lacks the shell's PATH, so the native installer's place
// comes first, then an interactive shell's answer (it reads the rc files that set PATH).
let claudePath = '';
function findClaude() {
  if (process.platform === 'darwin') return 'claude';
  if (claudePath) return claudePath;
  const win = process.platform === 'win32';
  const h = require('os').homedir();
  const native = path.join(h, '.local', 'bin', win ? 'claude.exe' : 'claude');
  if (fs.existsSync(native)) return (claudePath = native);
  const r = win
    ? spawnSync('where', ['claude'], { encoding: 'utf8', timeout: 3000 })
    : spawnSync(process.env.SHELL || '/bin/sh', ['-ic', 'command -v claude'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
  const found = (r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => path.isAbsolute(l) && (!win || /\.exe$/i.test(l))).pop();
  return (claudePath = found || (win ? 'claude.exe' : 'claude'));
}

module.exports = { sq, appleString, macScript, macPlan, linuxPlan, windowsPlan, plan, open, findClaude };
