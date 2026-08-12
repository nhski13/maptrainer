/**
 * Rotatable 3D globe — the MapTap.gg interaction model: drag to rotate,
 * scroll/pinch to zoom, tap to drop a pin.
 *
 * Two stacked canvases:
 *  - WebGL layer: NASA Blue Marble satellite imagery, reprojected to the
 *    orthographic sphere in a fragment shader (60 fps while dragging).
 *  - 2D layer: country borders, rim, pins, and the reveal geodesic, drawn
 *    with d3-geo so vectors align exactly with the imagery.
 * If WebGL or the texture fails, the 2D layer falls back to flat land fills.
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
import earthUrl from '../assets/earth.jpg';
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

// ── WebGL satellite layer ─────────────────────────────────────────────

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

/**
 * Inverse orthographic (Snyder): for each fragment on the disc, recover
 * lon/lat for a projection centered at (u_center.x, u_center.y) and sample
 * the equirectangular texture. Matches d3's rotate([-lon, -lat]) convention.
 */
const FRAG = `
precision highp float;
uniform vec2 u_translate;   // sphere center, device px, GL origin (bottom-left)
uniform float u_radius;     // sphere radius, device px
uniform vec2 u_center;      // projection center lon/lat, radians
uniform sampler2D u_tex;
const float PI = 3.141592653589793;

void main() {
  float X = (gl_FragCoord.x - u_translate.x) / u_radius;
  float Y = (gl_FragCoord.y - u_translate.y) / u_radius;
  float d2 = X * X + Y * Y;
  if (d2 > 1.0) discard;
  float z = sqrt(1.0 - d2);

  float sinPhi0 = sin(u_center.y);
  float cosPhi0 = cos(u_center.y);
  float phi = asin(clamp(Y * cosPhi0 + z * sinPhi0, -1.0, 1.0));
  float lam = u_center.x + atan(X, z * cosPhi0 - Y * sinPhi0);

  vec2 uv = vec2(fract(lam / (2.0 * PI) + 0.5), 0.5 - phi / PI);
  vec3 col = texture2D(u_tex, uv).rgb;

  // limb shading for depth
  col *= 0.42 + 0.58 * pow(z, 0.35);
  // soft antialiased edge
  float alpha = clamp((1.0 - sqrt(d2)) * u_radius, 0.0, 1.0);
  gl_FragColor = vec4(col, alpha);
}
`;

class SatelliteLayer {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null = null;
  private uTranslate: WebGLUniformLocation | null = null;
  private uRadius: WebGLUniformLocation | null = null;
  private uCenter: WebGLUniformLocation | null = null;
  ready = false;
  failed = false;

  constructor(private onReady: () => void) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'globe-canvas globe-gl';
    const gl = this.canvas.getContext('webgl', { alpha: true, antialias: false });
    if (!gl) {
      this.failed = true;
      return;
    }
    this.gl = gl;

    const compile = (type: number, src: string): WebGLShader | null => {
      const s = gl.createShader(type);
      if (!s) return null;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error('shader:', gl.getShaderInfoLog(s));
        return null;
      }
      return s;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram();
    if (!vs || !fs || !prog) {
      this.failed = true;
      return;
    }
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      this.failed = true;
      return;
    }
    gl.useProgram(prog);

    // fullscreen quad
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const aPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    this.uTranslate = gl.getUniformLocation(prog, 'u_translate');
    this.uRadius = gl.getUniformLocation(prog, 'u_radius');
    this.uCenter = gl.getUniformLocation(prog, 'u_center');

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // load the Blue Marble texture (4096×2048 = power of two → mipmaps)
    const img = new Image();
    img.onload = () => {
      if (!this.gl) return;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
      this.ready = true;
      this.onReady();
    };
    img.onerror = () => {
      this.failed = true;
    };
    img.src = earthUrl;
  }

  resize(wPx: number, hPx: number): void {
    this.canvas.width = Math.max(1, wPx);
    this.canvas.height = Math.max(1, hPx);
    this.gl?.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  /** All spatial args in device pixels; ty measured from the top. */
  draw(tx: number, ty: number, radius: number, centerLonRad: number, centerLatRad: number): void {
    const gl = this.gl;
    if (!gl || !this.ready) return;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(this.uTranslate, tx, this.canvas.height - ty);
    gl.uniform1f(this.uRadius, radius);
    gl.uniform2f(this.uCenter, centerLonRad, centerLatRad);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  destroy(): void {
    this.gl?.getExtension('WEBGL_lose_context')?.loseContext();
    this.canvas.remove();
  }
}

// ── the globe ─────────────────────────────────────────────────────────

export class Globe {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private sat: SatelliteLayer;
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
    this.sat = new SatelliteLayer(() => this.requestRender());
    container.appendChild(this.sat.canvas);

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'globe-canvas globe-overlay';
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
    this.sat.destroy();
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
    this.sat.resize(w * dpr, h * dpr);
    this.sat.canvas.style.width = `${w}px`;
    this.sat.canvas.style.height = `${h}px`;
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
    const dpr = window.devicePixelRatio || 1;
    this.projection.rotate([this.rotation[0], this.rotation[1], 0]);
    this.projection.scale(Math.max(10, this.baseScale * this.zoom));
    const path = geoPath(this.projection, ctx);
    const styles = getComputedStyle(document.documentElement);
    const c = (name: string, fallback: string): string =>
      styles.getPropertyValue(name).trim() || fallback;

    ctx.clearRect(0, 0, w, h);

    const satellite = this.sat.ready && !this.sat.failed;
    if (satellite) {
      const t = this.projection.translate()!;
      const DEG = Math.PI / 180;
      this.sat.draw(
        t[0] * dpr,
        t[1] * dpr,
        this.projection.scale()! * dpr,
        -this.rotation[0] * DEG,
        -this.rotation[1] * DEG,
      );
      // subtle country borders over imagery
      ctx.beginPath();
      path(borders);
      ctx.strokeStyle = c('--border-sat', 'rgba(255,255,255,0.30)');
      ctx.lineWidth = 0.7;
      ctx.stroke();
    } else {
      // flat vector fallback (texture loading, or no WebGL)
      ctx.beginPath();
      path({ type: 'Sphere' });
      ctx.fillStyle = c('--ocean', '#0b1d33');
      ctx.fill();

      ctx.beginPath();
      path(graticule);
      ctx.strokeStyle = c('--graticule', 'rgba(255,255,255,0.06)');
      ctx.lineWidth = 0.5;
      ctx.stroke();

      ctx.beginPath();
      path(land);
      ctx.fillStyle = c('--land', '#22384f');
      ctx.fill();

      ctx.beginPath();
      path(borders);
      ctx.strokeStyle = c('--border', 'rgba(140,180,220,0.35)');
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }

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
