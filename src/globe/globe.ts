/**
 * Canvas-rendered rotatable 3D globe (orthographic projection) — the same
 * interaction model as MapTap.gg: drag to rotate, scroll/pinch to zoom,
 * tap to drop a pin.
 */
import {
  geoOrthographic,
  geoPath,
  geoGraticule10,
  geoDistance,
  geoInterpolate,
  type GeoProjection,
} from 'd3-geo';
import { feature, mesh } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import worldData from 'world-atlas/countries-110m.json';
import type { LatLon } from '../core/geo';

const world = worldData as unknown as Topology<{ countries: GeometryCollection }>;
const land = feature(world, world.objects.countries);
const borders = mesh(world, world.objects.countries, (a, b) => a !== b);
const graticule = geoGraticule10();

export interface GlobeCallbacks {
  onPin?: (p: LatLon) => void;
}

interface Reveal {
  guess: LatLon | null;
  target: LatLon;
}

const MIN_SCALE_FACTOR = 0.45;
const MAX_SCALE_FACTOR = 14;
const CLICK_SLOP_PX = 6;

export class Globe {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private projection: GeoProjection;
  private rotation: [number, number] = [-10, -25];
  private baseScale = 1;
  private zoom = 1;
  private pin: LatLon | null = null;
  private reveal: Reveal | null = null;
  private raf = 0;
  private animRaf = 0;
  private pointers = new Map<number, { x: number; y: number }>();
  private downPos: { x: number; y: number } | null = null;
  private moved = 0;
  private pinchDist = 0;
  interactive = true;

  constructor(
    private container: HTMLElement,
    private callbacks: GlobeCallbacks = {},
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'globe-canvas';
    container.appendChild(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;
    this.projection = geoOrthographic().clipAngle(90);

    this.resize();
    window.addEventListener('resize', this.resize);
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.animRaf);
    window.removeEventListener('resize', this.resize);
    this.canvas.remove();
  }

  // ── public API ────────────────────────────────────────────────────

  setPin(p: LatLon | null): void {
    this.pin = p;
    this.requestRender();
  }

  getPin(): LatLon | null {
    return this.pin;
  }

  /** Show guess → target reveal, rotating to frame the result. */
  showReveal(guess: LatLon | null, target: LatLon): void {
    this.reveal = { guess, target };
    this.pin = null;
    const focus = guess
      ? geoInterpolate([guess.lon, guess.lat], [target.lon, target.lat])(0.5)
      : ([target.lon, target.lat] as [number, number]);
    this.animateTo([-focus[0], -focus[1]]);
  }

  clearReveal(): void {
    this.reveal = null;
    this.requestRender();
  }

  resetView(): void {
    this.zoom = 1;
    this.animateTo([-10, -25]);
  }

