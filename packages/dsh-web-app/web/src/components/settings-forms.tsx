"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/select";
import type {
  ConfigurableProviderView,
  CredentialView,
  DiscoveredModelView,
  LlmDiscoverModelsRequest,
  ModelProviderGroup,
  SettingsNamespaceView,
  SettingsPathOpView,
} from "@/dsh/api";
import { cn } from "@/lib/utils";
import {
  apiKeyError,
  CUSTOM_PROVIDER_ROUTE_PATTERN,
  deriveCredentialRef,
  parseModelCapacity,
} from "@/dsh/settings-provider";

type SchemaMeta = {
  default?: unknown;
  description?: unknown;
  min?: unknown;
  max?: unknown;
  step?: unknown;
  role?: unknown;
  required?: unknown;
};

type SchemaNode = {
  type?: unknown;
  meta?: SchemaMeta;
  value?: unknown;
  list?: Array<string | number>;
  dict?: Record<string, string | number>;
};

type SchemaEnvelope = {
  uid?: string | number;
  refs?: Record<string, SchemaNode>;
};

export type SettingsMutator = (
  namespace: SettingsNamespaceView,
  ops: SettingsPathOpView[],
) => Promise<SettingsNamespaceView>;

export type CredentialWriter = (ref: string, value: string) => Promise<void>;
export type CredentialRemover = (ref: string) => Promise<void>;
export type ModelDiscoverer = (request: LlmDiscoverModelsRequest) => Promise<DiscoveredModelView[]>;

const FIELD_COPY: Record<string, { label: string; hint?: string }> = {
  apiKey: { label: "API Key", hint: "密钥只写入 Host，不会回显到浏览器。" },
  apiKeyEnv: { label: "凭据名称", hint: "Host 用于解析 API Key 的凭据引用。" },
  baseURL: { label: "服务地址", hint: "留空时使用插件或 provider 的默认地址。" },
  model: { label: "模型" },
  apiVersion: { label: "API 版本" },
  maxTokens: { label: "最大输出 Token" },
  maxUses: { label: "单轮最大搜索次数" },
  maxParallelToolCalls: { label: "并行工具调用数", hint: "一个步骤可同时运行的最大工具数量。" },
  cwd: { label: "默认工作目录" },
  timeoutMs: { label: "默认超时（毫秒）" },
  maxTimeoutMs: { label: "最大超时（毫秒）" },
  maxOutputBytes: { label: "最大输出字节数" },
  maxSpillBytes: { label: "最大溢出文件字节数" },
  graceMs: { label: "终止宽限时间（毫秒）" },
  pwshPath: { label: "PowerShell 路径" },
};

const NAMESPACE_COPY: Record<string, { title: string; description: string }> = {
  "web-search-deepseek": {
    title: "Web Search",
    description: "配置 DeepSeek 搜索端点、模型、调用预算和凭据。",
  },
  "agent-loop": {
    title: "Agent Loop",
    description: "控制智能体每个步骤可并行运行的工具调用数量。",
  },
  shell: {
    title: "终端",
    description: "配置命令执行的目录、超时和输出限制。",
  },
};

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function valueAt(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) current = recordOf(current)[key];
  return current;
}

function hasOwnAt(value: unknown, path: readonly string[]): boolean {
  if (path.length === 0) return value !== undefined;
  const parent = valueAt(value, path.slice(0, -1));
  return Object.prototype.hasOwnProperty.call(recordOf(parent), path[path.length - 1]!);
}

function schemaNode(envelope: SchemaEnvelope, id: string | number | undefined): SchemaNode | undefined {
  if (id === undefined) return undefined;
  return envelope.refs?.[String(id)];
}

function rootFields(namespace: SettingsNamespaceView): Array<{ key: string; node: SchemaNode }> {
  const envelope = recordOf(namespace.schema) as SchemaEnvelope;
  const root = schemaNode(envelope, envelope.uid);
  return Object.entries(root?.dict ?? {}).flatMap(([key, id]) => {
    const node = schemaNode(envelope, id);
    return node ? [{ key, node }] : [];
  });
}

function nodeAtSchemaPath(namespace: SettingsNamespaceView, path: readonly string[]): SchemaNode | undefined {
  const envelope = recordOf(namespace.schema) as SchemaEnvelope;
  let node = schemaNode(envelope, envelope.uid);
  for (const key of path) {
    if (node?.type === "object") node = schemaNode(envelope, node.dict?.[key]);
    else if (node?.type === "dict") node = schemaNode(envelope, (node as SchemaNode & { inner?: string | number }).inner);
    else return undefined;
  }
  return node;
}

function protocolChoices(namespace: SettingsNamespaceView | undefined): string[] {
  if (!namespace) return [];
  const node = nodeAtSchemaPath(namespace, ["providers", "__probe", "api"]);
  return choicesOf(namespace, node ?? {}).filter((value): value is string => typeof value === "string");
}

function choicesOf(namespace: SettingsNamespaceView, node: SchemaNode): unknown[] {
  const envelope = recordOf(namespace.schema) as SchemaEnvelope;
  return (node.list ?? []).flatMap((id) => {
    const choice = schemaNode(envelope, id);
    return choice?.type === "const" ? [choice.value] : [];
  });
}

