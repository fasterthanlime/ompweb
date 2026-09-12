"use client";

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback, useDeferredValue, type CSSProperties, type ReactNode, type RefObject } from "react";
import type { SessionInfo } from "@/lib/types";
import type { RemoteTargetSummary, RemoteThreadSummary } from "./RemoteWorkspaceList";
import { useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import { FileExplorer, type FileExplorerHandle } from "./FileExplorer";
import { Tooltip } from "./ui/primitives";
import { toast } from "./ui/toast";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { clearLastOpenSession, setLastOpenSession, workspaceKeyOf } from "@/lib/workspace-memory";
import { Archive, Check, FileUp, MoreHorizontal, Monitor, Plus, RefreshCw, Search, Settings2, SlidersHorizontal, Upload } from "lucide-react";
import { publishRunningSessionIds } from "@/lib/session-change-bus";
import { HostMark, ThreadExpressionMeta } from "./ThreadList";
const REMOTE_THREAD_RENAMED_EVENT = "nook:remote-thread-renamed";
const UNREAD_SESSIONS_STORAGE_KEY = "omp-web:unread-session-ids";
const NEW_HOST_STORAGE_KEY = "omp-web:new-thread-host";
const INITIAL_RESTORE_RETRY_MS = 1000;
const INITIAL_RESTORE_MAX_ATTEMPTS = 8;
const SIDEBAR_BUTTON_TRANSITION = "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm), border-color var(--dur-fast) var(--ease-out-warm)";

interface Props {
  /** Flat remote thread rows. */
  remoteWorkspaces?: ReactNode;
  remoteThreads?: RemoteThreadSummary[];
  remoteTargets?: RemoteTargetSummary[];
  selectedRemoteSessionId?: string | null;
  onSelectRemoteSession?: (targetId: string, sessionId: string) => void;
  onNewRemoteSession?: (targetId: string) => void;
  onRemoteThreadRenamed?: (sessionId: string) => void;
  remoteActive?: boolean;
  hostPlatform?: string;
  selectedSessionId: string | null;
  optimisticSession?: SessionInfo | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean) => void;
  onNewSession?: (sessionId: string, cwd: string) => void;
  initialSessionId?: string | null;
  skipInitialProjectSelection?: boolean;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
  selectedCwd?: string | null;
  onCwdChange?: (cwd: string | null, projectRoot?: string | null) => void;
  onOpenFile?: (filePath: string, fileName: string) => void;
  explorerRefreshKey?: number;
  onExplorerRefresh?: () => void;
  explorerRefreshing?: boolean;
  onExplorerRefreshDone?: () => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
  onOpenSettings?: () => void;
  updateAvailable?: boolean;
  onOpenArchive?: () => void;
}

function loadUnreadSessionIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(UNREAD_SESSIONS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    return Array.isArray(parsed) ? new Set(parsed.filter((id): id is string => typeof id === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function saveUnreadSessionIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (ids.size) window.localStorage.setItem(UNREAD_SESSIONS_STORAGE_KEY, JSON.stringify([...ids]));
    else window.localStorage.removeItem(UNREAD_SESSIONS_STORAGE_KEY);
  } catch {
    // Storage is optional.
  }
}

function loadNewHost(): "local" | "remote" {
  if (typeof window === "undefined") return "local";
  try {
    return window.localStorage.getItem(NEW_HOST_STORAGE_KEY) === "remote" ? "remote" : "local";
  } catch {
    return "local";
  }
}

function saveNewHost(host: "local" | "remote"): void {
  try { window.localStorage.setItem(NEW_HOST_STORAGE_KEY, host); } catch { /* optional */ }
}

function displayCwd(cwd: string, homeDir?: string): string {
  return homeDir && cwd.startsWith(homeDir) ? "~" + cwd.slice(homeDir.length) : cwd;
}

function formatRelativeTime(value: string, _locale: string, now: number): string | null {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}


function OmpWebTitle() {
  return <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}><span aria-hidden="true" style={{ width: 18, height: 18, borderLeft: "3px solid var(--accent)", borderBottom: "3px solid var(--accent)", borderRadius: "2px 0 0 6px", position: "relative", display: "inline-block" }}><span style={{ position: "absolute", width: 5, height: 5, borderRadius: "50%", background: "var(--accent)", left: 5, bottom: 5 }} /></span><span style={{ color: "var(--text)", fontWeight: 600, fontSize: 20, letterSpacing: "-0.045em" }}>nook</span></div>;
}

function SidebarIconButton({ label, title, onClick, active = false, disabled = false, children }: { label: string; title?: string; onClick: () => void; active?: boolean; disabled?: boolean; children: ReactNode }) {
  const [hovered, setHovered] = useState(false);
  return <button type="button" aria-label={label} title={title ?? label} onClick={onClick} disabled={disabled} aria-pressed={active} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, flexShrink: 0, lineHeight: 0, background: active || hovered ? "var(--bg-hover)" : "none", border: "none", borderRadius: "var(--radius-control)", color: active || hovered ? "var(--accent)" : "var(--text-dim)", cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1, transition: SIDEBAR_BUTTON_TRANSITION }} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>{children}</button>;
}

