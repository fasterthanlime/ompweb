"use client";
import { useEffect, useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { ComposerPanels } from "./ComposerPanels";

export function ThreadWorkControls(props: ComponentProps<typeof ComposerPanels>) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => { setHost(document.getElementById("thread-work-controls")); }, []);
  return host ? createPortal(<ComposerPanels {...props} history header />, host) : null;
}
