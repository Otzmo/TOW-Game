import type { History } from '../model/history';
import { playerName } from '../model/players';
import { isDestroyed } from '../model/score';
import { isJoined, type Store } from '../model/store';
import type { LogEntry, PlayerId, UnitState } from '../model/types';

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const d6 = () => 1 + Math.floor(crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32 * 6);

interface Spell { name: string; slug: string; type: string; castingValue: number | null; range: string; text: string }
interface Lore { name: string; slug: string; intro: string; spells: Spell[] }

/** "Lore of Battle Magic", "Battle Magic" → "battle magic" zum Vergleichen */
const loreKey = (s: string) => s.toLowerCase().replace(/^lore of (the )?/, '').replace(/[^a-z]+/g, ' ').trim();

/** Zauberstufe aus Optionen und Regeln, z. B. "Level 4 wizard" */
export function wizardLevel(u: UnitState): number {
  const texts = [...u.info.options, ...u.info.rules.map((r) => r.name)];
  for (const t of texts) {
    const m = /level\s*(\d)\s*wizard/i.exec(t);
    if (m) return Number(m[1]);
  }
  return 0;
}

/**
 * Zauber: je Zauberer die Lore wählen, beliebig viele Sprüche auswürfeln (je Spruch ein W6, doppelte werden
 * neu gewürfelt), dann die gewünschten auswählen – die übrigen verschwinden. Sprüche lassen sich auch von Hand
 * hinzufügen und wieder entfernen. Das Ergebnis gehört zur Einheit und ist für beide sichtbar.
 */
export class SpellsPanel {
  private lores: Lore[] = [];
  /** Aufgeklappte Spruchtexte (Einheit:Spruch) */
  private open = new Set<string>();
  /** Ausgewürfelte, noch nicht ausgewählte Sprüche je Einheit; angehakt = behalten */
  private rolled = new Map<string, { slugs: string[]; keep: Set<string> }>();

  constructor(
    private store: Store,
    private history: History,
    private seat: () => PlayerId | 'spectator' | null,
    private log: (entry: Pick<LogEntry, 'kind' | 'text' | 'dice'>) => void,
  ) {
    fetch(`${import.meta.env.BASE_URL}data/spells.json`).then((r) => (r.ok ? r.json() : [])).catch(() => [])
      .then((l: Lore[]) => { this.lores = l.sort((a, b) => loreKey(a.name).localeCompare(loreKey(b.name))); this.render(); });
    $('spells-list').onclick = (e) => this.onClick(e);
    $('spells-list').onchange = (e) => {
      const t = e.target as HTMLElement;
      const sel = t.closest<HTMLSelectElement>('select[data-lore]');
      if (sel) {
        this.history.record();
        this.rolled.delete(sel.dataset.lore!);
        this.store.updateUnit(sel.dataset.lore!, { lore: sel.value || null, spells: null });
      }
      const box = t.closest<HTMLInputElement>('input[data-keep]');
      if (box) {
        const [id, slug] = box.dataset.keep!.split('|');
        const r = this.rolled.get(id);
        if (r) { if (box.checked) r.keep.add(slug); else r.keep.delete(slug); }
      }
    };
    store.subscribe((_, c) => { if (c.unitId || c.loaded || c.replacedOwner) this.render(); });
  }

  /** Lore der Einheit: gewählt oder aus der Armeeliste ("Lore of Battle Magic") */
  private loreOf(u: UnitState): Lore | undefined {
    if (u.lore) return this.lores.find((l) => l.slug === u.lore);
    for (const o of u.info.options) {
      if (!/^lore of/i.test(o)) continue;
      const found = this.lores.find((l) => loreKey(l.name) === loreKey(o));
      if (found) return found;
    }
    return undefined;
  }

  private spell(slug: string): Spell | undefined {
    for (const l of this.lores) {
      const s = l.spells.find((x) => x.slug === slug);
      if (s) return s;
    }
    return undefined;
  }

  private mayAct(p: PlayerId): boolean {
    const s = this.seat();
    return s !== 'spectator' && (!s || s === p);
  }

