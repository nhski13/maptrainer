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
import { formatKm, haversineKm, type LatLon } from '../core/geo';

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
  targetLabel: string;
  errorKm: number;
}

const MIN_SCALE_FACTOR = 0.45;
/** ~2.5° of longitude across the viewport at max — MapTap+ "minDistance" parity. */
const MAX_SCALE_FACTOR = 48;
const CLICK_SLOP_PX = 6;

// ── Sentinel-2 detail tiles (same imagery family MapTap serves) ───────
// EOX s2cloudless, WGS84 grid, CORS-enabled, attribution required.
// Zoom 10 ≈ 76 m/px — MapTap+ Pro tier fidelity (their free tier caps at 8).
const TILE_URL = (z: number, y: number, x: number): string =>
  `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024/default/WGS84/${z}/${y}/${x}.jpg`;
const TILE_PX = 256;
const MAX_TILE_ZOOM = 10;
const MIN_TILE_ZOOM = 4;
const MAX_TILES_PER_AXIS = 8; // patch canvas ≤ 2048×2048 (safe on mobile GPUs)
const DETAIL_ZOOM_THRESHOLD = 2.2; // globe zoom factor where detail kicks in
const SETTLE_MS = 280;

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
uniform sampler2D u_patch;  // regional Sentinel-2 detail patch
uniform vec4 u_patchB;      // lonMin, latMax, lonSpan, latSpan (radians)
uniform float u_patchAlpha; // 0 = no patch
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

  // Detail patch overlay (branchless: always sample, mix by inside-test).
  // Longitude compare is wrap-aware via mod so patches spanning the
  // antimeridian (Fiji, Tuvalu…) still work.
  float dLon = mod(lam - u_patchB.x, 2.0 * PI);
  float dLat = u_patchB.y - phi;
  float inside = step(dLon, u_patchB.z) * step(0.0, dLat) * step(dLat, u_patchB.w);
  vec2 puv = clamp(
    vec2(dLon / max(u_patchB.z, 1e-6), dLat / max(u_patchB.w, 1e-6)),
    0.0, 1.0);
  vec3 det = texture2D(u_patch, puv).rgb;
  col = mix(col, det, inside * u_patchAlpha);

  // limb shading for depth
  col *= 0.42 + 0.58 * pow(z, 0.35);
  // soft antialiased edge
  float alpha = clamp((1.0 - sqrt(d2)) * u_radius, 0.0, 1.0);
  gl_FragColor = vec4(col, alpha);
}
`;

/** Degree-space bounds of a detail patch. */
interface PatchBounds {
  lonMin: number; // may extend past ±180 (continuous, unwrapped)
  latMax: number;
  lonSpan: number;
  latSpan: number;
}

class SatelliteLayer {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null = null;
  private uTranslate: WebGLUniformLocation | null = null;
  private uRadius: WebGLUniformLocation | null = null;
  private uCenter: WebGLUniformLocation | null = null;
  private uPatchB: WebGLUniformLocation | null = null;
  private uPatchAlpha: WebGLUniformLocation | null = null;
  private patchTex: WebGLTexture | null = null;
  private patchBounds: PatchBounds | null = null;
  patchAlpha = 0;
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
    this.uPatchB = gl.getUniformLocation(prog, 'u_patchB');
    this.uPatchAlpha = gl.getUniformLocation(prog, 'u_patchAlpha');
    gl.uniform1i(gl.getUniformLocation(prog, 'u_tex'), 0);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_patch'), 1);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // load the Blue Marble texture (4096×2048 = power of two → mipmaps)
    const img = new Image();
    img.onload = () => {
      if (!this.gl) return;
      const tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
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

  /** Upload a composited tile canvas as the regional detail patch. */
  setPatch(source: HTMLCanvasElement, bounds: PatchBounds): void {
    const gl = this.gl;
    if (!gl) return;
    this.patchTex ??= gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.patchTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source);
    // Non-power-of-two canvas → clamp + linear, no mipmaps.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.patchBounds = bounds;
  }

  clearPatch(): void {
    this.patchBounds = null;
    this.patchAlpha = 0;
  }

  hasPatch(): boolean {
    return this.patchBounds !== null;
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
    const DEG = Math.PI / 180;
    const b = this.patchBounds;
    if (b && this.patchAlpha > 0) {
      gl.uniform4f(this.uPatchB, b.lonMin * DEG, b.latMax * DEG, b.lonSpan * DEG, b.latSpan * DEG);
      gl.uniform1f(this.uPatchAlpha, this.patchAlpha);
    } else {
      gl.uniform4f(this.uPatchB, 0, 0, 0, 0);
      gl.uniform1f(this.uPatchAlpha, 0);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  destroy(): void {
    this.gl?.getExtension('WEBGL_lose_context')?.loseContext();
    this.canvas.remove();
  }
}

// ── Sentinel-2 tile fetching ──────────────────────────────────────────

const tileCache = new Map<string, HTMLImageElement>();
const TILE_CACHE_MAX = 400;

function loadTile(z: number, y: number, x: number): Promise<HTMLImageElement> {
  const key = `${z}/${y}/${x}`;
  const hit = tileCache.get(key);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (tileCache.size >= TILE_CACHE_MAX) {
        const first = tileCache.keys().next().value;
        if (first !== undefined) tileCache.delete(first);
      }
      tileCache.set(key, img);
      resolve(img);
    };
    img.onerror = () => reject(new Error(`tile ${key} failed`));
    img.src = TILE_URL(z, y, x);
  });
}

interface DetailPlan {
  z: number;
  colStart: number; // continuous (may be <0 or ≥ nCols; wrapped at fetch time)
  rowStart: number;
  cols: number;
  rows: number;
  bounds: PatchBounds;
}

/**
 * Choose tile zoom + tile range covering the current view.
 * `pxPerDeg` is on-screen pixel density at globe center; the patch aims to
 * match or exceed it, capped at MAX_TILE_ZOOM (MapTap+ Pro fidelity).
 */
function planDetail(
  centerLon: number,
  centerLat: number,
  pxPerDeg: number,
  viewWdeg: number,
  viewHdeg: number,
): DetailPlan | null {
  let z = Math.ceil(Math.log2((pxPerDeg * 180) / TILE_PX));
  z = Math.max(MIN_TILE_ZOOM, Math.min(MAX_TILE_ZOOM, z));

  const halfW = Math.min(60, viewWdeg * 0.75);
  const halfH = Math.min(60, viewHdeg * 0.75);

  for (; z >= MIN_TILE_ZOOM; z--) {
    const tileDeg = 180 / 2 ** z;
    const nRows = 2 ** z;
    const rowStart = Math.max(0, Math.floor((90 - (centerLat + halfH)) / tileDeg));
    const rowEnd = Math.min(nRows - 1, Math.floor((90 - (centerLat - halfH)) / tileDeg));
    const colStart = Math.floor((centerLon - halfW + 180) / tileDeg);
    const colEnd = Math.floor((centerLon + halfW + 180) / tileDeg);
    const cols = colEnd - colStart + 1;
    const rows = rowEnd - rowStart + 1;
    if (cols > MAX_TILES_PER_AXIS || rows > MAX_TILES_PER_AXIS) continue; // zoom out
    return {
      z,
      colStart,
      rowStart,
      cols,
      rows,
      bounds: {
        lonMin: colStart * tileDeg - 180,
        latMax: 90 - rowStart * tileDeg,
        lonSpan: cols * tileDeg,
        latSpan: rows * tileDeg,
      },
    };
  }
  return null;
}

/** Fetch and composite the planned tiles. Rejects if any tile fails. */
async function buildPatch(plan: DetailPlan): Promise<HTMLCanvasElement> {
  const nCols = 2 ** (plan.z + 1);
  const jobs: Promise<{ img: HTMLImageElement; cx: number; ry: number }>[] = [];
  for (let ry = 0; ry < plan.rows; ry++) {
    for (let cx = 0; cx < plan.cols; cx++) {
      const col = (((plan.colStart + cx) % nCols) + nCols) % nCols; // wrap antimeridian
      const row = plan.rowStart + ry;
      jobs.push(loadTile(plan.z, row, col).then((img) => ({ img, cx, ry })));
    }
  }
  const tiles = await Promise.all(jobs);
  const canvas = document.createElement('canvas');
  canvas.width = plan.cols * TILE_PX;
  canvas.height = plan.rows * TILE_PX;
  const ctx = canvas.getContext('2d')!;
  for (const t of tiles) ctx.drawImage(t.img, t.cx * TILE_PX, t.ry * TILE_PX);
  return canvas;
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
  private settleTimer = 0;
  private detailToken = 0;
  private appliedDetailKey = '';
  private fadeRaf = 0;

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
    cancelAnimationFrame(this.fadeRaf);
    clearTimeout(this.settleTimer);
    this.detailToken++; // invalidate in-flight tile builds
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

  /**
   * Show the guess → target reveal and frame it. The globe stays live
   * afterwards: drag and pinch keep working so you can scroll around the
   * answer and see exactly what you missed. Only pin-dropping is locked out.
   */
  showReveal(guess: LatLon | null, target: LatLon, targetLabel = ''): void {
    this.reveal = {
      guess,
      target,
      targetLabel,
      errorKm: guess ? haversineKm(guess, target) : Infinity,
    };
    this.pin = null;
    this.frameReveal();
  }

  /** (Re-)frame the reveal so both markers sit comfortably on screen. */
  frameReveal(): void {
    const r = this.reveal;
    if (!r) return;
    const focus = r.guess
      ? geoInterpolate([r.guess.lon, r.guess.lat], [r.target.lon, r.target.lat])(0.5)
      : ([r.target.lon, r.target.lat] as [number, number]);
    this.animateTo([-focus[0], -focus[1]], this.zoomToFitReveal());
  }

  /**
   * Zoom that fits both markers. Centred on the midpoint each sits sin(θ/2)
   * of a radius from centre, so the pair spans 2·R·sin(θ/2) on screen; solve
   * for the R that keeps that inside ~62% of the viewport. A tight guess
   * yields a huge number and simply clamps to max zoom — which is the good
   * case: you get dropped into Sentinel-2 detail right on top of the city.
   */
  private zoomToFitReveal(): number {
    const r = this.reveal;
    if (!r) return this.zoom;
    const viewport = Math.min(this.container.clientWidth, this.container.clientHeight);
    if (!r.guess || this.baseScale <= 0) return Math.min(MAX_SCALE_FACTOR, 6);
    const theta = geoDistance([r.guess.lon, r.guess.lat], [r.target.lon, r.target.lat]);
    const half = Math.max(Math.sin(theta / 2), 1e-4);
    const fit = (0.31 * viewport) / (half * this.baseScale);
    return Math.max(MIN_SCALE_FACTOR, Math.min(MAX_SCALE_FACTOR, fit));
  }

  clearReveal(): void {
    this.reveal = null;
    this.requestRender();
  }

  resetView(): void {
    this.animateTo([-10, -25], 1);
  }

  // ── interaction ───────────────────────────────────────────────────

  private onPointerDown = (e: PointerEvent): void => {
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
    if (!this.pointers.has(e.pointerId)) return;
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
    if (!this.downPos) return;
    if (this.pointers.size === 0 && this.moved < CLICK_SLOP_PX) {
      this.handleTap(e.offsetX, e.offsetY);
    }
    if (this.pointers.size === 0) this.downPos = null;
  };

  private onWheel = (e: WheelEvent): void => {
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
    // Rotation and zoom stay live during a reveal so you can inspect the
    // answer; only dropping a new pin is locked out.
    if (this.reveal) return;
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

  private animateTo(target: [number, number], targetZoom = this.zoom): void {
    cancelAnimationFrame(this.animRaf);
    const start: [number, number] = [...this.rotation];
    // take the short way around in longitude
    let dLon = target[0] - start[0];
    dLon = ((dLon + 540) % 360) - 180;
    const dLat = target[1] - start[1];
    // Zoom is a scale, so interpolate it geometrically — a linear ramp from
    // 1× to 40× spends almost the whole animation already deep in the zoom.
    const zoomFrom = this.zoom;
    const zoomRatio = Math.log(targetZoom / zoomFrom);
    const t0 = performance.now();
    const dur = 650;
    const step = (now: number): void => {
      const t = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - t, 3); // ease-out cubic
      this.rotation = [start[0] + dLon * e, start[1] + dLat * e];
      this.zoom = zoomFrom * Math.exp(zoomRatio * e);
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
    // Re-plan the detail patch once the view stops moving.
    clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => this.updateDetail(), SETTLE_MS);
  }

  /** Fetch/refresh the Sentinel-2 detail patch for the settled view. */
  private updateDetail(): void {
    if (!this.sat.ready || this.sat.failed) return;
    if (this.zoom < DETAIL_ZOOM_THRESHOLD) {
      if (this.sat.hasPatch()) {
        this.sat.clearPatch();
        this.appliedDetailKey = '';
        this.requestRenderOnly();
      }
      return;
    }
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const scalePx = this.projection.scale()!;
    const pxPerDeg = (scalePx * Math.PI) / 180;
    const plan = planDetail(
      -this.rotation[0],
      -this.rotation[1],
      pxPerDeg * (window.devicePixelRatio || 1),
      w / pxPerDeg,
      h / pxPerDeg,
    );
    if (!plan) return;
    const key = `${plan.z}:${plan.colStart}:${plan.rowStart}:${plan.cols}:${plan.rows}`;
    if (key === this.appliedDetailKey) return; // already showing this patch
    const token = ++this.detailToken;
    void buildPatch(plan)
      .then((canvas) => {
        if (token !== this.detailToken) return; // stale — view moved on
        this.sat.setPatch(canvas, plan.bounds);
        this.appliedDetailKey = key;
        this.fadePatchIn();
      })
      .catch(() => {
        /* offline or tile hiccup — base texture stays */
      });
  }

  /** Fade the freshly-loaded patch in over ~180 ms. */
  private fadePatchIn(): void {
    cancelAnimationFrame(this.fadeRaf);
    const t0 = performance.now();
    const from = this.sat.patchAlpha;
    const step = (now: number): void => {
      const t = Math.min(1, (now - t0) / 180);
      this.sat.patchAlpha = from + (1 - from) * t;
      this.requestRenderOnly();
      if (t < 1) this.fadeRaf = requestAnimationFrame(step);
    };
    this.fadeRaf = requestAnimationFrame(step);
  }

  /** Render without re-scheduling detail work (used by detail plumbing itself). */
  private requestRenderOnly(): void {
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
    const { guess, target, targetLabel, errorKm } = this.reveal!;
    const ctx = this.ctx;
    const styles = getComputedStyle(document.documentElement);
    const c = (name: string, fallback: string): string =>
      styles.getPropertyValue(name).trim() || fallback;
    const lineColor = c('--reveal-line', 'rgba(255,181,69,0.9)');

    if (guess) {
      // Geodesic guess → target, drawn twice: a soft wide pass so the line
      // survives bright satellite imagery, then the dashed line itself.
      const geodesic = {
        type: 'LineString' as const,
        coordinates: [
          [guess.lon, guess.lat],
          [target.lon, target.lat],
        ],
      };
      ctx.save();
      ctx.lineCap = 'round';
      ctx.beginPath();
      path(geodesic);
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = 5;
      ctx.stroke();

      ctx.beginPath();
      path(geodesic);
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 2.2;
      ctx.setLineDash([7, 5]);
      ctx.stroke();
      ctx.restore();

      this.drawMarker(guess, c('--pin', '#ffb545'));
      this.drawLabel(guess, 'Your tap', c('--pin', '#ffb545'));
    }

    this.drawMarker(target, c('--target', '#3ddc84'), true);
    if (targetLabel) this.drawLabel(target, targetLabel, c('--target', '#3ddc84'));

    // Distance chip, pinned to the middle of the geodesic — the answer to
    // "how badly did I miss?" sits on the line that shows the miss.
    if (guess && Number.isFinite(errorKm)) {
      const mid = geoInterpolate([guess.lon, guess.lat], [target.lon, target.lat])(0.5);
      const midPoint = { lon: mid[0], lat: mid[1] };
      if (this.isVisible(midPoint)) {
        const pt = this.projection([mid[0], mid[1]]);
        if (pt) this.drawChip(pt[0], pt[1], formatKm(errorKm), lineColor, true);
      }
    }
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

  /** Marker caption, offset above the dot. */
  private drawLabel(p: LatLon, text: string, color: string): void {
    if (!this.isVisible(p)) return;
    const pt = this.projection([p.lon, p.lat]);
    if (!pt) return;
    this.drawChip(pt[0], pt[1] - 20, text, color, false);
  }

  /** Rounded pill of text centred on (x, y). */
  private drawChip(x: number, y: number, text: string, color: string, strong: boolean): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = strong
      ? '700 13px ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif'
      : '600 11px ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif';
    const padX = strong ? 9 : 7;
    const h = strong ? 22 : 18;
    const w = ctx.measureText(text).width + padX * 2;
    const left = x - w / 2;
    const top = y - h / 2;

    ctx.beginPath();
    ctx.roundRect(left, top, w, h, h / 2);
    ctx.fillStyle = 'rgba(6, 13, 24, 0.82)';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = strong ? color : '#e8eef7';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 0.5);
    ctx.restore();
  }
}
