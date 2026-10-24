import { onSyncError, type SyncError } from '../net/room';

const $ = (id: string) => document.getElementById(id)!;

/** Verständliche Namen der Bereiche im Online-Raum */
const AREA_NAMES: Record<string, string> = {
  units: 'Einheiten',
  objects: 'Gelände, Marker & Schablonen',
  flow: 'Angriffe & Popups',
  log: 'Protokoll & Würfe',
  meta: 'Runde & Phasen',
  players: 'Spielerplätze',
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
    const what = kinds.has('read') && kinds.has('write') ? 'Lesen und Schreiben' : kinds.has('read') ? 'Lesen' : 'Schreiben';
    $('sync-text').innerHTML =
      `<b>Online-Abgleich gestört:</b> Firebase lehnt ${what} ab für <b>${names.join(', ')}</b>. ` +
      'Der Gegner sieht diese Änderungen nicht. Meist erlauben die Datenbankregeln diesen Bereich noch nicht: ' +
      'In der Firebase-Konsole unter <i>Realtime Database → Regeln</i> den Inhalt von <code>database.rules.json</code> ' +
      'veröffentlichen und danach bei beiden Spielern die Seite neu laden.';
    $('sync-error').hidden = false;
  }
}
