import {
  armourBane, attackLines, attackWeapon, bareHands, contactAttacks, baseToWound, finalNeed, isDiceExpr, lineToHit, misses, needText, rollExpr,
  shooters, shootingOptions, shootingRules, successes, type AttackLine, type AttackMode, type AttackWeapon, type RollMod,
  type ShootingRules,
} from '../model/attack';
import { d6, minChargeDistance, roll, statOf } from '../model/flow';
import { unitSaves, unitWeapons } from '../model/gear';
import type { History } from '../model/history';
import { playerName } from '../model/players';
import { objectPolygon, pointInPolygon } from '../model/objects';
import { isSkirmish, type Store } from '../model/store';
import type { BoardObject, LogEntry, PlayerId, Prompt, PromptKind, UnitState } from '../model/types';
import { diceHtml } from './dice';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '±0');
const clampCount = (v: string) => Math.max(0, Math.min(200, Math.round(Number(v) || 0)));
const saveOptions = (def: number | null) => '<option value="">none</option>' +
  [1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}" ${n === def ? 'selected' : ''}>${n}+</option>`).join('');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const dice = (n: number) => `${n} ${n === 1 ? 'die' : 'dice'}`;
const parse = <T>(v: unknown, fallback: T): T => {
  try { return typeof v === 'string' && v ? JSON.parse(v) as T : fallback; } catch { return fallback; }
};

/** Was PromptCenter für Angriffe bereitstellt */
export interface AttackHost {
  store: Store;
  history: History;
  log(entry: Pick<LogEntry, 'kind' | 'text' | 'dice'>): void;
  create(kind: PromptKind, to: PlayerId, from: PlayerId, title: string, text: string, data: Prompt['data']): void;
  finish(p: Prompt, result: string): void;
  /** Zwischenstand des offenen Popups (wird bei einem neuen Popup geleert) */
  stage(): Record<string, unknown>;
  /** Hat sich die Einheit in diesem Spielerzug bewegt? */
  movedThisTurn(unitId: string): boolean;
}

/** Eine Zeile im Trefferwurf: welches Profil, mit welcher Waffe, wie oft */
interface HitLine {
  line: AttackLine;
  weapon: number;
  count: number;
  /** bei Multiple Shots mit Würfeln: gewürfelte Schüsse dieser Zeile */
  multiRolled: number | null;
}

interface HitForm {
  lines: HitLine[];
  /** angehakte Lage (Labels), z. B. Moving & Shooting, Long range */
  checked: string[];
  manual: RollMod[];
  /** Beschuss: Einheit steht auf einem Hügel (erste zwei Glieder schießen) */
  hill: boolean;
  /** Multiple Shots abgeben statt eines Schusses je Modell */
  multi: boolean;
  /** abgewählte Regeln und Hilfen (Namen) */
  off: string[];
  /** Nahkampf: Erklärung der Attacken aus dem Basekontakt je Zeile */
  notes: Record<string, string>;
}

/** Zeile im Verwundungswurf (aus den Treffern einer Zeile) */
interface WoundLine {
  label: string;
  weapon: AttackWeapon;
  hits: number;
  /** Treffer mit natürlicher 6 bei Poisoned Attacks */
  poisoned: number;
  strength: number;
}

interface WoundForm {
  lines: WoundLine[];
  toughness: number;
  manual: RollMod[];
}

/** Gewürfelt: eine Zeile mit Würfeln, Erfolgen und natürlichen 6en */
interface LineRoll {
  label: string;
  dice: number[];
  then: number[];
  need: number | null;
  thenNeed: number | null;
  rerolled: number[];
  rerollNeed: number | null;
  poison: number[];
  poisonNeed: number | null;
  success: number;
  sixes: number;
}

/** Wunden einer Waffe, für den Rettungswurf zusammengefasst */
interface SaveGroup {
  label: string;
  wounds: number;
  ap: number;
  /** davon mit natürlicher 6 beim Verwunden (Armour Bane) */
  bane: number;
  baneAp: number;
  /** Multiple Wounds (X) oder leer */
  mw: string;
}

/** Waffen einer Einheit für die Auswahl: magische Waffen, dann Ausrüstung; passend zur Angriffsart */
export function weaponsFor(u: UnitState, mode: AttackMode, ownS = statOf(u, 'S')): AttackWeapon[] {
  const profiles = [
    ...u.info.items.flatMap((i) => i.profiles ?? []),
    ...unitWeapons(u.info).flatMap((w) => w.profiles),
  ];
  const list = profiles.map((p) => attackWeapon(p, u, ownS)).filter((w) => (mode === 'shooting' ? w.range !== null : w.range === null));
  return list.length ? list : mode === 'combat' ? [bareHands(u, ownS)] : [];
}

/** Hilfe im Nahkampf: Attacken aus dem Basekontakt zählen */
const CONTACT = 'Attacks from base contact';

const unitRuleNames = (u: UnitState) => [...u.info.rules, ...u.info.items].map((r) => r.name);

/** Sonderregeln, die das Spiel anwendet – je eine Checkbox, angehakt, solange sie nicht abgewählt ist */
const RULES: { name: string; hint: string; has: (r: ShootingRules) => boolean; off: (r: ShootingRules) => Partial<ShootingRules> }[] = [
  { name: 'Volley Fire', hint: 'half of each further rank shoots', has: (r) => r.volley, off: () => ({ volley: false }) },
  { name: 'Ponderous', hint: 'Moving & Shooting −2', has: (r) => r.ponderous, off: () => ({ ponderous: false }) },
  { name: 'Quick Shot', hint: 'no penalty for Moving & Shooting', has: (r) => r.quickShot, off: () => ({ quickShot: false }) },
  { name: 'Dwarf Crafted', hint: 'no penalty for Stand & Shoot', has: (r) => r.dwarfCrafted, off: () => ({ dwarfCrafted: false }) },
  { name: 'Move or Shoot', hint: 'warning after moving', has: (r) => r.moveOrShoot, off: () => ({ moveOrShoot: false }) },
  { name: 'Cumbersome', hint: 'warning for Stand & Shoot', has: (r) => r.cumbersome, off: () => ({ cumbersome: false }) },
  { name: 'Poisoned Attacks', hint: 'natural 6 To Hit: +2 To Wound', has: (r) => r.poisoned, off: () => ({ poisoned: false }) },
];

