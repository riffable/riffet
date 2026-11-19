import { BRAND_BODY, BRAND_EYE, BRAND_TEETH } from '@/lib/brand-geometry';

/**
 * 黑马跑酷: the brand mark runs right to left over fences, failed checks and conflict markers.
 * Obstacles fall on the beat: a beat is a fixed distance on the ground, so going faster means a
 * higher tempo, and a take-off on the beat in front of an obstacle strikes a tooth of the mane.
 *
 * The mane starts grey. A tooth floating over an empty beat, bumped with the head, lights one:
 * one jumps higher, two also jump further, three double what an on-beat take-off scores. A crash
 * with a lit tooth costs that tooth and a moment of flicker instead of the run.
 * The engine only draws and steps; the React shell owns input, focus, text and storage. It runs
 * on an `OffscreenCanvas` in a worker (`runner.worker.ts`) where it can, so a busy page does not
 * stall it, and on the page's own canvas otherwise.
 */
export type RunnerPhase = 'ready' | 'count' | 'run' | 'paused' | 'over' | 'finishing' | 'done';

export interface RunnerColors {
  ink: string;
  mane: string;
  line: string;
  muted: string;
  faint: string;
}

export interface RunnerEvents {
  phase: (phase: RunnerPhase) => void;
  score: (score: number) => void;
}

/** Ground distance of one beat, in CSS pixels. */
const BEAT = 190;
const BAR = 4;
const bpmAt = (beat: number) => Math.min(104 + 8 * Math.floor(Math.max(0, beat) / (BAR * 8)), 160);
const speedAt = (beat: number) => BEAT * bpmAt(beat) / 60;
/** Seconds in the air on a full jump, whatever the height: the beat maths depend on it. */
const AIR = 0.55;
/** One riff per bar: T fence, L failed check, W conflict marker, F double fence, `.` a rest. */
const RIFFS = [
  ['T...', '..T.', 'L...', 'T.L.', '....', '.T..'],
  ['T.T.', 'L.T.', 'W...', '.T.L', 'F...', 'T..L'],
  ['T.T.', 'W.T.', 'L.L.', 'F.T.', '.W.T', 'T.W.', 'L.F.'],
] as const;
type Kind = 'T' | 'L' | 'W' | 'F';
const SHAPES: Record<Kind, { w: number; h: number }> = { T: { w: 22, h: 34 }, L: { w: 22, h: 22 }, W: { w: 74, h: 16 }, F: { w: 54, h: 30 } };
const TOOTH_OF_BEAT = [0, 1, 2, 1] as const;
/** The horse is drawn this tall; the mark is on a 24-unit grid. */
const HORSE = 36;
const U = HORSE / 24;
const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';
/** What each lit tooth gives: a higher jump, a longer one (never past the next obstacle's beat). */
const HIGH = 1.3;
const LONG = 1.35;
const LONG_MAX_BEATS = 1.9;
/** After losing a tooth, obstacles pass through the horse for this long. */
const SHIELD = 1.2;
/** The floating tooth's half size, and its chance per bar while the mane is not full. */
const BONUS = 9;
const BONUS_CHANCE = 0.4;
const LEVEL_MARK = ['↑', '→', '★'] as const;
/** A key that reached the engine late (the page was busy) counts from when it was pressed, up to this. */
const MAX_LAG = 0.12;

type Canvas = HTMLCanvasElement | OffscreenCanvas;
type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
// A worker has its own frames in most browsers; where it has none, a timer stands in.
const nextFrame = (callback: (now: number) => void): number => typeof requestAnimationFrame === 'function'
  ? requestAnimationFrame(callback)
  : setTimeout(() => callback(performance.now()), 16) as unknown as number;
const cancelFrame = (frame: number) => { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame); else clearTimeout(frame); };

interface Obstacle { beat: number; kind: Kind; x: number; w: number; h: number; perfect: boolean }
/** A tooth to bump: `taken` runs from 0 once the head reaches it. */
interface Bonus { beat: number; x: number; taken: number }

