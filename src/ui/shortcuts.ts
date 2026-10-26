import type { History } from '../model/history';
import type { UnitStatus } from '../model/types';
import type { Board } from '../view/board';
import type { GameBar } from './gameBar';
import type { UnitPanel } from './panel';
import { openedSheet, openSheet, toggleSheet } from './sheets';
import type { Toolbox } from './toolbox';
import type { ViewToggles } from './viewToggles';

const $ = (id: string) => document.getElementById(id)!;

export interface ShortcutTargets {
  board: Board;
  panel: UnitPanel;
  gameBar: GameBar;
  toolbox: Toolbox;
  history: History;
  views: ViewToggles;
}

interface Shortcut {
  group: string;
  /** Anzeige in der Legende, z. B. ["Strg", "Z"]; mehrere Varianten als Liste */
  keys: string[][];
  desc: string;
  match: (e: KeyboardEvent) => boolean;
  run: (e: KeyboardEvent) => void;
  /** Auch auslösen, während in einem Eingabefeld getippt wird */
  whileTyping?: boolean;
}

const ctrl = (e: KeyboardEvent) => e.ctrlKey || e.metaKey;
/** Element, auf dem die Taste gedrückt wurde (kann auch das Fenster sein) */
const targetEl = (e: KeyboardEvent) => (e.target instanceof HTMLElement ? e.target : null);
const isTyping = (e: KeyboardEvent) => !!targetEl(e)?.closest('input, textarea, select');
const plain = (e: KeyboardEvent) => !ctrl(e) && !e.altKey;
/** Buchstabentaste ohne Strg/Alt/Umschalt */
const letter = (k: string) => (e: KeyboardEvent) =>
  plain(e) && !e.shiftKey && e.key.toLowerCase() === k;
/** Zeichen, das Umschalt schon enthält (?, +) – Umschalt wird nicht geprüft */
const char = (...ks: string[]) => (e: KeyboardEvent) => plain(e) && ks.includes(e.key);

/**
 * Jeder Knopf der linken Spalte hat einen eigenen Buchstaben; die Taste klickt einfach den Knopf
 * (nur wenn er gerade sichtbar und nicht gesperrt ist). Der Buchstabe steht auch auf dem Knopf.
 */
const LEFT_KEYS: [selector: string, key: string, desc: string][] = [
  ['#g-end', 'N', 'End turn'],
  ['#g-undo', 'U', 'Undo'],
  ['#g-redo', 'Y', 'Redo'],
  ['[data-tool="measure"]', 'M', 'Measuring tape (stays on the table)'],
  ['[data-tool="ping"]', 'P', 'Ping: mark a point for both players (also Alt + click)'],
  ['#score-btn', 'S', 'Scoring'],
  ['[data-sheet="dice"]', 'D', 'Dice'],
  ['[data-sheet="battlefield"]', 'A', 'Setup (current step)'],
  ['[data-sheet="markers"]', 'K', 'Markers'],
  ['[data-sheet="templates"]', 'T', 'Templates'],
  ['[data-sheet="log"]', 'L', 'Log & chat'],
  ['[data-sheet="notes"]', 'J', 'Notes'],
  ['#new-game', 'O', 'New game (deletes this game)'],
  ['#save-game', 'W', 'Save game'],
  ['#load-game', 'G', 'Load game'],
  ['[data-sheet="keys"]', 'V', 'Shortcuts (this list)'],
  ['[data-sheet="mission"]', 'I', 'Mission'],
  ['#ambush-btn', 'B', 'Ambushers'],
  ['[data-sheet="spells"]', 'Z', 'Spells'],
  ['[data-sheet="destroyed"]', 'C', 'Destroyed units'],
];

/** Alle Tastenkürzel an einer Stelle: steuert die Tasten und erzeugt die Legende. */
export class Shortcuts {
  private readonly list: Shortcut[];