/** Regeln der Waffe und Einheit ohne die abgewählten */
function rulesWithout(weapon: AttackWeapon, unit: UnitState, off: string[]): ShootingRules {
  const r = shootingRules(weapon.rules, unitRuleNames(unit));
  return RULES.reduce((acc, x) => (off.includes(x.name) ? { ...acc, ...x.off(acc) } : acc), r);
}

/** Checkboxen für Regeln und Hilfen: angehakt = das Spiel wendet sie an */
function ruleBoxes(items: { name: string; hint: string }[], off: string[]): string {
  if (!items.length) return '';
  return `<div class="atk-mods atk-rules-box"><div class="atk-base">Rules & helpers <span class="meta">(untick to ignore)</span></div>
    ${items.map((x) => `<label class="atk-mod"><input type="checkbox" data-rule="${esc(x.name)}" ${off.includes(x.name) ? '' : 'checked'}><span class="atk-label">${esc(x.name)} <span class="atk-hint">${esc(x.hint)}</span></span></label>`).join('')}
  </div>`;
}

function wireRules(body: HTMLElement, off: string[], after: () => void): void {
  body.querySelectorAll<HTMLInputElement>('[data-rule]').forEach((box) => {
    box.onchange = () => {
      const i = off.indexOf(box.dataset.rule!);
      if (!box.checked && i < 0) off.push(box.dataset.rule!);
      if (box.checked && i >= 0) off.splice(i, 1);
      after();
    };
  });
}

/** Steht die Einheit (ihre Mitte) auf einem Hügel? */
function onHill(u: UnitState, objects: Record<string, BoardObject>): boolean {
  return Object.values(objects).some((o) => o.kind === 'terrain' && o.type === 'hill' && pointInPolygon(u, objectPolygon(o)));
}

/**
 * Beschuss und Nahkampf als Abfolge von Popups: Der Angreifer würfelt erst Treffer, nach Bestätigung
 * Verwundungen; danach würfelt der Verteidiger Rüstung, Rettung und Regeneration.
 * Jedes Profil greift in einer eigenen Zeile an (Truppe, Champion, Reittier, angeschlossene Charaktere).
 * Die Lage (bewegt, Deckung, Hügel …) hakt der Spieler an; die Regeln der Waffe (Volley Fire, Ponderous,
 * Quick Shot, Multiple Shots, Poisoned Attacks, AP, Armour Bane, Multiple Wounds) folgen daraus von selbst.
 */
export class AttackFlow {
  constructor(private host: AttackHost) {}

  private get units() {
    return this.host.store.state.units;
  }

  /** Angriff beginnen: Popup „Roll To Hit“ für den Besitzer der angreifenden Einheit */
  start(from: PlayerId, attackerId: string, targetId: string, mode: AttackMode): void {
    const a = this.units[attackerId];
    const t = this.units[targetId];
    if (!a || !t || a.owner === t.owner) return;
    const verb = mode === 'shooting' ? 'Shooting' : 'Combat';
    this.host.create('attack', a.owner, from, 'Roll To Hit', `${verb}: ${a.info.name} → ${t.info.name}`,
      { attackerId, targetId, mode, step: 'hit' });
  }

  /** Waffen eines Profils: Reittiere kämpfen mit ihren Hufen/Klauen als Handwaffe, alle anderen mit der Ausrüstung */
  private lineWeapons(line: AttackLine, mode: AttackMode): AttackWeapon[] {
    const unit = this.units[line.unitId];
    if (!unit) return [];
    return line.mount ? [bareHands(unit, line.s, 'Hand weapon (mount)')] : weaponsFor(unit, mode, line.s);
  }

  renderAttack(p: Prompt, body: HTMLElement): void {
    const a = this.units[String(p.data.attackerId)];
    const t = this.units[String(p.data.targetId)];
    if (!a || !t) {
      this.host.store.setPrompt(p.id, null);
      return;
    }
    const mode = (p.data.mode === 'shooting' ? 'shooting' : 'combat') as AttackMode;
    if (p.data.step === 'wound') return this.renderWound(p, body, a, t);
    this.renderHit(p, body, a, t, mode);
  }

  // --- Treffer ------------------------------------------------------------------

