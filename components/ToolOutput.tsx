"use client";
import type { ReactNode } from "react";
import type { ToolCallContent } from "@/lib/types";
import { getLanguage } from "@/lib/file-language";
import { SyntaxHighlightedCode } from "./SyntaxHighlightedCode";
import { getFileIcon } from "./FileIcons";
import { toolKind } from "./ToolCommand";

function FileLabel({ path }: { path: string }) {
  return <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 10px", fontFamily: "var(--font-mono)", fontSize: 12 }}>{getFileIcon(path.replace(/#.*$/, ""), 16)}<span>{path}</span></div>;
}

/** Only recognize explicit output structures; otherwise preserve the original output. */
export function ToolOutput({ block, text, fallback, isError }: { block: ToolCallContent; text: string; fallback: ReactNode; isError: boolean }) {
  const kind = toolKind(block.toolName);
  const input = block.input ?? {};
  const path = String(input.path ?? input.file_path ?? "").replace(/:\d.*$/, "");
  if (kind === "eval") return <><SyntaxHighlightedCode code={String(input.code ?? "")} lang={input.language === "py" ? "python" : input.language === "js" ? "javascript" : String(input.language ?? "text")} />{fallback}</>;
  if (isError) return <>{fallback}</>;
  if (kind === "write" && typeof input.content === "string") return <><SyntaxHighlightedCode code={input.content} lang={getLanguage(path)} />{fallback}</>;
  if (kind === "read" && path && !/\.(png|jpe?g|webp|gif|pdf)$/i.test(path)) return <SyntaxHighlightedCode code={text} lang={getLanguage(path)} showLineNumbers={false} />;
  if (kind === "grep" || kind === "glob") {
    const lines = text.split("\n");
    if (lines.some(line => /^#{1,3} .+/.test(line))) {
      return <div>{lines.map((line, index) => /^#{1,3} .+/.test(line) ? <FileLabel key={index} path={line.replace(/^#+ /, "")} /> : <pre key={index} style={{ margin: 0, padding: "0 12px", whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)", fontSize: 12 }}>{line}</pre>)}</div>;
    }
    if (kind === "grep") {
      const groups = new Map<string, string[]>();
      for (const line of lines.filter(Boolean)) {
        const match = /^(.*?):(\d+):(.*)$/.exec(line);
        if (!match) return <>{fallback}</>;
        const group = groups.get(match[1]) ?? [];
        group.push(`${match[2]}: ${match[3]}`);
        groups.set(match[1], group);
      }
      if (groups.size) return <>{[...groups].map(([file, matches]) => <section key={file}><FileLabel path={file} /><pre style={{ margin: 0, padding: "0 12px 8px", fontFamily: "var(--font-mono)", fontSize: 12, whiteSpace: "pre-wrap" }}>{matches.join("\n")}</pre></section>)}</>;
    }
    if (kind === "glob" && lines.filter(Boolean).every(line => /^(?:[./\w-]+\/)*[\w.-]+\.[\w]+$/.test(line.trim()))) return <>{lines.filter(Boolean).map((file, i) => <FileLabel key={i} path={file.trim()} />)}</>;
  }
  if (kind === "web_search") {
    const parts = text.split(/(https?:\/\/[^\s<>"\]]+)/g);
    return <pre style={{ margin: 0, padding: 12, whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: 13 }}>{parts.map((part, index) => /^https?:\/\//.test(part) ? <a key={index} href={part} target="_blank" rel="noopener noreferrer">{part}</a> : part)}</pre>;
  }
  return <>{fallback}</>;
}
