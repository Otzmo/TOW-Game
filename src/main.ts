import { Application } from 'pixi.js';
import './style.css';
import { demoUnits } from './demoUnits';
import { Store } from './model/store';
import type { GameState } from './model/types';
import { UnitPanel } from './ui/panel';
import { Board } from './view/board';

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
    units: Object.fromEntries(demoUnits.map((u) => [u.id, structuredClone(u)])),
  };
  const store = new Store(state);

  const panel = new UnitPanel(store, () => board.select(null));
  const board: Board = new Board(app, store, {
    onSelect: (id) => panel.show(id),
    onAction: (id, text) => panel.setLastAction(id, text),
  });

  board.focus(34, 26, 2.2, 0.4);
}

start();
