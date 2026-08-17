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
/** Zoom the fly-to-answer leg settles at — city scale, deep in tile detail. */
const ANSWER_ZOOM = 20;
/** Beat between framing the miss and flying to the answer. */
const REVEAL_FLY_DELAY_MS = 1400;
/** Pin-drop animation length. */
const DROP_MS = 520;

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
/**
 * How long the view must hold still before we go to the network for a patch.
 * Short, because most of the cost has been moved off this path: the warming
 * passes below fetch ahead of the gesture, and anything already in cache is
 * swapped in immediately without waiting for the settle at all.
 */
const SETTLE_MS = 150;
/** Floor between two cache-only patch swaps — each one re-uploads a texture. */
const CACHED_APPLY_MS = 90;
/** Floor between partial re-uploads while a patch is still streaming in. */
const PATCH_PAINT_MS = 130;
/** Tile levels the page-load warm pulls before you have touched anything. */
const WARM_ENTRY_LEVELS = 2;
/** Tile levels the settled view runs ahead by, once you are already zoomed in. */
const WARM_LOOKAHEAD_LEVELS = 2;
/** Zoom ratio the level sweep steps by — fine enough not to skip a band. */
const LEVEL_SWEEP_STEP = 1.08;

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
  /**
   * The decoded Blue Marble image, kept around after upload. Detail patches
   * start life as an upscaled crop of it, so a patch that is still streaming
   * shows blur where its tiles have not landed rather than holes.
   */
  baseImage: HTMLImageElement | null = null;

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
      this.baseImage = img;
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

/**
 * Decoded tiles, reused across patches. Eviction is LRU — a hit moves its key
 * to the back — not FIFO: the warming passes stream a lot of tiles past this
 * map, and a plain queue would push the tiles you are actually looking at out
 * the front to make room for tiles you might never zoom to.
 */
const tileCache = new Map<string, HTMLImageElement>();
const TILE_CACHE_MAX = 500;
/** In-flight loads, so a warm pass and a foreground patch share one request. */
const tileInflight = new Map<string, Promise<HTMLImageElement>>();
/** Keys that 404'd or timed out. Warming skips them so it can't loop offline. */
const tileFailed = new Set<string>();

const tileKey = (z: number, y: number, x: number): string => `${z}/${y}/${x}`;

function cacheGet(key: string): HTMLImageElement | undefined {
  const hit = tileCache.get(key);
  if (hit) {
    tileCache.delete(key); // re-insert at the back — least-recent falls out first
    tileCache.set(key, hit);
  }
  return hit;
}

function loadTile(
  z: number,
  y: number,
  x: number,
  priority: 'high' | 'low' = 'high',
): Promise<HTMLImageElement> {
  const key = tileKey(z, y, x);
  const hit = cacheGet(key);
  if (hit) return Promise.resolve(hit);
  const pending = tileInflight.get(key);
  if (pending) return pending;

  const job = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    // Warm tiles queue behind whatever is being drawn right now.
    img.setAttribute('fetchpriority', priority);
    img.onload = () => {
      if (tileCache.size >= TILE_CACHE_MAX) {
        const oldest = tileCache.keys().next().value;
        if (oldest !== undefined) tileCache.delete(oldest);
      }
      tileCache.set(key, img);
      resolve(img);
    };
    img.onerror = () => {
      tileFailed.add(key);
      reject(new Error(`tile ${key} failed`));
    };
    img.src = TILE_URL(z, y, x);
  });
  tileInflight.set(key, job);
  void job.catch(() => undefined).then(() => tileInflight.delete(key));
  return job;
}

// ── background warming ────────────────────────────────────────────────
// Zooming used to be a cold start every time: the view had to stop, then a
// whole patch had to come off the network before anything sharpened. These
// queue tiles ahead of the gesture, at low priority, so by the time you zoom
// the fetch has already happened.

const WARM_CONCURRENCY = 3;
const WARM_QUEUE_MAX = 320;
const warmQueue: string[] = [];
const warmQueued = new Set<string>();
let warmActive = 0;

/** Metered connections opt out — imagery you may never look at isn't worth it. */
function warmingAllowed(): boolean {
  const conn = (navigator as unknown as {
    connection?: { saveData?: boolean; effectiveType?: string };
  }).connection;
  if (!conn) return true;
  if (conn.saveData) return false;
  return conn.effectiveType !== '2g' && conn.effectiveType !== 'slow-2g';
}

