import { describe, expect, it } from 'vitest'
import { REDACTED, redactSecrets, redactText } from '../../src/redaction.js'

/**
 * Credential-shaped fixtures are assembled at run time rather than spelled out
 * as literals. A key-shaped string sitting in the source tree trips GitHub push
 * protection and every secret scanner that reads the repository, even when it
 * is obviously synthetic — so the shapes are built from harmless fragments.
 */
const DEEPSEEK_KEY = `sk-${'a'.repeat(24)}${'0'.repeat(8)}`
const GITHUB_TOKEN = `ghp_${'A'.repeat(24)}${'0'.repeat(8)}`
const AWS_KEY_ID = `AKIA${'B'.repeat(16)}`
const JWT = `eyJ${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(12)}`

describe('redaction (UT-RD)', () => {
  it('UT-RD-01 recognizes prefixed credentials, Bearer tokens, and Authorization headers', () => {
    const text = [
      `export DEEPSEEK_API_KEY=${DEEPSEEK_KEY}`,
      `git token ${GITHUB_TOKEN}`,
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
      'header Authorization: token-1234567890',
      `aws ${AWS_KEY_ID}`,
      `jwt ${JWT}`,
    ].join('\n')

    const redacted = redactText(text)

    expect(redacted).not.toContain(DEEPSEEK_KEY)
    expect(redacted).not.toContain(GITHUB_TOKEN)
    expect(redacted).not.toContain('a'.repeat(24))
    expect(redacted).not.toContain(AWS_KEY_ID)
    expect(redacted).not.toContain('b'.repeat(12))
    expect(redacted).toContain(REDACTED)
    // The key names survive, so the brief still says what was removed.
    expect(redacted).toContain('DEEPSEEK_API_KEY')
  })

  it('UT-RD-02 recognizes PASSWORD=, TOKEN=, and COOKIE= assignments', () => {
    const text = ['PASSWORD=hunter2secret', 'TOKEN: abcdef123456', 'COOKIE=sessionid%3Dabc123'].join('\n')

    const redacted = redactText(text)

    expect(redacted).not.toContain('hunter2secret')
    expect(redacted).not.toContain('abcdef123456')
    expect(redacted).not.toContain('sessionid%3Dabc123')
    // The key stays readable, so the summary still shows what was removed.
    expect(redacted).toContain('PASSWORD')
    expect(redacted).toContain('TOKEN')
    expect(redacted).toContain('COOKIE')
  })

  it('UT-RD-03 replaces long hexadecimal and canonical base64 blobs', () => {
    const hex = 'a3f5c9d1e7b24860a3f5c9d1e7b24860'
    const sha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    const base64 = 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU2Nzg5QUJDREVG+/=='

    const redacted = redactText(`hex=${hex} sha=${sha} b64=${base64}`)

    expect(redacted).not.toContain(hex)
    expect(redacted).not.toContain(sha)
    expect(redacted).not.toContain(base64)
    expect(redacted.match(/\[已脱敏\]/g)).toHaveLength(3)
  })

  it('UT-RD-04 leaves ordinary technical text untouched', () => {
    const text = [
      '请在 E:\\work\\dsh-auto-handoff\\src\\session-summary.ts 中修复 resolveSessionProjectionStateMapKey。',
      '命令 npm run typecheck && npm test 应当通过。',
      'HTTP/1.1 200 OK, content-type: application/json; charset=utf-8',
      'harness 版本 0.1.5-rc.3，peer 范围 >=0.1.5-rc.1 <0.1.6-0。',
      'the quick brown fox jumps over the lazy dog, repeatedly and without incident',
    ].join('\n')

    expect(redactText(text)).toBe(text)
  })

  it('is idempotent and redacts object leaves deeply', () => {
    const once = redactText('PASSWORD=abc12345')
    expect(redactText(once)).toBe(once)

    const value = {
      note: 'PASSWORD=abc12345',
      nested: [{ token: GITHUB_TOKEN }],
      safe: 42,
    }
    const redacted = redactSecrets(value)

    expect(JSON.stringify(redacted)).not.toContain('abc12345')
    expect(JSON.stringify(redacted)).not.toContain('ghp_')
    expect(redacted.safe).toBe(42)
    // The original value is never mutated.
    expect(value.note).toContain('abc12345')
  })
})
