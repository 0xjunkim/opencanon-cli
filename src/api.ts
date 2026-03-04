/**
 * opencanon API client
 * Centralises all web app communication for CLI commands.
 * SSE streaming for generate; JSON for everything else.
 */

import { CanonConfig } from "./commands/login.js"

export class ApiClient {
  constructor(
    private readonly host: string,
    private readonly token: string
  ) {}

  // ─── Auth header ──────────────────────────────────────────────────────────
  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      "Authorization": `Bearer ${this.token}`,
      "Content-Type": "application/json",
      ...extra,
    }
  }

  // ─── Notebook ─────────────────────────────────────────────────────────────
  async getNotebook(): Promise<string | null> {
    try {
      const res = await fetch(`${this.host}/api/notebook`, {
        headers: this.headers(),
      })
      if (!res.ok) return null
      const data = await res.json() as { content?: string }
      return data.content?.slice(0, 600) ?? null
    } catch { return null }
  }

  // ─── Registry (public) ────────────────────────────────────────────────────
  async getRegistry(): Promise<Array<{ owner: string; repo: string; title?: Record<string, string> }>> {
    try {
      const res = await fetch(`${this.host}/api/registry`)
      if (!res.ok) return []
      return await res.json() as Array<{ owner: string; repo: string; title?: Record<string, string> }>
    } catch { return [] }
  }

  // ─── Attest (fire-and-forget) ─────────────────────────────────────────────
  async attest(owner: string, targets: Array<{ owner: string; repo: string }>): Promise<void> {
    for (const ref of targets) {
      fetch(`${this.host}/api/attest`, {
        method: "POST",
        headers: { ...this.headers(), "X-Canon-Owner": owner },
        body: JSON.stringify({ target: `${ref.owner}/${ref.repo}` }),
      }).catch(() => {})
    }
  }

  // ─── Axis 3: Auth verify ─────────────────────────────────────────────────
  /**
   * Verify token is valid against the web app.
   * GET /api/auth/verify
   * Returns { valid: true, owner: string } or { valid: false, reason: string }
   */
  async verifyToken(): Promise<{ valid: true; owner: string } | { valid: false; reason: string }> {
    try {
      const res = await fetch(`${this.host}/api/auth/verify`, {
        headers: this.headers(),
      })
      if (res.status === 401) return { valid: false, reason: "invalid or expired token" }
      if (!res.ok) return { valid: false, reason: `server error: ${res.status}` }
      const data = await res.json() as { owner?: string; username?: string }
      const owner = data.owner ?? data.username ?? "unknown"
      return { valid: true, owner }
    } catch (e) {
      return { valid: false, reason: `unreachable: ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  // ─── Axis 4: Registry check ───────────────────────────────────────────────
  /**
   * Check if a canon repo is registered on the web app.
   * GET /api/canon/{owner}/{repo}/status
   * Returns { registered: true, canonId: string } or { registered: false }
   */
  async getCanonStatus(owner: string, repo: string): Promise<
    { registered: true; canonId: string; score?: number } |
    { registered: false; reason?: string }
  > {
    try {
      const res = await fetch(`${this.host}/api/canon/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/status`, {
        headers: this.headers(),
      })
      if (res.status === 404) return { registered: false, reason: "not found in registry" }
      if (!res.ok) return { registered: false, reason: `server error: ${res.status}` }
      const data = await res.json() as { canon_id?: string; canonId?: string; score?: number }
      const canonId = data.canon_id ?? data.canonId ?? ""
      return { registered: true, canonId, score: data.score }
    } catch (e) {
      return { registered: false, reason: `unreachable: ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  // ─── Publish ──────────────────────────────────────────────────────────────
  async publish(owner: string, repo: string): Promise<{ url: string } | { error: string; code?: string }> {
    try {
      const res = await fetch(`${this.host}/api/publish`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ token: this.token, owner, repo }),
      })
      const data = await res.json() as Record<string, unknown>
      if (res.ok && data.url) return { url: data.url as string }
      return { error: String(data.error ?? "publish failed"), code: data.code as string | undefined }
    } catch (e) {
      return { error: String(e) }
    }
  }

  // ─── Generate (SSE streaming) ─────────────────────────────────────────────
  /**
   * Stream AI-generated episode prose from the web app.
   * Yields text chunks as they arrive.
   *
   * POST /api/cli/generate
   * Body: { owner, repo, episode, direction, refs }
   * Response: SSE — data: <chunk>\n\n  or  data: [DONE]\n\n
   */
  async *generate(params: {
    owner: string
    repo: string
    episode: string
    direction: string
    refs: Array<{ hash: string; source: string; storyId?: string; preview: string }>
  }): AsyncGenerator<string> {
    const res = await fetch(`${this.host}/api/cli/generate`, {
      method: "POST",
      headers: {
        ...this.headers(),
        "Accept": "text/event-stream",
      },
      body: JSON.stringify(params),
    })

    if (!res.ok) {
      let errMsg = `generate failed: ${res.status}`
      try {
        const err = await res.json() as { error?: string; code?: string }
        errMsg = err.error ?? errMsg
        if (err.code === "INVALID_TOKEN") errMsg = "invalid token — run: canon login"
        if (err.code === "NOT_FOUND") errMsg = `canon not registered on opencanon — run: canon publish`
      } catch { /* use status message */ }
      throw new Error(errMsg)
    }

    if (!res.body) throw new Error("no response body from generate endpoint")

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // Parse SSE lines
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const chunk = line.slice(6)
            if (chunk === "[DONE]") return
            if (chunk.trim()) yield chunk
          }
        }
      }

      // Flush remaining buffer
      if (buffer.startsWith("data: ")) {
        const chunk = buffer.slice(6)
        if (chunk !== "[DONE]" && chunk.trim()) yield chunk
      }
    } finally {
      reader.releaseLock()
    }
  }
}

// ─── Factory from saved config ────────────────────────────────────────────────
export function apiClientFromConfig(
  config: CanonConfig | null,
  overrides?: { token?: string; host?: string }
): ApiClient | null {
  const token = overrides?.token ?? config?.token
  const host = overrides?.host ?? config?.host ?? "https://opencanon.co"
  if (!token) return null
  return new ApiClient(host, token)
}
