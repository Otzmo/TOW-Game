import { onSyncError, type SyncError } from '../net/room';

const $ = (id: string) => document.getElementById(id)!;

/** Verständliche Namen der Bereiche im Online-Raum */
const AREA_NAMES: Record<string, string> = {
  units: 'units',
  objects: 'terrain, markers & templates',
  flow: 'charges & prompts',
  log: 'log & dice',
  meta: 'round & phases',
  players: 'player seats',
};

/**
 * Sichtbare Warnung, wenn Firebase Daten ablehnt – sonst kommen z. B. Popups einfach nicht beim Gegner an.
 * Bleibt stehen, bis sie geschlossen oder die Seite neu geladen wird.
 */
export class SyncWarning {
  private problems = new Map<string, SyncError>();

  constructor() {
    $('sync-reload').onclick = () => location.reload();
    $('sync-close').onclick = () => { $('sync-error').hidden = true; };
    onSyncError((err) => {
      this.problems.set(`${err.kind}-${err.area}`, err);
      this.render();
    });
  }

  private render(): void {
    const list = [...this.problems.values()];
    const names = [...new Set(list.map((p) => AREA_NAMES[p.area] ?? p.area))];
    const kinds = new Set(list.map((p) => p.kind));
    const what = kinds.has('read') && kinds.has('write') ? 'reading and writing' : kinds.has('read') ? 'reading' : 'writing';
    $('sync-text').innerHTML =
      `<b>Online sync failed:</b> Firebase denies ${what} for <b>${names.join(', ')}</b>. ` +
      'Your opponent does not see these changes. Usually the database rules do not allow this area yet: ' +
      'in the Firebase console under <i>Realtime Database → Rules</i>, publish the content of <code>database.rules.json</code> ' +
      'and then reload the page for both players.';
    $('sync-error').hidden = false;
  }
}
