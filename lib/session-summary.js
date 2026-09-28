import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { redactSecrets, redactText } from './redaction.js';
/** Default cap on how many transcript entries enter the prompt. */
export const SUMMARY_MAX_MESSAGES = 200;
/** Default per-entry character cap. */
export const SUMMARY_MAX_CHARS_PER_MESSAGE = 8_000;
/** Tool-name fragments that mean "this call touches the filesystem". */
const MUTATING_TOOL_PATTERN = /write|edit|patch|create|delete|remove|move|rename|copy|mkdir|touch|str_replace|insert|append|truncate/i;
/** Argument keys a filesystem tool uses to name its target. */
const PATH_KEYS = ['path', 'file_path', 'filePath', 'filepath', 'target', 'notebook_path', 'to', 'destination'];
/**
 * Flatten a model-visible history into a bounded, redacted transcript.
 *
 * Filtering rules (`TASK-PLAN.md` §7.4 step 2):
 * - system messages are dropped — the assembled system prompt is harness
 *   boilerplate and would dominate the budget;
 * - plugin-sourced messages are dropped — they are internal injections;
 * - repeated content is collapsed to its last occurrence;
 * - only the most recent `maxMessages` entries survive, each truncated.
 *
 * @param messages - `session.deriveMessages()`.
 * @param options - caps; see the module constants for the defaults.
 * @returns the transcript, oldest first.
 */
export function buildSummaryInput(messages, options = {}) {
    const maxMessages = options.maxMessages ?? SUMMARY_MAX_MESSAGES;
    const maxChars = options.maxCharsPerMessage ?? SUMMARY_MAX_CHARS_PER_MESSAGE;
    const kept = [];
    const seen = new Set();
    for (const message of messages) {
        if (message.role === 'system')
            continue;
        const source = message.source;
        if (source.kind === 'plugin')
            continue;
        const text = renderContent(message.content).replace(/\s+/g, ' ').trim();
        if (text.length === 0)
            continue;
        const clamped = text.length > maxChars ? `${text.slice(0, maxChars)}…[已截断]` : text;
        const digest = fingerprint(clamped);
        if (seen.has(digest))
            continue;
        seen.add(digest);
        const entry = {
            role: message.role === 'assistant' ? 'assistant' : 'user',
            text: clamped,
        };
        if (source.kind === 'tool')
            entry.tool = true;
        kept.push(entry);
    }
    return kept.length > maxMessages ? kept.slice(kept.length - maxMessages) : kept;
}
/** Render one content-block list to plain text. */
export function renderContent(blocks) {
    const parts = [];
    for (const block of blocks) {
        switch (block.type) {
            case 'text':
                parts.push(block.text);
                break;
            case 'reasoning':
                // Reasoning is model-private scratch; keep only a marker so the
                // summarizer knows deliberation happened without paying for it.
                parts.push('[思考]');
                break;
            case 'tool-call':
                parts.push(`[调用工具 ${block.name} ${clamp(block.arguments, 400)}]`);
                break;
            case 'tool-result':
                parts.push(renderContent(block.content));
                break;
            case 'image':
                parts.push('[图片]');
                break;
            case 'file':
                parts.push('[文件]');
                break;
            default:
                break;
        }
    }
    return parts.join('\n');
}
function clamp(text, limit) {
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
/** Order-independent content fingerprint (FNV-1a, 32-bit). */
function fingerprint(text) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `${hash.toString(16)}:${text.length}`;
}
/**
 * Fold `tool/call` events into the set of files the session created, modified,
 * or removed. Facts come from the durable log, never from model memory.
 *
 * @param events - `session.snapshotEvents()`, or any suffix of it.
 * @returns one entry per distinct path, in first-touch order.
 */
