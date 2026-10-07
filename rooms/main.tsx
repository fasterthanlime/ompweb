import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/app/globals.css";
import { RoomView } from "@/components/RoomView";
import { GraphView } from "@/components/GraphView";
import { CliLogin, SignIn } from "@/components/SignIn";
import { MeContext, useSession } from "@/hooks/useMe";

// nookd serves this at /, /r/<id>, /graph, and the open pages /signin and
// /cli-login/<code>; the id or code is the path tail.
const room = /^\/r\/([0-9a-f-]{36})/.exec(location.pathname);
const cli = /^\/cli-login\/([0-9a-f]+)/.exec(location.pathname);

function App() {
  if (location.pathname === "/signin") return <SignIn />;
  if (cli) return <CliLogin code={cli[1]!} />;
  return <Gated />;
}

/** Everything else needs a session; without one, go sign in and come back. */
function Gated() {
  const me = useSession();
  if (me === false) {
    location.replace(`/signin?next=${encodeURIComponent(location.pathname + location.search)}`);
    return null;
  }
  if (me === null) return null;
  return (
    <MeContext.Provider value={me}>
      {location.pathname === "/graph" ? <GraphView /> : <RoomView initialRoom={room?.[1] ?? null} />}
    </MeContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
