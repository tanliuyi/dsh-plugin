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

import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
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
.dshsub-section{box-sizing:border-box;display:flex;flex-direction:column;gap:24px;width:100%;max-width:720px;padding:4px 0 24px;color:var(--dsw-alias-label-primary, #0f1115);font-size:14px;line-height:22px}
.dshsub-header{display:flex;flex-direction:column;gap:6px}
.dshsub-kicker{margin:0;color:var(--dsw-alias-label-tertiary, #81858c);font-size:12px;line-height:18px;font-weight:500;letter-spacing:.04em;text-transform:uppercase}
.dshsub-title{margin:0;color:var(--dsw-alias-label-primary, #0f1115);font-size:20px;line-height:28px;font-weight:500}
.dshsub-intro{max-width:620px;margin:0;color:var(--dsw-alias-label-secondary, #61666b);font-size:14px;line-height:22px}
.dshsub-intro code{padding:2px 5px;border-radius:5px;background:var(--dsw-alias-bg-module-platform, #f1f3f5);color:var(--dsw-alias-label-primary, #0f1115);font:12px/18px var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)}
.dshsub-summary{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}
.dshsub-summary-item{display:inline-flex;align-items:center;gap:6px;min-height:24px;padding:0 8px;border-radius:12px;background:var(--dsw-alias-bg-layer-2, #fff);color:var(--dsw-alias-label-secondary, #61666b);font-size:12px;line-height:18px}
.dshsub-summary-item[data-state=dirty]{color:var(--dsw-alias-state-warn-label, #dd8629);background:var(--dsw-alias-state-warn-tertiary, #fef5e7)}
.dshsub-summary-item[data-state=clean]{color:var(--dsw-alias-state-success-primary, #22c55e);background:var(--dsw-alias-state-success-tertiary, #e6faed)}
.dshsub-summary-dot{width:6px;height:6px;border-radius:50%;background:currentColor}
.dshsub-status,.dshsub-notice{margin:0;color:var(--dsw-alias-label-secondary, #61666b);font-size:14px;line-height:22px}
.dshsub-error{margin:0;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-state-error-tertiary, #fef2f2);color:var(--dsw-alias-state-error-primary, #ec1313);font-size:14px;line-height:22px}
.dshsub-form{display:flex;flex-direction:column;gap:24px}
.dshsub-group{display:flex;flex-direction:column;min-width:0;border-top:1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.04))}
.dshsub-group-heading{display:flex;flex-direction:column;gap:2px;padding:16px 0 8px}
.dshsub-group-title{margin:0;color:var(--dsw-alias-label-primary, #0f1115);font-size:16px;line-height:24px;font-weight:500}
.dshsub-group-description{margin:0;color:var(--dsw-alias-label-tertiary, #81858c);font-size:12px;line-height:18px}
.dshsub-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(180px,260px);align-items:center;gap:24px;min-height:56px;padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.04))}
.dshsub-row-label{display:flex;flex-direction:column;align-items:flex-start;gap:3px;min-width:0;color:var(--dsw-alias-label-primary, #0f1115);font-size:14px;line-height:22px}
.dshsub-row-description{color:var(--dsw-alias-label-tertiary, #81858c);font-size:12px;line-height:18px}
.dshsub-restart{display:inline-flex;align-items:center;min-height:20px;padding:0 6px;border-radius:10px;background:var(--dsw-alias-state-warn-tertiary, #fef5e7);color:var(--dsw-alias-state-warn-label, #dd8629);font-size:11px;line-height:16px;font-style:normal;font-weight:500}
.dshsub-control{box-sizing:border-box;width:100%;min-width:0;height:32px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1));border-radius:8px;background:var(--dsw-alias-bg-layer-1, #fff);color:var(--dsw-alias-label-primary, #0f1115);font-size:14px;line-height:22px;font-family:inherit;outline:none;transition:border-color .15s ease,background .15s ease}
.dshsub-select{position:relative;width:100%;min-width:0}
.dshsub-select-trigger{display:flex;align-items:center;justify-content:space-between;gap:8px;text-align:left;cursor:pointer}
.dshsub-select-trigger[data-open=true]{border-color:var(--dsw-alias-state-business-primary, #4176e6);background:var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04))}
.dshsub-select-value{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshsub-select-chevron{flex:0 0 7px;width:7px;height:7px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(45deg) translateY(-2px);transition:transform .15s ease}
.dshsub-select-trigger[data-open=true] .dshsub-select-chevron{transform:rotate(225deg) translate(-1px,-1px)}
.dshsub-select-menu{position:absolute;z-index:20;top:calc(100% + 4px);left:0;width:100%;box-sizing:border-box;margin:0;padding:4px;border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1));border-radius:8px;background:var(--dsw-alias-bg-layer-2, #fff);box-shadow:0 8px 24px rgba(15,17,21,.12);list-style:none}
.dshsub-select-option{display:flex;align-items:center;min-height:32px;padding:0 8px;border-radius:6px;color:var(--dsw-alias-label-primary, #0f1115);font-size:14px;line-height:22px;cursor:pointer}
.dshsub-select-option:hover,.dshsub-select-option[data-active=true]{background:var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04))}
.dshsub-select-option[data-selected=true]{color:var(--dsw-alias-state-business-primary, #4176e6);font-weight:500}
.dshsub-select-option:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary, #4176e6);outline-offset:-2px}
.dshsub-select-option-mark{width:14px;margin-right:2px;color:currentColor;font-size:12px}
.dshsub-select-option-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshsub-control:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04))}
.dshsub-control:focus{border-color:var(--dsw-alias-state-business-primary, #4176e6)}
.dshsub-control::placeholder{color:var(--dsw-alias-label-dimmed, #cfd3d8)}
.dshsub-input{display:block;width:100%;min-width:0}
.dshsub-number{max-width:none}
.dshsub-inline{display:flex;gap:8px;align-items:center;min-width:0}
.dshsub-inline .dshsub-select{flex:0 0 128px}
.dshsub-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding-top:8px}
.dshsub-button{display:inline-flex;align-items:center;justify-content:center;height:36px;padding:0 14px;border:1px solid transparent;border-radius:18px;background:transparent;color:var(--dsw-alias-label-primary, #0f1115);font-size:14px;line-height:22px;font-family:inherit;cursor:pointer;transition:background .15s ease,opacity .15s ease}
.dshsub-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04))}
.dshsub-button:focus-visible,.dshsub-control:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary, #4176e6);outline-offset:2px}
.dshsub-button:disabled{opacity:.4;cursor:not-allowed}
.dshsub-primary{background:var(--dsw-alias-button-primary-fill, #0f1115);color:var(--dsw-alias-label-primary-foreground, #fff)}
.dshsub-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover, #333438)}
.dshsub-dirty{margin-left:4px;color:var(--dsw-alias-state-warn-label, #dd8629);font-size:12px;line-height:18px}
@media (max-width:640px){.dshsub-section{gap:20px}.dshsub-row{grid-template-columns:1fr;gap:8px;align-items:stretch}.dshsub-inline .dshsub-control:first-child{flex-basis:120px}.dshsub-actions{padding-top:4px}}
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

interface FieldMeta {
  label: string
  description: string
}

const FIELD_META: Record<keyof WebSettingsValue, FieldMeta> = {
  asyncByDefault: { label: '默认后台运行', description: 'workflowScript 默认交给后台执行' },
  timeoutMs: { label: '运行超时', description: '单次子代理运行的最长时间' },
  gateTimeoutMs: { label: '验证命令超时', description: 'gate 验证命令允许执行的时间' },
  maxSubagentSpawnsPerRun: { label: '单次运行上限', description: '一棵委派树最多启动的子代理数' },
  maxSubagentSpawnsPerSession: { label: '会话启动上限', description: '当前会话累计启动数，0 表示无限' },
  maxActiveAsyncRunsPerSession: { label: '并发运行上限', description: '当前会话同时运行的后台任务数，0 表示无限' },
  maxSubagentDepth: { label: '嵌套委派深度', description: '子代理继续委派时允许的最大层级' },
  defaultModel: { label: '默认子代理模型', description: '未指定模型时使用的模型 ID' },
  defaultThinking: { label: '默认思考级别', description: '未指定时应用到子代理的 thinking 配置' },
  missionsEnabled: { label: 'Missions 存储', description: '保存工作流任务的状态与结果' },
  scheduledRunsEnabled: { label: '持久调度', description: '启用定时工作流和持久化调度' },
  intercomMode: { label: 'Intercom 通道', description: '控制子代理与父会话之间的回报通道' },
  watchdogEnabled: { label: 'Watchdog 评审', description: '在回合边界检查代码变更与范围漂移' },
  watchdogMainModel: { label: 'Watchdog 模型', description: '执行对抗性评审的主模型 ID' },
  watchdogMainThinking: { label: 'Watchdog 思考级别', description: 'Watchdog 主模型的 thinking 配置' },
}

/** 需要重启的键（与宿主 RESTART_REQUIRED_KEYS 一致；GET 响应也会带回）。 */
const RESTART_KEYS = new Set(['missionsEnabled', 'scheduledRunsEnabled'])

function Field({ meta, restart, children }: { meta: FieldMeta; restart?: boolean; children: ReactNode }) {
  const labelId = useId()
  return (
    <div className="dshsub-row" role="group" aria-labelledby={labelId}>
      <span className="dshsub-row-label" id={labelId}>
        <span>{meta.label}</span>
        <span className="dshsub-row-description">{meta.description}</span>
        {restart ? <em className="dshsub-restart">重启后生效</em> : null}
      </span>
      {children}
    </div>
  )
}

interface SelectOption {
  value: string
  label: string
}

function CustomSelect({ value, options, onChange, ariaLabel }: { value: string; options: SelectOption[]; onChange: (value: string) => void; ariaLabel: string }) {
  const [open, setOpen] = useState(false)
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value))
  const [activeIndex, setActiveIndex] = useState(selectedIndex)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const listboxId = useId()
  const selected = options[selectedIndex] ?? options[0]

  useEffect(() => {
    setActiveIndex(selectedIndex)
  }, [selectedIndex])

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => window.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [open])

  const choose = (index: number): void => {
    const option = options[index]
    if (!option) return
    onChange(option.value)
    setActiveIndex(index)
    setOpen(false)
    buttonRef.current?.focus()
  }

  const move = (delta: number): void => {
    setActiveIndex((current) => (current + delta + options.length) % options.length)
  }

  const onButtonKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'Escape') {
      setOpen(false)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault()
      if (!open) setOpen(true)
      move(1)
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault()
      if (!open) setOpen(true)
      move(-1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      setActiveIndex(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      setActiveIndex(options.length - 1)
    } else if ((event.key === 'Enter' || event.key === ' ') && open) {
      event.preventDefault()
      choose(activeIndex)
    }
  }

  return (
    <div className="dshsub-select" ref={rootRef}>
      <button type="button" ref={buttonRef} className="dshsub-control dshsub-select-trigger" data-open={open}
        aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} aria-controls={listboxId}
        onClick={() => setOpen((current) => !current)} onKeyDown={onButtonKeyDown}>
        <span className="dshsub-select-value">{selected?.label ?? ''}</span>
        <span className="dshsub-select-chevron" aria-hidden="true" />
      </button>
      {open ? (
        <ul className="dshsub-select-menu" id={listboxId} role="listbox" aria-label={ariaLabel}>
          {options.map((option, index) => (
            <li key={option.value} className="dshsub-select-option" role="option" tabIndex={-1}
              data-active={index === activeIndex} data-selected={option.value === value}
              aria-selected={option.value === value} onMouseEnter={() => setActiveIndex(index)} onClick={() => choose(index)}>
              <span className="dshsub-select-option-mark" aria-hidden="true">{option.value === value ? '✓' : ''}</span>
              <span className="dshsub-select-option-label">{option.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function BooleanSelect({ draft, setDraft, field }: { draft: Draft; setDraft: (d: Draft) => void; field: string }) {
  return <CustomSelect ariaLabel={field} value={draft[field] ?? ''} onChange={(value) => setDraft({ ...draft, [field]: value })}
    options={[{ value: '', label: '继承默认' }, { value: 'true', label: '开' }, { value: 'false', label: '关' }]} />
}

function NumberInput({ draft, setDraft, field, placeholder, step = 1 }: { draft: Draft; setDraft: (d: Draft) => void; field: string; placeholder: string; step?: number }) {
  return (
    <Input className="dshsub-input dshsub-number" type="number" min={0} step={step}
      aria-label={field} value={draft[field] ?? ''}
      onChange={(e) => {
        const value = e.target.value
        if (value === '' || (Number.isFinite(Number(value)) && Number(value) >= 0)) setDraft({ ...draft, [field]: value })
      }}
      placeholder={placeholder} />
  )
}

function ThinkingSelect({ draft, setDraft, field }: { draft: Draft; setDraft: (d: Draft) => void; field: string }) {
  const value = draft[field] ?? ''
  const custom = value !== '' && value !== 'off'
  return (
    <span className="dshsub-inline">
      <CustomSelect ariaLabel={field} value={custom ? 'custom' : value} onChange={(next) => setDraft({ ...draft, [field]: next === 'custom' ? 'high' : next })}
        options={[{ value: '', label: '继承默认' }, { value: 'off', label: '关闭' }, { value: 'custom', label: '自定义…' }]} />
      {custom ? <Input className="dshsub-input" aria-label={field + ' 自定义值'} value={value} onChange={(e) => setDraft({ ...draft, [field]: e.target.value })} placeholder="如 high / low" /> : null}
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
  const overrideCount = view === null ? 0 : Object.keys(view.overrides).length

  return (
    <div className="dshsub-section">
      <header className="dshsub-header">
        <h2 className="dshsub-title">子代理设置</h2>
        <p className="dshsub-intro">管理委派运行时的默认行为、资源边界和质量守护。留空的字段会继承当前 profile 默认值。</p>
        {view !== null ? (
          <div className="dshsub-summary" aria-live="polite">
            <span className="dshsub-summary-item" data-state={dirty ? 'dirty' : 'clean'}>
              <span className="dshsub-summary-dot" aria-hidden="true" />
              {dirty ? '有未保存修改' : '设置已同步'}
            </span>
            <span className="dshsub-summary-item">{overrideCount > 0 ? `${overrideCount} 项自定义覆盖` : '使用默认配置'}</span>
            <span className="dshsub-summary-item">空值 = 继承默认</span>
          </div>
        ) : null}
      </header>
      {view === null && error === null ? <p className="dshsub-status">加载中…</p> : null}
      {error !== null ? <p className="dshsub-error" role="alert">{error}</p> : null}
      {view !== null ? (
        <div className="dshsub-form">
          <section className="dshsub-group">
            <div className="dshsub-group-heading">
              <h3 className="dshsub-group-title">运行策略</h3>
              <p className="dshsub-group-description">控制任务何时执行，以及验证阶段的时间边界。</p>
            </div>
            <Field meta={FIELD_META.asyncByDefault}>
              <BooleanSelect draft={draft} setDraft={setDraft} field="asyncByDefault" />
            </Field>
            <Field meta={FIELD_META.timeoutMs}>
              <NumberInput draft={draft} setDraft={setDraft} field="timeoutMs" placeholder="继承（分钟）" step={0.1} />
            </Field>
            <Field meta={FIELD_META.gateTimeoutMs}>
              <NumberInput draft={draft} setDraft={setDraft} field="gateTimeoutMs" placeholder="继承（秒）" />
            </Field>
          </section>

          <section className="dshsub-group">
            <div className="dshsub-group-heading">
              <h3 className="dshsub-group-title">资源边界</h3>
              <p className="dshsub-group-description">限制委派树和会话级并发，避免后台任务无界增长。</p>
            </div>
            <Field meta={FIELD_META.maxSubagentSpawnsPerRun}>
              <NumberInput draft={draft} setDraft={setDraft} field="maxSubagentSpawnsPerRun" placeholder="继承" />
            </Field>
            <Field meta={FIELD_META.maxSubagentSpawnsPerSession}>
              <NumberInput draft={draft} setDraft={setDraft} field="maxSubagentSpawnsPerSession" placeholder="继承" />
            </Field>
            <Field meta={FIELD_META.maxActiveAsyncRunsPerSession}>
              <NumberInput draft={draft} setDraft={setDraft} field="maxActiveAsyncRunsPerSession" placeholder="继承" />
            </Field>
            <Field meta={FIELD_META.maxSubagentDepth}>
              <NumberInput draft={draft} setDraft={setDraft} field="maxSubagentDepth" placeholder="继承" />
            </Field>
          </section>

          <section className="dshsub-group">
            <div className="dshsub-group-heading">
              <h3 className="dshsub-group-title">模型策略</h3>
              <p className="dshsub-group-description">设置未明确指定时的模型与 thinking 行为。</p>
            </div>
            <Field meta={FIELD_META.defaultModel}>
              <Input className="dshsub-input" type="text" aria-label="默认子代理模型" value={draft.defaultModel ?? ''}
                onChange={(e) => setDraft({ ...draft, defaultModel: e.target.value })}
                placeholder="继承（如 anthropic/claude-sonnet-4:high）" />
            </Field>
            <Field meta={FIELD_META.defaultThinking}>
              <ThinkingSelect draft={draft} setDraft={setDraft} field="defaultThinking" />
            </Field>
          </section>

          <section className="dshsub-group">
            <div className="dshsub-group-heading">
              <h3 className="dshsub-group-title">能力与集成</h3>
              <p className="dshsub-group-description">启用持久能力，并配置子代理与父会话的通信方式。</p>
            </div>
            <Field meta={FIELD_META.missionsEnabled} restart={restartKeys.has('missionsEnabled')}>
              <BooleanSelect draft={draft} setDraft={setDraft} field="missionsEnabled" />
            </Field>
            <Field meta={FIELD_META.scheduledRunsEnabled} restart={restartKeys.has('scheduledRunsEnabled')}>
              <BooleanSelect draft={draft} setDraft={setDraft} field="scheduledRunsEnabled" />
            </Field>
            <Field meta={FIELD_META.intercomMode}>
              <CustomSelect ariaLabel="intercomMode" value={draft.intercomMode ?? ''} onChange={(value) => setDraft({ ...draft, intercomMode: value })}
                options={[{ value: '', label: '继承默认' }, { value: 'always', label: '始终启用' }, { value: 'fork-only', label: '仅 fork 会话' }, { value: 'off', label: '关闭' }]} />
            </Field>
          </section>

          <section className="dshsub-group">
            <div className="dshsub-group-heading">
              <h3 className="dshsub-group-title">质量守护</h3>
              <p className="dshsub-group-description">让 Watchdog 在回合边界对代码变更进行额外检查。</p>
            </div>
            <Field meta={FIELD_META.watchdogEnabled}>
              <BooleanSelect draft={draft} setDraft={setDraft} field="watchdogEnabled" />
            </Field>
            <Field meta={FIELD_META.watchdogMainModel}>
              <Input className="dshsub-input" type="text" aria-label="Watchdog 模型" value={draft.watchdogMainModel ?? ''}
                onChange={(e) => setDraft({ ...draft, watchdogMainModel: e.target.value })}
                placeholder="继承（Watchdog 开启时使用）" />
            </Field>
            <Field meta={FIELD_META.watchdogMainThinking}>
              <ThinkingSelect draft={draft} setDraft={setDraft} field="watchdogMainThinking" />
            </Field>
          </section>

          <div className="dshsub-actions">
            <button type="button" className="dshsub-button dshsub-primary" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? '保存中…' : '保存更改'}
            </button>
            <button type="button" className="dshsub-button" disabled={saving} onClick={() => void resetAll()}>
              恢复全部默认
            </button>
            <span className="dshsub-dirty" aria-live="polite">{dirty ? '有未保存修改' : ''}</span>
          </div>
          {notice !== null ? <p className="dshsub-notice" role="status">{notice}</p> : null}
          <p className="dshsub-group-description">设置覆盖保存至 <code>~/.dsh/subagents/web-settings.json</code>。标记「重启后生效」的项目需要重启 dsh 或热重载插件。</p>
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
