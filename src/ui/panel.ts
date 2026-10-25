import type { Store } from '../model/store';
import {
  canSkirmish, isJoined, isNonUnitChange, isSkirmish, joinedCharacters, SKIRMISH_GAP, spreadPositions, unitLayout,
} from '../model/store';
import type { History } from '../model/history';
import { armourInfo, loadWeapons, optionInfo, unitSaves, unitWeapons, visibleOptions, visibleRules, weaponRule } from '../model/gear';
import { hasStandard, unitVictoryPoints, wounds } from '../model/score';
import type { RuleRef, UnitState, UnitStatus } from '../model/types';
import { PLAYER_COLORS } from '../view/theme';

const $ = (id: string) => document.getElementById(id)!;

/** Vergleichsschlüssel für Regel- und Optionsnamen: ohne Klammerwerte, Groß-/Kleinschreibung und Satzzeichen */
const ruleKey = (s: string) => s.toLowerCase().replace(/\([^)]*\)/g, '').replace(/[^a-z0-9]/g, '');

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function ruleHtml(r: RuleRef): string {
  const note = r.note ? `<span class="note">${escapeHtml(r.note)}</span>` : '';
  const link = r.url ? `\n<a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">Full text ↗</a>` : '';
  return `<details><summary>${escapeHtml(r.name)}${note}</summary><p>${escapeHtml(r.text || 'No text found.')}${link}</p></details>`;
}

export interface PanelActions {
  close(): void;
  select(unitId: string): void;
  detach(charId: string): void;
  showRanges(on: boolean): void;
}

/** Seitenpanel mit allen Angaben zur ausgewählten Einheit. */
export class UnitPanel {
  private unitId: string | null = null;
  /** Aufgeklappter Begriff ("Abschnitt:Name") und die Erklärungen der zuletzt gezeichneten Begriffe */
  private infoOpen: string | null = null;
  private infoRefs = new Map<string, RuleRef>();
  /** Phasenregeln: Umformieren zählt als Bewegung */
  canMove: (unitId: string) => boolean = () => true;
  private lastAction = new Map<string, string>();

