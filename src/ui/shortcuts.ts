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
/** Nach der Aufstellung gibt es Gelände und Battlefield nicht mehr (siehe gameBar) */
const inBattle = () => document.body.classList.contains('battle');
const isTyping = (e: KeyboardEvent) => !!targetEl(e)?.closest('input, textarea, select');
const plain = (e: KeyboardEvent) => !ctrl(e) && !e.altKey;
/** Buchstabentaste ohne Strg/Alt; Umschalt optional bzw. verlangt */
const letter = (k: string, shift: boolean | null = false) => (e: KeyboardEvent) =>
  plain(e) && e.key.toLowerCase() === k && (shift === null || e.shiftKey === shift);
/** Zeichen, das Umschalt schon enthält (?, +) – Umschalt wird nicht geprüft */
const char = (...ks: string[]) => (e: KeyboardEvent) => plain(e) && ks.includes(e.key);
const withCtrl = (k: string, shift = false) => (e: KeyboardEvent) =>
  ctrl(e) && !e.altKey && e.key.toLowerCase() === k && e.shiftKey === shift;

/** Alle Tastenkürzel an einer Stelle: steuert die Tasten und erzeugt die Legende. */
export class Shortcuts {
  private readonly list: Shortcut[];

  constructor(private t: ShortcutTargets) {
    const { board, panel, gameBar, toolbox, history, views } = t;
    const tools = board.tools;
    const nudge = (f: number, r: number) => (e: KeyboardEvent) => {
      const step = e.shiftKey ? 0.1 : 1;
      board.nudgeSelected(f * step, r * step);
    };
    const status = (s: UnitStatus | null) => () => panel.change({ status: s });

    this.list = [
      // Allgemein
      { group: 'General', keys: [['Ctrl', 'Z']], desc: 'Undo', match: withCtrl('z'), run: () => history.undo() },
      { group: 'General', keys: [['Ctrl', 'Y'], ['Ctrl', 'Shift', 'Z']], desc: 'Redo',
        match: (e) => withCtrl('y')(e) || withCtrl('z', true)(e), run: () => history.redo() },
      { group: 'General', keys: [['Ctrl', 'S']], desc: 'Save game', match: withCtrl('s'), run: () => toolbox.save() },
      { group: 'General', keys: [['Ctrl', 'O']], desc: 'Load game', match: withCtrl('o'), run: () => toolbox.openLoad() },
      { group: 'General', keys: [['Esc']], desc: 'Stop tool, close sheet, then clear selection',
        match: (e) => e.key === 'Escape', whileTyping: true, run: (e) => this.escape(e) },
      { group: 'View', keys: [['H'], ['[']], desc: 'Hide / show the left column', match: (e) => letter('h')(e) || char('[')(e), run: () => views.toggle('left') },
      { group: 'General', keys: [['?'], ['F1']], desc: 'Show these shortcuts',
        match: (e) => char('?')(e) || e.key === 'F1', run: () => toggleSheet('keys') },

      // Werkzeuge
      { group: 'Tools', keys: [['V']], desc: 'Select and drag', match: letter('v'), run: () => tools.setTool('select') },
      { group: 'Tools', keys: [['M']], desc: 'Measuring tape (after setup)', match: letter('m'), run: () => { if (inBattle()) tools.setTool('measure'); } },
      { group: 'Tools', keys: [['L']], desc: 'Line of sight (after setup)', match: letter('l'), run: () => { if (inBattle()) tools.setTool('sight'); } },
      { group: 'Tools', keys: [['G']], desc: 'Place terrain: Battlefield sheet (setup only)', match: letter('g'), run: () => { if (!inBattle()) toggleSheet('battlefield'); } },
      { group: 'Tools', keys: [['K']], desc: 'Place markers (after setup)', match: letter('k'), run: () => { if (inBattle()) toggleSheet('markers'); } },
      { group: 'Tools', keys: [['B']], desc: 'Templates (after setup)', match: letter('b'), run: () => { if (inBattle()) toggleSheet('templates'); } },
      { group: 'Tools', keys: [['A']], desc: 'Battlefield & setup (setup only)', match: letter('a'), run: () => { if (!inBattle()) toggleSheet('battlefield'); } },

      // Fenster und Spiel
      { group: 'Game', keys: [['W']], desc: 'Dice (after setup): open and enter number', match: letter('w'), run: () => {
        if (!inBattle()) return;
        openSheet('dice');
        const input = $('d-count') as HTMLInputElement;
        input.focus();
        input.select();
      } },
      { group: 'Game', keys: [['Enter']], desc: 'In the dice popup: roll',
        match: (e) => e.key === 'Enter' && plain(e) && !!targetEl(e)?.closest('#dicebar'),
        whileTyping: true, run: () => ($('d-roll') as HTMLButtonElement).click() },
      { group: 'Game', keys: [['P']], desc: 'Log', match: letter('p'), run: () => toggleSheet('log') },
      { group: 'Game', keys: [['N']], desc: 'End round (after setup)', match: letter('n'), run: () => gameBar.endRound() },
      { group: 'Game', keys: [['C']], desc: 'Write a chat message', match: letter('c'), run: () => {
        openSheet('log');
        ($('chat-input') as HTMLInputElement).focus();
      } },
      { group: 'Game', keys: [['S']], desc: 'Victory Points (after setup)', match: letter('s'), run: () => {
        if (inBattle()) toggleSheet('score');
      } },
      { group: 'Game', keys: [['Tab'], ['Shift', 'Tab']], desc: 'Select next / previous unit',
        match: (e) => e.key === 'Tab' && plain(e), run: (e) => board.selectNext(e.shiftKey ? -1 : 1) },

      // Ausgewählte Einheit oder ausgewähltes Objekt
      { group: 'Selection', keys: [['↑'], ['↓']], desc: '1″ forward / backward (Shift: 0.1″)',
        match: (e) => plain(e) && (e.key === 'ArrowUp' || e.key === 'ArrowDown'),
        run: (e) => nudge(e.key === 'ArrowUp' ? 1 : -1, 0)(e) },
      { group: 'Selection', keys: [['←'], ['→']], desc: '1″ left / right (Shift: 0.1″)',
        match: (e) => plain(e) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'),
        run: (e) => nudge(0, e.key === 'ArrowRight' ? 1 : -1)(e) },
      { group: 'Selection', keys: [['Q'], ['E']], desc: 'Turn 15° left / right (Shift: 1°)',
        match: (e) => letter('q', null)(e) || letter('e', null)(e),
        run: (e) => board.rotateSelected((e.key.toLowerCase() === 'e' ? 1 : -1) * (e.shiftKey ? 1 : 15)) },
      { group: 'Selection', keys: [['R']], desc: 'Show movement and charge ranges', match: letter('r'), run: () => panel.toggleRanges() },
      { group: 'Selection', keys: [['F']], desc: 'Toggle close order / skirmish', match: letter('f'), run: () => panel.toggleFormation() },
      { group: 'Selection', keys: [['O']], desc: 'Arrange skirmishers in ranks (0.5″)', match: letter('o'), run: () => panel.arrangeInRanks() },
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
      { group: 'Selection', keys: [['Del'], ['Backspace']], desc: 'Remove terrain, marker or template',
        match: (e) => plain(e) && (e.key === 'Delete' || e.key === 'Backspace'), run: () => tools.removeSelected() },

      // Ansicht
      { group: 'View', keys: [['PgUp'], ['PgDn']], desc: 'Zoom in / out (also mouse wheel)',
        match: (e) => plain(e) && (e.key === 'PageUp' || e.key === 'PageDown'),
        run: (e) => board.zoomBy(e.key === 'PageUp' ? 1.25 : 1 / 1.25) },
      { group: 'View', keys: [['Home']], desc: 'Show the whole table', match: (e) => plain(e) && e.key === 'Home', run: () => board.fitView() },
      { group: 'View', keys: [['Ctrl', '↑ ↓ ← →']], desc: 'Pan the view (when zoomed in)',
        match: (e) => ctrl(e) && e.key.startsWith('Arrow'),
        run: (e) => board.panBy({ ArrowLeft: 80, ArrowRight: -80 }[e.key] ?? 0, { ArrowUp: 80, ArrowDown: -80 }[e.key] ?? 0) },
    ];

    window.addEventListener('keydown', (e) => this.onKey(e));
    this.renderLegend();
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

