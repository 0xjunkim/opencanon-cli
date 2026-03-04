/**
 * Canon compliance validation logic.
 *
 * Pure functions — no I/O, no side effects.
 * Shared between CLI (local check) and adapter (engine observation).
 */
import type { StoryMetadata, CanonLock, CheckResult, StoryCheckReport, RepoCheckReport, CheckId, RepoModel, StoryMetadata_v1_3, CheckIdV3, CheckResultV3, StoryCheckReportV3, RepoCheckReportV3, RepoModelAny } from "./types.js"
import { hasExcessiveCombining, hasProhibitedCodepoints } from "./sanitize.js"

function check(id: CheckId, pass: boolean, message?: string): CheckResult {
  return { id, pass, ...(!pass && message ? { message } : {}) }
}

function isBilingualObject(v: unknown): v is { ko: string; en: string } {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    typeof (v as Record<string, unknown>).ko === "string" &&
    typeof (v as Record<string, unknown>).en === "string"
  )
}

/**
 * Validate that all declared characters exist in the canon.
 */
export function checkCharacters(
  meta: StoryMetadata,
  knownCharacters: ReadonlySet<string>,
): CheckResult {
  const missing = meta.characters.filter(c => !knownCharacters.has(c))
  return check(
    "characters_valid",
    missing.length === 0,
    missing.length > 0 ? `Unknown characters: ${missing.join(", ")}` : undefined,
  )
}

/**
 * Validate that all declared locations exist in the canon.
 */
export function checkLocations(
  meta: StoryMetadata,
  knownLocations: ReadonlySet<string>,
): CheckResult {
  const missing = meta.locations.filter(l => !knownLocations.has(l))
  return check(
    "locations_valid",
    missing.length === 0,
    missing.length > 0 ? `Unknown locations: ${missing.join(", ")}` : undefined,
  )
}

/**
 * Validate that the timeline field is a valid ISO date.
 */
export function checkTimeline(meta: StoryMetadata): CheckResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.timeline)) {
    return check("timeline_consistent", false, `Invalid timeline date: "${meta.timeline}"`)
  }
  const [y, m, d] = meta.timeline.split("-").map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  const roundTrip = date.toISOString().slice(0, 10)
  const valid = roundTrip === meta.timeline
  return check(
    "timeline_consistent",
    valid,
    valid ? undefined : `Invalid timeline date: "${meta.timeline}"`,
  )
}

/**
 * Validate temporal_context references exist in known episode set.
 */
export function checkContinuity(
  meta: StoryMetadata,
  knownEpisodes: ReadonlySet<string>,
): CheckResult {
  if (!meta.temporal_context) {
    return check("continuity_valid", true)
  }

  const tc = meta.temporal_context
  const broken: string[] = []

  if (tc.prev_episode && !knownEpisodes.has(tc.prev_episode)) {
    broken.push(`prev_episode "${tc.prev_episode}" not found`)
  }
  if (tc.next_episode && !knownEpisodes.has(tc.next_episode)) {
    broken.push(`next_episode "${tc.next_episode}" not found`)
  }
  if (tc.thematic_echoes) {
    if (!Array.isArray(tc.thematic_echoes)) {
      broken.push("thematic_echoes must be an array")
    } else {
      for (const echo of tc.thematic_echoes) {
        if (!knownEpisodes.has(echo)) {
          broken.push(`thematic_echo "${echo}" not found`)
        }
      }
    }
  }

  return check(
    "continuity_valid",
    broken.length === 0,
    broken.length > 0 ? broken.join("; ") : undefined,
  )
}

/**
 * Validate that metadata.canon_ref matches canon.lock.json.
 */
export function checkCanonVersion(
  meta: StoryMetadata,
  canonLock: CanonLock | null,
): CheckResult {
  if (!canonLock) {
    return check("canon_version_match", false, "canon.lock.json not found")
  }
  const match = meta.canon_ref === canonLock.canon_commit
  return check(
    "canon_version_match",
    match,
    match ? undefined : `canon_ref "${meta.canon_ref}" does not match lock "${canonLock.canon_commit}"`,
  )
}