  private renderHit(p: Prompt, body: HTMLElement, a: UnitState, t: UnitState, mode: AttackMode): void {
    const stage = this.host.stage();
    const shooting = mode === 'shooting';
    const form = (stage.hit as HitForm | undefined) ?? (stage.hit = this.newHitForm(a, t, mode)) as HitForm;
    const lines = form.lines.filter((l) => this.lineWeapons(l.line, mode).length);
    if (!lines.length) {
      body.innerHTML = `<p class="warn">${esc(a.info.name)} has no ${shooting ? 'missile weapon' : 'attacks'}.</p>
        <div class="prompt-actions"><button data-cancel>Close</button></div>`;
      (body.querySelector('[data-cancel]') as HTMLButtonElement).onclick = () => this.host.store.setPrompt(p.id, null);
      return;
    }
    const rolled = stage.hitRolled as LineRoll[] | undefined;
    if (rolled) return this.showHits(p, body, a, mode, lines, rolled);

    const distance = minChargeDistance(a, t, this.units);
    const weaponOf = (l: HitLine) => this.lineWeapons(l.line, mode)[Math.min(l.weapon, this.lineWeapons(l.line, mode).length - 1)];
    const rulesOf = (l: HitLine) => rulesWithout(weaponOf(l), this.units[l.line.unitId] ?? a, form.off);
    // Lage zum Anhaken (Erkanntes ist vorab angehakt); die Werte hängen von der Waffe der Zeile ab (Ponderous, Quick Shot …)
    const optionsOf = (l: HitLine) => (shooting ? shootingOptions(weaponOf(l).range, distance, rulesOf(l)) : []);
    const activeOf = (l: HitLine): RollMod[] => [
      ...optionsOf(l).filter((m) => form.checked.includes(m.label)),
      ...(shooting && form.multi && rulesOf(l).multipleShots ? [{ label: `Multiple Shots (${rulesOf(l).multipleShots})`, value: -1 }] : []),
      ...form.manual,
    ];
    const needOf = (l: HitLine) => {
      const base = lineToHit(mode, l.line, t);
      const need = finalNeed(base.need, activeOf(l), 'hit');
      return { base, need, text: `${needText(need)}${base.reroll && need.need !== null ? `, misses re-rolled on ${base.reroll}+` : ''}` };
    };
    const first = rulesOf(lines[0]);
    const moved = form.checked.includes('Moving & Shooting');
    const stand = form.checked.includes('Stand & Shoot');
    const warnings = [
      ...lines.map((l) => {
        const w = weaponOf(l);
        return w.range !== null && distance > w.range ? `${l.line.label}: out of range (${distance.toFixed(1)}″ > ${w.range}″)` : '';
      }),
      ...lines.map((l) => (shooting && rulesOf(l).moveOrShoot && moved ? `${l.line.label}: Move or Shoot – cannot shoot after moving.` : '')),
      ...lines.map((l) => (shooting && rulesOf(l).cumbersome && stand ? `${l.line.label}: Cumbersome – cannot Stand & Shoot.` : '')),
    ].filter(Boolean);
    const total = lines.reduce((s, l) => s + l.count, 0);
    const rows = lines.map((l, i) => {
      const weapons = this.lineWeapons(l.line, mode);
      const w = weaponOf(l);
      const n = needOf(l);
      const select = weapons.length > 1
        ? `<select data-weapon="${i}">${weapons.map((x, j) => `<option value="${j}" ${j === l.weapon ? 'selected' : ''}>${esc(x.name)}${x.range !== null ? ` ${x.range}″` : ''} · S ${x.strength} · AP ${x.ap || '–'}</option>`).join('')}</select>`
        : `<span>${esc(w.name)}${w.range !== null ? ` ${w.range}″` : ''} · S ${w.strength} · AP ${w.ap || '–'}</span>`;
      // Schmal genug für die rechte Spalte: Waffe unter dem Namen
      const note = !shooting && !form.off.includes(CONTACT) ? form.notes[l.line.key] : undefined;
      return `<tr>
        <td><b>${esc(l.line.label)}</b> <span class="meta">${plural(l.line.models, 'model')} · ${esc(n.base.why)}${note ? ` · ${esc(note)}` : ''}</span>
          <div class="atk-weapon">${select}</div>${w.rules.length ? `<span class="meta">${esc(w.rules.join(', '))}</span>` : ''}</td>
        <td><input type="number" min="0" max="200" data-count="${i}" value="${l.count}"></td>
        <td class="atk-need-cell">${esc(n.text)}</td></tr>`;
    }).join('');
    const situation = shooting ? optionsOf(lines[0]) : [];
    const fixed = shooting && form.multi && first.multipleShots ? [{ label: `Multiple Shots (${first.multipleShots})`, value: -1, hint: 'weapon rule' }] : [];
    // Alle Regeln der beteiligten Waffen und Einheiten, dazu im Nahkampf die Zählung aus dem Basekontakt
    const present = RULES.filter((x) => lines.some((l) => x.has(shootingRules(weaponOf(l).rules, unitRuleNames(this.units[l.line.unitId] ?? a)))));
    const helpers = !shooting && Object.keys(form.notes).length ? [{ name: CONTACT, hint: 'models in base contact attack fully, the rest of the front rank supports; mounts never support' }] : [];
    body.innerHTML = `<table class="atk-lines">
        <thead><tr><th>Who · weapon</th><th>${shooting ? 'Shots' : 'Attacks'}</th><th>To Hit</th></tr></thead>
        <tbody>${rows}</tbody></table>
      ${shooting ? this.shootersHtml(a, first, form, moved, stand) : ''}
      ${ruleBoxes([...helpers, ...present], form.off)}
      ${warnings.map((w) => `<p class="warn">${esc(w)}</p>`).join('')}
      ${this.modsHtml('Modifiers <span class="meta">(for all lines; the To Hit column shows the result)</span>', situation, form.checked, form.manual, '', fixed)}
      <div class="prompt-actions">
        <button class="primary" data-roll ${!total || lines.every((l) => needOf(l).need.need === null) ? 'disabled' : ''}>Roll To Hit (${dice(total)})</button>
        <button data-cancel>Cancel</button>
      </div>`;

    const redraw = () => this.renderHit(p, body, a, t, mode);
    // Lage, Hügel, Multiple Shots oder Waffe geändert: Schüsse nach den Regeln neu zählen (danach von Hand änderbar)
    const recount = () => {
      if (shooting) this.recountShots(a, form);
      else this.countCombat(a, t, form);
      redraw();
    };
    wireRules(body, form.off, recount);
    body.querySelectorAll<HTMLInputElement>('[data-count]').forEach((inp) => {
      inp.onchange = () => { lines[Number(inp.dataset.count)].count = clampCount(inp.value); redraw(); };
    });
    body.querySelectorAll<HTMLSelectElement>('[data-weapon]').forEach((s) => {
      s.onchange = () => { lines[Number(s.dataset.weapon)].weapon = Number(s.value); recount(); };
    });
    body.querySelectorAll<HTMLInputElement>('[data-shoot]').forEach((box) => {
      box.onchange = () => {
        if (box.dataset.shoot === 'hill') form.hill = box.checked;
        if (box.dataset.shoot === 'multi') { form.multi = box.checked; form.lines.forEach((l) => { l.multiRolled = null; }); }
        recount();
      };
    });
    const rollMulti = body.querySelector<HTMLButtonElement>('[data-roll-multi]');
    if (rollMulti) rollMulti.onclick = () => {
      // Würfelwert: für jedes schießende Modell einzeln würfeln
      const all: number[] = [];
      for (const l of lines) {
        const expr = rulesOf(l).multipleShots;
        if (!expr || !isDiceExpr(expr)) continue;
        const each = Array.from({ length: this.modelsShooting(a, l, form) }, () => rollExpr(expr, d6));
        l.multiRolled = each.reduce((s, r) => s + r.total, 0);
        all.push(...each.flatMap((r) => r.dice));
      }
      this.recountShots(a, form);
      this.host.log({ kind: 'roll', dice: [all], text: `${a.info.name}: Multiple Shots → ${lines.map((l) => `${l.line.label} ${l.count}`).join(', ')} shots` });
      redraw();
    };
    this.wireMods(body, form.checked, form.manual, redraw, recount);
    (body.querySelector('[data-cancel]') as HTMLButtonElement).onclick = () => this.host.store.setPrompt(p.id, null);
    (body.querySelector('[data-roll]') as HTMLButtonElement).onclick = () => {
      const results = lines.map((l): LineRoll => {
        const { base, need } = needOf(l);
        const d = roll(l.count);
        const then = need.then ? roll(d.filter((x) => x === 6).length) : [];
        const rerolled = base.reroll && need.need !== null ? roll(misses(d, need.need, then, need.then)) : [];
        const success = successes(d, need.need, then, need.then, rerolled, base.reroll);
        // natürliche 6 (Poisoned Attacks); nicht bei „6, dann x+“
        const sixes = need.then ? 0 : d.filter((x) => x === 6).length + rerolled.filter((x) => x === 6).length;
        return { label: l.line.label, dice: d, then, need: need.need, thenNeed: need.then, rerolled, rerollNeed: base.reroll,
          poison: [], poisonNeed: null, success, sixes };
      });
      stage.hitRolled = results;
      const mods = form.checked.length || form.manual.length
        ? ` [${[...form.checked, ...form.manual.map((m) => `${m.label} ${signed(m.value)}`)].join(', ')}]` : '';
      this.host.log({ kind: 'roll', dice: results.flatMap((r) => [r.dice, r.then, r.rerolled]).filter((x) => x.length),
        text: `${a.info.name} → ${t.info.name}: ${results.map((r, i) => `${r.label} ${lines[i].count}× ${weaponOf(lines[i]).name} on ${needOf(lines[i]).text} → ${r.success}`).join('; ')}${mods}` });
      redraw();
    };
  }

