# Nook - Development Notes

Visible product identity is **Nook** (lowercase wordmark `nook`, overlapping coral, gold, and periwinkle colour-study mark). Brand sources live in `assets/branding/`; `node bin/generate-brand-assets.mjs` regenerates web, favicon, home-screen, and iOS icons using librsvg and ImageMagick. Preserve the full-colour intersections. `NookMark` is the shared interface mark. Package names, `ompweb` CLI, storage keys, environment variables, and deployment URLs deliberately retain their existing identifiers. The compact unboxed composer status row keeps tasks and agent history independently expandable; process details trail completed answers; header telemetry shows context and live speed with full accounting in the existing stats panel.
Tasks and Subagents open independent upward floating popovers; their contents must not resize the composer or timeline. The task trigger previews the active task (blocked fallback), with counts secondary. Consecutive user messages omit intermediate timestamp/action rows; metadata remains available on hover/focus without reflow. Async-result logs render as literal preformatted text, not Markdown.
Transcript and composer share an 880px column centered within the area excluding the 36px desktop minimap rail; empty-state composer avoids nested gutters. Chat prose caps at 78ch while code/tables keep column width. Idle task plans show remaining/complete rather than appearing active. Mobile left-edge right swipes open the existing workspace drawer; vertical and non-edge gestures do not. Streaming emphasis is a display-only remark transform on final-paragraph text; completed Markdown and code retain normal parsing.
Subagent rosters dedupe by id (live preferred), list current work before five recent results, and mount older history only on disclosure. Recovered started records have unknown status rather than appearing live. Detail dialogs lead with results for terminal agents and activity for live agents; assignment is collapsed, and the optional paged transcript uses shared MessageView rendering and paired tool results. Composer autocomplete is off; when a focused editor shrinks visualViewport at normal zoom, omit the bottom safe-area inset and restore it when the keyboard closes.
Thread loads request `limit=100` with deferred thinking/media; older pages use exclusive `before` entry cursors and the selected `leafId`. The server caches unresolved entries and resolves blobs only for the selected page. Client warm-cache stores recent pages for eight sessions, refreshes on return, and merges older pages with entry IDs. Page-local token sums must not be presented as lifetime statistics. Cold parsing still scans the session file and branch topology; response payloads no longer include all historical message bodies.
Navigation is thread-first: local and SSH sessions share a flat list with server-host platform badges; New thread chooses a host, while cwd remains metadata. `remoteTarget`/`remoteSession` select RemoteChat in the main pane. Explorer is local-only. `OMP_WEB_SSH_TARGETS` configures allowed SSH destinations with strict host-key checks. `/remote` redirects home.
Thread expression state is server-owned in `thread-expressions.json`: reactions distinguish user/agent actors, kaomoji/caption are optional, and celebrations are opt-in with reduced-motion handling. Local and remote OMP register `react_to_message`, `set_expression`, `list_reaction_targets`, `celebrate`, and `show_visual` alongside essential goal tools; browser registration cannot replace server tools. Remote reaction indices are absolute transcript indices. Sidebar expression summaries use a shared batch request, not per-row SSE.
Visual frames are restricted static HTML/CSS/SVG, not arbitrary pages: DOMPurify allowlists markup, css-tree validates rules/values, external assets/scripts/forms/animation are blocked, complexity is bounded, and Shadow DOM plus containment isolates presentation (not a security sandbox). Source is treated as untrusted on every render. No iframe or JS execution. Quick replies send literal 👍, Keep going, Commit & push, and Next unit of work please without changing unsent drafts.
Dictation `conversation.item.input_audio_transcription.updated` replaces the provisional hypothesis; after revisions begin, compatibility deltas are ignored. Final `completed.transcript` remains authoritative.
Remote history uses OMP `get_messages_page` with bounded latest100 snapshots and exclusive absolute-index older pages. Warm client cache retains eight thread views; remote reaction targets use absolute indices. Never replace this with full `get_messages` per event. RPC page cursors are versioned and validated; reconnect refreshes cursor seeds.
Deployment storage: create/build future releases on `/fs0/ompweb-release-archive`, not the small root filesystem. `/home/amos/.local/share/ompweb-releases/<name>` may remain a compatibility symlink. Historical releases were relocated there without deletion; the active `workspaces-20260911` release was left in place. Never move a running release in place. Check root free space before builds; preserve active and rollback targets, and build in isolated directories without touching live `.next`.
Deployment automation: `npm run deploy` queues a systemd-owned worker from `bin/deploy-nook.mjs`; it copies/builds on `/fs0`, checks an isolated candidate, arms an independent 10-minute rollback, switches production, and verifies health. `npm run deploy:status` reads durable state; after human browser reconnect use `npm run deploy:confirm`; `npm run deploy:rollback` restores the exact previous override. Never manually repeat a queued worker's side effects. Per-deployment scripts/config/environment files are private and survive Nook restarts. Production is not modified by sandbox tests.
Visual lifecycle: `show_visual` defaults to create and supports update/remove/list by session-scoped id. Updates retain their original anchor and bounded prior source revisions. Direct tool calls and `write` to `xd://show_visual` render beside their originating tool result; the visual index provides latest navigation with an explicit off-page fallback and history disclosure. Safe `light-dark()` follows Nook's selected theme; `.card`, `.muted`, `.row`, `.grid` defaults are provided inside the sanitized shadow root.
Mobile keeps primary quick replies visible and secondary replies in More; celebration preference lives in Settings, not every message. Header identity truncates without wrapping and occasional thread controls use its More menu. `nook:last-thread` restores local or remote selection on ordinary launch; explicit session/remote/cwd URLs take precedence.
Foreground dictation verifies audio-clock progress, tries same-graph suspend/resume, then rebuilds once only before PCM exists. Meter attaches after graph recovery. AudioCaptureError does not trigger automatic Google fallback; retained PCM retries locally. Automated browser and frozen-clock tests do not substitute for physical iOS foreground verification.
Dictation display preference (`nook:dictation-display-mode`) offers Immediate and Stable words in Settings; changes apply next recording. Stable mode uses the server-only `OMP_WEB_DICTATION_PREVIEW_URL` (default LAN preview listener at port8766), never assumes the existing immediate listener supports display_mode. Wait for stable session.updated acknowledgement before PCM. Updated/correction spans replace the whole display; unstable punctuation is secondary, words normal, spacing exact; completed transcript remains authoritative. Both modes retain same capture graph and manual commit. Browser PCM frames cap at 96000 bytes (two seconds at24k PCM16 mono); composer Send/Stop target is44px. Preview service has no reboot/login guarantee; no endpoint URL is exposed to browser.
Dictation preview occupies the textarea itself, with matching draft typography and a same-geometry annotation overlay only for stable punctuation; it is not a separate small transcript row. Microphone and recording stop share a44px slot, the send slot stays fixed, and pending permission/transcription retains cancel in the stop slot. Provisional text never persists as the draft; completion replaces it in place. HostMark uses local Apple/Tux brand assets in identical20px slots, without visible platform words; accessible labels/tooltips retain platform names.
Local and remote threads share `CommittedTranscript`, `ChatInput`, `ComposerPanels`, subagent detail rendering, and sidebar `ThreadRow`. Remote controls use authoritative RPC context/stats (never page sums), compact/abort, model/reasoning, goal state, system prompt, and throughput. Remote rename uses the same inline row affordance; native `branch` creates an independent descriptor and preserves the original. Remote file browsing, archive/delete, and in-thread tree navigation remain explicitly unavailable in Thread controls.
SSH RPC channels use server-owned private `omp-web-ssh-<uid>` control sockets, `ControlMaster=auto`, and 90-second idle persistence; strict host-key verification stays enabled. Each thread retains its own OMP process. First-connection races may briefly open separate transports; subsequent channels reuse the master. Never tear down a live shared master to clean up one thread.
Remote submission always sends one native `abort_and_prompt` through the server (`submit` route); the browser must not choose abort-versus-prompt from cached running state. Remote Runtime projects each message event into its bounded latest100 snapshot even with no subscribers, including the in-flight assistant. Snapshot/event wrappers carry `streamId` and monotonic `revision`; message events carry absolute `messageIndex`. Client snapshots reject older revisions and reset on a new stream epoch. Native history refresh must not overwrite newer live events; goal nonterminal turns still refresh history. Foreground/online reopens SSE and refreshes the authoritative page; SSE has heartbeat comments.
Native `get_messages_page` rejects streaming/compacting sessions (`session_busy`) and binds cursors to session/leaf/message count (`stale_cursor`). During runs, serve the web runtime's live snapshot; unavailable older history is a contextual waiting state, never a transcript-wide failure. Native pages also stop at a byte limit: assemble requested bounded ranges via validated cursor offsets, not requested counts or `total-returnedLength`. Stale transactions discard partial data and restart once. Older-page client merges preserve newer overlapping entries, running state, revision, and live tail; never discard a valid older prefix merely because live events advanced the revision.
Deferred tool-result images retain `{entryId, blockIndex}` references and load individually through the entry image route; never replace them with an irreversible omission marker. TranscriptImages keeps media visible outside collapsed process details and reserves loading dimensions. Image proof must exercise actual paged thread history/reload, not merely read a screenshot in an agent tool. Preview servers must set `OMP_WEB_PACKAGE_DIR` to the source checkout explicitly; inherited production environment otherwise serves an old release.
Visual navigation belongs in the shared thread header, not an inline transcript toolbar. Remote metadata/fork controls live in the header-triggered dialog; mobile detailed telemetry and file-panel controls live in More. Thread rows keep activity visible beside action affordances and show server-reported run elapsed time when known. Long user messages expose measured-overflow Expand/Collapse controls. React is contextual beside Copy; existing pills remain visible, empty messages reserve no reaction row. Picker defaults to three rows of common emoji, supports keyboard emoji input and optional search, with 16px mobile inputs. Recording waveform opens diagnostics; Local labels and standalone diagnostics triggers are not visible.