/**
 * Validate metadata.json schema conformance.
 */
export function checkMetadataSchema(meta: Record<string, unknown>, slug?: string): CheckResult {
  const required = ["schema_version", "canon_ref", "id", "episode", "title", "timeline", "synopsis", "characters", "locations", "contributor", "canon_status"]
  const missing = required.filter(f => !(f in meta))
  if (missing.length > 0) {
    return check("metadata_schema_valid", false, `Missing fields: ${missing.join(", ")}`)
  }
  if (meta.schema_version !== "1.2") {
    return check("metadata_schema_valid", false, `Expected schema_version "1.2", got "${meta.schema_version}"`)
  }
  if (typeof meta.episode !== "number" || !Number.isFinite(meta.episode)) {
    return check("metadata_schema_valid", false, `episode must be a finite number`)
  }
  if (!Array.isArray(meta.characters)) {
    return check("metadata_schema_valid", false, `characters must be an array`)
  }
  if (!Array.isArray(meta.locations)) {
    return check("metadata_schema_valid", false, `locations must be an array`)
  }
  for (const field of ["canon_ref", "id", "contributor", "timeline"] as const) {
    if (typeof meta[field] !== "string") {
      return check("metadata_schema_valid", false, `${field} must be a string`)
    }
  }
  if (!isBilingualObject(meta.title)) {
    return check("metadata_schema_valid", false, `title must be { ko: string, en: string }`)
  }
  if (!isBilingualObject(meta.synopsis)) {
    return check("metadata_schema_valid", false, `synopsis must be { ko: string, en: string }`)
  }
  if (!(meta.characters as unknown[]).every((c: unknown) => typeof c === "string")) {
    return check("metadata_schema_valid", false, `characters array must contain only strings`)
  }
  if (!(meta.locations as unknown[]).every((l: unknown) => typeof l === "string")) {
    return check("metadata_schema_valid", false, `locations array must contain only strings`)
  }
  if (slug !== undefined && typeof meta.id === "string" && meta.id !== slug) {
    return check("metadata_schema_valid", false,
      `metadata.id "${meta.id}" must match directory slug "${slug}"`)
  }
  const validStatuses = ["canonical", "non-canonical"]
  if (!validStatuses.includes(meta.canon_status as string)) {
    return check("metadata_schema_valid", false, `canon_status must be "canonical" or "non-canonical"`)
  }
  return check("metadata_schema_valid", true)
}

/**
 * Validate that contributor field is present and non-empty.
 */
/** GitHub/git-style username: alphanumeric + hyphens/underscores, 1–39 chars, no leading/trailing hyphen */
const CONTRIBUTOR_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,37}[a-zA-Z0-9_]$|^[a-zA-Z0-9_]$/

export function checkContributor(meta: StoryMetadata): CheckResult {
  const value = meta.contributor
  if (typeof value !== "string" || value.trim().length === 0) {
    return check("contributor_valid", false, "contributor must be a non-empty string")
  }
  const valid = CONTRIBUTOR_RE.test(value.trim())
  return check(
    "contributor_valid",
    valid,
    valid ? undefined : `contributor "${value}" is not a valid username (alphanumeric/hyphens/underscores, 1–39 chars)`,
  )
}

/**
 * Run all checks for a single story.
 */
export function validateStory(input: {
  meta: StoryMetadata
  rawMeta: Record<string, unknown>
  slug?: string
  knownCharacters: ReadonlySet<string>
  knownLocations: ReadonlySet<string>
  knownEpisodes: ReadonlySet<string>
  canonLock: CanonLock | null
}): StoryCheckReport {
  const schemaCheck = checkMetadataSchema(input.rawMeta, input.slug)

  const checks: CheckResult[] = schemaCheck.pass
    ? [
        schemaCheck,
        checkCharacters(input.meta, input.knownCharacters),
        checkLocations(input.meta, input.knownLocations),
        checkTimeline(input.meta),
        checkContinuity(input.meta, input.knownEpisodes),
        checkCanonVersion(input.meta, input.canonLock),
        checkContributor(input.meta),
      ]
    : [
        schemaCheck,
        check("characters_valid", false, "skipped: metadata schema invalid"),
        check("locations_valid", false, "skipped: metadata schema invalid"),
        check("timeline_consistent", false, "skipped: metadata schema invalid"),
        check("continuity_valid", false, "skipped: metadata schema invalid"),
        check("canon_version_match", false, "skipped: metadata schema invalid"),
        check("contributor_valid", false, "skipped: metadata schema invalid"),
      ]

  return {
    storyId: input.meta.id,
    checks,
    allPass: checks.every(c => c.pass),
  }
}

