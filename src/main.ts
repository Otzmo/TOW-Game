import { Application } from 'pixi.js';
import './style.css';
import { importBbList } from './data/importer';
import { History } from './model/history';
import { Store } from './model/store';
import type { GameState } from './model/types';
import { GameBar } from './ui/gameBar';
import { ImportDialog } from './ui/importDialog';
import { Lobby } from './ui/lobby';
import { UnitPanel } from './ui/panel';
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
    meta: { round: 1, active: 'p1', breakBonus: {} },
  };
  const store = new Store(state);
  const history = new History(store);

  const panel = new UnitPanel(store, history, {
    close: () => board.select(null),
    select: (id) => board.select(id),
    detach: (id) => board.detachCharacter(id),
  });
  const board: Board = new Board(app, store, history, {
    onSelect: (id) => panel.show(id),
    onAction: (id, text) => panel.setLastAction(id, text),
  });
  const gameBar = new GameBar(store, () => history.undo(), () => history.canUndo());

  // Ganzen Tisch zeigen, auch nach jedem Armeeimport
  const { width, height } = state.table;
  const showTable = () => {
    // Platz für die Zoll-Leisten am Rand und die Leisten oben
    const fit = Math.min(app.screen.width / (width * PPI + 120), app.screen.height / (height * PPI + 220));
    board.focus(width / 2, height / 2 - 2, fit);
  };
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

  // Online: jeder Spieler lädt nur seine eigene Armee
  new Lobby(store, (me) => {
    document.querySelectorAll<HTMLElement>('[data-import]').forEach((btn) => {
      btn.hidden = btn.dataset.import !== me;
    });
    gameBar.setOnlinePlayer(me);
  });
}

start();
