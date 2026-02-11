export type Frame = {
  // 10 frames. Each frame has 1-3 rolls.
  rolls: number[];
};

export function computeBowlingScore(frames: Frame[]) {
  // Flatten to rolls per standard bowling scoring.
  const rolls: number[] = [];
  for (let i = 0; i < Math.min(frames.length, 10); i++) {
    const f = frames[i];
    for (const r of f.rolls) rolls.push(r);
  }

  let total = 0;
  const perFrame: number[] = [];
  let rollIndex = 0;

  for (let frame = 0; frame < 10; frame++) {
    const first = rolls[rollIndex] ?? 0;

    // strike
    if (first === 10) {
      const bonus1 = rolls[rollIndex + 1] ?? 0;
      const bonus2 = rolls[rollIndex + 2] ?? 0;
      const s = 10 + bonus1 + bonus2;
      perFrame.push(s);
      total += s;
      rollIndex += 1;
      continue;
    }

    const second = rolls[rollIndex + 1] ?? 0;
    const framePins = first + second;

    // spare
    if (framePins === 10) {
      const bonus = rolls[rollIndex + 2] ?? 0;
      const s = 10 + bonus;
      perFrame.push(s);
      total += s;
      rollIndex += 2;
      continue;
    }

    // open
    const s = framePins;
    perFrame.push(s);
    total += s;
    rollIndex += 2;
  }

  return { total, perFrame };
}

export function makeInitialFrames(playerCount: number) {
  return Array.from({ length: playerCount }, () => Array.from({ length: 10 }, () => ({ rolls: [] as number[] })));
}

export function isFrameComplete(frameIndex: number, frame: Frame) {
  const rolls = frame.rolls;
  if (frameIndex < 9) {
    if (rolls.length === 0) return false;
    if (rolls[0] === 10) return true;
    return rolls.length >= 2;
  }

  // 10th frame
  if (rolls.length < 2) return false;
  const first = rolls[0] ?? 0;
  const second = rolls[1] ?? 0;
  if (first === 10 || first + second === 10) {
    return rolls.length >= 3;
  }
  return rolls.length >= 2;
}

export function maxPinsThisRoll(frameIndex: number, frame: Frame) {
  // Useful for validation.
  if (frameIndex < 9) {
    if (frame.rolls.length === 0) return 10;
    return Math.max(0, 10 - (frame.rolls[0] ?? 0));
  }

  // 10th frame
  const r = frame.rolls;
  if (r.length === 0) return 10;
  if (r.length === 1) return r[0] === 10 ? 10 : 10 - r[0];
  if (r.length === 2) {
    const first = r[0] ?? 0;
    const second = r[1] ?? 0;
    if (first === 10) return second === 10 ? 10 : 10 - second;
    if (first + second === 10) return 10;
    return 0;
  }
  return 0;
}