function fieldText(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value);
}

function parseField(node: SchemaNode, text: string): unknown {
  if (node.type === "number") {
    const parsed = Number(text);
    if (text.trim() === "" || !Number.isFinite(parsed)) throw new Error("请输入有效数字。");
    const min = typeof node.meta?.min === "number" ? node.meta.min : undefined;
    const max = typeof node.meta?.max === "number" ? node.meta.max : undefined;
    if (min !== undefined && parsed < min) throw new Error(`值不能小于 ${String(min)}。`);
    if (max !== undefined && parsed > max) throw new Error(`值不能大于 ${String(max)}。`);
    return parsed;
  }
  if (node.type === "boolean") return text === "true";
  return text;
}

function FieldControl({
  namespace,
  field,
  text,
  reset,
  disabled,
  onChange,
  onReset,
}: {
  namespace: SettingsNamespaceView;
  field: { key: string; node: SchemaNode };
  text: string;
  reset: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
  onReset: () => void;
}) {
  const copy = FIELD_COPY[field.key] ?? { label: field.key };
  const choices = choicesOf(namespace, field.node).filter((value): value is string => typeof value === "string");
  const overridden = hasOwnAt(namespace.user, [field.key]) && !reset;
  const isSecret = field.node.meta?.role === "secret";
  const secretSet = namespace.secrets.some((secret) => secret.path.length === 1 && secret.path[0] === field.key && secret.set);
  const placeholder = fieldText(recordOf(namespace.base)[field.key] ?? field.node.meta?.default);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <label className="text-sm font-medium" htmlFor={`${namespace.ns}-${field.key}`}>{copy.label}</label>
        <div className="flex items-center gap-2">
          {isSecret && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <KeyRoundIcon className="size-3" />{secretSet ? "已设置" : "未设置"}
            </span>
          )}
          {overridden && (
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={disabled} onClick={onReset}>
              <RotateCcwIcon className="size-3" />重置
            </Button>
          )}
        </div>
      </div>
      {choices.length > 0 ? (
        <Select
          aria-label={copy.label}
          value={text}
          options={choices.map((value) => ({ value, label: value }))}
          disabled={disabled}
          className="w-full justify-between"
          onValueChange={onChange}
        />
      ) : field.node.type === "boolean" ? (
        <label className="flex h-9 items-center gap-2 text-sm">
          <input
            id={`${namespace.ns}-${field.key}`}
            type="checkbox"
            checked={text === "true"}
            disabled={disabled}
            onChange={(event) => onChange(String(event.target.checked))}
          />
          启用
        </label>
      ) : (
        <Input
          id={`${namespace.ns}-${field.key}`}
          type={isSecret ? "password" : field.node.type === "number" ? "number" : "text"}
          inputMode={field.node.type === "number" ? "numeric" : undefined}
          value={text}
          placeholder={isSecret && secretSet ? "留空以保留当前值" : placeholder}
          autoComplete="off"
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {(copy.hint || reset) && (
        <p className="text-xs leading-5 text-muted-foreground">
          {reset ? "保存后恢复组合默认值。" : copy.hint}
        </p>
      )}
    </div>
  );
}

function PluginNamespaceForm({
  namespace,
  writable,
  onMutate,
}: {
  namespace: SettingsNamespaceView;
  writable: boolean;
  onMutate: SettingsMutator;
}) {
  const fields = useMemo(
    () => rootFields(namespace).filter(({ node }) => ["string", "number", "boolean", "union"].includes(String(node.type))),
    [namespace],
  );
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(
    fields.map(({ key, node }) => [key, node.meta?.role === "secret" ? "" : fieldText(recordOf(namespace.value)[key])]),
  ));
  const [reset, setReset] = useState<ReadonlySet<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const copy = NAMESPACE_COPY[namespace.ns] ?? {
    title: namespace.ns,
    description: `${namespace.applies === "restart" ? "重启后" : "保存后立即"}应用此插件的配置。`,
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const ops: SettingsPathOpView[] = [];
      for (const field of fields) {
        if (reset.has(field.key)) {
          ops.push({ op: "unset", path: [field.key] });
          continue;
        }
        const text = draft[field.key] ?? "";
        if (field.node.meta?.role === "secret" && text === "") continue;
        if (text === "" && field.node.meta?.required !== true) {
          if (hasOwnAt(namespace.user, [field.key])) ops.push({ op: "unset", path: [field.key] });
          continue;
        }
        const value = parseField(field.node, text);
        if (JSON.stringify(value) !== JSON.stringify(recordOf(namespace.value)[field.key])) {
          ops.push({ op: "set", path: [field.key], value });
        }
      }
      if (ops.length > 0) await onMutate(namespace, ops);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="rounded-lg border border-border p-4" onSubmit={save}>
      <div className="mb-5">
        <h3 className="text-sm font-semibold">{copy.title}</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{copy.description}</p>
      </div>
      <div className="grid gap-5 md:grid-cols-2">
        {fields.map((field) => (
          <FieldControl
            key={field.key}
            namespace={namespace}
            field={field}
            text={draft[field.key] ?? ""}
            reset={reset.has(field.key)}
            disabled={!writable || saving}
            onChange={(value) => {
              setDraft((current) => ({ ...current, [field.key]: value }));
              setReset((current) => { const next = new Set(current); next.delete(field.key); return next; });
              setSaved(false);
            }}
            onReset={() => {
              setReset((current) => new Set([...current, field.key]));
              setDraft((current) => ({ ...current, [field.key]: fieldText(recordOf(namespace.base)[field.key] ?? field.node.meta?.default) }));
              setSaved(false);
            }}
          />
        ))}
      </div>
      {fields.length === 0 && <p className="text-sm text-muted-foreground">此插件没有可由表单编辑的字段。</p>}
      <div className="mt-5 flex min-h-9 items-center justify-between gap-3 border-t border-border pt-4">
        <div>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          {saved && <p className="flex items-center gap-1 text-sm text-emerald-600" role="status"><CheckIcon className="size-4" />已保存</p>}
        </div>
        <Button type="submit" size="sm" disabled={!writable || saving || fields.length === 0}>
          {saving && <LoaderCircleIcon className="animate-spin" />}{saving ? "正在保存" : "保存"}
        </Button>
      </div>
    </form>
  );
}