## Quick Start

```bash
npm run dev   # port 30178
```

Typecheck: `node_modules/.bin/tsc --noEmit`  
Lint: `npm run lint`  
**Never run `next build` during dev** — pollutes `.next/` and breaks `npm run dev`.

The dev server needs the `omp` binary installed (on `PATH`, or set `OMP_WEB_OMP_BIN`).
All live-agent features go through it; session browsing works without it.

---
## Autonomous web goals

`/goal` is server-owned in `AgentSessionWrapper`, not an expanded prompt or the
TUI's native goal command. `set_goal` supports start/pause/resume/clear;
`get_goal`, `get_state.goal`, and `web_goal_updated` synchronize clients.
Goals persist in `session-preferences.json` alongside the advisor choice.
Ordinary successful terminal replies schedule another prompt and become
nonterminal SSE events. Server-owned essential host tools run without a browser:
`set_goal` lets an agent activate a user-requested objective during its current
turn, without starting a competing prompt. Agents may replace completed/blocked goals or clear a matching goal by id; active goals cannot be silently replaced and explicit user pauses remain protected. `finish_goal` records completion or a genuine blocker. The same lifecycle runs for remote descriptors. Local indicators hydrate from server state and `web_goal_updated`, not legacy sessionStorage. The Set goal quick reply sends literal “Set this as your goal” without altering drafts.
Explicit agent `set_goal` action `replace` requires the current active goalId and new user-requested objective; it creates a successor id without a competing turn. Stale ids and paused-goal bypass are rejected. Shared interaction guidance is appended through native `--append-system-prompt` for local/remote processes and included in autonomous continuation prompts; successful server host-tool results periodically reinforce it. Reactions, celebration, and kaomoji tools are essential but encouraged only when useful.
Remote archiving is reversible descriptor metadata, not deletion or compression of remote files. Busy sessions cannot be archived. Archived descriptors are excluded from the switcher and cannot reconnect until restored through Archive Browser; the original remote session and artifacts remain untouched. Sending displays a pending state, preserves drafts/attachments on rejection and newer edits on late acceptance. Remote connection state is visible in the shared header. Quick replies belong to the latest completed answer, and Working joins tasks/agents in the shared composer strip.
host-tool registration must preserve both tools. Stop pauses before aborting;
runtime failures and process restarts pause rather than resume goals silently.
There is no implicit token budget. Old browser-only goals require explicit
re-entry. Regression coverage: `lib/goal-lifecycle.test.mjs`.