function warmTile(z: number, y: number, x: number): void {
  if (z < MIN_TILE_ZOOM || z > MAX_TILE_ZOOM) return;
  const key = tileKey(z, y, x);
  if (tileCache.has(key) || tileInflight.has(key) || warmQueued.has(key)) return;
  if (tileFailed.has(key)) return;
  if (warmQueue.length >= WARM_QUEUE_MAX) return;
  warmQueued.add(key);
  warmQueue.push(key);
  pumpWarm();
}

function pumpWarm(): void {
  while (warmActive < WARM_CONCURRENCY) {
    const key = warmQueue.shift();
    if (key === undefined) return;
    warmQueued.delete(key);
    if (tileCache.has(key) || tileInflight.has(key)) continue;
    const [z, y, x] = key.split('/').map(Number);
    warmActive++;
    void loadTile(z, y, x, 'low')
      .catch(() => undefined)
      .then(() => {
        warmActive--;
        pumpWarm();
      });
  }
}

/** Drop pending warm work — used when the view jumps somewhere else entirely. */
function clearWarmQueue(): void {
  warmQueue.length = 0;
  warmQueued.clear();
}

/** Run after the browser is done with more important work (or soon enough). */
function whenIdle(fn: () => void): void {
  const ric = (window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  }).requestIdleCallback;
  if (ric) ric(fn, { timeout: 2500 });
  else window.setTimeout(fn, 500);
}

// ── planning ──────────────────────────────────────────────────────────

export interface TileRect {
  z: number;
  colStart: number; // continuous (may be <0 or ≥ nCols; wrapped at fetch time)
  rowStart: number;
  cols: number;
  rows: number;
}

export interface DetailPlan extends TileRect {
  bounds: PatchBounds;
}

/** Tile rectangle covering ±half degrees around a centre, at zoom `z`. */
export function tileRect(
  z: number,
  centerLon: number,
  centerLat: number,
  halfWdeg: number,
  halfHdeg: number,
): TileRect {
  const tileDeg = 180 / 2 ** z;
  const nRows = 2 ** z;
  const rowStart = Math.max(0, Math.floor((90 - (centerLat + halfHdeg)) / tileDeg));
  const rowEnd = Math.min(nRows - 1, Math.floor((90 - (centerLat - halfHdeg)) / tileDeg));
  const colStart = Math.floor((centerLon - halfWdeg + 180) / tileDeg);
  const colEnd = Math.floor((centerLon + halfWdeg + 180) / tileDeg);
  return { z, colStart, rowStart, cols: colEnd - colStart + 1, rows: rowEnd - rowStart + 1 };
}

/** Walk a rect's tiles, wrapping columns across the antimeridian. */
export function eachTile(
  rect: TileRect,
  fn: (row: number, col: number, ry: number, cx: number) => void,
): void {
  const nCols = 2 ** (rect.z + 1);
  for (let ry = 0; ry < rect.rows; ry++) {
    for (let cx = 0; cx < rect.cols; cx++) {
      const col = (((rect.colStart + cx) % nCols) + nCols) % nCols;
      fn(rect.rowStart + ry, col, ry, cx);
    }
  }
}

const planKey = (p: TileRect): string =>
  `${p.z}:${p.colStart}:${p.rowStart}:${p.cols}:${p.rows}`;

/** Queue every tile a plan needs, at background priority. */
function warmPlan(plan: TileRect): void {
  eachTile(plan, (row, col) => warmTile(plan.z, row, col));
}

/**
 * Choose tile zoom + tile range covering the current view.
 * `pxPerDeg` is on-screen pixel density at globe center; the patch aims to
 * match or exceed it, capped at MAX_TILE_ZOOM (MapTap+ Pro fidelity).
 */
export function planDetail(
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
    const rect = tileRect(z, centerLon, centerLat, halfW, halfH);
    if (rect.cols > MAX_TILES_PER_AXIS || rect.rows > MAX_TILES_PER_AXIS) continue; // zoom out
    const tileDeg = 180 / 2 ** z;
    return {
      ...rect,
      bounds: {
        lonMin: rect.colStart * tileDeg - 180,
        latMax: 90 - rect.rowStart * tileDeg,
        lonSpan: rect.cols * tileDeg,
        latSpan: rect.rows * tileDeg,
      },
    };
  }
  return null;
}

