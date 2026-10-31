const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Alle Schritte eines Ablaufs nebeneinander: erledigte bleiben mit ihren Würfeln stehen (nur lesen), der aktuelle
 * ist bedienbar, kommende sind schon angekündigt. Gibt je Schritt den Bereich für seinen Inhalt zurück.
 * @param current Index des aktuellen Schritts
 * @param open läuft der Ablauf noch? (sonst sind alle Schritte erledigt)
 */
export function stepSections(body: HTMLElement, titles: string[], current: number, open: boolean): HTMLElement[] {
  const state = (i: number) => (i < current || (i === current && !open) ? 'done' : i === current ? 'active' : 'todo');
  body.innerHTML = `<div class="steps">${titles.map((t, i) => `<section class="step ${state(i)}">
      <h4><span class="step-no">${i + 1}</span>${esc(t)}</h4>
      <div class="step-body">${state(i) === 'todo' ? '<p class="meta">Follows after the step before.</p>' : ''}</div>
    </section>`).join('')}</div>`;
  return [...body.querySelectorAll<HTMLElement>('.step-body')];
}

/** Erledigte Schritte nur noch anzeigen: ohne Knöpfe, Eingaben gesperrt */
export function freezeSteps(body: HTMLElement): void {
  body.querySelectorAll('.step:not(.active) .prompt-actions').forEach((el) => el.remove());
  body.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>(
    '.step:not(.active) input, .step:not(.active) select, .step:not(.active) button').forEach((el) => { el.disabled = true; });
}
