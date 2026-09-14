"use client";

import { useEffect, useState } from "react";
import type { GraphEdge, NodeRow } from "@/hooks/useRoom";
import { short } from "@/components/NodeList";

/**
 * The graph, drawn. `part_of` is the tree: children sit under parents.
 * `blocks` is an arrow. Layered top-down, siblings across; no library,
 * because the layout the data wants is a tree with a few cross-arrows and
 * that is a hundred lines, not a dependency.
 */

const W = 168;
const H = 44;
const GAP_X = 14;
const GAP_Y = 46;

const TONE: Record<NodeRow["node"]["state"], string> = {
  open: "var(--text-muted)",
  doing: "var(--accent)",
  done: "var(--status-success)",
  dropped: "var(--text-dim)",
};

interface Placed {
  row: NodeRow;
  x: number;
  y: number;
}

/** Tree layout over `part_of`: each node's width is the sum of its children's. */
function layout(nodes: NodeRow[], edges: GraphEdge[], maxWidth: number): { placed: Placed[]; width: number; height: number } {
  const byId = new Map(nodes.map(n => [n.node.id, n]));
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const e of edges) {
    if (e.kind !== "part_of" || !byId.has(e.from_id) || !byId.has(e.to_id)) continue;
    (children.get(e.to_id) ?? children.set(e.to_id, []).get(e.to_id)!).push(e.from_id);
    hasParent.add(e.from_id);
  }
  const order = (ids: string[]) => ids.map(id => byId.get(id)!).sort((a, b) => a.node.created_at.localeCompare(b.node.created_at)).map(n => n.node.id);
  const roots = order(nodes.filter(n => !hasParent.has(n.node.id)).map(n => n.node.id));
  const span = new Map<string, number>();
  const measure = (id: string): number => {
    const kids = children.get(id) ?? [];
    const w = kids.length ? kids.reduce((s, k) => s + measure(k) + GAP_X, -GAP_X) : W;
    span.set(id, Math.max(w, W));
    return span.get(id)!;
  };
  for (const r of roots) measure(r);
  const placed: Placed[] = [];
  let treeBottom = 0;
  // Children go across when the tree fits, else down as an indented
  // column: an outline, which is what a phone can show. Returns the
  // bottom edge of the subtree.
  const INDENT = 22;
  const place = (id: string, x0: number, y: number, across: boolean): number => {
    const w = across ? span.get(id)! : W;
    placed.push({ row: byId.get(id)!, x: x0 + (w - W) / 2, y });
    treeBottom = Math.max(treeBottom, y + H);
    const kids = order(children.get(id) ?? []);
    if (kids.length === 0) return y + H;
    if (across) {
      let cx = x0;
      let bottom = y + H;
      for (const k of kids) {
        bottom = Math.max(bottom, place(k, cx, y + H + GAP_Y, true));
        cx += span.get(k)! + GAP_X;
      }
      return bottom;
    }
    let cy = y + H + GAP_Y / 2;
    for (const k of kids) {
      cy = place(k, x0 + INDENT, cy, false) + GAP_Y / 2;
    }
    return cy - GAP_Y / 2;
  };
  // Roots flow left to right and wrap, like words: the graph is many
  // small trees, and a phone is narrow.
  let x = 0;
  let rowTop = 0;
  let width = 0;
  for (const r of roots) {
    const across = span.get(r)! <= maxWidth;
    const w = across ? span.get(r)! : W + INDENT * 3;
    if (x > 0 && x + w > maxWidth) {
      x = 0;
      rowTop = treeBottom + GAP_Y;
    }
    place(r, x, rowTop, across);
    x += w + GAP_X * 2;
    width = Math.max(width, x - GAP_X * 2);
  }
  return { placed, width: Math.max(width, W), height: treeBottom };
}

