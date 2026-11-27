# Ally

A floating, translucent, always-on-top widget that works with Claude Code: usage, sessions,
priority todos. Runs on Linux, macOS and Windows.

Ally was called Claude Meter. Upgrading keeps your data: on first start it moves
`~/.claude-meter` to `~/.ally`, and `ally setup` replaces the old hooks, menu entries and
start at login.

## Plan limits (opt-in)

The Usage tab always shows today's tokens and replies, read from Claude Code's local logs.
Your plan's 5-hour and weekly limits are off by default: tick **Usage limits** under
**Show** in Settings to see them. Ally then reads Claude Code's login on this computer
(`~/.claude/.credentials.json`, or the Keychain on macOS) and asks Anthropic for the
limits Claude Code's `/usage` shows. That endpoint is not documented and may change.
The login is only sent to `api.anthropic.com`, never stored, never refreshed by Ally.
Untick it and Ally stops reading it and deletes the saved limits.

## Top bar

With plan limits on, the 5h session usage also shows in the top bar (next to Wi-Fi): the Ally icon
with the percentage beside it on Linux and macOS (icon and tooltip only on Windows). A red dot (⚑ on macOS) means a session needs your input.
Its menu lists every limit and shows or hides the widget.
GNOME needs the AppIndicator extension (enabled by default on Ubuntu).

## Jumping to a session

Clicking a session raises its terminal and selects its tab: gnome-terminal on Linux
(needs `xdotool`), Terminal and iTerm2 on macOS. Other terminals are raised without tab selection.
macOS asks once for permission to control the terminal app, and, with plan limits on,
once for Keychain access (that is where Claude Code keeps its login there).

## Answering a session from the widget

When a session asks a question or needs a permission, the widget fades in by itself (from the
compact bar or from hidden) with the options and a free-text line. Click an option or type your own
answer: it goes to the session without its terminal taking focus. The terminal prompt stays open, so
you can answer there instead, and the widget closes. Double-click the card to open that terminal.
Once nothing is waiting the widget goes back to how it was.

## Tasks

Your Jira tickets and personal todos in one list. Jira tickets and the Projects tab are
optional: tick them under **Show** in Settings (the gear). Connect Jira from the Tasks tab with
**Sign in with Atlassian**: your browser opens Atlassian's consent page, you choose what Ally
may do, and Ally finds your Jira site. Ally then talks to Jira through Atlassian's MCP server
(`mcp.atlassian.com`), signed in as you; no Claude tokens are used. It registers itself with
Atlassian on the fly, so no secret ships with it, and keeps only a refresh token, encrypted
with the system keychain. If you leave out write access, Ally shows your tickets but cannot
move, follow or create them, and says so.

