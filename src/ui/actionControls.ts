import { currentPhase, currentSub, SUB_DECLARE } from '../model/phases';
import type { Store } from '../model/store';
import type { PlayerId, UnitState } from '../model/types';
import type { Board } from '../view/board';
import type { PromptCenter } from './prompts';
import { TEST_TYPES } from './prompts';
import { onSheetChange } from './sheets';

const $ = (id: string) => document.getElementById(id)!;
const sel = (id: string) => $(id) as HTMLSelectElement;
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Bedienelemente, die Abläufe mit dem Gegner auslösen: Angriff ansagen, Test verlangen,
 * Ziel für Treffer, deren Rüstungswurf der Gegner macht.
 */
export class ActionControls {
  constructor(
    private store: Store,
    private board: Board,
    private prompts: PromptCenter,
    private seat: () => PlayerId | 'spectator' | null,
  ) {
    sel('p-test-type').innerHTML = Object.entries(TEST_TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
    sel('p-test-mod').innerHTML = [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3]
      .map((n) => `<option value="${n}" ${n === 0 ? 'selected' : ''}>Ld ${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n)}</option>`).join('');

    $('p-charge').onclick = () => this.declareCharge();
    $('p-attack').onclick = () => this.attack();
    $('p-test').onclick = () => {
      const id = this.board.selectedId;
      if (id) this.prompts.requestTest(this.me(), id, sel('p-test-type').value, Number(sel('p-test-mod').value));
    };

    store.subscribe(() => this.refresh());
    onSheetChange(() => this.refresh());
    this.refresh();
  }

  /** Wer gerade handelt: online der eigene Platz, offline der Spieler am Zug. */
  private me(): PlayerId {
    const s = this.seat();
    return s && s !== 'spectator' ? s : this.store.state.meta.active;
  }

  /**
   * Beschuss (Fernkampfphase) oder Nahkampf: Ziel anklicken, dann führen Popups durch Treffer- und
   * Verwundungswurf; der Gegner macht danach Rüstungs-, Rettungs- und Regenerationswurf.
   */
  attack(): void {
    const reason = this.attackBlocked();
    if (reason) return;
    const units = this.store.state.units;
    const id = this.board.selectedId!;
    const attackerId = units[id]?.joinedTo && units[units[id].joinedTo!] ? units[id].joinedTo! : id;
    const mode = currentPhase(this.store.state.meta) === 'shooting' ? 'shooting' : 'combat';
    this.board.startChargePick(attackerId, (targetId) => this.prompts.startAttack(this.me(), attackerId, targetId, mode),
      mode === 'shooting' ? 'Shooting' : 'Attack');
  }

  private attackBlocked(): string | null {
    const { units, meta } = this.store.state;
    const u = this.board.selectedId ? units[this.board.selectedId] : undefined;
    if (!u) return 'Select one of your units first.';
    const host = u.joinedTo && units[u.joinedTo] ? units[u.joinedTo] : u;
    const phase = currentPhase(meta);
    if (phase !== 'shooting' && phase !== 'combat') return 'Attacks are made in the Shooting phase (shooting) or the Combat phase (combat).';
    if (this.seat() && this.seat() !== host.owner) return 'Online, each player attacks only with their own units.';
    if (phase === 'shooting' && host.owner !== meta.active) return 'Only the active player shoots.';
    if (host.status === 'fleeing') return 'Fleeing units cannot attack.';
    return null;
  }

  /** Angriff ansagen: nur eigene Einheit in der eigenen Bewegungsphase. */
  declareCharge(): void {
    // Noch nicht verschickter Angriff dieser Einheit: zurücknehmen
    const own = this.ownUnsentCharge();
    if (own) {
      this.prompts.withdrawCharge(own);
      return;
    }
    const reason = this.chargeBlocked();
    if (reason) {
      $('p-charge').title = reason;
      return;
    }
    const id = this.board.selectedId!;
    const units = this.store.state.units;
    const chargerId = units[id]?.joinedTo && units[units[id].joinedTo!] ? units[id].joinedTo! : id;
    this.board.startChargePick(chargerId, (targetId) => this.prompts.declareCharge(chargerId, targetId));
  }

  private chargeBlocked(): string | null {
    const { units, meta, charges } = this.store.state;
    const u = this.board.selectedId ? units[this.board.selectedId] : undefined;
    if (!u) return 'Select one of your units first.';
    const host = u.joinedTo && units[u.joinedTo] ? units[u.joinedTo] : u;
    if (host.owner !== meta.active || (this.seat() && this.seat() !== host.owner)) return 'Only the active player declares charges.';
    if (currentPhase(meta) !== 'movement' || currentSub(meta) !== SUB_DECLARE) {
      return 'Charges are declared in the Movement phase, sub-phase “Declare Charges & Charge Reactions”.';
    }
    if (host.status === 'fleeing') return 'Fleeing units cannot declare a charge.';
    if (Object.values(charges).some((c) => c.charger === host.id)) return 'This unit has already declared a charge.';
    return null;
  }

  /** Angriff der ausgewählten Einheit, der noch nicht an den Gegner geschickt wurde */
  private ownUnsentCharge(): string | null {
    const units = this.store.state.units;
    const u = this.board.selectedId ? units[this.board.selectedId] : undefined;
    if (!u) return null;
    const host = u.joinedTo && units[u.joinedTo] ? units[u.joinedTo] : u;
    return this.prompts.unsentCharges().find((c) => c.charger === host.id)?.id ?? null;
  }

  /** Auswahllisten und Knöpfe an Auswahl, Phase und eigenen Platz anpassen. */
  refresh(): void {
    const { units } = this.store.state;
    const me = this.me();
    const blocked = this.chargeBlocked();
    const btn = $('p-charge') as HTMLButtonElement;
    const withdraw = !!this.ownUnsentCharge();
    btn.textContent = withdraw ? '↶ Withdraw charge' : '⚔ Declare charge';
    btn.disabled = !withdraw && !!blocked;
    btn.title = withdraw ? 'Withdraw the charge while declaring' : blocked ?? 'Then click the enemy unit to charge (J)';
    // Warum der Knopf gesperrt ist, steht direkt darunter
    $('p-charge-why').textContent = withdraw ? '' : blocked ?? '';
    const attackBlocked = this.attackBlocked();
    const attackBtn = $('p-attack') as HTMLButtonElement;
    attackBtn.textContent = currentPhase(this.store.state.meta) === 'combat' ? '⚔ Attack in combat' : '🎯 Shoot';
    attackBtn.disabled = !!attackBlocked;
    attackBtn.title = attackBlocked ?? 'Then click the enemy unit (To Hit, To Wound, then the opponent rolls saves)';
    $('p-attack-why').textContent = attackBlocked ?? '';

    const own = (u: UnitState) => u.owner === me;
    const fill = (id: string, list: UnitState[], empty: string) => {
      const box = sel(id);
      const keep = box.value;
      box.innerHTML = `<option value="">${empty}</option>` +
        list.map((u) => `<option value="${u.id}">${esc(u.info.name)}${u.models > 1 ? ` (${u.models})` : ''}</option>`).join('');
      if (list.some((u) => u.id === keep)) box.value = keep;
    };
    fill('d-target', Object.values(units).filter((u) => !own(u)), '– (roll saves yourself)');
  }
}
