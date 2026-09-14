import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/app/globals.css";
import { RoomView } from "@/components/RoomView";

// nookd serves this at / and /r/<id>; the id is the path tail.
const match = /^\/r\/([0-9a-f-]{36})/.exec(location.pathname);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RoomView initialRoom={match?.[1] ?? null} />
  </StrictMode>,
);