## Architecture

omp-web never imports `@oh-my-pi/*` or `@earendil-works/*` packages (they are
Bun-only and cannot run inside Node/Next). See `DESIGN.md` for the full porting
contract.

```
Browser                Next.js Server                    omp child process
  │                        │                                    │
  ├─ GET /api/sessions ────▶ reads ~/.omp/agent/sessions/       │
  ├─ GET /api/sessions/[id] reads .jsonl file directly          │
  ├─ GET /api/agent/running/events ───▶ running id SSE          │
  │                        │                                    │
  ├─ send message ─────────▶ POST /api/agent/[id]               │
  │                        │   startRpcSession() ── spawn ─────▶│ omp --mode rpc-ui
  │                        │   sendCommand({type:"prompt"}) ───▶│ (NDJSON stdio)
  │                        │                                    │
  ├─ SSE connect ──────────▶ GET /api/agent/[id]/events         │
  │                        │   onFrame() ◀── event frames ──────│
  │◀── data: {...} ─────────│                                    │
```

**Session browsing** (read-only): pure-Node parsing of omp session `.jsonl`
files via `lib/session-reader.ts` — no child process involved.  
**Sending a message**: `startRpcSession()` in `lib/rpc-manager.ts` spawns
`omp --mode rpc-ui` (one process per active session) through
`lib/omp/rpc-process.ts`.