// ── patch compositing ─────────────────────────────────────────────────

/** One `drawImage` of the base texture: source longitude run → destination x run. */
export interface CropSlice {
  /** Western edge of the run in the source image, degrees in [-180, 180). */
  srcLon: number;
  /** Width of the run, degrees. */
  spanDeg: number;
  /** Destination x, in patch-canvas pixels. */
  dx: number;
  dw: number;
}

/**
 * Split a patch's longitude range into runs that don't cross the source
 * image's seam. A patch may straddle the antimeridian — Fiji, Tuvalu, the
 * Aleutians — where the sphere wraps but an equirectangular bitmap does not,
 * so those become two draws off opposite edges of the source.
 */
export function baseCropSlices(lonMin: number, lonSpan: number, w: number): CropSlice[] {
  const slices: CropSlice[] = [];
  let drawnDeg = 0;
  while (drawnDeg < lonSpan - 1e-9) {
    const srcLon = ((((lonMin + drawnDeg + 180) % 360) + 360) % 360) - 180;
    const spanDeg = Math.min(180 - srcLon, lonSpan - drawnDeg);
    if (spanDeg <= 0) break;
    slices.push({
      srcLon,
      spanDeg,
      dx: (drawnDeg / lonSpan) * w,
      dw: (spanDeg / lonSpan) * w,
    });
    drawnDeg += spanDeg;
  }
  return slices;
}

/**
 * Paint the patch's own region of the blurry base texture, upscaled, as the
 * canvas's starting content. Tiles then land on top of it. That is what makes
 * a half-loaded patch read as "sharpening in" instead of punching black holes
 * in the globe, and it means one dead tile costs you one blurry square rather
 * than the whole patch.
 */
function drawBaseCrop(
  ctx: CanvasRenderingContext2D,
  base: HTMLImageElement | null,
  b: PatchBounds,
  w: number,
  h: number,
): void {
  if (!base?.naturalWidth) {
    ctx.fillStyle = '#0b1d33';
    ctx.fillRect(0, 0, w, h);
    return;
  }
  const pxPerLon = base.naturalWidth / 360;
  const sy = ((90 - b.latMax) / 180) * base.naturalHeight;
  const sh = Math.max(1, (b.latSpan / 180) * base.naturalHeight);
  for (const s of baseCropSlices(b.lonMin, b.lonSpan, w)) {
    ctx.drawImage(base, (s.srcLon + 180) * pxPerLon, sy, s.spanDeg * pxPerLon, sh, s.dx, 0, s.dw, h);
  }
}

function newPatchCanvas(
  plan: DetailPlan,
  base: HTMLImageElement | null,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = plan.cols * TILE_PX;
  canvas.height = plan.rows * TILE_PX;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  drawBaseCrop(ctx, base, plan.bounds, canvas.width, canvas.height);
  return { canvas, ctx };
}

/**
 * Composite a plan from cache alone, or return null if any tile is missing.
 * This is the path a warmed zoom takes: no network, no settle wait, no fade —
 * the sharp version is simply there on the next frame.
 */
function compositeCached(
  plan: DetailPlan,
  base: HTMLImageElement | null,
): HTMLCanvasElement | null {
  const have: { img: HTMLImageElement; cx: number; ry: number }[] = [];
  let complete = true;
  eachTile(plan, (row, col, ry, cx) => {
    if (!complete) return;
    const img = cacheGet(tileKey(plan.z, row, col));
    if (img) have.push({ img, cx, ry });
    else complete = false;
  });
  if (!complete) return null;
  const { canvas, ctx } = newPatchCanvas(plan, base);
  for (const t of have) ctx.drawImage(t.img, t.cx * TILE_PX, t.ry * TILE_PX);
  return canvas;
}

/**
 * Fetch and composite a plan, calling `onProgress` as tiles land so the caller
 * can show the patch filling in. Resolves once every tile has settled one way
 * or the other; rejects only if nothing at all arrived.
 */