export function collectFileChanges(events) {
    const byPath = new Map();
    for (const event of events) {
        if (event.type !== 'tool/call')
            continue;
        const { name, arguments: rawArguments } = event.data;
        if (!MUTATING_TOOL_PATTERN.test(name))
            continue;
        let args;
        try {
            args = JSON.parse(rawArguments);
        }
        catch {
            continue;
        }
        if (args === null || typeof args !== 'object')
            continue;
        const record = args;
        let path;
        for (const key of PATH_KEYS) {
            const value = record[key];
            if (typeof value === 'string' && value.trim().length > 0) {
                path = value.trim();
                break;
            }
        }
        if (path === undefined)
            continue;
        const existing = byPath.get(path);
        if (existing === undefined) {
            byPath.set(path, { path, tools: [name] });
        }
        else if (!existing.tools.includes(name)) {
            existing.tools.push(name);
        }
    }
    return [...byPath.values()];
}
/** The nine model-authored sections, in the fixed output order. */
export const SUMMARY_SECTION_KEYS = [
    'goal',
    'constraints',
    'completed',
    'current',
    'files',
    'decisions',
    'problems',
    'todo',
    'next',
];
/** Heading text per section, in the exact order the brief renders. */
export const SUMMARY_HEADINGS = {
    goal: '总体目标',
    constraints: '用户要求与限制',
    completed: '已完成工作',
    current: '当前进度',
    files: '已修改文件',
    decisions: '关键技术决策',
    problems: '已知问题与错误',
    todo: '未完成任务',
    next: '下一步行动',
};
/** Placeholder for a section the model left empty. */
export const EMPTY_SECTION = '（无）';
/** System prompt for the summarizing call. */
export const SUMMARY_SYSTEM = [
    '你是一个会话交接助手。你会收到一段被裁剪过的会话记录，以及一组由程序直接读取的真实状态。',
    '请把这段会话压缩成一份能让一个全新的会话继续工作的交接简报。',
    '严格只输出一个 JSON 对象，不要输出任何解释、前言或 Markdown 代码围栏。',
    `JSON 的键固定为：${SUMMARY_SECTION_KEYS.join('、')}。`,
    '每个键的值是一个字符串；如果该项确实没有内容，写空字符串。',
    '不要编造：会话记录里没有的模型名、模式、权限、文件或结论一律不要写。',
    '已知的文件改动清单由程序提供，请直接采用，不要另行推测。',
].join('\n');
/**
 * Build the summarizing prompt.
 *
 * @param transcript - the bounded transcript.
 * @param facts - program-read facts, rendered verbatim into the prompt.
 * @returns the redacted prompt text.
 */
export function buildSummaryPrompt(transcript, facts) {
    const lines = [];
    lines.push('## 程序读取的真实状态');
    lines.push(`- 工作区：${facts.cwd ?? '（未知）'}`);
    lines.push(`- 模型：${facts.model ?? '（未知）'}${facts.provider === undefined ? '' : `（provider: ${facts.provider}）`}`);
    lines.push(`- 模式：${facts.planModeActive ? 'Plan 模式（只读规划）' : '普通模式'}`);
    lines.push(`- 权限控制：${facts.permissionPreset ?? '（未知）'}${facts.approvalPolicy === undefined ? '' : ` / 审批策略 ${facts.approvalPolicy}`}`);
    lines.push(`- 是否经历过压缩：${facts.compacted ? '是' : '否'}`);
    lines.push(`- 已修改文件（程序从工具调用归纳，直接采用）：${renderFileChanges(facts.fileChanges)}`);
    if (facts.lastStep !== undefined)
        lines.push(`- 最近一个完整 Step 的结果：${facts.lastStep}`);
    if (facts.failures.length > 0)
        lines.push(`- 记录到的失败：${facts.failures.join('；')}`);
    lines.push('');
    lines.push('## 会话记录（已裁剪与脱敏，最早的在前）');
    if (transcript.length === 0) {
        lines.push('（无）');
    }
    else {
        for (const entry of transcript) {
            const label = entry.tool === true ? '工具输出' : entry.role === 'assistant' ? '助手' : '用户';
            lines.push(`### ${label}`);
            lines.push(entry.text);
        }
    }
    if (facts.truncated) {
        lines.push('');
        lines.push(`注意：会话记录已裁剪，仅保留最近 ${facts.transcriptSize} 条，更早的内容不可见。`);
    }
    lines.push('');
    lines.push(`请输出 JSON：${SUMMARY_SECTION_KEYS.map((key) => `"${key}"`).join(', ')}`);
    return redactText(lines.join('\n'));
}
function renderFileChanges(changes) {
    if (changes.length === 0)
        return '（无）';
    return changes.map((change) => `${change.path}（${change.tools.join('、')}）`).join('；');
}
/**
 * Parse the summarizer's JSON reply defensively.
 *
 * @param raw - the model's raw text.
 * @returns the recognized sections; unknown keys are ignored.
 * @throws {Error} when no JSON object can be recovered.
 */
