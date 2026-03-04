/**
 * Core types for canon worldbuilding validation.
 * No protocol internals — these are platform-facing types only.
 */

// ── Repo structure ──

export interface CanonLock {
  schema_version: "canon.lock.v2"
  canon_commit: string
  worldbuilding_hash: string
  hash_algo: "sha256"
  generated_at: string
  contributors: string[] // append-only contributor list
}

export interface StoryMetadata {
  schema_version: "1.2"
  canon_ref: string
  id: string
  episode: number
  title: { ko: string; en: string }
  timeline: string
  synopsis: { ko: string; en: string }
  characters: string[]
  locations: string[]
  contributor: string // GitHub username, immutable after creation
  themes?: string[]
  canon_events?: string[]
  canon_status: "canonical" | "non-canonical"
  word_count?: { ko?: number; en?: number }
  temporal_context?: {
    prev_episode: string | null
    next_episode: string | null
    thematic_echoes?: string[]
  }
}

export interface CharacterDefinition {
  id: string
  name: { ko: string; en: string }
  description?: { ko?: string; en?: string }
}

export interface LocationDefinition {
  id: string
  name: { ko: string; en: string }
  description?: { ko?: string; en?: string }
}

// ── In-memory repo model (I/O-free) ──

export interface RepoModel {
  canonLock: CanonLock | null
  characters: Set<string>
  locations: Set<string>
  episodes: Set<string>
  stories: Map<string, { meta: StoryMetadata; raw: Record<string, unknown> }>
}

// ── GitHub adapter input (pure conversion, no Octokit) ──

export interface GitHubTreeEntry {
  path: string
  type: "blob" | "tree"
  sha: string
}

export interface GitHubRepoInput {
  tree: GitHubTreeEntry[]
  files: Map<string, string>
}

// ── Check results ──

export type CheckId =
  | "metadata_schema_valid"
  | "characters_valid"
  | "locations_valid"
  | "timeline_consistent"
  | "continuity_valid"
  | "canon_version_match"
  | "contributor_valid"

export interface CheckResult {
  id: CheckId
  pass: boolean
  message?: string
}

export interface StoryCheckReport {
  storyId: string
  checks: CheckResult[]
  allPass: boolean
}

export interface RepoCheckReport {
  schemaVersion: "check.v2"
  summary: {
    score: number // passingStories / totalStories (0 if no stories)
    totalChecks: number
    passingChecks: number
  }
  stories: StoryCheckReport[]
  totalStories: number
  passingStories: number
}

// ── CLI config ──

export interface CanonConfig {
  schema_version: "canonrc.v1"
  author: string
  default_lang: "ko" | "en"
  repo_url?: string
}

// ── v1.3 metadata (additive — all types above are frozen) ──

export interface StoryMetadata_v1_3 {
  schema_version: "1.3"
  canon_ref: string
  id: string
  episode: number
  lang: string
  title: string
  timeline: string
  synopsis: string
  characters: string[]
  locations: string[]
  contributor: string
  canon_status: "canonical" | "non-canonical" | "derivative"
  derived_from?: string
  themes?: string[]
  canon_events?: string[]
  word_count?: number
  temporal_context?: {
    prev_episode: string | null
    next_episode: string | null
    thematic_echoes?: string[]
  }
}

export type ParsedMetadataResult =
  | { version: "1.2"; meta: StoryMetadata; raw: Record<string, unknown> }
  | { version: "1.3"; meta: StoryMetadata_v1_3; raw: Record<string, unknown> }

export interface RepoModelAny {
  canonLock: CanonLock | null
  characters: Set<string>
  locations: Set<string>
  episodes: Set<string>
  stories: Map<string, ParsedMetadataResult>
}

// ── v3 check types (CheckId/CheckResult/StoryCheckReport/RepoCheckReport are frozen) ──

export type CheckIdV3 =
  | "metadata_schema_valid"
  | "characters_valid"
  | "locations_valid"
  | "timeline_consistent"
  | "continuity_valid"
  | "canon_version_match"
  | "contributor_valid"
  | "derived_from_valid"
  | "episode_id_format"
  | "title_bilingual"
  | "synopsis_bilingual"

export interface CheckResultV3 {
  id: CheckIdV3
  pass: boolean
  message?: string
}

export interface StoryCheckReportV3 {
  storyId: string
  checks: CheckResultV3[]
  allPass: boolean
}

export interface RepoCheckReportV3 {
  schemaVersion: "check.v3"
  summary: {
    score: number
    totalChecks: number
    passingChecks: number
  }
  stories: StoryCheckReportV3[]
  totalStories: number
  passingStories: number
}
