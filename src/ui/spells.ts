import type { History } from '../model/history';
import { playerName } from '../model/players';
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
 * Zauber: je Zauberer die Lore wählen und die Sprüche auswürfeln (je Stufe ein W6, doppelte werden neu
 * gewürfelt). Der Signature Spell steht immer dabei. Das Ergebnis gehört zur Einheit und ist für beide sichtbar.
 */
export class SpellsPanel {
  private lores: Lore[] = [];
  /** Aufgeklappte Spruchtexte (Einheit:Spruch) */
  private open = new Set<string>();

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
      const sel = (e.target as HTMLElement).closest<HTMLSelectElement>('select[data-lore]');
      if (!sel) return;
      this.history.record();
      this.store.updateUnit(sel.dataset.lore!, { lore: sel.value || null, spells: null });
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

  private mayAct(p: PlayerId): boolean {
    const s = this.seat();
    return s !== 'spectator' && (!s || s === p);
  }

  private onClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    const gen = t.closest<HTMLButtonElement>('button[data-generate]');
    if (gen) return this.generate(gen.dataset.generate!);
    const sp = t.closest<HTMLButtonElement>('button[data-spell]');
    if (sp) {
      const k = sp.dataset.spell!;
      if (this.open.has(k)) this.open.delete(k); else this.open.add(k);
      this.render();
    }
  }

  /** Je Stufe ein W6 auf die Tabelle der Lore (1–6); doppelte Ergebnisse werden neu gewürfelt */
  private generate(id: string): void {
    const u = this.store.state.units[id];
    const lore = u && this.loreOf(u);
    if (!u || !lore) return;
    const numbered = lore.spells.filter((s) => /^\d$/.test(s.type));
    const count = Math.min(wizardLevel(u) || 1, numbered.length);
    const dice: number[] = [];
    const picked: Spell[] = [];
    if (numbered.length >= 6) {
      while (picked.length < count) {
        const d = d6();
        dice.push(d);
        const s = numbered.find((x) => Number(x.type) === d);
        if (s && !picked.includes(s)) picked.push(s);
      }
    } else {
      // Kleine Lores (z. B. Fraktionslores ohne Tabelle): alle Sprüche
      picked.push(...lore.spells);
    }
    this.history.record();
    this.store.updateUnit(id, { lore: lore.slug, spells: picked.map((s) => s.slug) });
    this.log({ kind: 'roll', dice: dice.length ? [dice] : undefined,
      text: `${u.info.name} generates spells (${lore.name}): ${picked.map((s) => s.name).join(', ')}` });
  }

  private render(): void {
    const units = Object.values(this.store.state.units).filter((u) => wizardLevel(u) > 0 && u.status !== 'destroyed');
    const loreOptions = (cur?: string) => `<option value="">– choose lore –</option>` + this.lores
      .map((l) => `<option value="${l.slug}" ${l.slug === cur ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
    const spellHtml = (u: UnitState, s: Spell, tag: string) => {
      const k = `${u.id}:${s.slug}`;
      return `<li><button class="rule-link${this.open.has(k) ? ' on' : ''}" data-spell="${k}">${esc(s.name)}</button>
        <span class="meta">${tag} · ${s.castingValue ?? '–'}+ · ${esc(s.range || '–')}</span>
        ${this.open.has(k) ? `<p class="spell-text">${esc(s.text)}</p>` : ''}</li>`;
    };
    $('spells-list').innerHTML = (['p1', 'p2'] as const).map((p) => {
      const wizards = units.filter((u) => u.owner === p);
      return `<section><h4><span class="dot ${p}"></span>${playerName(p)}</h4>` + (wizards.map((u) => {
        const lore = this.loreOf(u);
        const known = (u.spells ?? []).map((slug) => lore?.spells.find((s) => s.slug === slug)).filter((s): s is Spell => !!s);
        const signature = lore?.spells.filter((s) => /signature/i.test(s.type) && !known.includes(s)) ?? [];
        const can = this.mayAct(u.owner);
        return `<div class="wizard">
          <p><b>${esc(u.info.name)}</b> <span class="meta">Level ${wizardLevel(u)} Wizard${isJoined(u, this.store.state.units) ? ' · joined' : ''}</span></p>
          <div class="wizard-row"><select data-lore="${u.id}" ${can ? '' : 'disabled'}>${loreOptions(lore?.slug)}</select>
            <button data-generate="${u.id}" class="primary" ${can && lore ? '' : 'disabled'}>🎲 ${known.length ? 'Re-roll' : 'Generate'} spells</button></div>
          ${known.length || signature.length ? `<ul class="spells">${known.map((s) => spellHtml(u, s, /^\d$/.test(s.type) ? `Spell ${s.type}` : s.type)).join('')}
            ${signature.map((s) => spellHtml(u, s, 'Signature spell (may replace one)')).join('')}</ul>` : ''}
        </div>`;
      }).join('') || '<p class="meta">No wizards.</p>') + '</section>';
    }).join('');
  }
}
