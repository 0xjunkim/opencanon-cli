/**
 * canon push — full pipeline: check → lock → commit → git push → publish
 *
 * Replaces the manual sequence:
 *   canon check && canon lock && git add -A && git commit && git push && canon publish
 */

import { Command } from "commander"
import { resolve, join } from "node:path"
import { execSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { loadConfig } from "./login.js"
import { ApiClient } from "../api.js"
import { loadRepoFromFs } from "../adapters/fs.js"
import { validateRepo, checkFormat } from "../core/validate.js"

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] })
}

function runInherited(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: "inherit" })
}

function detectOwnerRepo(root: string): { owner: string; repo: string } {
  let owner = "unknown"
  let repo = root.split("/").pop() || "canon"

  // From .canonrc.json
  const rcPath = join(root, ".canonrc.json")
  if (existsSync(rcPath)) {
    try {
      const rc = JSON.parse(readFileSync(rcPath, "utf-8"))
      if (rc.author) owner = rc.author
    } catch { /* ignore */ }
  }

  // From git remote (overrides canonrc if available)
  try {
    const remote = run("git remote get-url origin", root).trim()
    const match = remote.match(/github\.com[:/]([^/]+)\/([^/.\s]+)/)
    if (match) {
      owner = match[1]
      repo = match[2].replace(/\.git$/, "")
    }
  } catch { /* no remote */ }

  return { owner, repo }
}

export const pushCommand = new Command("push")
  .description("Full pipeline: check → lock → commit → git push → publish")
  .argument("[dir]", "repo root directory", ".")
  .option("--message <msg>", "Git commit message (auto-generated if omitted)")
  .option("--no-publish", "Skip canon publish after git push")
  .option("--token <tok>", "CLI token (overrides ~/.canon/config.json)")
  .option("--host <url>", "opencanon host (overrides saved config)")
  .option("--dry-run", "Show what would happen without executing")
  .action(async (dir: string, opts: {
    message?: string
    publish: boolean
    token?: string
    host?: string
    dryRun?: boolean
  }) => {
    const root = resolve(dir)
    const config = loadConfig()
    const token = opts.token ?? config?.token
    const host = opts.host ?? config?.host ?? "https://opencanon.co"

    const { owner, repo } = detectOwnerRepo(root)

    console.log("")
    console.log(`[canon push] ${owner}/${repo}`)
    if (opts.dryRun) console.log("  (dry run — no changes will be made)")
    console.log("")

    // ── Step 1: multi-axis check (structure + format) ─────────────────────
    process.stdout.write("  1/4  canon verify... ")
    if (!opts.dryRun) {
      let verifyFails = 0

      // Axis 1: structure
      try {
        const model = loadRepoFromFs(root)
        if (model.stories.size > 0) {
          const report = validateRepo(model)
          for (const story of report.stories) {
            for (const c of story.checks) {
              if (!c.pass) verifyFails++
            }
          }
          // Axis 2: format
          for (const [, parsed] of model.stories) {
            const formatChecks = checkFormat(parsed.meta)
            for (const c of formatChecks) {
              if (!c.pass) verifyFails++
            }
          }
        }
      } catch { verifyFails++ }

      if (verifyFails > 0) {
        console.log("✗")
        console.error(`\n     ${verifyFails} validation failure(s) — run: canon verify  for details`)
        process.exit(1)
      }
      console.log("✓")
    } else {
      console.log("(skipped)")
    }

    // ── Step 2: canon lock ────────────────────────────────────────────────
    process.stdout.write("  2/4  canon lock...   ")
    if (!opts.dryRun) {
      try {
        run("canon lock --update-refs", root)
        console.log("✓")
      } catch {
        // Try node path fallback
        try {
          const canonBin = new URL("../../cli.js", import.meta.url).pathname
          run(`node "${canonBin}" lock --update-refs`, root)
          console.log("✓")
        } catch {
          console.log("⚠ (skipped — run manually: canon lock)")
        }
      }
    } else {
      console.log("(skipped)")
    }

    // ── Step 3: git add + commit + push ──────────────────────────────────
    let commitMsg = opts.message

    if (!commitMsg) {
      // Auto-generate from new stories
      try {
        const status = run("git status --porcelain", root)
        const newStories = status
          .split("\n")
          .filter((l) => l.includes("stories/"))
          .map((l) => l.trim().split(/\s+/).pop()?.split("/")[1])
          .filter(Boolean)
          .filter((v, i, a) => a.indexOf(v) === i)

        if (newStories.length > 0) {
          commitMsg = `[episode] ${newStories.join(", ")}`
        } else {
          commitMsg = "[canon] update"
        }
      } catch {
        commitMsg = "[canon] update"
      }
    }

    process.stdout.write(`  3/4  git commit...  `)
    if (!opts.dryRun) {
      try {
        run("git add -A", root)
        const diff = run("git status --porcelain", root).trim()
        if (!diff) {
          console.log("○ nothing to commit")
        } else {
          run(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, root)
          console.log(`✓ "${commitMsg}"`)
          // Push
          process.stdout.write("       git push...   ")
          runInherited("git push", root)
          console.log("✓")
        }
      } catch (e: unknown) {
        console.log("✗")
        const msg = e instanceof Error ? e.message : String(e)
        console.error(`     git error: ${msg}`)
        process.exit(1)
      }
    } else {
      console.log(`(skipped) commit: "${commitMsg}"`)
    }

    // ── Step 4: canon publish ─────────────────────────────────────────────
    if (opts.publish !== false) {
      process.stdout.write("  4/4  canon publish... ")
      if (!opts.dryRun) {
        if (!token) {
          console.log("⚠ (skipped — no token, run: canon login)")
        } else {
          const api = new ApiClient(host, token)
          const result = await api.publish(owner, repo)
          if ("url" in result) {
            console.log(`✓`)
            console.log("")
            console.log(`  Canon: ${result.url}`)
          } else {
            console.log("✗")
            const code = result.code
            if (code === "INVALID_TOKEN") {
              console.error("     invalid or expired token — run: canon login")
            } else if (code === "NOT_REGISTERED") {
              console.error(`     not registered — visit ${host} to register`)
            } else {
              console.error(`     ${result.error}`)
            }
          }
        }
      } else {
        console.log("(skipped)")
      }
    } else {
      console.log("  4/4  publish skipped (--no-publish)")
    }

    console.log("")
    console.log("────────────────────────────────────────")
    console.log(opts.dryRun ? "dry run complete." : "push complete.")
    console.log("────────────────────────────────────────")
  })
