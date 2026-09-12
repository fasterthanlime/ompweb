import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** Remote chat now lives in the AppShell main pane. Keep old bookmarks useful. */
export default function RemotePage() {
  redirect("/");
}