Shared foundations in `lib/omp/`:

- `paths.ts` — Node port of omp's directory resolution (`~/.omp/agent`,
  profiles, XDG, session dir slugs).
- `omp-cli.ts` — locate/probe the installed `omp` binary (`resolveOmpBin`,
  `getOmpVersion`).
- `rpc-process.ts` — process + NDJSON protocol layer (`RpcProcess`).

---

## File Map

```
app/api/
  sessions/route.ts               GET  list all sessions
  sessions/[id]/route.ts          GET/PATCH/DELETE session
  sessions/[id]/context/route.ts  GET ?leafId= — context for a specific leaf
  sessions/[id]/export/route.ts   GET exported HTML for a session
  agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts             GET state | POST any RPC command
  agent/[id]/events/route.ts      GET SSE stream
  agent/running/events/route.ts   GET SSE stream of currently-running session ids
  auth/**                         provider list, login/logout, API keys (via RPC)
  cwd/validate/route.ts           POST validate/select a cwd
  default-cwd/route.ts            POST create ~/omp-cwd-YYYYMMDD
  files/[...path]/route.ts        GET file contents for viewer
  home/route.ts                   GET user home directory
  models/route.ts                 GET { models, modelList, defaultModel }
  models-config/route.ts          GET/PUT — read/write ~/.omp/agent/models.yml
  models-config/test/route.ts     POST test a configured model/provider
  omp-settings/route.ts           GET/PUT native config.yml settings (allow-listed)
  mcp/route.ts                    GET/POST/PUT/DELETE project MCP servers
  plugins/route.ts                GET/POST plugin management (shells out to `omp plugin`)
  projects/route.ts               GET registered+discovered projects | POST add | DELETE hide
  skills/route.ts                 GET/PATCH loaded skills and disable-model-invocation
  skills/install/route.ts         POST install skills through npx skills add
  skills/search/route.ts          GET/POST skills.sh search
  worktrees/route.ts              GET/POST/DELETE git worktrees

lib/
  omp/                 shared omp foundations (paths, CLI probe, RpcProcess)
  agent-client.ts      typed fetch helper for /api/agent commands
  draft-store.ts       local draft persistence helpers
  file-access.ts       allowed file roots for /api/files and worktrees
  file-paths.ts        client/server path encoding helpers
  markdown.ts          shared markdown helpers
  npx.ts               npx runner used by skill install
  pi-types.ts          local structural types for agent/RPC objects
  project-ordering.ts  pure project sort/group/activity helpers (client + tests)
  project-registry.ts  on-disk managed-project registry (~/.omp/agent/projects.json)
  rpc-manager.ts       session registry + startRpcSession over RpcProcess
  session-reader.ts    session .jsonl parsing + path cache + buildSessionContext
  skills-service.ts    pure-Node skill discovery mirroring omp's providers
  tool-presets.ts      PRESET_NONE/DEFAULT/FULL + getPresetFromTools()
  types.ts             shared TypeScript types
  normalize.ts         normalizeToolCalls() — field name mismatch between file format and our types
  worktree.ts          project/worktree resolution and git worktree operations

components/
  AppShell.tsx        layout + URL state + tab management
  SessionSidebar.tsx  session tree + FileExplorer
  ChatWindow.tsx      chat composition + completion sound wrapper
  ChatInput.tsx       input bar + model/thinking/tools/compact controls
  ComposerPanels.tsx  composer-attached todo + subagent panels (collapsible, live states)
  TodoList.tsx        todo phase grid with preview/show-all (used by ComposerPanels)
  SubagentTranscriptDialog.tsx  task + final output summary dialog (wide, screen-adaptive)
  MessageView.tsx     renders one message (user/assistant/toolCall/toolResult)
  CommandPalette.tsx  ⌘K/Ctrl+K palette (cmdk): session switch, new session, theme
  ImageLightbox.tsx   click-to-preview lightbox for chat images (ClickableImage)
  BranchNavigator.tsx in-session branch switcher
  ChatMinimap.tsx     scroll minimap alongside the message list
  MarkdownBody.tsx    markdown renderer
  ModelsConfig.tsx    modal for models/auth configuration
  McpConfig.tsx       project MCP server editor (Settings → MCP tab)
  PluginsConfig.tsx   modal for installed plugins
  SkillsConfig.tsx    modal for loaded/search/installable skills
  FileExplorer.tsx    file tree inside sidebar
  FileViewer.tsx      file content in a tab
  TabBar.tsx          tab bar (Chat + open file tabs)
  ui/                 shared primitives: Dialog/Tooltip/Collapsible, fields, toast

hooks/
  useAgentSession.ts       messages + streaming + SSE + fork/navigate/reconciliation logic
  useAudio.ts              completion sound + browser AudioContext unlock
  useDragDrop.ts           shared drag/drop state
  useIsMobile.ts           responsive breakpoint hook
  usePrefersReducedMotion.ts OS reduce-motion preference (SMIL-safe)
  useTheme.ts              theme state (localStorage key "omp-theme")
```

