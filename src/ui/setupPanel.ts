import {
  DEPLOYMENTS, deploymentZones, generateBattlefield, MISSIONS, missionByKey, SCORING_RULES, TERRAIN_RULES,
} from '../model/battlefield';
import { roll } from '../model/flow';
import { moveToNoMansLand } from '../model/noMansLand';
import { playerName } from '../model/players';
import type { History } from '../model/history';
import { OBJECT_TYPES, pointInPolygon } from '../model/objects';
import { currentPhase, currentSub } from '../model/phases';
import { isJoined, type Store } from '../model/store';
import type { LogEntry, PlayerId, SetupState, UnitState } from '../model/types';
import { openedSheet, openSheet } from './sheets';

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const other = (p: PlayerId): PlayerId => (p === 'p1' ? 'p2' : 'p1');

/** Unterschritte der Aufbauphase (OTZMO-TOW Core Battle, Game Sequence) */
export const SETUP_STEPS = {
  armies: 0,
  battlefield: 1,
  attacker: 2,
  zones: 3,
  deploy: 4,
  scouts: 5,
  firstTurn: 6,
};

/**
 * Aufbauphase: Schlachtfeld auswürfeln (Aufstellung, Missionen, Gelände), Roll-off um Angreifer
 * und Verteidiger, Zonenwahl, abwechselndes Aufstellen und Roll-off für den ersten Zug.
 */
export class SetupPanel {
  constructor(
    private store: Store,
    private history: History,
    private seat: () => PlayerId | 'spectator' | null,
    private log: (entry: Pick<LogEntry, 'kind' | 'text' | 'dice'>) => void,
  ) {
    $('setup-options').innerHTML = this.optionsHtml();
    $('sheet-battlefield').onclick = (e) => this.onClick(e);
    $('setup-confirm').onclick = () => this.confirm();
    let lastKey = '';
    store.subscribe((state, c) => {
      if (!c.meta && !c.loaded && !c.objectId && !c.unitId && !c.replacedOwner) return;
      // In der Aufbauphase das Fenster bei jedem neuen Schritt öffnen
      const key = `${currentPhase(state.meta)}-${currentSub(state.meta)}`;
      if (key !== lastKey && currentPhase(state.meta) === 'setup' && (c.meta || c.loaded)) openSheet('battlefield');
      // Schlacht beginnt: das Fenster schließt sich, sein Knopf ist dann ausgeblendet
      if (key !== lastKey && currentPhase(state.meta) !== 'setup' && openedSheet() === 'battlefield') openSheet(null);
      lastKey = key;
      this.render();
    });
    this.render();
    // Spielbeginn: der erste Aufbauschritt ist gleich offen
    if (currentPhase(store.state.meta) === 'setup') openSheet('battlefield');
  }

  /** Weiter zum nächsten Aufbauschritt (von main.ts gesetzt: gameBar.requestNext) */
  onNext: () => void = () => {};

  /**
   * Schritt bestätigen: Popup schließt sich, der Aufbau geht weiter und das nächste Popup öffnet sich
   * (siehe subscribe im Konstruktor). Die Zonenwahl wird dabei zugleich festgelegt.
   */
  private confirm(): void {
    const { meta } = this.store.state;
    if (currentPhase(meta) !== 'setup' || this.confirmBlocker() || this.seat() === 'spectator') return;
    const step = currentSub(meta);
    if (step === SETUP_STEPS.zones && !meta.setup?.zoneChosen) {
      this.setSetup({ zoneChosen: true });
      this.log({ kind: 'turn', text: 'The Defender has chosen the Defender zone' });
    }
    openSheet(null);
    this.onNext();
    // Ging es nicht weiter (z. B. Rückfrage zu Plänklern links), bleibt der Schritt offen
    const now = this.store.state.meta;
    if (currentPhase(now) === 'setup' && currentSub(now) === step) openSheet('battlefield');
  }

  /** Was dem Bestätigen noch im Weg steht; die Zonenwahl bestätigt der Knopf selbst. */
  private confirmBlocker(): string | null {
    const { meta } = this.store.state;
    if (currentPhase(meta) === 'setup' && currentSub(meta) === SETUP_STEPS.zones) {
      return meta.setup?.defender ? null : 'Roll off for Attacker / Defender first';
    }
    return this.blocker();
  }

