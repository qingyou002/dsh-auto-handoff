/**
 * The settings card: one plugin card inside Settings → Plugins → configurable
 * (`TASK-PLAN.md` §10.2).
 *
 * Written with `createElement` and no JSX because this file is compiled to
 * CommonJS and inlined into a browser bundle envelope, not through a JSX
 * pipeline. Every colour goes through a `--dsw-alias-*` design token; literal
 * values are fallbacks for hosts predating the alias table. The root node
 * carries `data-dsh-plugin="dsh-auto-handoff"` so skins can target it.
 */
import { createElement as h, useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  NAMESPACE,
  ROUTE_PREFIX,
  type HandoffSettingsShape,
  type SessionsLike,
  type SettingsScopeLike,
  type StatePayload,
} from './protocol.js'

export { NAMESPACE, ROUTE_PREFIX }
export type { HandoffSettingsShape, SessionsLike, SettingsScopeLike, StatePayload }

/** Stable DOM marker for skins and tests. */
export const DATA_ATTR = 'dsh-auto-handoff'

/** Props the registration closes over. */
export interface HandoffCardProps {
  scope: SettingsScopeLike | undefined
  sessions: SessionsLike | undefined
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Poll interval in ms; defaults to 2000. */
  pollMs?: number
}

const FIELD_LABELS: Readonly<Record<keyof HandoffSettingsShape, string>> = {
  autoHandoffEnabled: '启用 Token 阈值自动迁移',
  autoHandoffThreshold: '自动迁移阈值（会话累计 Token）',
  autoCompactEnabled: '启用 Token 阈值自动压缩',
  autoCompactThreshold: '自动压缩阈值（会话累计 Token）',
  rearmDeltaTokens: '重臂增量（动作成功后需再增长多少 Token）',
  maxAutoActionsPerSession: '单会话自动动作上限（1–10）',
  summaryMaxTokens: '摘要输出上限（Token）',
  stepWaitTimeoutMs: '等待 Step 完成的「偏久」提示阈值（毫秒）',
  actionDeadlineMs: '动作总时限（毫秒，到期只释放闩锁）',
  openNewSessionOnHandoff: '迁移成功后自动切换到新会话',
}

const MAIN_FIELDS: readonly (keyof HandoffSettingsShape)[] = [
  'autoHandoffEnabled',
  'autoHandoffThreshold',
  'autoCompactEnabled',
  'autoCompactThreshold',
]

const ADVANCED_FIELDS: readonly (keyof HandoffSettingsShape)[] = [
  'rearmDeltaTokens',
  'maxAutoActionsPerSession',
  'summaryMaxTokens',
  'stepWaitTimeoutMs',
  'actionDeadlineMs',
  'openNewSessionOnHandoff',
]

const DEFAULT_DRAFT: HandoffSettingsShape = {
  autoHandoffEnabled: false,
  autoHandoffThreshold: 2_000_000,
  autoCompactEnabled: false,
  autoCompactThreshold: 1_500_000,
  rearmDeltaTokens: 200_000,
  maxAutoActionsPerSession: 3,
  summaryMaxTokens: 4096,
  stepWaitTimeoutMs: 900_000,
  actionDeadlineMs: 1_800_000,
  openNewSessionOnHandoff: true,
}