---

## Key Design Decisions & Traps

### RPC session lifecycle (`lib/rpc-manager.ts`)
- One wrapper per session id, keyed in a `globalThis` registry.
- `globalThis` survives Next.js hot-reload; plain module-level Map does not.
- Idle sessions are disposed after a timeout; concurrent `startRpcSession()`
  calls must share a single start promise.

### Two kinds of branching — don't confuse them
- **Fork** (Fork button on user message): creates a new independent `.jsonl` file. Shown as a child in the sidebar tree via `parentSession` header field.
- **In-session branch** (Continue button / BranchNavigator): navigates the entry tree within the same file. Multiple entries share the same `parentId`. Switching between them calls `/api/sessions/[id]/context?leafId=`.

### ToolCall field normalization
Sessions store toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles this — called in both `session-reader.ts` (file load) and streaming event handling.

### Event protocol differences vs pi
omp emits no `prompt_done` / `prompt_error` / `queue_update` /
`compaction_start` / `compaction_end` events. Completion is `agent_end`
(`isTerminal !== false`), errors surface as failed RPC responses plus `notice`
events, and the queue length comes from `get_state.queuedMessageCount`.
New frame types (`turn_start/end`, `notice`, `todo_reminder`, ...) must be
handled or safely ignored.

### Running state SSE + reconciliation
- The sidebar listens to `/api/agent/running/events`, backed by `subscribeRunningSessions()` in `lib/rpc-manager.ts`, so running badges update without polling.
- `useAgentSession` still treats per-session SSE as primary for chat events, but while a run is active it periodically calls `GET /api/agent/[id]` and also reconciles on `visibilitychange`/`online`. This fixes missed `agent_end` events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.

### Composer-attached panels (`components/ComposerPanels.tsx`)
- The live todo plan (`TodoList`) and the subagent roster live **pinned above
  the chat input**, not inside the scrollable message list. `ComposerPanels`
  renders both, each independently collapsible via its header row (`chevron`);
  panels start collapsed with both headers sharing one compact horizontal strip.
  Subagent chips carry live state (pulsing dot while `started`, check/alert/ban
  for terminal states) fed by the same `subagent_lifecycle`/`subagent_progress`
  SSE frames; clicking a chip opens the transcript dialog. `TodoList` keeps a
  non-collapsible default (`collapsible` prop) for SSR tests.

### Subagent integration (`lib/subagent-types.ts`, `lib/subagent-history.ts`)
- **Live detail**: `subagent_progress` frames carry the full `AgentProgress`
  object — `lib/subagent-types.ts` parses it defensively into
  `SubagentInfo.progress` (current tool/intent, tokens, cost, context
  gauge, resolved model, retry state, detached flag, agentSource). The
  composer chips surface the current activity + telemetry line; retry
  (`⟳ retrying N/M`) takes precedence over the tool line. `subagent_event`
  frames also feed a bounded per-subagent activity buffer shown in the
  transcript dialog.
- **Roster hydration**: `get_subagents` snapshots (which carry progress)
  rehydrate the roster after SSE reconnect (`refreshSubagentRoster`, wired
  into mount, send, and the reconcile poll). Terminal subagents vanish from
  the RPC registry — history fills that gap.
