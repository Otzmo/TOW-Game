import { Application, Container, Text } from 'pixi.js';
import { PPI, UPRIGHT } from './theme';

/** Bildschirmbereich in Pixeln */
export interface ScreenArea {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const MAX_SCALE = 8;
const WHEEL_STEP = 1.12;

/**
 * Kamera über dem Tisch: Zoomen, Verschieben und Drehen um 180°.
 * world.pivot ist die Tischmitte, world.position deren Stelle auf dem Bildschirm.
 */
export class Camera {
  /**
   * Freier Bereich für den Tisch in Bildschirmpixeln (zwischen der Spalte links und der Spalte rechts,
   * abzüglich Platz für die Zoll-Leisten). Kommt aus main.ts.
   */
  viewArea: () => ScreenArea = () => ({ left: 0, top: 0, right: this.app.screen.width, bottom: this.app.screen.height });

  /** Wird gerufen, wenn sich die Drehung der Ansicht ändert (für den Knopf) */
  onRotate: (rotated: boolean) => void = () => {};

  /** Bilder, in denen nach einer Drehung noch Texte aufgerichtet werden */
  private settleFrames = 0;

  /**
   * @param table Tischgröße in Zoll
   * @param onView nach jeder Änderung von Zoom oder Lage (z. B. Maßband-Beschriftung gleich groß halten)
   */
  constructor(private app: Application, private world: Container, private table: { width: number; height: number },
    private onView: () => void) {
    world.pivot.set((table.width * PPI) / 2, (table.height * PPI) / 2);
    app.ticker.add(() => {
      // Nach dem Zurückdrehen noch ein paar Bilder lang: bleibende Texte (z. B. die Zahl am Maßband beim Ziehen)
      // wurden in der gedrehten Ansicht umgedreht und stünden sonst jetzt auf dem Kopf
      if (this.rotated || this.settleFrames > 0) {
        keepTextUpright(world);
        this.settleFrames = Math.max(0, this.settleFrames - 1);
      }
    });
    app.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
  }

  /** Kleinster Zoom: der ganze Tisch passt in den freien Bereich. */
  private minScale(): number {
    const a = this.viewArea();
    return Math.min((a.right - a.left) / (this.table.width * PPI), (a.bottom - a.top) / (this.table.height * PPI));
  }

  /** Um eine Bildschirmstelle zoomen; sie bleibt dabei unter dem Mauszeiger. */
  private zoomAt(mx: number, my: number, factor: number): void {
    const s = this.world.scale.x;
    const ns = Math.min(MAX_SCALE, Math.max(this.minScale(), s * factor));
    const wx = (mx - this.world.x) / s;
    const wy = (my - this.world.y) / s;
    this.world.scale.set(ns);
    this.world.position.set(mx - wx * ns, my - wy * ns);
    this.clamp();
  }

  /** Um die Mitte des freien Bereichs zoomen. */
  zoomBy(factor: number): void {
    const a = this.viewArea();
    this.zoomAt((a.left + a.right) / 2, (a.top + a.bottom) / 2, factor);
  }

  /** Ansicht verschieben (Bildschirmpixel), bleibt an den Leisten. */
  panBy(dx: number, dy: number): void {
    this.moveTo(this.world.x + dx, this.world.y + dy);
  }

  /** Tischmitte an eine Bildschirmstelle legen (Ziehen mit der Maus), bleibt an den Leisten. */
  moveTo(x: number, y: number): void {
    this.world.position.set(x, y);
    this.clamp();
  }

  /** Ist die Ansicht um 180° gedreht? */
  get rotated(): boolean {
    return Math.abs(this.world.rotation) > 1;
  }

  /** Ansicht um 180° drehen (nur die Anzeige; Positionen bleiben für beide Spieler gleich) */
  setRotated(on: boolean): void {
    if (on === this.rotated) return;
    this.world.rotation = on ? Math.PI : 0;
    // Die Weltlage der Texte stimmt erst nach dem nächsten Zeichnen; darum mehrere Bilder lang prüfen
    this.settleFrames = 3;
    this.fit();
    this.onRotate(on);
  }

  /** Ganzen Tisch zeigen, mittig zwischen den Spalten links und rechts. */
  fit(): void {
    this.world.scale.set(this.minScale());
    this.clamp();
  }

  /**
   * Tisch bleibt zwischen den Spalten: Passt er in eine Richtung ganz hinein, liegt er dort mittig;
   * ist er größer (hineingezoomt), lässt er sich nur so weit verschieben, dass keine Lücke zu den Spalten entsteht.
   * world.position ist die Bildschirmstelle der Tischmitte (Drehpunkt), darum gilt das auch für die gedrehte Ansicht.
   */
  private clamp(): void {
    const a = this.viewArea();
    const s = Math.max(this.world.scale.x, this.minScale());
    this.world.scale.set(s);
    const w = this.table.width * PPI * s;
    const h = this.table.height * PPI * s;
    const x = w <= a.right - a.left ? (a.left + a.right) / 2 : Math.min(a.left + w / 2, Math.max(a.right - w / 2, this.world.x));
    const y = h <= a.bottom - a.top ? (a.top + a.bottom) / 2 : Math.min(a.top + h / 2, Math.max(a.bottom - h / 2, this.world.y));
    this.world.position.set(x, y);
    this.onView();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const r = this.app.canvas.getBoundingClientRect();
    this.zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP);
  }
}

/**
 * In der gedrehten Ansicht stünden Texte auf dem Kopf: jeden Text, der gerade kopfüber steht, um 180° drehen.
 * Läuft bei jedem Bild; neu gezeichnete Texte werden so sofort wieder aufrecht.
 */
function keepTextUpright(node: Container): void {
  for (const child of node.children) {
    // Schilder (Name mit Plakette, Trefferzähler) als Ganzes um ihre Mitte drehen, damit nichts auseinanderfällt
    if (child.label === UPRIGHT || child instanceof Text) {
      const m = child.worldTransform;
      if (Math.cos(Math.atan2(m.b, m.a)) < -0.01) child.rotation += Math.PI;
    } else if (child.children?.length) keepTextUpright(child as Container);
  }
}
