import { useMemo, useState } from "react";
import "./App.css";
import { LaneCanvas, type LaneEvent } from "./components/LaneCanvas";
import { computeBowlingScore, isFrameComplete, makeInitialFrames, maxPinsThisRoll } from "./lib/scoring";

type Player = { id: string; name: string };

function uid() {
  return Math.random().toString(16).slice(2);
}

export default function App() {
  const [players, setPlayers] = useState<Player[]>([
    { id: uid(), name: "Sam" },
    { id: uid(), name: "Friend" },
  ]);

  const [framesByPlayer, setFramesByPlayer] = useState(() => makeInitialFrames(2));
  const [playerIndex, setPlayerIndex] = useState(0);
  const [frameIndex, setFrameIndex] = useState(0);
  const [resetToken, setResetToken] = useState(1);
  const [keepStandingPins, setKeepStandingPins] = useState(false);
  const [rolling, setRolling] = useState(false);

  const curFrames = framesByPlayer[playerIndex] ?? [];
  const curFrame = curFrames[frameIndex] ?? { rolls: [] as number[] };

  const scores = useMemo(() => {
    return players.map((p, i) => {
      const frames = framesByPlayer[i] ?? [];
      const { total, perFrame } = computeBowlingScore(frames);
      return { player: p, total, perFrame, frames };
    });
  }, [players, framesByPlayer]);

  const maxPins = maxPinsThisRoll(frameIndex, curFrame);

  function onLaneEvent(e: LaneEvent) {
    if (e.kind === "throw") {
      setRolling(true);
      return;
    }
    if (e.kind !== "roll_end") return;
    setRolling(false);

    const knocked = Math.max(0, Math.min(maxPins, e.knocked));

    setFramesByPlayer((prev) => {
      const next = prev.map((arr) => arr.map((f) => ({ rolls: [...f.rolls] })));
      const pf = next[playerIndex]![frameIndex]!;
      pf.rolls.push(knocked);
      return next;
    });

    // Advance turn if frame complete
    const nextFrameState = (() => {
      const newFrame = { ...curFrame, rolls: [...curFrame.rolls, knocked] };
      const done = isFrameComplete(frameIndex, newFrame);

      if (!done) {
        // second roll in same frame -> keep standing pins
        setKeepStandingPins(true);
        setResetToken((x) => x + 1);
        return;
      }

      // next player or next frame
      const isLastPlayer = playerIndex === players.length - 1;
      if (!isLastPlayer) {
        setPlayerIndex((i) => i + 1);
      } else {
        setPlayerIndex(0);
        setFrameIndex((f) => Math.min(9, f + 1));
      }

      // full reset pins for next turn/frame
      setKeepStandingPins(false);
      setResetToken((x) => x + 1);
    })();

    void nextFrameState;
  }

  function addPlayer() {
    const name = prompt("Player name?")?.trim();
    if (!name) return;
    setPlayers((prev) => {
      const next = [...prev, { id: uid(), name }];
      setFramesByPlayer(() => makeInitialFrames(next.length));
      setPlayerIndex(0);
      setFrameIndex(0);
      setKeepStandingPins(false);
      setRolling(false);
      setResetToken((x) => x + 1);
      return next;
    });
  }

  function resetGame() {
    if (!confirm("Reset game?") ) return;
    setFramesByPlayer(makeInitialFrames(players.length));
    setPlayerIndex(0);
    setFrameIndex(0);
    setKeepStandingPins(false);
    setRolling(false);
    setResetToken((x) => x + 1);
  }

  return (
    <div className="appRoot">
      <header className="hud">
        <div className="brand">
          <div className="brandTitle">NEON BOWL</div>
          <div className="brandSub">Touch bowling • iPhone-first</div>
        </div>

        <div className="hudRight">
          <button className="hudBtn" onClick={addPlayer}>+ Player</button>
          <button className="hudBtn ghost" onClick={resetGame}>Reset</button>
        </div>
      </header>

      <main className="main">
        <section className="scoreCard">
          <div className="turnRow">
            <div>
              <div className="turnLabel">Up next</div>
              <div className="turnName">{players[playerIndex]?.name}</div>
            </div>
            <div className="turnMeta">
              <div className="pill">Frame {frameIndex + 1}/10</div>
              <div className="pill">Roll {curFrame.rolls.length + 1}</div>
            </div>
          </div>

          <div className="scoreGrid">
            {scores.map((s) => (
              <div key={s.player.id} className={"playerRow" + (s.player.id === players[playerIndex]?.id ? " active" : "")}
              >
                <div className="playerName">{s.player.name}</div>
                <div className="playerTotal">{s.total}</div>
                <div className="frameMini">
                  {Array.from({ length: 10 }).map((_, i) => (
                    <div key={i} className="frameCell">
                      <div className="frameNum">{i + 1}</div>
                      <div className="frameVal">{s.perFrame[i] ?? ""}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="laneWrap">
          <LaneCanvas
            resetToken={resetToken}
            keepStandingPins={keepStandingPins}
            disabled={rolling}
            onEvent={onLaneEvent}
          />
          <div className="hint">Tip: swipe up. Curve left/right by swiping diagonally.</div>
        </section>
      </main>

      <footer className="footer">
        <div className="footerText">Neon Bowl MVP • Physics: Matter.js • Scoring: 10-pin</div>
      </footer>
    </div>
  );
}
