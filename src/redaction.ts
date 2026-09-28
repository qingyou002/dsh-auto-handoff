/**
 * Secret redaction. Pure functions, no Harness imports.
 *
 * `redactSecrets` runs on the assembled summary prompt *before* it reaches the
 * model (`TASK-PLAN.md` §7.4 step 3), so credentials that appeared in the
 * conversation never leave the machine a second time.
 *
 * Design rules, in order of importance:
 *
 * 1. Never redact ordinary technical prose. The generic blob rules are
 *    deliberately narrow (canonical long hex digests, and base64 that carries
 *    `+`, `/` or `=` padding), so identifiers, paths, versions, and sentences
 *    survive untouched.
 * 2. Prefer prefix-shaped credentials (`sk-…`, `ghp_…`, `AKIA…`, JWTs, …),
 *    which are unambiguous.
 * 3. Treat `KEY=value` and `Authorization:` assignments as secrets whatever the
 *    value looks like, because the *name* is the evidence.
 */

/** The single replacement token; also the marker used to stay idempotent. */
export const REDACTED = '[已脱敏]'

/** Redactable `name=value` / `name: value` assignment keys. */
const SECRET_KEY =
  'password|passwd|pwd|secret|client[_-]?secret|token|api[_-]?key|apikey|access[_-]?key|' +
  'secret[_-]?key|private[_-]?key|auth[_-]?token|cookie|set-cookie|session[_-]?id|bearer'

/** Replacement for one rule: a literal, or a callback that keeps the key name. */
type RuleReplacement = string | ((match: string) => string)

/** Credential shapes that carry their own unambiguous prefix. */
const PREFIX_RULES: readonly { readonly pattern: RegExp; readonly replace: RuleReplacement }[] = [
  // OpenAI / DeepSeek / generic `sk-` keys, including `sk-live_…` style.
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}/g, replace: REDACTED },
  // GitHub tokens.
  { pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, replace: REDACTED },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: REDACTED },
  // Slack tokens.
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replace: REDACTED },
  // AWS access key ids.
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: REDACTED },
  // Google API keys.
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: REDACTED },
  // JSON Web Tokens.
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replace: REDACTED,
  },
  // `Authorization: <anything>` and `Authorization: Bearer <anything>`.
  {
    pattern: new RegExp(`\\bauthorization\\b\\s*[:=]\\s*(?:Bearer\\s+)?[^\\s"',;]+`, 'gi'),
    replace: `Authorization: ${REDACTED}`,
  },
  // A bare `Bearer <token>`.
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, replace: `Bearer ${REDACTED}` },
  // `PASSWORD=…`, `TOKEN: …`, `COOKIE=…`, `API_KEY=…`, …
  {
    pattern: new RegExp(`\\b(?:${SECRET_KEY})\\b\\s*[:=]\\s*["']?[^\\s"',;]{4,}`, 'gi'),
    replace: (match: string) => {
      const separator = match.search(/[:=]/)
      const head = separator === -1 ? match : match.slice(0, separator)
      return `${head.trimEnd()}${separator === -1 ? '' : match[separator]} ${REDACTED}`
    },
  },
  // Query-string credentials: `?api_key=…`, `&access_token=…`.
  {
    pattern: new RegExp(`[?&](?:${SECRET_KEY})=[^\\s&#"']{4,}`, 'gi'),
    replace: (match: string) => `${match.slice(0, match.indexOf('=') + 1)}${REDACTED}`,
  },
]

/** Canonical long hexadecimal digests (md5 is 32, sha1 40, sha256 64). */
const HEX_BLOB = /(?<![0-9A-Za-z])[0-9a-fA-F]{32,}(?![0-9A-Za-z])/g

/** Candidate base64/url-safe blobs; the callback decides whether they are secrets. */
const BASE64_BLOB = /(?<![0-9A-Za-z+/])[A-Za-z0-9+/]{40,}={0,2}(?![0-9A-Za-z+/])/g

/**
 * Redact every secret-shaped run in one string.
 *
 * @param text - any text, typically a rendered prompt or one message body.
 * @returns the same text with credentials replaced by {@link REDACTED}.
 */
export function redactText(text: string): string {
  let out = text
  for (const rule of PREFIX_RULES) {
    out = out.replace(rule.pattern, rule.replace as string)
  }

  out = out.replace(HEX_BLOB, REDACTED)
  out = out.replace(BASE64_BLOB, (match) => {
    // Only canonical base64 — padded, or carrying a `+`/`/` — is treated as a
    // secret. Otherwise a long mixed-case identifier would be a false positive.
    const padded = match.endsWith('=')
    if (!padded && !/[+/]/.test(match)) return match
    return REDACTED
  })
  return out
}

/**
 * Deep-redact a JSON-ish value: every string leaf passes through
 * {@link redactText}. Objects and arrays are copied, never mutated.
 *
 * @param value - any value; non-string leaves are returned unchanged.
 * @returns a detached, redacted copy.
 */
export function redactSecrets<T>(value: T): T {
  return walk(value) as T
}

function walk(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map((item) => walk(item))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      // A secret-named key is replaced wholesale, whatever its value shape.
      out[key] = isSecretKey(key) ? REDACTED : walk(item)
    }
    return out
  }
  return value
}

function isSecretKey(key: string): boolean {
  return new RegExp(`^(?:${SECRET_KEY})$`, 'i').test(key)
}
