/**
 * pi-sync-config Extension
 *
 * Syncs your pi config (settings, extensions, themes, skills, prompts) to a
 * remote git repository. Automatically pushes after package installs (by
 * watching settings.json) and periodically pulls updates from the remote.
 *
 * Commands:
 *   /sync-setup <repo-url> [interval-minutes]  — first-time setup
 *   /sync          — push current config to remote
 *   /sync-pull     — pull latest config from remote
 *   /sync-status   — show sync info
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

// ─── Paths ────────────────────────────────────────────────────────────────────

const PI_DIR =
  process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");

/**
 * Files at the root of ~/.pi/agent/ to include in the sync.
 * AGENTS.md / CLAUDE.md are intentionally excluded — they are user-written
 * context files that may contain sensitive business logic or proprietary
 * instructions and are not pi configuration.
 */
const ROOT_FILES = ["keybindings.json"];

/**
 * Keys to strip from settings.json before committing.
 * These are runtime/machine-local state, not portable configuration.
 */
const SETTINGS_STRIP_KEYS = new Set(["lastChangelogVersion"]);

/** Sub-directories of ~/.pi/agent/ to sync recursively */
const SYNC_DIRS = ["extensions", "themes", "skills", "prompts"];

/** Always excluded — never committed to the repo */
const NEVER_SYNC = new Set([
  "auth.json",
  "sessions",
  "git",
  "npm",
  "bin",
  "sync-repo",
  "pi-sync.json",
]);

// ─── Config ───────────────────────────────────────────────────────────────────

interface SyncConfig {
  /** Remote git URL (SSH only, e.g. git@github.com:user/repo.git) */
  repoUrl: string;
  /** Absolute path for the local clone */
  localRepoPath: string;
  /** How often to pull from remote, in minutes (default: 1440 = 1 day) */
  pullIntervalMinutes: number;
  /** ISO timestamp of the last successful sync */
  lastSyncAt?: string;
}

const CONFIG_FILE = path.join(PI_DIR, "pi-sync.json");

function loadConfig(): SyncConfig | null {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as SyncConfig;
    // Reject HTTPS URLs that may have been saved before the validation was added.
    // HTTPS prompts for a username interactively and blocks the process.
    if (/^https?:\/\//i.test(cfg.repoUrl)) return null;
    return cfg;
  } catch {
    return null;
  }
}

