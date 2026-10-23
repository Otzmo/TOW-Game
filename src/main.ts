import { Application } from 'pixi.js';
import './style.css';
import { Store } from './model/store';
import type { GameState } from './model/types';
import { ImportDialog } from './ui/importDialog';
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

  const state: GameState = { table: { width: 72, height: 48 }, units: {} };
  const store = new Store(state);

  const panel = new UnitPanel(store, () => board.select(null));
  const board: Board = new Board(app, store, {
    onSelect: (id) => panel.show(id),
    onAction: (id, text) => panel.setLastAction(id, text),
  });
  // Ganzen Tisch zeigen, auch nach jedem Armeeimport
  const { width, height } = state.table;
  const showTable = () => {
    const fit = Math.min(app.screen.width / (width * PPI + 80), app.screen.height / (height * PPI + 120));
    board.focus(width / 2, height / 2, fit);
  };
  new ImportDialog(store, showTable);
  showTable();
}

start();