  /**
   * Neues Formular mit allem, was das Spiel erkennt, schon angehakt: bewegt in diesem Zug, lange Reichweite,
   * Plänkler als Ziel, auf einem Hügel; im Nahkampf die Attacken aus dem Basekontakt. Alles lässt sich abhaken.
   */
  private newHitForm(a: UnitState, t: UnitState, mode: AttackMode): HitForm {
    const form: HitForm = {
      lines: attackLines(a, this.units, mode).map((line) => ({ line, weapon: 0, count: line.count, multiRolled: null })),
      checked: [], manual: [], hill: false, multi: false, off: [], notes: {},
    };
    if (mode === 'shooting') {
      const w = form.lines[0] ? this.lineWeapons(form.lines[0].line, mode)[0] : undefined;
      const distance = minChargeDistance(a, t, this.units);
      if (this.host.movedThisTurn(a.id)) form.checked.push('Moving & Shooting');
      if (w?.range != null && distance > w.range / 2) form.checked.push('Long range');
      if (isSkirmish(t)) form.checked.push('Target is skirmishers');
      form.hill = onHill(a, this.host.store.state.objects);
      this.recountShots(a, form);
    } else this.countCombat(a, t, form);
    return form;
  }

  /** Nahkampf: Attacken aus dem Basekontakt (wenn angehakt und Kontakt besteht), sonst Modelle × Attacken */
  private countCombat(a: UnitState, t: UnitState, form: HitForm): void {
    const counts = contactAttacks(form.lines.map((l) => l.line), a, this.units, t);
    form.notes = {};
    for (const l of form.lines) {
      const c = counts?.get(l.line.key);
      if (c) form.notes[l.line.key] = c.note;
      l.count = c && !form.off.includes(CONTACT) ? c.count : l.line.count;
    }
  }

  /** Schießende Modelle der Truppe: erstes Glied (Hügel: zwei), mit Volley Fire die Hälfte jedes weiteren – nicht nach Bewegung oder bei Stand & Shoot */
  private modelsShooting(a: UnitState, l: HitLine, form: HitForm): number {
    const w = this.lineWeapons(l.line, 'shooting')[l.weapon];
    const rules = w ? rulesWithout(w, this.units[l.line.unitId] ?? a, form.off) : shootingRules([]);
    const volley = rules.volley && !form.checked.includes('Moving & Shooting') && !form.checked.includes('Stand & Shoot');
    // Nur die Truppe (erste Zeile) hängt von Gliedern ab; Champion und Charaktere schießen mit je einem Modell
    if (l.line.unitId !== a.id || l.line.row !== 0) return l.line.models;
    const champion = form.lines.some((x) => x.line.unitId === a.id && x.line.row === 1) ? 1 : 0;
    return Math.max(0, shooters(a, this.units, form.hill, volley) - champion);
  }

  /** Schüsse je Zeile nach den Regeln: Modelle; Multiple Shots (X) mal X, bei Würfeln erst nach dem Würfeln */
  private recountShots(a: UnitState, form: HitForm): void {
    for (const l of form.lines) {
      const models = this.modelsShooting(a, l, form);
      const w = this.lineWeapons(l.line, 'shooting')[l.weapon];
      const expr = w ? rulesWithout(w, this.units[l.line.unitId] ?? a, form.off).multipleShots : null;
      l.count = !form.multi || !expr ? models : isDiceExpr(expr) ? l.multiRolled ?? models : models * (Number.parseInt(expr, 10) || 1);
    }
  }

