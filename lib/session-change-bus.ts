// The running-events stream is consumed by the sidebar, but the open
// transcript lives in useAgentSession under a sibling component. These buses
// carry "these session files changed on disk" and "these sessions are
// currently running" from one to the other without threading callbacks
// through the tree.

type Listener = (sessionIds: string[]) => void;

const changeListeners = new Set<Listener>();
const runningListeners = new Set<Listener>();

function publish(listeners: Set<Listener>, sessionIds: string[]): void {
  for (const listener of [...listeners]) {
    try {
      listener(sessionIds);
    } catch {
      // a failing subscriber must not stop the others
    }
  }
}

export function publishSessionsChanged(sessionIds: string[]): void {
  if (sessionIds.length === 0) return;
  publish(changeListeners, sessionIds);
}

export function subscribeSessionsChanged(listener: Listener): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

/** Latest running-session-id snapshot from the sidebar's SSE stream. Empty
 * arrays are published too: "nothing is running" is meaningful state. */
export function publishRunningSessionIds(sessionIds: string[]): void {
  publish(runningListeners, sessionIds);
}

export function subscribeRunningSessionIds(listener: Listener): () => void {
  runningListeners.add(listener);
  return () => {
    runningListeners.delete(listener);
  };
}