const S = {
  box: {
    padding: '4px 2px',
    color: 'var(--dsw-alias-label-primary, #c9d1d9)',
    fontSize: '13px',
    lineHeight: '1.6',
  },
  h2: { fontSize: '15px', fontWeight: 600, margin: '0 0 4px' },
  hint: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #8b949e)', margin: '4px 0 0' },
  section: { marginTop: '14px' },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    margin: '6px 0',
  },
  input: {
    width: '160px',
    padding: '3px 6px',
    background: 'var(--dsw-alias-bg-layer-1, #0d1117)',
    color: 'inherit',
    border: '1px solid var(--dsw-alias-border-l1, #30363d)',
    borderRadius: '4px',
    font: 'inherit',
  },
  button: {
    padding: '4px 10px',
    marginRight: '8px',
    borderRadius: '4px',
    border: '1px solid var(--dsw-alias-border-l1, #30363d)',
    background: 'var(--dsw-alias-bg-layer-1, #0d1117)',
    color: 'inherit',
    cursor: 'pointer',
  },
  buttonPrimary: {
    padding: '4px 10px',
    marginRight: '8px',
    borderRadius: '4px',
    border: 'none',
    background: 'var(--dsw-alias-button-primary-fill, #2f81f7)',
    color: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
    cursor: 'pointer',
  },
  buttonDisabled: { opacity: 0.5, cursor: 'not-allowed' },
  bar: {
    height: '6px',
    borderRadius: '3px',
    background: 'var(--dsw-alias-bg-layer-1, #0d1117)',
    border: '1px solid var(--dsw-alias-border-l1, #30363d)',
    overflow: 'hidden',
    margin: '4px 0 0',
  },
  barFill: { height: '100%', background: 'var(--dsw-alias-button-primary-fill, #2f81f7)' },
  warn: { color: 'var(--dsw-alias-state-warning-primary, #d29922)', fontSize: '12px' },
  error: { color: 'var(--dsw-alias-state-error-primary, #f85149)', fontSize: '12px' },
  ok: { color: 'var(--dsw-alias-state-success-primary, #3fb950)', fontSize: '12px' },
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' },
}

/**
 * One plugin card.
 *
 * @param props - the settings scope, the sessions service, and test seams.
 * @returns the rendered card.
 */
