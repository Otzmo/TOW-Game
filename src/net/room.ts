import { initializeApp, type FirebaseApp } from 'firebase/app';
import { browserLocalPersistence, getAuth, initializeAuth, signInAnonymously } from 'firebase/auth';
import {
  get, getDatabase, onChildAdded, onChildChanged, onChildRemoved, onValue, ref, set, update,
  type Database,
} from 'firebase/database';
import type { Change, Store } from '../model/store';
import type { BoardObject, Charge, GameMeta, GameState, LogEntry, PlayerId, Prompt, UnitState } from '../model/types';
import { firebaseConfig } from './firebaseConfig';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne leicht verwechselbare Zeichen
const CODE_LENGTH = 6;
const WRITE_INTERVAL_MS = 40;
/** So lange nach einer eigenen Änderung werden Echos derselben Einheit ignoriert. */
const ECHO_WINDOW_MS = 500;

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

let app: FirebaseApp | null = null;

export const isOnlineAvailable = () => firebaseConfig !== null;

async function connect(): Promise<{ db: Database; uid: string }> {
  if (!firebaseConfig) throw new Error('Firebase is not set up yet.');
  // Anmeldung bleibt im Browser gespeichert: Mit dem Raumlink kommt man später auf seinen Platz zurück.
  // Zwei Spieler auf einem Rechner brauchen deshalb zwei Browser oder ein privates Fenster.
  if (!app) {
    app = initializeApp(firebaseConfig);
    initializeAuth(app, { persistence: browserLocalPersistence });
  }
  const auth = getAuth(app);
  const cred = auth.currentUser ? { user: auth.currentUser } : await signInAnonymously(auth);
  return { db: getDatabase(app), uid: cred.user.uid };
}

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Firebase speichert keine undefined-Werte und keine leeren Arrays. */
const toDb = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function unitFromDb(id: string, v: UnitState): UnitState {
  const info = v.info;
  for (const key of ['profile', 'options', 'rules', 'items', 'command'] as const) info[key] ??= [];
  for (const row of info.profile) row.values ??= [];
  return { ...v, id };
}

/** Ein Online-Spielraum: hält Einheiten, Objekte, Protokoll und Spielinfos mit Firebase abgeglichen. */
export class OnlineRoom {
  private pending = new Map<string, Record<string, unknown>>();
  private timer: number | null = null;
  private lastLocal = new Map<string, number>();
  /** Bekannte Einheiten mit Besitzer, um beim Neuimport die alten zu löschen */
  private owners = new Map<string, PlayerId>();
  private unsubscribers: (() => void)[] = [];

  private constructor(
    private db: Database,
    readonly code: string,
    readonly me: Seat,
    private store: Store,
  ) {}

  private path(sub: string): string {
    return `rooms/${this.code}/${sub}`;
  }