let headPath: Path2D | undefined;
let bodyPath: Path2D | undefined;
let toothPaths: Path2D[] | undefined;
function brandPaths() {
  headPath ??= new Path2D(`${BRAND_BODY}${BRAND_EYE}`);
  bodyPath ??= new Path2D(BRAND_BODY);
  toothPaths ??= BRAND_TEETH.map(([d]) => new Path2D(d));
  return { head: headPath, body: bodyPath, teeth: toothPaths };
}

export class RunnerEngine {
  private readonly ctx: Context;
  private width = 0;
  private height = 0;
  private colors: RunnerColors;
  private frame = 0;
  private last = 0;

  phase: RunnerPhase = 'ready';
  score = 0;
  private s = 0;
  private y = 0;
  private vy = 0;
  private gravity = 0;
  private lift = 0;
  private obstacles: Obstacle[] = [];
  private nextBar = 2;
  private lastBeat = -9;
  private lastTickBeat = -1;
  private hits = [0, 0, 0];
  private floats: { x: number; y: number; a: number; text: string }[] = [];
  private combo = 0;
  private t = 0;
  private shake = 0;
  private finishAt: number | undefined;
  private slow = 1;
  private count = 0;
  private countBeat = -1;
  /** Lit teeth, 0–3. */
  private level = 0;
  private bonuses: Bonus[] = [];
  private shield = 0;
  private dropped: { x: number; y: number; vy: number; a: number } | undefined;
  /** A plain jump's height for this strip. */
  private rise = 0;

  constructor(private readonly canvas: Canvas, colors: RunnerColors, private readonly events: RunnerEvents) {
    const ctx = canvas.getContext('2d') as Context | null;
    if (!ctx) throw new Error('2d canvas unavailable');
    this.ctx = ctx;
    this.colors = colors;
  }

  private get horseX() { return Math.min(72, Math.max(40, this.width * 0.1)); }
  private get groundY() { return this.height - 30; }

  resize(width: number, height: number, dpr: number) {
    this.width = width;
    this.height = height;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // A short strip jumps lower, in the same time, so the beat maths hold.
    this.rise = Math.max(56, Math.min(100, height - 30 - HORSE - 24));
    this.draw();
  }

  setColors(colors: RunnerColors) {
    this.colors = colors;
    this.draw();
  }

  /**
   * Jump while running; start or restart otherwise. `lag` is how long ago, in seconds, the key went
   * down: the take-off is judged and the jump drawn from then, so a busy page does not cost the beat.
   */
  press(lag = 0) {
    if (this.phase === 'ready' || this.phase === 'paused') { this.countIn(); return; }
    if (this.phase === 'over' || this.phase === 'done') { this.reset(); this.countIn(); return; }
    if (this.phase !== 'run') return;
    if (this.y < 0) return;
    const late = Math.min(Math.max(lag, 0), MAX_LAG);
    const at = this.s - speedAt(Math.floor(this.s / BEAT)) * late;
    const beat = Math.round(at / BEAT);
    // Lit teeth: higher, then also longer (landing before the next beat's take-off).
    const air = this.level >= 2 ? Math.min(AIR * LONG, LONG_MAX_BEATS * 60 / bpmAt(beat)) : AIR;
    this.lift = 4 * this.jumpRise / air;
    this.gravity = 2 * this.lift / air;
    this.vy = -this.lift + this.gravity * late;
    this.y = Math.min(-0.01, -this.lift * late + this.gravity * late * late / 2);
    const error = (at - beat * BEAT) / speedAt(beat);
    const obstacle = this.obstacles.find((item) => item.beat === beat);
    if (obstacle && Math.abs(error) < 0.075) {
      obstacle.perfect = true;
      this.combo++;
      const points = this.level >= 3 ? 4 : 2;
      this.score += points;
      this.hits[TOOTH_OF_BEAT[((beat % BAR) + BAR) % BAR]!] = 1;
      this.floats.push({ x: this.horseX + 18, y: this.groundY - 70, a: 1, text: this.combo > 1 ? `×${this.combo}` : `+${points}` });
    } else if (obstacle && Math.abs(error) < 0.25) {
      this.combo = 0;
    }
  }