export function PluginSettingsForms({
  namespaces,
  writable,
  onMutate,
}: {
  namespaces: SettingsNamespaceView[];
  writable: boolean;
  onMutate: SettingsMutator;
}) {
  return (
    <section>
      <h2 className="text-sm font-semibold">插件设置</h2>
      <p className="mt-1 text-xs text-muted-foreground">配置 Host 插件公开的可写选项。</p>
      <div className="mt-5 space-y-4">
        {namespaces.map((namespace) => (
          <PluginNamespaceForm
            key={`${namespace.ns}:${String(namespace.revision)}`}
            namespace={namespace}
            writable={writable}
            onMutate={onMutate}
          />
        ))}
      </div>
      {namespaces.length === 0 && <p className="py-16 text-center text-sm text-muted-foreground">没有可配置插件。</p>}
    </section>
  );
}

type ModelDraft = {
  id: string;
  name: string;
  contextWindow: string;
  maxTokens: string;
  source: Record<string, unknown>;
};

function modelDrafts(value: unknown): ModelDraft[] {
  return Array.isArray(value) ? value.map((entry) => {
    const model = recordOf(entry);
    return {
      id: fieldText(model.id),
      name: fieldText(model.name),
      contextWindow: fieldText(model.contextWindow),
      maxTokens: fieldText(model.maxTokens),
      source: { ...model },
    };
  }) : [];
}

