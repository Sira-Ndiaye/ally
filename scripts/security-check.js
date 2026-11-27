#!/usr/bin/env node
'use strict';
// Security guards, run by `make security` and on every pull request. Each check keeps one
// protection from the security review (ROADMAP.md) from being removed by accident.
// Needs no network and no extra tool. Exits 1 when a check fails.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : '\n     ' + detail}`);
  if (!ok) failed++;
}

// Tracked files only: what would be pushed and published.
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT }).toString().split('\0').filter(Boolean);
const text = tracked.filter((f) => !/\.(png|jpe?g|gif|ico|icns)$/i.test(f) && f !== 'package-lock.json');
const code = text.filter((f) => /^(src|bin|hook|board|scripts)\/.*\.js$/.test(f) && f !== 'scripts/security-check.js');

// 1. No secret in the repository.
const SECRETS = [
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['Atlassian API token', /\bATATT[A-Za-z0-9_=-]{20,}/],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['AWS key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/],
  ['hard-coded secret', /\b(api[_-]?key|secret|password|passwd|client[_-]?secret)\b\s*[:=]\s*['"][A-Za-z0-9_\-+/=]{16,}['"]/i],
];
const leaks = [];
for (const f of text) {
  const lines = read(f).split('\n');
  lines.forEach((line, i) => { for (const [kind, re] of SECRETS) if (re.test(line)) leaks.push(`${f}:${i + 1} ${kind}`); });
}
check('no secret in tracked files', !leaks.length, leaks.join('\n     '));
check('no .env, key or credentials file tracked', !tracked.some((f) => /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|credentials\.json|jira\.json)$/.test(f)), tracked.join(' '));

// 2. The widget window stays locked to Ally's own page (Electron security checklist).
const main = read('src/main.js');
for (const [name, re] of [
  ['contextIsolation on', /contextIsolation:\s*true/],
  ['sandbox on', /sandbox:\s*true/],
  ['nodeIntegration off', /nodeIntegration:\s*false/],
  ['webSecurity on', /webSecurity:\s*true/],
  ['navigation blocked', /'will-navigate',\s*\(e\)\s*=>\s*e\.preventDefault\(\)/],
  ['new windows denied', /setWindowOpenHandler\(\(\)\s*=>\s*\(\{\s*action:\s*'deny'\s*\}\)\)/],
  ['browser permissions refused', /setPermissionRequestHandler\([^)]*\)\s*=>\s*cb\(false\)/],
]) check(`Electron: ${name}`, re.test(main));
check('Electron: nothing turns a protection off', !/nodeIntegration:\s*true|contextIsolation:\s*false|sandbox:\s*false|webSecurity:\s*false|allowRunningInsecureContent:\s*true|enableRemoteModule/.test(code.map(read).join('\n')));
// Every IPC channel goes through the sender check: ipcMain is used in the two helpers only.
const ipcUses = (main.match(/ipcMain\.(handle|on|once|handleOnce)\(/g) || []).length;
check('IPC: every channel checks that it comes from Ally\'s page', ipcUses === 2 && /const trusted = /.test(main), `${ipcUses} direct ipcMain uses`);
check('IPC: no other file listens on ipcMain', code.filter((f) => f !== 'src/main.js').every((f) => !/ipcMain\./.test(read(f))));

// 3. Pages run only their own scripts.
const page = read('src/index.html');
check('widget page has a strict CSP', /Content-Security-Policy" content="default-src 'self'; style-src 'self'; script-src 'self'"/.test(page));
check('no inline script or handler in the widget page', !/<script>(?!<\/script>)|\son[a-z]+=/i.test(page));

// 4. No shell between Ally and the commands it runs.
const shelly = [];
for (const f of code) {
  const src = read(f);
  if (/shell:\s*true/.test(src)) shelly.push(`${f}: shell: true`);
  // child_process.exec runs a shell; a regex's .exec( is fine.
  if (/(^|[^.\w])(exec|execSync)\(/m.test(src) || /\b(cp|childProcess|child_process|require\('child_process'\))\.(exec|execSync)\(/.test(src) || /child_process'\)\.exec\b|\{[^}]*\bexec(Sync)?\b[^}]*\}\s*=\s*require\('child_process'\)/.test(src)) shelly.push(`${f}: exec/execSync (runs a shell)`);
  if (/spawnSync?\(\s*'sudo',\s*\[\s*'(sh|bash)'/.test(src)) shelly.push(`${f}: sudo through a shell`);
}
check('commands run without a shell', !shelly.length, shelly.join('\n     '));

// 5. Data never goes into HTML: no innerHTML built from a template with values.
const html = [];
for (const f of code.filter((x) => /^(src|board)\//.test(x))) {
  read(f).split('\n').forEach((line, i) => {
    if (/(innerHTML|outerHTML)\s*[+]?=\s*`[^`]*\$\{/.test(line) && !/^\s*\$\('spk'\)/.test(line)) html.push(`${f}:${i + 1}`);
    if (/insertAdjacentHTML|document\.write\(|\beval\(|new Function\(/.test(line)) html.push(`${f}:${i + 1}`);
  });
}
check('no value is inserted as HTML (except the sparkline\'s numbers)', !html.length, html.join('\n     '));

// 6. Private data stays private.
check('~/.ally is made private at start', /makePrivate\(\);/.test(main) && /0o700/.test(read('src/home.js')));
check('Jira secrets are written with mode 600', /mode:\s*0o600/.test(read('src/jira-config.js')));
check('the hook writes its files private', /mode:\s*0o600/.test(read('hook/hook.js')));
check('plan limits stay opt-in', /const limitsOn = \(\) => !!prefs\.features\?\.limits;/.test(main) && /if \(!limitsOn\(\)\) return;/.test(main));
check('git never runs a repository\'s fsmonitor', ['src/sessions.js', 'hook/hook.js'].every((f) => !/execFileSync\('git', \['-C'/.test(read(f))));

// 7. The npm package ships only what users need.
const pkg = JSON.parse(read('package.json'));
check('npm package: files is an allow-list without tests, docs or dot files',
  Array.isArray(pkg.files) && !pkg.files.some((f) => /^(test|docs|\.)/.test(f)), JSON.stringify(pkg.files));
check('npm package: Electron pinned to an exact version', /^\d+\.\d+\.\d+$/.test(pkg.dependencies?.electron || ''), pkg.dependencies?.electron);

// 8. CI actions are pinned to a commit and the workflows only read the repository.
for (const f of tracked.filter((x) => /^\.github\/workflows\/.*\.ya?ml$/.test(x))) {
  const wf = read(f);
  const loose = [...wf.matchAll(/uses:\s*([^\s#]+)/g)].map((m) => m[1]).filter((u) => !/@[0-9a-f]{40}$/.test(u));
  check(`${f}: actions pinned to a commit`, !loose.length, loose.join(', '));
  check(`${f}: read-only token by default`, /^permissions:\s*\n\s+contents:\s*read/m.test(wf));
}

console.log(failed ? `\n${failed} security check(s) failed.` : '\nAll security checks passed.');
process.exit(failed ? 1 : 0);
