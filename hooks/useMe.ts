"use client";

import { createContext, useContext, useEffect, useState } from "react";

/** The signed-in user, as nookd sees it. */
export interface Me {
  did: string;
  handle: string;
}

export const MeContext = createContext<Me | null>(null);

export function useMe(): Me | null {
  return useContext(MeContext);
}

/**
 * Ask nookd who we are. `null` while asking; `false` when there is no
 * session, which sends us to sign in (nookd's HTML redirect only covers
 * page loads; the bundle asks over fetch).
 */
export function useSession(): Me | null | false {
  const [me, setMe] = useState<Me | null | false>(null);
  useEffect(() => {
    let stop = false;
    void (async () => {
      const res = await fetch("/api/me", { cache: "no-store" });
      if (stop) return;
      if (res.status === 401) { setMe(false); return; }
      if (!res.ok) { setMe(false); return; }
      setMe((await res.json()) as Me);
    })();
    return () => { stop = true; };
  }, []);
  return me;
}

export async function signOut() {
  await fetch("/api/signout", { method: "POST" });
  location.assign("/signin");
}
