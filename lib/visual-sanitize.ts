import DOMPurify from "dompurify";
import { generate, parse, walk } from "css-tree";

const MAX_HTML_LENGTH = 40_000;
const MAX_CSS_LENGTH = 12_000;
const MAX_ELEMENT_COUNT = 500;
const MAX_ATTRIBUTE_LENGTH = 6_000;
const MAX_CSS_RULE_COUNT = 100;
const MAX_MEDIA_DEPTH = 3;
const MAX_NUMERIC_VALUE = 2_000;

// HTML is intentionally limited to inert text/layout primitives and SVG
// drawing nodes. In particular, links, forms, media, and interactive content
// are not part of the visual format.
const ALLOWED_TAGS = [
  "div", "span", "p", "strong", "em", "b", "i", "h1", "h2", "h3", "h4",
  "ul", "ol", "li", "table", "thead", "tbody", "tr", "td", "th", "caption",
  "pre", "code", "br", "hr", "header", "main", "footer", "section", "article",
  "aside", "nav", "button", "svg", "g", "path", "rect", "circle", "ellipse",
  "line", "polyline", "polygon", "text", "tspan", "defs", "marker",
  "linearGradient", "radialGradient", "stop",
];

const ALLOWED_ATTRIBUTES = [
  "class", "id", "viewBox", "width", "height", "x", "y", "x1", "y1", "x2", "y2",
  "cx", "cy", "r", "rx", "ry", "d", "points", "fill", "stroke", "stroke-width",
  "stroke-linecap", "stroke-linejoin", "opacity", "fill-opacity", "stroke-opacity",
  "transform", "text-anchor", "dominant-baseline", "font-size", "font-weight",
  "marker-end", "marker-start", "markerWidth", "markerHeight", "refX", "refY",
  "orient", "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform",
];

const SVG_REFERENCE_ATTRIBUTES: Record<string, true> = { fill: true, stroke: true, "marker-end": true, "marker-start": true };
const NUMERIC_ATTRIBUTES: Record<string, true> = { width: true, height: true, r: true, rx: true, ry: true, "font-size": true, "stroke-width": true };

// Keep this list explicit: every property here is a deliberate part of the
// static visual contract. Positioning, animation, content generation, and
// resource-loading properties are intentionally absent.
const SAFE_CSS_PROPERTIES: Record<string, true> = {
  display: true, "grid-template-columns": true, "grid-template-rows": true, "grid-column": true, "grid-row": true,
  gap: true, "row-gap": true, "column-gap": true, flex: true, "flex-direction": true, "flex-wrap": true,
  "align-items": true, "justify-content": true, "align-self": true, order: true, padding: true,
  "padding-top": true, "padding-bottom": true, "padding-left": true, "padding-right": true, margin: true,
  "margin-top": true, "margin-bottom": true, "margin-left": true, "margin-right": true, width: true,
  height: true, "min-width": true, "max-width": true, "min-height": true, "max-height": true,
  "box-sizing": true, border: true, "border-width": true, "border-style": true, "border-color": true,
  "border-radius": true, "background-color": true, color: true, "color-scheme": true, "font-size": true,
  "font-weight": true, "font-style": true, "font-family": true, "line-height": true, "letter-spacing": true,
  "text-align": true, "white-space": true, "overflow-wrap": true, "word-break": true, "list-style-type": true,
  "border-collapse": true, "vertical-align": true, opacity: true, fill: true, stroke: true, "stroke-width": true,
  background: true, "box-shadow": true, "text-shadow": true, overflow: true, "overflow-x": true,
  "overflow-y": true, "text-overflow": true, "flex-grow": true, "flex-shrink": true, "flex-basis": true,
};

const SAFE_CSS_FUNCTIONS: Record<string, true> = {
  rgb: true, rgba: true, hsl: true, hsla: true, min: true, max: true, minmax: true, repeat: true,
  "light-dark": true, "linear-gradient": true, "radial-gradient": true, calc: true, clamp: true,
};
const SAFE_LENGTH_UNITS: Record<string, true> = { px: true, em: true, rem: true, ch: true, fr: true, "%": true };
const SAFE_COLOR_SCHEME_VALUES: Record<string, true> = {
  normal: true, light: true, dark: true, "light dark": true, "dark light": true,
  "only light": true, "only dark": true,
};
const UNSAFE_SELECTOR_NODES: Record<string, true> = {
  PseudoClassSelector: true, PseudoElementSelector: true, AttributeSelector: true, NestingSelector: true, Raw: true,
};

const MEDIA_QUERY_PATTERN = /^(?:\((?:min-|max-)?width:\s*\d+(?:\.\d+)?(?:px|em|rem)\)|\(prefers-color-scheme:\s*(?:light|dark)\))(?:\s+and\s+\((?:min-|max-)?width:\s*\d+(?:\.\d+)?(?:px|em|rem)\))*$/i;

type SanitizedVisual = { html: string; css: string; warnings: string[] };

function isSafeNumericAttribute(name: string, value: string): boolean {
  if (!Object.hasOwn(NUMERIC_ATTRIBUTES, name)) return true;
  return /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) && Number(value) <= MAX_NUMERIC_VALUE;
}

