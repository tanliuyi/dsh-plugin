"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { CheckIcon, ExternalLinkIcon, LoaderCircleIcon, SaveIcon } from "lucide-react";

import { rpc } from "@/dsh/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

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

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Something went wrong.";
}

function namespaceLabel(namespace: SettingsNamespace): string {
  return namespace.ns;
}

function displayError(result: RequestResult): string {
  return result.ok ? "" : result.error?.message ?? "Request failed.";
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
      setNamespaces(nextNamespaces);
      setWritable(result.value.writable);
      setHasDocument(result.value.hasDocument);
      const nextNamespace = nextNamespaces[0];
      setSelectedNamespace((current) => current && nextNamespaces.some((item) => item.ns === current) ? current : nextNamespace?.ns ?? null);
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
        throw new Error("Settings must be a JSON object.");
      }
      if (!selectedNamespace) throw new Error("Select a settings namespace first.");
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
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof SyntaxError ? "Enter valid JSON before saving." : errorMessage(cause));
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
        className="max-h-[min(760px,calc(100vh-2rem))] max-w-2xl overflow-y-auto"
        aria-describedby={descriptionId}
      >
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription id={descriptionId}>
            Review and edit your settings as JSON. Sensitive values are redacted.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex min-h-48 items-center justify-center text-muted-foreground" role="status">
            <LoaderCircleIcon className="mr-2 size-4 animate-spin" aria-hidden="true" />
            Loading settings…
          </div>
        ) : (
          <div className="grid gap-4">
            {namespaces.length > 0 && (
              <section aria-labelledby={`${editorId}-namespaces`} className="grid gap-2">
                <h2 id={`${editorId}-namespaces`} className="text-sm font-medium">Namespaces</h2>
                <div className="flex flex-wrap gap-1.5" role="listbox" aria-label="Settings namespaces">
                  {namespaces.map((namespace) => (
                    <button
                      key={namespace.ns}
                      type="button"
                      role="option"
                      aria-selected={selectedNamespace === namespace.ns}
                      onClick={() => selectNamespace(namespace)}
                      className={selectedNamespace === namespace.ns ? "rounded-md bg-primary px-2.5 py-1.5 text-xs text-primary-foreground" : "rounded-md border px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted"}
                    >
                      {namespaceLabel(namespace)}
                      <span className="ms-1 opacity-60">{namespace.applies}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            <div className="grid gap-2">
              <label htmlFor={editorId} className="text-sm font-medium">Settings JSON</label>
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
                className="min-h-72 resize-y font-mono text-sm leading-6"
              />
              <p className="text-xs text-muted-foreground">Secret values appear redacted and are preserved until explicitly changed.</p>
              {error && <p id={`${editorId}-error`} className="text-sm text-destructive" role="alert">{error}</p>}
              {saved && (
                <p className="flex items-center gap-1 text-sm text-emerald-600" role="status">
                  <CheckIcon className="size-4" aria-hidden="true" /> Settings saved.
                </p>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          {hasDocument && (
            <Button type="button" variant="outline" onClick={openDocument} disabled={loading || saving || openingDocument}>
              {openingDocument ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : <ExternalLinkIcon aria-hidden="true" />}
              Open document
            </Button>
          )}
          <Button type="button" onClick={saveSettings} disabled={!writable || loading || saving || openingDocument}>
            {saving ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : <SaveIcon aria-hidden="true" />}
            {saving ? "Saving…" : "Save settings"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default SettingsDialog;
