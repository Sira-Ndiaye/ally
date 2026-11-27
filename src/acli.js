'use strict';
// Atlassian's CLI (acli), when it is installed and logged in, knows your Jira site and
// email. Ally asks it with `acli jira auth status` only to pre-fill those two fields of
// the Jira form. It never reads acli's token: you still paste an API token yourself.
// The command's output has no documented format, so only an *.atlassian.net site and an
// email address are taken from it, and nothing when acli fails or says it is logged out.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const SITE = /\b([a-z0-9][a-z0-9-]*\.atlassian\.net)\b/i;
const EMAIL = /\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i;
const LOGGED_OUT = /\b(not (logged|signed) in|not authenticated|unauthenticated|no (active )?accounts?|log ?in first|please (log|sign) ?in)\b/i;

function parseStatus(text) {
  const s = String(text || '');
  if (!s.trim() || LOGGED_OUT.test(s)) return null;
  const site = (s.match(SITE) || [])[1];
  const email = (s.match(EMAIL) || [])[1];
  if (!site && !email) return null;
  return { site: site ? site.toLowerCase() : '', email: email || '' };
}

// An app started at login lacks the shell's PATH, so the usual install places come first.
function candidates(platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') return ['acli'];
  const places = platform === 'darwin'
    ? ['/opt/homebrew/bin/acli', '/usr/local/bin/acli', path.join(home, '.local', 'bin', 'acli')]
    : [path.join(home, '.local', 'bin', 'acli'), '/usr/local/bin/acli', '/usr/bin/acli'];
  return [...places.filter((p) => fs.existsSync(p)), 'acli'];
}

function run(bin, timeout) {
  return new Promise((resolve) => {
    execFile(bin, ['jira', 'auth', 'status'], { timeout, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve(err ? null : parseStatus(`${stdout}\n${stderr}`));
    });
  });
}

// { site, email } from the first acli that answers, or null. Asked once per run.
let asked = null;
function status({ bins = candidates(), timeout = 4000 } = {}) {
  if (!asked) {
    asked = (async () => {
      for (const bin of bins) {
        const r = await run(bin, timeout);
        if (r) return r;
      }
      return null;
    })();
  }
  return asked;
}
const forget = () => { asked = null; };

module.exports = { parseStatus, candidates, status, forget };