function isSafeSvgReference(value: string): boolean {
  try {
    let safe = true;
    walk(parse(value, { context: "value" }), node => {
      if (node.type === "Url" && !/^#[A-Za-z0-9_-]+$/.test(node.value)) safe = false;
      if (node.type === "Raw") safe = false;
    });
    return safe;
  } catch {
    return false;
  }
}

function isSafeSelector(prelude: Parameters<typeof walk>[0]): boolean {
  let safe = true;
  walk(prelude, node => {
    if (Object.hasOwn(UNSAFE_SELECTOR_NODES, node.type)) safe = false;
  });
  return safe;
}

function isSafeCssValue(value: Parameters<typeof walk>[0]): boolean {
  let safe = true;
  walk(value, node => {
    if (node.type === "Url" || node.type === "Raw") safe = false;
    if (node.type === "Function") {
      const name = node.name.toLowerCase();
      if (!Object.hasOwn(SAFE_CSS_FUNCTIONS, name)) safe = false;
      if (name === "light-dark") {
        const commas = node.children.toArray().filter(child => child.type === "Operator" && child.value === ",").length;
        if (commas !== 1) safe = false;
      }
    }
    if ((node.type === "Dimension" || node.type === "Percentage") && (!Number.isFinite(Number(node.value)) || Number(node.value) < 0 || Number(node.value) > MAX_NUMERIC_VALUE || (node.type === "Dimension" && !Object.hasOwn(SAFE_LENGTH_UNITS, node.unit.toLowerCase())))) safe = false;
    if (node.type === "Number" && (!Number.isFinite(Number(node.value)) || Number(node.value) < 0 || Number(node.value) > MAX_NUMERIC_VALUE)) safe = false;
  });
  return safe;
}

function isSafeMediaQuery(prelude: Parameters<typeof walk>[0]): boolean {
  const query = generate(prelude);
  if (!MEDIA_QUERY_PATTERN.test(query)) return false;
  let safe = true;
  walk(prelude, node => {
    if (node.type === "Dimension" && (!Number.isFinite(Number(node.value)) || Number(node.value) < 0 || Number(node.value) > MAX_NUMERIC_VALUE)) safe = false;
  });
  return safe;
}

export function sanitizeVisual(html: string, css: string): SanitizedVisual {
  if (html.length > MAX_HTML_LENGTH || css.length > MAX_CSS_LENGTH) throw new Error("Visual exceeds size limit");

  const fragment = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ALLOWED_ATTRIBUTES,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });
  const warnings: string[] = [];
  const warn = () => {
    if (!warnings.length) warnings.push("Unsupported or unsafe markup/styles were removed; this visual may differ from its source.");
  };

  if (DOMPurify.removed.some(removal => !(("element" in removal && removal.element?.nodeName === "BODY")))) warn();
  const nodes = fragment.querySelectorAll("*");
  if (nodes.length > MAX_ELEMENT_COUNT) throw new Error("Visual has too many elements");

  for (const button of fragment.querySelectorAll("button")) {
    button.setAttribute("type", "button");
    button.setAttribute("disabled", "");
    button.setAttribute("tabindex", "-1");
  }
  for (const node of nodes) {
    for (const attr of Array.from(node.attributes)) {
      if (Object.hasOwn(SVG_REFERENCE_ATTRIBUTES, attr.name) && !isSafeSvgReference(attr.value)) {
        node.removeAttribute(attr.name);
        warn();
        continue;
      }
      if (!isSafeNumericAttribute(attr.name, attr.value) || attr.value.length > MAX_ATTRIBUTE_LENGTH) {
        node.removeAttribute(attr.name);
        warn();
      }
    }
  }

  const tree = parse(css, { positions: false });
  if (tree.type !== "StyleSheet") throw new Error("Invalid stylesheet");
  let ruleCount = 0;
  const sanitizeRules = (rules: typeof tree.children, depth = 0): void => rules.forEach((node, item, list) => {
    if (++ruleCount > MAX_CSS_RULE_COUNT) {
      list.remove(item);
      warn();
      return;
    }
    if (node.type === "Atrule" && node.name.toLowerCase() === "media" && node.prelude && node.block && depth < MAX_MEDIA_DEPTH) {
      if (isSafeMediaQuery(node.prelude)) {
        sanitizeRules(node.block.children, depth + 1);
        return;
      }
    }
    if (node.type !== "Rule") {
      list.remove(item);
      warn();
      return;
    }
    if (!isSafeSelector(node.prelude)) {
      list.remove(item);
      warn();
      return;
    }
    node.block.children.forEach((declaration, declarationItem, declarationList) => {
      if (declaration.type !== "Declaration" || !Object.hasOwn(SAFE_CSS_PROPERTIES, declaration.property.toLowerCase())) {
        declarationList.remove(declarationItem);
        warn();
        return;
      }
      const property = declaration.property.toLowerCase();
      const generated = generate(declaration.value).trim().replace(/\s+/g, " ");
      if (property === "color-scheme" && !Object.hasOwn(SAFE_COLOR_SCHEME_VALUES, generated.toLowerCase())) {
        declarationList.remove(declarationItem);
        warn();
        return;
      }
      if (!isSafeCssValue(declaration.value)) {
        declarationList.remove(declarationItem);
        warn();
      }
    });
  });
  sanitizeRules(tree.children);

  const container = document.createElement("div");
  container.append(fragment);
  return { html: container.innerHTML, css: generate(tree), warnings };
}
