# session-progress

A Claude Code mod: type `/progress` to open an animated pane beside the chat that shows

- **Overview**: cost, tokens, requests and context fill for the current session, an efficiency score, the current plan's progress, the token mix (tokens vs. cost), context size per request, and where the spend went.
- **What next**: whether to continue, `/compact`, start a new session, or hand work to a subagent, with the token math behind it. A short hint appears above the prompt when switching would clearly pay off.
- **While background work runs** (background shells, subagents, monitors, scheduled wake-ups): the advice stays on this session, and the prompt cache can be kept warm with a tiny request just before it would lapse, until the work is done or the pings would cost more than re-caching.
- **Tips as you go**: after a turn, a new or worsening issue shows above the prompt with a one-click fix, at most every third turn; optionally a one-line note goes to Claude so it adjusts by itself.
- **Loaded but unused**: connectors loaded in the session that this session and this project's past sessions never used, with their per-request token weight and a button to have Claude switch them off (after asking).
- **Tasks**: every prompt you sent, with its share of spend, tools, plan steps and subagents.
- **Tips**: recommendations with evidence and estimated savings, and buttons that hand the fix to Claude or make it a rule in your `~/.claude/CLAUDE.md`.
- **History**: past sessions across your projects, what keeps costing you, and any past session opened in full.
- **Storage & memory**: Claude sessions kept running in the background and other memory-heavy apps (with Quit), and old session logs, old Claude Code versions, finished worktrees, rebuildable folders in idle projects and large old downloads (moved to the Trash, after a confirming press).

Everything is read from your own machine; nothing is sent anywhere. Removed files go to the Trash, where you can restore them until you empty it.

## Install

At the prompt of a terminal session:

```
/plugin install session-progress --marketplace amitvprabhu-lang/session-progress
```

Answer `y` to add the marketplace, then pick a scope (the user scope makes it available in every session).

From a shell:

```
claude plugin install session-progress --marketplace amitvprabhu-lang/session-progress
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `amitvprabhu-lang/session-progress`, then **Add plugin**.

Then type `/progress` in any session.

## Requirements

- A recent Claude Code (2.1.308 or later) with mods.
- The Storage & memory tab uses macOS tools (`ps`, `vm_stat`, `du`, `pbcopy`, `open`, the Trash); the other tabs work everywhere.

## How spend is measured

Every request is priced in input-equivalent tokens with the API's ratios: output ×5, cache write ×1.25 (5-minute) or ×2 (1-hour), cache read ×0.1. Dollar figures share the session's `/cost` total in the same proportions; past sessions use a dollars-per-token rate the mod learns from your current sessions.
