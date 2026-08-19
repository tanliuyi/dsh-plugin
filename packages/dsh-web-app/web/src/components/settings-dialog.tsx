"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import {
  BotIcon,
  CheckIcon,
  ExternalLinkIcon,
  FileCogIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  PuzzleIcon,
  SaveIcon,
  Settings2Icon,
  ShieldCheckIcon,
  SquareTerminalIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";

import { rpc } from "@/dsh/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export type SettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type SettingsNamespace = {
  ns: string;
  value: unknown;
  applies: "live" | "restart";
  secrets: { path: string[]; set: boolean }[];
  revision: number;
};

type SettingsDescription = {
  writable: boolean;
  namespaces: SettingsNamespace[];
  hasDocument: boolean;
};

type RequestResult = { ok: true; value: unknown } | { ok: false; error?: { message?: string } };

type NamespacePresentation = {
  label: string;
  description: string;
  Icon: LucideIcon;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "操作失败。";
}

function displayError(result: RequestResult): string {
  return result.ok ? "" : result.error?.message ?? "请求失败。";
}

function namespacePresentation(namespace: string): NamespacePresentation {
  const normalized = namespace.toLowerCase();
  if (normalized.includes("model")) {
    return { label: "模型", description: "配置模型提供商、模型参数及默认模型。", Icon: BotIcon };
  }
  if (normalized.includes("plugin")) {
    return { label: "插件", description: "管理插件运行时使用的配置。", Icon: PuzzleIcon };
  }
  if (normalized.includes("permission") || normalized.includes("sandbox") || normalized.includes("security")) {
    return { label: "权限", description: "设置工具执行与沙箱访问策略。", Icon: ShieldCheckIcon };
  }
  if (normalized.includes("credential") || normalized.includes("secret") || normalized.includes("key")) {
    return { label: "凭据", description: "管理服务连接所需的凭据配置。", Icon: KeyRoundIcon };
  }
  if (normalized.includes("shell") || normalized.includes("bash") || normalized.includes("pwsh") || normalized.includes("terminal")) {
    return { label: "终端", description: "配置终端与命令执行行为。", Icon: SquareTerminalIcon };
  }
  if (normalized === "general" || normalized.includes("core") || normalized.includes("app")) {
    return { label: "常规", description: "管理应用的通用行为与偏好。", Icon: Settings2Icon };
  }
  return { label: namespace, description: `编辑 ${namespace} 命名空间。`, Icon: FileCogIcon };
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const descriptionId = useId();
  const editorId = useId();
  const [namespaces, setNamespaces] = useState<SettingsNamespace[]>([]);
  const [selectedNamespace, setSelectedNamespace] = useState<string | null>(null);
  const [writable, setWritable] = useState(false);
  const [hasDocument, setHasDocument] = useState(false);
  const [text, setText] = useState("{}");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [openingDocument, setOpeningDocument] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const activeNamespace = useMemo(
    () => namespaces.find((item) => item.ns === selectedNamespace) ?? null,
    [namespaces, selectedNamespace],
  );
  const activePresentation = activeNamespace
    ? namespacePresentation(activeNamespace.ns)
    : { label: "设置", description: "管理应用配置。", Icon: Settings2Icon };

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      const result = await rpc<SettingsDescription>("settings.describe");
      if (!result.ok) {
        setError(displayError(result));
        return;
      }
      const nextNamespaces = result.value.namespaces ?? [];
      const nextNamespace = nextNamespaces[0] ?? null;
      setNamespaces(nextNamespaces);
      setWritable(result.value.writable);
      setHasDocument(result.value.hasDocument);
      setSelectedNamespace(nextNamespace?.ns ?? null);
      setText(JSON.stringify(nextNamespace?.value ?? {}, null, 2));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void loadSettings();
  }, [loadSettings, open]);

  const selectNamespace = (namespace: SettingsNamespace) => {
    setSelectedNamespace(namespace.ns);
    setText(JSON.stringify(namespace.value ?? {}, null, 2));
    setError(null);
    setSaved(false);
  };

  const saveSettings = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const value: unknown = JSON.parse(text);
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("设置内容必须是 JSON 对象。");
      }
      if (!selectedNamespace) throw new Error("请先选择一个设置分类。");
      const namespace = namespaces.find((item) => item.ns === selectedNamespace);
      const result = await rpc("settings.update", {
        ns: selectedNamespace,
        patch: value,
        ...(namespace ? { expectedRevision: namespace.revision } : {}),
      });
      if (!result.ok) {
        setError(displayError(result));
        return;
      }
      setNamespaces((current) => current.map((item) => (
        item.ns === selectedNamespace ? { ...item, value } : item
      )));
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof SyntaxError ? "保存前请输入有效的 JSON。" : errorMessage(cause));
    } finally {
      setSaving(false);
    }
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="h-[min(800px,calc(100dvh-2rem))] w-[min(800px,calc(100vw-2rem))] max-w-none gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-none"
        aria-describedby={descriptionId}
      >
        <div className="flex h-full min-h-0 flex-col sm:flex-row">
          <div className="flex shrink-0 flex-col gap-3 border-b bg-muted/25 px-3 py-4 sm:w-[188px] sm:gap-[18px] sm:border-r sm:border-b-0 sm:pt-[22px]">
            <DialogTitle className="px-3 text-base leading-6">设置</DialogTitle>
            <ScrollArea className="min-h-0 sm:flex-1">
              <div className="flex w-max gap-1 pb-1 sm:w-full sm:flex-col sm:pb-0" role="navigation" aria-label="设置分类">
                {namespaces.map((namespace) => {
                  const presentation = namespacePresentation(namespace.ns);
                  const selected = selectedNamespace === namespace.ns;
                  return (
                    <Button
                      key={namespace.ns}
                      type="button"
                      variant="ghost"
                      aria-current={selected ? "page" : undefined}
                      className={cn(
                        "h-10 min-w-36 justify-start gap-2 rounded-xl px-3 font-normal sm:min-w-0 sm:w-full",
                        selected && "bg-muted text-foreground hover:bg-muted",
                      )}
                      onClick={() => selectNamespace(namespace)}
                    >
                      <presentation.Icon className="size-4" aria-hidden="true" />
                      {presentation.label}
                    </Button>
                  );
                })}
              </div>
            </ScrollArea>
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex h-[54px] shrink-0 items-center gap-2 px-4">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{activePresentation.label}</div>
                <DialogDescription id={descriptionId} className="truncate text-xs">
                  {activePresentation.description}
                </DialogDescription>
              </div>
              {hasDocument && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={openDocument}
                  disabled={loading || saving || openingDocument}
                >
                  {openingDocument ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : <ExternalLinkIcon aria-hidden="true" />}
                  <span className="hidden md:inline">打开配置文件</span>
                </Button>
              )}
              <DialogClose asChild>
                <Button type="button" variant="ghost" size="icon-sm" aria-label="关闭设置">
                  <XIcon aria-hidden="true" />
                </Button>
              </DialogClose>
            </div>

            <ScrollArea className="min-h-0 flex-1">
              <div className="flex min-h-full flex-col px-6 pb-6">
                {loading ? (
                  <div className="flex min-h-48 flex-1 items-center justify-center text-muted-foreground" role="status">
                    <LoaderCircleIcon className="mr-2 size-4 animate-spin" aria-hidden="true" />
                    正在加载设置
                  </div>
                ) : activeNamespace ? (
                  <div className="flex min-h-full flex-1 flex-col gap-3">
                    <div className="flex items-center justify-between gap-3 border-b pb-4">
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{activeNamespace.ns}</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {activeNamespace.applies === "restart" ? "保存后重启生效" : "保存后立即生效"}
                        </div>
                      </div>
                      <div className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                        revision {activeNamespace.revision}
                      </div>
                    </div>

                    <Label htmlFor={editorId}>配置 JSON</Label>
                    <Textarea
                      id={editorId}
                      value={text}
                      onChange={(event) => {
                        setText(event.target.value);
                        setSaved(false);
                        setError(null);
                      }}
                      disabled={saving}
                      aria-invalid={Boolean(error)}
                      aria-describedby={error ? `${editorId}-error` : undefined}
                      spellCheck={false}
                      className="min-h-80 flex-1 resize-none font-mono text-sm leading-6"
                    />
                    <div className="text-xs text-muted-foreground">
                      敏感值会以脱敏形式显示，未显式修改时将保持原值。
                    </div>
                    {error && (
                      <div id={`${editorId}-error`} className="text-sm text-destructive" role="alert">
                        {error}
                      </div>
                    )}
                    {saved && (
                      <div className="flex items-center gap-1 text-sm text-emerald-600" role="status">
                        <CheckIcon className="size-4" aria-hidden="true" />
                        设置已保存
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex min-h-48 flex-1 items-center justify-center text-sm text-muted-foreground">
                    当前没有可用的设置分类
                  </div>
                )}
              </div>
            </ScrollArea>

            <div className="flex min-h-14 shrink-0 items-center justify-end border-t bg-muted/20 px-6 py-3">
              <Button
                type="button"
                onClick={saveSettings}
                disabled={!activeNamespace || !writable || loading || saving || openingDocument}
              >
                {saving ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : <SaveIcon aria-hidden="true" />}
                {saving ? "正在保存" : "保存设置"}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default SettingsDialog;