If your company's Atlassian admin does not let apps sign in that way, use an
[API token](https://id.atlassian.com/manage-profile/security/api-tokens) instead (Use an API
token instead, under the button): Ally then reads Jira's REST API with your email and token.
If [Atlassian's CLI](https://developer.atlassian.com/cloud/acli/) (`acli`) is installed and
logged in, that form starts with its site and email (from `acli jira auth status`); its
token is never read.

- **List | Matrix**: the Matrix view sorts open tasks into Do now, Plan, Quick win and Later.
  Urgent means due within 2 days or late (a todo with no date means today); important means
  P1 or P2. Drag a task to another square, or use the arrow keys: Ally changes only what it
  must (priority to P1 or P3, due date to today or a week away) and writes a ticket's change
  straight to Jira.
- One search lists your tickets, the ones assigned to you, at most 100. Done tickets stay
  for a week.
- Status chips (To Do, In Progress, Done) and scope chips (Mine for your tickets, Personal
  for your todos) filter the list. With no chip pressed in a row, that row does not filter.
- A ticket shows its priority, due date, and `blocked` when an open ticket blocks it or it
  is flagged. Click it to open it in Jira.
- Click a todo's ring to move it from To Do to In Progress to Done.
- Jira is read when you open the tab or press refresh, never in the background.

Right-click a row for its menu:

- Ticket: Move to (the moves its workflow allows, fetched when the menu opens), Plan with
  Claude, Open in Jira, Copy key.
- Todo: Send to Jira (becomes a ticket in one of your projects, assigned to you), Plan
  with Claude, Delete.

Plan with Claude opens a terminal at once, running `claude` in a session named after the
ticket, so it shows in Sessions. Ally picks the skill and folder from files on this computer:

- Skill: the one you chose with Change for that Jira project; else one whose name, then
  description, mentions Jira or tickets (the repository's first, then yours, then plugins').
  It runs as `/skill KEY` in normal mode. With no such skill, a built-in prompt runs in plan mode.
- Folder: the one you chose with Change; else a folder where you used Claude Code with a git
  branch for this ticket, then the most branches for the project; else a folder named like
  the project; else your home folder, and Claude is told the repository is unknown.
- The ticket's title, status, labels, links and description go in the prompt, so Claude
  does not spend turns fetching it.

A notice says what was chosen. Change picks another skill or folder, runs again, and is
remembered for every ticket of that project (in `~/.ally/plan.json`).

## Projects

A project measures its progress from a Jira epic, a Jira label, or a checklist of your
own todos. Projects live in `~/.ally/projects.json`. Opening the tab, or pressing refresh,
runs one Jira search for every linked epic and label; checklists need none.

- Each card shows progress, the due date (the project's own, else the epic's, else the
  last open ticket's for a label) and a health:
  Done when everything is done, Blocked when an open item is blocked, At risk when past
  due with work left or due within a week with more than a fifth left, Not started when
  nothing is done or under way, otherwise On track.
- Click a card for its details. A checklist's items are todos: they show under Personal in
  Tasks too, and a todo's menu has Add to project.
- New project, or Follow a project for someone else's epic or label (the epic's assignee
  shows as its owner).
- Right-click a project: Open its page (with the board), Edit checklist, Create a Jira epic
  for it (the epic, then one ticket under it for each open item), Link to an epic or label,
  Rename, Archive. Renaming keeps the project's page address.

### The projects board on claude.ai

`board/` is a page for claude.ai: one board of all your projects (`#board`) and one view
per project (`#<id>`, the id Ally gave it), with its items in To do, In progress and Done.

- Epic and label projects are read live from Jira through your claude.ai Atlassian
  connector when the page opens and when you press Refresh from Jira. Nothing refreshes
  on its own, and reading costs no Claude usage.
- Checklist projects, and the list of projects itself, come from Ally. Press
  **Update board** in the Projects tab: Ally copies them to the clipboard and opens the
  board, where you click the paste box and press ⌘V (Ctrl+V). The page checks what was
  pasted and keeps it in its own storage, private to you, until the next update. No
  Claude, and nothing written to Atlassian. Right-click Update board to open the board or
  change its address.
- On a project's view, Suggest the next step asks Claude (on your claude.ai usage) for one
  sentence. It is kept until that project's items change.

To make your own board, ask Claude Code to publish the files of `board/` together with
`src/projects.js` as an artifact, and to declare its capabilities: `mcp` for the
`Atlassian MCP` server with `searchJiraIssuesUsingJql`, `db`, `user` and `sample`. The
first Update board asks for the board's address (`https://claude.ai/artifact/…`).

## Install

From npm (Linux, macOS, Windows; needs Node 22.12 or newer):

    npm install -g @sira-ndiaye/ally
    ally setup                  # hooks, app menu entry, start at login, then start
    ally setup --no-autostart   # same, without start at login
    ally                        # start it later
    ally remove                 # undo setup, then: npm uninstall -g @sira-ndiaye/ally

The first run downloads Electron (about 100 MB). On Ubuntu 24.04 and newer, setup asks for
sudo once to enable Electron's sandbox.

From a source checkout:

    git clone https://github.com/Sira-Ndiaye/ally.git && cd ally
    ./install.sh                 # Linux, macOS, Windows (Git Bash)
    ./install.sh --no-autostart  # same, without starting at login
    ./install.sh --remove        # remove hooks, launcher and autostart

It installs the dependencies, adds the Claude Code hooks to `~/.claude/settings.json`
(backup made first), adds a launcher, starts the widget at login, and starts it now.
Needs Node 22.12 or newer.

## Run from source

    nvm use            # Node 22
    npm install
    npm start

## Session tracking

Sessions come from Claude Code hooks that write `~/.ally/sessions/<id>.json`.
Terminal sessions show as soon as they start. Sessions without a terminal (the Claude desktop
app's Code tab) show after their first prompt. One-shot `claude -p` runs and cloud sessions
(claude.ai/code) are not listed.

    npm run hooks:preview   # show what would change in ~/.claude/settings.json
    npm run hooks:install   # apply (backup made first)
    npm run hooks:remove    # undo

Data lives in `~/.ally/` (sessions, todos.json, window.json, jira.json, jira-cache.json,
plan.json, projects.json, projects-cache.json).

## Width

The window cannot be resized by dragging. Its width is a preference: click the gear in the
header and move the Width slider (300 to 600 px). It is saved in `window.json` and kept across restarts.

## Tests and checks

    make check       # unit tests + every security check (what a pull request must pass)
    make security    # npm audit, registry signatures, security guards, gitleaks
    make smoke       # end-to-end test of the real app
    make git-hooks   # run make security before each git push

`npm test` and `npm run smoke` work too. Without `make` (Windows), run
`node scripts/security-check.js` for the guards.

## Command, app menu and autostart

    npm run desktop:install     # `ally` command (Linux, macOS), app menu entry (Linux), Start menu shortcut (Windows)
    npm run desktop:autostart   # same, plus start at login
    npm run desktop:remove      # undo all of it

## Security and privacy

- No telemetry. Ally talks only to Jira (or Atlassian's MCP server) when you open a list or
  press refresh, and to Anthropic only with plan limits on.
- Secrets (Jira API token, Atlassian refresh token) are encrypted with the system keychain
  in `~/.ally/jira.json` (mode 600). Linux without a keyring stores them as plain text, and
  the settings say so. The widget's page never receives a token.
- `~/.ally` is private to your account (mode 700): it holds sessions, permission prompts,
  tickets and todos.
- The widget window only shows Ally's own page: it never navigates elsewhere, opens no other
  window, and the app ignores messages from anything else.
- Plan with Claude passes a ticket's text, which other people write, to Claude. Claude starts
  in plan mode, so nothing changes without your approval; still read what it proposes.
- Commands (terminals, git, osascript) get their arguments without a shell.

Report a vulnerability privately: see [SECURITY.md](SECURITY.md).

## License

MIT, see [LICENSE](LICENSE).