  /** Letting go early cuts the jump short. */
  release() {
    if (this.vy < 0) this.vy *= 0.6;
  }

  pause() {
    if (this.phase !== 'run' && this.phase !== 'count') return;
    this.setPhase('paused');
  }

  /** Two bars on, a finish post; no obstacle after it. */
  finish() {
    if (this.finishAt !== undefined) return;
    if (this.phase === 'ready' || this.phase === 'over' || this.phase === 'done') return;
    this.finishAt = (Math.ceil(this.s / BEAT / BAR) + 2) * BAR * BEAT;
    this.obstacles = this.obstacles.filter((item) => item.beat * BEAT < this.finishAt! - BEAT * 1.5);
    this.bonuses = this.bonuses.filter((item) => item.taken > 0 || item.beat * BEAT < this.finishAt! - BEAT * 1.5);
    this.draw();
  }

  reset() {
    this.s = 0; this.y = 0; this.vy = 0; this.score = 0; this.combo = 0; this.t = 0; this.shake = 0;
    this.obstacles = []; this.nextBar = 2; this.lastBeat = -9; this.lastTickBeat = -1;
    this.hits = [0, 0, 0]; this.floats = []; this.finishAt = undefined; this.slow = 1;
    this.level = 0; this.bonuses = []; this.shield = 0; this.dropped = undefined;
    this.events.score(0);
    this.setPhase('ready');
  }

  destroy() {
    cancelFrame(this.frame);
    this.frame = 0;
  }

  private countIn() {
    this.count = 0;
    this.countBeat = -1;
    this.setPhase('count');
  }

  private setPhase(phase: RunnerPhase) {
    this.phase = phase;
    this.events.phase(phase);
    // Frames run only while something moves; a still strip costs nothing.
    if (phase === 'count' || phase === 'run' || phase === 'finishing') this.loop();
    else this.draw();
  }

  private loop() {
    if (this.frame) return;
    this.last = 0;
    const tick = (now: number) => {
      const dt = Math.min(1 / 30, this.last ? (now - this.last) / 1000 : 0);
      this.last = now;
      this.step(dt);
      this.draw();
      const moving = this.phase === 'count' || this.phase === 'run' || this.phase === 'finishing' || this.shake > 0;
      this.frame = moving ? nextFrame(tick) : 0;
    };
    this.frame = nextFrame(tick);
  }

  private generate() {
    while (this.nextBar * BAR * BEAT < this.s + this.width + 400) {
      const bar = this.nextBar++;
      const start = bar * BAR;
      if (this.finishAt !== undefined && start * BEAT >= this.finishAt - BEAT * 1.5) continue;
      const pool = RIFFS[Math.min(RIFFS.length - 1, Math.floor(bar / 8))]!;
      const riff = pool[Math.floor(Math.random() * pool.length)]!;
      [...riff].forEach((symbol, index) => {
        if (symbol === '.') return;
        const beat = start + index;
        if (beat - this.lastBeat < 2) return;
        if (this.finishAt !== undefined && beat * BEAT >= this.finishAt - BEAT * 1.5) return;
        this.lastBeat = beat;
        // Taking off on the beat puts the top of the jump over the obstacle's middle.
        const middle = beat * BEAT + speedAt(beat) * AIR / 2 + 3 * U;
        const shape = SHAPES[symbol as Kind];
        this.obstacles.push({ beat, kind: symbol as Kind, x: middle - shape.w / 2, w: shape.w, h: shape.h, perfect: false });
      });
      this.placeBonus(bar);
    }
  }

