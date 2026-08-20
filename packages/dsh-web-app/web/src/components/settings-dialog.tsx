"use client";

import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import {
  BotIcon,
  CheckIcon,
  ExternalLinkIcon,
  FileCogIcon,
  LoaderCircleIcon,
  MonitorIcon,
  MoonIcon,
  PuzzleIcon,
  Settings2Icon,
  SunIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";

import { useDsh } from "@/dsh/store";
import {
  rpc,
  type AgentPresetEntry,
  type AgentPresetListResponse,
  type ConfigurableProviderView,
  type CredentialView,
  type LlmDiscoverModelsRequest,
  type LlmDiscoverModelsResponse,
  type ModelCatalogResponse,
  type ModelProviderGroup,
  type SettingsDescribeResponse,
  type SettingsMutateRequest,
  type SettingsNamespaceView,
  type SettingsPathOpView,
  type SettingsUpdateRequest,
} from "@/dsh/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select } from "@/components/select";
import { ModelsSettingsForms, PluginSettingsForms } from "@/components/settings-forms";
import { cn } from "@/lib/utils";

export type SettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type RequestResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error?: { code?: string; message?: string } };

type SettingsSectionId = "general" | "models" | "plugins" | "agent-presets";
type ThemePreference = "light" | "dark" | "system";

type SettingsSection = {
  id: SettingsSectionId;
  label: string;
  Icon: LucideIcon;
};

const SECTIONS: readonly SettingsSection[] = [
  { id: "general", label: "通用设置", Icon: Settings2Icon },
  { id: "models", label: "模型", Icon: BotIcon },
  { id: "plugins", label: "插件", Icon: PuzzleIcon },
  { id: "agent-presets", label: "Agent 预设", Icon: FileCogIcon },
];

const PERMISSION_OPTIONS = [
  { value: "read-only", label: "Read Only" },
  { value: "workspace-write", label: "Workspace Write" },
  { value: "danger-full-access", label: "Full access" },
] as const;

const ENTER_OPTIONS = [
  { value: "queue", label: "排队发送" },
  { value: "steer", label: "插话发送" },
] as const;

const LOCALE_OPTIONS = [
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
] as const;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "操作失败。";
}

function displayError(result: RequestResult): string {
  return result.ok ? "" : result.error?.message ?? "请求失败。";
}

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

function stringField(namespace: SettingsNamespaceView | undefined, field: string, fallback: string): string {
  const value = recordOf(namespace?.value)[field];
  return typeof value === "string" ? value : fallback;
}

