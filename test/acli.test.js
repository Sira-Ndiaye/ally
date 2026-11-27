'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../src/acli');

test('the site and email are read from what acli prints, whatever its layout', () => {
  assert.deepStrictEqual(A.parseStatus('✓ Authenticated\n  Site: Acme.atlassian.net\n  Email: ada@acme.io\n  Authentication Type: api_token'), { site: 'acme.atlassian.net', email: 'ada@acme.io' });
  assert.deepStrictEqual(A.parseStatus('Logged in to https://acme-dev.atlassian.net as ada@acme.io'), { site: 'acme-dev.atlassian.net', email: 'ada@acme.io' });
  assert.deepStrictEqual(A.parseStatus('site acme.atlassian.net'), { site: 'acme.atlassian.net', email: '' });
});

test('nothing is taken when acli is logged out or says nothing useful', () => {
  for (const out of ['', 'You are not logged in. Run acli jira auth login.', 'No accounts found', 'Error: not authenticated (acme.atlassian.net)', 'ok']) {
    assert.equal(A.parseStatus(out), null, out);
  }
});

test('acli is looked for where installers put it, then on the PATH', () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'ally-acli-'));
  assert.deepStrictEqual(A.candidates('linux', t), ['acli']);
  fs.mkdirSync(path.join(t, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(t, '.local', 'bin', 'acli'), '');
  assert.deepStrictEqual(A.candidates('linux', t), [path.join(t, '.local', 'bin', 'acli'), 'acli']);
  assert.deepStrictEqual(A.candidates('win32', t), ['acli']);
});

test('the first acli that answers wins; a failing or logged-out one is skipped', { skip: process.platform === 'win32' }, async () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'ally-acli-'));
  const fake = (name, body) => { const f = path.join(t, name); fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return f; };
  const fails = fake('fails', 'echo "Site: wrong.atlassian.net"; exit 1');
  const out = fake('out', 'echo "You are not logged in"');
  const ok = fake('ok', '[ "$*" = "jira auth status" ] || exit 2; echo "Site: acme.atlassian.net"; echo "Email: ada@acme.io"');
  A.forget();
  assert.deepStrictEqual(await A.status({ bins: [path.join(t, 'missing'), fails, out, ok] }), { site: 'acme.atlassian.net', email: 'ada@acme.io' });
  A.forget();
  assert.equal(await A.status({ bins: [path.join(t, 'missing'), out] }), null);
  A.forget();
  assert.equal(await A.status({ bins: [fake('slow', 'sleep 5; echo "Site: acme.atlassian.net"')], timeout: 300 }), null);
});
