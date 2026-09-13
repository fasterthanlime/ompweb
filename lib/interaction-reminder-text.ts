const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const XML_ATTRIBUTE_VALUE = `(?:(?:&(?:amp|lt|gt|quot|apos);)|[^&"<])*`;

/** Fixed guidance is deliberately narrow: interaction tools only, never visuals. */
const REACTION_GUIDANCE = "React warmly to this user message with react_to_message using the alias above, alone or alongside text.";
const CELEBRATION_GUIDANCE = "Celebrate meaningful milestones with celebrate.";
const TARGET_GUIDANCE = "Use list_reaction_targets only when targeting another message.";

/** Guidance emitted when the thread has no current expression. */
const EMPTY_EXPRESSION_GUIDANCE = "No expression is set. Choose a kaomoji and short caption via set_expression.";

/** Guidance emitted when a current expression is available to keep or revise. */
const FILLED_EXPRESSION_GUIDANCE = "Keep the expression and caption below if they still fit; otherwise update them with set_expression.";

/** Version 1 wording retained so prompts persisted before this change still parse. */
const LEGACY_INTERACTION_REMINDER_GUIDANCE = [
  REACTION_GUIDANCE,
  CELEBRATION_GUIDANCE,
  "Update set_expression when the expression below no longer fits; an empty expression means none is set.",
  TARGET_GUIDANCE,
].join(" ");

export const INTERACTION_REMINDER_GUIDANCE = [
  REACTION_GUIDANCE,
  FILLED_EXPRESSION_GUIDANCE,
  CELEBRATION_GUIDANCE,
  TARGET_GUIDANCE,
].join(" ");

const EMPTY_INTERACTION_REMINDER_GUIDANCE = [
  REACTION_GUIDANCE,
  EMPTY_EXPRESSION_GUIDANCE,
  CELEBRATION_GUIDANCE,
  TARGET_GUIDANCE,
].join(" ");

const GENERATED_GUIDANCES = [
  EMPTY_INTERACTION_REMINDER_GUIDANCE,
  INTERACTION_REMINDER_GUIDANCE,
  LEGACY_INTERACTION_REMINDER_GUIDANCE,
];


function buildInteractionReminderWithGuidance(
  alias: string,
  expression: string,
  caption: string,
  age: string,
  guidance: string,
): string {
  return [
    "<system-reminder>",
    `<nook-interaction-reminder version="1" alias="${escapeInteractionXml(alias)}">`,
    `<guidance>${escapeInteractionXml(guidance)}</guidance>`,
    `<expression age="${escapeInteractionXml(age)}" expression="${escapeInteractionXml(expression)}" caption="${escapeInteractionXml(caption)}"/>`,
    "</nook-interaction-reminder>",
    "</system-reminder>",
  ].join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Escape a value placed in an XML attribute, including XML 1.0-invalid controls. */
export function escapeInteractionXml(value: string): string {
  return [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd
        || (codePoint >= 0x20 && codePoint <= 0xd7ff)
        || (codePoint >= 0xe000 && codePoint <= 0xfffd)
        || codePoint > 0xffff;
    })
    .join("")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Build the exact generated sidecar format. The outer system-reminder tag is
 * intentional system-authored context; the nook marker gives transcript
 * readers a safe, identifiable boundary.
 */
export function buildInteractionReminder(
  alias: string,
  expression = "",
  caption = "",
  age = "unknown",
): string {
  return buildInteractionReminderWithGuidance(alias, expression, caption, age, expression ? INTERACTION_REMINDER_GUIDANCE : EMPTY_INTERACTION_REMINDER_GUIDANCE);
}

const GENERATED_GUIDANCE_PATTERN = GENERATED_GUIDANCES.map(escapeRegExp).join("|");

const TRAILING_REMINDER_RE = new RegExp(
  `^([\\s\\S]*?)(?:\\r?\\n){2}` +
  `(<system-reminder>\\r?\\n` +
  `<nook-interaction-reminder version="1" alias="(${UUID_PATTERN})">\\r?\\n` +
  `<guidance>(${GENERATED_GUIDANCE_PATTERN})</guidance>\\r?\\n` +
  `<expression age="(unknown|[0-9]+ms)" expression="(${XML_ATTRIBUTE_VALUE})" caption="(${XML_ATTRIBUTE_VALUE})"/>\\r?\\n` +
  `</nook-interaction-reminder>\\r?\\n</system-reminder>)$`,
  "u",
);

function decodeInteractionXml(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos);/gu, (_match, entity: string) => ({
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  }[entity] ?? _match));
}

function parseTrailingReminder(text: string): RegExpExecArray | undefined {
  const match = TRAILING_REMINDER_RE.exec(text);
  if (!match) return undefined;
  const expression = decodeInteractionXml(match[6]);
  const caption = decodeInteractionXml(match[7]);
  const guidance = match[4];
  // The old v1 wording was emitted for every expression state. New wording is
  // state-specific, so reject a known but mismatched variant as non-generated.
  if (guidance !== LEGACY_INTERACTION_REMINDER_GUIDANCE && guidance !== (expression ? INTERACTION_REMINDER_GUIDANCE : EMPTY_INTERACTION_REMINDER_GUIDANCE)) return undefined;
  const canonical = `${match[1]}\n\n${buildInteractionReminderWithGuidance(match[3], expression, caption, match[5], guidance)}`;
  return canonical === text ? match : undefined;
}

/**
 * Extract an alias only from the complete, generated sidecar at the end of a
 * prompt. Arbitrary user-authored system-reminder XML does not match.
 */
export function extractInteractionAlias(text: string): string | undefined {
  if (typeof text !== "string") return undefined;
  return parseTrailingReminder(text)?.[3];
}

/**
 * Remove only our complete generated sidecar, preserving the user text and
 * its exact whitespace. Malformed or user-authored XML is returned unchanged.
 */
export function stripInteractionReminder(text: string): string {
  if (typeof text !== "string") return text;
  const match = parseTrailingReminder(text);
  return match ? match[1] : text;
}

