import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("launcher refuses unauthenticated non-loopback binds", async () => {
  const source = await readFile(new URL("./omp-web.js", import.meta.url), "utf8");
  assert.match(source, /Refusing to listen on/);
  assert.match(source, /!passwordEnabled/);
  // The refusal must not apply when a trusted reverse proxy authenticates.
  assert.match(source, /launchOptions\.authProxy/);
});

test("auth-proxy opt-out is explicit: flag or env, never default", async () => {
  const { parseLaunchOptions } = await import("./omp-web-options.js").then((m) => m.default ?? m);
  assert.equal(parseLaunchOptions([], {}).authProxy, false);
  assert.equal(parseLaunchOptions(["--auth-proxy"], {}).authProxy, true);
  assert.equal(parseLaunchOptions([], { OMP_WEB_AUTH_PROXY: "1" }).authProxy, true);
  assert.equal(parseLaunchOptions([], { OMP_WEB_AUTH_PROXY: "0" }).authProxy, false);
});
