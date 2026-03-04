import { Command } from "commander"
import { resolve, join } from "node:path"
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, statSync, renameSync, unlinkSync } from "node:fs"
import { createHash } from "node:crypto"
import { metadataTemplate } from "../templates/metadata.js"
import { loadConfig } from "./login.js"
import { ApiClient } from "../api.js"

const OPENCANON_HOST = "https://opencanon.co"

// ─── Lossy SHA-256 hash (12 hex chars = 48 bits) ─────────────────────────────
function sha12(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 12)
}

interface RefEntry {
  hash: string
  source: "self" | "notebook" | "cross"
  storyId?: string
  owner?: string
  repo?: string
  preview: string // first 60 chars only (bounded)
  createdAt: string
}

interface CanonRefs {
  episode: string
  createdAt: string
  direction: string
  generated: boolean
  refs: RefEntry[]
}

// ─── Read own recent chapter ──────────────────────────────────────────────────
function readOwnContext(root: string): { content: string; storyId: string } | null {
  const storiesDir = join(root, "stories")
  if (!existsSync(storiesDir)) return null

  const storyDirs = readdirSync(storiesDir).filter((d) => {
    try {
      return statSync(join(storiesDir, d)).isDirectory()
    } catch { return false }
  }).sort().reverse()

  for (const storyDir of storyDirs) {
    const candidates = [
      join(storiesDir, storyDir, "ko", "chapter-01.md"),
      join(storiesDir, storyDir, "en", "chapter-01.md"),
      join(storiesDir, storyDir, "content.md"),
      join(storiesDir, storyDir, "chapter-01.md"),
    ]
    for (const p of candidates) {
      if (existsSync(p)) {
        const content = readFileSync(p, "utf-8").slice(0, 800)
        return { content, storyId: storyDir }
      }
    }
  }
  return null
}

// ─── Detect current repo owner from .canonrc ─────────────────────────────────
function detectOwner(root: string): string {
  const rcPath = join(root, ".canonrc.json")
  if (existsSync(rcPath)) {
    try {
      const rc = JSON.parse(readFileSync(rcPath, "utf-8"))
      return rc.author || "unknown"
    } catch { /* ignore */ }
  }
  return "unknown"
}

// ─── Detect repo name from git remote ────────────────────────────────────────
function detectRepo(root: string): string {
  try {
    const { execSync } = _require("node:child_process") as typeof import("node:child_process")
    const remote = execSync("git remote get-url origin", {
      cwd: root, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"]
    }).trim()
    const match = remote.match(/github\.com[:/][^/]+\/([^/.\s]+)/)
    if (match) return match[1].replace(/\.git$/, "")
  } catch { /* no remote */ }
  return root.split("/").pop() || "canon"
}

// ─── Build ref header block ───────────────────────────────────────────────────
function buildRefHeader(refs: RefEntry[]): string {
  return refs
    .map((r) => `<!--ref:#${r.hash} source:${r.source}${r.storyId ? ` story:${r.storyId}` : ""}-->`)
    .join("\n")
}

// ─── Build chapter scaffold (no --generate) ───────────────────────────────────
function buildScaffold(episodeSlug: string, refs: RefEntry[], direction: string): string {
  const refBlock = buildRefHeader(refs)
  const directionNote = direction !== "continue naturally"
    ? `\n<!-- direction: ${direction} -->`
    : ""

  return `${refBlock}${directionNote}

# ${episodeSlug.replace(/^ep\d+-/, "").replace(/-/g, " ")}

---

*[이야기를 이어가세요]*
*참조: ${refs.length}개 | direction: ${direction}*

`
}

// ─── Main command ─────────────────────────────────────────────────────────────

