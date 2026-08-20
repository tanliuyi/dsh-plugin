"use client";

import { useState } from "react";

import { ToolCall } from "@/components/elements/tool-call";

export interface CommandMessageData {
  commandName?: string | null;
  args?: string | null;
  outcome?: {
    kind?: "success" | "error";
    text?: string;
  } | null;
}

function commandLine(command: CommandMessageData): string {
  const name = command.commandName ?? "command";
  return `/${name}${command.args ?? ""}`;
}

/** Render a slash-command lifecycle with the assistant-ui Elements ToolCall surface. */
export function CommandMessage({ command }: { command: CommandMessageData }) {
  const running = command.outcome == null;
  const failed = command.outcome?.kind === "error";
  const [open, setOpen] = useState(false);

  const result = running
    ? command.commandName === "compact"
      ? "正在压缩…"
      : "执行中…"
    : (command.outcome?.text ?? (failed ? "命令失败" : "已完成"));

  return (
    <div
      data-slot="aui_command"
      data-state={running ? "running" : failed ? "error" : "complete"}
      className="my-4 w-full"
    >
      <ToolCall
        label="已执行"
        activeLabel="执行中"
        query={command.commandName ?? "命令"}
        request={commandLine(command)}
        result={result}
        running={running}
        success={!failed}
        open={open}
        onOpenChange={setOpen}
      />
    </div>
  );
}