  /** Wer schießt und warum: erstes Glied, Volley Fire, Hügel und Multiple Shots */
  private shootersHtml(a: UnitState, rules: ShootingRules, form: HitForm, moved: boolean, stand: boolean): string {
    const troop = form.lines.find((l) => l.line.unitId === a.id && l.line.row === 0);
    const front = shooters(a, this.units, form.hill, false);
    const all = shooters(a, this.units, form.hill, true);
    const box = (key: string, on: boolean, label: string, hint: string) =>
      `<label class="atk-mod"><input type="checkbox" data-shoot="${key}" ${on ? 'checked' : ''}><span class="atk-label">${label} <span class="atk-hint">${hint}</span></span></label>`;
    const volleyLine = !rules.volley ? ''
      : moved || stand ? `<div class="atk-mod"><span class="atk-label">Volley Fire <span class="atk-hint">not possible: ${moved ? 'the unit moved' : 'Stand & Shoot'}</span></span></div>`
      : `<div class="atk-mod"><span class="atk-label">Volley Fire <span class="atk-hint">half of each further rank, rounded up</span></span><b>+${all - front}</b></div>`;
    const multi = rules.multipleShots;
    const rolled = form.lines.some((l) => l.multiRolled !== null);
    const multiLine = !multi ? '' : box('multi', form.multi, `Fire Multiple Shots (${multi} per model)`, 'each roll To Hit −1')
      + (form.multi && isDiceExpr(multi) ? `<div class="atk-mod"><button data-roll-multi>Roll ${esc(multi)} for each model</button>
          <span class="atk-hint">${rolled ? 'rolled' : 'not rolled yet'}</span></div>` : '');
    return `<div class="atk-mods atk-shooters">
      <div class="atk-base">${troop ? esc(troop.line.label) : 'Unit'}: ${form.hill ? 'front two ranks' : 'front rank'} ${front} models</div>
      ${volleyLine}
      ${box('hill', form.hill, 'On a hill', 'front two ranks shoot')}
      ${multiLine}
    </div>`;
  }

  private showHits(p: Prompt, body: HTMLElement, a: UnitState, mode: AttackMode, lines: HitLine[], rolled: LineRoll[]): void {
    const total = rolled.reduce((s, r) => s + r.success, 0);
    const weaponOf = (l: HitLine) => this.lineWeapons(l.line, mode)[Math.min(l.weapon, this.lineWeapons(l.line, mode).length - 1)];
    const off = (this.host.stage().hit as HitForm | undefined)?.off ?? [];
    const poisonedOf = (l: HitLine, r: LineRoll) =>
      rulesWithout(weaponOf(l), this.units[l.line.unitId] ?? a, off).poisoned ? Math.min(r.sixes, r.success) : 0;
    body.innerHTML = `${rolled.map((r, i) => this.rollRows(r, `${r.label} (${weaponOf(lines[i]).name})`)
      + `<p class="prompt-info">${r.label}: <b>${plural(r.success, 'hit')}</b>${poisonedOf(lines[i], r) ? ` · ${poisonedOf(lines[i], r)} with a natural 6 (Poisoned Attacks: +2 To Wound)` : ''}</p>`).join('')}
      <p class="prompt-info"><b>Total: ${plural(total, 'hit')}</b></p>
      <div class="prompt-actions">${total ? '<button class="primary" data-next>Continue: Roll To Wound ›</button>' : ''}
        <button data-done>${total ? 'Stop here' : 'Done'}</button></div>`;
    const stage = this.host.stage();
    (body.querySelector('[data-done]') as HTMLButtonElement).onclick = () => this.host.store.setPrompt(p.id, null);
    const next = body.querySelector('[data-next]') as HTMLButtonElement | null;
    if (next) next.onclick = () => {
      // Nächstes Popup: Verwundungswurf je Zeile mit ihren Treffern und der Stärke ihrer Waffe
      const wound: WoundLine[] = lines.map((l, i) => ({
        label: l.line.label, weapon: weaponOf(l), hits: rolled[i].success, poisoned: poisonedOf(l, rolled[i]), strength: weaponOf(l).strength,
      })).filter((w) => w.hits);
      for (const k of Object.keys(stage)) delete stage[k];
      // Abgewählte Regeln gelten auch für Verwundung und Rettungswurf
      this.host.store.setPrompt(p.id, { ...p, title: 'Roll To Wound',
        data: { ...p.data, step: 'wound', lines: JSON.stringify(wound), off: JSON.stringify(off) } });
    };
  }

  // --- Verwundungen ---------------------------------------------------------------