  constructor(private t: ShortcutTargets) {
    const { board, panel, views } = t;
    const tools = board.tools;
    const status = (s: UnitStatus | null) => () => panel.change({ status: s });

    // Jedes Kürzel ist genau eine Taste – keine Kombination mit Strg, Umschalt oder Alt
    this.list = [
      // Allgemein
      { group: 'General', keys: [['Esc']], desc: 'Stop tool, close window, remove the measuring tape',
        match: (e) => e.key === 'Escape', whileTyping: true, run: (e) => this.escape(e) },
      { group: 'General', keys: [['F1']], desc: 'Show these shortcuts', match: (e) => plain(e) && e.key === 'F1', run: () => toggleSheet('keys') },
      { group: 'General', keys: [['H']], desc: 'Hide / show the left column', match: letter('h'), run: () => views.toggle('left') },

      // Linke Spalte: ein Buchstabe je Knopf
      ...LEFT_KEYS.map(([selector, key, desc]): Shortcut => ({
        group: 'Left column', keys: [[key]], desc, match: letter(key.toLowerCase()),
        run: () => this.pressButton(selector),
      })),
      { group: 'Left column', keys: [['Enter']], desc: 'In the dice window: roll',
        match: (e) => e.key === 'Enter' && plain(e) && !!targetEl(e)?.closest('#dicebar'),
        whileTyping: true, run: () => ($('d-roll') as HTMLButtonElement).click() },

      // Ausgewählte Einheit oder ausgewähltes Objekt
      { group: 'Selection', keys: [['Tab']], desc: 'Select the next unit',
        match: (e) => e.key === 'Tab' && plain(e) && !e.shiftKey, run: () => board.selectNext(1) },
      { group: 'Selection', keys: [['↑'], ['↓']], desc: '1″ forward / backward',
        match: (e) => plain(e) && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown'),
        run: (e) => board.nudgeSelected(e.key === 'ArrowUp' ? 1 : -1, 0) },
      { group: 'Selection', keys: [['←'], ['→']], desc: '1″ left / right',
        match: (e) => plain(e) && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'),
        run: (e) => board.nudgeSelected(0, e.key === 'ArrowRight' ? 1 : -1) },
      { group: 'Selection', keys: [['Q'], ['E']], desc: 'Turn 15° left / right',
        match: (e) => letter('q')(e) || letter('e')(e),
        run: (e) => board.rotateSelected((e.key.toLowerCase() === 'e' ? 1 : -1) * 15) },
      { group: 'Selection', keys: [['R']], desc: 'Show movement and charge ranges', match: letter('r'), run: () => panel.toggleRanges() },
      { group: 'Selection', keys: [['F']], desc: 'Toggle close order / skirmish', match: letter('f'), run: () => panel.toggleFormation() },
      { group: 'Selection', keys: [[','], ['.']], desc: 'Narrower / wider formation', match: char(',', '.'),
        run: (e) => panel.onFormation(e.key === ',' ? 'w-' : 'w+') },
      { group: 'Selection', keys: [['-'], ['+']], desc: 'Remove / add model', match: char('-', '+'),
        run: (e) => panel.onFormation(e.key === '-' ? 'm-' : 'm+') },
      { group: 'Selection', keys: [['1'], ['2'], ['3'], ['4']], desc: 'Status: in play / fleeing / fled / destroyed',
        match: char('1', '2', '3', '4'),
        run: (e) => status(([null, 'fleeing', 'fledOff', 'destroyed'] as const)[Number(e.key) - 1])() },
      { group: 'Selection', keys: [['X']], desc: 'Character leaves its unit', match: letter('x'), run: () => {
        if (board.selectedId) board.detachCharacter(board.selectedId);
      } },
      { group: 'Selection', keys: [['Del']], desc: 'Remove terrain, marker or template',
        match: (e) => plain(e) && e.key === 'Delete', run: () => tools.removeSelected() },

      // Ansicht
      { group: 'View', keys: [['PgUp'], ['PgDn']], desc: 'Zoom in / out (also mouse wheel)',
        match: (e) => plain(e) && (e.key === 'PageUp' || e.key === 'PageDown'),
        run: (e) => board.camera.zoomBy(e.key === 'PageUp' ? 1.25 : 1 / 1.25) },
      { group: 'View', keys: [['Home']], desc: 'Show the whole table', match: (e) => plain(e) && e.key === 'Home', run: () => board.camera.fit() },
    ];

    window.addEventListener('keydown', (e) => this.onKey(e));
    // Buchstaben auf die Knöpfe der linken Spalte schreiben
    for (const [selector, key] of LEFT_KEYS) document.querySelector<HTMLElement>(selector)?.setAttribute('data-key', key);
    this.renderLegend();
  }

  /** Knopf der linken Spalte drücken, falls er gerade sichtbar und nicht gesperrt ist */
  private pressButton(selector: string): void {
    const btn = document.querySelector<HTMLButtonElement>(selector);
    if (!btn || btn.disabled || !btn.offsetParent) return;
    btn.click();
    // Würfel: gleich die Anzahl eingeben können
    if (selector.includes('dice') && openedSheet() === 'dice') {
      const input = $('d-count') as HTMLInputElement;
      input.focus();
      input.select();
    }
  }

  private onKey(e: KeyboardEvent): void {
    const typing = isTyping(e);
    const dialogOpen = !!document.querySelector('dialog[open]');
    if (dialogOpen) return;
    for (const s of this.list) {
      if ((typing && !s.whileTyping) || !s.match(e)) continue;
      e.preventDefault();
      s.run(e);
      return;
    }
  }

  /** Esc: zuerst Eingabe verlassen, dann Werkzeug/Fenster schließen, dann Auswahl aufheben. */
  private escape(e: KeyboardEvent): void {
    const { board } = this.t;
    if (isTyping(e)) targetEl(e)?.blur();
    else if (board.cancelPick()) return;
    else if (board.tools.tool !== 'select') board.tools.setTool('select');
    else if (openedSheet()) openSheet(null);
    else if (board.tools.selectedId) board.tools.select(null);
    else board.select(null);
  }

  private renderLegend(): void {
    const groups = [...new Set(this.list.map((s) => s.group))];
    $('keys-list').innerHTML = groups.map((g) => `<div class="key-group"><h4>${g}</h4><table class="keys">${
      this.list.filter((s) => s.group === g).map((s) => `<tr><td>${
        s.keys.map((combo) => combo.map((k) => `<kbd>${k}</kbd>`).join('+')).join(' ')
      }</td><td>${s.desc}</td></tr>`).join('')}</table></div>`).join('');
  }
}

