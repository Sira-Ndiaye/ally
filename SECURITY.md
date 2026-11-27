# Security policy

## Reporting a vulnerability

Please report it privately: on GitHub, open the **Security** tab of this repository and
choose **Report a vulnerability**. Do not open a public issue. You will get an answer
within a week.

## Supported versions

Only the latest release on npm (`@sira-ndiaye/ally`) gets fixes.

## What is checked

Every pull request and push to `main` runs `make security` (npm audit at any severity,
npm registry signatures, gitleaks on the whole history, and the guards in
`scripts/security-check.js`), GitHub's dependency review and CodeQL. The same checks run
every Monday, to catch advisories published since. Dependabot proposes updates weekly.
How Ally handles tokens and private data is described in the README, under
"Security and privacy".