- **On-disk history** (`lib/subagent-history.ts`, `/api/sessions/[id]/subagents*`):
  omp persists each subagent's transcript to the parent session's sibling
  artifacts dir (`<session-dir>/<subagent-id>.jsonl`) and the parent file's
  task toolResults keep `progress[]`/`results[]` snapshots. omp-web recovers
  the roster from disk (`extractSubagentHistory`, result fields win over the
  mid-run snapshot), so past/finished runs show in the composer panel after a
  reload. The transcript route pages the sibling file byte-wise (mirroring
  `get_subagent_messages`, which is RPC-registry-gated and refuses files it
  doesn't know). The dialog initially reads the final output — `<id>.md` via
  `?mode=completion` (bounded tail read beyond the 16MB paging cap), with a
  live snapshot for header enrichment. Its explicit transcript disclosure
  pages RPC/disk history and renders normalized messages. Subagent ids are
  `[A-Za-z0-9_-]{1,80}` — the route validates before joining to confine reads
  to the sibling dir.
- **In-message task summary** (`components/MessageView.tsx` TaskResultPanel):
  the session reader allowlists a SIZE-BOUNDED subset of `task` toolResult
  details (telemetry only — no `output`/`stderr`, long text truncated to
  240 chars, `lib/session-reader.ts` `keepTaskToolResultDetails`), and
  expanded `task` tool calls render a per-subagent summary (status, agent,
  task, tokens/cost/duration/model, async marker) above the raw result text.
- **Chip extras**: agent-source labels (`user`/`project`), nested-subagent
  count (`inflightTaskDetails`/`extractedToolData.task` progress), and the
  `⤴` async marker (live `detached` flag or history `details.async`
  presence). Shared formatters live in `lib/subagent-format.ts`.

### Worktrees and project grouping
- `lib/worktree.ts` resolves linked worktree top-levels back to the main repo `projectRoot`; `listAllSessions()` attaches that to each `SessionInfo` so all worktrees for one repo are grouped together in the sidebar.
- Worktree operations are served by `/api/worktrees` and guarded by the same allowed-root rules as `/api/files`.
- New worktrees are created under `<repoRoot>-worktrees/<sanitized-branch>`. Existing branches are reused; otherwise `git worktree add -b` creates the branch.
- Removing a dirty worktree returns `409` with `{ dirty: true }` so the UI can ask before retrying with `force`.
- Sessions whose cwd points at a removed worktree are inferred back into the main project instead of becoming a phantom project row.

### Managed projects sidebar (`lib/project-registry.ts`, `/api/projects`)
- The sidebar lists **managed projects**: explicitly added directories (registered in
  `~/.omp/agent/projects.json`, written atomically as temp-file + rename) plus
  session-discovered ones — hidden entries excluded. Removing a project only
  marks it hidden (reversible via re-adding); hidden entries suppress session
  re-discovery.
- Registry paths are canonical `projectRoot`s: `POST` resolves worktrees to
  their main repo via `resolveProject`, and `resolveProject` returns the
  symlink-free on-disk form for plain directories so registered and
  session-discovered paths compare equal on Windows casing.
- `GET /api/projects` re-authorizes registered roots with `allowFileRoot()` —
  the in-memory browse allowlist does not survive restarts, and empty managed
  projects derive no root from sessions.
- The client sorts the merged list by most-recently-added (registration
  order), then by path for session-discovered projects
  (`lib/project-ordering.ts`); the order deliberately does NOT depend on
  session activity, so project rows never jump around while sessions refresh.
  Expanded project paths live
  in `localStorage` (`omp-web:expanded-projects`), defaulting to only the
  active/restored project expanded, and stale keys are pruned against the
  current project list (only after the first project fetch — an empty
  still-loading list must never wipe storage).
- Each project's session tree is capped at 5 roots with a show-more toggle;
  project rows are cards matching the session items' height/margins/accent
  treatment, and the active project's worktree selector renders directly
  below its row.

### File access allow-list
- `/api/files` is intentionally not a general filesystem browser. Allowed roots come from session cwds, their resolved project roots, `~/omp-cwd-*`, and roots explicitly added with `allowFileRoot()`.
- `/api/cwd/validate`, `/api/default-cwd`, and `/api/worktrees` call `allowFileRoot()` when they make a new location browsable.

### Session list caching — new sessions must appear immediately
- `listAllSessions()` (sidebar, command palette) is cached twice: a 30s TTL
  list cache in `lib/session-reader.ts` plus an mtime-keyed directory walk in
  `lib/omp/session-files.ts` (`listSessionFiles`).
- The walk cache keys on the **sessions root** mtime. On Windows/NTFS a new
  `.jsonl` inside an existing project subdirectory does NOT bump the root
  mtime, so the walk stays stale indefinitely.
- `invalidateSessionListCache()` (fired on `agent_end`, `session_info_update`,
  compaction, renames) must therefore ALSO clear the walk cache via
  `invalidateSessionFileListCache()` — never add a session-mutation path that
  forgets this. Regression test: `session-reader.test.mjs`.

### Chat scroll-follow
- `useAgentSession` follows the conversation: the effect depends on both
  `messages` (boundaries) and `streamState` (every token batch) and throttles
  to one `requestAnimationFrame` while a run is active (`followScrollFrameRef`).
- A manual scroll-up sets `completionScrollAllowedRef = false` and disables
  following until the next prompt; `scrollUserMsgToTop` handles the
  pending-scroll after sending.
- Programmatic smooth scrolling must respect `prefers-reduced-motion`
  (`usePrefersReducedMotion` in `hooks/usePrefersReducedMotion.ts` — also the
  only way to stop SVG SMIL animations, which CSS cannot).

### MCP configuration (`lib/omp/mcp-config.ts`, `/api/mcp`, `components/McpConfig.tsx`)
- Project MCP config resolution order: `.omp/mcp.json`, `.omp/.mcp.json`,
  `mcp.json`, `.mcp.json` at the git top level (falls back to cwd for
  non-git dirs). Server definitions support `stdio`, `http`, and `sse`;
  exactly one of `command`/`url` is required and validated before any write.
- Writes are atomic (temp file + rename), preserve unrelated top-level keys
  (`disabledServers`, `$schema`, ...), and support rename via `previousName`.
- The MCP settings live in their own Settings tab (`SettingsTabs` id `"mcp"`,
  workspace-gated). Server list rows show a config-derived status dot
  (valid+enabled / disabled / invalid) — no live-connectivity probe exists in
  the RPC protocol, so failures surface as toasts (`toast.error`) from the
  editor actions, not inline text.
- The endpoint is guarded by the same allowed-root rules as `/api/files`.

### Plugins and skills
- `/api/plugins` shells out to the user's `omp plugin` CLI (`list/install/uninstall/enable/disable/upgrade`, `--json` where available) — never the Bun-only SDK.
- `/api/skills` uses `lib/skills-service.ts`, a pure-Node scanner mirroring omp's discovery order: project `.omp/skills` (walk-up), `~/.omp/agent/skills`, then the `.claude` / `.agent(s)` / `.codex` / `.github` compat dirs and managed skills.
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives.
- `/api/skills/install` shells through `npx skills add ... --agent universal`, which installs into the ecosystem-standard `.agents/skills` dirs omp reads; project installs run with the selected cwd.

### Update notifications (`/api/omp-update`, `/api/app-update`)
- Automatic in-app self-updating has been removed in favor of explicit user notifications and manual terminal commands.
- `GET /api/app-update` queries the npm registry for `@kahme247/ompweb` updates, detects the install manager (`bun` vs `npm` via `detectInstallMethod`), and returns `updateAvailable` plus the exact terminal command (e.g. `npm install -g @kahme247/ompweb` or `bun add -g @kahme247/ompweb`).
- `POST /api/omp-update` (`action: "check"`) runs `omp update --check` and returns `updateAvailable` plus `updateCommand: "omp update"`.
- `POST /api/omp-update` (`action: "restart"`) restarts active OMP sessions after a manual CLI update.
- Notifications in `AppShell` and settings cards in `SettingsConfig` present the update notification alongside copyable terminal update commands.

### Auth and model config
- Auth flows go through RPC commands (`get_login_providers`, `login`) against the omp child process; credentials live in omp's `agent.db` (SQLite) which omp-web never touches directly.
- The Models panel reads and writes `models.yml` in the omp agent directory (`~/.omp/agent/models.yml`, `.yaml` fallback).
- API-key status endpoints must never return the raw key.

### Composer dictation
- `components/DictationControl.tsx` records browser audio and POSTs a bounded raw Blob to `/api/dictation`; `ChatInput` appends the transcript through a functional draft update and submits only when the recording arrow was explicitly selected. Key the control by draft identity so session switches cancel capture/upload and discard late results. Microphone tracks must stop even when permission arrives after cancellation.
- Recording replaces the normal toolbar with an AnalyserNode-driven level meter, elapsed timer, cancel and stop controls. Capture teardown closes its AudioContext and cancels meter frames. The `+` menu holds attachments/advisor settings; the context ring popover holds the labelled compact action. Model and reasoning triggers are text-only.
- The meter maps only the lower half of analyser frequency bins across all bars. Live provider configuration is prefetched; socket connection runs alongside capture setup, buffering initial PCM until ready. Stop during connection flushes the buffered audio before commit; cancellation must prevent late upload. `app/apple-icon.png` provides the 180px iPhone home-screen mark.
- Recording actions are ordered cancel (far left), then ghost round stop and filled send (far right). Cancel discards audio only; stop appends transcription; the explicit arrow appends and submits the combined draft. During an active run, Send and desktop Enter use `handleInterruptAndReply` (`abort_and_prompt`), not queue/steer, and preserve the draft on failure. Provider failure must never submit the draft.
- Failed transcription keeps the bounded audio Blob in component memory with retry/download/discard controls. Retry always inserts into the draft without inheriting Send intent. Refresh, closing the page, changing chats, or explicit discard removes this in-memory recovery; download first to preserve it. Provider waits have an overall deadline; best-effort Google file deletion never delays transcript delivery.
- Keyboard submission is device-based, not viewport-based: touch devices insert newlines for Enter and Shift+Enter; only the arrow sends. Desktop Enter sends and Shift+Enter inserts a newline.
- `lib/google-dictation.ts` uses Google Gemini 3.5 Transcribe smart mode and the existing Discord key file (`~/.omp/agent/discord-gemini-api-key`, override `OMP_WEB_GEMINI_API_KEY_PATH`). Keep credentials server-only, `store: false`, and uploaded-file cleanup in the server path.
- Opt-in live dictation uses `OMP_WEB_DICTATION_REALTIME_URL` and the authenticated same-origin `/api/dictation/live/socket` bridge. Browser AudioWorklet sends PCM16 mono24k; partial text remains separate from the draft. Local failures fall back to Google with the complete MediaRecorder Blob and a visible provider indicator (explicitly approved by the user). If both fail, retain the Blob for retry/download/discard. Backgrounding stops capture and clears Send intent; the next recording requests fresh microphone access. Permission waits are bounded, and late streams after cancellation or timeout must have their tracks stopped.
- `next.config.ts` must allow `microphone=(self)` in Permissions-Policy; `microphone=()` blocks recording even when the user grants browser permission. Remote microphone use also requires HTTPS.

### Completion sound
- `hooks/useAudio.ts` stores the toggle in `localStorage` and reuses one `AudioContext`.
- Browser autoplay policy means sound must be unlocked from a user gesture; `ChatInput` calls the unlock hook from interactive controls, and `ChatWindow` plays the tone from `onAgentEnd`.

## omp Session File Format (v3)

Location: `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"title","v":1,"title":"...","source":"...","updatedAt":"...","pad":"   ..."}   ← fixed 256-byte slot
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"...","modelId":"...","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
```

- Line 1 is a fixed-width 256-byte padded title slot, rewritable in place.
  Old pi files may lack it — the `{"type":"session"}` header is then line 1.
- Entries form a tree via `(id, parentId)`. Additional entry types
  (`title_change`, `session_init`, `mode_change`, `ttsr_injection`, ...) must
  be tolerated by readers.
- Large payloads (images) are externalized to the content-addressed blob store
  at `~/.omp/agent/blobs` and referenced from entries.

`entryIds[]` in `SessionContext` is a parallel array to `messages[]` — maps each displayed message back to its `.jsonl` entry id, used for fork and navigate_tree calls.

---

## Design Tokens & UI Kit (`app/globals.css`, `components/ui/`)

Warm-paper (light) / warm-ember (dark) palettes; every text/background pair is
WCAG AA-verified (measured ratios noted in `globals.css` comments). Components
must consume these variables — no hardcoded colors.

```
color:  --bg --bg-panel --bg-hover --bg-selected --border --bg-subtle
        --text --text-muted --text-dim
        --accent --accent-strong --accent-hover   (links / filled buttons / hover)
        --user-bg --tool-bg
type:   --font-serif (display headings, class .display-serif)  --font-mono
shape:  --radius-control (8) --radius-card (12) --radius-modal (16)
depth:  --shadow-card --shadow-pop --shadow-modal
motion: --dur-fast (150ms) --dur-med (220ms) --dur-slow (320ms) --ease-out-warm
```

`components/ui/` holds the shared primitives (built on `@base-ui/react`):
`primitives.tsx` (Dialog/Tooltip/Collapsible), `field.tsx` (form fields +
ConfirmDialog), `toast.tsx` (`toast.success/error/info`, mounted in AppShell).
Icons come from `lucide-react` — do not add new inline SVGs. The command
palette (`components/CommandPalette.tsx`, ⌘K/Ctrl+K) is built on `cmdk`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