export function HandoffCard(props: HandoffCardProps): ReactNode {
  const { scope, sessions } = props
  const fetchImpl = props.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined)
  const pollMs = props.pollMs ?? 2000

  const [, forceRender] = useState(0)
  const snapshot = scope?.getSnapshot()
  const [draft, setDraft] = useState<HandoffSettingsShape>(DEFAULT_DRAFT)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [actionMessage, setActionMessage] = useState<string | undefined>(undefined)
  const [state, setState] = useState<StatePayload | undefined>(undefined)
  const [stateError, setStateError] = useState<string | undefined>(undefined)

  // Bind the draft to the host value until the user edits something.
  useEffect(() => {
    if (scope === undefined) return undefined
    const sync = (): void => {
      forceRender((value) => value + 1)
      if (dirty) return
      const next = scope.getSnapshot().value
      if (next !== undefined) setDraft(next)
    }
    sync()
    return scope.subscribe(sync)
  }, [scope, dirty])

  const sessionId = sessions?.list.getSnapshot().current

  // Poll the host state channel.
  useEffect(() => {
    if (fetchImpl === undefined || sessionId === undefined || sessionId.length === 0) return undefined
    let cancelled = false
    const tick = async (): Promise<void> => {
      try {
        const response = await fetchImpl(
          `${ROUTE_PREFIX}/state?sessionId=${encodeURIComponent(sessionId)}`,
          { headers: { accept: 'application/json' } },
        )
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const payload = (await response.json()) as StatePayload
        if (!cancelled) {
          setState(payload)
          setStateError(undefined)
        }
      } catch (error) {
        if (!cancelled) setStateError(error instanceof Error ? error.message : String(error))
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), pollMs)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [fetchImpl, sessionId, pollMs])

  // Switching to the new session is NOT done here: the follower in
  // `client/follow.ts` owns it, because it must run while the card is unmounted
  // (a `/handoff` typed in the chat never opens the settings tab).

  const invalid = useMemo(() => {
    if (!draft.autoHandoffEnabled || !draft.autoCompactEnabled) return undefined
    if (draft.autoCompactThreshold >= draft.autoHandoffThreshold) {
      return `自动压缩阈值（${draft.autoCompactThreshold}）必须小于自动迁移阈值（${draft.autoHandoffThreshold}）。`
    }
    return undefined
  }, [draft])

  const onChange = useCallback((field: keyof HandoffSettingsShape, value: unknown) => {
    setDirty(true)
    setDraft((previous) => ({ ...previous, [field]: value }))
  }, [])

  const onSave = useCallback(async () => {
    if (scope === undefined || invalid !== undefined) return
    setSaving(true)
    try {
      for (const field of [...MAIN_FIELDS, ...ADVANCED_FIELDS]) {
        const next = draft[field]
        const current = snapshot?.value?.[field]
        if (next === current) continue
        await scope.set(field, next)
      }
      setDirty(false)
      setActionMessage('设置已保存。')
    } catch (error) {
      setActionMessage(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSaving(false)
    }
  }, [scope, invalid, draft, snapshot])

  const post = useCallback(
    async (action: 'handoff' | 'cancel' | 'retry') => {
      if (fetchImpl === undefined || sessionId === undefined) return
      setActionMessage(undefined)
      try {
        const response = await fetchImpl(`${ROUTE_PREFIX}/${action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
        const payload = (await response.json()) as { ok?: boolean; text?: string; error?: string }
        setActionMessage(payload.text ?? payload.error ?? (payload.ok === true ? '已受理。' : '操作失败。'))
      } catch (error) {
        setActionMessage(`请求失败：${error instanceof Error ? error.message : String(error)}`)
      }
    },
    [fetchImpl, sessionId],
  )

  const children: ReactNode[] = [
    h('div', { key: 'title', style: S.h2 }, 'DeepSeek Harness Session Handoff'),
    h(
      'p',
      { key: 'intro', style: S.hint },
      '把当前会话的任务与进度摘要交给同工作区的新会话，继续未完成的任务。迁移不会硬中断正在运行的 Step 或 Tool Call。',
    ),
  ]

  if (scope === undefined) {
    children.push(h('p', { key: 'noscope', style: S.warn }, '设置服务不可用：无法读写本插件的设置。'))
  } else if (snapshot?.status === 'unavailable') {
    children.push(
      h('p', { key: 'unavailable', style: S.warn }, '设置服务未暴露本命名空间；设置仅在本次会话内有效。'),
    )
  }

  // ---- primary settings ----------------------------------------------------
  children.push(
    h(
      'div',
      { key: 'main', style: S.section },
      h('div', { style: S.h2 }, '主设置'),
      ...MAIN_FIELDS.map((field) => renderField(field, draft, onChange)),
      invalid === undefined ? null : h('p', { key: 'invalid', style: S.error }, invalid),
    ),
  )

  // ---- status --------------------------------------------------------------
  children.push(h('div', { key: 'status', style: S.section }, h('div', { style: S.h2 }, '状态'), ...renderStatus(state, stateError)))

  // ---- advanced ------------------------------------------------------------
  children.push(
    h(
      'div',
      { key: 'advanced', style: S.section },
      h('div', { style: S.h2 }, '高级设置'),
      ...ADVANCED_FIELDS.map((field) => renderField(field, draft, onChange)),
      h(
        'div',
        { style: { marginTop: '8px' } },
        h(
          'button',
          {
            type: 'button',
            style: invalid !== undefined || saving ? { ...S.buttonPrimary, ...S.buttonDisabled } : S.buttonPrimary,
            disabled: invalid !== undefined || saving,
            onClick: () => void onSave(),
          },
          saving ? '保存中…' : '保存设置',
        ),
        dirty ? h('span', { style: S.hint }, '有未保存的修改') : null,
      ),
    ),
  )

  // ---- actions -------------------------------------------------------------
  children.push(
    h(
      'div',
      { key: 'actions', style: S.section },
      h('div', { style: S.h2 }, '操作'),
      h(
        'div',
        null,
        h(
          'button',
          {
            type: 'button',
            style: fetchImpl === undefined || sessionId === undefined ? { ...S.button, ...S.buttonDisabled } : S.button,
            disabled: fetchImpl === undefined || sessionId === undefined,
            onClick: () => void post('handoff'),
          },
          '立即迁移',
        ),
        h(
          'button',
          {
            type: 'button',
            style: fetchImpl === undefined || sessionId === undefined ? { ...S.button, ...S.buttonDisabled } : S.button,
            disabled: fetchImpl === undefined || sessionId === undefined,
            onClick: () => void post('cancel'),
          },
          '取消',
        ),
        h(
          'button',
          {
            type: 'button',
            style: fetchImpl === undefined || sessionId === undefined ? { ...S.button, ...S.buttonDisabled } : S.button,
            disabled: fetchImpl === undefined || sessionId === undefined,
            onClick: () => void post('retry'),
          },
          '重试',
        ),
      ),
      actionMessage === undefined ? null : h('p', { key: 'action-message', style: S.hint }, actionMessage),
    ),
  )

  return h(
    'div',
    { style: S.box, 'data-dsh-plugin': DATA_ATTR, 'data-dsh-surface': 'settings-modal' },
    ...children,
  )
}

function renderField(
  field: keyof HandoffSettingsShape,
  draft: HandoffSettingsShape,
  onChange: (field: keyof HandoffSettingsShape, value: unknown) => void,
): ReactNode {
  const label = FIELD_LABELS[field]
  const value = draft[field]
  if (typeof value === 'boolean') {
    return h(
      'label',
      { key: field, style: S.row, 'data-dsh-part': 'field' },
      h('span', null, label),
      h('input', {
        type: 'checkbox',
        checked: value,
        'data-dsh-field': field,
        onChange: (event: { target: { checked: boolean } }) => onChange(field, event.target.checked),
      }),
    )
  }
  return h(
    'label',
    { key: field, style: S.row, 'data-dsh-part': 'field' },
    h('span', null, label),
    h('input', {
      type: 'number',
      min: 0,
      step: 1,
      value: String(value),
      style: S.input,
      'data-dsh-field': field,
      onChange: (event: { target: { value: string } }) => {
        const parsed = Number(event.target.value)
        onChange(field, Number.isFinite(parsed) ? Math.trunc(parsed) : 0)
      },
    }),
  )
}

function renderStatus(state: StatePayload | undefined, stateError: string | undefined): ReactNode[] {
  if (stateError !== undefined && state === undefined) {
    return [h('p', { key: 'nochannel', style: S.warn }, `状态通道不可用：${stateError}`)]
  }
  if (state === undefined) {
    return [h('p', { key: 'loading', style: S.hint }, '正在读取状态…')]
  }

  const sourceLabel =
    state.tokenSource === 'exact' ? '精确' : state.tokenSource === 'estimated' ? '估算' : '不可用'
  const threshold = state.thresholds.handoff
  const ratio = threshold > 0 ? Math.min(1, Math.max(0, state.tokens / threshold)) : 0
  const rows: ReactNode[] = [
    h(
      'div',
      { key: 'tokens', style: S.mono },
      `会话累计 Token：${state.tokens}（${sourceLabel}）`,
    ),
    h('div', { key: 'bar', style: S.bar }, h('div', { style: { ...S.barFill, width: `${Math.round(ratio * 100)}%` } })),
    h(
      'div',
      { key: 'phase', style: S.hint },
      `阶段：${state.phaseLabel}${state.stopRequested ? '（已持有停止闩锁）' : ''}${
        state.atBoundary ? '（已到达 Step 边界）' : ''
      }`,
    ),
    h(
      'div',
      { key: 'thresholds', style: S.hint },
      `阈值：迁移 ${state.autoHandoffEnabled ? state.thresholds.handoff : '未启用'} / 压缩 ${
        state.autoCompactEnabled ? state.thresholds.compact : '未启用'
      }；本会话自动动作 ${state.autoActions}/${state.maxAutoActionsPerSession}`,
    ),
    h(
      'div',
      { key: 'persistence', style: S.hint },
      state.persistence === 'host' ? '设置持久化：Host（写入设置文件）' : '设置持久化：内存（重启后恢复默认）',
    ),
  ]
  if (state.warnings.length > 0) {
    rows.push(h('p', { key: 'warnings', style: S.warn }, state.warnings.join(' ')))
  }
  if (state.retired) {
    rows.push(h('p', { key: 'retired', style: S.hint }, '本会话已退休：迁移完成后不再处理新任务。'))
  }
  if (state.lastResult !== undefined) {
    rows.push(
      h(
        'p',
        { key: 'last', style: state.lastResult.outcome === 'completed' ? S.ok : S.error },
        `最近一次动作：${state.lastResult.text}`,
      ),
    )
  }
  if (state.progress.length > 0) {
    rows.push(
      h(
        'div',
        { key: 'progress', style: { ...S.hint, ...S.mono } },
        ...state.progress.slice(-5).map((line, index) => h('div', { key: `line-${index}` }, line)),
      ),
    )
  }
  return rows
}

export default HandoffCard
