import type { History } from '../model/history';
import type { UnitStatus } from '../model/types';
import type { Board } from '../view/board';
import type { GameBar } from './gameBar';
import type { UnitPanel } from './panel';
import { openedSheet, openSheet, toggleSheet } from './sheets';
import type { Toolbox } from './toolbox';

const $ = (id: string) => document.getElementById(id)!;

export interface ShortcutTargets {
  board: Board;
  panel: UnitPanel;
  gameBar: GameBar;
  toolbox: Toolbox;
  history: History;
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
    const { board, panel, gameBar, toolbox, history } = t;
    const tools = board.tools;
    const nudge = (f: number, r: number) => (e: KeyboardEvent) => {
      const step = e.shiftKey ? 0.1 : 1;
      board.nudgeSelected(f * step, r * step);
    };
    const status = (s: UnitStatus | null) => () => panel.change({ status: s });

    this.list = [
      // Allgemein
      { group: 'Allgemein', keys: [['Strg', 'Z']], desc: 'Rückgängig', match: withCtrl('z'), run: () => history.undo() },
      { group: 'Allgemein', keys: [['Strg', 'Y'], ['Strg', 'Umschalt', 'Z']], desc: 'Wiederholen',
        match: (e) => withCtrl('y')(e) || withCtrl('z', true)(e), run: () => history.redo() },
      { group: 'Allgemein', keys: [['Strg', 'S']], desc: 'Spielstand speichern', match: withCtrl('s'), run: () => toolbox.save() },
      { group: 'Allgemein', keys: [['Strg', 'O']], desc: 'Spielstand laden', match: withCtrl('o'), run: () => toolbox.openLoad() },
      { group: 'Allgemein', keys: [['Esc']], desc: 'Werkzeug beenden, Fenster schließen, dann Auswahl aufheben',
        match: (e) => e.key === 'Escape', whileTyping: true, run: (e) => this.escape(e) },
      { group: 'Allgemein', keys: [['?'], ['F1']], desc: 'Diese Tastenkürzel anzeigen',
        match: (e) => char('?')(e) || e.key === 'F1', run: () => toggleSheet('keys') },
      { group: 'Allgemein', keys: [['H']], desc: 'Hilfe zur Steuerung', match: letter('h'), run: () => toggleSheet('help') },

      // Werkzeuge
      { group: 'Werkzeuge', keys: [['V']], desc: 'Auswählen und ziehen', match: letter('v'), run: () => tools.setTool('select') },
      { group: 'Werkzeuge', keys: [['M']], desc: 'Maßband', match: letter('m'), run: () => tools.setTool('measure') },
      { group: 'Werkzeuge', keys: [['L']], desc: 'Sichtlinie', match: letter('l'), run: () => tools.setTool('sight') },
      { group: 'Werkzeuge', keys: [['G']], desc: 'Gelände setzen', match: letter('g'), run: () => toggleSheet('terrain') },
      { group: 'Werkzeuge', keys: [['K']], desc: 'Marker setzen', match: letter('k'), run: () => toggleSheet('markers') },
      { group: 'Werkzeuge', keys: [['B']], desc: 'Schablonen', match: letter('b'), run: () => toggleSheet('templates') },
      { group: 'Werkzeuge', keys: [['A']], desc: 'Aufstellungszonen', match: letter('a'), run: () => toggleSheet('zones') },

      // Fenster und Spiel
      { group: 'Spiel', keys: [['W']], desc: 'Würfel', match: letter('w'), run: () => toggleSheet('dice') },
      { group: 'Spiel', keys: [['Enter']], desc: 'Im Würfelfenster: würfeln',
        match: (e) => e.key === 'Enter' && plain(e) && !!targetEl(e)?.closest('#sheet-dice'),
        whileTyping: true, run: () => ($('d-roll') as HTMLButtonElement).click() },
      { group: 'Spiel', keys: [['P']], desc: 'Protokoll', match: letter('p'), run: () => toggleSheet('log') },
      { group: 'Spiel', keys: [['C']], desc: 'Chat-Nachricht schreiben', match: letter('c'), run: () => {
        openSheet('log');
        ($('chat-input') as HTMLInputElement).focus();
      } },
      { group: 'Spiel', keys: [['S']], desc: 'Siegpunkte', match: letter('s'), run: () => toggleSheet('score') },
      { group: 'Spiel', keys: [['N']], desc: 'Phase beenden (nach dem Nahkampf: Zug abgeben)', match: letter('n'), run: () => gameBar.requestEndPhase() },
      { group: 'Spiel', keys: [['Tab'], ['Umschalt', 'Tab']], desc: 'Nächste / vorige Einheit auswählen',
        match: (e) => e.key === 'Tab' && plain(e), run: (e) => board.selectNext(e.shiftKey ? -1 : 1) },

      // Ausgewählte Einheit oder ausgewähltes Objekt
      { group: 'Auswahl', keys: [['↑'], ['↓']], desc: '1″ vor / zurück (mit Umschalt 0,1″)',
        match: (e) => plain(e) && (e.key === 'ArrowUp' || e.key === 'ArrowDown'),
        run: (e) => nudge(e.key === 'ArrowUp' ? 1 : -1, 0)(e) },
      { group: 'Auswahl', keys: [['←'], ['→']], desc: '1″ nach links / rechts (mit Umschalt 0,1″)',
        match: (e) => plain(e) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'),
        run: (e) => nudge(0, e.key === 'ArrowRight' ? 1 : -1)(e) },
      { group: 'Auswahl', keys: [['Q'], ['E']], desc: '15° nach links / rechts drehen (mit Umschalt 1°)',
        match: (e) => letter('q', null)(e) || letter('e', null)(e),
        run: (e) => board.rotateSelected((e.key.toLowerCase() === 'e' ? 1 : -1) * (e.shiftKey ? 1 : 15)) },
      { group: 'Auswahl', keys: [['R']], desc: 'Bewegungs- und Angriffsreichweite zeigen', match: letter('r'), run: () => panel.toggleRanges() },
      { group: 'Auswahl', keys: [['F']], desc: 'Geschlossen / Plänkler wechseln', match: letter('f'), run: () => panel.toggleFormation() },
      { group: 'Auswahl', keys: [['O']], desc: 'Plänkler in Reihen ordnen (0,5″)', match: letter('o'), run: () => panel.arrangeInRanks() },
      { group: 'Auswahl', keys: [[','], ['.']], desc: 'Formation schmaler / breiter', match: char(',', '.'),
        run: (e) => panel.onFormation(e.key === ',' ? 'w-' : 'w+') },
      { group: 'Auswahl', keys: [['-'], ['+']], desc: 'Modell entfernen / hinzufügen', match: char('-', '+'),
        run: (e) => panel.onFormation(e.key === '-' ? 'm-' : 'm+') },
      { group: 'Auswahl', keys: [['1'], ['2'], ['3'], ['4']], desc: 'Status: im Spiel / flieht / geflohen / vernichtet',
        match: char('1', '2', '3', '4'),
        run: (e) => status(([null, 'fleeing', 'fledOff', 'destroyed'] as const)[Number(e.key) - 1])() },
      { group: 'Auswahl', keys: [['X']], desc: 'Charakter verlässt seine Einheit', match: letter('x'), run: () => {
        if (board.selectedId) board.detachCharacter(board.selectedId);
      } },
      { group: 'Auswahl', keys: [['Entf'], ['Rücktaste']], desc: 'Gelände, Marker oder Schablone entfernen',
        match: (e) => plain(e) && (e.key === 'Delete' || e.key === 'Backspace'), run: () => tools.removeSelected() },

      // Ansicht
      { group: 'Ansicht', keys: [['Bild ↑'], ['Bild ↓']], desc: 'Hinein- / herauszoomen (auch Mausrad)',
        match: (e) => plain(e) && (e.key === 'PageUp' || e.key === 'PageDown'),
        run: (e) => board.zoomBy(e.key === 'PageUp' ? 1.25 : 1 / 1.25) },
      { group: 'Ansicht', keys: [['Pos1']], desc: 'Ganzen Tisch zeigen', match: (e) => plain(e) && e.key === 'Home', run: () => board.fitView() },
      { group: 'Ansicht', keys: [['Strg', '↑ ↓ ← →']], desc: 'Ansicht verschieben (hineingezoomt)',
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