function applyTheme(preference: ThemePreference): void {
  const dark = preference === "dark"
    || (preference === "system" && (window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false));
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

function isModelNamespace(namespace: SettingsNamespaceView): boolean {
  return namespace.ns === "agent-default-model" || namespace.ns.startsWith("llm-");
}

function isGeneralNamespace(namespace: SettingsNamespaceView): boolean {
  return ["agent-presets", "permission", "locale", "ui-theme", "ui-conversation"].includes(namespace.ns);
}

function PreferenceRow({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-19 flex-col items-stretch justify-between gap-3 border-b border-border py-4 last:border-b-0 sm:flex-row sm:items-center sm:gap-6">
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        {description && <div className="mt-1 text-xs leading-5 text-muted-foreground">{description}</div>}
      </div>
      <div className="w-full shrink-0 sm:w-auto">{children}</div>
    </div>
  );
}

function ThemeControl({
  value,
  disabled,
  onChange,
}: {
  value: ThemePreference;
  disabled: boolean;
  onChange: (value: ThemePreference) => void;
}) {
  const choices = [
    { id: "light" as const, label: "浅色", Icon: SunIcon },
    { id: "dark" as const, label: "深色", Icon: MoonIcon },
    { id: "system" as const, label: "跟随系统", Icon: MonitorIcon },
  ];
  return (
    <div className="grid w-full grid-cols-3 gap-2" aria-label="外观">
      {choices.map(({ id, label, Icon }) => (
        <Button
          key={id}
          type="button"
          variant="outline"
          aria-pressed={value === id}
          disabled={disabled}
          className={cn(
            "h-21 min-w-0 flex-col gap-2 rounded-xl px-2 font-normal",
            value === id && "border-foreground/35 bg-muted",
          )}
          onClick={() => onChange(id)}
        >
          <Icon className="size-4" aria-hidden="true" />
          {label}
        </Button>
      ))}
    </div>
  );
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const descriptionId = useId();
  const setBusyEnterBehavior = useDsh((state) => state.setBusyEnterBehavior);
  const [activeSection, setActiveSection] = useState<SettingsSectionId>("general");
  const [namespaces, setNamespaces] = useState<SettingsNamespaceView[]>([]);
  const [presets, setPresets] = useState<AgentPresetEntry[]>([]);
  const [modelProviders, setModelProviders] = useState<ConfigurableProviderView[]>([]);
  const [modelGroups, setModelGroups] = useState<ModelProviderGroup[]>([]);
  const [credentials, setCredentials] = useState<Record<string, CredentialView>>({});
  const [writable, setWritable] = useState(false);
  const [hasDocument, setHasDocument] = useState(false);
  const [loading, setLoading] = useState(false);
  const [savingField, setSavingField] = useState<string | null>(null);
  const [openingDocument, setOpeningDocument] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const namespace = useCallback((ns: string) => namespaces.find((item) => item.ns === ns), [namespaces]);
  const modelNamespaces = useMemo(() => namespaces.filter(isModelNamespace), [namespaces]);
  const pluginNamespaces = useMemo(
    () => namespaces.filter((item) => !isGeneralNamespace(item) && !isModelNamespace(item)),
    [namespaces],
  );

  const replaceNamespace = useCallback((view: SettingsNamespaceView) => {
    setNamespaces((current) => current.map((item) => item.ns === view.ns ? view : item));
  }, []);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [settingsResult, presetsResult, providersResult, modelsResult] = await Promise.all([
        rpc<SettingsDescribeResponse>("settings.describe"),
        rpc<AgentPresetListResponse>("agentPreset.list"),
        rpc<{ providers: ConfigurableProviderView[] }>("llm.providers"),
        rpc<ModelCatalogResponse>("llm.models"),
      ]);
      if (!settingsResult.ok) throw new Error(displayError(settingsResult));
      const nextNamespaces = settingsResult.value.namespaces ?? [];
      setNamespaces(nextNamespaces);
      setWritable(settingsResult.value.writable);
      setHasDocument(settingsResult.value.hasDocument);
      if (presetsResult.ok) setPresets([...presetsResult.value.presets]);
      if (providersResult.ok) {
        const providerRows = providersResult.value.providers;
        setModelProviders(providerRows);
        const refs = [...new Set(providerRows.flatMap((entry) => {
          const view = nextNamespaces.find((item) => item.ns === entry.settingsNs);
          const profile = recordOf(valueAt(view?.value, entry.settingsPath));
          return typeof profile.apiKeyEnv === "string" ? [profile.apiKeyEnv] : [];
        }))].slice(0, 64);
        const credentialResult = refs.length > 0
          ? await rpc<{ credentials: Record<string, CredentialView> }>("credentials.describe", { refs })
          : { ok: true as const, value: { credentials: {} } };
        if (credentialResult.ok) setCredentials(credentialResult.value.credentials);
      }
      if (modelsResult.ok) setModelGroups(modelsResult.value.groups);
      const theme = stringField(nextNamespaces.find((item) => item.ns === "ui-theme"), "preference", "system");
      if (theme === "light" || theme === "dark" || theme === "system") applyTheme(theme);
      const busyEnter = stringField(nextNamespaces.find((item) => item.ns === "ui-conversation"), "busyEnter", "queue");
      setBusyEnterBehavior(busyEnter === "steer" ? "steer" : "queue");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [setBusyEnterBehavior]);

  useEffect(() => {
    if (open) void loadSettings();
  }, [loadSettings, open]);

  const mutateField = async (ns: string, path: string[], value: unknown, key: string) => {
    const current = namespace(ns);
    if (!current || !writable || savingField) return;
    setSavingField(key);
    setError(null);
    try {
      const request: SettingsMutateRequest = {
        ns,
        ops: [{ op: "set", path, value }],
        expectedRevision: current.revision,
      };
      const result = await rpc<SettingsNamespaceView>("settings.mutate", request);
      if (!result.ok) throw new Error(displayError(result));
      replaceNamespace(result.value);
      if (ns === "ui-conversation" && path.length === 1 && path[0] === "busyEnter") {
        setBusyEnterBehavior(value === "steer" ? "steer" : "queue");
      }
    } catch (cause) {
      setError(errorMessage(cause));
      await loadSettings();
    } finally {
      setSavingField(null);
    }
  };

  const updateDefaultPreset = async (id: string) => {
    const current = namespace("agent-presets");
    if (!current || !writable || savingField) return;
    setSavingField("agent-presets");
    setError(null);
    try {
      const request: SettingsUpdateRequest = {
        ns: current.ns,
        patch: { default: id },
        expectedRevision: current.revision,
      };
      const result = await rpc<SettingsNamespaceView>("settings.update", request);
      if (!result.ok) throw new Error(displayError(result));
      replaceNamespace(result.value);
      setPresets((items) => items.map((item) => ({ ...item, isDefault: item.id === id })));
    } catch (cause) {
      setError(errorMessage(cause));
      await loadSettings();
    } finally {
      setSavingField(null);
    }
  };

  const mutateNamespace = async (current: SettingsNamespaceView, ops: SettingsPathOpView[]) => {
    const request: SettingsMutateRequest = {
      ns: current.ns,
      ops,
      expectedRevision: current.revision,
    };
    const result = await rpc<SettingsNamespaceView>("settings.mutate", request);
    if (!result.ok) {
      await loadSettings();
      throw new Error(displayError(result));
    }
    replaceNamespace(result.value);
    return result.value;
  };

  const writeCredential = async (ref: string, value: string) => {
    const result = await rpc("credentials.set", { ref, value });
    if (!result.ok) throw new Error(displayError(result));
  };

  const discoverModels = async (request: LlmDiscoverModelsRequest) => {
    const result = await rpc<LlmDiscoverModelsResponse>("llm.discoverModels", request);
    if (!result.ok) throw new Error(displayError(result));
    return result.value.models;
  };

  const removeProvider = async (entry: ConfigurableProviderView, credentialRef?: string) => {
    if (credentialRef) {
      const credentialResult = await rpc("credentials.unset", { ref: credentialRef });
      if (!credentialResult.ok) throw new Error(displayError(credentialResult));
    }
    const result = await rpc<SettingsNamespaceView>("settings.mutate", {
      ns: entry.settingsNs,
      ops: [{ op: "unset", path: entry.settingsPath }],
    });
    if (!result.ok) throw new Error(displayError(result));
    await loadSettings();
  };

  const openDocument = async () => {
    setOpeningDocument(true);
    setError(null);
    try {
      const result = await rpc("settings.openDocument");
      if (!result.ok) setError(displayError(result));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setOpeningDocument(false);
    }
  };

  const defaultPreset = stringField(namespace("agent-presets"), "default", presets.find((item) => item.isDefault)?.id ?? "");
  const permission = stringField(namespace("permission"), "defaultPreset", "workspace-write");
  const locale = stringField(namespace("locale"), "preference", "zh");
  const theme = stringField(namespace("ui-theme"), "preference", "system") as ThemePreference;
  const busyEnter = stringField(namespace("ui-conversation"), "busyEnter", "queue");
  const presetOptions = presets.filter((item) => !item.broken).map((item) => ({
    value: item.id,
    label: item.name ?? item.id,
  }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="h-[min(800px,calc(100dvh-3rem))] w-[min(800px,calc(100vw-3rem))] max-w-none gap-0 overflow-hidden rounded-3xl p-0 sm:max-w-none"
        aria-describedby={descriptionId}
      >
        <DialogDescription id={descriptionId} className="sr-only">管理 DeepSeek Harness 设置</DialogDescription>
        <div className="flex h-full min-h-0 min-w-0 flex-col sm:flex-row">
          <nav className="flex w-full min-w-0 shrink-0 flex-col gap-[18px] border-b border-border px-3 pt-[22px] sm:w-[188px] sm:border-r sm:border-b-0" aria-label="设置分类">
            <DialogTitle className="px-3 text-base leading-6">设置</DialogTitle>
            <div className="grid w-full min-w-0 grid-cols-2 gap-1 pb-3 sm:flex sm:flex-col sm:pb-0">
              {SECTIONS.map(({ id, label, Icon }) => (
                <Button
                  key={id}
                  type="button"
                  variant="ghost"
                  aria-current={activeSection === id ? "page" : undefined}
                  className={cn(
                    "h-10 min-w-0 justify-start gap-2 rounded-xl px-3 font-normal sm:w-full",
                    activeSection === id && "bg-muted text-foreground hover:bg-muted",
                  )}
                  onClick={() => setActiveSection(id)}
                >
                  <Icon className="size-4" aria-hidden="true" />
                  {label}
                </Button>
              ))}
            </div>
          </nav>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <header className="flex h-[54px] shrink-0 items-center justify-end gap-2 px-4">
              {hasDocument && (
                <Button type="button" variant="ghost" size="sm" onClick={openDocument} disabled={loading || openingDocument}>
                  {openingDocument ? <LoaderCircleIcon className="animate-spin" /> : <ExternalLinkIcon />}
                  <span className="hidden md:inline">打开配置文件</span>
                </Button>
              )}
              <DialogClose asChild>
                <Button type="button" variant="ghost" size="icon-sm" aria-label="关闭">
                  <XIcon aria-hidden="true" />
                </Button>
              </DialogClose>
            </header>

            <ScrollArea className="min-h-0 flex-1">
              <div className="min-h-full px-6 pb-6">
                {loading ? (
                  <div className="flex min-h-48 items-center justify-center text-muted-foreground" role="status">
                    <LoaderCircleIcon className="mr-2 size-4 animate-spin" />
                    正在加载设置
                  </div>
                ) : activeSection === "general" ? (
                  <div>
                    <PreferenceRow title="Agent 预设" description="对此后新建的会话生效。运行中的会话保持它开始时的预设。">
                      <Select
                        aria-label="Agent 预设"
                        value={defaultPreset}
                        options={presetOptions}
                        disabled={!writable || savingField !== null || presetOptions.length === 0}
                        className="bg-muted px-3 py-2 text-foreground"
                        onValueChange={(value) => void updateDefaultPreset(value)}
                      />
                    </PreferenceRow>
                    <PreferenceRow title="权限" description="选择新会话的默认权限模式">
                      <Select
                        aria-label="权限"
                        value={permission}
                        options={PERMISSION_OPTIONS}
                        disabled={!writable || savingField !== null || !namespace("permission")}
                        className="bg-muted px-3 py-2 text-foreground"
                        onValueChange={(value) => void mutateField("permission", ["defaultPreset"], value, "permission")}
                      />
                    </PreferenceRow>
                    <PreferenceRow title="语言">
                      <Select
                        aria-label="语言"
                        value={locale}
                        options={LOCALE_OPTIONS}
                        disabled={!writable || savingField !== null || !namespace("locale")}
                        className="bg-muted px-3 py-2 text-foreground"
                        onValueChange={(value) => void mutateField("locale", ["preference"], value, "locale")}
                      />
                    </PreferenceRow>
                    <div className="border-b border-border py-5">
                      <div className="mb-3 text-sm font-medium">外观</div>
                      <ThemeControl
                        value={theme === "light" || theme === "dark" || theme === "system" ? theme : "system"}
                        disabled={!writable || savingField !== null || !namespace("ui-theme")}
                        onChange={(value) => {
                          applyTheme(value);
                          void mutateField("ui-theme", ["preference"], value, "ui-theme");
                        }}
                      />
                    </div>
                    <PreferenceRow title="繁忙时 Enter 键行为" description="仅在智能体运行时生效；Cmd/Ctrl+Enter 使用另一行为">
                      <Select
                        aria-label="繁忙时 Enter 键行为"
                        value={busyEnter}
                        options={ENTER_OPTIONS}
                        disabled={!writable || savingField !== null || !namespace("ui-conversation")}
                        className="bg-muted px-3 py-2 text-foreground"
                        onValueChange={(value) => void mutateField("ui-conversation", ["busyEnter"], value, "ui-conversation")}
                      />
                    </PreferenceRow>
                    {error && <div className="mt-4 text-sm text-destructive" role="alert">{error}</div>}
                  </div>
                ) : activeSection === "models" ? (
                  <ModelsSettingsForms
                    namespaces={modelNamespaces}
                    groups={modelGroups}
                    providers={modelProviders}
                    credentials={credentials}
                    writable={writable}
                    onMutate={mutateNamespace}
                    onCredential={writeCredential}
                    onDiscover={discoverModels}
                    onRemoveProvider={removeProvider}
                    onReload={loadSettings}
                  />
                ) : activeSection === "plugins" ? (
                  <PluginSettingsForms
                    namespaces={pluginNamespaces}
                    writable={writable}
                    onMutate={mutateNamespace}
                  />
                ) : (
                  <div className="space-y-1">
                    <div className="mb-4">
                      <h2 className="text-sm font-medium">Agent 预设</h2>
                      <p className="mt-1 text-xs text-muted-foreground">管理新会话可使用的预设，并选择默认预设。</p>
                    </div>
                    {presets.map((preset) => (
                      <div key={preset.id} className="flex items-center justify-between gap-4 border-b border-border py-4">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 text-sm font-medium">
                            <span className="truncate">{preset.name ?? preset.id}</span>
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">
                              {preset.trust === "system" ? "内置" : "用户"}
                            </span>
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">{preset.description ?? preset.id}</div>
                          {preset.broken && <div className="mt-1 text-xs text-destructive">{preset.broken}</div>}
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant={preset.isDefault ? "secondary" : "outline"}
                          disabled={!writable || Boolean(preset.broken) || savingField !== null}
                          onClick={() => void updateDefaultPreset(preset.id)}
                        >
                          {preset.isDefault ? "默认" : "设为默认"}
                        </Button>
                      </div>
                    ))}
                    {presets.length === 0 && <div className="py-16 text-center text-sm text-muted-foreground">没有可用的 Agent 预设。</div>}
                    {error && <div className="mt-4 text-sm text-destructive" role="alert">{error}</div>}
                  </div>
                )}
              </div>
            </ScrollArea>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default SettingsDialog;
