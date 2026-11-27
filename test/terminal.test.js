'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const T = require('../src/terminal');

const nasty = `Plan "X" it's $HOME \`whoami\` ; rm -rf x & \\ end\nsecond line`;

test('macOS: the script hands claude the exact arguments, whatever they hold', { skip: process.platform === 'win32' }, () => {
  const script = T.macScript({ cwd: "/tmp/it's here", bin: 'printf', args: ['%s|', nasty, '-n', 'K'] });
  assert.match(script, /^#!\/bin\/sh\nrm -f "\$0"\ncd '\/tmp\/it'\\''s here' \|\| exit 1\nexec 'printf'/);
  // Run the exec line in sh: printf gets every argument intact.
  // The quoted prompt holds a new line, so the command runs to the end of the script.
  const command = script.slice(script.indexOf('\nexec ') + 6);
  const out = spawnSync('sh', ['-c', command], { encoding: 'utf8' }).stdout;
  assert.equal(out, `${nasty}|-n|K|`);
});

test('macOS: Terminal and iTerm2 get an AppleScript string with quotes escaped', () => {
  const [cmd, args] = T.macPlan('terminal', '/x/a "b".sh');
  assert.equal(cmd, 'osascript');
  assert.match(args[1], /do script "sh '\/x\/a \\"b\\".sh'"/);
  assert.match(T.macPlan('iterm', '/x.sh')[1][1], /tell application "iTerm"[\s\S]*write text "sh '\/x.sh'"/);
});

test('Linux: arguments go to the terminal as separate entries', () => {
  const o = { cwd: '/r', bin: '/bin/claude', args: ['-n', 'K', nasty], title: 'K' };
  assert.deepStrictEqual(T.linuxPlan('gnome-terminal', o), ['gnome-terminal', ['--working-directory=/r', '--title=K', '--', '/bin/claude', '-n', 'K', nasty]]);
  // Konsole would expand $HOME in its -e command: it runs the script that execs claude.
  assert.deepStrictEqual(T.linuxPlan('konsole', o, '/run/K.sh'), ['konsole', ['--workdir', '/r', '-p', 'tabtitle=K', '-e', '/bin/sh', '/run/K.sh']]);
  assert.deepStrictEqual(T.linuxPlan('xterm', o), ['xterm', ['-T', 'K', '-e', '/bin/claude', '-n', 'K', nasty], { cwd: '/r' }]);
});

test('Windows: only fixed paths reach wt, with ; escaped; the console is a detached child', () => {
  const [cmd, args] = T.windowsPlan('wt', { cwd: 'C:\\a;b', title: 'K' }, 'C:\\run\\k.json');
  assert.equal(cmd, 'wt.exe');
  assert.deepStrictEqual(args.slice(0, 6), ['-w', 'new', '--title', 'K', '-d', 'C:\\a\\;b']);
  assert.equal(args[args.length - 1], 'C:\\run\\k.json');
  const [, , opts] = T.windowsPlan('console', { cwd: 'C:\\r', title: 'K' }, 'C:\\run\\k.json');
  assert.deepStrictEqual(opts, { cwd: 'C:\\r', detached: true });
});
