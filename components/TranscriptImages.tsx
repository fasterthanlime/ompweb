"use client";
import { useState } from "react";
import type { ImageContent } from "@/lib/types";
import { ClickableImage } from "./ImageLightbox";
export function TranscriptImages({ images, sessionId }: { images: ImageContent[]; sessionId?: string }) {
  return <div style={{ display: "grid", gap: 10, margin: "12px 0", minWidth: 0 }}>{images.map((image, index) => <TranscriptImage key={index} image={image} sessionId={sessionId} />)}</div>;
}
function TranscriptImage({ image, sessionId }: { image: ImageContent; sessionId?: string }) {
  const [failed, setFailed] = useState(false);
  const deferred = image.deferredImage;
  const src = deferred && sessionId ? `/api/sessions/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(deferred.entryId)}/image?blockIndex=${deferred.blockIndex}`
    : image.data && !image.data.startsWith("blob:") ? `data:${image.mimeType};base64,${image.data}`
    : image.source?.type === "base64" ? `data:${image.source.media_type};base64,${image.source.data}` : image.source?.url;
  if (!src || failed) return <p role="status">Transcript image unavailable. {src && <a href={src} target="_blank" rel="noreferrer">Open image</a>}</p>;
  return <ClickableImage src={src} alt="Image attached to tool result" loading="lazy" onError={() => setFailed(true)} style={{ minWidth: 120, minHeight: 120, maxWidth: "100%", maxHeight: 560, objectFit: "contain", borderRadius: "var(--radius-card)" }} />;
}
