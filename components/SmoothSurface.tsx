"use client";
import { useLayoutEffect, useRef, useState } from "react";
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
  const r = Math.min(radius, width / 2, height / 2);
  const points: string[] = [];
  for (const [cx, cy, angle] of [[width-r,r,-90],[width-r,height-r,0],[r,height-r,90],[r,r,180]]) {
    for (let step=0;step<=32;step++) {
      const t=(angle+step*90/32)*Math.PI/180;
      const x=cx+r*Math.sign(Math.cos(t))*Math.abs(Math.cos(t))**(2/3);
      const y=cy+r*Math.sign(Math.sin(t))*Math.abs(Math.sin(t))**(2/3);
      points.push(`${points.length ? "L" : "M"}${x},${y}`);
    }
  }
  return <svg ref={ref} aria-hidden="true" className="smooth-surface" viewBox={`-0.5 -0.5 ${width+1} ${height+1}`} preserveAspectRatio="none"><path d={points.join(" ")+"Z"} fill={fill} stroke="var(--border)" strokeWidth="1" /></svg>;
}
