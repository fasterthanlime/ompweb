// `next/link` outside Next: a plain anchor. Links to "/" leave the rooms
// app for nook, so a full navigation is what we want anyway.
import type { AnchorHTMLAttributes, ReactNode } from "react";

export default function Link({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children?: ReactNode }) {
  return <a href={href} {...rest}>{children}</a>;
}