const MENU_MARGIN = 5;
const MENU_VIEWPORT_PAD = 8;
function SidebarPortalMenu({ anchor, open, onClose, placement = "above", minWidth = 128, children }: { anchor: RefObject<HTMLElement | null>; open: boolean; onClose: () => void; placement?: "below" | "above"; minWidth?: number; children: ReactNode }) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const update = useCallback(() => {
    const element = anchorRef.current.current;
    const menu = menuRef.current;
    if (!element || !menu) return;
    const rect = element.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    let top = placement === "above" ? rect.top - height - MENU_MARGIN : rect.bottom + MENU_MARGIN;
    if (top < MENU_VIEWPORT_PAD) top = Math.min(rect.bottom + MENU_MARGIN, window.innerHeight - height - MENU_VIEWPORT_PAD);
    if (top + height > window.innerHeight - MENU_VIEWPORT_PAD) top = rect.top - height - MENU_MARGIN;
    top = Math.max(MENU_VIEWPORT_PAD, top);
    const left = Math.max(MENU_VIEWPORT_PAD, Math.min(rect.right - width, window.innerWidth - width - MENU_VIEWPORT_PAD));
    setPos({ top, left });
  }, [placement]);
  useLayoutEffect(() => { if (open) update(); }, [open, update]);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent | TouchEvent) => { const target = event.target as Node; if (!anchor.current?.contains(target) && !menuRef.current?.contains(target)) onClose(); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); event.preventDefault(); onClose(); anchor.current?.focus(); } };
    window.addEventListener("resize", update); window.addEventListener("scroll", update, true);
    document.addEventListener("mousedown", onPointer); document.addEventListener("touchstart", onPointer); document.addEventListener("keydown", onKey);
    const first = window.setTimeout(() => menuRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus(), 0);
    return () => { window.clearTimeout(first); window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); document.removeEventListener("mousedown", onPointer); document.removeEventListener("touchstart", onPointer); document.removeEventListener("keydown", onKey); };
  }, [open, onClose, update, anchor]);
  if (!open || typeof document === "undefined") return null;
  return <div ref={menuRef} role="menu" onClick={event => event.stopPropagation()} style={{ position: "fixed", top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? "visible" : "hidden", zIndex: 1000, minWidth, padding: 4, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", boxShadow: "var(--shadow-pop)" }}>{children}</div>;
}

function RunningSessionIndicator({ size = 12 }: { size?: number }) {
  const { t } = useI18n();
  const reducedMotion = usePrefersReducedMotion();
  return <span title={t("sessionSidebar.agentRunning")} aria-label={t("sessionSidebar.agentRunningAria")} style={{ display: "inline-flex", width: size, height: size, alignItems: "center", justifyContent: "center", color: "var(--accent)", flexShrink: 0 }}><span className="sidebar-running-spinner" data-reduced-motion={reducedMotion ? "true" : "false"} style={{ width: size - 2, height: size - 2 }} /></span>;
}

function UnreadSessionIndicator({ size = 11 }: { size?: number }) {
  const { t } = useI18n();
  return <span title={t("sessionSidebar.newActivity")} aria-label={t("sessionSidebar.newSessionActivity")} style={{ width: size, height: size, borderRadius: "50%", background: "var(--accent)", display: "inline-block", flexShrink: 0 }} />;
}

interface ThreadRowBaseProps {
  isSelected: boolean;
  isRunning: boolean;
  runningSince?: number | null;
  isUnread: boolean;
  relativeTimeNow: number;
  homeDir: string;
  hostPlatform?: string;
  onClick: () => void;
  onRenamed?: () => void;
  onRemoteThreadRenamed?: (id: string) => void;
  onDeleted?: (id: string) => void;
}

type ThreadRowProps = ThreadRowBaseProps & (
  | { host: "local"; session: SessionInfo; thread?: never }
  | { host: "remote"; thread: RemoteThreadSummary; session?: never }
);

const ThreadRow = memo(function ThreadRow({ host, session, thread, isSelected, isRunning, runningSince, isUnread, relativeTimeNow, homeDir, hostPlatform, onClick, onRenamed, onDeleted, onRemoteThreadRenamed }: ThreadRowProps) {
  const { t, locale } = useI18n();
  const [touchActions, setTouchActions] = useState(false);
  useEffect(() => { setTouchActions(window.matchMedia("(pointer: coarse)").matches); }, []);
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const renameFinishedRef = useRef(false);
  const isRemote = host === "remote";
  const id = session?.id ?? thread?.id ?? "";
  const currentName = session?.name ?? thread?.name ?? "";
  const title = session
    ? session.name || session.firstMessage.slice(0, 50) || session.id.slice(0, 12)
    : thread?.name || thread?.id.slice(0, 12) || id.slice(0, 12);
  const modified = session?.modified ?? thread?.modified ?? "";
  const relativeTime = formatRelativeTime(modified, locale, relativeTimeNow);
  const connected = thread?.connected ?? true;
  const targetTooltip = thread ? [thread.target.name, thread.target.hostname ?? thread.target.id, thread.cwd].filter(Boolean).join(" · ") : "";
  const tooltip = session
    ? `${displayCwd(session.cwd, homeDir)}${session.worktreeBranch ? ` · ${session.worktreeBranch}` : ""}`
    : targetTooltip;
  const showActions = touchActions || hovered || focusWithin || actionMenuOpen;
  const confirming = confirmDelete || confirmArchive;
  const closeMenu = useCallback(() => setActionMenuOpen(false), []);
  const startRename = useCallback(() => {
    renameFinishedRef.current = false;
    setRenameValue(currentName);
    setRenaming(true);
    setActionMenuOpen(false);
    window.setTimeout(() => inputRef.current?.select(), 0);
  }, [currentName]);
  const cancelRename = useCallback(() => {
    renameFinishedRef.current = true;
    setRenaming(false);
  }, []);
  const commitRename = useCallback(async () => {
    if (renameFinishedRef.current) return;
    renameFinishedRef.current = true;
    const name = renameValue.trim();
    setRenaming(false);
    if (name === currentName || (isRemote && !name)) return;
    try {
      const response = await fetch(isRemote ? `/api/remote/${encodeURIComponent(id)}` : `/api/sessions/${encodeURIComponent(id)}`, {
        method: isRemote ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isRemote ? { type: "set_session_name", name } : { name }),
      });
      if (!response.ok) throw new Error("Session rename failed");
      if (isRemote) {
        window.dispatchEvent(new CustomEvent(REMOTE_THREAD_RENAMED_EVENT, { detail: { id, targetId: thread?.targetId, name } }));
        onRemoteThreadRenamed?.(id);
      } else {
        onRenamed?.();
      }
    } catch {
      toast.error(t("sessionSidebar.deleteFailed"));
    }
  }, [currentName, id, isRemote, onRemoteThreadRenamed, onRenamed, renameValue, t, thread?.targetId]);
  const beginDelete = useCallback((archive: boolean) => {
    setActionMenuOpen(false);
    if (archive) setConfirmArchive(true);
    else setConfirmDelete(true);
  }, []);
  const finishDelete = useCallback(async (archive: boolean) => {
    setConfirmDelete(false); setConfirmArchive(false); setDeleting(true);
    try {
      const response = await fetch(isRemote ? `/api/remote/${encodeURIComponent(id)}` : archive ? `/api/sessions/${encodeURIComponent(id)}/archive` : `/api/sessions/${encodeURIComponent(id)}`, { method: archive ? "POST" : "DELETE", ...(isRemote ? {headers:{"Content-Type":"application/json"},body:JSON.stringify({type:"archive"})} : {}) });
      if (!response.ok) throw new Error(archive ? "Session archive failed" : "Session deletion failed");
      if (isRemote) { onRemoteThreadRenamed?.(id); window.dispatchEvent(new CustomEvent("nook:remote-thread-archived",{detail:{id}})); } else onDeleted?.(id);
    } catch {
      setDeleting(false);
      toast.error(archive ? t("sessionSidebar.archiveFailed") : t("sessionSidebar.deleteFailed"));
    }
  }, [id, onDeleted, t, isRemote, onRemoteThreadRenamed]);
  const remoteUnsupportedTitle = "Unavailable for remote sessions";
  return <div onClick={confirming || renaming ? undefined : onClick} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onFocus={() => setFocusWithin(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusWithin(false); }} style={{ minHeight: 34, display: "flex", alignItems: "center", gap: 7, width: "100%", margin: "1px 0", padding: "0 8px", boxSizing: "border-box", position: "relative", overflow: "hidden", borderRadius: "var(--radius-control)", background: confirming ? "color-mix(in srgb, var(--accent) 7%, transparent)" : isSelected ? "color-mix(in srgb, var(--bg-selected) 70%, transparent)" : hovered ? "var(--bg-hover)" : "transparent", opacity: deleting ? 0.5 : 1, cursor: confirming || renaming ? "default" : "pointer", transition: "background var(--dur-fast) var(--ease-out-warm), opacity var(--dur-fast) var(--ease-out-warm)" }}>
    {(isSelected || confirming) && <span aria-hidden="true" style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 2, borderRadius: 1, background: "var(--accent)" }} />}
    {confirming ? <><span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11.5 }}>{confirmArchive ? t("sessionSidebar.archiveConfirm", { title }) : t("sessionSidebar.deleteConfirm", { title })}</span><button type="button" onClick={(event) => { event.stopPropagation(); void finishDelete(confirmArchive); }} style={{ height: 27, padding: "0 9px", border: 0, borderRadius: "var(--radius-control)", background: "var(--accent-strong)", color: "var(--on-accent)", fontSize: 11, fontWeight: 600 }}>{confirmArchive ? t("sessionSidebar.archive") : t("sessionSidebar.delete")}</button><button type="button" onClick={(event) => { event.stopPropagation(); setConfirmDelete(false); setConfirmArchive(false); }} style={{ height: 27, padding: "0 9px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text-muted)", fontSize: 11 }}>{t("sessionSidebar.cancel")}</button></> : renaming ? <input ref={inputRef} autoFocus aria-label={t("sessionSidebar.rename")} value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onBlur={() => void commitRename()} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void commitRename(); } if (event.key === "Escape") { event.preventDefault(); cancelRename(); } }} style={{ flex: 1, minWidth: 0, height: 25, padding: "3px 7px", border: "1px solid var(--accent)", borderRadius: "var(--radius-control)", outline: "none", background: "var(--bg)", color: "var(--text)", fontSize: 12 }} /> : <>
      <HostMark host={host} platform={session ? hostPlatform : thread?.target.platform} />
      <button type="button" className="session-item-button" aria-current={isSelected ? "true" : undefined} onClick={(event) => { event.stopPropagation(); onClick(); }} title={tooltip} style={{ display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "flex-start", gap: 1, flex: 1, minWidth: 0, border: 0, background: "none", color: "var(--text)", textAlign: "left", padding: 0, cursor: "pointer" }}>
        <span style={{ display: "block", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5, fontWeight: isSelected ? 600 : 500 }}>{title}</span>
        <ThreadExpressionMeta id={id} />
      </button>
      <div style={{ display: "flex", alignItems: "center", gap: 3, flexShrink: 0 }}>
        <div style={{ minWidth: 47, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 4, marginRight: showActions ? 26 : 0, opacity: 1, transition: "opacity var(--dur-fast) var(--ease-out-warm)" }}>{isRunning ? <RunningSessionIndicator /> : isUnread ? <UnreadSessionIndicator /> : null}{isRemote && <span title={connected ? "Connected" : "Disconnected"} aria-label={connected ? "Connected" : "Disconnected"} style={{ width: 7, height: 7, borderRadius: "50%", background: connected ? "var(--accent)" : "var(--text-dim)", display: "inline-block" }} />}{(isRunning || relativeTime) && <span style={{ color: isSelected ? "var(--accent)" : "var(--text-dim)", fontSize: 10, fontVariantNumeric: "tabular-nums" }}>{isRunning ? runningSince ? `${Math.max(0, Math.floor((relativeTimeNow - runningSince) / 60000))}m active` : "Active" : relativeTime}</span>}</div>
        <div style={{ position: "absolute", right: 5, display: "flex", alignItems: "center", opacity: showActions ? 1 : 0, pointerEvents: showActions ? "auto" : "none", transition: "opacity var(--dur-fast) var(--ease-out-warm)" }}><button type="button" ref={menuButtonRef} onClick={(event) => { event.stopPropagation(); setActionMenuOpen((open) => !open); }} aria-label={t("projects.actions")} title={t("projects.actions")} aria-expanded={actionMenuOpen} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, border: 0, borderRadius: "var(--radius-control)", background: actionMenuOpen ? "var(--bg-selected)" : "transparent", color: "var(--text-dim)", cursor: "pointer" }}><MoreHorizontal size={14} strokeWidth={2} aria-hidden="true" /></button><SidebarPortalMenu anchor={menuButtonRef} open={actionMenuOpen} onClose={closeMenu}><button type="button" role="menuitem" onClick={() => beginDelete(true)} style={menuItemStyle}>{t("sessionSidebar.archive")}</button><button type="button" role="menuitem" onClick={startRename} style={menuItemStyle}>{t("sessionSidebar.rename")}</button><button type="button" role="menuitem" disabled={isRemote} title={isRemote ? `Delete: ${remoteUnsupportedTitle}` : undefined} aria-label={isRemote ? `Delete: ${remoteUnsupportedTitle}` : t("sessionSidebar.delete")} onClick={() => beginDelete(false)} style={{ ...menuItemStyle, color: isRemote ? "var(--text-dim)" : "var(--status-error)", cursor: isRemote ? "not-allowed" : "pointer", opacity: isRemote ? 0.65 : 1 }}>{t("sessionSidebar.delete")}{isRemote && <span style={{ display: "block", fontSize: 9, marginTop: 2, color: "var(--text-dim)" }}>({remoteUnsupportedTitle})</span>}</button></SidebarPortalMenu></div>
      </div>
    </>}
  </div>;
}, (previous, next) => previous.host === next.host && previous.session === next.session && previous.thread === next.thread && previous.isSelected === next.isSelected && previous.isRunning === next.isRunning && previous.runningSince === next.runningSince && previous.isUnread === next.isUnread && previous.relativeTimeNow === next.relativeTimeNow && previous.homeDir === next.homeDir && previous.hostPlatform === next.hostPlatform && previous.onClick === next.onClick && previous.onRenamed === next.onRenamed && previous.onDeleted === next.onDeleted && previous.onRemoteThreadRenamed === next.onRemoteThreadRenamed);