  /** Was noch fehlt, bevor es im Aufbau weitergeht (null = weiter möglich) */
  blocker(): string | null {
    const { meta } = this.store.state;
    if (currentPhase(meta) !== 'setup') return null;
    const s = meta.setup ?? {};
    switch (currentSub(meta)) {
      case SETUP_STEPS.armies: {
        const units = Object.values(this.store.state.units);
        const missing = (['p1', 'p2'] as const).filter((p) => !units.some((u) => u.owner === p));
        return missing.length ? `Load the army of ${missing.map((p) => playerName(p)).join(' and ')}` : null;
      }
      case SETUP_STEPS.battlefield: return s.deployment ? null : 'Generate the battlefield first';
      case SETUP_STEPS.attacker: return s.defender ? null : 'Roll off for Attacker / Defender';
      case SETUP_STEPS.zones: return s.zoneChosen ? null : 'Defender confirms the Defender zone';
      case SETUP_STEPS.deploy: return s.finished?.p1 && s.finished?.p2 ? null : 'Both players finish deploying';
      case SETUP_STEPS.firstTurn: return s.firstPlayer ? null : 'Roll off for the first turn';
      default: return null;
    }
  }

  /** Darf ich für diesen Spieler entscheiden? (offline immer, online nur für den eigenen Platz) */
  private mayAct(p: PlayerId | null | undefined): boolean {
    const s = this.seat();
    if (s === 'spectator') return false;
    return !s || !p || s === p;
  }

  private setSetup(patch: Partial<SetupState>): void {
    this.store.setMeta({ setup: { ...this.store.state.meta.setup, ...patch } });
  }

  // --- Schlachtfeld -----------------------------------------------------------

  private optionsHtml(): string {
    const box = (name: string, value: string, label: string) =>
      `<label class="check"><input type="checkbox" name="${name}" value="${value}" checked> ${esc(label)}</label>`;
    return `<fieldset><legend>Deployment</legend>${Object.entries(DEPLOYMENTS).map(([k, v]) => box('deployment', k, v)).join('')}</fieldset>
      <fieldset><legend>Mission – End of player turn</legend>${MISSIONS.filter((m) => m.group === 'turn').map((m) => box('turn', m.key, m.name)).join('')}</fieldset>
      <fieldset><legend>Mission – End of game</legend>${MISSIONS.filter((m) => m.group === 'game').map((m) => box('game', m.key, m.name)).join('')}</fieldset>`;
  }

  private checked(name: string): string[] {
    return [...document.querySelectorAll<HTMLInputElement>(`#setup-options input[name="${name}"]:checked`)].map((i) => i.value);
  }

  /** Schlachtfeld auswürfeln: ersetzt Gelände und Missionsziele, andere Marker bleiben. */
  private randomise(): void {
    const result = generateBattlefield({
      deployments: this.checked('deployment'), turnMissions: this.checked('turn'), gameMissions: this.checked('game'),
    });
    this.history.record();
    for (const o of Object.values(this.store.state.objects)) {
      if (o.kind === 'terrain' || o.type === 'objective') this.store.removeObject(o.id);
    }
    for (const o of result.objects) this.store.setObject(o);
    // Neues Schlachtfeld: Zonenwahl und Aufstellung beginnen von vorn
    this.setSetup({ ...result.setup, swapZones: false, zoneChosen: false });
    // Noch nicht aufgestellte Armeen passen sich an die neuen Zonen und das neue Gelände an
    if (this.seat() !== 'spectator') moveToNoMansLand(this.store);
    const s = result.setup;
    this.log({ kind: 'turn', text: `Battlefield: ${DEPLOYMENTS[s.deployment!]} · ${[missionByKey(s.missionTurn), missionByKey(s.missionGame)].filter(Boolean).map((m) => m!.name).join(' + ') || 'no mission'} · ${result.objects.filter((o) => o.kind === 'terrain').length} terrain features` });
  }

  /** Alle Einheiten zurück ins Niemandsland: außerhalb beider Aufstellungszonen und außerhalb von Gelände */
  private toNoMansLand(): void {
    // Gilt für beide Armeen, auch online; nur Zuschauer dürfen es nicht
    if (this.seat() === 'spectator') return;
    this.history.record();
    moveToNoMansLand(this.store);
    this.log({ kind: 'action', text: 'All units moved back to no man\'s land' });
  }

