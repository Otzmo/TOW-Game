import { initializeApp, type FirebaseApp } from 'firebase/app';
import { browserSessionPersistence, getAuth, initializeAuth, signInAnonymously } from 'firebase/auth';
import {
  get, getDatabase, onChildAdded, onChildChanged, onChildRemoved, onValue, ref, set, update,
  type Database,
} from 'firebase/database';
import type { Change, Store } from '../model/store';
import type { GameMeta, GameState, PlayerId, UnitState } from '../model/types';
import { firebaseConfig } from './firebaseConfig';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne leicht verwechselbare Zeichen
const CODE_LENGTH = 6;
const WRITE_INTERVAL_MS = 40;
/** So lange nach einer eigenen Änderung werden Echos derselben Einheit ignoriert. */
const ECHO_WINDOW_MS = 500;

let app: FirebaseApp | null = null;

export const isOnlineAvailable = () => firebaseConfig !== null;

async function connect(): Promise<{ db: Database; uid: string }> {
  if (!firebaseConfig) throw new Error('Firebase ist noch nicht eingerichtet.');
  // Anmeldung pro Browser-Tab: Neu laden behält den Platz, ein zweiter Tab ist ein eigener Spieler
  if (!app) {
    app = initializeApp(firebaseConfig);
    initializeAuth(app, { persistence: browserSessionPersistence });
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

function fromDb(id: string, v: UnitState): UnitState {
  const info = v.info;
  for (const key of ['profile', 'options', 'rules', 'items', 'command'] as const) info[key] ??= [];
  for (const row of info.profile) row.values ??= [];
  return { ...v, id };
}

/** Ein Online-Spielraum: hält den Spielzustand mit Firebase abgeglichen. */
export class OnlineRoom {
  private pending = new Map<string, Partial<UnitState>>();
  private timer: number | null = null;
  private lastLocal = new Map<string, number>();
  /** Bekannte Einheiten mit Besitzer, um beim Neuimport die alten zu löschen */
  private owners = new Map<string, PlayerId>();
  private unsubscribers: (() => void)[] = [];

  private constructor(
    private db: Database,
    readonly code: string,
    readonly me: PlayerId,
    private store: Store,
  ) {}

  static async create(store: Store): Promise<OnlineRoom> {
    const { db, uid } = await connect();
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = randomCode();
      try {
        // Die Regeln erlauben das nur, wenn der Platz noch frei ist – also der Raum neu ist
        await set(ref(db, `rooms/${code}/players/p1`), uid);
        await set(ref(db, `rooms/${code}/meta`), { createdAt: Date.now(), game: toDb(store.state.meta) });
        return new OnlineRoom(db, code, 'p1', store).start();
      } catch (e) {
        // PERMISSION_DENIED heißt: Code schon vergeben, nächsten probieren
        if (!String((e as Error).message).toLowerCase().includes('permission')) throw e;
      }
    }
    throw new Error('Konnte keinen Raum anlegen: Zugriff verweigert. Sind die Datenbankregeln veröffentlicht?');
  }

  static async join(rawCode: string, store: Store): Promise<OnlineRoom> {
    const code = normalizeCode(rawCode);
    const { db, uid } = await connect();
    const players = (await get(ref(db, `rooms/${code}/players`))).val() as Partial<Record<PlayerId, string>> | null;
    if (!players) throw new Error(`Raum ${code} gibt es nicht.`);
    let me: PlayerId;
    if (players.p1 === uid) me = 'p1';
    else if (players.p2 === uid) me = 'p2';
    else if (!players.p2) {
      await set(ref(db, `rooms/${code}/players/p2`), uid);
      me = 'p2';
    } else throw new Error(`Raum ${code} ist schon voll.`);
    return new OnlineRoom(db, code, me, store).start();
  }

  /** Meldet, ob der andere Spieler dem Raum beigetreten ist. */
  onOpponent(cb: (joined: boolean) => void): void {
    const other: PlayerId = this.me === 'p1' ? 'p2' : 'p1';
    this.unsubscribers.push(onValue(ref(this.db, `rooms/${this.code}/players/${other}`), (s) => cb(s.exists())));
  }

  private start(): this {
    const unitsRef = ref(this.db, `rooms/${this.code}/units`);
    const onRemote = (key: string | null, val: UnitState) => {
      if (!key) return;
      this.owners.set(key, val.owner);
      if (Date.now() - (this.lastLocal.get(key) ?? 0) < ECHO_WINDOW_MS) return;
      this.store.setUnit(fromDb(key, val), 'remote');
    };
    this.unsubscribers.push(
      onChildAdded(unitsRef, (s) => onRemote(s.key, s.val())),
      onChildChanged(unitsRef, (s) => onRemote(s.key, s.val())),
      onChildRemoved(unitsRef, (s) => {
        if (!s.key) return;
        this.owners.delete(s.key);
        this.store.removeUnit(s.key, 'remote');
      }),
      // Runde, Spieler am Zug und Siegpunkt-Boni
      onValue(ref(this.db, `rooms/${this.code}/meta/game`), (s) => {
        const val = s.val() as GameMeta | null;
        if (val) this.store.setMeta({ round: val.round, active: val.active, breakBonus: val.breakBonus ?? {} }, 'remote');
      }),
      this.store.subscribe((state, change) => this.onLocalChange(state, change)),
    );
    return this;
  }

  private onLocalChange({ units, meta }: GameState, change: Change): void {
    if (change.origin !== 'local') return;

    if (change.meta) {
      set(ref(this.db, `rooms/${this.code}/meta/game`), toDb(meta));
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
      update(ref(this.db, `rooms/${this.code}/units`), paths);
      return;
    }

    const id = change.unitId;
    if (!id) return;
    this.lastLocal.set(id, Date.now());
    if (change.patch) {
      // Bewegungen sammeln und höchstens alle WRITE_INTERVAL_MS senden
      this.pending.set(id, { ...this.pending.get(id), ...change.patch });
      this.timer ??= window.setTimeout(() => this.flush(), WRITE_INTERVAL_MS);
    } else if (units[id]) {
      set(ref(this.db, `rooms/${this.code}/units/${id}`), toDb(units[id]));
    }
  }

  private flush(): void {
    this.timer = null;
    const paths: Record<string, unknown> = {};
    for (const [id, patch] of this.pending) {
      for (const [key, value] of Object.entries(toDb(patch))) paths[`${id}/${key}`] = value;
      this.lastLocal.set(id, Date.now());
    }
    this.pending.clear();
    if (Object.keys(paths).length) update(ref(this.db, `rooms/${this.code}/units`), paths);
  }

  leave(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
  }
}