/**
 * Run all checks for an entire repo model.
 * Pure function — takes RepoModel, returns RepoCheckReport.
 */
export function validateRepo(model: RepoModel): RepoCheckReport {
  const stories: StoryCheckReport[] = []

  for (const [slug, { meta, raw }] of model.stories) {
    stories.push(validateStory({
      meta,
      rawMeta: raw,
      slug,
      knownCharacters: model.characters,
      knownLocations: model.locations,
      knownEpisodes: model.episodes,
      canonLock: model.canonLock,
    }))
  }

  const totalStories = stories.length
  const passingStories = stories.filter(s => s.allPass).length
  const totalChecks = stories.reduce((sum, s) => sum + s.checks.length, 0)
  const passingChecks = stories.reduce((sum, s) => sum + s.checks.filter(c => c.pass).length, 0)

  return {
    schemaVersion: "check.v2",
    summary: {
      score: totalStories > 0 ? passingStories / totalStories : 0,
      totalChecks,
      passingChecks,
    },
    stories,
    totalStories,
    passingStories,
  }
}

// ── v1.3 validation (additive — all functions above are frozen) ──

function checkV3(id: CheckIdV3, pass: boolean, message?: string): CheckResultV3 {
  return { id, pass, ...(!pass && message ? { message } : {}) }
}

/**
 * Validate v1.3 metadata schema conformance.
 * Flat title/synopsis (string), required lang, derivative canon_status, Unicode safety.
 */
export function checkMetadataSchema_v1_3(meta: Record<string, unknown>, slug?: string): CheckResultV3 {
  const required = ["schema_version", "canon_ref", "id", "episode", "lang", "title", "timeline", "synopsis", "characters", "locations", "contributor", "canon_status"]
  const missing = required.filter(f => !(f in meta))
  if (missing.length > 0) {
    return checkV3("metadata_schema_valid", false, `Missing fields: ${missing.join(", ")}`)
  }
  if (meta.schema_version !== "1.3") {
    return checkV3("metadata_schema_valid", false, `Expected schema_version "1.3", got "${meta.schema_version}"`)
  }
  if (typeof meta.lang !== "string" || meta.lang.trim().length === 0) {
    return checkV3("metadata_schema_valid", false, "lang must be a non-empty string")
  }
  if (typeof meta.episode !== "number" || !Number.isFinite(meta.episode)) {
    return checkV3("metadata_schema_valid", false, "episode must be a finite number")
  }
  for (const field of ["canon_ref", "id", "contributor", "timeline", "title", "synopsis"] as const) {
    if (typeof meta[field] !== "string") {
      return checkV3("metadata_schema_valid", false, `${field} must be a string`)
    }
  }
  if (!Array.isArray(meta.characters)) {
    return checkV3("metadata_schema_valid", false, "characters must be an array")
  }
  if (!Array.isArray(meta.locations)) {
    return checkV3("metadata_schema_valid", false, "locations must be an array")
  }
  if (!(meta.characters as unknown[]).every((c: unknown) => typeof c === "string")) {
    return checkV3("metadata_schema_valid", false, "characters array must contain only strings")
  }
  if (!(meta.locations as unknown[]).every((l: unknown) => typeof l === "string")) {
    return checkV3("metadata_schema_valid", false, "locations array must contain only strings")
  }
  if (slug !== undefined && typeof meta.id === "string" && meta.id !== slug) {
    return checkV3("metadata_schema_valid", false,
      `metadata.id "${meta.id}" must match directory slug "${slug}"`)
  }
  const validStatuses = ["canonical", "non-canonical", "derivative"]
  if (!validStatuses.includes(meta.canon_status as string)) {
    return checkV3("metadata_schema_valid", false, `canon_status must be "canonical", "non-canonical", or "derivative"`)
  }
  // Unicode safety (reject only, never modify)
  const title = meta.title as string
  const synopsis = meta.synopsis as string
  if (hasExcessiveCombining(title)) {
    return checkV3("metadata_schema_valid", false, "title contains excessive combining marks (possible Zalgo)")
  }
  if (hasExcessiveCombining(synopsis)) {
    return checkV3("metadata_schema_valid", false, "synopsis contains excessive combining marks (possible Zalgo)")
  }
  if (hasProhibitedCodepoints(title)) {
    return checkV3("metadata_schema_valid", false, "title contains prohibited Unicode codepoints (bidi overrides)")
  }
  if (hasProhibitedCodepoints(synopsis)) {
    return checkV3("metadata_schema_valid", false, "synopsis contains prohibited Unicode codepoints (bidi overrides)")
  }
  return checkV3("metadata_schema_valid", true)
}