  /**
   * Now and then a tooth where the head peaks on a take-off on some beat of the bar: over an
   * obstacle (an on-beat jump clears it and bumps the tooth), or over an empty beat whose
   * neighbours are empty too, so the jump to it lands clear. None once the mane is full.
   */
  private placeBonus(bar: number) {
    if (bar < 3 || this.level + this.bonuses.filter((item) => !item.taken).length >= 3 || Math.random() > BONUS_CHANCE) return;
    const taken = new Set(this.obstacles.map((item) => item.beat));
    const beats = [0, 1, 2, 3].map((index) => bar * BAR + index);
    const spots = [...beats.filter((beat) => taken.has(beat)), ...beats.slice(0, 3).filter((beat) => !taken.has(beat - 1) && !taken.has(beat) && !taken.has(beat + 1))];
    if (!spots.length) return;
    const beat = spots[Math.floor(Math.random() * spots.length)]!;
    if (this.finishAt !== undefined && beat * BEAT >= this.finishAt - BEAT * 1.5) return;
    this.bonuses.push({ beat, x: beat * BEAT + speedAt(beat) * AIR / 2 + 5 * U, taken: 0 });
  }

  /** How high the next jump goes: one lit tooth lifts it, kept inside the strip. */
  private get jumpRise() { return this.level >= 1 ? Math.min(this.rise * HIGH, this.groundY - HORSE - 4) : this.rise; }

  /** Where the head peaks on a take-off on the beat: a floating tooth sits just under it. */
  private get bonusY() { return this.groundY - 21 * U - this.jumpRise + 10 * U; }

  private step(dt: number) {
    this.t += dt;
    for (let index = 0; index < 3; index++) this.hits[index] = Math.max(0, this.hits[index]! - dt * 5);
    for (const float of this.floats) { float.y -= dt * 30; float.a -= dt * 1.6; }
    this.floats = this.floats.filter((float) => float.a > 0);
    this.shake = Math.max(0, this.shake - dt);
    this.shield = Math.max(0, this.shield - dt);
    for (const item of this.bonuses) if (item.taken) item.taken += dt * 2.5;
    this.bonuses = this.bonuses.filter((item) => item.taken < 1);
    if (this.dropped) {
      this.dropped.vy += 600 * dt; this.dropped.y += this.dropped.vy * dt; this.dropped.x -= 60 * dt; this.dropped.a -= dt * 1.4;
      if (this.dropped.a <= 0) this.dropped = undefined;
    }

    if (this.phase === 'count') {
      // Three beats in, the mane strikes its three teeth; the fourth is the start.
      this.count += dt;
      const beat = Math.floor(this.count / (60 / bpmAt(Math.floor(this.s / BEAT))));
      if (beat !== this.countBeat) {
        this.countBeat = beat;
        if (beat < 3) this.hits[beat] = 1;
        else this.setPhase('run');
      }
      return;
    }
    if (this.phase !== 'run' && this.phase !== 'finishing') return;

    if (this.phase === 'finishing') this.slow = Math.max(0, this.slow - dt * 0.9);
    this.s += speedAt(Math.floor(this.s / BEAT)) * this.slow * dt;
    this.generate();

    const beat = Math.floor(this.s / BEAT);
    if (beat !== this.lastTickBeat) {
      if (this.phase === 'run' && this.lastTickBeat >= 0) { this.score += beat - this.lastTickBeat; this.events.score(this.score); }
      this.lastTickBeat = beat;
    }

    if (this.y < 0 || this.vy < 0) {
      this.vy += this.gravity * dt;
      this.y += this.vy * dt;
      if (this.y >= 0) { this.y = 0; this.vy = 0; }
    }

    if (this.phase === 'run') {
      const ox = this.horseX - 9 * U, oy = this.groundY - 21 * U + this.y;
      const boxes = [
        [ox + 6.8 * U, oy + 7 * U, ox + 12 * U, oy + 21 * U],
        [ox + 9 * U, oy + 6 * U, ox + 19 * U, oy + 13.5 * U],
      ] as const;
      const [, head] = boxes;
      for (const item of this.bonuses) {
        if (item.taken) continue;
        const cx = this.horseX + item.x - this.s, cy = this.bonusY;
        if (head[0] < cx + BONUS && head[2] > cx - BONUS && head[1] < cy + BONUS && head[3] > cy - BONUS) this.collect(item);
      }
      this.bonuses = this.bonuses.filter((item) => item.taken || item.x + BONUS > this.s - this.horseX - 20);
      if (!this.shield) {
        for (const item of this.obstacles) {
          const x0 = this.horseX + item.x - this.s + 3, x1 = x0 + item.w - 6, y0 = this.groundY - item.h + 3, y1 = this.groundY;
          if (x1 < ox || x0 > ox + 22 * U) continue;
          if (boxes.some(([a, b, c, d]) => a < x1 && c > x0 && b < y1 && d > y0)) {
            if (this.level > 0) { this.lose(); break; }
            this.crash(); return;
          }
        }
      }
      this.obstacles = this.obstacles.filter((item) => item.x + item.w > this.s - this.horseX - 20);
      if (this.finishAt !== undefined && this.s >= this.finishAt - 3 * U) this.setPhase('finishing');
    } else if (this.slow === 0) {
      this.setPhase('done');
    }
  }

