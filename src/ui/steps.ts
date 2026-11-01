const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Von Hand wieder aufgeklappte erledigte Schritte ("Fenster-id:Schritt"); gilt nur auf diesem Bildschirm */
const expanded = new Set<string>();

export interface StepOptions {
  /** Kennung des Fensters, damit aufgeklappte Schritte beim Neuzeichnen offen bleiben */
  key?: string;
  /** Kurzfassung je Schritt: steht in der Zeile eines erledigten (eingeklappten) Schritts */
  summaries?: (string | null | undefined)[];
  /** Kopfzeile über den Schritten (summaryBar), bleibt beim Scrollen oben stehen */
  header?: string;
}

/**
 * Alle Schritte eines Ablaufs untereinander: erledigte sind zu einer Zeile mit ihrer Kurzfassung eingeklappt
 * (Klick klappt sie auf, ihre Würfel bleiben drin), der aktuelle ist offen und bedienbar, kommende sind angekündigt.
 * Ist der Ablauf fertig, bleibt der letzte Schritt offen. Gibt je Schritt den Bereich für seinen Inhalt zurück.
 * @param current Index des aktuellen Schritts
 * @param open läuft der Ablauf noch? (sonst sind alle Schritte erledigt)
 */
export function stepSections(body: HTMLElement, titles: string[], current: number, open: boolean, opts: StepOptions = {}): HTMLElement[] {
  const state = (i: number) => (i < current || (i === current && !open) ? 'done' : i === current ? 'active' : 'todo');
  const collapsed = (i: number) => i < current && !expanded.has(`${opts.key}:${i}`);
  body.innerHTML = `${opts.header ?? ''}<div class="steps">${titles.map((t, i) => `<section class="step ${state(i)}${collapsed(i) ? ' collapsed' : ''}">
      <h4 ${i < current ? `data-step-toggle="${i}" title="Click to show or hide this step"` : ''}><span class="step-no">${i + 1}</span>${esc(t)}${
        i < current && opts.summaries?.[i] ? `<span class="step-sum">${esc(opts.summaries[i]!)}</span>` : ''}${i < current ? '<span class="step-chev"></span>' : ''}</h4>
      <div class="step-body">${state(i) === 'todo' ? '<p class="meta">Follows after the step before.</p>' : ''}</div>
    </section>`).join('')}</div>`;
  body.querySelectorAll<HTMLElement>('[data-step-toggle]').forEach((h) => {
    h.onclick = () => {
      const id = `${opts.key}:${h.dataset.stepToggle}`;
      const open = h.parentElement!.classList.toggle('collapsed') === false;
      if (open) expanded.add(id);
      else expanded.delete(id);
    };
  });
  return [...body.querySelectorAll<HTMLElement>('.step-body')];
}

/** Erledigte Schritte nur noch anzeigen: ohne Knöpfe, Eingaben gesperrt */
export function freezeSteps(body: HTMLElement): void {
  body.querySelectorAll('.step:not(.active) .prompt-actions').forEach((el) => el.remove());
  body.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>(
    '.step:not(.active) input, .step:not(.active) select, .step:not(.active) button').forEach((el) => { el.disabled = true; });
}

/**
 * Kopfzeile eines Fensters: die wichtigsten Zahlen (z. B. „Needed 12.3″ · Max 16″“) und, sobald es feststeht,
 * das Ergebnis groß und farbig (ok = grün, bad = rot, sonst neutral).
 */
export function summaryBar(items: (string | null | undefined | false)[], result?: { text: string; tone?: 'ok' | 'bad' | 'neutral' } | null): string {
  const list = items.filter(Boolean) as string[];
  if (!list.length && !result) return '';
  return `<div class="dlg-summary">${list.map((x) => `<span class="sum-item">${x}</span>`).join('')}${
    result ? `<span class="sum-result ${result.tone ?? 'neutral'}">${esc(result.text)}</span>` : ''}</div>`;
}

/** Ein Würfelfeld: leer (Klick würfelt) oder mit Ergebnis (Klick würfelt neu); face ist HTML */
export interface DieSlot {
  label: string;
  /** Attribut und Wert, die der Klick auslöst, z. B. ['data-cd', 'roll:roll:0'] */
  attr: string;
  act: string;
  face: string | null;
  dropped?: boolean;
  /** z. B. Misfire */
  bad?: boolean;
  disabled?: boolean;
}

/** Würfel nebeneinander: leere Felder zum Würfeln, gewürfelte zum Neuwürfeln, gestrichene blass */
export function dieSlots(slots: DieSlot[]): string {
  return `<div class="dice-slots">${slots.map((s) => `<button class="die-slot${s.face === null ? ' empty' : ''}${s.dropped ? ' dropped' : ''}${s.bad ? ' bad' : ''}"
      ${s.attr}="${esc(s.act)}" title="${s.face === null ? 'Click to roll' : 'Click to roll again'}" ${s.disabled ? 'disabled' : ''}>
      <span class="die-face">${s.face ?? '🎲'}</span><span class="die-label">${esc(s.label)}</span></button>`).join('')}</div>`;
}
