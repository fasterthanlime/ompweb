"use client";
import { FileInput, FileOutput, FilePenLine, Search, Terminal, Files, Code, Globe, Users, MessagesSquare, ListChecks } from "lucide-react";
import { getFileIcon } from "./FileIcons";
import { SyntaxHighlighter, vs, vscDarkPlus } from "@/lib/syntax-highlight";
import { useTheme } from "@/hooks/useTheme";
import type { ToolCallContent } from "@/lib/types";

export function toolKind(name: string): string {
  const normalized = name.toLowerCase().split(".").at(-1) ?? name;
  if (normalized === "web_search") return normalized;
  return normalized.split("_").at(-1) ?? normalized;
}
export function ToolActionIcon({ name }: { name: string }) {
  const kind = toolKind(name);
  if (kind === "bash") return <span title={name} aria-label={name} style={{ flexShrink: 0, fontFamily: "var(--font-mono)", color: "var(--accent)" }}>$</span>;
  const Icon = kind === "read" ? FileInput : kind === "write" ? FileOutput : kind === "edit" ? FilePenLine : kind === "grep" ? Search : kind === "glob" ? Files : kind === "eval" ? Code : kind === "web_search" ? Globe : kind === "task" ? Users : kind === "hub" ? MessagesSquare : kind === "todo" ? ListChecks : Terminal;
  return <span title={name} aria-label={name} style={{ display: "inline-flex", flexShrink: 0, color: "var(--accent)" }}><Icon size={16} aria-hidden="true" /></span>;
}
export function ToolCommand({ block, expanded = false }: { block: ToolCallContent; expanded?: boolean }) {
  const { isDark } = useTheme();
  const input = block.input ?? {};
  const kind = toolKind(block.toolName);
  const path = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : null;
  const command = typeof input.command === "string" ? input.command : "";
  if (kind === "grep" || kind === "glob") return <span>{String(input.pattern ?? input.path ?? "")} {kind === "grep" && path && <span style={{ color: "var(--text-dim)" }}>in {path}</span>}</span>;
  if (kind === "eval") return <span><span style={{ color: "var(--text-dim)", marginRight: 8 }}>{String(input.language ?? "code")}</span>{String(input.title ?? input.i ?? "Evaluate code")}</span>;
  if (kind === "task") {
    const tasks = Array.isArray(input.tasks) ? input.tasks : [];
    return <span>{String(input.i ?? tasks.map(task => task && typeof task === "object" && "task" in task ? task.task : "").join(" · ") ?? "Agents")}</span>;
  }
  if (kind === "hub") return <span>{String(input.i ?? [input.op, input.to ?? input.name].filter(Boolean).join(" · "))}</span>;
  if (kind === "web_search") return <span>{String(input.query ?? "Web search")}</span>;
  if (kind === "bash" && command) return <SyntaxHighlighter language="bash" style={isDark ? vscDarkPlus : vs} PreTag="span" CodeTag="span" customStyle={{ display: "block", margin: 0, padding: 0, border: 0, boxShadow: "none", outline: "none", background: "transparent", fontSize: "inherit", lineHeight: "inherit", whiteSpace: expanded ? "pre-wrap" : "pre", overflow: "hidden", textOverflow: "ellipsis" }} codeTagProps={{ style: { fontFamily: "var(--font-mono)", border: 0, boxShadow: "none", background: "transparent", padding: 0 } }}>{expanded ? command : command.slice(0, 2000)}</SyntaxHighlighter>;
  if (path) return <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}><span aria-hidden="true" style={{ display: "inline-flex", flexShrink: 0 }}>{getFileIcon(path.replace(/:\d.*$/, ""), 16)}</span><span title={path} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: expanded ? "pre-wrap" : "nowrap" }}>{path}</span></span>;
  const preview = input.query ?? input.pattern ?? input.i ?? input.description ?? Object.values(input)[0] ?? block.toolName;
  return <span>{typeof preview === "string" ? preview : JSON.stringify(preview)}</span>;
}
