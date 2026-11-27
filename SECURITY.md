# Security policy

## Reporting a vulnerability

Please report it privately: on GitHub, open the **Security** tab of this repository and
choose **Report a vulnerability**. Do not open a public issue. You will get an answer
within a week.

## Supported versions

Only the latest release on npm (`@helpter-tools/ally`) gets fixes.

## What is checked

Every pull request and push to `main` runs `make security` (npm audit at any severity,
npm registry signatures, gitleaks on the whole history, and the guards in
`scripts/security-check.js`), GitHub's dependency review and CodeQL. The same checks run
every Monday, to catch advisories published since. Dependabot proposes updates weekly.
## How Ally handles your data

- No telemetry. Ally talks to Jira (or Atlassian's MCP server) only when you open a list or
  press refresh, and to Anthropic only when plan limits are on.
- Secrets (Jira API token, Atlassian refresh token) are encrypted with the system keychain
  in `~/.ally/jira.json` (mode 600). Linux without a keyring stores them as plain text, and
  the settings say so. The widget's page never receives a token.
- `~/.ally` is private to your account (mode 700): it holds sessions, permission prompts,
  tickets and todos.
- Plan limits are opt-in. Only then does Ally read Claude Code's login, sends it only to
  `api.anthropic.com`, and never stores or refreshes it.
- The widget window only shows Ally's own page: it never navigates elsewhere, opens no
  other window, and the app ignores messages from anything else.
- Plan with Claude passes a ticket's text, which other people write, to Claude. Without a
  ticket skill Claude starts in plan mode, so nothing changes without your approval; still
  read what it proposes.
- Commands (terminals, git, osascript) get their arguments without a shell.
