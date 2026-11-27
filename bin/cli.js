#!/usr/bin/env node
'use strict';
// The `ally` command, for an npm install or a source checkout.
//   ally                  start the widget
//   ally setup            hooks, app menu entry, start at login, then start
//   ally setup --no-autostart
//   ally remove           undo setup
//   ally --version | --help
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const APP = path.resolve(__dirname, '..');
const SCRIPTS = path.join(APP, 'scripts');
const { home, migrate } = require('../src/home');
const LOG = path.join(home(), 'launch.log');
const { version } = require('../package.json');

const node = (script, ...args) => spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { stdio: 'inherit' }).status === 0;

function minNode() {
  const [a, b] = process.versions.node.split('.').map(Number);
  if (a > 22 || (a === 22 && b >= 12)) return true;
  console.error(`Ally needs Node.js 22.12 or newer (found ${process.version}).`);
  return false;
}

// Electron 44 downloads its binary the first time its path is asked for.
function electron() {
  let bin = '';
  try { bin = require('electron'); } catch (e) { console.error(e.message); }
  if (!bin || !fs.existsSync(bin) || !node('check-deps.js')) {
    console.error(`Electron could not be set up. Reinstall the package: npm install -g ${require('../package.json').name}`);
    return '';
  }
  return bin;
}

// Ubuntu 24.04 and newer stop Electron unless its sandbox helper is setuid root.
function linuxSandbox(bin) {
  if (process.platform !== 'linux') return;
  const read = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; } };
  if (read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') !== '1' && read('/proc/sys/kernel/unprivileged_userns_clone') !== '0') return;
  const helper = path.join(path.dirname(bin), 'chrome-sandbox');
  const st = fs.statSync(helper);
  if (st.uid === 0 && (st.mode & 0o4777) === 0o4755) return;
  console.log("This system restricts Electron's sandbox. Fixing its helper needs sudo:");
  // No shell: the path goes as one argument, whatever characters it holds.
  const ok = spawnSync('sudo', ['chown', 'root:root', helper], { stdio: 'inherit' }).status === 0 &&
    spawnSync('sudo', ['chmod', '4755', helper], { stdio: 'inherit' }).status === 0;
  if (!ok) console.log(`Not fixed, Ally may not start. Run: sudo chown root:root '${helper}' && sudo chmod 4755 '${helper}'`);
}

function linuxHints() {
  if (process.platform !== 'linux') return;
  const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
  if (!has('xdotool')) console.log("Optional: install xdotool to jump to a session's terminal tab (sudo apt install xdotool).");
  if (has('gnome-extensions')) {
    const on = spawnSync('gnome-extensions', ['list', '--enabled'], { encoding: 'utf8' }).stdout || '';
    if (!/appindicator/i.test(on)) console.log('Note: the top bar icon needs the GNOME AppIndicator extension to be enabled.');
  }
}

// Detached, so closing the terminal does not close the widget. Output goes to a log.
function start(bin) {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  const out = fs.openSync(LOG, 'w');
  spawn(bin, [APP], { detached: true, stdio: ['ignore', out, out], windowsHide: true }).unref();
  const where = process.platform === 'win32' ? 'system tray' : process.platform === 'darwin' ? 'menu bar' : 'top bar';
  console.log(`Ally is running. Look for its icon in the ${where}. Log: ${LOG}`);
}

function help() {
  console.log(`Ally ${version}

  ally                                start the widget
  ally setup                          add the Claude Code hooks, an app menu entry and
                                      start at login, then start the widget
  ally setup --no-autostart           same, without start at login
  ally remove                         remove the hooks, menu entry and start at login
  ally --version`);
}

function main(argv) {
  const cmd = argv[0] || 'start';
  if (cmd === '--version' || cmd === '-v') return console.log(version), 0;
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') return help(), 0;
  // Claude Meter, Ally's former name, kept its data in ~/.claude-meter.
  if (migrate()) console.log(`Moved your Claude Meter data to ${home()}`);
  if (cmd === 'remove') return node('install-hooks.js', '--remove', '--apply') && node('install-desktop.js', '--remove') ? 0 : 1;
  if (cmd !== 'start' && cmd !== 'setup') { help(); return 1; }
  if (!minNode()) return 1;
  const bin = electron();
  if (!bin) return 1;
  if (cmd === 'setup') {
    if (!node('install-hooks.js', '--apply')) return 1;
    if (!node('install-desktop.js', ...(argv.includes('--no-autostart') ? [] : ['--autostart']))) return 1;
    linuxSandbox(bin);
    linuxHints();
  }
  start(bin);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