  static async create(store: Store): Promise<OnlineRoom> {
    const { db, uid } = await connect();
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = randomCode();
      try {
        // Die Regeln erlauben das nur, wenn der Platz noch frei ist – also der Raum neu ist
        await set(ref(db, `rooms/${code}/players/p1`), uid);
        const { meta, objects, log } = store.state;
        await set(ref(db, `rooms/${code}/meta`), { createdAt: Date.now(), game: toDb(meta) });
        await set(ref(db, `rooms/${code}/objects`), toDb(objects));
        await set(ref(db, `rooms/${code}/log`), toDb(Object.fromEntries(log.map((e) => [e.id, e]))));
        return new OnlineRoom(db, code, 'p1', store).start(false);
      } catch (e) {
        // PERMISSION_DENIED heißt: Code schon vergeben, nächsten probieren
        if (!String((e as Error).message).toLowerCase().includes('permission')) throw e;
      }
    }
    throw new Error('Could not create a room: permission denied. Have the database rules been published?');
  }

  /** Beitreten: freier Platz → Spieler 2, eigener Platz → zurück ins Spiel, sonst als Zuschauer. */
  static async join(rawCode: string, store: Store): Promise<OnlineRoom> {
    const code = normalizeCode(rawCode);
    const { db, uid } = await connect();
    const players = (await get(ref(db, `rooms/${code}/players`))).val() as Partial<Record<PlayerId, string>> | null;
    if (!players) throw new Error(`Room ${code} does not exist.`);
    let me: Seat;
    if (players.p1 === uid) me = 'p1';
    else if (players.p2 === uid) me = 'p2';
    else if (!players.p2) {
      await set(ref(db, `rooms/${code}/players/p2`), uid);
      me = 'p2';
    } else me = 'spectator';
    return new OnlineRoom(db, code, me, store).start(true);
  }

  /** Meldet, ob der andere Spieler dem Raum beigetreten ist. */
  onOpponent(cb: (joined: boolean) => void): void {
    const other: PlayerId = this.me === 'p1' ? 'p2' : 'p1';
    this.unsubscribers.push(onValue(ref(this.db, this.path(`players/${other}`)), (s) => cb(s.exists())));
  }

  /** @param fromRoom true: Tisch kommt aus dem Raum (Beitreten), lokaler Stand wird verworfen */
  private start(fromRoom: boolean): this {
    if (fromRoom) {
      this.store.loadState({ units: {}, objects: {}, log: [], meta: { round: 1, active: 'p1', breakBonus: {} } }, 'remote');
    }
    const recent = (key: string) => Date.now() - (this.lastLocal.get(key) ?? 0) < ECHO_WINDOW_MS;

    const unitsRef = ref(this.db, this.path('units'));
    const onUnit = (key: string | null, val: UnitState) => {
      if (!key) return;
      this.owners.set(key, val.owner);
      if (!recent(key)) this.store.setUnit(unitFromDb(key, val), 'remote');
    };
    const objectsRef = ref(this.db, this.path('objects'));
    const onObject = (key: string | null, val: BoardObject) => {
      if (key && !recent(key)) this.store.setObject({ ...val, id: key }, 'remote');
    };

    this.unsubscribers.push(
      onChildAdded(unitsRef, (s) => onUnit(s.key, s.val()), this.readFailed('units')),
      onChildChanged(unitsRef, (s) => onUnit(s.key, s.val()), this.readFailed('units')),
      onChildRemoved(unitsRef, (s) => {
        if (!s.key) return;
        this.owners.delete(s.key);
        this.store.removeUnit(s.key, 'remote');
      }, this.readFailed('units')),
      onChildAdded(objectsRef, (s) => onObject(s.key, s.val()), this.readFailed('objects')),
      onChildChanged(objectsRef, (s) => onObject(s.key, s.val()), this.readFailed('objects')),
      onChildRemoved(objectsRef, (s) => { if (s.key) this.store.removeObject(s.key, 'remote'); }, this.readFailed('objects')),
      // Angriffe und Aufforderungen
      ...(['charges', 'prompts'] as const).flatMap((kind) => {
        const r = ref(this.db, this.path(`flow/${kind}`));
        const put = (key: string | null, val: unknown) => {
          if (!key || !val) return;
          if (kind === 'charges') this.store.setCharge(key, { ...(val as Charge), id: key }, 'remote');
          else this.store.setPrompt(key, { ...(val as Prompt), id: key, data: (val as Prompt).data ?? {} }, 'remote');
        };
        return [
          onChildAdded(r, (s) => put(s.key, s.val()), this.readFailed('flow')),
          onChildChanged(r, (s) => put(s.key, s.val()), this.readFailed('flow')),
          onChildRemoved(r, (s) => {
            if (!s.key) return;
            if (kind === 'charges') this.store.setCharge(s.key, null, 'remote');
            else this.store.setPrompt(s.key, null, 'remote');
          }, this.readFailed('flow')),
        ];
      }),
      onChildAdded(ref(this.db, this.path('log')), (s) => {
        const val = s.val() as LogEntry;
        if (s.key && val) this.store.addLog({ ...val, id: s.key }, 'remote');
      }, this.readFailed('log')),
      // Runde, Spieler am Zug, Aufstellungszonen und Siegpunkt-Boni
      onValue(ref(this.db, this.path('meta/game')), (s) => {
        const val = s.val() as GameMeta | null;
        // Leere Felder fehlen in Firebase ganz: dann auch hier leeren (gelöschte Maßbänder, Notizen)
        if (val) this.store.setMeta({ ...val, breakBonus: val.breakBonus ?? {}, measures: val.measures ?? {}, notes: val.notes ?? null, ping: val.ping ?? null }, 'remote');
      }, this.readFailed('meta')),
      this.store.subscribe((state, change) => this.onLocalChange(state, change)),
    );
    return this;
  }

  private onLocalChange(state: GameState, change: Change): void {
    // Zuschauer schreiben nichts
    if (change.origin !== 'local' || this.me === 'spectator') return;
    const { units, meta, objects } = state;

    if (change.loaded) {
      // Gespeicherter Spielstand: alles im Raum ersetzen
      for (const u of Object.values(units)) this.owners.set(u.id, u.owner);
      this.write('units', toDb(units));
      this.write('objects', toDb(objects));
      this.write('log', toDb(Object.fromEntries(state.log.map((e) => [e.id, e]))));
      this.write('meta/game', toDb(meta));
      this.write('flow', toDb({ charges: state.charges, prompts: state.prompts }));
      return;
    }
    if (change.chargeId) {
      this.write(`flow/charges/${change.chargeId}`, state.charges[change.chargeId] ? toDb(state.charges[change.chargeId]) : null);
      return;
    }
    if (change.promptId) {
      this.write(`flow/prompts/${change.promptId}`, state.prompts[change.promptId] ? toDb(state.prompts[change.promptId]) : null);
      return;
    }
    if (change.meta) {
      this.write('meta/game', toDb(meta));
      return;
    }
    if (change.log) {
      this.write(`log/${change.log.id}`, toDb(change.log));
      return;
    }
    if (change.objectId) {
      const id = change.objectId;
      this.lastLocal.set(id, Date.now());
      if (change.objectRemoved) this.write(`objects/${id}`, null);
      else if (change.objectPatch) this.queue('objects', id, change.objectPatch);
      else if (objects[id]) this.write(`objects/${id}`, toDb(objects[id]));
      return;
    }

    if (change.replacedOwner) {
      // Armeeimport: alte Einheiten dieses Spielers löschen, neue komplett schreiben
      const paths: Record<string, unknown> = {};
      for (const [id, owner] of this.owners) if (owner === change.replacedOwner) paths[id] = null;
      for (const u of Object.values(units)) {
        if (u.owner !== change.replacedOwner) continue;
        paths[u.id] = toDb(u);
        this.owners.set(u.id, u.owner);
      }
      this.patch('units', paths);
      return;
    }

    const id = change.unitId;
    if (!id) return;
    this.lastLocal.set(id, Date.now());
    if (change.patch) this.queue('units', id, change.patch);
    else if (units[id]) this.write(`units/${id}`, toDb(units[id]));
  }

  /** Änderungen sammeln und höchstens alle WRITE_INTERVAL_MS senden (flüssiges Ziehen). */
  private queue(collection: 'units' | 'objects', id: string, patch: object): void {
    const key = `${collection}/${id}`;
    this.pending.set(key, { ...this.pending.get(key), ...patch });
    this.timer ??= window.setTimeout(() => this.flush(), WRITE_INTERVAL_MS);
  }

  private flush(): void {
    this.timer = null;
    const paths: Record<string, unknown> = {};
    for (const [key, patch] of this.pending) {
      for (const [field, value] of Object.entries(toDb(patch))) paths[`${key}/${field}`] = value;
      this.lastLocal.set(key.split('/')[1], Date.now());
    }
    this.pending.clear();
    if (Object.keys(paths).length) this.patch('', paths);
  }

  /** In die Datenbank schreiben; abgelehnte Schreibzugriffe sichtbar melden. */
  private write(sub: string, value: unknown): void {
    set(ref(this.db, this.path(sub)), value).catch((e: Error) => reportSyncError('write', sub, e));
  }

  private patch(sub: string, paths: Record<string, unknown>): void {
    update(ref(this.db, this.path(sub)), paths).catch((e: Error) =>
      reportSyncError('write', sub || Object.keys(paths)[0] || '', e));
  }

  /** Lesen abgebrochen (z. B. Regeln verbieten den Bereich) */
  private readFailed(sub: string): (e: Error) => void {
    return (e) => reportSyncError('read', sub, e);
  }

  leave(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
  }
}