  private onClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    const btn = t.closest<HTMLButtonElement>('button[data-act]');
    if (btn) {
      const id = btn.dataset.unit!;
      const act = btn.dataset.act!;
      if (act === 'roll') this.roll(id);
      if (act === 'keep') this.keep(id);
      if (act === 'add') this.add(id);
      if (act === 'remove') this.remove(id, btn.dataset.spell!);
      return;
    }
    const sp = t.closest<HTMLButtonElement>('button[data-spell-text]');
    if (sp) {
      const k = sp.dataset.spellText!;
      if (this.open.has(k)) this.open.delete(k); else this.open.add(k);
      this.render();
    }
  }

  /** Gewünschte Anzahl Sprüche auswürfeln (W6 auf die Tabelle der Lore, doppelte neu); danach auswählen */
  private roll(id: string): void {
    const u = this.store.state.units[id];
    const lore = u && this.loreOf(u);
    if (!u || !lore) return;
    const numbered = lore.spells.filter((s) => /^\d$/.test(s.type));
    const input = document.querySelector<HTMLInputElement>(`input[data-count="${id}"]`);
    const wanted = Math.max(1, Math.round(Number(input?.value) || wizardLevel(u) || 1));
    const dice: number[] = [];
    const picked: Spell[] = [];
    if (numbered.length >= 6) {
      const count = Math.min(wanted, numbered.length);
      while (picked.length < count) {
        const d = d6();
        dice.push(d);
        const s = numbered.find((x) => Number(x.type) === d);
        if (s && !picked.includes(s)) picked.push(s);
      }
    } else {
      // Kleine Lores ohne Tabelle (z. B. Fraktionslores): alle Sprüche zur Auswahl
      picked.push(...lore.spells);
    }
    // Zur Auswahl stehen die gewürfelten Sprüche und der Signature Spell; vorausgewählt sind die gewürfelten
    const signature = lore.spells.filter((s) => /signature/i.test(s.type) && !picked.includes(s));
    this.rolled.set(id, { slugs: [...picked, ...signature].map((s) => s.slug), keep: new Set(picked.map((s) => s.slug)) });
    this.log({ kind: 'roll', dice: dice.length ? [dice] : undefined,
      text: `${u.info.name} rolls ${dice.length || picked.length} spell${picked.length === 1 ? '' : 's'} (${lore.name}): ${picked.map((s) => s.name).join(', ')}` });
    this.render();
  }

  /** Ausgewählte Sprüche übernehmen, die übrigen verschwinden */
  private keep(id: string): void {
    const u = this.store.state.units[id];
    const r = this.rolled.get(id);
    if (!u || !r) return;
    const kept = r.slugs.filter((s) => r.keep.has(s));
    this.rolled.delete(id);
    this.history.record();
    this.store.updateUnit(id, { lore: this.loreOf(u)?.slug ?? u.lore ?? null, spells: kept });
    this.log({ kind: 'action', text: `${u.info.name} knows: ${kept.map((s) => this.spell(s)?.name ?? s).join(', ') || 'no spells'}` });
  }

  /** Spruch von Hand hinzufügen (aus jeder Lore) */
  private add(id: string): void {
    const u = this.store.state.units[id];
    const sel = document.querySelector<HTMLSelectElement>(`select[data-add="${id}"]`);
    if (!u || !sel?.value || (u.spells ?? []).includes(sel.value)) return;
    this.history.record();
    this.store.updateUnit(id, { spells: [...(u.spells ?? []), sel.value] });
    this.log({ kind: 'action', text: `${u.info.name} adds the spell ${this.spell(sel.value)?.name ?? sel.value}` });
  }

  private remove(id: string, slug: string): void {
    const u = this.store.state.units[id];
    if (!u) return;
    this.history.record();
    this.store.updateUnit(id, { spells: (u.spells ?? []).filter((s) => s !== slug) });
  }

  private render(): void {
    // Eingaben (Anzahl, Auswahl) nicht beim Tippen überschreiben
    if ($('spells-list').contains(document.activeElement) && (document.activeElement as HTMLElement).tagName !== 'BUTTON') return;
    const units = Object.values(this.store.state.units).filter((u) => wizardLevel(u) > 0 && !isDestroyed(u));
    const loreOptions = (cur?: string) => `<option value="">– choose lore –</option>` + this.lores
      .map((l) => `<option value="${l.slug}" ${l.slug === cur ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
    // Alle Sprüche zum Hinzufügen, nach Lore gruppiert; die eigene Lore zuerst
    const addOptions = (lore?: Lore) => `<option value="">– add a spell –</option>` +
      [...(lore ? [lore] : []), ...this.lores.filter((l) => l !== lore)].map((l) =>
        `<optgroup label="${esc(l.name)}">${l.spells.map((s) => `<option value="${s.slug}">${esc(s.name)}</option>`).join('')}</optgroup>`).join('');
    const tag = (s: Spell) => (/^\d$/.test(s.type) ? `Spell ${s.type}` : s.type);
    const spellLine = (u: UnitState, s: Spell, extra: string) => {
      const k = `${u.id}:${s.slug}`;
      return `<li>${extra}<button class="rule-link${this.open.has(k) ? ' on' : ''}" data-spell-text="${k}">${esc(s.name)}</button>
        <span class="meta">${tag(s)} · ${s.castingValue ?? '–'}+ · ${esc(s.range || '–')}</span>
        ${this.open.has(k) ? `<p class="spell-text">${esc(s.text)}</p>` : ''}</li>`;
    };
    $('spells-list').innerHTML = (['p1', 'p2'] as const).map((p) => {
      const wizards = units.filter((u) => u.owner === p);
      return `<section><h4><span class="dot ${p}"></span>${playerName(p)}</h4>` + (wizards.map((u) => {
        const lore = this.loreOf(u);
        const can = this.mayAct(u.owner);
        const dis = can ? '' : 'disabled';
        const known = (u.spells ?? []).map((slug) => this.spell(slug)).filter((s): s is Spell => !!s);
        const r = this.rolled.get(u.id);
        const choose = r ? `<div class="spell-choice"><p class="meta">Tick the spells to keep, the others disappear:</p>
            <ul class="spells">${r.slugs.map((slug) => this.spell(slug)).filter((s): s is Spell => !!s).map((s) =>
              spellLine(u, s, `<input type="checkbox" data-keep="${u.id}|${s.slug}" ${r.keep.has(s.slug) ? 'checked' : ''} ${dis}> `)).join('')}</ul>
            <button data-act="keep" data-unit="${u.id}" class="primary" ${dis}>Keep selected ✓</button></div>` : '';
        return `<div class="wizard">
          <p><b>${esc(u.info.name)}</b> <span class="meta">Level ${wizardLevel(u)} Wizard${isJoined(u, this.store.state.units) ? ' · joined' : ''}</span></p>
          <div class="wizard-row"><select data-lore="${u.id}" ${dis}>${loreOptions(lore?.slug)}</select></div>
          <div class="wizard-row"><label class="spell-count">Spells <input type="number" min="1" max="6" data-count="${u.id}" value="${wizardLevel(u) || 1}" ${dis}></label>
            <button data-act="roll" data-unit="${u.id}" class="primary" ${can && lore ? '' : 'disabled'}>🎲 Roll spells</button></div>
          ${choose}
          ${known.length ? `<ul class="spells">${known.map((s) => spellLine(u, s,
            can ? `<button class="spell-remove" data-act="remove" data-unit="${u.id}" data-spell="${s.slug}" title="Remove this spell">×</button> ` : '')).join('')}</ul>`
            : r ? '' : '<p class="meta">No spells yet.</p>'}
          <div class="wizard-row"><select data-add="${u.id}" ${dis}>${addOptions(lore)}</select>
            <button data-act="add" data-unit="${u.id}" ${dis}>+ Add</button></div>
        </div>`;
      }).join('') || '<p class="meta">No wizards.</p>') + '</section>';
    }).join('');
  }
}
