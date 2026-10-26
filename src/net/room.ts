import type { OnlineRoom } from './onlineRoom';
import type { PlayerId } from '../model/types';
import { firebaseConfig } from './firebaseConfig';

export type Seat = PlayerId | 'spectator';

/** Von Firebase abgelehnter Zugriff, z. B. weil die Datenbankregeln einen Bereich nicht erlauben */
export interface SyncError {
  kind: 'read' | 'write';
  /** Bereich im Raum, z. B. "flow" oder "units" */
  area: string;
  message: string;
}

const syncErrorListeners = new Set<(err: SyncError) => void>();

export function onSyncError(fn: (err: SyncError) => void): void {
  syncErrorListeners.add(fn);
}

export function reportSyncError(kind: SyncError['kind'], path: string, e: Error): void {
  const area = path.split('/').filter(Boolean)[0] ?? '';
  console.error(`Firebase: ${kind} of "${path}" denied`, e);
  for (const fn of syncErrorListeners) fn({ kind, area, message: e?.message ?? String(e) });
}

export const isOnlineAvailable = () => firebaseConfig !== null;

export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Firebase erst laden, wenn jemand online spielt: Der Start bleibt klein, und im Demo-Build
 * (ohne Online-Modus) fällt Firebase ganz aus dem Paket.
 */
export async function loadOnlineRoom(): Promise<typeof OnlineRoom> {
  if (import.meta.env.VITE_DEMO) throw new Error('Online play is not available in the demo.');
  return (await import('./onlineRoom')).OnlineRoom;
}