async function buildPatch(
  plan: DetailPlan,
  base: HTMLImageElement | null,
  onProgress?: (canvas: HTMLCanvasElement) => void,
): Promise<HTMLCanvasElement> {
  const { canvas, ctx } = newPatchCanvas(plan, base);
  let landed = 0;
  const jobs: Promise<void>[] = [];
  eachTile(plan, (row, col, ry, cx) => {
    jobs.push(
      loadTile(plan.z, row, col)
        .then((img) => {
          ctx.drawImage(img, cx * TILE_PX, ry * TILE_PX);
          landed++;
          onProgress?.(canvas);
        })
        .catch(() => undefined), // leave the base crop showing for this tile
    );
  });
  await Promise.all(jobs);
  if (landed === 0) throw new Error('patch had no tiles');
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
  private revealTimer = 0;
  private dropStart = 0;
  private dropRaf = 0;
  private detailToken = 0;
  private appliedDetailKey = '';
  private fadeRaf = 0;
  private warmedAheadKey = '';
  private warmedViewKey = '';
  private lastCachedApply = 0;

  constructor(
    private container: HTMLElement,
    private callbacks: GlobeCallbacks = {},
  ) {
    // Warming starts as soon as the base texture is up — the moment the globe
    // first appears, not the first time someone zooms. Detail tiles are a
    // WebGL-only concern, so if the layer fails this never runs.
    this.sat = new SatelliteLayer(() => {
      this.requestRender();
      this.warmView();
    });
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
    cancelAnimationFrame(this.dropRaf);
    clearTimeout(this.settleTimer);
    clearTimeout(this.revealTimer);
    this.detailToken++; // invalidate in-flight tile builds
    clearWarmQueue();
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

    // Two beats, because the reveal has two things to say. First frame both
    // points so the geodesic shows how far off the tap was; then fly the globe
    // over to the answer and zoom in, so you actually see where it was.
    this.dropPin();
    this.frameReveal();
    clearTimeout(this.revealTimer);
    this.revealTimer = window.setTimeout(() => this.flyToAnswer(), REVEAL_FLY_DELAY_MS);
  }

  /** Fly to the answer and zoom to city scale. Cancels the pending auto-fly. */
  flyToAnswer(): void {
    const r = this.reveal;
    if (!r) return;
    clearTimeout(this.revealTimer);
    this.animateTo(
      [-r.target.lon, -r.target.lat],
      Math.min(MAX_SCALE_FACTOR, ANSWER_ZOOM),
    );
  }

  /** Animate the target marker dropping into place. */
  private dropPin(): void {
    cancelAnimationFrame(this.dropRaf);
    this.dropStart = performance.now();
    const step = (): void => {
      this.requestRenderOnly();
      if (performance.now() - this.dropStart < DROP_MS) {
        this.dropRaf = requestAnimationFrame(step);
      }
    };
    this.dropRaf = requestAnimationFrame(step);
  }

  /** 0 → 1 over the drop, eased with a small overshoot at the end. */
  private dropProgress(): number {
    const t = Math.min(1, (performance.now() - this.dropStart) / DROP_MS);
    return 1 - Math.pow(1 - t, 3);
  }

  /** (Re-)frame the reveal so both markers sit comfortably on screen. */
  frameReveal(): void {
    const r = this.reveal;
    if (!r) return;
    clearTimeout(this.revealTimer);
    const focus = r.guess
      ? geoInterpolate([r.guess.lon, r.guess.lat], [r.target.lon, r.target.lat])(0.5)
      : ([r.target.lon, r.target.lat] as [number, number]);
    const zoom = this.zoomToFitReveal();
    // Where the framing lands depends on the guess, so it can't be warmed with
    // the answer at the top of the round — but it can be warmed now, while the
    // camera is still flying there, instead of after it arrives.
    if (!this.sat.failed && warmingAllowed()) {
      const plan = this.planFor(focus[0], focus[1], zoom);
      if (plan) warmPlan(plan);
    }
    this.animateTo([-focus[0], -focus[1]], zoom);
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
    clearTimeout(this.revealTimer);
    cancelAnimationFrame(this.dropRaf);
    this.reveal = null;
    this.requestRender();
  }

  resetView(): void {
    this.animateTo([-10, -25], 1);
  }

  // ── interaction ───────────────────────────────────────────────────

  private onPointerDown = (e: PointerEvent): void => {
    // Grabbing the globe means you want to look around yourself — drop the
    // scheduled fly-to rather than yanking the view out from under you.
    clearTimeout(this.revealTimer);
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
    clearTimeout(this.revealTimer);
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
    // Patch plans are sized off the viewport, so a resize invalidates what the
    // warming passes decided to fetch.
    this.warmedViewKey = '';
    this.warmedAheadKey = '';
    this.requestRender();
  };

  private requestRender(): void {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.render());
    // Two-speed detail. If the level the view now wants is already warm, swap
    // it in on this frame — waiting out a settle timer for tiles we are
    // already holding is most of what made zooming feel a beat behind the
    // gesture. Only work that still needs the network waits for the view to
    // stop moving.
    this.applyCachedDetail();
    clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => this.updateDetail(), SETTLE_MS);
  }

  /** The patch plan for a hypothetical view: same centre, a given zoom. */
  private planFor(lon: number, lat: number, zoom: number): DetailPlan | null {
    const scalePx = Math.max(10, this.baseScale * zoom);
    const pxPerDeg = (scalePx * Math.PI) / 180;
    if (pxPerDeg <= 0) return null;
    return planDetail(
      lon,
      lat,
      pxPerDeg * (window.devicePixelRatio || 1),
      this.container.clientWidth / pxPerDeg,
      this.container.clientHeight / pxPerDeg,
    );
  }

  /**
   * The widest patch each tile level ever uses at this centre, coarsest first.
   *
   * Which level a patch lands on is set by the MAX_TILES_PER_AXIS cap, not by
   * pixel density — `planDetail` walks the level down until the rect fits — so
   * a zoom band covers one level, and every plan inside the band is a centred
   * sub-rect of the plan the band opens with. Warm that opening rect and the
   * whole band is warm. Swept rather than solved because where the bands fall
   * depends on viewport shape.
   */
  private levelBands(lon: number, lat: number): DetailPlan[] {
    const bands: DetailPlan[] = [];
    let deepest = -1;
    for (let zoom = DETAIL_ZOOM_THRESHOLD; zoom <= MAX_SCALE_FACTOR; zoom *= LEVEL_SWEEP_STEP) {
      const plan = this.planFor(lon, lat, zoom);
      if (!plan || plan.z <= deepest) continue;
      deepest = plan.z;
      bands.push(plan);
    }
    return bands;
  }

  /**
   * Queue the tiles a zoom-in from here would want. Cheap and idempotent —
   * anything cached, in flight or already queued is dropped on the floor. Only
   * the first band goes out immediately; the next waits for an idle moment so
   * it never races the base texture or a patch that's actually on screen.
   */
  private warmView(): void {
    if (!warmingAllowed()) return;
    // Bucket the centre so a drag re-warms on real movement, not every frame.
    const key = `${Math.round(this.rotation[0] / 5)},${Math.round(this.rotation[1] / 5)}`;
    if (key === this.warmedViewKey) return;
    this.warmedViewKey = key;
    const bands = this.levelBands(-this.rotation[0], -this.rotation[1]);
    if (bands[0]) warmPlan(bands[0]);
    whenIdle(() => {
      if (key !== this.warmedViewKey) return; // view has moved on
      for (const plan of bands.slice(1, WARM_ENTRY_LEVELS)) warmPlan(plan);
    });
  }

  /** Queue the band below the one on screen, so the next pinch is paid for. */
  private warmAhead(): void {
    if (!warmingAllowed()) return;
    const lon = -this.rotation[0];
    const lat = -this.rotation[1];
    const here = this.planFor(lon, lat, this.zoom);
    if (!here) return;
    const key = planKey(here);
    if (key === this.warmedAheadKey) return;
    this.warmedAheadKey = key;
    // Two bands down, not one: a single flick of a scroll wheel or a pinch
    // crosses more than one band, and the settle that triggers this only fires
    // once the gesture is over. Also this band's own full width, since the
    // rect grows again if you back the zoom off or drag.
    for (const plan of this.levelBands(lon, lat)) {
      if (plan.z >= here.z && plan.z <= here.z + WARM_LOOKAHEAD_LEVELS) warmPlan(plan);
    }
  }

  /**
   * Pre-fetch the imagery around a point the view is about to be sent to —
   * the round's answer, before the reveal flies there. The bands the fly-to
   * passes through are planned now and fetched during the round, so the zoom
   * lands sharp instead of spending its first second unblurring.
   *
   * No secret leaks: every location's coordinates already ship in the bundle,
   * and the prompt names the place.
   */
  prefetchAround(p: LatLon): void {
    if (this.sat.failed || !warmingAllowed()) return;
    clearWarmQueue(); // last round's leftovers are no longer worth the bandwidth
    this.warmedViewKey = ''; // …but re-warm the view we're actually looking at
    this.warmedAheadKey = '';
    const landing = this.planFor(p.lon, p.lat, Math.min(MAX_SCALE_FACTOR, ANSWER_ZOOM));
    if (!landing) return;
    // Just the band the fly-to settles in. The framing beat before it sits
    // wherever the guess put it, which is usually nowhere near, and one band
    // per round is already a megabyte or two of somebody's data.
    warmPlan(landing);
  }

  /**
   * Swap in a patch that can be built from cache alone. Runs on every render
   * request, guarded by a short floor so a continuous pinch doesn't re-upload
   * a 2048² texture every frame.
   */
  private applyCachedDetail(): void {
    if (!this.sat.ready || this.sat.failed) return;
    if (this.zoom < DETAIL_ZOOM_THRESHOLD) return;
    const now = performance.now();
    if (now - this.lastCachedApply < CACHED_APPLY_MS) return;
    // Charge the throttle for the attempt, not just the hit: a drag fires this
    // on every frame, and re-planning 60 times a second to find nothing warm
    // is work nobody sees.
    this.lastCachedApply = now;
    const plan = this.planFor(-this.rotation[0], -this.rotation[1], this.zoom);
    if (!plan) return;
    const key = planKey(plan);
    if (key === this.appliedDetailKey) return;
    const canvas = compositeCached(plan, this.sat.baseImage);
    if (!canvas) return;
    this.detailToken++; // any in-flight build is for a view we've moved past
    this.sat.setPatch(canvas, plan.bounds);
    this.appliedDetailKey = key;
    // Refining a patch that's already up should not flicker through a fade;
    // only the first patch of a zoom-in gets one.
    if (this.sat.patchAlpha === 0) this.fadePatchIn();
    else this.requestRenderOnly();
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
      // Idle at globe scale: line up the first zoom step for wherever the
      // view is now pointing.
      this.warmView();
      return;
    }
    this.warmAhead();
    const plan = this.planFor(-this.rotation[0], -this.rotation[1], this.zoom);
    if (!plan) return;
    const key = planKey(plan);
    if (key === this.appliedDetailKey) return; // already showing this patch
    const token = ++this.detailToken;
    let lastPaint = 0;
    void buildPatch(plan, this.sat.baseImage, (canvas) => {
      // Show the patch filling in rather than holding everything back until
      // the slowest tile of the batch arrives — throttled, since each paint
      // is a texture upload.
      if (token !== this.detailToken) return;
      const now = performance.now();
      if (now - lastPaint < PATCH_PAINT_MS) return;
      lastPaint = now;
      this.sat.setPatch(canvas, plan.bounds);
      if (this.sat.patchAlpha === 0) this.fadePatchIn();
      else this.requestRenderOnly();
    })
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

    // The answer pin literally drops in, so the eye is drawn to it.
    const drop = this.dropProgress();
    const dropPx = (1 - drop) * -34;
    this.drawMarker(target, c('--target', '#3ddc84'), true, dropPx, drop);
    if (targetLabel) {
      this.drawLabel(target, targetLabel, c('--target', '#3ddc84'), dropPx, drop);
    }

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

  private drawMarker(
    p: LatLon,
    color: string,
    ring = false,
    dy = 0,
    alpha = 1,
  ): void {
    if (!this.isVisible(p)) return;
    const pt = this.projection([p.lon, p.lat]);
    if (!pt) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(pt[0], pt[1] + dy, 5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.stroke();
    if (ring) {
      // Landed ring expands out of the dot as the drop finishes.
      ctx.beginPath();
      ctx.arc(pt[0], pt[1] + dy, 6 + 4 * alpha, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Marker caption, offset above the dot. */
  private drawLabel(
    p: LatLon,
    text: string,
    color: string,
    dy = 0,
    alpha = 1,
  ): void {
    if (!this.isVisible(p)) return;
    const pt = this.projection([p.lon, p.lat]);
    if (!pt) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    this.drawChip(pt[0], pt[1] + dy - 20, text, color, false);
    ctx.restore();
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
