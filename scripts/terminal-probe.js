#!/usr/bin/env node
'use strict';
// Does Plan with Claude reach claude intact on this system? Opens a real terminal with
// src/terminal.js, the code Ally ships, and the arguments src/plan.js builds for a skill
// and for the built-in prompt. A stand-in (this file, run with --as-claude) takes
// claude's place and writes down the folder and arguments it received.
//
//   node scripts/terminal-probe.js [--terminal NAME]
// Exits 0 when every argument and the folder arrived exactly as sent.
const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.argv[2] === '--as-claude') {
  const [, , , out, ...argv] = process.argv;
  fs.writeFileSync(out, JSON.stringify({ cwd: fs.realpathSync(process.cwd()), argv }));
  console.log('Ally probe received:', argv);
  process.exit(0);
}

const terminal = require('../src/terminal');
const plan = require('../src/plan');

const i = process.argv.indexOf('--terminal');
const name = i > 0 ? process.argv[i + 1] : undefined;

// Everything a ticket's text can hold that shells, wt and cmd treat specially.
const ticket = {
  key: 'ACME-312', summary: `Show "report" it's $HOME \`whoami\` ; rm -rf x & | > %PATH% ^& !x!`, status: 'In Progress', p: 'P2',
  due: '2026-11-21', labels: ['mvp2'], links: [], description: 'Line one.\nLine two with \\ and "quotes".', project: { key: 'ACME', name: 'Acme' },
};
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ally probe it's here "));
const cases = [
  ['skill', plan.planArgs({ ticket, skill: { name: 'ui-handler' }, folder: { dir: cwd, known: true } })],
  ['built-in prompt', plan.planArgs({ ticket, skill: null, folder: { dir: cwd, known: true } })],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let failed = 0;
  for (const [label, args] of cases) {
    const out = path.join(os.tmpdir(), `ally-probe-${process.pid}-${label.replace(/\W/g, '')}.json`);
    const p = terminal.open({ cwd, bin: process.execPath, args: [__filename, '--as-claude', out, ...args], title: ticket.key, terminal: name });
    const want = JSON.stringify({ cwd: fs.realpathSync(cwd), argv: args });
    let got = '';
    for (let t = 0; t < 120 && !got; t++) { await sleep(250); try { got = fs.readFileSync(out, 'utf8'); } catch {} }
    const ok = got === want;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${p.terminal}, ${label}` + (ok ? '' : got ? `\n     want ${want}\n     got  ${got}` : '\n     nothing ran within 30 s'));
  }
  process.exit(failed ? 1 : 0);
})();
