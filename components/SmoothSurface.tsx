"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";

const CORNER_STEPS = 32;
const SUPERELLIPSE_EXPONENT = 2 / 3;

/** Decorative surface only: never clip text, menus, or focus rings. */
export function SmoothSurface({ radius = 22, fill = "var(--user-bg)" }: { radius?: number; fill?: string }) {
  const ref = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const measure = () => setSize({ width: parent.clientWidth, height: parent.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  const { width, height } = size;
  const path = useMemo(() => {
    const r = Math.min(radius, width / 2, height / 2);
    const corners = [
      [width - r, r, -90],
      [width - r, height - r, 0],
      [r, height - r, 90],
      [r, r, 180],
    ];
    const points: string[] = [];
    for (const [centerX, centerY, startAngle] of corners) {
      for (let step = 0; step <= CORNER_STEPS; step++) {
        const angle = (startAngle + step * 90 / CORNER_STEPS) * Math.PI / 180;
        const cosine = Math.cos(angle);
        const sine = Math.sin(angle);
        const x = centerX + r * Math.sign(cosine) * Math.abs(cosine) ** SUPERELLIPSE_EXPONENT;
        const y = centerY + r * Math.sign(sine) * Math.abs(sine) ** SUPERELLIPSE_EXPONENT;
        points.push(`${points.length ? "L" : "M"}${x},${y}`);
      }
    }
    return points.join(" ") + "Z";
  }, [width, height, radius]);

  return (
    <svg ref={ref} aria-hidden="true" className="smooth-surface" viewBox={`-0.5 -0.5 ${width + 1} ${height + 1}`} preserveAspectRatio="none">
      <path d={path} fill={fill} stroke="var(--border)" strokeWidth="1" />
    </svg>
  );
}