  private collect(item: Bonus) {
    item.taken = 0.001;
    this.level = Math.min(3, this.level + 1);
    this.hits[this.level - 1] = 1;
    this.floats.push({ x: this.horseX + 18, y: this.groundY - 21 * U + this.y - 8, a: 1, text: LEVEL_MARK[this.level - 1]! });
  }

  /** A crash with a lit tooth: the top tooth falls off and the run goes on. */
  private lose() {
    this.level--;
    this.combo = 0;
    this.shield = SHIELD;
    this.shake = 0.15;
    this.dropped = { x: this.horseX - 4, y: this.groundY - 14 * U + this.y, vy: -120, a: 1 };
  }

  private crash() {
    this.shake = 0.25;
    this.combo = 0;
    this.setPhase('over');
    this.loop();
  }

  private draw() {
    const { ctx, width, height, colors } = this;
    if (!width || !height) return;
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    if (this.shake) ctx.translate(Math.sin(this.t * 90) * 3 * (this.shake / 0.25), 0);
    const ground = this.groundY, horseX = this.horseX;

    // The ground, and a tick per beat: the moment a tick passes the horse is the beat.
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, ground + 0.5); ctx.lineTo(width, ground + 0.5); ctx.stroke();
    const first = Math.floor((this.s - horseX) / BEAT) - 1, end = Math.ceil((this.s + width) / BEAT) + 1;
    for (let beat = first; beat <= end; beat++) {
      const x = Math.round(horseX + beat * BEAT - this.s) + 0.5;
      const bar = beat % BAR === 0;
      const lit = this.phase === 'run' && Math.abs(beat * BEAT - this.s) / BEAT < 0.12;
      ctx.strokeStyle = lit ? colors.mane : bar ? colors.faint : colors.line;
      ctx.lineWidth = lit ? 2 : 1;
      ctx.beginPath(); ctx.moveTo(x, ground + 4); ctx.lineTo(x, ground + (bar ? 12 : 8)); ctx.stroke();
    }
    // Pebbles, for a sense of speed.
    ctx.fillStyle = colors.line;
    for (let index = Math.floor(this.s / 37) - 1; index < (this.s + width) / 37 + 1; index++) {
      const r = Math.abs((Math.sin(index * 12.9898) * 43758.5453) % 1);
      if (r < 0.55) continue;
      ctx.fillRect(Math.round(horseX + index * 37 + r * 30 - this.s), ground + 16 + r * 8, r > 0.85 ? 3 : 2, 1);
    }

