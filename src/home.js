'use strict';
// Ally keeps its data in ~/.ally. Claude Meter, its former name, used ~/.claude-meter:
// migrate() moves that folder over once, so settings, todos and sessions are kept.
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = () => path.join(os.homedir(), '.ally');
const legacyHome = () => path.join(os.homedir(), '.claude-meter');

// Moves src into dst. When dst already exists (the new hooks ran before the app started),
// folders are merged and a file already in dst wins: it is the newer one.
function move(src, dst) {
  if (!fs.existsSync(dst)) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(src, dst);
    return;
  }
  // Both have it: the new folder's copy wins and the old one goes, so the old folder empties.
  if (!fs.statSync(src).isDirectory() || !fs.statSync(dst).isDirectory()) {
    fs.rmSync(src, { recursive: true, force: true });
    return;
  }
  for (const name of fs.readdirSync(src)) move(path.join(src, name), path.join(dst, name));
  try { fs.rmdirSync(src); } catch {}
}

// Returns true when something was moved. Never throws: a failed move leaves the old folder.
function migrate(from = legacyHome(), to = home()) {
  try {
    if (!fs.existsSync(from)) return false;
    move(from, to);
    return true;
  } catch {
    return false;
  }
}

// ~/.ally holds sessions (with permission prompts), tickets and todos: only you may read it.
// Windows already keeps a profile folder private.
function makePrivate(dir = home()) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  } catch {}
}

module.exports = { home, legacyHome, migrate, makePrivate };
