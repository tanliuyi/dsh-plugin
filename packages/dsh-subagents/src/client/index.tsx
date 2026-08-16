/**
 * dsh-subagents 的 Web 设置页（client 插件，浏览器端）。
 *
 * 注册 `settings.section` 分区「Subagents」：表单通过宿主侧同源路由
 * `/api/subagents/settings`（GET/PUT/DELETE）读写 `~/.dsh/subagents/web-settings.json`
 * 里的覆盖。只依赖平台种子（react）；样式以 <style> 注入并在物化时登记。
 *
 * 设置值语义：空输入 = 继承（不产生覆盖）；保存时把整个表单作为 effective
 * 发送，宿主计算与 baseline 的差异后落盘并 live-apply。
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { WebSettingsValue } from '../web-settings.ts'

/** 客户端注入的服务：只需要 slots（settings 契约经 slots.inject 等待声明）。 */
export const inject = ['slots']

export const SETTINGS_PATH = '/api/subagents/settings'

/** 模块级样式：物化时注入一次（loader 会登记本 factory 创建的 style 标签）。 */
const STYLE_ID = 'dsh-subagents-settings-style'
if (typeof document !== 'undefined' && document.getElementById(STYLE_ID) === null) {
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.dshsub-section{display:flex;flex-direction:column;gap:12px;max-width:560px}
.dshsub-intro{color:var(--dsw-alias-label-secondary, #667);font-size:12px;line-height:18px;margin:0}
.dshsub-intro code{color:var(--dsw-alias-label-primary, #333)}
.dshsub-status,.dshsub-notice{color:var(--dsw-alias-label-secondary, #667);font-size:12px;margin:0}
.dshsub-error{color:var(--dsw-alias-status-danger, #c33);font-size:12px;margin:0}
.dshsub-form{display:flex;flex-direction:column;gap:10px}
.dshsub-row{display:flex;flex-direction:column;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l2, #eee);padding:8px 0}
.dshsub-row-label{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-primary, #333);font-size:13px}
.dshsub-restart{color:var(--dsw-alias-status-warning, #b60);font-size:11px;font-style:normal;border:1px solid var(--dsw-alias-border-l2, #ddd);border-radius:4px;padding:0 4px}
.dshsub-control{background:var(--dsw-alias-surface-l2, #fff);color:var(--dsw-alias-label-primary, #333);border:1px solid var(--dsw-alias-border-l2, #ccc);border-radius:6px;padding:4px 8px;font-size:13px;max-width:360px}
.dshsub-number{max-width:160px}
.dshsub-inline{display:flex;gap:8px;align-items:center}
.dshsub-actions{display:flex;gap:8px;align-items:center}
.dshsub-button{background:var(--dsw-alias-surface-l2, #fff);color:var(--dsw-alias-label-primary, #333);border:1px solid var(--dsw-alias-border-l2, #ccc);border-radius:6px;padding:5px 14px;font-size:13px;cursor:pointer}
.dshsub-button:disabled{opacity:.5;cursor:default}
.dshsub-primary{background:var(--dsw-alias-accent, #2563eb);border-color:transparent;color:#fff}
.dshsub-dirty{color:var(--dsw-alias-status-warning, #b60);font-size:12px}
`
  document.head.appendChild(style)
}

interface SettingsView {
  baseline: WebSettingsValue
  effective: WebSettingsValue
  overrides: WebSettingsValue
  restartKeys: string[]
}

interface SaveResult {
  applied: string[]
  restartRequired: string[]
  effective: WebSettingsValue
}

/** 表单草稿：全部字段以字符串表示，'' = 继承/未设置。 */
type Draft = Record<string, string>

const BOOLEAN_KEYS = ['asyncByDefault', 'missionsEnabled', 'scheduledRunsEnabled', 'watchdogEnabled'] as const
const NUMBER_KEYS = ['timeoutMs', 'gateTimeoutMs', 'maxSubagentSpawnsPerRun', 'maxSubagentSpawnsPerSession', 'maxActiveAsyncRunsPerSession', 'maxSubagentDepth'] as const
const STRING_KEYS = ['defaultModel', 'watchdogMainModel'] as const
const THINKING_KEYS = ['defaultThinking', 'watchdogMainThinking'] as const
const ENUM_KEYS = ['intercomMode'] as const

/** 设置页可见的全部键。 */
const ALL_KEYS: (keyof WebSettingsValue)[] = [
  ...BOOLEAN_KEYS, ...NUMBER_KEYS, ...STRING_KEYS, ...THINKING_KEYS, ...ENUM_KEYS,
]

/** 值 → 草稿字符串（毫秒字段以分钟/秒展示；timeoutMs 保留 1 位小数避免 90s→1.5min→2min 的取整误差）。 */
function toDraft(value: WebSettingsValue): Draft {
  const draft: Draft = {}
  for (const key of ALL_KEYS) {
    const v = value[key]
    if (v === undefined) draft[key] = ''
    else if (typeof v === 'boolean') draft[key] = String(v)
    else if (typeof v === 'number') draft[key] = String(key === 'timeoutMs' ? Math.round(v / 6_000) / 10 : key === 'gateTimeoutMs' ? Math.round(v / 1_000) : v)
    else draft[key] = v // string | false
  }
  return draft
}

/** 草稿字符串 → 设置值（'' = undefined = 继承；timeoutMs 允许 1 位小数分钟，gateTimeoutMs 秒转回毫秒）。 */
function fromDraft(draft: Draft): WebSettingsValue {
  const out: WebSettingsValue = {}
  for (const key of BOOLEAN_KEYS) {
    const v = draft[key]
    if (v === 'true') out[key] = true
    else if (v === 'false') out[key] = false
  }
  for (const key of NUMBER_KEYS) {
    const v = draft[key]
    if (v !== undefined && v !== '') {
      const n = Number(v)
      if (key === 'timeoutMs') {
        // 分钟可以是小数（1 位小数 × 60000 必为整数毫秒）
        if (Number.isFinite(n) && n >= 0) out[key] = Math.round(n * 60_000)
      } else if (Number.isInteger(n) && n >= 0) {
        out[key] = key === 'gateTimeoutMs' ? n * 1_000 : n
      }
    }
  }
  for (const key of STRING_KEYS) {
    const v = draft[key]
    if (v !== undefined && v.trim() !== '') out[key] = v.trim()
  }
  for (const key of THINKING_KEYS) {
    const v = draft[key]
    if (v === 'off') out[key] = false
    else if (v !== undefined && v.trim() !== '') out[key] = v.trim()
  }
  for (const key of ENUM_KEYS) {
    const v = draft[key]
    if (v === 'always' || v === 'fork-only' || v === 'off') out[key] = v
  }
  return out
}

/** 草稿是否与当前生效值一致（保存按钮与脏状态）。 */
function isClean(draft: Draft, effective: WebSettingsValue): boolean {
  const current = toDraft(effective)
  for (const key of ALL_KEYS) {
    if ((draft[key] ?? '') !== (current[key] ?? '')) return false
  }
  return true
}

const FIELD_LABELS: Record<keyof WebSettingsValue, string> = {
  asyncByDefault: '默认后台运行（workflowScript）',
  timeoutMs: '运行超时（分钟）',
  gateTimeoutMs: 'gate 验证超时（秒）',
  maxSubagentSpawnsPerRun: '单次运行子代理上限',
  maxSubagentSpawnsPerSession: '会话累计启动上限（0 = 无限）',
  maxActiveAsyncRunsPerSession: '并发后台运行上限（0 = 无限）',
  maxSubagentDepth: '嵌套委派深度上限',
  defaultModel: '默认子代理模型',
  defaultThinking: '默认思考级别',
  missionsEnabled: 'missions 存储',
  scheduledRunsEnabled: '持久调度',
  intercomMode: 'intercom 模式',
  watchdogEnabled: 'watchdog',
  watchdogMainModel: 'watchdog 模型',
  watchdogMainThinking: 'watchdog 思考级别',
}

/** 需要重启的键（与宿主 RESTART_REQUIRED_KEYS 一致；GET 响应也会带回）。 */
const RESTART_KEYS = new Set(['missionsEnabled', 'scheduledRunsEnabled'])

function Field({ label, restart, children }: { label: string; restart?: boolean; children: ReactNode }) {
  return (
    <label className="dshsub-row">
      <span className="dshsub-row-label">
        {label}
        {restart ? <em className="dshsub-restart">重启后生效</em> : null}
      </span>
      {children}
    </label>
  )
}

function BooleanSelect({ draft, setDraft, field }: { draft: Draft; setDraft: (d: Draft) => void; field: string }) {
  return (
    <select className="dshsub-control" value={draft[field] ?? ''} onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}>
      <option value="">继承默认</option>
      <option value="true">开</option>
      <option value="false">关</option>
    </select>
  )
}

function ThinkingSelect({ draft, setDraft, field }: { draft: Draft; setDraft: (d: Draft) => void; field: string }) {
  const value = draft[field] ?? ''
  const custom = value !== '' && value !== 'off'
  return (
    <span className="dshsub-inline">
      <select className="dshsub-control" value={custom ? 'custom' : value} onChange={(e) => {
        const next = e.target.value
        setDraft({ ...draft, [field]: next === 'custom' ? 'high' : next })
      }}>
        <option value="">继承默认</option>
        <option value="off">关闭</option>
        <option value="custom">自定义…</option>
      </select>
      {custom ? <input className="dshsub-control" value={value} onChange={(e) => setDraft({ ...draft, [field]: e.target.value })} placeholder="如 high / low" /> : null}
    </span>
  )
}

function SubagentsSection(_props: SettingsSectionOwnerProps) {
/** 解析 fetch 响应体：非 JSON（错误页等）时给出可读错误而非裸解析异常。 */
async function parseJsonResponse(res: Response): Promise<unknown> {
  const text = await res.text()
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`HTTP ${res.status}：响应不是 JSON（content-type: ${res.headers.get('content-type') ?? '未知'}）`)
  }
}

  const [view, setView] = useState<SettingsView | null>(null)
  const [draft, setDraft] = useState<Draft>({})
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const reload = async (): Promise<void> => {
    setError(null)
    try {
      const res = await fetch(SETTINGS_PATH, { headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await parseJsonResponse(res)) as SettingsView
      setView(data)
      setDraft(toDraft(data.effective))
    } catch (err) {
      setError(`读取设置失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  const save = async (): Promise<void> => {
    setSaving(true)
    setNotice(null)
    setError(null)
    try {
      const res = await fetch(SETTINGS_PATH, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ effective: fromDraft(draft) }),
      })
      const data = (await res.json()) as SaveResult & { error?: string; issues?: string[] }
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}${data.issues ? '：' + data.issues.join('；') : ''}`)
      setView((v) => (v ? { ...v, effective: data.effective } : v))
      setDraft(toDraft(data.effective))
      const parts: string[] = []
      if (data.applied.length > 0) parts.push(`已生效：${data.applied.join(', ')}`)
      if (data.restartRequired.length > 0) parts.push(`重启后生效：${data.restartRequired.join(', ')}`)
      setNotice(parts.length > 0 ? parts.join('；') : '已保存（与默认一致，覆盖已清除）')
    } catch (err) {
      setError(`保存失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const resetAll = async (): Promise<void> => {
    setSaving(true)
    setNotice(null)
    setError(null)
    try {
      const res = await fetch(SETTINGS_PATH, { method: 'DELETE' })
      const data = (await res.json()) as { effective: WebSettingsValue; error?: string }
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      setView((v) => (v ? { ...v, effective: data.effective, overrides: {} } : v))
      setDraft(toDraft(data.effective))
      setNotice('已恢复全部默认（live-apply）')
    } catch (err) {
      setError(`重置失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const restartKeys = new Set(view?.restartKeys ?? [...RESTART_KEYS])
  const dirty = view !== null && !isClean(draft, view.effective)

  return (
    <div className="dshsub-section">
      <p className="dshsub-intro">
        子代理委派（subagents 工具）的运行时偏好。改动即时生效（消费点在调用时读取配置）；
        标「重启后生效」的键需要重启 dsh 或热重载插件。覆盖写入{' '}
        <code>~/.dsh/subagents/web-settings.json</code>。
      </p>
      {view === null && error === null ? <p className="dshsub-status">加载中…</p> : null}
      {error !== null ? <p className="dshsub-error">{error}</p> : null}
      {view !== null ? (
        <div className="dshsub-form">
          <Field label={FIELD_LABELS['asyncByDefault']}>
            <BooleanSelect draft={draft} setDraft={setDraft} field="asyncByDefault" />
          </Field>
          <Field label={FIELD_LABELS['timeoutMs']}>
            <input className="dshsub-control dshsub-number" type="number" min={0} step={1}
              value={draft['timeoutMs'] ?? ''}
              onChange={(e) => {
                const v = e.target.value
                if (v === '' || (Number.isFinite(Number(v)) && Number(v) >= 0)) setDraft({ ...draft, timeoutMs: v })
              }}
              placeholder="继承（分钟）" />
          </Field>
          <Field label={FIELD_LABELS['gateTimeoutMs']}>
            <input className="dshsub-control dshsub-number" type="number" min={0} step={1}
              value={draft['gateTimeoutMs'] ?? ''}
              onChange={(e) => {
                const v = e.target.value
                if (v === '' || (Number.isFinite(Number(v)) && Number(v) >= 0)) setDraft({ ...draft, gateTimeoutMs: v })
              }}
              placeholder="继承（秒）" />
          </Field>
          <Field label={FIELD_LABELS['maxSubagentSpawnsPerRun']}>
            <input className="dshsub-control dshsub-number" type="number" min={0} step={1}
              value={draft['maxSubagentSpawnsPerRun'] ?? ''}
              onChange={(e) => setDraft({ ...draft, maxSubagentSpawnsPerRun: e.target.value })}
              placeholder="继承" />
          </Field>
          <Field label={FIELD_LABELS['maxSubagentSpawnsPerSession']}>
            <input className="dshsub-control dshsub-number" type="number" min={0} step={1}
              value={draft['maxSubagentSpawnsPerSession'] ?? ''}
              onChange={(e) => setDraft({ ...draft, maxSubagentSpawnsPerSession: e.target.value })}
              placeholder="继承" />
          </Field>
          <Field label={FIELD_LABELS['maxActiveAsyncRunsPerSession']}>
            <input className="dshsub-control dshsub-number" type="number" min={0} step={1}
              value={draft['maxActiveAsyncRunsPerSession'] ?? ''}
              onChange={(e) => setDraft({ ...draft, maxActiveAsyncRunsPerSession: e.target.value })}
              placeholder="继承" />
          </Field>
          <Field label={FIELD_LABELS['maxSubagentDepth']}>
            <input className="dshsub-control dshsub-number" type="number" min={0} step={1}
              value={draft['maxSubagentDepth'] ?? ''}
              onChange={(e) => setDraft({ ...draft, maxSubagentDepth: e.target.value })}
              placeholder="继承" />
          </Field>
          <Field label={FIELD_LABELS['defaultModel']}>
            <input className="dshsub-control" type="text"
              value={draft['defaultModel'] ?? ''}
              onChange={(e) => setDraft({ ...draft, defaultModel: e.target.value })}
              placeholder="继承（如 anthropic/claude-sonnet-4:high）" />
          </Field>
          <Field label={FIELD_LABELS['defaultThinking']}>
            <ThinkingSelect draft={draft} setDraft={setDraft} field="defaultThinking" />
          </Field>
          <Field label={FIELD_LABELS['missionsEnabled']} restart={restartKeys.has('missionsEnabled')}>
            <BooleanSelect draft={draft} setDraft={setDraft} field="missionsEnabled" />
          </Field>
          <Field label={FIELD_LABELS['scheduledRunsEnabled']} restart={restartKeys.has('scheduledRunsEnabled')}>
            <BooleanSelect draft={draft} setDraft={setDraft} field="scheduledRunsEnabled" />
          </Field>
          <Field label={FIELD_LABELS['intercomMode']}>
            <select className="dshsub-control" value={draft['intercomMode'] ?? ''}
              onChange={(e) => setDraft({ ...draft, intercomMode: e.target.value })}>
              <option value="">继承默认</option>
              <option value="always">always</option>
              <option value="fork-only">fork-only</option>
              <option value="off">off</option>
            </select>
          </Field>
          <Field label={FIELD_LABELS['watchdogEnabled']}>
            <BooleanSelect draft={draft} setDraft={setDraft} field="watchdogEnabled" />
          </Field>
          <Field label={FIELD_LABELS['watchdogMainModel']}>
            <input className="dshsub-control" type="text"
              value={draft['watchdogMainModel'] ?? ''}
              onChange={(e) => setDraft({ ...draft, watchdogMainModel: e.target.value })}
              placeholder="继承（watchdog 开启时使用）" />
          </Field>
          <Field label={FIELD_LABELS['watchdogMainThinking']}>
            <ThinkingSelect draft={draft} setDraft={setDraft} field="watchdogMainThinking" />
          </Field>
          <div className="dshsub-actions">
            <button className="dshsub-button dshsub-primary" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? '保存中…' : '保存'}
            </button>
            <button className="dshsub-button" disabled={saving} onClick={() => void resetAll()}>
              恢复全部默认
            </button>
            <span className="dshsub-dirty">{dirty ? '有未保存修改' : ''}</span>
          </div>
          {notice !== null ? <p className="dshsub-notice">{notice}</p> : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * 客户端插件体：注册设置分区。
 * @param ctx - 浏览器端 cordis 上下文（slots 已注入）。
 */
export function apply(ctx: import('@deepseek-ai/cordis').Context): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'subagents',
    order: 20,
    label: () => 'Subagents',
  }, SubagentsSection))
}