/**
 * Validate derived_from consistency:
 * - derivative status requires derived_from
 * - derived_from must reference a known episode
 * - non-derivative should not have derived_from
 */
export function checkDerivedFrom(
  meta: StoryMetadata_v1_3,
  knownEpisodes: ReadonlySet<string>,
): CheckResultV3 {
  const isDerivative = meta.canon_status === "derivative"
  const hasDerivedFrom = typeof meta.derived_from === "string" && meta.derived_from.length > 0

  if (isDerivative && !hasDerivedFrom) {
    return checkV3("derived_from_valid", false, `derivative status requires derived_from field`)
  }
  if (!isDerivative && hasDerivedFrom) {
    return checkV3("derived_from_valid", false, `derived_from should only be set when canon_status is "derivative"`)
  }
  if (hasDerivedFrom && !knownEpisodes.has(meta.derived_from!)) {
    return checkV3("derived_from_valid", false, `derived_from "${meta.derived_from}" does not match any known episode`)
  }
  return checkV3("derived_from_valid", true)
}

// ── Axis 2: Format checks (web app pipeline alignment) ───────────────────────

const EPISODE_SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/

/**
 * Validate episode slug format matches web app ID constraint.
 * Rule: /^[a-z0-9][a-z0-9_-]*$/ — lowercase alphanumeric, hyphens, underscores.
 */
export function checkEpisodeIdFormat(meta: StoryMetadata | StoryMetadata_v1_3): CheckResultV3 {
  const id = meta.id
  if (!EPISODE_SLUG_RE.test(id)) {
    return checkV3("episode_id_format", false,
      `id "${id}" must match /^[a-z0-9][a-z0-9_-]*$/ — lowercase, hyphens/underscores only`)
  }
  return checkV3("episode_id_format", true)
}

/**
 * Validate title has non-empty ko and en strings (v1.2 bilingual object).
 * Web app requires both fields for rendering.
 */
export function checkTitleBilingual(meta: StoryMetadata): CheckResultV3 {
  const { ko, en } = meta.title
  if (!ko || ko.trim().length === 0) {
    return checkV3("title_bilingual", false, "title.ko is empty")
  }
  if (!en || en.trim().length === 0) {
    return checkV3("title_bilingual", false, "title.en is empty")
  }
  return checkV3("title_bilingual", true)
}

/**
 * Validate synopsis has non-empty ko and en strings (v1.2 bilingual object).
 * Web app requires both fields for episode listing.
 */
export function checkSynopsisBilingual(meta: StoryMetadata): CheckResultV3 {
  const { ko, en } = meta.synopsis
  if (!ko || ko.trim().length === 0) {
    return checkV3("synopsis_bilingual", false, "synopsis.ko is empty")
  }
  if (!en || en.trim().length === 0) {
    return checkV3("synopsis_bilingual", false, "synopsis.en is empty")
  }
  return checkV3("synopsis_bilingual", true)
}

