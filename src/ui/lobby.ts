import type { Store } from '../model/store';
import { isOnlineAvailable, normalizeCode, OnlineRoom, type Seat } from '../net/room';

const $ = (id: string) => document.getElementById(id)!;

/** Startbildschirm: Online-Spiel erstellen, beitreten oder offline üben. */
export class Lobby {
  constructor(private store: Store, private onOnline: (me: Seat, room: OnlineRoom) => void) {
    const create = $('lobby-create') as HTMLButtonElement;
    const join = $('lobby-join') as HTMLButtonElement;
    const input = $('lobby-code') as HTMLInputElement;

    if (!isOnlineAvailable()) {
      create.disabled = true;
      join.disabled = true;
      input.disabled = true;
      this.message('Online-Spiel ist noch nicht eingerichtet (Firebase-Konfiguration fehlt).');
    }

    create.onclick = () => this.run(() => OnlineRoom.create(this.store));
    join.onclick = () => this.run(() => OnlineRoom.join(input.value, this.store));
    input.onkeydown = (e) => { if (e.key === 'Enter') join.click(); };
    $('lobby-offline').onclick = () => { $('lobby').hidden = true; };

    // Einladungslink: …/#RAUMCODE
    const fromHash = normalizeCode(location.hash.slice(1));
    if (fromHash && isOnlineAvailable()) {
      input.value = fromHash;
      join.click();
    }
  }

  private async run(connect: () => Promise<OnlineRoom>): Promise<void> {
    this.setBusy(true);
    this.message('Verbinde …');
    try {
      const room = await connect();
      this.enterRoom(room);
    } catch (e) {
      this.message((e as Error).message, true);
    } finally {
      this.setBusy(false);
    }
  }

  private enterRoom(room: OnlineRoom): void {
    $('lobby').hidden = true;
    history.replaceState(null, '', `#${room.code}`);
    $('room-status').hidden = false;
    $('room-code').textContent = room.code;
    $('room-me').textContent = room.me === 'spectator' ? 'Du schaust zu' : `Du: Spieler ${room.me === 'p1' ? 1 : 2}`;
    room.onOpponent((joined) => {
      const el = $('room-opponent');
      el.textContent = joined ? 'Gegner verbunden' : 'Warte auf Gegner …';
      el.classList.toggle('on', joined);
    });
    $('room-copy').onclick = async () => {
      await navigator.clipboard.writeText(location.href);
      $('room-copy').textContent = 'Kopiert ✓';
      setTimeout(() => { $('room-copy').textContent = 'Link kopieren'; }, 1500);
    };
    this.onOnline(room.me, room);
  }

  private setBusy(busy: boolean): void {
    for (const id of ['lobby-create', 'lobby-join', 'lobby-offline']) {
      ($(id) as HTMLButtonElement).disabled = busy || (id !== 'lobby-offline' && !isOnlineAvailable());
    }
  }

  private message(text: string, error = false): void {
    const el = $('lobby-msg');
    el.textContent = text;
    el.classList.toggle('error', error);
  }
}
