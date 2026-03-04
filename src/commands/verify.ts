/**
 * canon verify — multi-axis validation for web app pipeline alignment.
 *
 * Axis 1: Structure  — 7 canon compliance checks (offline)
 * Axis 2: Format     — episode_id_format, title_bilingual, synopsis_bilingual
 * Axis 3: Auth       — token valid + web app reachable
 * Axis 4: Registry   — repo registered on opencanon.co
 * Axis 5: Sync       — canon.lock.json exists + matches git HEAD
 *
 * Exit 0: all axes pass
 * Exit 1: any axis fails
 */

import { Command } from "commander"
import { resolve, join } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { execSync } from "node:child_process"
import { loadRepoFromFs } from "../adapters/fs.js"
import { validateRepo, checkFormat } from "../core/validate.js"
import { SchemaVersionError } from "../core/contract.js"
import { loadConfig } from "./login.js"
import { ApiClient } from "../api.js"

// ─── Helpers ──────────────────────────────────────────────────────────────────
function pass(label: string, detail?: string) {
  console.log(`  ✓ ${label}${detail ? `  — ${detail}` : ""}`)
}
function fail(label: string, detail?: string) {
  console.log(`  ✗ ${label}${detail ? `  — ${detail}` : ""}`)
}
function warn(label: string, detail?: string) {
  console.log(`  ⚠ ${label}${detail ? `  — ${detail}` : ""}`)
}

function detectOwnerRepo(root: string): { owner: string; repo: string } {
  let owner = "unknown"
  let repo = root.split("/").pop() || "canon"
  const rcPath = join(root, ".canonrc.json")
  if (existsSync(rcPath)) {
    try {
      const rc = JSON.parse(readFileSync(rcPath, "utf-8"))
      if (rc.author) owner = rc.author
    } catch { /* ignore */ }
  }
  try {
    const remote = execSync("git remote get-url origin", {
      cwd: root, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"]
    }).trim()
    const m = remote.match(/github\.com[:/]([^/]+)\/([^/.\s]+)/)
    if (m) { owner = m[1]; repo = m[2].replace(/\.git$/, "") }
  } catch { /* no remote */ }
  return { owner, repo }
}

function getGitHead(root: string): string | null {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: root, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"]
    }).trim()
  } catch { return null }
}

// ─── Command ──────────────────────────────────────────────────────────────────

export const verifyCommand = new Command("verify")
  .description("Multi-axis validation: structure + format + auth + registry + sync")
  .argument("[dir]", "repo root directory", ".")
  .option("--token <tok>", "CLI token (overrides ~/.canon/config.json)")
  .option("--host <url>", "opencanon host (overrides saved config)")
  .option("--offline", "Skip network axes (auth + registry)")
  .action(async (dir: string, opts: {
    token?: string
    host?: string
    offline?: boolean
  }) => {
    const root = resolve(dir)
    const config = loadConfig()
    const token = opts.token ?? config?.token
    const host = opts.host ?? config?.host ?? "https://opencanon.co"
    const { owner, repo } = detectOwnerRepo(root)

    const api = (!opts.offline && token) ? new ApiClient(host, token) : null

    let totalFails = 0
    let totalWarns = 0

    console.log("")
    console.log(`[canon verify] ${owner}/${repo}`)
    console.log("")

    // ── Axis 1: Structure (7 checks, offline) ─────────────────────────────
    console.log("Axis 1  structure")
    let model
    try {
      model = loadRepoFromFs(root)
    } catch (err) {
      if (err instanceof SchemaVersionError) {
        fail("load", `v1.3 metadata detected — rerun with --schema v1.3`)
      } else {
        fail("load", err instanceof Error ? err.message : String(err))
      }
      process.exit(1)
    }

    if (model.stories.size === 0) {
      warn("no stories found in stories/")
      totalWarns++
    } else {
      const report = validateRepo(model)
      for (const story of report.stories) {
        for (const c of story.checks) {
          if (c.pass) {
            pass(`${story.storyId}  ${c.id}`)
          } else {
            fail(`${story.storyId}  ${c.id}`, c.message)
            totalFails++
          }
        }
      }
    }

    // ── Axis 2: Format (3 checks, offline) ────────────────────────────────
    console.log("")
    console.log("Axis 2  format")
    if (model.stories.size === 0) {
      warn("skipped — no stories")
    } else {
      for (const [slug, parsed] of model.stories) {
        const formatChecks = checkFormat(parsed.meta)
        for (const c of formatChecks) {
          if (c.pass) {
            pass(`${slug}  ${c.id}`)
          } else {
            fail(`${slug}  ${c.id}`, c.message)
            totalFails++
          }
        }
      }
    }

    // ── Axis 3: Auth (network) ─────────────────────────────────────────────
    console.log("")
    console.log("Axis 3  auth")
    if (opts.offline) {
      warn("skipped (--offline)")
    } else if (!token) {
      fail("token missing", "run: canon login")
      totalFails++
    } else {
      const result = await api!.verifyToken()
      if (result.valid) {
        pass(`token valid`, `owner: ${result.owner}`)
      } else {
        fail(`token invalid`, result.reason)
        totalFails++
      }
    }

    // ── Axis 4: Registry (network) ────────────────────────────────────────
    console.log("")
    console.log("Axis 4  registry")
    if (opts.offline) {
      warn("skipped (--offline)")
    } else if (!api) {
      warn("skipped (no token)")
    } else {
      const status = await api.getCanonStatus(owner, repo)
      if (status.registered) {
        const scoreStr = status.score !== undefined ? ` score: ${(status.score * 100).toFixed(0)}%` : ""
        pass(`${owner}/${repo} registered`, `canon_id: ${status.canonId.slice(0, 12)}...${scoreStr}`)
      } else {
        fail(`${owner}/${repo} not registered`, status.reason ?? "visit opencanon.co to register")
        totalFails++
      }
    }

    // ── Axis 5: Sync (canon.lock ↔ git HEAD) ──────────────────────────────
    console.log("")
    console.log("Axis 5  sync")
    const lockPath = join(root, "canon.lock.json")
    if (!existsSync(lockPath)) {
      fail("canon.lock.json missing", "run: canon lock")
      totalFails++
    } else {
      const lock = model.canonLock
      if (!lock) {
        fail("canon.lock.json unreadable")
        totalFails++
      } else {
        const head = getGitHead(root)
        if (!head) {
          warn("git HEAD unavailable — skipping lock sync check")
          totalWarns++
        } else if (lock.canon_commit === head) {
          pass("canon.lock.json in sync with git HEAD")
        } else {
          fail("canon.lock.json out of sync", `lock: ${lock.canon_commit.slice(0, 8)} | HEAD: ${head.slice(0, 8)} — run: canon lock`)
          totalFails++
        }
      }
    }

    // ── Summary ───────────────────────────────────────────────────────────
    console.log("")
    console.log("────────────────────────────────────────")
    if (totalFails === 0 && totalWarns === 0) {
      console.log("✓ all axes pass — pipeline ready")
    } else if (totalFails === 0) {
      console.log(`⚠ ${totalWarns} warning(s) — review before push`)
    } else {
      console.log(`✗ ${totalFails} failure(s)${totalWarns > 0 ? `, ${totalWarns} warning(s)` : ""}`)
    }
    console.log("────────────────────────────────────────")

    if (totalFails > 0) process.exit(1)
  })