    if (this.finishAt !== undefined) {
      const x = horseX + this.finishAt - this.s;
      if (x < width + 40) {
        ctx.strokeStyle = colors.ink; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x, ground); ctx.lineTo(x, ground - 64); ctx.stroke();
        ctx.fillStyle = colors.ink;
        for (let row = 0; row < 3; row++) for (let column = 0; column < 4; column++) if ((row + column) % 2) ctx.fillRect(x + 1 + column * 5, ground - 64 + row * 5, 5, 5);
        ctx.lineWidth = 1; ctx.strokeRect(x + 1.5, ground - 63.5, 20, 15);
      }
    }

    for (const item of this.obstacles) {
      const x = Math.round(horseX + item.x - this.s);
      if (x > width + 10 || x + item.w < -10) continue;
      this.drawObstacle(item, x);
    }

    for (const item of this.bonuses) {
      const x = horseX + item.x - this.s;
      if (x > width + 20 || x < -20) continue;
      // The tooth bobs while it waits; bumped, it jumps up and fades.
      const y = this.bonusY + (item.taken ? -24 * item.taken : Math.sin(this.t * 5 + item.beat) * 2);
      this.drawTooth(x, y, item.taken ? 1 - item.taken : 1);
    }
    if (this.dropped) this.drawTooth(this.dropped.x, this.dropped.y, this.dropped.a, colors.faint);

    this.drawHorse();

    ctx.font = `600 12px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = colors.mane;
    for (const float of this.floats) { ctx.globalAlpha = Math.max(0, float.a); ctx.fillText(float.text, float.x, float.y); }
    ctx.globalAlpha = 1;
    if (this.combo > 1 && this.phase === 'run') { ctx.textAlign = 'left'; ctx.font = `12px ${MONO}`; ctx.fillText(`×${this.combo}`, 12, 20); }
    ctx.restore();
  }

  private drawObstacle(item: Obstacle, x: number) {
    const { ctx, colors } = this;
    const ground = this.groundY, top = ground - item.h;
    ctx.strokeStyle = colors.ink;
    ctx.fillStyle = colors.ink;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    const fence = (left: number, w: number, h: number) => {
      ctx.beginPath();
      ctx.moveTo(left + 1, ground); ctx.lineTo(left + 1, ground - h);
      ctx.moveTo(left + w - 1, ground); ctx.lineTo(left + w - 1, ground - h);
      ctx.moveTo(left - 2, ground - h + 6); ctx.lineTo(left + w + 2, ground - h + 6);
      ctx.moveTo(left - 2, ground - h * 0.45); ctx.lineTo(left + w + 2, ground - h * 0.45);
      ctx.stroke();
    };
    if (item.kind === 'T') fence(x, item.w, item.h);
    if (item.kind === 'F') { fence(x, 20, item.h); fence(x + item.w - 20, 20, item.h - 6); }
    if (item.kind === 'L') {
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.roundRect(x + 0.75, top + 0.75, item.w - 1.5, item.h - 1.5, 4); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x + 7, top + 7); ctx.lineTo(x + item.w - 7, ground - 7); ctx.moveTo(x + item.w - 7, top + 7); ctx.lineTo(x + 7, ground - 7); ctx.stroke();
    }
    if (item.kind === 'W') {
      ctx.font = `600 13px ${MONO}`;
      ctx.textAlign = 'left';
      ctx.fillText('<<<<<<<', x, ground - 3);
    }
    if (item.perfect) {
      ctx.fillStyle = colors.mane;
      ctx.beginPath(); ctx.arc(x + item.w / 2, ground + 8, 2, 0, Math.PI * 2); ctx.fill();
    }
  }

  /** The middle tooth of the mane, a little larger than on the horse, centred on (x, y). */
  private drawTooth(x: number, y: number, alpha: number, color = this.colors.mane) {
    const { ctx } = this;
    const [, px, py] = BRAND_TEETH[1];
    ctx.save();
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.translate(x, y);
    ctx.scale(U * 2, U * 2);
    ctx.translate(-px + 1.6, -py + 0.6);
    ctx.fillStyle = color; ctx.strokeStyle = color; ctx.lineWidth = 0.6; ctx.lineJoin = 'round';
    const tooth = brandPaths().teeth[1]!;
    ctx.fill(tooth); ctx.stroke(tooth);
    ctx.restore();
  }

  private drawHorse() {
    const { ctx, colors } = this;
    const paths = brandPaths();
    const running = this.phase === 'run' || this.phase === 'finishing';
    const air = this.y < 0;
    const stride = (this.s / BEAT) * Math.PI * 4;
    let tilt = 0, bob = 0;
    if (running && !air) { const k = 0.5 - 0.5 * Math.cos(stride); tilt = -5 - 3 * k; bob = -0.9 * k; }
    if (air) tilt = Math.max(-14, Math.min(4, -6 + this.vy / 90));
    if (this.phase === 'over') tilt = 6;
    if (this.phase === 'count') tilt = -2 * Math.max(...this.hits);

    ctx.save();
    // Flickers while a lost tooth keeps obstacles off it.
    if (this.shield && Math.floor(this.shield * 12) % 2) ctx.globalAlpha = 0.35;
    ctx.translate(this.horseX - 9 * U, this.groundY - 21 * U + this.y);
    ctx.scale(U, U);

    if (running && this.slow > 0.4) {
      // Speed lines streaming back from the mane.
      ctx.strokeStyle = colors.mane; ctx.lineWidth = 0.7; ctx.lineCap = 'round';
      for (const [x, y, length, offset] of [[1, 9, 3.2, 0], [0, 13.5, 4, 0.33], [2, 17.5, 2.6, 0.66]] as const) {
        const p = (this.t / 0.7 + offset) % 1;
        ctx.globalAlpha = p < 0.25 ? p * 4 : 1 - (p - 0.25) / 0.75;
        const dx = 3 - 16 * p;
        ctx.beginPath(); ctx.moveTo(x + dx, y); ctx.lineTo(x + dx + length, y); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    ctx.translate(9, 21 + bob); ctx.rotate(tilt * Math.PI / 180); ctx.translate(-9, -21);

    BRAND_TEETH.forEach(([, px, py], index) => {
      ctx.save();
      ctx.translate(px, py);
      let turn = 0, sx = 1, sy = 1;
      if (running) { const p = Math.sin(this.t * Math.PI * 2 / 0.23 - index * 1.1); turn = 18 + 4 * p; sx = 1.24 + 0.06 * p; }
      const hit = this.hits[index]!;
      if (hit) { turn += 7 * hit; sx *= 1 + 0.34 * hit; sy *= 1 + 0.34 * hit; }
      ctx.rotate(turn * Math.PI / 180);
      ctx.scale(sx, sy);
      ctx.translate(-px, -py);
      // Unlit teeth are grey; a strike flashes them for a moment.
      const lit = index < this.level || hit > 0.3;
      ctx.fillStyle = lit ? colors.mane : colors.faint; ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 0.6; ctx.lineJoin = 'round';
      ctx.fill(paths.teeth[index]!); ctx.stroke(paths.teeth[index]!);
      ctx.restore();
    });

    // The head, the eye a hole in it; a fall crosses the eye out.
    ctx.fillStyle = colors.ink; ctx.strokeStyle = colors.ink; ctx.lineWidth = 1; ctx.lineJoin = 'round';
    ctx.fill(paths.head, 'evenodd'); ctx.stroke(paths.body);
    if (this.phase === 'over') {
      ctx.beginPath(); ctx.arc(12.5, 8.2, 1, 0, Math.PI * 2); ctx.fill();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(11.7, 7.4); ctx.lineTo(13.3, 9); ctx.moveTo(13.3, 7.4); ctx.lineTo(11.7, 9); ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();
  }
}
