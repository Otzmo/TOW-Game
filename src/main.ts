import { Application } from 'pixi.js';
import './style.css';
import { importBbList } from './data/importer';
import { History } from './model/history';
import { defaultTerrain } from './model/objects';
import { Store } from './model/store';
import type { GameState, LogEntry } from './model/types';
import type { Seat } from './net/room';
import { DicePanel } from './ui/dice';
import { GameBar } from './ui/gameBar';
import { ImportDialog } from './ui/importDialog';
import { Lobby } from './ui/lobby';
import { LogPanel } from './ui/logPanel';
import { ObjectPanel } from './ui/objectPanel';
import { UnitPanel } from './ui/panel';
import { Toolbox } from './ui/toolbox';
import { Board } from './view/board';
import { PPI } from './view/theme';

async function start(): Promise<void> {
  const app = new Application();
  await app.init({
    resizeTo: window,
    background: '#16181a',
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  });
  document.getElementById('app')!.appendChild(app.canvas);

  const state: GameState = {
    table: { width: 72, height: 48 },
    units: {},
    meta: { round: 1, active: 'p1', breakBonus: {}, scenario: 'none' },
    objects: defaultTerrain(),
    log: [],
  };
  const store = new Store(state);
  const history = new History(store);

  // Wer schreibt ins Protokoll: online der eigene Platz, offline der Spieler am Zug
  let seat: Seat | null = null;
  const addLog = (entry: Pick<LogEntry, 'kind' | 'text' | 'dice'>) => {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    store.addLog({ id, ts: Date.now(), by: seat ?? store.state.meta.active, ...entry });
  };

  const panel = new UnitPanel(store, history, {
    close: () => board.select(null),
    select: (id) => board.select(id),
    detach: (id) => board.detachCharacter(id),
    showRanges: (on) => board.setShowRanges(on),
  });
  const objectPanel = new ObjectPanel(store, history, {
    close: () => board.tools.select(null),
    remove: () => board.tools.removeSelected(),
  });
  const board: Board = new Board(app, store, history, {
    onSelect: (id) => panel.show(id),
    onSelectObject: (id) => objectPanel.show(id),
    onAction: (id, text) => {
      panel.setLastAction(id, text);
      const name = store.state.units[id]?.info.name ?? '';
      addLog({ kind: 'action', text: `${name} ${text}` });
    },
  });
  const gameBar = new GameBar(store, () => history.undo(), () => history.canUndo(),
    (kind, text) => addLog({ kind, text }));
  new Toolbox(store, history, board.tools, (text) => addLog({ kind: 'action', text }));
  new DicePanel((entry) => addLog(entry));
  new LogPanel(store, (text) => addLog({ kind: 'chat', text }));

  // Ganzen Tisch zeigen, auch nach jedem Armeeimport
  const { width, height } = state.table;
  const showTable = () => {
    // Tisch zwischen Hilfsmittel-Spalte links und Einheitenleiste unten (Maße aus dem CSS)
    const css = getComputedStyle(document.documentElement);
    const px = (name: string) => {
      const v = css.getPropertyValue(name).trim();
      return v.endsWith('vh') ? (parseFloat(v) * window.innerHeight) / 100 : parseFloat(v) || 0;
    };
    const left = px('--side');
    const bottom = px('--bottom') + 12;
    const margin = 30; // Platz für die Zoll-Leisten
    const areaW = app.screen.width - left;
    const areaH = app.screen.height - bottom;
    const fit = Math.min((areaW - 2 * margin) / (width * PPI), (areaH - 2 * margin) / (height * PPI));
    // Tisch liegt unten links an Hilfsmittel-Spalte und Einheitenleiste an
    board.world.scale.set(fit);
    board.world.position.set(left + margin, areaH - margin - height * PPI * fit);
  };
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(showTable, 100);
  });
  new ImportDialog(store, () => {
    history.clear();
    showTable();
  });
  showTable();

  if (import.meta.env.VITE_DEMO) {
    // Demo-Build (z. B. als Artefakt): ohne Lobby, mit Beispielliste auf beiden Seiten
    document.getElementById('lobby')!.hidden = true;
    const { default: list } = await import('../fixtures/turnier-wuppertal.bb.json');
    for (const owner of ['p1', 'p2'] as const) {
      const result = await importBbList(list, owner, state.table);
      store.replacePlayerUnits(owner, result.units);
    }
    history.clear();
    showTable();
    return;
  }

  // Online: jeder Spieler lädt nur seine eigene Armee; Zuschauer ändern nichts
  new Lobby(store, (me) => {
    seat = me;
    document.querySelectorAll<HTMLElement>('[data-import]').forEach((btn) => {
      btn.hidden = btn.dataset.import !== me;
    });
    gameBar.setOnlinePlayer(me);
    if (me === 'spectator') {
      document.body.classList.add('spectator');
      board.readOnly = true;
    }
  });
}

start();
