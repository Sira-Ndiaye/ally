'use strict';
// Windows only: runs in the new terminal and starts claude with the argv from a JSON file,
// so the prompt never goes through wt's or cmd's command-line parsing.
const fs = require('fs');
const { spawn } = require('child_process');

const file = process.argv[2];
const { cwd, bin, args } = JSON.parse(fs.readFileSync(file, 'utf8'));
fs.unlinkSync(file);
// Ctrl+C belongs to claude (it asks twice before quitting): the wrapper must not die on it.
process.on('SIGINT', () => {});
const child = spawn(bin, args, { cwd, stdio: 'inherit' });
child.on('error', (e) => { console.error(`${bin}: ${e.message}`); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