export function parseSummarySections(raw) {
    const candidate = extractJsonObject(raw);
    if (candidate === undefined) {
        throw new Error('摘要响应不是可解析的 JSON 对象。');
    }
    let parsed;
    try {
        parsed = JSON.parse(candidate);
    }
    catch (error) {
        throw new Error(`摘要响应 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('摘要响应不是 JSON 对象。');
    }
    const record = parsed;
    const out = {};
    for (const key of SUMMARY_SECTION_KEYS) {
        const value = record[key];
        if (typeof value === 'string' && value.trim().length > 0)
            out[key] = value.trim();
    }
    return out;
}
function extractJsonObject(raw) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}'))
        return trimmed;
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
    if (fence !== null && fence[1] !== undefined) {
        const inner = fence[1].trim();
        if (inner.startsWith('{'))
            return inner;
    }
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start)
        return trimmed.slice(start, end + 1);
    return undefined;
}
/**
 * Render the fixed brief: the nine model sections, then the program-read
 * configuration, then the instruction block for the new session. Every
 * section is always present; an empty one renders {@link EMPTY_SECTION}
 * rather than being omitted.
 *
 * @param sections - the parsed model sections.
 * @param facts - the program-read facts.
 * @param failures - failures recorded while preparing the migration.
 * @returns the complete handoff brief, already redacted.
 */
export function renderSummary(sections, facts, failures = []) {
    const lines = ['# 任务迁移摘要'];
    for (const key of SUMMARY_SECTION_KEYS) {
        const body = sections[key];
        lines.push('', `## ${SUMMARY_HEADINGS[key]}`, body !== undefined && body.length > 0 ? body : EMPTY_SECTION);
    }
    lines.push('', '## 原会话配置');
    lines.push(`- 工作区：${facts.cwd ?? '（未知）'}`);
    lines.push(`- 模式：${facts.planModeActive ? 'Plan 模式' : '普通模式'}`);
    lines.push(`- 模型：${facts.model ?? '（未知）'}`);
    lines.push(`- 权限控制：${facts.permissionPreset ?? '（未知）'}${facts.approvalPolicy === undefined ? '' : ` / 审批策略 ${facts.approvalPolicy}`}`);
    lines.push(`- 是否经历过压缩：${facts.compacted ? '是' : '否'}`);
    lines.push(`- 已修改文件：${renderFileChanges(facts.fileChanges)}`);
    if (failures.length > 0) {
        lines.push(`- 迁移期间记录到的失败：${failures.join('；')}`);
    }
    lines.push('', '## 给新会话的指令');
    lines.push('请基于以上信息继续完成未完成的任务。');
    lines.push('不要重复已经完成的工作。');
    lines.push('如果上下文不完整，请先检查当前工作区、已有文件和项目状态，再继续执行。');
    return redactText(lines.join('\n'));
}
/**
 * Ask the session's own model for a structured brief and render it.
 *
 * No `purpose` is passed: on `0.1.5-rc.3` that field is a closed union
 * (`'compaction' | 'session-title'`) and this call is neither
 * (`TASK-PLAN.md` §4.10).
 *
 * @param deps - routing, budget, transcript, and facts.
 * @returns the rendered brief.
 * @throws {Error} when the stream fails, the reply is unparsable, or the
 *   rendered brief carries no model-authored section.
 */
export async function generateSummary(deps) {
    const prompt = buildSummaryPrompt(deps.transcript, deps.facts);
    const assembler = new BlockAssembler();
    const options = {
        provider: deps.provider,
        model: deps.model,
        messages: [
            createUserMessage({
                content: [{ type: 'text', text: prompt }],
                source: { kind: 'plugin', plugin: 'dsh-auto-handoff' },
            }),
        ],
        system: SUMMARY_SYSTEM,
        maxTokens: deps.maxTokens,
        signal: deps.signal,
        sessionId: deps.sessionId,
    };
    if (deps.reasoningEffort !== undefined) {
        options.reasoningEffort = deps.reasoningEffort;
    }
    for await (const chunk of deps.stream(options)) {
        assembler.push(chunk);
    }
    const finish = assembler.finish;
    if (finish.kind !== 'stop' && finish.kind !== 'max-tokens') {
        throw new Error(`模型未正常结束摘要生成（finish=${finish.kind}）。`);
    }
    const raw = assembler.blocks().map(blockText).join('').trim();
    if (raw.length === 0)
        throw new Error('模型返回了空摘要。');
    const sections = parseSummarySections(raw);
    const authored = SUMMARY_SECTION_KEYS.filter((key) => sections[key] !== undefined);
    if (authored.length === 0)
        throw new Error('摘要未包含任何可识别小节。');
    return { text: renderSummary(sections, deps.facts), sections, raw };
}
function blockText(block) {
    if (block.type === 'text')
        return block.text;
    return '';
}
/**
 * The completed-compaction marker. Compared as a plain string so this module
 * keeps working even when `@deepseek-ai/dsh-compaction` (which merges the event
 * into `SessionEventMap`) is not part of the compilation.
 */
const COMPACTION_END = 'compaction/end';
/**
 * Read the cheap, always-available facts from a live session.
 *
 * @param input - the session and already-resolved configuration values.
 * @returns the partial fact set, before file changes and the last step are added.
 */
export function readSessionFacts(input) {
    const header = input.session.header;
    const events = input.session.snapshotEvents();
    return {
        cwd: header.cwd,
        provider: input.route?.provider,
        model: input.route?.model,
        planModeActive: input.planModeActive,
        permissionPreset: input.permissionPreset,
        approvalPolicy: input.approvalPolicy,
        compacted: events.some((event) => event.type === COMPACTION_END),
        fileChanges: collectFileChanges(events),
    };
}
/**
 * Render the last complete step's outcome: the trailing `step/end` and the
 * nearest preceding assistant text or tool result.
 *
 * @param events - the durable log.
 * @returns a one-line summary, or `undefined` when no step has completed.
 */
export function readLastStep(events) {
    let lastStepEnd = -1;
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event !== undefined && event.type === 'step/end') {
            lastStepEnd = index;
            break;
        }
    }
    if (lastStepEnd === -1)
        return undefined;
    for (let index = lastStepEnd - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event === undefined)
            continue;
        if (event.type === 'assistant/message') {
            const text = renderContent(event.data.message.content).replace(/\s+/g, ' ').trim();
            if (text.length > 0) {
                return `turn ${event.data.turn} step ${event.data.step}：${clamp(text, 400)}`;
            }
        }
        if (event.type === 'tool/result') {
            const text = renderContent(event.data.message.content).replace(/\s+/g, ' ').trim();
            if (text.length > 0) {
                return `turn ${event.data.turn} step ${event.data.step} 工具结果：${clamp(text, 400)}`;
            }
        }
    }
    return undefined;
}
/**
 * Redact-and-freeze helper used by the migration path before the brief is
 * handed to a new session.
 *
 * @param brief - the rendered brief.
 * @returns the brief with any credential-shaped run replaced.
 */
export function sanitizeBrief(brief) {
    return redactText(brief);
}
/** Re-export so callers do not need a second import for deep redaction. */
export { redactSecrets };