/**
 * Run all 3 format checks for a story (Axis 2).
 * Returns array of CheckResultV3.
 */
export function checkFormat(meta: StoryMetadata): CheckResultV3[] {
  return [
    checkEpisodeIdFormat(meta),
    checkTitleBilingual(meta),
    checkSynopsisBilingual(meta),
  ]
}

/**
 * Run all 8 checks for a single v1.3 story.
 * Reuses shared checks by casting common fields.
 */
export function validateStory_v1_3(input: {
  meta: StoryMetadata_v1_3
  rawMeta: Record<string, unknown>
  slug?: string
  knownCharacters: ReadonlySet<string>
  knownLocations: ReadonlySet<string>
  knownEpisodes: ReadonlySet<string>
  canonLock: CanonLock | null
}): StoryCheckReportV3 {
  const schemaCheck = checkMetadataSchema_v1_3(input.rawMeta, input.slug)

  // Reuse shared checks — cast v1.3 meta to v1.2 for structurally compatible fields
  const metaCompat = input.meta as unknown as StoryMetadata

  const checks: CheckResultV3[] = schemaCheck.pass
    ? [
        schemaCheck,
        checkCharacters(metaCompat, input.knownCharacters) as CheckResultV3,
        checkLocations(metaCompat, input.knownLocations) as CheckResultV3,
        checkTimeline(metaCompat) as CheckResultV3,
        checkContinuity(metaCompat, input.knownEpisodes) as CheckResultV3,
        checkCanonVersion(metaCompat, input.canonLock) as CheckResultV3,
        checkContributor(metaCompat) as CheckResultV3,
        checkDerivedFrom(input.meta, input.knownEpisodes),
      ]
    : [
        schemaCheck,
        checkV3("characters_valid", false, "skipped: metadata schema invalid"),
        checkV3("locations_valid", false, "skipped: metadata schema invalid"),
        checkV3("timeline_consistent", false, "skipped: metadata schema invalid"),
        checkV3("continuity_valid", false, "skipped: metadata schema invalid"),
        checkV3("canon_version_match", false, "skipped: metadata schema invalid"),
        checkV3("contributor_valid", false, "skipped: metadata schema invalid"),
        checkV3("derived_from_valid", false, "skipped: metadata schema invalid"),
      ]

  return {
    storyId: input.meta.id,
    checks,
    allPass: checks.every(c => c.pass),
  }
}

/**
 * Run all checks for a mixed-version repo.
 * v1.2 stories get 7 checks, v1.3 stories get 8 checks.
 * Returns check.v3 report.
 */
export function validateRepoAny(model: RepoModelAny): RepoCheckReportV3 {
  const stories: StoryCheckReportV3[] = []

  for (const [slug, parsed] of model.stories) {
    if (parsed.version === "1.2") {
      // Run v1.2 validation, convert result to V3 shape
      const v2Report = validateStory({
        meta: parsed.meta,
        rawMeta: parsed.raw,
        slug,
        knownCharacters: model.characters,
        knownLocations: model.locations,
        knownEpisodes: model.episodes,
        canonLock: model.canonLock,
      })
      stories.push({
        storyId: v2Report.storyId,
        checks: v2Report.checks as CheckResultV3[],
        allPass: v2Report.allPass,
      })
    } else {
      stories.push(validateStory_v1_3({
        meta: parsed.meta,
        rawMeta: parsed.raw,
        slug,
        knownCharacters: model.characters,
        knownLocations: model.locations,
        knownEpisodes: model.episodes,
        canonLock: model.canonLock,
      }))
    }
  }

  const totalStories = stories.length
  const passingStories = stories.filter(s => s.allPass).length
  const totalChecks = stories.reduce((sum, s) => sum + s.checks.length, 0)
  const passingChecks = stories.reduce((sum, s) => sum + s.checks.filter(c => c.pass).length, 0)

  return {
    schemaVersion: "check.v3",
    summary: {
      score: totalStories > 0 ? passingStories / totalStories : 0,
      totalChecks,
      passingChecks,
    },
    stories,
    totalStories,
    passingStories,
  }
}
