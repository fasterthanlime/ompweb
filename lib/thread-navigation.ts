import type { SessionInfo } from './types';
import type { RemoteThreadSummary } from '../components/RemoteWorkspaceList';

export type ThreadNavigationItem =
  | { kind: 'local'; key: string; title: string; modified: string; session: SessionInfo }
  | { kind: 'remote'; key: string; title: string; modified: string; thread: RemoteThreadSummary };

export function orderedThreads(local: SessionInfo[], remote: RemoteThreadSummary[]): ThreadNavigationItem[] {
  return [
    ...local.map(session => ({ kind: 'local' as const, key: `local:${session.id}`, title: session.name || session.firstMessage || 'Untitled thread', modified: session.modified, session })),
    ...remote.map(thread => ({ kind: 'remote' as const, key: `remote:${thread.id}`, title: thread.name || 'Untitled thread', modified: thread.modified ?? '', thread })),
  ].sort((a, b) => b.modified.localeCompare(a.modified));
}

export function swipeCommits(distance: number, elapsed: number, width: number): boolean {
  return Math.abs(distance) >= Math.min(120, width * 0.28)
    || (Math.abs(distance) >= 45 && Math.abs(distance) / Math.max(elapsed, 1) > 0.55);
}
