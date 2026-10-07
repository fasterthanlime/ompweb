"use client";

import { useEffect, useState } from "react";

const field: React.CSSProperties = {
  width: "100%", height: 40, padding: "0 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)",
  background: "var(--bg-panel)", color: "var(--text)", font: "inherit", fontSize: 15,
};
const button: React.CSSProperties = {
  height: 40, padding: "0 16px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)",
  background: "var(--accent)", color: "var(--bg)", font: "inherit", fontSize: 14, fontWeight: 600, cursor: "pointer",
};

/**
 * Sign in with an ATproto handle. nookd resolves it, pushes the
 * authorization request to that account's PDS, and gives us the URL to
 * go to; the PDS sends us back to /oauth/callback with a session.
 */
export function SignIn() {
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = new URLSearchParams(location.search).get("next") ?? "/";
  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!handle.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch("/oauth/start", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: handle.trim(), next }),
      });
      const body = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !body.url) throw new Error(body.error ?? `sign-in: ${res.status}`);
      location.href = body.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <Shell>
      <form onSubmit={go} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label htmlFor="handle" style={{ fontSize: 13, color: "var(--text-muted)" }}>your Bluesky / ATproto handle</label>
        <input
          id="handle" value={handle} onChange={e => setHandle(e.target.value)} placeholder="you.bsky.social"
          autoCapitalize="none" autoCorrect="off" spellCheck={false} autoFocus disabled={busy} style={field}
        />
        <button type="submit" disabled={busy || !handle.trim()} style={{ ...button, opacity: busy || !handle.trim() ? 0.6 : 1 }}>
          {busy ? "one moment" : "sign in"}
        </button>
        {error && <div role="alert" style={{ fontSize: 13, color: "var(--danger, #c33)" }}>{error}</div>}
      </form>
    </Shell>
  );
}

/**
 * A CLI asked to be let in; this is the browser side. The label says
 * which one. Approving mints a session for it under our identity.
 */
export function CliLogin({ code }: { code: string }) {
  const [state, setState] = useState<"loading" | "ready" | "approved" | "gone" | "error">("loading");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    void (async () => {
      const res = await fetch(`/api/cli-login/${code}/show`, { cache: "no-store" });
      if (stop) return;
      if (res.status === 401) { location.assign(`/signin?next=${encodeURIComponent(location.pathname)}`); return; }
      if (!res.ok) { setState("gone"); return; }
      const body = (await res.json()) as { label: string; approved: boolean };
      setLabel(body.label);
      setState(body.approved ? "approved" : "ready");
    })();
    return () => { stop = true; };
  }, [code]);
  const approve = async () => {
    const res = await fetch(`/api/cli-login/${code}/approve`, { method: "POST" });
    if (res.ok) setState("approved");
    else { setError(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `${res.status}`); setState("error"); }
  };
  return (
    <Shell>
      {state === "loading" && <p style={{ color: "var(--text-muted)" }}>one moment</p>}
      {state === "gone" && <p>That login code is unknown or has expired. Run <code>nook login</code> again.</p>}
      {state === "ready" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <p style={{ margin: 0 }}><strong>{label}</strong> wants to act as you.</p>
          <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>Only approve if you just ran <code>nook login</code> there.</p>
          <button type="button" onClick={() => void approve()} style={button}>approve</button>
        </div>
      )}
      {state === "approved" && <p>Approved. <strong>{label}</strong> is signed in; you can close this.</p>}
      {state === "error" && <p role="alert" style={{ color: "var(--danger, #c33)" }}>{error}</p>}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, background: "var(--bg)", color: "var(--text)" }}>
      <div style={{ width: "100%", maxWidth: 360, display: "flex", flexDirection: "column", gap: 20 }}>
        <div style={{ fontWeight: 700, fontSize: 20, letterSpacing: "-0.01em" }}>nook</div>
        {children}
      </div>
    </div>
  );
}