  // ── interaction ───────────────────────────────────────────────────

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.interactive) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (this.pointers.size === 1) {
      this.downPos = { x: e.offsetX, y: e.offsetY };
      this.moved = 0;
    } else if (this.pointers.size === 2) {
      this.pinchDist = this.pinchDistance();
    }
    cancelAnimationFrame(this.animRaf);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.interactive || !this.pointers.has(e.pointerId)) return;
    const prev = this.pointers.get(e.pointerId)!;
    const dx = e.offsetX - prev.x;
    const dy = e.offsetY - prev.y;
    this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });

    if (this.pointers.size === 2) {
      const d = this.pinchDistance();
      if (this.pinchDist > 0) this.applyZoom(d / this.pinchDist);
      this.pinchDist = d;
      return;
    }

    this.moved += Math.abs(dx) + Math.abs(dy);
    const k = 60 / this.projection.scale()!;
    this.rotation[0] += dx * k;
    this.rotation[1] = Math.max(-90, Math.min(90, this.rotation[1] - dy * k));
    this.requestRender();
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    this.pinchDist = 0;
    if (!this.interactive || !this.downPos) return;
    if (this.pointers.size === 0 && this.moved < CLICK_SLOP_PX) {
      this.handleTap(e.offsetX, e.offsetY);
    }
    if (this.pointers.size === 0) this.downPos = null;
  };

  private onWheel = (e: WheelEvent): void => {
    if (!this.interactive) return;
    e.preventDefault();
    // Trackpad pinch arrives as wheel + ctrlKey; both zoom.
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
    this.applyZoom(factor);
  };

  private applyZoom(factor: number): void {
    this.zoom = Math.max(MIN_SCALE_FACTOR, Math.min(MAX_SCALE_FACTOR, this.zoom * factor));
    this.requestRender();
  }

  private pinchDistance(): number {
    const pts = [...this.pointers.values()];
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  private handleTap(x: number, y: number): void {
    if (this.reveal) return; // reveal screen is read-only
    const t = this.projection.translate()!;
    const r = this.projection.scale()!;
    if (Math.hypot(x - t[0], y - t[1]) > r) return; // tapped off-globe
    const inv = this.projection.invert?.([x, y]);
    if (!inv || inv.some((v) => Number.isNaN(v))) return;
    this.pin = { lon: inv[0], lat: inv[1] };
    this.requestRender();
    this.callbacks.onPin?.(this.pin);
  }

  // ── animation ─────────────────────────────────────────────────────

  private animateTo(target: [number, number]): void {
    cancelAnimationFrame(this.animRaf);
    const start: [number, number] = [...this.rotation];
    // take the short way around in longitude
    let dLon = target[0] - start[0];
    dLon = ((dLon + 540) % 360) - 180;
    const dLat = target[1] - start[1];
    const t0 = performance.now();
    const dur = 650;
    const step = (now: number): void => {
      const t = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - t, 3); // ease-out cubic
      this.rotation = [start[0] + dLon * e, start[1] + dLat * e];
      this.requestRender();
      if (t < 1) this.animRaf = requestAnimationFrame(step);
    };
    this.animRaf = requestAnimationFrame(step);
  }

  // ── rendering ─────────────────────────────────────────────────────

  private resize = (): void => {
    const dpr = window.devicePixelRatio || 1;
    const { clientWidth: w, clientHeight: h } = this.container;
    this.canvas.width = Math.max(1, w * dpr);
    this.canvas.height = Math.max(1, h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.baseScale = Math.min(w, h) / 2 - 12;
    this.projection.translate([w / 2, h / 2]);
    this.requestRender();
  };

  private requestRender(): void {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.render());
  }

  private isVisible(p: LatLon): boolean {
    return (
      geoDistance([p.lon, p.lat], [-this.rotation[0], -this.rotation[1]]) < Math.PI / 2
    );
  }

  private render(): void {
    const ctx = this.ctx;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.projection.rotate([this.rotation[0], this.rotation[1], 0]);
    this.projection.scale(Math.max(10, this.baseScale * this.zoom));
    const path = geoPath(this.projection, ctx);
    const styles = getComputedStyle(document.documentElement);
    const c = (name: string, fallback: string): string =>
      styles.getPropertyValue(name).trim() || fallback;

    ctx.clearRect(0, 0, w, h);

    // ocean
    ctx.beginPath();
    path({ type: 'Sphere' });
    ctx.fillStyle = c('--ocean', '#0b1d33');
    ctx.fill();

    // graticule
    ctx.beginPath();
    path(graticule);
    ctx.strokeStyle = c('--graticule', 'rgba(255,255,255,0.06)');
    ctx.lineWidth = 0.5;
    ctx.stroke();

    // land
    ctx.beginPath();
    path(land);
    ctx.fillStyle = c('--land', '#22384f');
    ctx.fill();

    // country borders
    ctx.beginPath();
    path(borders);
    ctx.strokeStyle = c('--border', 'rgba(140,180,220,0.35)');
    ctx.lineWidth = 0.6;
    ctx.stroke();

    // globe rim
    ctx.beginPath();
    path({ type: 'Sphere' });
    ctx.strokeStyle = c('--rim', 'rgba(120,170,255,0.35)');
    ctx.lineWidth = 1.2;
    ctx.stroke();

    if (this.reveal) this.renderReveal(path);
    else if (this.pin) this.drawMarker(this.pin, c('--pin', '#ffb545'));
  }

  private renderReveal(path: ReturnType<typeof geoPath>): void {
    const { guess, target } = this.reveal!;
    const ctx = this.ctx;
    const styles = getComputedStyle(document.documentElement);
    const c = (name: string, fallback: string): string =>
      styles.getPropertyValue(name).trim() || fallback;

    if (guess) {
      // geodesic from guess to target
      ctx.beginPath();
      path({
        type: 'LineString',
        coordinates: [
          [guess.lon, guess.lat],
          [target.lon, target.lat],
        ],
      });
      ctx.strokeStyle = c('--reveal-line', 'rgba(255,181,69,0.9)');
      ctx.lineWidth = 1.8;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      this.drawMarker(guess, c('--pin', '#ffb545'));
    }
    this.drawMarker(target, c('--target', '#3ddc84'), true);
  }

  private drawMarker(p: LatLon, color: string, ring = false): void {
    if (!this.isVisible(p)) return;
    const pt = this.projection([p.lon, p.lat]);
    if (!pt) return;
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(pt[0], pt[1], 5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.stroke();
    if (ring) {
      ctx.beginPath();
      ctx.arc(pt[0], pt[1], 10, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}
