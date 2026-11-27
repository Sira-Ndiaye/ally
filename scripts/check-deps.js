#!/usr/bin/env node
'use strict';
// Exits 1 when node_modules does not fit this system, for example when it was copied
// from a Linux machine to a Mac: npm keeps such packages and Electron's binary stays
// the Linux one. install.sh then reinstalls the dependencies from scratch.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const APP = path.resolve(__dirname, '..');
const EXPECTED = { darwin: 'Electron.app/Contents/MacOS/Electron', win32: 'electron.exe' }[process.platform] || 'electron';

function problem() {
  // Resolved, not assumed under APP: npm may place it in a parent node_modules.
  let dir;
  try { dir = path.dirname(require.resolve('electron/package.json', { paths: [APP] })); } catch { return 'Electron is not installed'; }
  let got;
  try { got = fs.readFileSync(path.join(dir, 'path.txt'), 'utf8'); } catch { return 'Electron is not installed'; }
  if (got !== EXPECTED) return `Electron was installed for another system (${got})`;
  if (!fs.existsSync(path.join(dir, 'dist', got))) return 'the Electron binary is missing';
  if (process.platform === 'darwin') {
    // A copied or downloaded folder keeps the quarantine flag, and macOS then refuses to run it.
    try {
      execFileSync('xattr', ['-p', 'com.apple.quarantine', path.join(dir, 'dist', 'Electron.app')], { stdio: 'ignore' });
      return 'the Electron app is quarantined by macOS';
    } catch {}
  }
  return '';
}

const p = problem();
if (p) {
  console.log(`Dependencies need a clean reinstall: ${p}.`);
  process.exit(1);
}
