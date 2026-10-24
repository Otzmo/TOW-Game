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

let app: FirebaseApp | null = null;

export const isOnlineAvailable = () => firebaseConfig !== null;

async function connect(): Promise<{ db: Database; uid: string }> {
  if (!firebaseConfig) throw new Error('Firebase ist noch nicht eingerichtet.');
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
    throw new Error('Konnte keinen Raum anlegen: Zugriff verweigert. Sind die Datenbankregeln veröffentlicht?');
  }

  /** Beitreten: freier Platz → Spieler 2, eigener Platz → zurück ins Spiel, sonst als Zuschauer. */
  static async join(rawCode: string, store: Store): Promise<OnlineRoom> {
    const code = normalizeCode(rawCode);
    const { db, uid } = await connect();
    const players = (await get(ref(db, `rooms/${code}/players`))).val() as Partial<Record<PlayerId, string>> | null;
    if (!players) throw new Error(`Raum ${code} gibt es nicht.`);
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
      onChildAdded(unitsRef, (s) => onUnit(s.key, s.val())),
      onChildChanged(unitsRef, (s) => onUnit(s.key, s.val())),
      onChildRemoved(unitsRef, (s) => {
        if (!s.key) return;
        this.owners.delete(s.key);
        this.store.removeUnit(s.key, 'remote');
      }),
      onChildAdded(objectsRef, (s) => onObject(s.key, s.val())),
      onChildChanged(objectsRef, (s) => onObject(s.key, s.val())),
      onChildRemoved(objectsRef, (s) => { if (s.key) this.store.removeObject(s.key, 'remote'); }),
      // Angriffe und Aufforderungen
      ...(['charges', 'prompts'] as const).flatMap((kind) => {
        const r = ref(this.db, this.path(`flow/${kind}`));
        const put = (key: string | null, val: unknown) => {
          if (!key || !val) return;
          if (kind === 'charges') this.store.setCharge(key, { ...(val as Charge), id: key }, 'remote');
          else this.store.setPrompt(key, { ...(val as Prompt), id: key, data: (val as Prompt).data ?? {} }, 'remote');
        };
        return [
          onChildAdded(r, (s) => put(s.key, s.val())),
          onChildChanged(r, (s) => put(s.key, s.val())),
          onChildRemoved(r, (s) => {
            if (!s.key) return;
            if (kind === 'charges') this.store.setCharge(s.key, null, 'remote');
            else this.store.setPrompt(s.key, null, 'remote');
          }),
        ];
      }),
      onChildAdded(ref(this.db, this.path('log')), (s) => {
        const val = s.val() as LogEntry;
        if (s.key && val) this.store.addLog({ ...val, id: s.key }, 'remote');
      }),
      // Runde, Spieler am Zug, Aufstellungszonen und Siegpunkt-Boni
      onValue(ref(this.db, this.path('meta/game')), (s) => {
        const val = s.val() as GameMeta | null;
        if (val) this.store.setMeta({ ...val, breakBonus: val.breakBonus ?? {} }, 'remote');
      }),
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
      set(ref(this.db, this.path('units')), toDb(units));
      set(ref(this.db, this.path('objects')), toDb(objects));
      set(ref(this.db, this.path('log')), toDb(Object.fromEntries(state.log.map((e) => [e.id, e]))));
      set(ref(this.db, this.path('meta/game')), toDb(meta));
      set(ref(this.db, this.path('flow')), toDb({ charges: state.charges, prompts: state.prompts }));
      return;
    }
    if (change.chargeId) {
      set(ref(this.db, this.path(`flow/charges/${change.chargeId}`)), state.charges[change.chargeId] ? toDb(state.charges[change.chargeId]) : null);
      return;
    }
    if (change.promptId) {
      set(ref(this.db, this.path(`flow/prompts/${change.promptId}`)), state.prompts[change.promptId] ? toDb(state.prompts[change.promptId]) : null);
      return;
    }
    if (change.meta) {
      set(ref(this.db, this.path('meta/game')), toDb(meta));
      return;
    }
    if (change.log) {
      set(ref(this.db, this.path(`log/${change.log.id}`)), toDb(change.log));
      return;
    }
    if (change.objectId) {
      const id = change.objectId;
      this.lastLocal.set(id, Date.now());
      if (change.objectRemoved) set(ref(this.db, this.path(`objects/${id}`)), null);
      else if (change.objectPatch) this.queue('objects', id, change.objectPatch);
      else if (objects[id]) set(ref(this.db, this.path(`objects/${id}`)), toDb(objects[id]));
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
      update(ref(this.db, this.path('units')), paths);
      return;
    }

    const id = change.unitId;
    if (!id) return;
    this.lastLocal.set(id, Date.now());
    if (change.patch) this.queue('units', id, change.patch);
    else if (units[id]) set(ref(this.db, this.path(`units/${id}`)), toDb(units[id]));
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
    if (Object.keys(paths).length) update(ref(this.db, this.path('')), paths);
  }

  leave(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
  }
}
