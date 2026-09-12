interface Node {
  type: string;
  value?: string;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/** Only unfinished text in the final paragraph is eligible. Code, HTML, and
 * already-parsed emphasis stay untouched; source offsets preserve escapes. */
export function streamingEmphasis() {
  return (tree: Node, file: { value: unknown }) => {
    const source = String(file.value);
    const visit = (node: Node) => {
      if (node.type === "paragraph" && node.position?.end.offset === source.trimEnd().length && node.children) {
        const children = node.children;
        for (let n = children.length - 1; n >= 0; n--) {
          const child = children[n];
          if (child.type !== "text" || !child.value) continue;
          const start = child.position?.start.offset;
          const end = child.position?.end.offset;
          if (start === undefined || end === undefined) continue;
          const raw = source.slice(start, end);
          // Avoid interpreting text whose escapes/entities changed its offsets.
          if (raw !== child.value) continue;
          const marker = /(?<![\\\w*])\*{1,2}(?=[^\s*])/g;
          let match: RegExpExecArray | null;
          while ((match = marker.exec(raw))) {
            const delimiter = match[0];
            const tail = raw.slice(match.index + delimiter.length);
            if (tail.includes("*") || tail.includes("\n\n")) continue;
            const before = raw.slice(0, match.index);
            const rest = children.splice(n + 1);
            children.splice(n, 1,
              ...(before ? [{ type: "text", value: before }] : []),
              { type: delimiter.length === 2 ? "strong" : "emphasis", children: [{ type: "text", value: tail }, ...rest] });
            return;
          }
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