export const writeCommand = new Command("write")
  .description("Scaffold next chapter with lossy cross-referenced context")
  .argument("<episode-slug>", "Episode slug (e.g. ep02-title)")
  .option("--generate", "Generate prose via opencanon web app (requires: canon login)")
  .option("--direction <text>", "Writing direction hint (used with --generate, max 280 chars)", "continue naturally")
  .option("--overwrite", "Allow overwriting existing chapter-01.md when using --generate")
  .option("--no-refs", "Skip cross-referencing other novels")
  .option("--no-notebook", "Skip notebook context")
  .option("--host <url>", "opencanon host", OPENCANON_HOST)
  .option("--token <tok>", "CLI token (overrides ~/.canon/config.json)")
  .action(async (episodeSlug: string, opts: {
    generate: boolean
    direction: string
    overwrite: boolean
    refs: boolean
    notebook: boolean
    host: string
    token?: string
  }) => {
    const root = resolve(".")
    const host = opts.host ?? OPENCANON_HOST
    const config = loadConfig()
    const token = opts.token ?? config?.token
    const owner = detectOwner(root)
    const repo = detectRepo(root)

    // Validate episode slug format early
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(episodeSlug)) {
      console.error(`Error: invalid episode slug "${episodeSlug}"`)
      console.error(`       must match /^[a-z0-9][a-z0-9_-]*$/ — lowercase, hyphens/underscores only`)
      process.exit(1)
    }

    // Truncate direction to 280 chars
    const direction = (opts.direction ?? "continue naturally").slice(0, 280)

    const api = token ? new ApiClient(host, token) : null

    console.log("")
    console.log(`[canon write] ${episodeSlug}`)
    if (opts.generate) console.log(`[direction] ${direction}`)
    console.log("컨텍스트를 수집하고 있습니다...\n")

    const refEntries: RefEntry[] = []
    const now = new Date().toISOString()

    // ── ① Own recent chapter ──────────────────────────────────────────────
    const own = readOwnContext(root)
    if (own) {
      refEntries.push({
        hash: sha12(own.content),
        source: "self",
        storyId: own.storyId,
        preview: own.content.slice(0, 60),
        createdAt: now,
      })
      console.log(`  ✓ 자체 캐논: ${own.storyId} (#${sha12(own.content)})`)
    }

    // ── ② Notebook ────────────────────────────────────────────────────────
    if (opts.notebook !== false && api) {
      const notebook = await api.getNotebook()
      if (notebook && notebook.trim()) {
        refEntries.push({
          hash: sha12(notebook),
          source: "notebook",
          preview: notebook.slice(0, 60),
          createdAt: now,
        })
        console.log(`  ✓ 수첩 참조: (#${sha12(notebook)})`)
      } else if (!token) {
        console.log(`  ○ 수첩: 토큰 없음 — canon login 후 소셜 시그널 포함`)
      } else {
        // Notebook empty — warn: X/Moltbook may not be connected
        console.log(`  ⚠ 수첩 비어있음 — opencanon.co/settings 에서 X/Moltbook 연동 확인`)
        console.log(`    (소셜 시그널 없이 self + cross 참조만으로 생성됩니다)`)
      }
    }

    // ── ③ Cross-refs ──────────────────────────────────────────────────────
    const crossRefTargets: Array<{ owner: string; repo: string }> = []
    if (opts.refs !== false && api) {
      const registry = await api.getRegistry()
      for (const r of registry.slice(0, 3)) {
        if (r.owner.toLowerCase() === owner.toLowerCase()) continue
        const titleText = Object.values(r.title ?? {}).join(" / ")
        const snippet = `${r.owner}/${r.repo} — ${titleText}`.slice(0, 200)
        refEntries.push({
          hash: sha12(snippet),
          source: "cross",
          owner: r.owner,
          repo: r.repo,
          preview: snippet.slice(0, 60),
          createdAt: now,
        })
        crossRefTargets.push({ owner: r.owner, repo: r.repo })
        console.log(`  ✓ 교차 캐논: ${r.owner}/${r.repo} (#${sha12(snippet)})`)
      }

      // Attest (fire-and-forget)
      if (crossRefTargets.length > 0) {
        api.attest(owner, crossRefTargets).catch(() => {})
      }
    }

    // ── Save .canon-refs.json ─────────────────────────────────────────────
    const refsRecord: CanonRefs = {
      episode: episodeSlug,
      createdAt: now,
      direction: opts.direction,
      generated: opts.generate,
      refs: refEntries,
    }
    const refsPath = join(root, ".canon-refs.json")
    let existing: CanonRefs[] = []
    if (existsSync(refsPath)) {
      try { existing = JSON.parse(readFileSync(refsPath, "utf-8")) } catch { /* ignore */ }
    }
    writeFileSync(refsPath, JSON.stringify([...existing, refsRecord], null, 2) + "\n")

    // ── Scaffold dirs + metadata ──────────────────────────────────────────
    const storyDir = join(root, "stories", episodeSlug)
    if (!existsSync(storyDir)) mkdirSync(storyDir, { recursive: true })

    const metaPath = join(storyDir, "metadata.json")
    if (!existsSync(metaPath)) {
      writeFileSync(
        metaPath,
        metadataTemplate(episodeSlug, {
          contributor: owner,
          episode: parseInt(episodeSlug.match(/ep(\d+)/)?.[1] ?? "1", 10),
          titleKo: episodeSlug.replace(/^ep\d+-/, "").replace(/-/g, " "),
          titleEn: episodeSlug.replace(/^ep\d+-/, "").replace(/-/g, " "),
          timeline: new Date().toISOString().slice(0, 10),
          synopsisKo: "",
          synopsisEn: "",
          characters: [],
          locations: [],
          canonStatus: "canonical",
          themes: [],
        })
      )
      console.log(`\n  ✓ 메타데이터: stories/${episodeSlug}/metadata.json`)
    }

    const chapterPath = join(storyDir, "chapter-01.md")

    // ── ④ Generate or scaffold ────────────────────────────────────────────
    if (opts.generate && api) {
      // Guard: irreversibility — require --overwrite to replace existing chapter
      if (existsSync(chapterPath) && !opts.overwrite) {
        console.error(`\n  ✗ ${chapterPath} already exists`)
        console.error(`    opencanon은 불가역 원칙 — 기존 챕터를 덮어쓰려면 --overwrite 를 명시하세요`)
        console.error(`    또는 새 에피소드 슬러그를 사용하세요 (권장)`)
        process.exit(1)
      }

      console.log(`\n생성 중... (direction: ${direction})\n`)

      const refHeader = buildRefHeader(refEntries)
      let generated = ""
      const tmpPath = chapterPath + ".tmp"

      try {
        process.stdout.write("  ")
        for await (const chunk of api.generate({
          owner,
          repo,
          episode: episodeSlug,
          direction,
          refs: refEntries,
        })) {
          process.stdout.write(chunk)
          generated += chunk
        }
        console.log("\n")

        if (!generated.trim()) {
          throw new Error("generation returned empty content")
        }

        // Atomic write: tmp → rename (prevents partial file on SSE drop)
        writeFileSync(tmpPath, `${refHeader}\n\n${generated}`)
        renameSync(tmpPath, chapterPath)
        console.log(`  ✓ 챕터 생성 (AI): stories/${episodeSlug}/chapter-01.md`)

      } catch (err: unknown) {
        // Clean up temp file if it exists
        try { if (existsSync(tmpPath)) unlinkSync(tmpPath) } catch { /* ignore */ }

        const message = err instanceof Error ? err.message : String(err)
        console.error(`\n  ✗ 생성 실패: ${message}`)
        console.log(`  → scaffold 모드로 폴백합니다`)
        if (!existsSync(chapterPath)) {
          writeFileSync(chapterPath, buildScaffold(episodeSlug, refEntries, direction))
        }
        console.log(`  ✓ 챕터 scaffold: stories/${episodeSlug}/chapter-01.md`)
      }

    } else {
      // Plain scaffold
      if (!existsSync(chapterPath)) {
        writeFileSync(chapterPath, buildScaffold(episodeSlug, refEntries, direction))
        console.log(`\n  ✓ 챕터 scaffold: stories/${episodeSlug}/chapter-01.md`)
      } else {
        console.log(`\n  ○ 챕터 이미 존재: stories/${episodeSlug}/chapter-01.md`)
      }
    }

    // ── Summary ───────────────────────────────────────────────────────────
    console.log("")
    console.log("────────────────────────────────────────")
    console.log(`에피소드:   ${episodeSlug}`)
    console.log(`참조 수:    ${refEntries.length}개 (비가역 hash)`)
    console.log(`참조 기록:  .canon-refs.json (gitignored — private)`)
    console.log(`생성:       ${opts.generate ? "웹앱 AI" : "scaffold"}`)
    console.log(`direction:  ${direction}`)
    console.log("")
    console.log("다음 단계:")
    if (!opts.generate) {
      console.log(`  1. stories/${episodeSlug}/chapter-01.md 열고 이야기를 이어가세요`)
      console.log(`  2. stories/${episodeSlug}/metadata.json 제목/시놉시스 채우기`)
    } else {
      console.log(`  1. stories/${episodeSlug}/chapter-01.md 검토 및 수정`)
      console.log(`  2. stories/${episodeSlug}/metadata.json 제목/시놉시스 채우기`)
    }
    console.log(`  3. canon push (check → lock → commit → push → publish)`)
    console.log("────────────────────────────────────────")
  })

// ─── require shim for detectRepo sync ────────────────────────────────────────
import { createRequire } from "node:module"
const _require = createRequire(import.meta.url)
