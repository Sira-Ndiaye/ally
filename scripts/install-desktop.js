#!/usr/bin/env node
'use strict';
// Adds a way to launch Ally without a terminal:
//   Linux    `ally` command + app-menu entry with icon
//   macOS    `ally` command
//   (installed from npm, the command comes from npm itself and is not written here)
//   Windows  Start menu shortcut
//   --autostart   also start it at login
//   --remove      remove everything this script added
// Either way, what Claude Meter (Ally's former name) added is removed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOME = os.homedir();
const APP = path.resolve(__dirname, '..');
const remove = process.argv.includes('--remove');
const autostart = process.argv.includes('--autostart');

// Under plain Node the electron package exports the path of its binary.
let ELECTRON = '';
try { ELECTRON = require('electron'); } catch {}

const write = (file, content, mode) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
  console.log('Wrote ' + file);
};

// A path inside double quotes, for sh and .desktop Exec lines: \ " $ and ` are escaped.
const dq = (p) => `"${String(p).replace(/[\\"$`]/g, '\\$&')}"`;
// A path inside XML text, for the macOS launch agent.
const xml = (p) => String(p).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Installed as an npm package rather than run from a source checkout.
const FROM_NPM = APP.split(path.sep).includes('node_modules');
const CLI = path.join(APP, 'bin', 'cli.js');
const BIN = path.join(HOME, '.local', 'bin', 'ally');
// The command runs bin/cli.js, which starts the widget detached and logs its output.
const launcher = () => {
  if (!FROM_NPM) write(BIN, `#!/bin/sh\nexec ${dq(process.execPath)} ${dq(CLI)} "$@"\n`, 0o755);
};
// Only a launcher written for this copy is removed: another copy may own the command.
const ownsBin = () => { try { return fs.readFileSync(BIN, 'utf8').includes(CLI); } catch { return false; } };
// Claude Meter's launcher ran its own copy's bin/cli.js, wherever that copy was.
const LEGACY_BIN = path.join(HOME, '.local', 'bin', 'claude-meter');
const ownsLegacyBin = () => { try { return /^exec ".*" ".*bin[\\/]cli\.js" "\$@"$/m.test(fs.readFileSync(LEGACY_BIN, 'utf8')); } catch { return false; } };

const linux = () => {
  const menu = path.join(HOME, '.local', 'share', 'applications', 'ally.desktop');
  const auto = path.join(HOME, '.config', 'autostart', 'ally.desktop');
  const entry = (extra = '') => `[Desktop Entry]
Type=Application
Name=Ally
Comment=Usage, sessions and todos for Claude Code
Exec=${dq(process.execPath)} ${dq(CLI)}
Icon=${path.join(APP, 'assets', 'icon.png').replace(/\n/g, '')}
Terminal=false
Categories=Utility;
StartupWMClass=ally
${extra}`;
  return {
    files: [menu, auto],
    legacy: [
      path.join(HOME, '.local', 'share', 'applications', 'claude-meter.desktop'),
      path.join(HOME, '.config', 'autostart', 'claude-meter.desktop'),
    ],
    install() {
      launcher();
      write(menu, entry());
      // The delay lets GNOME's compositor start first; without it the window is not transparent.
      if (autostart) write(auto, entry('X-GNOME-Autostart-enabled=true\nX-GNOME-Autostart-Delay=5\n'));
      console.log('Done. Search "Ally" in Activities, or run: ally');
    },
  };
};

const mac = () => {
  const agent = path.join(HOME, 'Library', 'LaunchAgents', 'com.sira-ndiaye.ally.plist');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.sira-ndiaye.ally</string>
  <key>ProgramArguments</key><array><string>${xml(ELECTRON)}</string><string>${xml(APP)}</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
`;
  return {
    files: [agent],
    legacy: [path.join(HOME, 'Library', 'LaunchAgents', 'com.claude-meter.plist')],
    install() {
      launcher();
      if (autostart) write(agent, plist);
      console.log('Done. Run: ally');
    },
  };
};

const windows = () => {
  const programs = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const menu = path.join(programs, 'Ally.lnk');
  const auto = path.join(programs, 'Startup', 'Ally.lnk');
  const shortcut = (file) => {
    // A quote in a path (a user named O'Brien) is doubled inside a PowerShell string.
    const q = (s) => `'${s.replace(/'/g, "''")}'`;
    const ps = `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${q(file)}); ` +
      `$s.TargetPath = ${q(ELECTRON)}; $s.Arguments = ${q(`"${APP}"`)}; $s.WorkingDirectory = ${q(APP)}; $s.Save()`;
    execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
    console.log('Wrote ' + file);
  };
  return {
    files: [menu, auto],
    legacy: [path.join(programs, 'Claude Meter.lnk'), path.join(programs, 'Startup', 'Claude Meter.lnk')],
    install() {
      shortcut(menu);
      if (autostart) shortcut(auto);
      console.log('Done. Search "Ally" in the Start menu.');
    },
  };
};

const target = { linux, darwin: mac, win32: windows }[process.platform];
if (!target) {
  console.error('Unsupported system: ' + process.platform);
  process.exit(1);
}
const { files, legacy, install } = target();
const unlink = (f) => { if (fs.existsSync(f)) { fs.unlinkSync(f); console.log('Removed ' + f); } };

// The old menu entries, autostart and launcher would start a second widget.
legacy.forEach(unlink);
if (ownsLegacyBin()) unlink(LEGACY_BIN);

if (remove) {
  (ownsBin() ? [BIN, ...files] : files).forEach(unlink);
  process.exit(0);
}

if (!ELECTRON || !fs.existsSync(ELECTRON)) {
  console.error(FROM_NPM ? 'Electron is missing. Run: ally setup' : 'Electron is missing. Run `npm install` in ' + APP + ' first.');
  process.exit(1);
}
try {
  execFileSync(process.execPath, [path.join(__dirname, 'check-deps.js')], { stdio: 'inherit' });
} catch {
  console.error(FROM_NPM ? 'Reinstall the package with npm.' : `Reinstall the dependencies first: rm -rf "${path.join(APP, 'node_modules')}" && npm install`);
  process.exit(1);
}

install();
if (!FROM_NPM && process.platform !== 'win32' && !(process.env.PATH || '').split(':').includes(path.dirname(BIN))) {
  console.log(`Note: ${path.dirname(BIN)} is not on your PATH, so the command needs its full path.`);
}
