import { useEffect, useMemo, useRef, useState } from "react";
import Matter from "matter-js";

export type LaneEvent =
  | { kind: "throw"; speed: number; curve: number }
  | { kind: "roll_end"; knocked: number; remaining: number };

type Props = {
  disabled?: boolean;
  onEvent?: (e: LaneEvent) => void;
  // When this number changes, reset the lane/pins.
  resetToken: number;
  // If true, keep standing pins on reset (for 2nd roll of a frame).
  keepStandingPins?: boolean;
};

// Simulation dimensions (world units ~= px)
const W = 320;
const H = 780;

const BALL_R = 14;
const PIN_W = 14;
const PIN_H = 34;

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function neon(ctx: CanvasRenderingContext2D, color: string, blur = 14) {
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
}

export function LaneCanvas(props: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const engineRef = useRef<Matter.Engine | null>(null);
  const runnerRef = useRef<number | null>(null);

  const ballRef = useRef<Matter.Body | null>(null);
  const pinsRef = useRef<Matter.Body[]>([]);

  const [gestureHint, setGestureHint] = useState<{ dx: number; dy: number; speed: number; curve: number } | null>(null);

  const gesture = useRef<null | {
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    startT: number;
    active: boolean;
  }>(null);

  const laneBounds = useMemo(() => {
    // lane rectangle inside world
    return {
      left: 36,
      right: W - 36,
      top: 80,
      bottom: H - 90,
    };
  }, []);

  function resetWorld(keepStandingPins: boolean) {
    const engine = engineRef.current;
    if (!engine) return;

    const world = engine.world;

    // Remove all bodies
    Matter.World.clear(world, false);

    // Lane walls
    const wallOpts: Matter.IChamferableBodyDefinition = { isStatic: true, restitution: 0.2, friction: 0.02 };
    const leftWall = Matter.Bodies.rectangle(laneBounds.left - 12, (laneBounds.top + laneBounds.bottom) / 2, 24, laneBounds.bottom - laneBounds.top, wallOpts);
    const rightWall = Matter.Bodies.rectangle(laneBounds.right + 12, (laneBounds.top + laneBounds.bottom) / 2, 24, laneBounds.bottom - laneBounds.top, wallOpts);
    const backWall = Matter.Bodies.rectangle((laneBounds.left + laneBounds.right) / 2, laneBounds.top - 10, laneBounds.right - laneBounds.left, 20, wallOpts);

    // Invisible gutters bottom
    const bottomWall = Matter.Bodies.rectangle((laneBounds.left + laneBounds.right) / 2, laneBounds.bottom + 12, laneBounds.right - laneBounds.left, 24, {
      isStatic: true,
      restitution: 0.2,
      friction: 0.02,
    });

    Matter.World.add(world, [leftWall, rightWall, backWall, bottomWall]);

    // Ball
    const ball = Matter.Bodies.circle((laneBounds.left + laneBounds.right) / 2, laneBounds.bottom - 40, BALL_R, {
      restitution: 0.15,
      friction: 0.01,
      frictionAir: 0.01,
      density: 0.02,
    });
    ballRef.current = ball;
    Matter.World.add(world, ball);

    // Pins
    const pins: Matter.Body[] = [];

    if (keepStandingPins && pinsRef.current.length) {
      // Re-add existing pins in their current transforms (standing pins only)
      for (const p of pinsRef.current) {
        pins.push(p);
      }
      Matter.World.add(world, pins);
      pinsRef.current = pins;
      return;
    }

    // Real 10-pin rack: headpin closest to the bowler.
    // In our world, the bowler is near the bottom of the lane (larger y).
    const headPinY = laneBounds.top + 90 + 3 * 32;
    const pinCenterX = (laneBounds.left + laneBounds.right) / 2;
    const rowGapY = 32;
    const colGapX = 20;

    const rows = [1, 2, 3, 4];
    let idx = 0;
    for (let r = 0; r < rows.length; r++) {
      const count = rows[r];
      const y = headPinY - r * rowGapY;
      const x0 = pinCenterX - ((count - 1) * colGapX) / 2;
      for (let c = 0; c < count; c++) {
        const x = x0 + c * colGapX;
        const pin = Matter.Bodies.rectangle(x, y, PIN_W, PIN_H, {
          restitution: 0.25,
          friction: 0.4,
          frictionAir: 0.02,
          density: 0.015,
          chamfer: { radius: 6 },
        });
        pin.label = `pin_${idx++}`;
        pins.push(pin);
      }
    }

    pinsRef.current = pins;
    Matter.World.add(world, pins);
  }

  function removeDownPins() {
    const engine = engineRef.current;
    if (!engine) return { knocked: 0, remaining: 0 };

    const world = engine.world;

    const standing: Matter.Body[] = [];
    let knocked = 0;

    for (const p of pinsRef.current) {
      const angle = Math.abs(p.angle);
      const offLane = p.position.y > laneBounds.bottom - 60 || p.position.x < laneBounds.left - 40 || p.position.x > laneBounds.right + 40;
      const tipped = angle > 0.55;

      if (offLane || tipped) {
        knocked++;
        Matter.World.remove(world, p);
      } else {
        standing.push(p);
      }
    }

    pinsRef.current = standing;
    return { knocked, remaining: standing.length };
  }

  const rollingRef = useRef(false);

  function throwBall(dx: number, dy: number, dtMs: number) {
    const engine = engineRef.current;
    const ball = ballRef.current;
    if (!engine || !ball) return;

    // Only allow throw if ball is near the start zone and mostly stationary.
    const v = ball.velocity;
    const speedNow = Math.hypot(v.x, v.y);
    const inStartZone = ball.position.y > laneBounds.bottom - 140;
    if (!inStartZone) return;
    if (speedNow > 0.4) return;

    // Interpret swipe: upward swipe (dy negative) gives forward speed.
    const t = clamp(dtMs, 40, 600);
    const vx = clamp(dx / t, -1.2, 1.2);
    const vy = clamp(dy / t, -2.2, -0.25);

    // Map to lane velocity (negative y is down-lane)
    const forward = clamp(-vy * 18, 6, 28);
    const curve = clamp(vx * 10, -8, 8);

    Matter.Body.setVelocity(ball, {
      x: curve,
      y: -forward,
    });

    Matter.Body.setAngularVelocity(ball, clamp(vx * 0.12, -0.2, 0.2));

    rollingRef.current = true;
    props.onEvent?.({ kind: "throw", speed: forward, curve });
  }

  function resetBallPosition() {
    const ball = ballRef.current;
    if (!ball) return;
    Matter.Body.setPosition(ball, { x: (laneBounds.left + laneBounds.right) / 2, y: laneBounds.bottom - 40 });
    Matter.Body.setVelocity(ball, { x: 0, y: 0 });
    Matter.Body.setAngularVelocity(ball, 0);
  }

  function draw(ctx: CanvasRenderingContext2D, scale: number) {
    ctx.save();
    ctx.scale(scale, scale);

    // Background
    ctx.clearRect(0, 0, W, H);

    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#020617");
    bg.addColorStop(1, "#000000");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Neon lane
    const laneW = laneBounds.right - laneBounds.left;
    const laneH = laneBounds.bottom - laneBounds.top;

    ctx.fillStyle = "#0b1220";
    ctx.fillRect(laneBounds.left, laneBounds.top, laneW, laneH);

    // Lane glow edges
    ctx.lineWidth = 2;
    neon(ctx, "#22d3ee", 18);
    ctx.strokeStyle = "rgba(34,211,238,0.9)";
    ctx.strokeRect(laneBounds.left, laneBounds.top, laneW, laneH);

    // Target arrows / dots
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(168,85,247,0.9)";
    for (let i = 0; i < 7; i++) {
      const x = laneBounds.left + (i + 1) * (laneW / 8);
      ctx.beginPath();
      ctx.arc(x, laneBounds.bottom - 160, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Pins
    for (const p of pinsRef.current) {
      const { x, y } = p.position;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(p.angle);

      neon(ctx, "#f472b6", 12);
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      roundRect(ctx, -PIN_W / 2, -PIN_H / 2, PIN_W, PIN_H, 6);
      ctx.fill();

      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(15,23,42,0.65)";
      ctx.fillRect(-PIN_W / 2 + 2, -PIN_H / 2 + 6, PIN_W - 4, 5);
      ctx.restore();
    }

    // Ball
    const ball = ballRef.current;
    if (ball) {
      const { x, y } = ball.position;
      neon(ctx, "#38bdf8", 20);
      ctx.fillStyle = "rgba(56,189,248,0.92)";
      ctx.beginPath();
      ctx.arc(x, y, BALL_R, 0, Math.PI * 2);
      ctx.fill();

      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(2,6,23,0.55)";
      ctx.beginPath();
      ctx.arc(x + 4, y + 2, BALL_R * 0.35, 0, Math.PI * 2);
      ctx.fill();
    }

    // Gesture aim line
    if (gesture.current?.active) {
      const g = gesture.current;
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(34,211,238,0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(g.startX, g.startY);
      ctx.lineTo(g.lastX, g.lastY);
      ctx.stroke();
    }

    ctx.restore();
  }

  function step(ts: number, lastTsRef: { current: number }) {
    const engine = engineRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!engine || !canvas || !ctx) return;

    const last = lastTsRef.current || ts;
    const dt = clamp(ts - last, 8, 34);
    lastTsRef.current = ts;

    Matter.Engine.update(engine, dt);

    // End-of-roll detection: once thrown, end when ball reaches pin deck or slows.
    const ball = ballRef.current;
    if (ball && rollingRef.current) {
      const nearPins = ball.position.y < laneBounds.top + 170;
      const slow = Math.hypot(ball.velocity.x, ball.velocity.y) < 0.35;
      if (nearPins || slow) {
        const { knocked, remaining } = removeDownPins();
        rollingRef.current = false;
        props.onEvent?.({ kind: "roll_end", knocked, remaining });
        resetBallPosition();
      }
    }

    // Fit to container
    const wrap = wrapRef.current;
    const scale = wrap ? Math.min(wrap.clientWidth / W, wrap.clientHeight / H, 1.25) : 1;
    const wpx = Math.floor(W * scale);
    const hpx = Math.floor(H * scale);
    if (canvas.width !== wpx || canvas.height !== hpx) {
      canvas.width = wpx;
      canvas.height = hpx;
    }

    draw(ctx, scale);
    runnerRef.current = requestAnimationFrame(() => step(performance.now(), lastTsRef));
  }

  useEffect(() => {
    const engine = Matter.Engine.create();
    engine.gravity.x = 0;
    engine.gravity.y = 0;
    engineRef.current = engine;

    resetWorld(false);

    const lastTsRef = { current: 0 };
    runnerRef.current = requestAnimationFrame(() => step(performance.now(), lastTsRef));

    return () => {
      if (runnerRef.current) cancelAnimationFrame(runnerRef.current);
      runnerRef.current = null;
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // reset => either full rack or keep standing pins (second roll)
    resetWorld(!!props.keepStandingPins);
    setGestureHint(null);
    rollingRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.resetToken]);

  // Pointer gesture handling
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    function onDown(ev: PointerEvent) {
      if (props.disabled) return;
      if (!canvas) return;
      canvas.setPointerCapture(ev.pointerId);

      const rect = canvas.getBoundingClientRect();
      const wrap = wrapRef.current;
      const scale = wrap ? Math.min(wrap.clientWidth / W, 1.25) : 1;
      const x = (ev.clientX - rect.left) / scale;
      const y = (ev.clientY - rect.top) / scale;

      gesture.current = { startX: x, startY: y, lastX: x, lastY: y, startT: performance.now(), active: true };
      setGestureHint(null);
    }

    function onMove(ev: PointerEvent) {
      const g = gesture.current;
      if (!g?.active) return;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const wrap = wrapRef.current;
      const scale = wrap ? Math.min(wrap.clientWidth / W, 1.25) : 1;
      const x = (ev.clientX - rect.left) / scale;
      const y = (ev.clientY - rect.top) / scale;

      g.lastX = x;
      g.lastY = y;

      const dx = x - g.startX;
      const dy = y - g.startY;
      const dt = clamp(performance.now() - g.startT, 40, 600);
      const vx = clamp(dx / dt, -1.2, 1.2);
      const vy = clamp(dy / dt, -2.2, -0.25);
      const forward = clamp(-vy * 18, 6, 28);
      const curve = clamp(vx * 10, -8, 8);
      setGestureHint({ dx, dy, speed: forward, curve });
    }

    function onUp(_ev: PointerEvent) {
      const g = gesture.current;
      if (!g?.active) return;

      const dx = g.lastX - g.startX;
      const dy = g.lastY - g.startY;
      const dt = performance.now() - g.startT;

      gesture.current = { ...g, active: false };
      throwBall(dx, dy, dt);
    }

    canvas.addEventListener("pointerdown", onDown, { passive: true });
    canvas.addEventListener("pointermove", onMove, { passive: true });
    canvas.addEventListener("pointerup", onUp, { passive: true });
    canvas.addEventListener("pointercancel", onUp, { passive: true });

    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
    };
  }, [props.disabled]);

  return (
    <div className="relative" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="w-full touch-none select-none rounded-3xl ring-1 ring-white/10"
        aria-label="Bowling lane"
      />

      {gestureHint ? (
        <div className="pointer-events-none absolute left-3 top-3 rounded-xl bg-black/55 px-3 py-2 text-[11px] text-white ring-1 ring-white/10">
          <div className="font-semibold tracking-wide text-cyan-200">Gesture test</div>
          <div className="mt-0.5 text-white/90">speed: {gestureHint.speed.toFixed(1)}</div>
          <div className="text-white/90">curve: {gestureHint.curve.toFixed(1)}</div>
        </div>
      ) : null}

      <div className="pointer-events-none absolute bottom-3 left-3 rounded-xl bg-black/50 px-3 py-2 text-[11px] text-white/90 ring-1 ring-white/10">
        Swipe up with your thumb to throw.
      </div>
    </div>
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
