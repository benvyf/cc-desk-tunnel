import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

// Clawd, Claude Code's pixel mascot, standing on the top edge of the session's message box. Drawn from screenshots
// of the Claude desktop app on a 12 × 8 grid (an 8 × 6 body, 2 × 2 arms, four legs); no artwork is copied from it.
// The units below are those grid cells: the body's top-left corner is (0, 0) and the feet stand on y = 8.
// Idle he stands and now and then blinks or winks; while Claude runs he takes out a small laptop, sets it down,
// turns three-quarters and types; while a run waits for the user he waves. With reduced motion he holds one pose.
export type ClawdState = 'idle' | 'working' | 'waiting';
export type ClawdPose =
  'stand' | 'blink' | 'wink' | 'wave' | 'lift' | 'put' | 'type' | 'tap' | 'typeBlink';

const body = '#d77656',
  side = '#be684c',
  eye = '#1a0000',
  laptop = '#8c8c8b';
type Cell = [x: number, y: number, w: number, h: number, fill?: string];
const legs: Cell[] = [
  [0, 6, 1, 2],
  [2, 6, 1, 2],
  [5, 6, 1, 2],
  [7, 6, 1, 2],
];
const open: Cell[] = [
  [1, 1, 1, 1, eye],
  [6, 1, 1, 1, eye],
];
const shut = (x: number, y = 1): Cell => [x - 0.15, y + 0.55, 1.3, 0.45, eye];
const front = (arms: Cell[], eyes: Cell[]): Cell[] => [[0, 0, 8, 6], ...arms, ...legs, ...eyes];
const level: Cell[] = [
  [-2, 2, 2, 2],
  [8, 2, 2, 2],
];
const askew: Cell[] = [
  [-2, 3, 2, 2],
  [8, 1, 2, 2],
];
// Three-quarters, turned to the laptop on his left: a narrower face, the darker side on the right, the left arm
// reaching down to the keys and the legs bent with their feet showing.
const turned = (arm: number, eyes: 'open' | 'shut'): Cell[] => [
  [0, 1.1, 6, 5.4],
  [6, 1.1, 2, 5.4, side],
  [-1.9, 3.9 + arm, 1.9, 2.1],
  ...(
    [
      [0.2, 6.5],
      [2.3, 6.5],
      [5.1, 6.5],
    ] as const
  ).flatMap(([x, y]): Cell[] => [
    [x, y, 0.9, 1.5],
    [x + 0.9, 7.5, 0.5, 0.5],
  ]),
  [6.8, 6.5, 0.9, 1.5, side],
  [7.7, 7.5, 0.5, 0.5, side],
  ...(eyes === 'open'
    ? ([
        [0.15, 2.85, 0.8, 0.75, eye],
        [3.9, 2.85, 0.8, 0.75, eye],
      ] as Cell[])
    : ([
        [0.05, 3.25, 1, 0.35, eye],
        [3.8, 3.25, 1, 0.35, eye],
      ] as Cell[])),
];
const poses: Record<ClawdPose, { cells: Cell[]; tool?: ReactElement }> = {
  stand: { cells: front(level, open) },
  blink: { cells: front(level, [shut(1), shut(6)]) },
  // Looking down a little: the eyes a row lower.
  wink: { cells: front(askew, [[1, 1.9, 1, 1, eye], shut(6, 1.9)]) },
  wave: { cells: front(askew, open) },
  // Lifting the laptop, half open, above his raised left arm.
  lift: {
    cells: front(
      [
        [-2, 1, 2, 1.6],
        [8, 2, 2, 2],
      ],
      open,
    ),
    tool: (
      <g fill="none" stroke={laptop} strokeWidth={1.2} strokeLinejoin="round">
        <path d="M -0.4 -1.7 L -3.6 0.1 L -0.9 0.9" />
      </g>
    ),
  },
  // Lowering it, closed, from his lowered left arm.
  put: {
    cells: front(askew, open),
    tool: (
      <g stroke={laptop} strokeLinecap="round">
        <path d="M -1.4 4.3 L -5 2.4" strokeWidth={1.1} />
        <circle cx={-5.3} cy={2.2} r={1.1} fill={laptop} stroke="none" />
      </g>
    ),
  },
  type: { cells: turned(0, 'open') },
  tap: { cells: turned(0.4, 'open') },
  typeBlink: { cells: turned(0, 'shut') },
};
// The open laptop on the ground to his left while he types: the base flat, the screen leaning back.
const desk = (
  <g fill="none" stroke={laptop} strokeWidth={0.45} strokeLinecap="square">
    <path d="M -0.7 7.25 L -3.25 7.25 L -5.3 4.8" />
  </g>
);

type Step = [pose: ClawdPose, ms: number];
const between = (low: number, high: number) => low + Math.random() * (high - low);
function* idle(): Generator<Step> {
  for (let round = 1; ; round++) {
    yield ['stand', between(2600, 5200)];
    yield round % 3 ? ['blink', 150] : ['wink', 900];
  }
}
function* working(): Generator<Step> {
  yield ['lift', 520];
  yield ['put', 520];
  for (let round = 1; ; round++) {
    for (let key = 0; key < 14; key++) yield [key % 2 ? 'tap' : 'type', between(120, 210)];
    yield [round % 2 ? 'typeBlink' : 'type', round % 2 ? 160 : 700];
  }
}
function* waiting(): Generator<Step> {
  for (;;) {
    yield ['wave', 650];
    yield ['stand', 650];
  }
}
const timelines = { idle, working, waiting };
const still: Record<ClawdState, ClawdPose> = { idle: 'stand', working: 'type', waiting: 'wave' };

// `pose` holds one pose (the test fixture's gallery).
export default function Clawd({ state, pose: fixed }: { state: ClawdState; pose?: ClawdPose }) {
  const [shownPose, setPose] = useState<ClawdPose>(still[state]);
  const pose = fixed ?? shownPose;
  useEffect(() => {
    if (fixed) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    let timer = 0;
    let steps = timelines[state]();
    const next = () => {
      const [shown, ms] = steps.next().value as Step;
      setPose(shown);
      timer = window.setTimeout(next, ms);
    };
    const start = () => {
      window.clearTimeout(timer);
      steps = timelines[state]();
      if (reduce.matches || document.hidden) setPose(still[state]);
      else next();
    };
    start();
    reduce.addEventListener('change', start);
    document.addEventListener('visibilitychange', start);
    return () => {
      window.clearTimeout(timer);
      reduce.removeEventListener('change', start);
      document.removeEventListener('visibilitychange', start);
    };
  }, [state, fixed]);
  const { cells, tool } = poses[pose];
  const typing = pose === 'type' || pose === 'tap' || pose === 'typeBlink';
  return (
    <svg
      className="clawd"
      data-state={state}
      data-pose={pose}
      viewBox="-8 -3 20 11"
      aria-hidden="true"
      focusable="false"
    >
      {typing && desk}
      {tool}
      {/* Not crispEdges: at fractional screen scales it snaps the two eyes to different widths. */}
      <g>
        {cells.map(([x, y, w, h, fill = body], index) => (
          <rect key={index} x={x} y={y} width={w} height={h} fill={fill} />
        ))}
      </g>
    </svg>
  );
}
