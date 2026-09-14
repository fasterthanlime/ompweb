import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

/**
 * The rooms UI: the same components as nook, bundled on their own and
 * served by nookd. Building this does not touch the nook server, so a
 * rooms deploy never restarts an OMP session.
 */
const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: `${root}rooms`,
  base: "/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": root,
      "next/link": `${root}rooms/next-link.tsx`,
    },
  },
  define: { "process.env.NEXT_PUBLIC_APP_VERSION": JSON.stringify(process.env.npm_package_version ?? "0.0.0"), "process.env.NODE_ENV": JSON.stringify("production") },
  build: { outDir: `${root}dist/rooms`, emptyOutDir: true, sourcemap: false },
  server: { port: 30179, proxy: { "/api": "http://127.0.0.1:7700" } },
});
