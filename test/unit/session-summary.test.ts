import { createAssistantMessage, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import {
  buildSummaryInput,
  collectFileChanges,
  EMPTY_SECTION,
  generateSummary,
  parseSummarySections,
  renderSummary,
  SUMMARY_HEADINGS,
  SUMMARY_SECTION_KEYS,
  type SummaryFacts,
} from '../../src/session-summary.js'
import { appendToolCall, appendUserMessage, createTestSession } from '../harness.js'

function facts(overrides: Partial<SummaryFacts> = {}): SummaryFacts {
  return {
    cwd: 'E:\\work\\dsh-auto-handoff',
    provider: 'deepseek',
    model: 'deepseek-chat',
    planModeActive: false,
    permissionPreset: 'default',
    approvalPolicy: 'ask',
    compacted: false,
    fileChanges: [],
    failures: [],
    transcriptSize: 3,
    truncated: false,
    ...overrides,
  }
}

const userMessage = (text: string) =>
  createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

const pluginMessage = (text: string) =>
  createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-auto-handoff' },
  })

describe('summary rendering (UT-SU)', () => {
  it('UT-SU-01/02 renders every documented section and writes （无） for empty ones', () => {
    const brief = renderSummary({ goal: '完成插件', completed: '写了测试' }, facts(), [])

    expect(brief.startsWith('# 任务迁移摘要')).toBe(true)
    for (const key of SUMMARY_SECTION_KEYS) {
      expect(brief).toContain(`## ${SUMMARY_HEADINGS[key]}`)
    }
    expect(brief).toContain('## 原会话配置')
    expect(brief).toContain('## 给新会话的指令')
    expect(brief).toContain('请基于以上信息继续完成未完成的任务。')
    expect(brief).toContain('不要重复已经完成的工作。')

    expect(brief).toContain('完成插件')
    // Sections the model left out are present but explicitly empty; the two it
    // answered carry its text.
    for (const key of SUMMARY_SECTION_KEYS) {
      const heading = `## ${SUMMARY_HEADINGS[key]}`
      const index = brief.indexOf(heading)
      expect(index).toBeGreaterThanOrEqual(0)
      const body = brief
        .slice(index + heading.length)
        .split('\n')
        .find((line) => line.length > 0)
      if (key === 'goal' || key === 'completed') expect(body).not.toBe(EMPTY_SECTION)
      else expect(body).toBe(EMPTY_SECTION)
    }
    expect(brief).toContain('- 工作区：E:\\work\\dsh-auto-handoff')
    expect(brief).toContain('- 模型：deepseek-chat')
    expect(brief).toContain('- 是否经历过压缩：否')
  })

  it('UT-SU-03 keeps log-only events out of the transcript', () => {
    const session = createTestSession('s-log-only')
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('command/run', {
      commandId: 'cmd-1' as never,
      name: 'handoff',
      args: ' status',
      source: { kind: 'user' },
    })
    session.append('command/done', { commandId: 'cmd-1' as never, kind: 'success', text: '好了' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    expect(session.deriveMessages()).toHaveLength(0)
    expect(buildSummaryInput(session.deriveMessages())).toHaveLength(0)
  })

  it('UT-SU-04 does not re-append content a surface replacement shadowed', () => {
    const session = createTestSession('s-compacted')
    appendUserMessage(session, '第一段很长的旧内容', 'msg-a')
    expect(session.deriveMessages()).toHaveLength(1)

    session.append(
      'user/message',
      userMessage('压缩后的摘要节点'),
      { surfaceOp: { op: 'replace', startSeq: 0 as never, endSeq: 0 as never }, sourceEventSeqs: [0 as never] },
    )

    const derived = session.deriveMessages()
    expect(derived).toHaveLength(1)
    expect(JSON.stringify(derived)).toContain('压缩后的摘要节点')
    const input = buildSummaryInput(derived)
    expect(input).toHaveLength(1)
    expect(input[0]?.text).toBe('压缩后的摘要节点')
  })

  it('UT-SU-05 drops plugin-sourced messages and de-duplicates repeated content', () => {
    const messages = [
      userMessage('请修复登录问题'),
      pluginMessage('内部注入：文件变更通知'),
      userMessage('请修复登录问题'),
      createAssistantMessage({
        content: [{ type: 'text', text: '好的，我先看代码。' }],
        source: { provider: 'deepseek', model: 'deepseek-chat' },
      }),
    ]

    const input = buildSummaryInput(messages)

    expect(input.map((entry) => entry.text)).toEqual(['请修复登录问题', '好的，我先看代码。'])
    expect(input[0]?.role).toBe('user')
    expect(input[1]?.role).toBe('assistant')
  })

  it('caps the transcript and truncates very long entries', () => {
    const messages = Array.from({ length: 12 }, (_, index) => userMessage(`消息 ${index}`))
    expect(buildSummaryInput(messages, { maxMessages: 3 }).map((entry) => entry.text)).toEqual([
      '消息 9',
      '消息 10',
      '消息 11',
    ])

    const long = userMessage('x'.repeat(120))
    const [entry] = buildSummaryInput([long], { maxCharsPerMessage: 50 })
    expect(entry?.text.endsWith('…[已截断]')).toBe(true)
    expect(entry?.text.length).toBeLessThan(70)
  })

  it('collects touched files from tool calls only', () => {
    const session = createTestSession('s-files')
    appendToolCall(session, 'write', { path: 'src/index.ts' })
    appendToolCall(session, 'edit', { file_path: 'src/state.ts' })
    appendToolCall(session, 'write', { path: 'src/index.ts' })
    appendToolCall(session, 'read', { path: 'src/index.ts' })
    appendToolCall(session, 'grep', { pattern: 'x' })

    const changes = collectFileChanges(session.snapshotEvents())

    expect(changes).toEqual([
      { path: 'src/index.ts', tools: ['write'] },
      { path: 'src/state.ts', tools: ['edit'] },
    ])
  })

  it('parses a fenced JSON reply defensively', () => {
    expect(parseSummarySections('{"goal":"G","next":"N"}')).toEqual({ goal: 'G', next: 'N' })
    expect(parseSummarySections('```json\n{"goal":"G"}\n```')).toEqual({ goal: 'G' })
    expect(parseSummarySections('前言 {"goal":"G"} 后记')).toEqual({ goal: 'G' })
    expect(parseSummarySections('{"goal":"","next":"  "}')).toEqual({})
    expect(() => parseSummarySections('not json at all')).toThrow()
  })

  it('generates a brief from a streamed model reply without a purpose field', async () => {
    const seen: unknown[] = []
    async function* stream(text: string): AsyncGenerator<StreamChunk> {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    }

    const result = await generateSummary({
      stream: (options) => {
        seen.push(options)
        return stream('{"goal":"完成交接插件","todo":"补齐 README"}')
      },
      provider: 'deepseek',
      model: 'deepseek-chat',
      maxTokens: 4096,
      sessionId: 'session-1',
      signal: new AbortController().signal,
      transcript: [{ role: 'user', text: '请完成插件' }],
      facts: facts(),
    })

    expect(result.sections.goal).toBe('完成交接插件')
    expect(result.text).toContain('完成交接插件')
    const options = seen[0] as { purpose?: unknown; system?: string; messages: unknown[] }
    expect(options.purpose).toBeUndefined()
    expect(options.system).toContain('JSON')
    expect(options.messages).toHaveLength(1)
  })

  it('fails loudly on an unparsable or empty reply', async () => {
    async function* stream(text: string): AsyncGenerator<StreamChunk> {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    }
    const base = {
      provider: 'deepseek',
      model: 'deepseek-chat',
      maxTokens: 4096,
      sessionId: 'session-1',
      signal: new AbortController().signal,
      transcript: [{ role: 'user' as const, text: 'hi' }],
      facts: facts(),
    }

    await expect(
      generateSummary({ ...base, stream: () => stream('抱歉我不能这样做') }),
    ).rejects.toThrow()
    await expect(generateSummary({ ...base, stream: () => stream('') })).rejects.toThrow()
    await expect(
      generateSummary({ ...base, stream: () => stream('{"goal":"ok"}') }),
    ).resolves.toBeTruthy()
  })

  it('redacts credentials before the prompt reaches the model', async () => {
    let captured = ''
    async function* stream(text: string): AsyncGenerator<StreamChunk> {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    }

    await generateSummary({
      stream: (options) => {
        const message = options.messages[0] as { content: { type: string; text?: string }[] }
        captured = message.content.map((block) => block.text ?? '').join('')
        return stream('{"goal":"g"}')
      },
      provider: 'deepseek',
      model: 'deepseek-chat',
      maxTokens: 1024,
      sessionId: 'session-1',
      signal: new AbortController().signal,
      transcript: [{ role: 'user', text: 'PASSWORD=hunter2secret' }],
      facts: facts(),
    })

    expect(captured).toContain('[已脱敏]')
    expect(captured).not.toContain('hunter2secret')
  })
})
