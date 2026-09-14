import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/app/globals.css";
import { RoomView } from "@/components/RoomView";
import { GraphView } from "@/components/GraphView";

// nookd serves this at /, /r/<id>, and /graph; the id is the path tail.
const match = /^\/r\/([0-9a-f-]{36})/.exec(location.pathname);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {location.pathname === "/graph" ? <GraphView /> : <RoomView initialRoom={match?.[1] ?? null} />}
  </StrictMode>,
);