  private renderWound(p: Prompt, body: HTMLElement, a: UnitState, t: UnitState): void {
    const stage = this.host.stage();
    const form = (stage.wound as WoundForm | undefined) ?? (stage.wound = {
      lines: parse<WoundLine[]>(p.data.lines, []), toughness: statOf(t, 'T') || 3, manual: [],
    } satisfies WoundForm) as WoundForm;
    const rolled = stage.woundRolled as LineRoll[] | undefined;
    if (rolled) return this.showWounds(p, body, a, t, form, rolled);
    const needOf = (l: WoundLine) => {
      const base = baseToWound(l.strength, form.toughness);
      const need = finalNeed(base.need, form.manual, 'wound');
      const poison = l.poisoned ? finalNeed(base.need, [...form.manual, { label: 'Poisoned Attacks', value: 2 }], 'wound') : null;
      const poisoned = Math.min(l.poisoned, l.hits);
      return { base, need, poison, poisoned,
        text: `${needText(need)}${poison ? ` · ${poisoned} poisoned on ${needText(poison)}` : ''}` };
    };
    const total = form.lines.reduce((s, l) => s + l.hits, 0);
    const rows = form.lines.map((l, i) => {
      const n = needOf(l);
      return `<tr><td><b>${esc(l.label)}</b><br><span class="meta">${esc(l.weapon.name)} · AP ${l.weapon.ap || '–'}</span></td>
        <td><input type="number" min="0" max="200" data-hits="${i}" value="${l.hits}"></td>
        <td><input type="number" min="1" max="10" data-s="${i}" value="${l.strength}"></td>
        <td class="atk-need-cell">${n.base.need > 6 ? 'impossible' : esc(n.text)}<br><span class="meta">${esc(n.base.why)}</span></td></tr>`;
    }).join('');
    body.innerHTML = `<div class="prompt-form"><label>Toughness of ${esc(t.info.name)} <input id="atk-t" type="number" min="1" max="10" value="${form.toughness}"></label></div>
      <table class="atk-lines"><thead><tr><th>Who</th><th>Hits</th><th>S</th><th>To Wound</th></tr></thead><tbody>${rows}</tbody></table>
      ${this.modsHtml('Modifiers <span class="meta">(for all lines)</span>', [], [], form.manual, '')}
      <div class="prompt-actions">
        <button class="primary" data-roll ${!total ? 'disabled' : ''}>Roll To Wound (${dice(total)})</button>
        <button data-cancel>Cancel</button>
      </div>`;
    const redraw = () => this.renderWound(p, body, a, t);
    body.querySelector<HTMLInputElement>('#atk-t')!.onchange = (e) => { form.toughness = clampCount((e.target as HTMLInputElement).value) || 1; redraw(); };
    body.querySelectorAll<HTMLInputElement>('[data-hits]').forEach((inp) => {
      inp.onchange = () => { form.lines[Number(inp.dataset.hits)].hits = clampCount(inp.value); redraw(); };
    });
    body.querySelectorAll<HTMLInputElement>('[data-s]').forEach((inp) => {
      inp.onchange = () => { form.lines[Number(inp.dataset.s)].strength = clampCount(inp.value) || 1; redraw(); };
    });
    this.wireMods(body, [], form.manual, redraw);
    (body.querySelector('[data-cancel]') as HTMLButtonElement).onclick = () => this.host.store.setPrompt(p.id, null);
    (body.querySelector('[data-roll]') as HTMLButtonElement).onclick = () => {
      const results = form.lines.map((l): LineRoll => {
        const n = needOf(l);
        const d = roll(l.hits - n.poisoned);
        const poison = n.poison ? roll(n.poisoned) : [];
        const success = successes(d, n.need.need) + (n.poison ? successes(poison, n.poison.need) : 0);
        // Verwundungen mit einer natürlichen 6 (Armour Bane)
        const sixes = Math.min(success, [...d, ...poison].filter((x) => x === 6).length);
        return { label: l.label, dice: d, then: [], need: n.need.need, thenNeed: null, rerolled: [], rerollNeed: null,
          poison, poisonNeed: n.poison?.need ?? null, success, sixes };
      });
      stage.woundRolled = results;
      this.host.log({ kind: 'roll', dice: results.flatMap((r) => [r.dice, r.poison]).filter((x) => x.length),
        text: `${a.info.name} → ${t.info.name} to wound (T ${form.toughness}): ${results.map((r, i) => `${r.label} ${form.lines[i].hits}× on ${needOf(form.lines[i]).text} → ${r.success}`).join('; ')}` });
      redraw();
    };
  }

  private showWounds(p: Prompt, body: HTMLElement, a: UnitState, t: UnitState, form: WoundForm, rolled: LineRoll[]): void {
    const total = rolled.reduce((s, r) => s + r.success, 0);
    body.innerHTML = `${rolled.map((r, i) => {
      const w = form.lines[i].weapon;
      const bane = armourBane(w.rules);
      return this.rollRows(r, `${r.label} (${w.name})`)
        + `<p class="prompt-info">${r.label}: <b>${plural(r.success, 'wound')}</b>${bane && r.sixes ? ` · ${r.sixes} with a natural 6 (Armour Bane ${bane}: AP ${w.ap - bane})` : ''}</p>`;
    }).join('')}
      <p class="prompt-info"><b>Total: ${plural(total, 'wound')}</b></p>
      <div class="prompt-actions">${total ? `<button class="primary" data-next>Send to ${esc(playerName(t.owner))} for saves ›</button>` : ''}
        <button data-done>${total ? 'Stop here' : 'Done'}</button></div>`;
    (body.querySelector('[data-done]') as HTMLButtonElement).onclick = () => this.host.store.setPrompt(p.id, null);
    const next = body.querySelector('[data-next]') as HTMLButtonElement | null;
    if (!next) return;
    next.onclick = () => {
      // Rettungswürfe je Waffe: AP, Armour Bane und Multiple Wounds können sich unterscheiden
      const groups: SaveGroup[] = rolled.map((r, i) => {
        const w = form.lines[i].weapon;
        const bane = armourBane(w.rules);
        return { label: `${r.label} (${w.name})`, wounds: r.success, ap: w.ap, bane: bane ? r.sixes : 0, baneAp: bane,
          mw: shootingRules(w.rules).multipleWounds ?? '' };
      }).filter((g) => g.wounds);
      this.host.store.setPrompt(p.id, null);
      const saves = unitSaves(t.info);
      this.host.create('saves', t.owner, a.owner, 'Saves: Armour, Ward, Regeneration',
        `${a.info.name}: ${plural(total, 'wound')} against ${t.info.name}.`,
        { targetId: t.id, wounds: total, groups: JSON.stringify(groups), off: String(p.data.off ?? '[]'),
          save: saves.armour ?? '', ward: saves.ward?.value ?? '', regen: saves.regen?.value ?? '' });
    };
  }

  /** Würfelreihen einer Zeile: erster Wurf, „6, dann x+“, Wiederholungen (BS 6+), vergiftete Treffer */
  private rollRows(r: LineRoll, label: string): string {
    const row = (name: string, d: number[], need: number | null) =>
      d.length ? `<div class="dice-row"><span class="dice-label">${esc(name)}</span>${diceHtml(d, need ?? 7)}</div>` : '';
    return row(`${label}${r.need ? ` ${r.thenNeed ? 6 : r.need}+` : ''}`, r.dice, r.thenNeed ? 7 : r.need)
      + row(`Sixes, then ${r.thenNeed}+`, r.then, r.thenNeed)
      + row(`Misses re-rolled, ${r.rerollNeed}+`, r.rerolled, r.rerollNeed)
      + row(`Poisoned, ${r.poisonNeed}+`, r.poison, r.poisonNeed);
  }

  // --- Verteidiger: Rüstung, Rettung, Regeneration ----------------------------

