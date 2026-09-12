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
    icons: [{ src: "/icon.png", sizes: "512x512", type: "image/png" }],
  };
}
