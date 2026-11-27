# Roadmap: Claude Meter becomes Ally

Design and reasoning: `docs/jira-projects-design.html`. Decided on 17 Nov 2026.

Ally keeps usage and sessions, merges todos and Jira tickets into one Tasks tab,
adds projects, and gets a projects board on claude.ai. Two rules hold in every phase:

- **Few Claude tokens.** Reading, filtering and moving tickets go straight to Jira's
  REST API. Claude is used only to plan a ticket and for a project's one-sentence next
  step. Update board sends checklist projects to the board with no Claude at all.
- **Nothing refreshes on its own in the background.** Lists refresh when you open
  them or press refresh.

Each phase ships on its own, with unit tests, the smoke test (`npm run smoke`) and CI
green on Linux, macOS and Windows.

## Phase 0: Rename to Ally

- npm package `@sira-ndiaye/ally`, command `ally`, window and tray title "Ally".
- Description says in plain text that it works with Claude Code. No Claude or
  Anthropic name in the product name and no logo (Anthropic's trademark guidelines).
- Data folder moves from `~/.claude-meter` to `~/.ally` on first start.
- `ally setup` replaces the old hooks, launchers and start-at-login entries.
- Rename the GitHub repository; README and CI follow.

Done when an existing Claude Meter install keeps its settings and todos after
upgrading, on all three systems.

## Phase 1: Spike (about two days)

Answers the questions the later phases depend on. Nothing here ships.

- An artifact page lists one epic's tickets through the Atlassian connector
  (`mcp` capability): tool names, arguments, paging, limits.
- A link from the widget opens the artifact on a `#name` view.
- A terminal opens with `claude --permission-mode plan -n KEY "..."` on macOS
  (Terminal, iTerm2), Windows (Windows Terminal, console) and Linux (gnome-terminal,
  konsole, default terminal).
- Measure the tokens of one board update run (`claude -p` publishing a file).
  Result: `claude -p` has no artifacts tools, so it cannot publish. Replaced on
  18 Nov 2026 by a clipboard hand-off (see Phase 5).

## Phase 2: Tasks tab, read only

- Settings: Jira site, email, API token (kept with Electron `safeStorage`).
- One JQL search: assigned to me, OR watched by me, OR any followed label.
  Only the fields shown; at most 100 tickets.
- Status chips, scope chips (Mine, Following, each label, Personal), "+ label".
- Changed 18 Nov 2026: the list shows only your tickets (assigned to you), so the search,
  the chips (Mine, Personal) and the ticket menu dropped watched tickets and followed labels.
- Ticket rows: priority, due date, assignee initials when not you, blocked marker.
- Todos appear in the same list (Personal), with To Do / In Progress / Done.
- Refresh when the tab opens and with a refresh button. No background polling.

## Phase 3: Actions

- Ticket menu: Move to (allowed transitions, fetched when the menu opens), Plan with
  Claude, Follow ticket (Jira watch), Follow its label, Open in Jira, Copy key.
- Todo menu: Send to Jira (creates a ticket), Add to project, Plan with Claude.
  (Add to project needs projects: it comes with Phase 4.)
- Plan with Claude is one click: skill and repository worked out from local files
  (rules in the design), notice with Change, Change remembered per Jira project.

## Phase 4: Projects tab

- Projects kept in `~/.ally/projects.json`. Kinds: epic, label, checklist
  (a checklist project's items are todos).
- Progress: epic and label from Jira; checklist from its todos.
- Project menu: Open its page, Edit checklist, Create a Jira epic for it,
  Link to an epic or label, Rename, Archive. Follow someone else's epic or label.

## Phase 5: Projects board on claude.ai

- One artifact: the board, and one `#name` view per project, animated.
- Epic and label projects read live through the Atlassian connector, with a refresh
  button; no polling.
- Checklist projects reach the board only through the widget's Update board button,
  with no Claude and nothing written to Atlassian:
  - Ally copies the checklists to the clipboard as `{v, at, sha, data}` (SHA-256 of
    the data's JSON with sorted keys, since db sorts keys) and opens
    `<board>#<project>~paste`.
  - The board shows a paste box; you click it and press ⌘V (Ctrl+V). A bare ⌘V never
    reaches the page, and the address cannot carry the data: claude.ai drops a `#part`
    longer than about 100 to 250 characters.
  - The page checks the hash, cleans the address to `#<project>` with
    `history.replaceState`, and saves the copy in the artifact's db under
    `data/users/<id>/checklists`, private to you. Later visits read it, shown as
    "Updated <time> from Ally".
  - The board declares `mcp`, `db` and `user`.
- Built 18 Nov 2026: `board/` (page, styles, script) with `src/projects.js` shared with the
  widget; published as a private artifact. The
  hand-off package carries the project list too (the board cannot read
  `projects.json`): active projects, checklist items, the Jira site, the account id and
  the Flagged field. The next step uses the `sample` capability.
- A project's next-step sentence from Claude, on click, kept until its tickets change.
- Private to you.

## Optional parts (27 Nov 2026)

- Settings has a Show row: Jira tickets, Projects. Unchecked, they leave the main display
  (no Projects tab; no tickets, Mine chip, refresh or Send to Jira in Tasks). Personal tasks stay.
- Saved as `prefs.features`. New installs start with both off; an older install keeps Jira on
  if it is connected and Projects on if it has an active project.

## Phase 6: Priority matrix (built 27 Nov 2026)

Option A of `docs/next-steps.html`, chosen by you.

- List | Matrix switch in Tasks, remembered (`prefs.tasksView`). Four squares: Do now, Plan,
  Quick win, Later. Urgent: due within 2 days or late; a todo with no date means today.
  Important: P1 or P2. Done tasks are left out; the scope chips still apply.
- Drag (or arrow keys) changes only what must change: priority to P1 or P3, due date to today
  or 7 days away. Tickets: one `PUT /rest/api/3/issue/KEY` (`editJiraIssue` through Atlassian
  sign-in), priority sent by the name this site's tickets use most. Shown at once, put back
  with a notice if Jira refuses. Logic in `src/matrix.js`.

Next: release 0.1.0 on npm, then Phase 7 (focus: top Do now task in the compact bar, a
#matrix view on the board, first-run screen for the optional parts).

## Security review (27 Nov 2026)

Done before the first public push, against OWASP Top 10, Electron's checklist and OWASP LLM01.
- The window cannot navigate or open windows; IPC only from Ally's own page; explicit
  contextIsolation, sandbox, no nodeIntegration; browser permissions refused.
- Prompt answers accepted only for a prompt waiting now; `focus` takes an integer pid only.
- `~/.ally` is 700, files 600 (app and hook).
- Plan limits opt-in (`prefs.features.limits`, off by default, existing installs included).
- `overrides`: xml2js 0.6, usocket 1.1 (npm audit: 0 vulnerabilities).
- No shell in the Linux sandbox fix; paths escaped in launcher, .desktop, plist, hook command.
- Session rows built as text. Smoke test checks navigation, private folder and limits off.

Second pass, same day: Electron 44.9.3 → 44.11.6 (Chromium security fixes); git calls
run with `core.fsmonitor=false`; CI token read-only and actions pinned to commits.
Automated from then on: `make security` (npm audit, registry signatures, gitleaks,
`scripts/security-check.js` guards) on every pull request, push to main and Monday, plus
dependency review and CodeQL (`.github/workflows/security.yml`) and weekly Dependabot.