  renderSaves(p: Prompt, body: HTMLElement): void {
    const target = this.units[String(p.data.targetId)];
    if (!target) {
      this.host.finish(p, 'The target is gone.');
      return;
    }
    const stage = this.host.stage();
    // Ältere Aufforderungen ohne Gruppen: alle Wunden in einer Gruppe
    const groups = parse<SaveGroup[]>(p.data.groups, [{ label: String(p.data.weapon ?? 'Attack'), wounds: Number(p.data.wounds) || 0,
      ap: Number(p.data.ap) || 0, bane: Number(p.data.bane) || 0, baneAp: Number(p.data.baneAp) || 0, mw: String(p.data.mw ?? '') }]);
    const wounds = groups.reduce((s, g) => s + g.wounds, 0);
    type SaveForm = { armour: number | null; ward: number | null; regen: number | null; manual: RollMod[]; off: string[] };
    const num = (v: unknown) => (Number(v) >= 1 && Number(v) <= 6 ? Number(v) : null);
    const form = (stage.saveForm as SaveForm | undefined) ?? (stage.saveForm = {
      armour: num(p.data.save), ward: num(p.data.ward), regen: num(p.data.regen), manual: [], off: parse<string[]>(p.data.off, []),
    }) as SaveForm;
    const done = stage.saves as SavesRolled | undefined;
    if (done) return this.showSaves(p, body, target, done);

    // Regeln der Waffe sind angehakt und lassen sich abwählen: AP für alle Wunden der Gruppe, Armour Bane für die mit
    // einer natürlichen 6, Multiple Wounds; eigene Modifikatoren (z. B. Schild nur von vorn) gelten für alle
    const useAp = !form.off.includes('AP');
    const useBane = !form.off.includes('Armour Bane');
    const useMw = !form.off.includes('Multiple Wounds');
    const needs = (g: SaveGroup) => {
      const ap = useAp && g.ap ? [{ label: `AP ${g.ap}`, value: g.ap }] : [];
      const normal = form.armour ? finalNeed(form.armour, [...ap, ...form.manual], 'save') : { need: null, then: null };
      const bane = useBane && form.armour && g.bane && g.baneAp
        ? finalNeed(form.armour, [...ap, ...form.manual, { label: 'Armour Bane', value: -g.baneAp }], 'save') : null;
      return { normal, bane, baned: bane ? Math.min(g.bane, g.wounds) : 0 };
    };
    const rows = groups.map((g) => {
      const n = needs(g);
      const armour = !form.armour ? 'no armour save'
        : n.bane ? `${g.wounds - n.baned} at ${needText(n.normal)}, ${n.baned} at ${needText(n.bane)} (Armour Bane ${g.baneAp})`
        : needText(n.normal);
      return `<tr><td><b>${esc(g.label)}</b>${g.mw && useMw ? `<br><span class="meta">Multiple Wounds (${esc(g.mw)})</span>` : ''}</td>
        <td>${g.wounds}</td><td>${useAp && g.ap ? signed(g.ap) : '–'}</td><td class="atk-need-cell">${esc(armour)}</td></tr>`;
    }).join('');
    const saveRules = [
      ...(groups.some((g) => g.ap) ? [{ name: 'AP', hint: 'weapon AP worsens the armour save' }] : []),
      ...(groups.some((g) => g.bane && g.baneAp) ? [{ name: 'Armour Bane', hint: 'wounds from a natural 6 get better AP' }] : []),
      ...(groups.some((g) => g.mw) ? [{ name: 'Multiple Wounds', hint: 'each unsaved wound counts several times' }] : []),
    ];
    body.innerHTML = `<div class="prompt-form">
        <label>Armour Save <select id="sv-armour">${saveOptions(form.armour)}</select></label>
        <label>Ward Save <select id="sv-ward">${saveOptions(form.ward)}</select></label>
        <label>Regeneration Save <select id="sv-regen">${saveOptions(form.regen)}</select></label>
      </div>
      <table class="atk-lines"><thead><tr><th>Wounds from</th><th>Wounds</th><th>AP</th><th>Armour</th></tr></thead><tbody>${rows}</tbody></table>
      ${ruleBoxes(saveRules, form.off)}
      ${this.modsHtml('Armour Save modifiers <span class="meta">(for all wounds; AP and Armour Bane are already in the table)</span>', [], [], form.manual, '')}
      <p class="prompt-info">Ward and Regeneration saves are not modified by AP.</p>
      <div class="prompt-actions"><button class="primary" data-roll>Roll saves (${plural(wounds, 'wound')})</button></div>`;
    const redraw = () => this.renderSaves(p, body);
    for (const [id, key] of [['sv-armour', 'armour'], ['sv-ward', 'ward'], ['sv-regen', 'regen']] as const) {
      const s = body.querySelector<HTMLSelectElement>(`#${id}`)!;
      s.onchange = () => { form[key] = num(s.value); redraw(); };
    }
    this.wireMods(body, [], form.manual, redraw);
    wireRules(body, form.off, redraw);
    (body.querySelector('[data-roll]') as HTMLButtonElement).onclick = () => {
      // Je Gruppe nacheinander: Rüstung, dann Rettung, dann Regeneration – jeweils für die noch übrigen Wunden;
      // danach Multiple Wounds je unverhinderter Verwundung
      const rowsOut: SavesRolled['rows'] = [];
      const parts: string[] = [];
      const perWound: number[] = [];
      const allDice: number[][] = [];
      let unsaved = 0;
      for (const g of groups) {
        const n = needs(g);
        const steps: string[] = [plural(g.wounds, 'wound')];
        const roll1 = (count: number, need: number | null, name: string) => {
          if (!count || need === null) return 0;
          const d = roll(count);
          const saved = d.filter((x) => x >= need).length;
          rowsOut.push({ label: `${g.label}: ${name}`, dice: d, need });
          allDice.push(d);
          steps.push(`${saved} saved by ${name} (${need}+)`);
          return saved;
        };
        let left = g.wounds;
        left -= roll1(g.wounds - n.baned, n.normal.need, 'armour');
        left -= roll1(n.baned, n.bane?.need ?? null, 'armour (Armour Bane)');
        left -= roll1(left, form.ward, 'ward');
        left -= roll1(left, form.regen, 'regeneration');
        steps.push(`${left} unsaved`);
        const each = useMw && g.mw && left ? Array.from({ length: left }, () => rollExpr(g.mw, d6)) : [];
        if (each.length) {
          steps.push(`Multiple Wounds (${g.mw}): ${each.map((r) => r.total).join(' + ')} Wounds`);
          allDice.push(each.flatMap((r) => r.dice));
        }
        perWound.push(...(each.length ? each.map((r) => r.total) : Array.from({ length: left }, () => 1)));
        unsaved += left;
        parts.push(`${g.label}: ${steps.join(' → ')}`);
      }
      const text = parts.join('; ');
      stage.saves = { rows: rowsOut, unsaved, perWound, text } satisfies SavesRolled;
      this.host.log({ kind: 'roll', text: `${target.info.name}: ${text}`, dice: allDice.filter((d) => d.length) });
      redraw();
    };
  }