function ModelDiscovery({
  request,
  models,
  disabled,
  onDiscover,
  onAdopt,
}: {
  request: LlmDiscoverModelsRequest;
  models: ModelDraft[];
  disabled: boolean;
  onDiscover: ModelDiscoverer;
  onAdopt: (models: ModelDraft[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<DiscoveredModelView[] | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const discover = async () => {
    setBusy(true);
    setError(null);
    try {
      const found = await onDiscover(request);
      if (found.length === 0) throw new Error("Provider 没有返回可用模型。");
      const known = new Set(models.map((model) => model.id));
      setCandidates(found);
      setPicked(new Set(found.filter((model) => !known.has(model.id)).map((model) => model.id)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const adopt = () => {
    if (!candidates) return;
    const byId = new Map(models.map((model) => [model.id, model]));
    for (const model of candidates) {
      if (!picked.has(model.id) || byId.has(model.id)) continue;
      byId.set(model.id, {
        id: model.id,
        name: model.name ?? "",
        contextWindow: model.contextWindow ? String(model.contextWindow) : "",
        maxTokens: model.maxTokens ? String(model.maxTokens) : "",
        source: {},
      });
    }
    onAdopt([...byId.values()]);
    setCandidates(null);
  };
  return (
    <div className="space-y-2">
      <Button type="button" variant="outline" size="sm" disabled={disabled || busy} onClick={() => void discover()}>
        {busy && <LoaderCircleIcon className="animate-spin" />}{busy ? "正在发现" : "发现模型"}
      </Button>
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      {candidates && (
        <div className="rounded-md border border-border p-3">
          <div className="max-h-48 space-y-2 overflow-y-auto">
            {candidates.map((model) => (
              <label key={model.id} className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={picked.has(model.id)} onChange={() => setPicked((current) => { const next = new Set(current); if (!next.delete(model.id)) next.add(model.id); return next; })} />
                <span><span className="block font-medium">{model.name ?? model.id}</span><span className="text-xs text-muted-foreground">{model.id}</span></span>
              </label>
            ))}
          </div>
          <div className="mt-3 flex justify-end gap-2 border-t border-border pt-3">
            <Button type="button" variant="ghost" size="sm" onClick={() => setCandidates(null)}>取消</Button>
            <Button type="button" size="sm" disabled={picked.size === 0} onClick={adopt}>添加所选模型</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ProviderForm({
  entry, group, namespace, configured, credential, writable, onMutate, onCredential, onDiscover, onRemove, onSaved,
}: {
  entry: ConfigurableProviderView;
  group?: ModelProviderGroup;
  namespace: SettingsNamespaceView;
  configured: boolean;
  credential?: CredentialView;
  writable: boolean;
  onMutate: SettingsMutator;
  onCredential: CredentialWriter;
  onDiscover: ModelDiscoverer;
  onRemove?: () => Promise<void>;
  onSaved?: () => Promise<void>;
}) {
  const profile = recordOf(valueAt(namespace.value, entry.settingsPath));
  const userProfile = valueAt(namespace.user, entry.settingsPath);
  const [open, setOpen] = useState(!configured);
  const [baseURL, setBaseURL] = useState(fieldText(profile.baseURL));
  const [displayName, setDisplayName] = useState(fieldText(profile.displayName));
  const protocols = protocolChoices(namespace);
  const [protocol, setProtocol] = useState(fieldText(profile.api) || protocols[0] || "");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<ModelDraft[]>(() => {
    const fromSettings = modelDrafts(profile.models);
    return fromSettings.length > 0 ? fromSettings : (group?.models ?? []).map((model) => ({ id: model.id, name: model.name, contextWindow: "", maxTokens: "", source: {} }));
  });
  const [modelsTouched, setModelsTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const derivedRef = deriveCredentialRef(entry.provider);
  const removable = entry.settingsPath.length > 0 && hasOwnAt(namespace.user, entry.settingsPath) && !hasOwnAt(namespace.base, entry.settingsPath);

  const save = async () => {
    setSaving(true); setError(null); setSaved(false);
    try {
      const keyFailure = apiKeyError(apiKey);
      if (keyFailure) throw new Error(keyFailure);
      const before = recordOf(userProfile);
      const ops: SettingsPathOpView[] = [];
      const addString = (field: string, value: string) => {
        const path = [...entry.settingsPath, field];
        if (!value.trim()) {
          if (Object.prototype.hasOwnProperty.call(before, field)) ops.push({ op: "unset", path });
        } else if (value.trim() !== fieldText(profile[field])) ops.push({ op: "set", path, value: value.trim() });
      };
      addString("baseURL", baseURL);
      if (entry.declared === true) { addString("displayName", displayName); addString("api", protocol); }
      if (apiKey.trim() && fieldText(profile.apiKeyEnv) !== derivedRef) ops.push({ op: "set", path: [...entry.settingsPath, "apiKeyEnv"], value: derivedRef });
      if (modelsTouched) {
        const ids = new Set<string>();
        const nextModels = models.map((model, index) => {
          const id = model.id.trim();
          if (!id) throw new Error(`模型 ${String(index + 1)} 缺少 ID。`);
          if (ids.has(id)) throw new Error(`模型 ID ${id} 重复。`);
          ids.add(id);
          const row: Record<string, unknown> = { ...model.source, id };
          if (model.name.trim()) row.name = model.name.trim(); else delete row.name;
          for (const key of ["contextWindow", "maxTokens"] as const) {
            const count = parseModelCapacity(model[key]);
            if (Number.isNaN(count)) throw new Error(`模型 ${String(index + 1)} 的容量无效。`);
            if (count === undefined) delete row[key]; else row[key] = count;
          }
          return row;
        });
        ops.push({ op: "set", path: [...entry.settingsPath, "models"], value: nextModels });
      }
      if (!configured && ops.length === 0) ops.push({ op: "set", path: entry.settingsPath, value: {} });
      if (ops.length > 0) {
        const updated = await onMutate(namespace, ops);
        const nextProfile = recordOf(valueAt(updated.value, entry.settingsPath));
        setBaseURL(fieldText(nextProfile.baseURL));
        setDisplayName(fieldText(nextProfile.displayName));
        setProtocol(fieldText(nextProfile.api) || protocols[0] || "");
        const nextModels = modelDrafts(nextProfile.models);
        setModels(nextModels.length > 0 ? nextModels : (group?.models ?? []).map((model) => ({
          id: model.id,
          name: model.name,
          contextWindow: "",
          maxTokens: "",
          source: {},
        })));
        setModelsTouched(false);
      }
      if (apiKey.trim()) { await onCredential(derivedRef, apiKey.trim()); setApiKey(""); }
      setModelsTouched(false); setSaved(true);
      if (onSaved) await onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (!onRemove) return;
    setDeleting(true); setError(null);
    try { await onRemove(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setDeleting(false); }
  };

  const editModels = (next: ModelDraft[]) => { setModelsTouched(true); setModels(next); };
  return (
    <div className="rounded-lg border border-border">
      <button type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? <ChevronDownIcon className="size-4" /> : <ChevronRightIcon className="size-4" />}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 truncate text-sm font-medium">{entry.displayName}{entry.declared === true && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal">自定义</span>}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{models.length} 个模型 · {credential?.configured ? "凭据已配置" : "凭据未配置"}</span>
        </span>
        <span className={cn("size-2 rounded-full", entry.active ? "bg-emerald-500" : "bg-muted-foreground/40")} aria-label={entry.active ? "已启用" : "未启用"} />
      </button>
      {open && (
        <div className="space-y-5 border-t border-border px-4 py-4">
          <div className="grid gap-4 md:grid-cols-2">
            {entry.declared === true && <label className="space-y-2 text-sm font-medium">显示名称<Input value={displayName} disabled={!writable || saving} onChange={(event) => setDisplayName(event.target.value)} /></label>}
            {entry.declared === true && <label className="space-y-2 text-sm font-medium">API 协议<Select value={protocol} options={protocols.map((value) => ({ value, label: value }))} disabled={!writable || saving} className="w-full justify-between" onValueChange={setProtocol} /></label>}
            <label className="space-y-2 text-sm font-medium">API Key<Input type="password" value={apiKey} placeholder={credential?.configured ? "留空以保留当前密钥" : "可选，留空使用 Provider 原生认证"} autoComplete="off" disabled={!writable || saving || credential?.writable === false} onChange={(event) => setApiKey(event.target.value)} /></label>
            <label className="space-y-2 text-sm font-medium">服务地址<Input value={baseURL} placeholder="使用 Provider 默认地址" disabled={!writable || saving} onChange={(event) => setBaseURL(event.target.value)} /></label>
          </div>
          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-medium">模型目录</h4><div className="flex gap-2"><ModelDiscovery request={{ settingsNs: entry.settingsNs, provider: entry.provider, ...(baseURL ? { baseURL } : {}), ...(entry.declared === true && protocol ? { api: protocol } : {}), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }} models={models} disabled={!writable || saving || Boolean(apiKeyError(apiKey))} onDiscover={onDiscover} onAdopt={editModels} /><Button type="button" variant="outline" size="sm" disabled={!writable || saving} onClick={() => editModels([...models, { id: "", name: "", contextWindow: "", maxTokens: "", source: {} }])}><PlusIcon />添加模型</Button></div></div>
            <div className="divide-y divide-border rounded-md border border-border">
              {models.map((model, index) => <div key={index} className="grid gap-2 p-3 md:grid-cols-[1fr_1fr_7rem_7rem_auto]">
                <Input aria-label={`模型 ID ${String(index + 1)}`} value={model.id} placeholder="模型 ID" disabled={!writable || saving} onChange={(event) => editModels(models.map((item, at) => at === index ? { ...item, id: event.target.value } : item))} />
                <Input aria-label={`模型名称 ${String(index + 1)}`} value={model.name} placeholder="显示名称" disabled={!writable || saving} onChange={(event) => editModels(models.map((item, at) => at === index ? { ...item, name: event.target.value } : item))} />
                <Input aria-label={`上下文窗口 ${String(index + 1)}`} value={model.contextWindow} placeholder="上下文/K/M" disabled={!writable || saving} onChange={(event) => editModels(models.map((item, at) => at === index ? { ...item, contextWindow: event.target.value } : item))} />
                <Input aria-label={`最大输出 ${String(index + 1)}`} value={model.maxTokens} placeholder="输出/K/M" disabled={!writable || saving} onChange={(event) => editModels(models.map((item, at) => at === index ? { ...item, maxTokens: event.target.value } : item))} />
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`删除模型 ${String(index + 1)}`} disabled={!writable || saving} onClick={() => editModels(models.filter((_item, at) => at !== index))}><Trash2Icon /></Button>
              </div>)}
              {models.length === 0 && <p className="p-4 text-sm text-muted-foreground">尚未选择模型，可手动添加或从 Provider 发现。</p>}
            </div>
          </div>
          {confirmDelete && <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"><p>删除 {entry.displayName} 的配置？{fieldText(profile.apiKeyEnv) === derivedRef && credential?.configured && credential.writable ? "对应凭据也会被删除。" : ""}</p><div className="mt-3 flex justify-end gap-2"><Button type="button" variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>取消</Button><Button type="button" variant="destructive" size="sm" disabled={deleting} onClick={() => void remove()}>{deleting ? "正在删除" : "确认删除"}</Button></div></div>}
          <div className="flex min-h-9 items-center justify-between gap-3"><div>{error && <p className="text-sm text-destructive" role="alert">{error}</p>}{saved && <p className="flex items-center gap-1 text-sm text-emerald-600"><CheckIcon className="size-4" />已保存</p>}</div><div className="flex gap-2">{removable && onRemove && <Button type="button" variant="ghost" size="sm" className="text-destructive" disabled={saving || deleting} onClick={() => setConfirmDelete(true)}><Trash2Icon />删除</Button>}<Button type="button" size="sm" disabled={!writable || saving} onClick={() => void save()}>{saving && <LoaderCircleIcon className="animate-spin" />}{saving ? "正在保存" : configured ? "保存 Provider" : "添加 Provider"}</Button></div></div>
        </div>
      )}
    </div>
  );
}

function CustomProviderForm({ namespace, taken, writable, onMutate, onCredential, onDiscover, onClose }: {
  namespace: SettingsNamespaceView;
  taken: string[];
  writable: boolean;
  onMutate: SettingsMutator;
  onCredential: CredentialWriter;
  onDiscover: ModelDiscoverer;
  onClose: (changed: boolean) => void;
}) {
  const protocols = protocolChoices(namespace);
  const [route, setRoute] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [protocol, setProtocol] = useState(protocols[0] ?? "");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<ModelDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [committed, setCommitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const routeError = route && (!CUSTOM_PROVIDER_ROUTE_PATTERN.test(route) ? "Route ID 必须是小写 kebab-case。" : taken.includes(route) ? "Route ID 已存在。" : null);
  const keyError = apiKeyError(apiKey);
  const derivedRef = deriveCredentialRef(route);
  const editModel = (index: number, field: keyof Omit<ModelDraft, "source">, value: string) => setModels((current) => current.map((model, at) => at === index ? { ...model, [field]: value } : model));
  const create = async () => {
    setBusy(true); setError(null);
    try {
      if (!route || routeError) throw new Error(routeError || "请输入 Route ID。");
      if (!baseURL.trim()) throw new Error("请输入服务地址。");
      if (!protocol) throw new Error("请选择 API 协议。");
      if (keyError) throw new Error(keyError);
      if (models.length === 0) throw new Error("请至少添加一个模型。");
      const ids = new Set<string>();
      const catalog = models.map((model, index) => {
        const id = model.id.trim();
        if (!id) throw new Error(`模型 ${String(index + 1)} 缺少 ID。`);
        if (ids.has(id)) throw new Error(`模型 ID ${id} 重复。`);
        ids.add(id);
        const row: Record<string, unknown> = { id };
        if (model.name.trim()) row.name = model.name.trim();
        for (const key of ["contextWindow", "maxTokens"] as const) {
          const count = parseModelCapacity(model[key]);
          if (Number.isNaN(count)) throw new Error(`模型 ${String(index + 1)} 的容量无效。`);
          if (count !== undefined) row[key] = count;
        }
        return row;
      });
      if (!committed) {
        const profile = { ...(displayName.trim() ? { displayName: displayName.trim() } : {}), ...(apiKey.trim() ? { apiKeyEnv: derivedRef } : {}), api: protocol, baseURL: baseURL.trim(), models: catalog };
        await onMutate(namespace, [{ op: "set", path: ["providers", route], value: profile }]);
        setCommitted(true);
      }
      if (apiKey.trim()) await onCredential(derivedRef, apiKey.trim());
      onClose(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <div className="space-y-5 rounded-lg border border-border p-4">
    <div><h3 className="text-sm font-semibold">自定义 Provider</h3><p className="mt-1 text-xs text-muted-foreground">声明 OpenAI 兼容网关、自托管服务或目录中不存在的新 Provider。</p></div>
    <div className="grid gap-4 md:grid-cols-2">
      <label className="space-y-2 text-sm font-medium">Route ID<Input value={route} placeholder="acme-gateway" disabled={!writable || busy || committed} aria-invalid={Boolean(routeError)} onChange={(event) => setRoute(event.target.value)} />{routeError && <span className="block text-xs text-destructive">{routeError}</span>}</label>
      <label className="space-y-2 text-sm font-medium">显示名称<Input value={displayName} placeholder={route || "Acme Gateway"} disabled={!writable || busy || committed} onChange={(event) => setDisplayName(event.target.value)} /></label>
      <label className="space-y-2 text-sm font-medium">服务地址<Input value={baseURL} placeholder="https://gateway.example/v1" disabled={!writable || busy || committed} onChange={(event) => setBaseURL(event.target.value)} /></label>
      <label className="space-y-2 text-sm font-medium">API 协议<Select value={protocol} options={protocols.map((value) => ({ value, label: value }))} disabled={!writable || busy || committed} className="w-full justify-between" onValueChange={setProtocol} /></label>
      <label className="space-y-2 text-sm font-medium md:col-span-2">API Key<Input type="password" autoComplete="off" value={apiKey} placeholder="可选，留空使用 Provider 原生认证" disabled={!writable || busy} aria-invalid={Boolean(keyError)} onChange={(event) => setApiKey(event.target.value)} />{keyError && <span className="block text-xs text-destructive">{keyError}</span>}</label>
    </div>
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-medium">模型目录</h4><div className="flex gap-2"><ModelDiscovery request={{ settingsNs: "llm-pi-ai", ...(baseURL ? { baseURL } : {}), ...(protocol ? { api: protocol } : {}), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }} models={models} disabled={!writable || busy || committed || !baseURL || Boolean(keyError)} onDiscover={onDiscover} onAdopt={setModels} /><Button type="button" variant="outline" size="sm" disabled={!writable || busy || committed} onClick={() => setModels((current) => [...current, { id: "", name: "", contextWindow: "", maxTokens: "", source: {} }])}><PlusIcon />添加模型</Button></div></div>
      <div className="divide-y divide-border rounded-md border border-border">{models.map((model, index) => <div key={index} className="grid gap-2 p-3 md:grid-cols-[1fr_1fr_7rem_7rem_auto]"><Input aria-label={`自定义模型 ID ${String(index + 1)}`} value={model.id} placeholder="模型 ID" disabled={busy || committed} onChange={(event) => editModel(index, "id", event.target.value)} /><Input aria-label={`自定义模型名称 ${String(index + 1)}`} value={model.name} placeholder="显示名称" disabled={busy || committed} onChange={(event) => editModel(index, "name", event.target.value)} /><Input aria-label={`自定义上下文窗口 ${String(index + 1)}`} value={model.contextWindow} placeholder="上下文/K/M" disabled={busy || committed} onChange={(event) => editModel(index, "contextWindow", event.target.value)} /><Input aria-label={`自定义最大输出 ${String(index + 1)}`} value={model.maxTokens} placeholder="输出/K/M" disabled={busy || committed} onChange={(event) => editModel(index, "maxTokens", event.target.value)} /><Button type="button" variant="ghost" size="icon-sm" aria-label={`删除自定义模型 ${String(index + 1)}`} disabled={busy || committed} onClick={() => setModels((current) => current.filter((_model, at) => at !== index))}><Trash2Icon /></Button></div>)}{models.length === 0 && <p className="p-4 text-sm text-muted-foreground">至少添加一个模型，可手动输入或从服务发现。</p>}</div>
    </div>
    {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
    <div className="flex justify-end gap-2 border-t border-border pt-4"><Button type="button" variant="ghost" disabled={busy} onClick={() => onClose(committed)}>取消</Button><Button type="button" disabled={!writable || busy || !route || Boolean(routeError) || !baseURL || !protocol || models.length === 0 || Boolean(keyError)} onClick={() => void create()}>{busy && <LoaderCircleIcon className="animate-spin" />}{busy ? committed ? "正在保存凭据" : "正在创建" : "创建 Provider"}</Button></div>
  </div>;
}

function DefaultModelForm({
  namespace,
  groups,
  writable,
  onMutate,
}: {
  namespace: SettingsNamespaceView | undefined;
  groups: ModelProviderGroup[];
  writable: boolean;
  onMutate: SettingsMutator;
}) {
  const current = recordOf(namespace?.value);
  const [provider, setProvider] = useState(fieldText(current.provider));
  const [model, setModel] = useState(fieldText(current.model));
  const [effort, setEffort] = useState(fieldText(current.reasoningEffort));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const group = groups.find((item) => item.id === provider) ?? groups[0];
  const selectedModel = group?.models.find((item) => item.id === model) ?? group?.models[0];
  const efforts = selectedModel?.reasoning?.efforts ?? [];

  useEffect(() => {
    setProvider(fieldText(current.provider));
    setModel(fieldText(current.model));
    setEffort(fieldText(current.reasoningEffort));
  }, [namespace?.revision, current.provider, current.model, current.reasoningEffort]);

  if (!namespace || groups.length === 0) return null;
  const save = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const ops: SettingsPathOpView[] = [
        { op: "set", path: ["provider"], value: provider },
        { op: "set", path: ["model"], value: model },
      ];
      if (effort) ops.push({ op: "set", path: ["reasoningEffort"], value: effort });
      else ops.push({ op: "unset", path: ["reasoningEffort"] });
      await onMutate(namespace, ops);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-border p-4">
      <h3 className="text-sm font-semibold">默认模型</h3>
      <p className="mt-1 text-xs text-muted-foreground">用于此后新建且未显式选择模型的会话。</p>
      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <label className="space-y-2 text-sm font-medium">
          Provider
          <Select
            value={provider}
            options={groups.map((item) => ({ value: item.id, label: item.name }))}
            disabled={!writable || saving}
            className="w-full justify-between"
            onValueChange={(value) => {
              const next = groups.find((item) => item.id === value)!;
              setProvider(value);
              setModel(next.models[0]?.id ?? "");
              setEffort(next.models[0]?.reasoning?.defaultEffort ?? "");
              setSaved(false);
            }}
          />
        </label>
        <label className="space-y-2 text-sm font-medium">
          模型
          <Select
            value={model}
            options={(group?.models ?? []).map((item) => ({ value: item.id, label: item.name }))}
            disabled={!writable || saving}
            className="w-full justify-between"
            onValueChange={(value) => {
              const next = group?.models.find((item) => item.id === value);
              setModel(value);
              setEffort(next?.reasoning?.defaultEffort ?? "");
              setSaved(false);
            }}
          />
        </label>
        <label className="space-y-2 text-sm font-medium">
          推理强度
          <Select
            value={effort || "default"}
            options={[{ value: "default", label: "模型默认" }, ...efforts.map((item) => ({ value: item.id, label: item.name }))]}
            disabled={!writable || saving}
            className="w-full justify-between"
            onValueChange={(value) => { setEffort(value === "default" ? "" : value); setSaved(false); }}
          />
        </label>
      </div>
      <div className="mt-4 flex min-h-9 items-center justify-between gap-3 border-t border-border pt-4">
        <div>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          {saved && <p className="flex items-center gap-1 text-sm text-emerald-600"><CheckIcon className="size-4" />已保存</p>}
        </div>
        <Button type="button" size="sm" disabled={!writable || saving || !provider || !model} onClick={() => void save()}>
          {saving && <LoaderCircleIcon className="animate-spin" />}{saving ? "正在保存" : "保存默认模型"}
        </Button>
      </div>
    </div>
  );
}

export function ModelsSettingsForms({ namespaces, groups, providers, credentials, writable, onMutate, onCredential, onDiscover, onRemoveProvider, onReload }: {
  namespaces: SettingsNamespaceView[];
  groups: ModelProviderGroup[];
  providers: ConfigurableProviderView[];
  credentials: Record<string, CredentialView>;
  writable: boolean;
  onMutate: SettingsMutator;
  onCredential: CredentialWriter;
  onDiscover: ModelDiscoverer;
  onRemoveProvider: (entry: ConfigurableProviderView, credentialRef?: string) => Promise<void>;
  onReload: () => Promise<void>;
}) {
  const defaultNamespace = namespaces.find((item) => item.ns === "agent-default-model");
  const piNamespace = namespaces.find((item) => item.ns === "llm-pi-ai");
  const [addMode, setAddMode] = useState<"known" | "custom" | null>(null);
  const [selectedProvider, setSelectedProvider] = useState("");
  const addressed = providers.flatMap((entry) => {
    if (!entry.settingsNs) return [];
    const namespace = namespaces.find((item) => item.ns === entry.settingsNs);
    if (!namespace) return [];
    const configured = entry.settingsPath.length === 0 || valueAt(namespace.value, entry.settingsPath) !== undefined;
    const profile = recordOf(valueAt(namespace.value, entry.settingsPath));
    const ref = typeof profile.apiKeyEnv === "string" ? profile.apiKeyEnv : undefined;
    return [{ entry, namespace, configured, group: groups.find((group) => group.id === entry.provider), ref }];
  });
  const configuredRows = addressed.filter((row) => (
    row.configured && !(addMode === "known" && row.entry.provider === selectedProvider)
  ));
  const addable = addressed.filter((row) => !row.configured);
  // Keep the selected row addressed after its settings write lands so a failed
  // credential write can retry in the same editor without replaying the mutate.
  const selected = addressed.find((row) => row.entry.provider === selectedProvider) ?? addable[0];
  const closeAdd = async (changed: boolean) => { setAddMode(null); if (changed) await onReload(); };

  return <section>
    <h2 className="text-sm font-semibold">模型</h2>
    <p className="mt-1 text-xs text-muted-foreground">选择默认模型，并管理 Provider 的连接、凭据和模型目录。</p>
    <div className="mt-5 space-y-4">
      <DefaultModelForm namespace={defaultNamespace} groups={groups} writable={writable} onMutate={onMutate} />
      <div className="space-y-2">{configuredRows.map(({ entry, namespace, group, ref }) => {
        const credential = ref ? credentials[ref] : undefined;
        const derivedRef = deriveCredentialRef(entry.provider);
        const removable = entry.settingsPath.length > 0 && hasOwnAt(namespace.user, entry.settingsPath) && !hasOwnAt(namespace.base, entry.settingsPath);
        const managedRef = removable && ref === derivedRef && credential?.configured && credential.writable ? derivedRef : undefined;
        return <ProviderForm key={entry.provider} entry={entry} group={group} namespace={namespace} configured credential={credential} writable={writable} onMutate={onMutate} onCredential={onCredential} onDiscover={onDiscover} onRemove={removable ? () => onRemoveProvider(entry, managedRef) : undefined} onSaved={onReload} />;
      })}</div>
      {addMode === "known" && selected ? <div className="space-y-3 rounded-lg border border-border p-4"><div className="flex items-end justify-between gap-3"><label className="min-w-0 flex-1 space-y-2 text-sm font-medium">Provider<Select value={selected.entry.provider} options={[selected, ...addable.filter((row) => row.entry.provider !== selected.entry.provider)].map((row) => ({ value: row.entry.provider, label: row.entry.displayName }))} className="w-full justify-between" onValueChange={setSelectedProvider} /></label><Button type="button" variant="ghost" size="sm" onClick={() => setAddMode(null)}>取消</Button></div><ProviderForm key={selected.entry.provider} entry={selected.entry} group={selected.group} namespace={selected.namespace} configured={selected.configured} writable={writable} onMutate={onMutate} onCredential={onCredential} onDiscover={onDiscover} onSaved={() => closeAdd(true)} /></div> : null}
      {addMode === "custom" && piNamespace ? <CustomProviderForm namespace={piNamespace} taken={providers.map((entry) => entry.provider)} writable={writable} onMutate={onMutate} onCredential={onCredential} onDiscover={onDiscover} onClose={(changed) => void closeAdd(changed)} /> : null}
      {addMode === null && <div className="grid grid-cols-2 gap-2"><Button type="button" variant="outline" disabled={!writable || addable.length === 0} onClick={() => { setSelectedProvider(addable[0]?.entry.provider ?? ""); setAddMode("known"); }}><PlusIcon />添加 Provider</Button><Button type="button" variant="outline" disabled={!writable || !piNamespace || protocolChoices(piNamespace).length === 0} onClick={() => setAddMode("custom")}><PlusIcon />自定义 Provider</Button></div>}
    </div>
  </section>;
}