  private clearTerrain(): void {
    this.history.record();
    for (const o of Object.values(this.store.state.objects)) if (o.kind === 'terrain' || o.type === 'objective') this.store.removeObject(o.id);
  }

  // --- Roll-offs und Entscheidungen -------------------------------------------

  /** Roll-off: je ein W6, bei Gleichstand neu; bonus = +1 für einen Spieler */
  private rollOff(bonus?: PlayerId | null): { rolls: Record<PlayerId, number>; winner: PlayerId; dice: number[][] } {
    const dice: number[][] = [];
    for (;;) {
      const [a, b] = roll(2);
      dice.push([a, b]);
      const p1 = a + (bonus === 'p1' ? 1 : 0);
      const p2 = b + (bonus === 'p2' ? 1 : 0);
      if (p1 !== p2) return { rolls: { p1, p2 }, winner: p1 > p2 ? 'p1' : 'p2', dice };
    }
  }

  private onClick(e: MouseEvent): void {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-setup]');
    if (!btn) return;
    const s = this.store.state.meta.setup ?? {};
    const act = btn.dataset.setup!;
    if (act === 'randomise') this.randomise();
    else if (act === 'clear') this.clearTerrain();
    else if (act === 'nomansland') this.toNoMansLand();
    else if (act === 'roll-attacker') {
      const r = this.rollOff();
      this.setSetup({ rollOff: r.rolls, rollWinner: r.winner, defender: null });
      this.log({ kind: 'roll', dice: r.dice, text: `Roll-off for Attacker / Defender: Player 1 ${r.rolls.p1}, Player 2 ${r.rolls.p2} – ${playerName(r.winner)} chooses` });
    } else if (act === 'attacker' || act === 'defender') {
      const winner = s.rollWinner!;
      const defender = act === 'defender' ? winner : other(winner);
      // Der Verteidiger stellt die erste Einheit auf
      this.setSetup({ defender, deployNext: defender });
      this.log({ kind: 'turn', text: `Player ${winner === 'p1' ? 1 : 2} chooses to be the ${act === 'defender' ? 'Defender' : 'Attacker'} – from now on: Player ${defender === 'p1' ? 1 : 2} = Defender, Player ${defender === 'p1' ? 2 : 1} = Attacker` });
    } else if (act === 'zone-swap') {
      // Der Verteidiger wählt seine Zone: Angreifer- und Verteidigerzone tauschen
      this.setSetup({ swapZones: !s.swapZones });
      moveToNoMansLand(this.store);
    } else if (act === 'placed') {
      const next = other(s.deployNext ?? s.defender ?? 'p1');
      // Wer fertig ist, stellt nicht mehr auf
      this.setSetup({ deployNext: s.finished?.[next] ? s.deployNext : next });
    } else if (act === 'finished-p1' || act === 'finished-p2') {
      const p = act.slice(-2) as PlayerId;
      const finished = { ...s.finished, [p]: !s.finished?.[p] };
      const finishedFirst = s.finishedFirst ?? (finished[p] ? p : null);
      this.setSetup({ finished, finishedFirst, deployNext: finished[p] ? other(p) : s.deployNext });
      if (finished[p]) this.log({ kind: 'turn', text: `${playerName(p)} has finished deploying${finishedFirst === p ? ' first (+1 to the roll-off for the first turn)' : ''}` });
    } else if (act === 'roll-first') {
      const r = this.rollOff(s.finishedFirst);
      this.setSetup({ firstRoll: r.rolls, firstWinner: r.winner, firstPlayer: null });
      this.log({ kind: 'roll', dice: r.dice, text: `Roll-off for the first turn${s.finishedFirst ? ` (+1 for ${playerName(s.finishedFirst)})` : ''}: ${playerName('p1')} ${r.rolls.p1}, ${playerName('p2')} ${r.rolls.p2} – ${playerName(r.winner)} chooses` });
    } else if (act === 'first-me' || act === 'first-other') {
      const first = act === 'first-me' ? s.firstWinner! : other(s.firstWinner!);
      this.setSetup({ firstPlayer: first });
      this.log({ kind: 'turn', text: `${playerName(first)} has the first player turn` });
    }
  }

  // --- Anzeige ----------------------------------------------------------------

  private render(): void {
    const { meta, units } = this.store.state;
    const s = meta.setup ?? {};
    const inSetup = currentPhase(meta) === 'setup';
    const step = inSetup ? currentSub(meta) : -1;

    // Ergebnis: Aufstellung, Missionen, Regeln
    const missions = [missionByKey(s.missionTurn), missionByKey(s.missionGame)];
    // Je Schritt nur, was dort gebraucht wird
    $('setup-armies').hidden = step !== SETUP_STEPS.armies;
    $('setup-gen').hidden = step !== SETUP_STEPS.battlefield;
    $('setup-nml').hidden = !(step >= SETUP_STEPS.battlefield && step <= SETUP_STEPS.deploy);
    $('setup-terrain').hidden = step !== SETUP_STEPS.battlefield && step !== SETUP_STEPS.zones;
    $('setup-title').textContent = inSetup ? `Setup · Step ${step + 1} of 7` : 'Setup';
    const blocked = inSetup ? this.confirmBlocker() : 'The battle has started';
    const confirm = $('setup-confirm') as HTMLButtonElement;
    confirm.textContent = ['Armies loaded ✓', 'Confirm battlefield ✓', 'Confirm Attacker & Defender ✓', 'Confirm Defender zone ✓',
      'Deployment finished ✓', 'Scouts & Vanguard done ✓', 'Start Battle ✓'][step] ?? 'Confirm ✓';
    confirm.disabled = !!blocked || this.seat() === 'spectator';
    $('setup-blocker').textContent = blocked ?? '';
    $('setup-result').innerHTML = s.deployment
      ? `<p><b>Deployment:</b> ${esc(DEPLOYMENTS[s.deployment])}</p>` +
        missions.map((m, i) => m ? `<details><summary>${i === 0 ? 'End of player turn' : 'End of game'}: ${esc(m.name)}</summary><p>${esc(m.rule)}</p></details>` : '').join('') +
        `<details><summary>Scoring</summary><p>${esc(SCORING_RULES)}</p></details>` +
        `<details><summary>Terrain Rules</summary><p>${esc(TERRAIN_RULES)}\n${['woods', 'building', 'ruins', 'field', 'lake', 'hill'].map((k) => `${OBJECT_TYPES[k].name}: ${OBJECT_TYPES[k].rules!.join(' · ')}`).join('\n')}</p></details>`
      : '<p class="meta">No battlefield yet. Choose the options and randomise, or place terrain by hand.</p>';
    // Fenster „Mission“ links unten: gewürfelte Aufstellung und Missionen mit Beschreibung, jederzeit nachzulesen
    $('mission-info').innerHTML = s.deployment || missions.some(Boolean)
      ? (s.deployment ? `<p><b>Deployment:</b> ${esc(DEPLOYMENTS[s.deployment])}</p>` : '') +
        missions.map((m, i) => m ? `<h4>${i === 0 ? 'End of player turn' : 'End of game'}: ${esc(m.name)}</h4><p class="mission-rule">${esc(m.rule)}</p>` : '').join('') +
        `<details><summary>Scoring</summary><p class="mission-rule">${esc(SCORING_RULES)}</p></details>`
      : '<p class="meta">No mission rolled yet. Randomise the battlefield in setup step 2.</p>';

    $('setup-step').innerHTML = inSetup ? this.stepHtml(step, s, units) : '<p class="meta">The battle has started. The battlefield can still be changed here.</p>';
    // Generator nur vor der Zonenwahl
    ($('setup-generate') as HTMLButtonElement).disabled = !this.mayAct(null) || (inSetup && step > SETUP_STEPS.attacker);
  }

  private stepHtml(step: number, s: SetupState, units: Record<string, UnitState>): string {
    const btn = (act: string, label: string, enabled = true, primary = false) =>
      `<button data-setup="${act}" class="${primary ? 'primary' : ''}" ${enabled ? '' : 'disabled'}>${esc(label)}</button>`;
    const rolls = (r?: Partial<Record<PlayerId, number>> | null) => r ? `<p>${playerName('p1')}: <b>${r.p1}</b> · ${playerName('p2')}: <b>${r.p2}</b></p>` : '';
    // Kurz zur Erinnerung: gewürfelte Aufstellung und Missionen
    const missionLine = s.deployment ? `<p class="meta">${esc([DEPLOYMENTS[s.deployment], ...[missionByKey(s.missionTurn), missionByKey(s.missionGame)].filter(Boolean).map((m) => m!.name)].join(' · '))}</p>` : '';
    switch (step) {
      case SETUP_STEPS.armies: {
        const armies = this.store.state.meta.armies ?? {};
        const count = (p: PlayerId) => Object.values(units).filter((u) => u.owner === p && !isJoined(u, units)).length;
        return `<h4>Load Armies</h4><p>Each player loads their army list (.bb.json from oldworldrankings). The armies are placed in no man's land.</p>
          ${(['p1', 'p2'] as const).map((p) => `<p><span class="dot ${p}"></span>${playerName(p)}: ${armies[p] ? `<b>${esc(armies[p]!.faction)}</b> · ${esc(armies[p]!.list)} (${count(p)} units)` : '<span class="meta">no army loaded</span>'}</p>`).join('')}`;
      }
      case SETUP_STEPS.battlefield:
        return `<h4>Generate Battlefield</h4><p>Randomise deployment, missions and terrain (or place terrain by hand below), then confirm.</p>`;
      case SETUP_STEPS.attacker:
        return `<h4>Roll-off: Attacker & Defender</h4>${missionLine}<p>The winner of the roll-off decides if they are the Attacker or the Defender.</p>
          ${rolls(s.rollOff)}
          ${s.rollWinner ? `<p><b>${playerName(s.rollWinner)}</b> chooses:</p><div class="row-btns">${btn('attacker', 'Be the Attacker', this.mayAct(s.rollWinner))}${btn('defender', 'Be the Defender', this.mayAct(s.rollWinner))}</div>` : ''}
          ${s.defender ? `<p class="ok">Defender: Player ${s.defender === 'p1' ? 1 : 2} · Attacker: Player ${s.defender === 'p1' ? 2 : 1}</p>` : btn('roll-attacker', s.rollOff ? 'Roll again' : 'Roll off (D6)', this.mayAct(null), true)}`;
      case SETUP_STEPS.zones:
        return `<h4>Deployment Zone & Terrain</h4><p>The Defender chooses the deployment zone (swap if needed) and places additional terrain and the Baggage Train first. The Defender declares Ambushers first.</p>
          ${missionLine}
          <div class="row-btns">${btn('zone-swap', 'Swap Attacker and Defender zones', this.mayAct(s.defender))}</div>`;
      case SETUP_STEPS.deploy: {
        const zones = deploymentZones(s);
        const outside = zones ? Object.values(units).filter((u) => !isJoined(u, units) && !pointInPolygon(u, zones[u.owner])) : [];
        const next = s.deployNext ?? s.defender ?? 'p1';
        return `<h4>Deploy Units</h4><p>The Defender places the first unit, then players alternate placing units. Scouts are either placed normally or after characters.</p>
          <p>Next to place a unit: <b><span class="dot ${next}"></span>${playerName(next)}</b></p>
          <div class="row-btns">${btn('placed', `Unit placed – ${playerName(other(next))}'s turn`, this.mayAct(next), true)}</div>
          <div class="row-btns">${(['p1', 'p2'] as const).map((p) => btn(`finished-${p}`, `${playerName(p)}: ${s.finished?.[p] ? 'finished ✓' : 'finished deploying'}`, this.mayAct(p))).join('')}</div>
          ${outside.length ? `<p class="warn">Outside their deployment zone: ${outside.map((u) => esc(u.info.name)).join(', ')}</p>` : ''}`;
      }
      case SETUP_STEPS.scouts:
        return `<h4>Scouts & Vanguard</h4><p>Scouts not yet deployed are placed now (after characters). Then Vanguard moves are made – roll off if both players have such units.</p>`;
      case SETUP_STEPS.firstTurn:
        return `<h4>Roll-off for First Turn</h4><p>The winner chooses who has the first player turn (+1 for the player who finished deployment first${s.finishedFirst ? `: ${playerName(s.finishedFirst)}` : ''}).</p>
          ${rolls(s.firstRoll)}
          ${s.firstWinner && !s.firstPlayer ? `<p><b>${playerName(s.firstWinner)}</b> chooses:</p><div class="row-btns">${btn('first-me', 'Take the first turn', this.mayAct(s.firstWinner))}${btn('first-other', 'Give the first turn', this.mayAct(s.firstWinner))}</div>` : ''}
          ${s.firstPlayer ? `<p class="ok">${playerName(s.firstPlayer)} has the first player turn.</p>` : s.firstWinner ? '' : btn('roll-first', 'Roll off (D6)', this.mayAct(null), true)}`;
      default:
        return '';
    }
  }
}

