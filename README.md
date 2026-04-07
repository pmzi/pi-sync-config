# pi-sync-config

A [pi](https://pi.dev) extension that keeps your pi configuration
in sync across machines via a remote git repository.

## What gets synced

| Item             | Path                                                      |
| ---------------- | --------------------------------------------------------- |
| Settings         | `~/.pi/agent/settings.json` (machine-local keys stripped) |
| Keybindings      | `~/.pi/agent/keybindings.json`                            |
| Extensions       | `~/.pi/agent/extensions/`                                 |
| Themes           | `~/.pi/agent/themes/`                                     |
| Skills           | `~/.pi/agent/skills/`                                     |
| Prompt templates | `~/.pi/agent/prompts/`                                    |

**Never synced (secrets & sensitive files):**

| Item                      | Reason                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------- |
| `auth.json`               | API keys and OAuth tokens                                                             |
| `AGENTS.md` / `CLAUDE.md` | User context files — may contain sensitive business logic or proprietary instructions |
| `sessions/`               | Local session history                                                                 |
| `git/`, `npm/`, `bin/`    | Installed packages — reinstalled automatically via `packages` in settings.json        |

### settings.json handling

`settings.json` is safe to sync — pi stores secrets in `auth.json` and
environment variables, never in settings. Before committing, pi-sync strips
machine-local runtime keys (e.g. `lastChangelogVersion`). On pull, incoming
portable config is merged into the local file so machine-specific values
(e.g. `shellPath`) set on this machine are preserved.

## Installation

```bash
pi install npm:pi-sync-config
```

## Setup

Run once after installation:

```
/sync-setup <ssh-repo-url>
```

Optionally set a custom pull interval (default 1 day):

```
/sync-setup git@github.com:you/pi-config.git 60
```

> **SSH only** — HTTPS URLs are rejected. Make sure your SSH key is added to
> your Git host (e.g. `~/.ssh/id_ed25519.pub` → GitHub → Settings → SSH keys).

pi-sync will:

1. Clone (or push to) the remote repo.
2. Watch `settings.json` for changes — every `pi install` automatically
   triggers a push.
3. Pull from the remote every N minutes in the background (default: once a day).

## Commands

| Command                        | Description                             |
| ------------------------------ | --------------------------------------- |
| `/sync-setup <url> [interval]` | First-time setup with a remote git URL  |
| `/sync`                        | Manually push current config to remote  |
| `/sync-pull`                   | Manually pull latest config from remote |
| `/sync-status`                 | Show current config and last sync time  |

## How it works

```
session_start
  └─ pull latest from remote (fast-forward only)
  └─ start periodic pull timer (default every 1440 min / 1 day)
  └─ watch ~/.pi/agent/settings.json for changes

settings.json changes (e.g. after `pi install`)
  └─ debounced 2 s → push to remote

periodic pull timer
  └─ git fetch → check for new commits → pull + apply

session_shutdown
  └─ cancel timer + file watcher
```

Config is stored in `~/.pi/agent/pi-sync.json` (never committed to the repo).
The local git clone lives at `~/.pi/agent/sync-repo/`.

## Conflict handling

Pulls use `--ff-only`. If histories diverge (e.g. two machines pushed
independently), the pull is skipped with an error notification. Fix manually
in `~/.pi/agent/sync-repo/` and run `/sync-pull` again.