  private showSaves(p: Prompt, body: HTMLElement, target: UnitState, done: SavesRolled): void {
    const perModel = target.info.woundsPerModel ?? 1;
    const single = (target.info.startModels ?? target.models) === 1;
    // Einzelmodell: alle verlorenen Lebenspunkte zählen; Einheit: überzählige Wounds einer Verwundung verfallen
    const lost = done.perWound.reduce((s, w) => s + (single ? w : Math.min(w, perModel)), 0);
    const losses = single ? lost : Math.floor(lost / perModel);
    body.innerHTML = `${done.rows.map((r) => `<div class="dice-row"><span class="dice-label">${esc(r.label)} ${r.need}+</span>${diceHtml(r.dice, r.need ?? 7)}</div>`).join('')}
      <p class="prompt-info"><b>${done.unsaved} unsaved.</b> ${esc(done.text)}</p>
      <div class="prompt-actions">
        ${done.unsaved ? `<button class="primary" data-apply>${single ? `Remove ${plural(losses, 'Wound')}` : `Remove ${plural(losses, 'model')}`}</button>` : ''}
        <button data-ok>${done.unsaved ? 'Apply by hand' : 'Done'}</button>
      </div>`;
    const apply = body.querySelector('[data-apply]') as HTMLButtonElement | null;
    if (apply) apply.onclick = () => {
      this.host.history.record();
      if (single) this.host.store.updateUnit(target.id, { woundsLost: (target.woundsLost ?? 0) + losses });
      // Alle Modelle verloren: Einheit gilt als vernichtet (bleibt für die Siegpunkte sichtbar)
      else if (target.models - losses <= 0) this.host.store.updateUnit(target.id, { status: 'destroyed' });
      else this.host.store.updateUnit(target.id, { models: target.models - losses });
      this.host.finish(p, `${target.info.name}: ${done.text}; ${single ? `${losses} Wounds lost` : `${losses} models removed`}.`);
    };
    (body.querySelector('[data-ok]') as HTMLButtonElement).onclick = () => this.host.finish(p, `${target.info.name}: ${done.text}.`);
  }

  // --- Modifikatoren ----------------------------------------------------------

  /**
   * Überschrift, feste Einträge aus den Waffenregeln (•), Lage zum Anhaken (mit Hinweis), eigene Einträge (mit ×)
   * und eine Zeile zum Hinzufügen; unten der nötige Wurf (wenn angegeben).
   */
  private modsHtml(base: string, situation: RollMod[], checked: string[], manual: RollMod[], need: string, fixed: RollMod[] = []): string {
    const row = (m: RollMod, control: string) =>
      `<label class="atk-mod${m.value < 0 ? ' minus' : m.value > 0 ? ' plus' : ''}">${control}<span class="atk-label">${esc(m.label)}${m.hint ? ` <span class="atk-hint">${esc(m.hint)}</span>` : ''}</span><b>${signed(m.value)}</b></label>`;
    const values = [-3, -2, -1, 1, 2, 3].map((v) => `<option value="${v}" ${v === -1 ? 'selected' : ''}>${signed(v)}</option>`).join('');
    return `<div class="atk-mods">
      <div class="atk-base">${base}</div>
      ${fixed.map((m) => row(m, '<span class="atk-fixed">•</span>')).join('')}
      ${situation.map((m) => row(m, `<input type="checkbox" data-opt="${esc(m.label)}" ${checked.includes(m.label) ? 'checked' : ''}>`)).join('')}
      ${manual.map((m, i) => row(m, `<button class="atk-del" data-del="${i}" title="Remove">×</button>`)).join('')}
      <div class="atk-add"><input id="atk-mlabel" placeholder="Add modifier, e.g. Hatred"><select id="atk-mval">${values}</select><button data-add>Add</button></div>
      ${need ? `<div class="atk-need">Roll needed: <b>${esc(need)}</b></div>` : ''}
    </div>`;
  }

  /** @param onCheck nach dem An- oder Abhaken einer Lage (z. B. Schüsse neu zählen); sonst nur neu zeichnen */
  private wireMods(body: HTMLElement, checked: string[], manual: RollMod[], redraw: () => void, onCheck = redraw): void {
    body.querySelectorAll<HTMLInputElement>('[data-opt]').forEach((box) => {
      box.onchange = () => {
        const i = checked.indexOf(box.dataset.opt!);
        if (box.checked && i < 0) checked.push(box.dataset.opt!);
        if (!box.checked && i >= 0) checked.splice(i, 1);
        onCheck();
      };
    });
    body.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((b) => {
      b.onclick = () => { manual.splice(Number(b.dataset.del), 1); redraw(); };
    });
    const label = body.querySelector<HTMLInputElement>('#atk-mlabel')!;
    const add = () => {
      const value = Number(body.querySelector<HTMLSelectElement>('#atk-mval')!.value);
      manual.push({ label: label.value.trim() || 'Modifier', value });
      redraw();
    };
    (body.querySelector('[data-add]') as HTMLButtonElement).onclick = add;
    label.onkeydown = (e) => { if (e.key === 'Enter') add(); };
  }
}

interface SavesRolled {
  rows: { label: string; dice: number[]; need: number | null }[];
  unsaved: number;
  /** Verlorene Wounds je unverhinderter Verwundung (Multiple Wounds, sonst 1) */
  perWound: number[];
  text: string;
}
