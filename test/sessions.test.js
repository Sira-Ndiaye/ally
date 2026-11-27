'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parsePs, parseLsofCwd, mergeSessions } = require('../src/sessions');

test('parsePs keeps Claude Code sessions, with or without a terminal, and skips one-shot runs', () => {
  const out = [
    '  101 ttys001  claude',
    '  102 ttys002  /Users/me/.local/bin/claude --resume',
    '  103 ttys003  node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    '  104 ??       claude',
    '  105 ttys004  /bin/zsh -c cd /Users/me/claude && ls',
    '  106 ttys005  vim claude',
    '  107 ??       claude -p summarise --model haiku',
    '  108 ttys006  claude --print hello',
  ].join('\n');
  assert.deepStrictEqual(parsePs(out), [
    { pid: 101, tty: true }, { pid: 102, tty: true }, { pid: 103, tty: true }, { pid: 104, tty: false },
  ]);
});

test('a process without a terminal is a session only once a hook has fired for it', () => {
  const procs = [{ pid: 1, cwd: '/a', tty: true }, { pid: 2, cwd: '/b', tty: false }, { pid: 3, cwd: '/c', tty: false }];
  const records = [{ id: 's3', pid: 3, cwd: '/c', state: 'working', updated: 5 }, { id: 'gone', pid: 9, updated: 1 }];
  const { sessions, stale } = mergeSessions(records, procs);
  assert.deepStrictEqual(sessions.map((s) => s.id), ['pid-1', 's3']);
  assert.deepStrictEqual(stale, ['gone']);
});

test('parseLsofCwd maps each pid to its working directory', () => {
  const out = 'p101\nfcwd\nn/Users/me/proj a\np103\nfcwd\nn/tmp\n';
  assert.deepStrictEqual([...parseLsofCwd(out)], [[101, '/Users/me/proj a'], [103, '/tmp']]);
});
