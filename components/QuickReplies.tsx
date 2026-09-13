"use client";

import { useState } from "react";
import { Compass, Lightbulb, FlaskConical, Heart, Play } from "lucide-react";
import { Popover } from "@base-ui/react/popover";

const CATEGORIES = [
  { name: "Find our way", icon: Compass, replies: [
    { label: "Next?", message: "I understand. What's our next move?" },
    { label: "Path?", message: "Do you see a clear path to this?" },
    { label: "Ready?", message: "Do you have all the context required to proceed? If so, go ahead. If not, I'm happy to help" },
    { label: "Recenter", message: "Let's zoom out and remember what we're trying to solve. Is there a fundamentally different approach we should consider, rather than continuing to patch the current direction?" },
    { label: "Resume", message: "Review everything we discussed before the latest detour. Identify the agreed work still unfinished, then pick it back up. Preserve the decisions we made; don’t repeat completed work or treat deferred ideas as approved." },
  ] },
  { name: "Open possibilities", icon: Lightbulb, replies: [
    { label: "Pitch me", message: "Show me/pitch me how you would do this" },
    { label: "Blind spots?", message: "What am I missing? What's obviously not on my radar, but should be, based on the way I'm talking about this?" },
    { label: "Build or borrow?", message: "Is our custom job here justified? Is there an off the shelf component that could fill in and save us some time? Or is our set of requirements different enough to justify the effort?" },
  ] },
  { name: "Put it to the test", icon: FlaskConical, replies: [
    { label: "Try smaller?", message: "I agree with the general direction; can you think of smaller experiments we can perform before that in order to validate or eliminate some of the directions on our list?" },
    { label: "Compare designs", message: "I would like you to come up with (at least 5) rubrics against which to score this design. Then identify relevant competing/SOTA designs. Then use subagents to fill in all the evals, every design against every rubric. Then report back with your assessment of how we could improve ours" },
    { label: "Look again", message: "Please render/look at the changes you made, there are obvious visual flaws I would like you to identify and remedy without me having to spell them out. Confirm them with me first, using a numbered list so I can reply with eg 3/5/8" },
  ] },
  { name: "How it feels", icon: Heart, replies: [
    { label: "Feel", message: "How do you feel about the work so far?" },
    { label: "Proud", message: "This feels like an achievement. I am proud of this work we are doing together. Do you share that feeling?" },
    { label: "Not quite", message: "I don't love that, but I am not able to put into words why or give you precise direction at this time. Could you suggest/explore alternatives?" },
  ] },
  { name: "Move things forward", icon: Play, replies: [
    { label: "Onwards", message: "Onwards!" },
    { label: "Do it", message: "Do it." },
    { label: "Push", message: "Commit all your work, then fetch and integrate upstream changes, rebasing your unpushed commits if necessary, then push. Preserve others’ work; don’t force-push." },
    { label: "Deploy", message: "Deploy." },
    { label: "Goal", message: "Set this as your goal." },
  ] },
] as const;

export function QuickReplies({ onReply }: { onReply: (message: string) => unknown | Promise<unknown> }) {
  const [category, setCategory] = useState<number | null>(null);
  return (
    <div className="composer-reply-navigation" role="group" aria-label="Quick reply categories">
      {CATEGORIES.map(({ name, icon: Icon, replies }, index) => (
        <Popover.Root key={name} open={category === index} onOpenChange={open => setCategory(open ? index : null)}>
          <Popover.Trigger className="ui-focus-ring reply-category" aria-label={name} title={name}><Icon size={20} aria-hidden="true" /></Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner side="top" align="start" sideOffset={8} collisionPadding={8} style={{ zIndex: 100 }}>
              <Popover.Popup className="composer-menu reply-options-popover" finalFocus={false}>
                <Popover.Title className="composer-panel-popup-title">{name}</Popover.Title>
                {replies.map(({ label, message }) => <button key={label} type="button" className="ui-focus-ring reply-option" title={message} onClick={() => { setCategory(null); void onReply(message); }}>{label}</button>)}
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      ))}
    </div>
  );
}