function saveConfig(cfg: SyncConfig): void {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

// ─── File utilities ───────────────────────────────────────────────────────────

async function copyRecursive(src: string, dest: string): Promise<void> {
  const stat = await fsp.stat(src);
  if (stat.isDirectory()) {
    await fsp.mkdir(dest, { recursive: true });
    for (const entry of await fsp.readdir(src)) {
      await copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(src, dest);
  }
}

async function removeRecursive(target: string): Promise<void> {
  try {
    await fsp.rm(target, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ─── Core sync logic ──────────────────────────────────────────────────────────

/**
 * Copy pi config files into the local repo directory (staging step before commit).
 */
async function stageFiles(cfg: SyncConfig): Promise<void> {
  const dest = cfg.localRepoPath;
  await fsp.mkdir(dest, { recursive: true });

  // Root-level files
  for (const file of ROOT_FILES) {
    const src = path.join(PI_DIR, file);
    if (fs.existsSync(src)) {
      await fsp.copyFile(src, path.join(dest, file));
    }
  }

  // settings.json — copy but strip machine-local / runtime-state keys
  const settingsSrc = path.join(PI_DIR, "settings.json");
  if (fs.existsSync(settingsSrc)) {
    const raw = JSON.parse(await fsp.readFile(settingsSrc, "utf8")) as Record<
      string,
      unknown
    >;
    for (const key of SETTINGS_STRIP_KEYS) delete raw[key];
    await fsp.writeFile(
      path.join(dest, "settings.json"),
      JSON.stringify(raw, null, 2) + "\n",
      "utf8",
    );
  }

  // Directories — wipe old snapshot then copy fresh
  for (const dir of SYNC_DIRS) {
    const src = path.join(PI_DIR, dir);
    const destDir = path.join(dest, dir);
    if (fs.existsSync(src)) {
      await removeRecursive(destDir);
      await copyRecursive(src, destDir);
    }
  }

  // Write a .gitignore so the repo never accidentally contains sensitive files
  const gitignore =
    [
      "# Secrets & credentials — never sync these",
      "auth.json",
      "",
      "# Runtime / machine-local state",
      "sessions/",
      "git/",
      "npm/",
      "bin/",
      "sync-repo/",
      "pi-sync.json",
      "*.log",
      "",
      "# User context files (may contain sensitive business logic)",
      "AGENTS.md",
      "CLAUDE.md",
    ].join("\n") + "\n";
  await fsp.writeFile(path.join(dest, ".gitignore"), gitignore, "utf8");
}

/**
 * Apply repo contents back to ~/.pi/agent/.
 * Only overwrites files that are tracked in ROOT_FILES / SYNC_DIRS.
 */
async function applyFiles(cfg: SyncConfig): Promise<void> {
  const src = cfg.localRepoPath;

  // keybindings and other plain root files
  for (const file of ROOT_FILES) {
    const repoFile = path.join(src, file);
    if (fs.existsSync(repoFile)) {
      await fsp.copyFile(repoFile, path.join(PI_DIR, file));
    }
  }

  // settings.json — merge into existing settings rather than overwrite,
  // so machine-local values (e.g. shellPath) set on this machine are preserved.
  const repoSettings = path.join(src, "settings.json");
  if (fs.existsSync(repoSettings)) {
    const incoming = JSON.parse(
      await fsp.readFile(repoSettings, "utf8"),
    ) as Record<string, unknown>;
    const localSettingsPath = path.join(PI_DIR, "settings.json");
    const local: Record<string, unknown> = fs.existsSync(localSettingsPath)
      ? (JSON.parse(await fsp.readFile(localSettingsPath, "utf8")) as Record<
          string,
          unknown
        >)
      : {};
    // Incoming portable config wins; machine-local runtime state is kept from local
    const merged = { ...local, ...incoming };
    await fsp.writeFile(
      localSettingsPath,
      JSON.stringify(merged, null, 2) + "\n",
      "utf8",
    );
  }

  for (const dir of SYNC_DIRS) {
    const repoDir = path.join(src, dir);
    if (fs.existsSync(repoDir)) {
      const destDir = path.join(PI_DIR, dir);
      await removeRecursive(destDir);
      await copyRecursive(repoDir, destDir);
    }
  }
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let config: SyncConfig | null = null;
  let pullTimer: ReturnType<typeof setInterval> | null = null;
  let settingsWatcher: fs.FSWatcher | null = null;
  let syncDebounce: ReturnType<typeof setTimeout> | null = null;

  // ── Push: copy → commit → push ─────────────────────────────────────────────

  async function pushToRemote(ctx?: {
    ui: { notify: (msg: string, level: string) => void };
  }): Promise<void> {
    if (!config) return;
    const repo = config.localRepoPath;

    try {
      // Clone if the local repo doesn't exist yet
      if (!fs.existsSync(path.join(repo, ".git"))) {
        ctx?.ui.notify("pi-sync: cloning remote repository…", "info");
        const { code, stderr } = await pi.exec(
          "git",
          ["clone", config.repoUrl, repo],
          { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
        );
        if (code !== 0) throw new Error(stderr || "git clone failed");
      }

      await stageFiles(config);

      // Commit only when there are actual changes
      const { stdout: statusOut } = await pi.exec(
        "git",
        ["-C", repo, "status", "--porcelain"],
        { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      );
      if (!statusOut.trim()) {
        // nothing changed
        return;
      }

      const gitEnv = { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } };
      await pi.exec("git", ["-C", repo, "add", "-A"], gitEnv);
      const msg = `pi-sync: ${new Date().toISOString()}`;
      await pi.exec("git", ["-C", repo, "commit", "-m", msg], gitEnv);

      const { code: pushCode, stderr: pushErr } = await pi.exec(
        "git",
        ["-C", repo, "push"],
        gitEnv,
      );
      if (pushCode !== 0) throw new Error(pushErr || "git push failed");

      config.lastSyncAt = new Date().toISOString();
      saveConfig(config);
      ctx?.ui.notify("pi-sync ✓ pushed config to remote", "success");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      ctx?.ui.notify(`pi-sync push error: ${message}`, "error");
    }
  }

  // ── Pull: fetch → merge → apply ────────────────────────────────────────────

  async function pullFromRemote(ctx?: {
    ui: { notify: (msg: string, level: string) => void };
  }): Promise<void> {
    if (!config) return;
    const repo = config.localRepoPath;

    try {
      // If repo doesn't exist locally yet, do an initial push first
      if (!fs.existsSync(path.join(repo, ".git"))) {
        await pushToRemote(ctx);
        return;
      }

      const pullGitEnv = { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } };
      const { code: fetchCode, stderr: fetchErr } = await pi.exec(
        "git",
        ["-C", repo, "fetch", "--quiet"],
        pullGitEnv,
      );
      if (fetchCode !== 0) throw new Error(fetchErr || "git fetch failed");

      // Check if remote has new commits
      const { stdout: revList } = await pi.exec(
        "git",
        ["-C", repo, "rev-list", "HEAD..@{u}", "--count"],
        pullGitEnv,
      );
      const newCommits = parseInt(revList.trim(), 10);
      if (isNaN(newCommits) || newCommits === 0) return; // already up to date

      const { code: pullCode, stderr: pullErr } = await pi.exec(
        "git",
        ["-C", repo, "pull", "--ff-only"],
        pullGitEnv,
      );
      if (pullCode !== 0) {
        // Fast-forward failed — diverged history; warn and skip applying
        throw new Error(
          pullErr || "git pull (fast-forward) failed — histories have diverged",
        );
      }

      await applyFiles(config);
      config.lastSyncAt = new Date().toISOString();
      saveConfig(config);
      ctx?.ui.notify(
        `pi-sync ✓ pulled ${newCommits} update(s) from remote — restart pi to activate changes`,
        "info",
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      ctx?.ui.notify(`pi-sync pull error: ${message}`, "error");
    }
  }

  // ── Watchers & timers ──────────────────────────────────────────────────────

  function startPullTimer(ctx: Parameters<typeof pullFromRemote>[0]): void {
    if (pullTimer) clearInterval(pullTimer);
    const intervalMs =
      Math.max(1, config?.pullIntervalMinutes ?? 1440) * 60 * 1000;
    pullTimer = setInterval(() => pullFromRemote(ctx), intervalMs);
  }

  function startSettingsWatcher(ctx: Parameters<typeof pushToRemote>[0]): void {
    if (settingsWatcher) settingsWatcher.close();
    const settingsPath = path.join(PI_DIR, "settings.json");
    try {
      settingsWatcher = fs.watch(settingsPath, () => {
        // Debounce rapid writes (e.g. pi writes settings.json multiple times)
        if (syncDebounce) clearTimeout(syncDebounce);
        syncDebounce = setTimeout(() => pushToRemote(ctx), 2000);
      });
    } catch {
      // settings.json doesn't exist yet; watcher will be recreated next session
    }
  }

  function cleanup(): void {
    if (pullTimer) {
      clearInterval(pullTimer);
      pullTimer = null;
    }
    if (settingsWatcher) {
      settingsWatcher.close();
      settingsWatcher = null;
    }
    if (syncDebounce) {
      clearTimeout(syncDebounce);
      syncDebounce = null;
    }
  }

  // ── Lifecycle events ───────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig();

    if (!config) {
      // loadConfig returns null for missing file OR for a stored HTTPS URL.
      // Distinguish the two so we can show a useful message.
      const raw = (() => {
        try {
          return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as SyncConfig;
        } catch {
          return null;
        }
      })();
      if (raw && /^https?:\/\//i.test(raw.repoUrl)) {
        ctx.ui.setStatus(
          "pi-sync",
          "⚠ stored URL is HTTPS — re-run /sync-setup with an SSH URL",
        );
        ctx.ui.notify(
          "pi-sync: the stored repo URL is HTTPS, which requires interactive auth and will block startup.\n" +
            "Please re-run /sync-setup with an SSH URL, e.g. git@github.com:you/pi-config.git",
          "error",
        );
      } else {
        ctx.ui.setStatus(
          "pi-sync",
          "not configured — run /sync-setup <repo-url>",
        );
      }
      return;
    }

    ctx.ui.setStatus("pi-sync", `→ ${config.repoUrl}`);

    // Pull any remote changes since last session
    await pullFromRemote(ctx.ui ? ctx : undefined);

    startPullTimer(ctx.ui ? ctx : undefined);
    startSettingsWatcher(ctx.ui ? ctx : undefined);
  });

  pi.on("session_shutdown", async () => {
    cleanup();
  });

  // ── Commands ───────────────────────────────────────────────────────────────

  pi.registerCommand("sync-setup", {
    description:
      "Configure pi-sync: /sync-setup [git-repo-url] [pull-interval-minutes]",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);

      // Prompt for repo URL if not provided
      let repoUrl = parts[0];
      if (!repoUrl) {
        const entered = await ctx.ui.input(
          "Git repository URL (SSH):",
          "git@github.com:you/pi-config.git",
        );
        if (!entered || !entered.trim()) {
          ctx.ui.notify(
            "pi-sync: setup cancelled — no repository URL provided",
            "error",
          );
          return;
        }
        repoUrl = entered.trim();
      }

      // Reject plain HTTPS URLs — SSH is required for non-interactive auth
      if (/^https?:\/\//i.test(repoUrl)) {
        ctx.ui.notify(
          "pi-sync: HTTPS URLs are not supported. Please use an SSH URL, e.g. git@github.com:you/pi-config.git",
          "error",
        );
        return;
      }

      // Prompt for pull interval if not provided
      let intervalMin: number;
      if (parts[1] !== undefined) {
        intervalMin = parseInt(parts[1], 10);
      } else {
        const existing = config?.pullIntervalMinutes;
        const defaultVal = existing ? String(existing) : "1440";
        const entered = await ctx.ui.input(
          "Pull interval (minutes):",
          defaultVal,
        );
        intervalMin = parseInt((entered ?? defaultVal).trim(), 10);
      }

      if (isNaN(intervalMin) || intervalMin < 1) {
        ctx.ui.notify(
          "pull-interval-minutes must be a positive number",
          "error",
        );
        return;
      }

      cleanup();

      config = {
        repoUrl,
        localRepoPath: path.join(PI_DIR, "sync-repo"),
        pullIntervalMinutes: intervalMin,
      };
      saveConfig(config);

      ctx.ui.notify(
        `pi-sync: configured — remote: ${repoUrl}, pull every ${intervalMin}m`,
        "info",
      );
      ctx.ui.setStatus("pi-sync", `→ ${repoUrl}`);

      // Initial push
      await pushToRemote(ctx);
      startPullTimer(ctx);
      startSettingsWatcher(ctx);
    },
  });

  pi.registerCommand("sync", {
    description: "Push current pi config to the remote git repository",
    handler: async (_args, ctx) => {
      if (!config) {
        ctx.ui.notify(
          "pi-sync: not configured — run /sync-setup <repo-url>",
          "error",
        );
        return;
      }
      await pushToRemote(ctx);
    },
  });

  pi.registerCommand("sync-pull", {
    description: "Pull latest pi config from the remote git repository",
    handler: async (_args, ctx) => {
      if (!config) {
        ctx.ui.notify(
          "pi-sync: not configured — run /sync-setup <repo-url>",
          "error",
        );
        return;
      }
      await pullFromRemote(ctx);
    },
  });

  pi.registerCommand("sync-status", {
    description: "Show pi-sync configuration and last sync time",
    handler: async (_args, ctx) => {
      if (!config) {
        ctx.ui.notify(
          "pi-sync: not configured — run /sync-setup <repo-url>",
          "info",
        );
        return;
      }
      const last = config.lastSyncAt
        ? new Date(config.lastSyncAt).toLocaleString()
        : "never";
      const msg = [
        `Remote:   ${config.repoUrl}`,
        `Local:    ${config.localRepoPath}`,
        `Interval: every ${config.pullIntervalMinutes} min`,
        `Last sync: ${last}`,
      ].join("\n");
      ctx.ui.notify(msg, "info");
    },
  });
}