const menuItemStyle: CSSProperties = { display: "block", width: "100%", padding: "6px 9px", border: "none", borderRadius: 6, background: "transparent", color: "var(--text-muted)", cursor: "pointer", textAlign: "left", fontSize: 11 };

export function SessionSidebar({ selectedRemoteSessionId, remoteWorkspaces, remoteThreads = [], remoteTargets = [], onSelectRemoteSession, onNewRemoteSession, onRemoteThreadRenamed, remoteActive, hostPlatform, selectedSessionId, optimisticSession, onSelectSession, onNewSession, initialSessionId, skipInitialProjectSelection, onInitialRestoreDone, refreshKey, onSessionDeleted, selectedCwd: selectedCwdProp, onCwdChange, onOpenFile, explorerRefreshKey, onExplorerRefresh, explorerRefreshing, onExplorerRefreshDone, onAtMention, onAtMentions, onOpenSettings, onOpenArchive, updateAvailable }: Props) {
  const { t } = useI18n();
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState("");
  const [serverHostPlatform, setServerHostPlatform] = useState<string | undefined>(hostPlatform);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [explorerKey, setExplorerKey] = useState(0);
  const [explorerUploadBusy, setExplorerUploadBusy] = useState(false);
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  const [runningSince, setRunningSince] = useState<Record<string, number | null>>({});
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => loadUnreadSessionIds());
  const [relativeTimeNow, setRelativeTimeNow] = useState(() => Date.now());
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [runningOnly, setRunningOnly] = useState(false);
  const [newHost, setNewHost] = useState<"local" | "remote">(() => loadNewHost());
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [newLocalBusy, setNewLocalBusy] = useState(false);
  const initialLoadDone = useRef(false);
  const restoredRef = useRef(false);
  const restoreRetryRef = useRef(0);
  const restoreRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastNotifiedCwdRef = useRef<string | null>(null);
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  const sseAuthoritativeRef = useRef(false);
  const pendingRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionsAbortRef = useRef<AbortController | null>(null);
  const sessionsEtagRef = useRef<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const fileExplorerRef = useRef<FileExplorerHandle>(null);

  const loadSessions = useCallback(async (showLoading = false) => {
    sessionsAbortRef.current?.abort();
    const controller = new AbortController();
    sessionsAbortRef.current = controller;
    try {
      if (showLoading) setLoading(true);
      const headers: Record<string, string> = {};
      if (sessionsEtagRef.current) headers["If-None-Match"] = sessionsEtagRef.current;
      const response = await fetch("/api/sessions", { headers, signal: controller.signal });
      if (response.status === 304) return;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const etag = response.headers.get("ETag");
      if (etag) sessionsEtagRef.current = etag;
      const data = await response.json() as { sessions?: SessionInfo[]; runningSessionIds?: string[] };
      setAllSessions(data.sessions ?? []);
      if (!sseAuthoritativeRef.current) setRunningSessionIds(new Set(data.runningSessionIds ?? []));
      const existing = new Set((data.sessions ?? []).map((session) => session.id));
      setUnreadSessionIds((previous) => { const next = new Set([...previous].filter((id) => existing.has(id))); return next.size === previous.size ? previous : next; });
      setError(null);
      if (!showLoading) { setSessionRefreshDone(true); if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current); sessionRefreshTimerRef.current = setTimeout(() => setSessionRefreshDone(false), 2000); }
    } catch (cause) {
      if ((cause as Error)?.name !== "AbortError") setError(t("sessionSidebar.loadFailed", { detail: cause instanceof Error ? cause.message : String(cause) }));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [t]);

  useEffect(() => { const first = !initialLoadDone.current; initialLoadDone.current = true; void loadSessions(first); }, [loadSessions, refreshKey]);
  useEffect(() => { const interval = setInterval(() => setRelativeTimeNow(Date.now()), 60_000); return () => clearInterval(interval); }, []);
  useEffect(() => { saveUnreadSessionIds(unreadSessionIds); }, [unreadSessionIds]);
  useEffect(() => { if (explorerRefreshKey !== undefined) setExplorerKey((key) => key + 1); }, [explorerRefreshKey]);
  useEffect(() => { fetch("/api/home").then((response) => response.json()).then((data: { home?: string; platform?: string }) => { if (data.home) setHomeDir(data.home); if (data.platform) setServerHostPlatform(data.platform); }).catch(() => {}); }, []);
  useEffect(() => () => { if (restoreRetryTimerRef.current) clearTimeout(restoreRetryTimerRef.current); if (pendingRefreshRef.current) clearTimeout(pendingRefreshRef.current); if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current); sessionsAbortRef.current?.abort(); }, []);

  const scheduleRefresh = useCallback(() => {
    if (pendingRefreshRef.current) return;
    pendingRefreshRef.current = setTimeout(() => { pendingRefreshRef.current = null; void loadSessions(false); }, 300);
  }, [loadSessions]);
  useEffect(() => {
    const source = new EventSource("/api/agent/running/events");
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { type?: string; runningSessionIds?: string[]; runningSince?: Record<string, number | null>; refreshSessionList?: boolean; sessionIds?: string[] };
        if (data.type === "running") { setRunningSince(data.runningSince ?? {}); sseAuthoritativeRef.current = true; setRunningSessionIds(new Set(data.runningSessionIds ?? [])); publishRunningSessionIds(data.runningSessionIds ?? []); if (data.refreshSessionList) scheduleRefresh(); }
      } catch { /* ignore malformed frames */ }
    };
    return () => source.close();
  }, [scheduleRefresh]);
  useEffect(() => {
    const previous = previousRunningSessionIdsRef.current;
    const completed = [...previous].filter((id) => !runningSessionIds.has(id) && id !== selectedSessionId);
    const newlyRunning = [...runningSessionIds].filter((id) => !previous.has(id));
    if (completed.length || newlyRunning.length) {
      setUnreadSessionIds((current) => { const next = new Set(current); newlyRunning.forEach((id) => next.delete(id)); completed.forEach((id) => next.add(id)); return next; });
      void loadSessions(false);
    }
    previousRunningSessionIdsRef.current = runningSessionIds;
  }, [runningSessionIds, selectedSessionId, loadSessions]);
  useEffect(() => {
    if (!selectedSessionId) return;
    setUnreadSessionIds((current) => { if (!current.has(selectedSessionId)) return current; const next = new Set(current); next.delete(selectedSessionId); return next; });
  }, [selectedSessionId]);

  const visibleSessions = useMemo(() => {
    let sessions = allSessions;
    if (optimisticSession && !sessions.some((session) => session.id === optimisticSession.id)) sessions = [...sessions, optimisticSession];
    return sessions;
  }, [allSessions, optimisticSession]);
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const filteredSessions = useMemo(() => {
    const query = deferredSearchQuery.trim().toLowerCase();
    return [...visibleSessions]
      .filter((session) => !runningOnly || runningSessionIds.has(session.id))
      .filter((session) => !query || [session.name, session.firstMessage, session.cwd].some((value) => value?.toLowerCase().includes(query)))
      .sort((left, right) => right.modified.localeCompare(left.modified));
  }, [visibleSessions, deferredSearchQuery, runningOnly, runningSessionIds]);

  const projectRootFor = useCallback((cwd: string | null): string | null => {
    if (!cwd) return null;
    const session = allSessions.find((item) => item.cwd === cwd);
    return session?.projectRoot ?? cwd;
  }, [allSessions]);
  useEffect(() => {
    if (lastNotifiedCwdRef.current === selectedCwd) return;
    lastNotifiedCwdRef.current = selectedCwd;
    onCwdChange?.(selectedCwd, projectRootFor(selectedCwd));
  }, [selectedCwd, onCwdChange, projectRootFor]);
  useEffect(() => {
    if (!selectedCwdProp || selectedCwdProp === selectedCwd) return;
    setSelectedCwd(selectedCwdProp);
  }, [selectedCwdProp, selectedCwd]);

  useEffect(() => {
    if (skipInitialProjectSelection) return;
    if (initialSessionId && !restoredRef.current) {
      const target = visibleSessions.find((session) => session.id === initialSessionId);
      if (target) { restoredRef.current = true; setSelectedCwd(target.cwd); onSelectSession(target, true); return; }
      if (restoreRetryRef.current < INITIAL_RESTORE_MAX_ATTEMPTS) {
        restoreRetryRef.current += 1;
        if (restoreRetryTimerRef.current) clearTimeout(restoreRetryTimerRef.current);
        restoreRetryTimerRef.current = setTimeout(() => { restoreRetryTimerRef.current = null; void loadSessions(false); }, INITIAL_RESTORE_RETRY_MS);
        return;
      }
      restoredRef.current = true;
      onInitialRestoreDone?.();
      return;
    }
    if (selectedCwd !== null || !visibleSessions[0]) return;
    setSelectedCwd(visibleSessions[0].cwd);
  }, [skipInitialProjectSelection, initialSessionId, visibleSessions, selectedCwd, onSelectSession, onInitialRestoreDone, loadSessions]);

  const handleSelectSessionFromList = useCallback((session: SessionInfo) => {
    setSelectedCwd(session.cwd);
    onSelectSession(session);
  }, [onSelectSession]);
  const handleSessionDeleted = useCallback((id: string) => {
    const deleted = allSessions.find((session) => session.id === id);
    if (deleted) clearLastOpenSession(workspaceKeyOf(deleted));
    onSessionDeleted?.(id);
    void loadSessions(false);
  }, [allSessions, onSessionDeleted, loadSessions]);
  useEffect(() => {
    const selected = allSessions.find((session) => session.id === selectedSessionId);
    if (selected) setLastOpenSession(workspaceKeyOf(selected), selected.id);
  }, [allSessions, selectedSessionId]);

  const selectHost = useCallback((host: "local" | "remote") => { setNewHost(host); saveNewHost(host); }, []);
  const handleNewLocal = useCallback(async () => {
    selectHost("local");
    if (newLocalBusy || !onNewSession) return;
    setNewLocalBusy(true);
    try {
      let cwd = selectedCwdProp ?? selectedCwd ?? visibleSessions.find((session) => session.id === selectedSessionId)?.cwd ?? visibleSessions[0]?.cwd ?? null;
      if (!cwd) {
        const response = await fetch("/api/default-cwd", { method: "POST" });
        const data = await response.json().catch(() => ({})) as { cwd?: string; error?: string; code?: string };
        if (!response.ok || !data.cwd) throw new Error(data.error || data.code ? formatApiError(data) : `HTTP ${response.status}`);
        cwd = data.cwd;
      }
      const sessionId = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      setSelectedCwd(cwd);
      onNewSession(sessionId, cwd);
      setNewMenuOpen(false);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally { setNewLocalBusy(false); }
  }, [newLocalBusy, onNewSession, selectHost, selectedCwdProp, selectedCwd, visibleSessions, selectedSessionId]);
  const handleNewRemote = useCallback((targetId: string) => { selectHost("remote"); onNewRemoteSession?.(targetId); setNewMenuOpen(false); }, [onNewRemoteSession, selectHost]);

  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const handleImportSession = useCallback(async (file: File | null) => {
    if (!file || importing) return;
    setImporting(true);
    try {
      const response = await fetch("/api/sessions/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fileName: file.name, content: await file.text() }) });
      const data = await response.json().catch(() => ({})) as { success?: boolean; error?: string };
      if (!response.ok || !data.success) throw new Error(data.error ?? `HTTP ${response.status}`);
      toast.success(t("sessionSidebar.imported"));
      void loadSessions(false);
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : String(cause)); } finally { setImporting(false); }
  }, [importing, loadSessions, t]);

  return <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
    {remoteWorkspaces}
    <div style={{ padding: "10px 10px 8px", borderBottom: "1px solid var(--border)", flexShrink: 0, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}><OmpWebTitle /><div style={{ display: "flex", gap: 2 }}>{onOpenArchive && <Tooltip content={t("sessionSidebar.archiveBrowserTitle")} side="bottom"><SidebarIconButton label={t("sessionSidebar.archiveBrowser")} onClick={onOpenArchive}><Archive size={14} strokeWidth={1.9} aria-hidden="true" /></SidebarIconButton></Tooltip>}<Tooltip content={t("sessionSidebar.importTitle")} side="bottom"><SidebarIconButton label={t("sessionSidebar.import")} onClick={() => importInputRef.current?.click()} disabled={importing}><FileUp size={14} strokeWidth={1.9} aria-hidden="true" /></SidebarIconButton></Tooltip><Tooltip content={t("sessionSidebar.refresh")} side="bottom"><SidebarIconButton label={t("sessionSidebar.refresh")} active={sessionRefreshDone} onClick={() => void loadSessions(false)}>{sessionRefreshDone ? <Check size={14} strokeWidth={2.2} aria-hidden="true" /> : <RefreshCw size={14} strokeWidth={1.9} aria-hidden="true" />}</SidebarIconButton></Tooltip></div></div>
      <input ref={importInputRef} type="file" accept=".jsonl,.json,application/json,application/jsonl" style={{ display: "none" }} onChange={(event) => { const file = event.target.files?.[0] ?? null; event.target.value = ""; void handleImportSession(file); }} />
      <div style={{ display: "flex", position: "relative" }}><button type="button" onClick={() => { if (newHost === "remote" && remoteTargets.length) handleNewRemote(remoteTargets[0].id); else void handleNewLocal(); }} disabled={newLocalBusy || (newHost === "remote" && remoteTargets.length === 0)} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 7, flex: 1, height: 32, padding: "0 10px", border: "1px solid color-mix(in srgb, var(--accent) 55%, var(--border))", borderRadius: "var(--radius-control) 0 0 var(--radius-control)", background: "color-mix(in srgb, var(--accent) 9%, transparent)", color: "var(--text)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}><Plus size={15} strokeWidth={2} aria-hidden="true" />{t("sessionSidebar.new")}{newHost === "remote" && remoteTargets.length > 0 ? <span style={{ color: "var(--text-dim)", fontWeight: 500 }}>· {remoteTargets[0].name}</span> : null}</button><button type="button" aria-label="Choose thread host" aria-expanded={newMenuOpen} onClick={() => setNewMenuOpen((open) => !open)} style={{ width: 31, height: 32, display: "grid", placeItems: "center", padding: 0, border: "1px solid color-mix(in srgb, var(--accent) 55%, var(--border))", borderLeft: 0, borderRadius: "0 var(--radius-control) var(--radius-control) 0", background: "color-mix(in srgb, var(--accent) 9%, transparent)", color: "var(--accent)", cursor: "pointer" }}><Monitor size={14} strokeWidth={1.9} aria-hidden="true" /></button>{newMenuOpen && <div role="menu" style={{ position: "absolute", top: 37, left: 0, right: 0, zIndex: 20, padding: 4, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", boxShadow: "var(--shadow-pop)" }}><button type="button" role="menuitem" onClick={() => void handleNewLocal()} style={menuItemStyle}><HostMark host="local" /> <span style={{ marginLeft: 7 }}>{t("sessionSidebar.new")} · Linux</span></button>{remoteTargets.map((target) => <button type="button" role="menuitem" key={target.id} onClick={() => handleNewRemote(target.id)} style={{ ...menuItemStyle, display: "flex", alignItems: "center" }}><HostMark host="remote" platform={target.platform} /><span style={{ minWidth: 0, marginLeft: 7, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{target.name}</span></button>)}</div>}</div>
    </div>
    <div style={{ flexShrink: 0, padding: "4px 10px 2px", display: "flex", alignItems: "center", gap: 2 }}><span style={{ flex: 1, color: "var(--text-muted)", fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase" }}>Threads</span><SidebarIconButton label={t("sessionSidebar.search")} title={t("sessionSidebar.searchTitle")} active={searchOpen} onClick={() => { const next = !searchOpen; setSearchOpen(next); if (next) setTimeout(() => searchInputRef.current?.focus(), 0); else setSearchQuery(""); }}><Search size={15} strokeWidth={1.9} aria-hidden="true" /></SidebarIconButton><SidebarIconButton label={t("sessionSidebar.filterRunning")} title={t("sessionSidebar.filterRunningTitle")} active={runningOnly} onClick={() => setRunningOnly((value) => !value)}><SlidersHorizontal size={15} strokeWidth={1.9} aria-hidden="true" /></SidebarIconButton></div>
    {searchOpen && <div style={{ padding: "0 10px 6px", flexShrink: 0 }}><input ref={searchInputRef} value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { setSearchOpen(false); setSearchQuery(""); } }} placeholder={t("sessionSidebar.searchPlaceholder")} aria-label={t("sessionSidebar.search")} style={{ width: "100%", height: 27, boxSizing: "border-box", padding: "0 9px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", outline: "none", color: "var(--text)", fontSize: 12 }} /></div>}
    <div style={{ flex: explorerOpen && (selectedCwdProp || selectedCwd) ? "1 1 0" : "1 1 auto", overflowY: "auto", padding: "2px 10px 10px", minHeight: 80 }}>
      {loading && <div style={{ padding: "10px 4px", color: "var(--text-muted)", fontSize: 12 }}>{t("sessionSidebar.loading")}</div>}
      {error && <div style={{ padding: "10px 4px", color: "var(--accent)", fontSize: 12 }}>{error}</div>}
      {!loading && !error && filteredSessions.length === 0 && remoteTargets.length === 0 && <div style={{ padding: "14px 4px", color: "var(--text-dim)", fontSize: 11.5, lineHeight: 1.5 }}>{searchQuery || runningOnly ? t("sessionSidebar.noMatches") : t("projects.noProjects")}</div>}
      {[...filteredSessions.map(session => ({kind:"local" as const,modified:session.modified,session})), ...remoteThreads.filter(thread => (!runningOnly || thread.running) && `${thread.name} ${thread.target.hostname ?? thread.target.id} ${thread.cwd}`.toLowerCase().includes(deferredSearchQuery.trim().toLowerCase())).map(thread => ({kind:"remote" as const,modified:thread.modified ?? "",thread}))].sort((a,b)=>b.modified.localeCompare(a.modified)).map(row => row.kind === "local" ? <ThreadRow key={row.session.id} host="local" session={row.session} isSelected={!remoteActive && row.session.id===selectedSessionId} isRunning={runningSessionIds.has(row.session.id)} runningSince={runningSince[row.session.id]} isUnread={unreadSessionIds.has(row.session.id)} relativeTimeNow={relativeTimeNow} homeDir={homeDir} hostPlatform={serverHostPlatform} onClick={()=>handleSelectSessionFromList(row.session)} onRenamed={()=>void loadSessions(false)} onDeleted={handleSessionDeleted}/> : <ThreadRow key={row.thread.id} host="remote" thread={row.thread} isSelected={remoteActive === true && row.thread.id===selectedRemoteSessionId} isRunning={row.thread.running === true} runningSince={row.thread.runningSince} isUnread={false} relativeTimeNow={relativeTimeNow} homeDir={homeDir} hostPlatform={row.thread.target.platform} onClick={()=>onSelectRemoteSession?.(row.thread.targetId,row.thread.id)} onRemoteThreadRenamed={onRemoteThreadRenamed}/>) }
    </div>
    {!remoteActive && (selectedCwdProp || selectedCwd) && <div style={{ borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column", flex: explorerOpen ? "1 1 0" : "0 0 auto", minHeight: 0, overflow: "hidden" }}><div style={{ display: "flex", alignItems: "center", flexShrink: 0 }}><button type="button" onClick={() => setExplorerOpen((value) => !value)} style={{ display: "flex", alignItems: "center", flex: 1, padding: "6px 10px", background: "none", border: 0, color: "var(--text-muted)", cursor: "pointer", fontSize: 11, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", textAlign: "left" }}><span style={{ marginRight: 6, transform: explorerOpen ? "rotate(90deg)" : "none", transition: "transform var(--dur-fast) var(--ease-out-warm)" }}>›</span>{t("sessionSidebar.explorer")}</button><div style={{ display: "flex", alignItems: "center" }}><Tooltip content={t("sessionSidebar.uploadFilesTitle")} side="top"><button type="button" onClick={() => fileExplorerRef.current?.openUploadPicker()} disabled={explorerUploadBusy} title={t("sessionSidebar.uploadFilesTitle")} aria-label={t("sessionSidebar.uploadFiles")} style={{ width: 26, height: 26, display: "grid", placeItems: "center", padding: 0, border: 0, background: "none", color: "var(--text-dim)", cursor: "pointer" }}><Upload size={13} strokeWidth={2} aria-hidden="true" /></button></Tooltip><Tooltip content={t("sessionSidebar.refreshExplorer")} side="top"><button type="button" onClick={() => onExplorerRefresh ? onExplorerRefresh() : setExplorerKey((key) => key + 1)} title={t("sessionSidebar.refreshExplorer")} aria-label={t("sessionSidebar.refreshExplorer")} style={{ width: 26, height: 26, display: "grid", placeItems: "center", padding: 0, marginRight: 6, border: 0, background: "none", color: explorerRefreshing ? "var(--accent)" : "var(--text-dim)", cursor: "pointer" }}>{explorerRefreshing ? <RefreshCw size={13} className="icon-spin" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}</button></Tooltip></div></div><div className={`accordion-flow ${explorerOpen ? "is-open" : ""}`} inert={!explorerOpen ? true : undefined} style={{ flex: explorerOpen ? "1 1 auto" : "0 0 0px", minHeight: 0 }}><div className="accordion-flow-inner" style={{ height: "100%", overflowY: "auto", overflowX: "hidden" }}><FileExplorer ref={fileExplorerRef} cwd={selectedCwd ?? selectedCwdProp!} onOpenFile={onOpenFile ?? (() => {})} refreshKey={explorerKey} onAtMention={onAtMention} onAtMentions={onAtMentions} onUploadBusyChange={setExplorerUploadBusy} onRefreshDone={onExplorerRefreshDone} /></div></div></div>}
    <button type="button" onClick={onOpenSettings} style={{padding:12,border:0,background:"var(--bg-panel)",color:"var(--text)",textAlign:"left",cursor:"pointer"}}><Settings2 size={14}/> Settings</button>
  </div>;
}