  constructor(private store: Store, private history: History, actions: PanelActions) {
    // Waffenprofile kommen aus einer eigenen Datei; sobald sie da ist, neu zeichnen
    void loadWeapons().then(() => this.render());
    // Begriff anklicken (Waffe, Waffenregel, Rüstungsteil …): Erklärung im Abschnitt zeigen bzw. schließen
    $('panel').addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-info]');
      if (!btn) return;
      this.infoOpen = this.infoOpen === btn.dataset.info ? null : btn.dataset.info!;
      this.render();
    });
    $('p-close').onclick = () => actions.close();
    $('p-rank').onclick = () => this.arrangeInRanks();
    ($('p-ranges') as HTMLInputElement).onchange = (e) => actions.showRanges((e.target as HTMLInputElement).checked);
    $('p-status').onclick = (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (btn) this.change({ status: (btn.dataset.status || null) as UnitStatus | null });
    };
    $('p-wounds-row').onclick = (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
      const u = this.unit();
      if (!btn || !u) return;
      const lost = u.woundsLost ?? 0;
      const total = wounds(u).total;
      this.change({ woundsLost: btn.dataset.wound === 'lose' ? Math.min(total, lost + 1) : Math.max(0, lost - 1) });
    };
    ($('p-captured') as HTMLInputElement).onchange = (e) => {
      this.change({ standardCaptured: (e.target as HTMLInputElement).checked });
    };
    ($('p-points') as HTMLInputElement).onchange = (e) => {
      const u = this.unit();
      const points = Math.max(0, Math.round(Number((e.target as HTMLInputElement).value) || 0));
      if (u) this.change({ info: { ...u.info, points } });
    };
    document.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((btn) => {
      btn.onclick = () => this.onFormation(btn.dataset.act!);
    });
    document.querySelectorAll<HTMLButtonElement>('[data-form]').forEach((btn) => {
      btn.onclick = () => this.setFormation(btn.dataset.form as 'close' | 'skirmish');
    });
    $('p-join').onclick = (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!btn) return;
      if (btn.dataset.select) actions.select(btn.dataset.select);
      if (btn.dataset.detach) actions.detach(btn.dataset.detach);
    };
    store.subscribe((_, change) => {
      if (isNonUnitChange(change)) return;
      const { unitId, patch } = change;
      if (!unitId || unitId === this.unitId || (patch && 'joinedTo' in patch)) this.render();
    });
  }

  show(unitId: string | null): void {
    if (unitId !== this.unitId) this.infoOpen = null;
    this.unitId = unitId;
    this.render();
  }

  setLastAction(unitId: string, text: string): void {
    this.lastAction.set(unitId, text);
    if (unitId === this.unitId) this.render();
  }

  private unit(): UnitState | undefined {
    return this.unitId ? this.store.state.units[this.unitId] : undefined;
  }

  /** Änderung an der ausgewählten Einheit, rückgängig machbar. */
  change(patch: Partial<UnitState>): void {
    const u = this.unit();
    if (!u) return;
    this.history.record();
    this.store.updateUnit(u.id, patch);
  }

  /** Breite (w-/w+) oder Modellzahl (m-/m+) der ausgewählten Einheit ändern */
  onFormation(act: string): void {
    const units = this.store.state.units;
    const u = this.unit();
    if (!u) return;
    // Plänkler haben keine Glieder; die Breite gilt dort für "In Reihen ordnen"
    const cols = isSkirmish(u) ? Math.min(u.width, u.models) : unitLayout(u, units).cols;
    const max = isSkirmish(u) ? u.models : unitLayout(u, units).slots.length;
    if ((act === 'w-' || act === 'w+') && !this.canMove(u.id)) return;
    if (act === 'w-') this.change({ width: Math.max(1, cols - 1) });
    if (act === 'w+') this.change({ width: Math.min(max, cols + 1) });
    if (act === 'm-') this.change({ models: Math.max(1, u.models - 1) });
    if (act === 'm+') this.change({ models: u.models + 1 });
  }

  /** Plänkler in Reihen mit 0,5″ Abstand aufstellen (Breite wie eingestellt). */
  arrangeInRanks(): void {
    const u = this.unit();
    if (!u || !isSkirmish(u) || !this.canMove(u.id)) return;
    this.change({ positions: spreadPositions(u, this.store.state.units) });
    this.setLastAction(u.id, 'arranged in ranks 0.5″ apart');
  }

  /** Zwischen geschlossener Formation und Plänklern wechseln, falls erlaubt */
  toggleFormation(): void {
    const u = this.unit();
    if (u && (canSkirmish(u) || isSkirmish(u))) this.setFormation(isSkirmish(u) ? 'close' : 'skirmish');
  }

  /** Reichweiten-Anzeige umschalten (wie das Häkchen) */
  toggleRanges(): void {
    const box = $('p-ranges') as HTMLInputElement;
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change'));
  }

  setFormation(form: 'close' | 'skirmish'): void {
    const units = this.store.state.units;
    const u = this.unit();
    if (!u || (u.formation ?? 'close') === form || !this.canMove(u.id)) return;
    this.history.record();
    if (form === 'skirmish') {
      // Geschlossene Aufstellung locker auseinanderziehen
      this.store.updateUnit(u.id, { formation: 'skirmish', positions: spreadPositions(u, units) });
    } else {
      this.store.updateUnit(u.id, { formation: 'close', positions: null });
    }
    this.setLastAction(u.id, form === 'skirmish' ? 'changed to skirmish formation' : 'changed to close order formation');
  }

  private render(): void {
    const units = this.store.state.units;
    const u = this.unitId ? units[this.unitId] : undefined;
    $('panel').hidden = !u;
    if (!u) return;
    const { info } = u;
    const { cols, ranks, w, h, stray } = unitLayout(u, units);
    const joined = isJoined(u, units);
    const skirmish = isSkirmish(u);

    $('p-swatch').style.background = PLAYER_COLORS[u.owner].css;
    $('p-name').textContent = info.name;
    const base = `Base ${info.baseWidth}×${info.baseDepth} mm`;
    const warn = stray.size ? ` · <span class="warn-line">${stray.size} beyond ${SKIRMISH_GAP}″</span>` : '';
    $('p-meta').innerHTML = joined
      ? `${u.models} model · ${base}`
      : skirmish
        ? `${u.models} models · ${base} · Skirmish · footprint ${w.toFixed(1)}″ × ${h.toFixed(1)}″${warn}`
        : `${u.models} models · ${base} · formation ${cols} × ${ranks} · footprint ${w.toFixed(1)}″ × ${h.toFixed(1)}″`;
    $('p-join').innerHTML = this.joinHtml(u.id);
    $('p-profile').innerHTML = info.profile
      .map((r) => `<tr><td>${escapeHtml(r.name)}</td>${r.values.map((v) => `<td>${escapeHtml(v)}</td>`).join('')}</tr>`)
      .join('');
    // Was oben schon erklärt ist (Waffen, Rettungswürfe, Optionen), steht unten nicht noch einmal
    const shown = new Set<string>();
    $('p-weapons').innerHTML = this.weaponsHtml(u, shown);
    $('p-saves').innerHTML = this.savesHtml(u, shown);
    const options = visibleOptions(info).map((o) => {
      const explained = optionInfo(o, info);
      if (explained) shown.add(ruleKey(explained.name));
      return explained ? ruleHtml({ ...explained, name: o, note: 'Option' }) : `<p class="opt-plain">${escapeHtml(o)} <span class="note">Option</span></p>`;
    });
    $('p-options').innerHTML = options.join('');
    $('p-items').innerHTML = info.items.filter((i) => !shown.has(ruleKey(i.name))).map(ruleHtml).join('');
    $('p-rules').innerHTML = visibleRules(info).filter((r) => !shown.has(ruleKey(r.name))).map(ruleHtml).join('');
    $('p-source').innerHTML = info.url
      ? `Source: <a href="${escapeHtml(info.url)}" target="_blank" rel="noopener">tow.whfb.app ↗</a>`
      : '';
    // Ein angeschlossener Charakter hat keine eigene Formation
    $('p-formation').hidden = joined;
    $('p-form-row').hidden = !canSkirmish(u) && !skirmish;
    $('p-rank').hidden = !skirmish;
    $('p-width-row').querySelector('.label')!.textContent = skirmish ? 'Width when arranging' : 'Width (models in front rank)';

    // Siegpunkte
    document.querySelectorAll<HTMLButtonElement>('[data-status]').forEach((btn) => {
      btn.classList.toggle('on', (btn.dataset.status || null) === (u.status ?? null));
    });
    const single = (info.startModels ?? u.models) === 1;
    $('p-wounds-row').hidden = !single;
    const wd = wounds(u);
    $('p-wounds').textContent = `${wd.left}/${wd.total}`;
    $('p-captured-row').hidden = !hasStandard(u);
    ($('p-captured') as HTMLInputElement).checked = !!u.standardCaptured;
    const pointsInput = $('p-points') as HTMLInputElement;
    if (document.activeElement !== pointsInput) pointsInput.value = String(info.points ?? 0);
    const vp = unitVictoryPoints(u);
    const total = vp.reduce((s, l) => s + l.vp, 0);
    const tags = [info.isGeneral ? 'General' : '', info.isBsb ? 'Battle Standard Bearer' : ''].filter(Boolean).join(' · ');
    $('p-vp-value').textContent = `Worth ${total} VP to the opponent right now` + (tags ? ` · ${tags}` : '');
    document.querySelectorAll<HTMLButtonElement>('[data-form]').forEach((btn) => {
      btn.classList.toggle('on', btn.dataset.form === (u.formation ?? 'close'));
    });
    $('p-width').textContent = String(skirmish ? Math.min(u.width, u.models) : cols);
    $('p-models').textContent = String(u.models);
    const last = this.lastAction.get(u.id);
    $('p-move').textContent = last ? `Last action: ${last}` : '';
  }

  /** Anschluss-Status: Charakter in Einheit, Charaktere einer Einheit oder Hinweis zum Anschließen. */
  /**
   * Anklickbarer Begriff: zeigt seine Erklärung im Kasten des Abschnitts (erneut klicken schließt ihn).
   * Ohne Text bleibt es normaler Text.
   */
  private infoLink(section: string, label: string, ref: RuleRef | null): string {
    if (!ref?.text) return escapeHtml(label);
    const key = `${section}:${label}`;
    this.infoRefs.set(key, { ...ref, name: label });
    return `<button class="link rule-link${this.infoOpen === key ? ' on' : ''}" data-info="${escapeHtml(key)}">${escapeHtml(label)}</button>`;
  }

  /** Erklärungskasten eines Abschnitts, falls dort gerade ein Begriff aufgeklappt ist */
  private infoBox(section: string): string {
    const r = this.infoOpen?.startsWith(`${section}:`) ? this.infoRefs.get(this.infoOpen) : undefined;
    if (!r) return '';
    const link = r.url ? `<a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">Full text ↗</a>` : '';
    return `<div class="w-rule-text"><b>${escapeHtml(r.name)}</b><p>${escapeHtml(r.text)}</p>${link}</div>`;
  }

  /** Sonderregel einer Waffe: Text aus der Waffenliste, sonst aus den Regeln der Einheit */
  private weaponRuleRef(name: string, u: UnitState): RuleRef | null {
    const w = weaponRule(name);
    if (w?.text) return w;
    return u.info.rules.find((r) => ruleKey(r.name) === ruleKey(name)) ?? null;
  }

  /** Waffen mit Profil (Range, S, AP) und Sonderregeln, magische Waffen genauso; Namen und Regeln anklickbar */
  private weaponsHtml(u: UnitState, shown: Set<string>): string {
    const magic = u.info.items.filter((i) => i.profiles?.length || /weapon/i.test(i.note ?? ''));
    const weapons = [
      // Im Text magischer Waffen steht der Profilname aus der Quelle ("… (Profile)") – der fällt weg
      ...magic.map((i) => ({ name: i.name, text: i.text.replace(/[^\n]*\(Profile\)\s*/g, ''), url: i.url ?? '', profiles: i.profiles ?? [], note: i.note })),
      ...unitWeapons(u.info).map((w) => ({ ...w, note: '' })),
    ];
    if (!weapons.length) return '<p class="meta">No weapons found.</p>';
    magic.forEach((i) => shown.add(ruleKey(i.name)));
    const rows = weapons.flatMap((w) => {
      const name = this.infoLink('w', w.name, { name: w.name, text: [w.note, w.text].filter(Boolean).join('\n'), url: w.url });
      if (!w.profiles.length) return [`<tr><td>${name}</td><td colspan="4" class="meta">see text</td></tr>`];
      return w.profiles.map((p) => `<tr>
        <td>${name}</td>
        <td>${escapeHtml(p.range)}</td><td>${escapeHtml(p.strength)}</td><td>${escapeHtml(p.ap)}</td>
        <td class="w-rules">${p.rules.map((r) => this.infoLink('w', r, this.weaponRuleRef(r, u))).join(', ') || '–'}${p.notes ? `<br><span class="meta">${escapeHtml(p.notes)}</span>` : ''}</td></tr>`);
    });
    return `<table class="profile weapons">
        <thead><tr><th></th><th>Range</th><th>S</th><th>AP</th><th>Special rules</th></tr></thead>
        <tbody>${rows.join('')}</tbody></table>${this.infoBox('w')}`;
  }

  /** Rüstung, Ward und Regeneration: Wert und direkt daneben, woraus er sich ergibt (anklickbar) */
  private savesHtml(u: UnitState, shown: Set<string>): string {
    const s = unitSaves(u.info);
    const line = (label: string, value: number, sources: string) =>
      `<p class="save-line"><b>${label} ${value}+</b> <span class="save-from">${sources}</span></p>`;
    const lines = [
      s.armour !== null ? line('Armour Save', s.armour, s.parts.map((p) => this.infoLink('s', p, armourInfo(p))).join(' · ')) : '',
      s.ward ? line('Ward Save', s.ward.value, this.infoLink('s', s.ward.source.name, s.ward.source)) : '',
      s.regen ? line('Regeneration Save', s.regen.value, this.infoLink('s', s.regen.source.name, s.regen.source)) : '',
    ].join('');
    for (const src of [s.ward?.source, s.regen?.source]) if (src) shown.add(ruleKey(src.name));
    return (lines || '<p class="meta">No saves.</p>') + this.infoBox('s');
  }

  private joinHtml(id: string): string {
    const units = this.store.state.units;
    const u = units[id];
    if (isJoined(u, units)) {
      const host = units[u.joinedTo!];
      return `<div class="join-row"><span>Joined to: <button class="link" data-select="${escapeHtml(host.id)}">` +
        `${escapeHtml(host.info.name)}</button></span>` +
        `<button data-detach="${escapeHtml(u.id)}">Leave unit</button></div>`;
    }
    const chars = joinedCharacters(u, units);
    if (chars.length) {
      const list = chars.map((c) => `<button class="link" data-select="${escapeHtml(c.id)}">${escapeHtml(c.info.name)}</button>`);
      return `<div class="join-row"><span>Characters: ${list.join(', ')}</span></div>`;
    }
    if (u.info.isCharacter) {
      return '<p class="hint">Drag onto a friendly unit to join it.</p>';
    }
    return '';
  }
}
