import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Nook",
    short_name: "Nook",
    description: "A place to work alongside coding agents.",
    start_url: "/",
    display: "standalone",
    background_color: "#FAF9F6",
    theme_color: "#FAF9F6",
    icons: [
      { src: "/icon-192.png?v=colour-study", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon.png?v=colour-study", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable.png?v=colour-study", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
