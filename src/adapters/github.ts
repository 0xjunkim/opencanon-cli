/**
 * GitHub adapter — pure conversion from parsed GitHub API data to RepoModel.
 * No I/O, no Octokit, no HTTP. Runs anywhere.
 */
import type { CanonLock, RepoModel, RepoModelAny, ParsedMetadataResult, GitHubRepoInput } from "../core/types.js"
import { parseCanonLock, parseMetadata, parseMetadataAny } from "../core/contract.js"

/**
 * Build a RepoModel from pre-fetched GitHub API data.
 *
 * Expects:
 * - tree: parsed Trees API response entries
 * - files: Map of path → file content string (for metadata.json, canon.lock.json, etc.)
 */
export function buildRepoModel(input: GitHubRepoInput): RepoModel {
  const { tree, files } = input

  // Parse canon.lock.json
  let canonLock: CanonLock | null = null
  const lockContent = files.get("canon.lock.json")
  if (lockContent) {
    canonLock = parseCanonLock(JSON.parse(lockContent))
  }

  // Extract character IDs from tree paths: canon/characters/<id>/ (dir) or canon/characters/<id>.json (blob)
  const characters = new Set<string>()
  for (const entry of tree) {
    if (entry.path.startsWith("canon/characters/")) {
      const parts = entry.path.split("/")
      if (parts.length === 3) {
        const name = entry.type === "tree" ? parts[2] : parts[2].replace(/\.json$/, "")
        if (name !== "index") {
          characters.add(name)
        }
      }
    }
  }

  // Extract location IDs from tree paths: canon/worldbuilding/locations/<id>.json or <id>/
  const locations = new Set<string>()
  for (const entry of tree) {
    if (entry.path.startsWith("canon/worldbuilding/locations/")) {
      const parts = entry.path.split("/")
      if (parts.length === 4) {
        const name = entry.type === "tree" ? parts[3] : parts[3].replace(/\.json$/, "")
        if (name !== "index") {
          locations.add(name)
        }
      }
    }
  }

  // Extract episode slugs from tree.
  // Supports two layouts:
  //   Flat (CLI):   stories/<epSlug>/metadata.json
  //   Nested (Web): stories/<storySlug>/episodes/<epSlug>/metadata.json
  const episodes = new Set<string>()

  // Flat: stories/<slug>/ (depth-2 tree entry)
  for (const entry of tree) {
    if (entry.type === "tree" && entry.path.startsWith("stories/")) {
      const parts = entry.path.split("/")
      if (parts.length === 2) episodes.add(parts[1])
    }
  }

  // Nested: stories/<storySlug>/episodes/<epSlug>/ (depth-4 tree entry)
  for (const entry of tree) {
    if (entry.type === "tree" && entry.path.startsWith("stories/")) {
      const parts = entry.path.split("/")
      // stories / storySlug / episodes / epSlug
      if (parts.length === 4 && parts[2] === "episodes") {
        episodes.add(parts[3])
      }
    }
  }

  // Parse story metadata — try nested path first, then flat
  const stories = new Map<string, ReturnType<typeof parseMetadata>>()
  for (const entry of tree) {
    if (
      entry.type === "blob" &&
      entry.path.startsWith("stories/") &&
      entry.path.endsWith("/metadata.json")
    ) {
      const parts = entry.path.split("/")
      // Flat: stories/<slug>/metadata.json → parts.length === 3
      // Nested: stories/<storySlug>/episodes/<epSlug>/metadata.json → parts.length === 5
      let epSlug: string | null = null
      if (parts.length === 3) epSlug = parts[1]
      else if (parts.length === 5 && parts[2] === "episodes") epSlug = parts[3]
      if (!epSlug) continue
      const metaContent = files.get(entry.path)
      if (metaContent) {
        stories.set(epSlug, parseMetadata(JSON.parse(metaContent)))
      }
    }
  }

  return { canonLock, characters, locations, episodes, stories }
}

// ── v1.3 additive (buildRepoModel above is frozen) ──

/**
 * Build a RepoModelAny from pre-fetched GitHub API data.
 * Supports both v1.2 and v1.3 metadata.
 */
export function buildRepoModelAny(input: GitHubRepoInput): RepoModelAny {
  const { tree, files } = input

  let canonLock: CanonLock | null = null
  const lockContent = files.get("canon.lock.json")
  if (lockContent) {
    canonLock = parseCanonLock(JSON.parse(lockContent))
  }

  const characters = new Set<string>()
  for (const entry of tree) {
    if (entry.path.startsWith("canon/characters/")) {
      const parts = entry.path.split("/")
      if (parts.length === 3) {
        const name = entry.type === "tree" ? parts[2] : parts[2].replace(/\.json$/, "")
        if (name !== "index") characters.add(name)
      }
    }
  }

  const locations = new Set<string>()
  for (const entry of tree) {
    if (entry.path.startsWith("canon/worldbuilding/locations/")) {
      const parts = entry.path.split("/")
      if (parts.length === 4) {
        const name = entry.type === "tree" ? parts[3] : parts[3].replace(/\.json$/, "")
        if (name !== "index") locations.add(name)
      }
    }
  }

  const episodes = new Set<string>()
  for (const entry of tree) {
    if (entry.type === "tree" && entry.path.startsWith("stories/")) {
      const parts = entry.path.split("/")
      if (parts.length === 2) episodes.add(parts[1])
      else if (parts.length === 4 && parts[2] === "episodes") episodes.add(parts[3])
    }
  }

  const stories = new Map<string, ParsedMetadataResult>()
  for (const entry of tree) {
    if (
      entry.type === "blob" &&
      entry.path.startsWith("stories/") &&
      entry.path.endsWith("/metadata.json")
    ) {
      const parts = entry.path.split("/")
      let epSlug: string | null = null
      if (parts.length === 3) epSlug = parts[1]
      else if (parts.length === 5 && parts[2] === "episodes") epSlug = parts[3]
      if (!epSlug) continue
      const metaContent = files.get(entry.path)
      if (metaContent) {
        stories.set(epSlug, parseMetadataAny(JSON.parse(metaContent)))
      }
    }
  }

  return { canonLock, characters, locations, episodes, stories }
}