export function NodeGraph({ nodes, edges, onSelect }: { nodes: NodeRow[]; edges: GraphEdge[]; onSelect?: (n: NodeRow) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [maxWidth, setMaxWidth] = useState(900);
  useEffect(() => {
    const measure = () => setMaxWidth(Math.max(W, window.innerWidth - 40));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  if (nodes.length === 0) return <div style={{ color: "var(--text-dim)", padding: 16, fontSize: 12.5 }}>nothing here</div>;
  const { placed, width, height } = layout(nodes, edges, maxWidth);
  const at = new Map(placed.map(p => [p.row.node.id, p]));
  const pad = 12;
  return (
    <div style={{ overflow: "auto", padding: pad }}>
      <svg width={width + pad * 2} height={height + pad * 2} viewBox={`${-pad} ${-pad} ${width + pad * 2} ${height + pad * 2}`} style={{ display: "block", fontSize: 11.5 }}>
        <defs>
          <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 z" fill="var(--accent-strong)" />
          </marker>
        </defs>
        {/* part_of: a quiet elbow from parent bottom to child top */}
        {edges.filter(e => e.kind === "part_of").map(e => {
          const c = at.get(e.from_id); const p = at.get(e.to_id);
          if (!c || !p) return null;
          const outline = c.x > p.x && c.x - p.x < W / 2;
          if (outline) {
            // Outline: down the parent's left margin, across to the child.
            const x1 = p.x + 10, y1 = p.y + H, y2 = c.y + H / 2;
            return <path key={`${e.from_id}${e.to_id}p`} d={`M${x1},${y1} V${y2} H${c.x}`} fill="none" stroke="var(--border)" strokeWidth={1.5} />;
          }
          const x1 = p.x + W / 2, y1 = p.y + H, x2 = c.x + W / 2, y2 = c.y;
          const ym = (y1 + y2) / 2;
          return <path key={`${e.from_id}${e.to_id}p`} d={`M${x1},${y1} V${ym} H${x2} V${y2}`} fill="none" stroke="var(--border)" strokeWidth={1.5} />;
        })}
        {/* blocks: an arrow, side to side when on one row, else top to bottom */}
        {edges.filter(e => e.kind === "blocks").map(e => {
          const a = at.get(e.from_id); const b = at.get(e.to_id);
          if (!a || !b) return null;
          const sameRow = Math.abs(a.y - b.y) < 1;
          const sameCol = Math.abs(a.x - b.x) < 1 && !sameRow;
          if (sameCol) {
            // Stacked: bow out to the right, arrow into the side.
            const x0 = a.x + W, ya = a.y + H / 2, yb = b.y + H / 2, bow = 26;
            const done0 = a.row.node.state === "done" || a.row.node.state === "dropped";
            return <path key={`${e.from_id}${e.to_id}b`} d={`M${x0},${ya} C${x0 + bow},${ya} ${x0 + bow},${yb} ${x0},${yb}`} fill="none" stroke={done0 ? "var(--text-dim)" : "var(--accent-strong)"} strokeWidth={1.5} strokeDasharray={done0 ? "3 3" : undefined} markerEnd={done0 ? undefined : "url(#arrow)"} />;
          }
          const [x1, y1, x2, y2] = a.y < b.y ? [a.x + W / 2, a.y + H, b.x + W / 2, b.y] : [a.x + W / 2, a.y, b.x + W / 2, b.y + H];
          const done = a.row.node.state === "done" || a.row.node.state === "dropped";
          const my = (y1 + y2) / 2;
          // Same row: leave from the top edge and arc over, so the arrow
          // reads as "this one, before that one" rather than a smudge
          // between two adjacent boxes.
          const lift = Math.min(40, 14 + Math.abs(x2 - x1) / 8);
          const d = sameRow
            ? `M${a.x + W / 2},${a.y} C${a.x + W / 2},${a.y - lift} ${b.x + W / 2},${b.y - lift} ${b.x + W / 2},${b.y}`
            : `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
          return <path key={`${e.from_id}${e.to_id}b`} d={d} fill="none" stroke={done ? "var(--text-dim)" : "var(--accent-strong)"} strokeWidth={1.5} strokeDasharray={done ? "3 3" : undefined} markerEnd={done ? undefined : "url(#arrow)"} />;
        })}
        {placed.map(({ row, x, y }) => {
          const n = row.node;
          const tone = TONE[n.state];
          const isSel = selected === n.id;
          const blocked = row.blocked_by.length > 0 && (n.state === "open" || n.state === "doing");
          return (
            <g key={n.id} transform={`translate(${x},${y})`} style={{ cursor: "pointer" }} onClick={() => { setSelected(isSel ? null : n.id); onSelect?.(row); }}>
              <rect width={W} height={H} rx={7} fill="var(--bg-panel)" stroke={isSel ? "var(--accent)" : blocked ? "var(--accent-strong)" : tone} strokeWidth={isSel ? 2 : 1.2} strokeDasharray={n.state === "dropped" ? "4 3" : undefined} />
              <circle cx={12} cy={H / 2} r={4} fill={n.state === "done" ? tone : "none"} stroke={tone} strokeWidth={1.5} />
              {n.state === "doing" && <path d={`M12,${H / 2 - 4} A4,4 0 0 1 12,${H / 2 + 4} z`} fill={tone} />}
              <text x={22} y={n.assignee || n.due ? 18 : H / 2 + 4} fill={n.state === "done" || n.state === "dropped" ? "var(--text-dim)" : "var(--text)"} style={{ fontWeight: 500 }}>
                <title>{n.title}</title>
                {n.title.length > 24 ? n.title.slice(0, 23) + "…" : n.title}
              </text>
              {(n.assignee || n.due) && (
                <text x={22} y={33} fill="var(--text-muted)" style={{ fontSize: 10 }}>
                  {n.assignee ? `@${n.assignee}` : ""}{n.assignee && n.due ? " · " : ""}{n.due ? `due ${n.due.slice(5, 10)}` : ""}
                </text>
              )}
              <text x={W - 6} y={H - 6} textAnchor="end" fill="var(--text-dim)" style={{ fontSize: 9, fontFamily: "var(--font-mono)" }}>{short(n.id)}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
