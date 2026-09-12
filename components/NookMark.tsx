import Image from "next/image";

export function NookMark({ size = 24 }: { size?: number }) {
  return <Image src="/nook.svg?v=colour-study" alt="" aria-hidden="true" width={size} height={size} unoptimized style={{ flexShrink: 0 }} />;
}
