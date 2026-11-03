import {
  BOARD_COLUMNS,
  BOARD_ROWS,
  fromIndex,
  isInsideBoard,
  opponentOf,
  samePosition,
  toIndex,
  type Board,
  type GameAction,
  type GameState,
  type Hands,
  type Hq,
  type Piece,
  type Player,
  type Position,
} from "../core/model";
import type { PositionAnalysis, Ruleset } from "../core/ruleset";
import { boardSteps, capturedForm, effectiveAtk, isOneSquareStep, pieceSignature } from "./pieceData";

/**
 * Roguelike ruleset, phase P1 (docs/roadmap.md): the skeleton the run and the
 * HP/fusion/event phases build on.
 *
 * What differs from classic in P1:
 * - Movement comes from piece data (kind steps + per-piece extra steps).
 * - Self-endangering moves are legal (spec §4.1, B-4).
 * - A battle can start from any setup, so the sides may have different pieces.
 * - Captures keep permanent piece data and drop this-battle data (spec §4.2).
 *
 * P3 adds HQ HP (spec §4.3). A setup with `hq` is decided by HQ HP: captures
 * deal damage, a captured lion returns stunned to its back rank, and a lion
 * holding the far rank deals damage at each of its owner's turn starts. A setup
 * without `hq` keeps the P1/P2 win conditions (lion capture, safe try), which
 * the tests use to compare against the classic baseline.
 *
 * In both modes: no legal action loses, and threefold repetition draws.
 */

/** HQ damage for capturing a lion (spec §4.3, C-1). */
export const LION_CAPTURE_DAMAGE = 10;
/** HQ damage per turn start while a lion holds the far rank (spec §4.3, C-2). */
export const TRY_DAMAGE = 5;
/** Back-rank columns a captured lion returns to, in order (spec §4.3, provisional). */
const RESPAWN_COLUMNS: ReadonlyArray<number> = [1, 0, 2];

type Hqs = Readonly<Record<Player, Hq>>;

/** Starting position of one battle. Ids must already be unique and deterministic. */
export interface BattleSetup {
  /** Row-major, BOARD_ROWS × BOARD_COLUMNS. */
  readonly board: ReadonlyArray<Piece | null>;
  readonly hands: Hands;
  /** Defaults to south, the player's side in a run. */
  readonly firstPlayer?: Player;
  /** HQs for an HP battle (P3). Omit for lion-capture battles. */
  readonly hq?: Hqs;
  /** Seed for the battle's random source, e.g. a lion's fallback respawn square. */
  readonly seed?: number;
}

function farRank(player: Player): number {
  return player === "south" ? 0 : BOARD_ROWS - 1;
}

/**
 * Squares the attacker could move onto on its turn. A stunned piece is left
 * out. That is exact on its owner's turn; on the captor's turn the stun ends
 * before the owner moves again, so evaluation heuristics that read this then
 * slightly underrate the stunned lion. Legality never relies on it.
 */
function attackedSquares(board: Board, attacker: Player): ReadonlySet<number> {
  const squares = new Set<number>();
  board.forEach((candidate, index) => {
    if (!candidate || candidate.owner !== attacker || candidate.stunned) return;
    const origin = fromIndex(index);
    boardSteps(candidate).forEach(([row, column]) => {
      const target = { row: origin.row + row, column: origin.column + column };
      if (isInsideBoard(target)) squares.add(toIndex(target));
    });
  });
  return squares;
}

function lionSquare(board: Board, owner: Player): number | null {
  const index = board.findIndex((candidate) => candidate?.owner === owner && candidate.kind === "lion");
  return index < 0 ? null : index;
}

export const roguelikeAnalysis: PositionAnalysis = {
  attackedSquares,
  lionSquare,
  tryRank: farRank,
  lionCaptureDamage: LION_CAPTURE_DAMAGE,
};

export function roguelikePositionKey(state: Pick<GameState, "board" | "hands" | "turn" | "hq">): string {
  const board = state.board.map((candidate) => (candidate ? pieceSignature(candidate) : "_")).join("|");
  const hand = (player: Player) => state.hands[player].map(pieceSignature).sort().join(",");
  const hp = state.hq ? `#hp=${state.hq.north.hp},${state.hq.south.hp}` : "";
  return `${board}#n=${hand("north")}#s=${hand("south")}#turn=${state.turn}${hp}`;
}

function isActionEqual(left: GameAction, right: GameAction): boolean {
  if (left.type === "move" && right.type === "move") {
    return samePosition(left.from, right.from) && samePosition(left.to, right.to);
  }
  if (left.type === "drop" && right.type === "drop") {
    return left.player === right.player && left.handIndex === right.handIndex && samePosition(left.to, right.to);
  }
  return false;
}

function actionsFor(state: GameState, player: Player): ReadonlyArray<GameAction> {
  const actions: GameAction[] = [];
  state.board.forEach((candidate, index) => {
    // A stunned lion cannot move (spec §4.3, B-5).
    if (!candidate || candidate.owner !== player || candidate.stunned) return;
    const from = fromIndex(index);
    boardSteps(candidate).forEach(([row, column]) => {
      const to = { row: from.row + row, column: from.column + column };
      if (!isInsideBoard(to)) return;
      const target = state.board[toIndex(to)];
      if (target?.owner === player) return;
      // ...and cannot be captured while stunned (spec §4.3, H-5 provisional).
      if (target?.stunned) return;
      actions.push({ type: "move", from, to });
    });
  });
  state.hands[player].forEach((_candidate, handIndex) => {
    state.board.forEach((target, index) => {
      if (!target) actions.push({ type: "drop", player, handIndex, to: fromIndex(index) });
    });
  });
  return actions;
}

function legalActions(state: GameState): ReadonlyArray<GameAction> {
  if (state.result.type !== "playing") return [];
  return actionsFor(state, state.turn);
}

function validateSetup(setup: BattleSetup): void {
  if (setup.board.length !== BOARD_ROWS * BOARD_COLUMNS) {
    throw new Error(`A battle board needs ${BOARD_ROWS * BOARD_COLUMNS} squares.`);
  }
  for (const player of ["north", "south"] as const) {
    const lions = setup.board.filter((candidate) => candidate?.owner === player && candidate.kind === "lion");
    if (lions.length !== 1) throw new Error(`${player} needs exactly one lion on the board.`);
    // A hand only ever holds demoted, non-lion pieces of its owner (spec §4.2).
    if (setup.hands[player].some((candidate) =>
      candidate.kind === "lion" || candidate.kind === "hen" || candidate.owner !== player)) {
      throw new Error(`${player}'s hand may only hold its own unpromoted non-lion pieces.`);
    }
  }
  const pieces = [...setup.board.filter((candidate): candidate is Piece => candidate !== null),
    ...setup.hands.north, ...setup.hands.south];
  if (pieces.some((candidate) => candidate.extraSteps?.some((step) => !isOneSquareStep(step)))) {
    throw new Error("Extra steps must be one-square steps.");
  }
  if (pieces.some((candidate) => candidate.stunned)) throw new Error("A battle cannot start with a stunned piece.");
  const ids = pieces.map((candidate) => candidate.id);
  if (new Set(ids).size !== ids.length) throw new Error("Piece ids must be unique within a battle.");
  if (setup.hq) {
    for (const player of ["north", "south"] as const) {
      const { hp, maxHp } = setup.hq[player];
      if (!Number.isInteger(hp) || !Number.isInteger(maxHp) || hp <= 0 || hp > maxHp) {
        throw new Error(`${player}'s HQ needs whole-number HP between 1 and its maximum.`);
      }
    }
  }
}

function createState(setup: BattleSetup): GameState {
  const turn = setup.firstPlayer ?? "south";
  const state: GameState = {
    board: [...setup.board],
    hands: { north: [...setup.hands.north], south: [...setup.hands.south] },
    turn,
    result: { type: "playing" },
    history: [],
    moveNumber: 1,
    lastEvent: { type: "start", player: turn },
    ...(setup.hq
      ? { hq: { north: { ...setup.hq.north }, south: { ...setup.hq.south } }, rng: (setup.seed ?? 1) >>> 0 }
      : {}),
  };
  return { ...state, history: [roguelikePositionKey(state)] };
}

/** One step of the battle's seeded random source (mulberry32): [value in [0,1), next state]. */
function nextRandom(rng: number): readonly [number, number] {
  const next = (rng + 0x6d2b79f5) >>> 0;
  let value = Math.imul(next ^ (next >>> 15), 1 | next);
  value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
  return [((value ^ (value >>> 14)) >>> 0) / 4294967296, next];
}

function damageHq(hq: Hqs, target: Player, amount: number): Hqs {
  return { ...hq, [target]: { ...hq[target], hp: Math.max(0, hq[target].hp - amount) } };
}

/**
 * Where a captured lion returns (spec §4.3): its back rank, middle then left
 * then right; otherwise a seeded random empty square that is not the owner's
 * far rank (provisional, so a respawn never starts a try); otherwise any empty
 * square. Null when the board is full.
 */
function respawnSquare(board: Board, owner: Player, rng: number): { index: number; rng: number } | null {
  const backRow = owner === "north" ? 0 : BOARD_ROWS - 1;
  for (const column of RESPAWN_COLUMNS) {
    const index = toIndex({ row: backRow, column });
    if (!board[index]) return { index, rng };
  }
  const empty = board.flatMap((candidate, index) => (candidate ? [] : [index]));
  const preferred = empty.filter((index) => fromIndex(index).row !== farRank(owner));
  const pool = preferred.length > 0 ? preferred : empty;
  if (pool.length === 0) return null;
  const [value, next] = nextRandom(rng);
  return { index: pool[Math.floor(value * pool.length)], rng: next };
}

function withoutStun(piece: Piece): Piece {
  const { stunned: _cleared, ...rest } = piece;
  return rest;
}

function execute(state: GameState, action: GameAction): GameState {
  const board = [...state.board];
  const hands = { north: [...state.hands.north], south: [...state.hands.south] };

  if (action.type === "drop") {
    const dropped = hands[action.player][action.handIndex];
    board[toIndex(action.to)] = dropped;
    hands[action.player].splice(action.handIndex, 1);
    return { ...state, board, hands, lastEvent: { type: "drop", player: dropped.owner, piece: dropped.kind } };
  }

  const from = toIndex(action.from);
  const to = toIndex(action.to);
  const moving = board[from]!;
  const captured = board[to];
  // A captured lion ends the battle in P1, so it never reaches a hand.
  if (captured && captured.kind !== "lion") hands[moving.owner].push(capturedForm(captured, moving.owner));

  const promotes = moving.kind === "chick" && action.to.row === farRank(moving.owner);
  board[from] = null;
  board[to] = promotes ? { ...moving, kind: "hen" } : moving;
  return {
    ...state,
    board,
    hands,
    lastEvent: {
      type: "move", player: moving.owner, piece: moving.kind,
      captured: captured?.kind ?? null, promoted: promotes,
    },
  };
}

function isSquareAttacked(board: Board, square: Position, attacker: Player): boolean {
  return attackedSquares(board, attacker).has(toIndex(square));
}

function applyAction(state: GameState, action: GameAction): GameState {
  if (!legalActions(state).some((candidate) => isActionEqual(candidate, action))) return state;
  return state.hq ? applyHpAction(state, action, state.hq) : applyLionCaptureAction(state, action);
}

/** Ends the turn: hands it over, then checks no-action and repetition (both modes). */
function passTurn(state: GameState, moved: GameState): GameState {
  const player = state.turn;
  const advanced: GameState = { ...moved, turn: opponentOf(player), moveNumber: state.moveNumber + 1 };
  const key = roguelikePositionKey(advanced);
  const history = [...state.history, key];

  if (actionsFor(advanced, advanced.turn).length === 0) {
    const result = { type: "win", winner: player, reason: "no-actions" } as const;
    return { ...advanced, history, result, lastEvent: result };
  }
  if (history.filter((candidate) => candidate === key).length >= 3) {
    const result = { type: "draw", reason: "repetition" } as const;
    return { ...advanced, history, result, lastEvent: result };
  }
  return { ...advanced, history };
}

type WinResult = Extract<GameState["result"], { type: "win" }>;

function ended(moved: GameState, board: Board, hq: Hqs, rng: number, result: WinResult): GameState {
  return { ...moved, board, hq, rng, result, lastEvent: result };
}

/** HP battle (P3, spec §4.3). */
function applyHpAction(state: GameState, action: GameAction, startHq: Hqs): GameState {
  const player = state.turn;
  const rival = opponentOf(player);
  const moving = action.type === "move" ? state.board[toIndex(action.from)]! : state.hands[player][action.handIndex];
  const captured = action.type === "move" ? state.board[toIndex(action.to)] : null;
  const moved = execute(state, action);
  const board = [...moved.board];
  let hq = startHq;
  let rng = state.rng ?? 1;
  const effects: { damage?: number; respawned?: boolean; tryDamage?: number } = {};

  // A lion this side captured last turn has now sat out its owner's turn and
  // stayed untouchable through this one, so its stun ends here. Ending it
  // after the owner's own turn instead would let the captor take it again at
  // once, which the stun exists to prevent (spec §4.3, H-5).
  board.forEach((candidate, index) => {
    if (candidate?.owner === rival && candidate.stunned) board[index] = withoutStun(candidate);
  });

  if (captured) {
    // A capture deals the predator's ATK; a lion capture deals a fixed amount
    // (C-3, C-1). ATK is read before any promotion this move causes.
    effects.damage = captured.kind === "lion" ? LION_CAPTURE_DAMAGE : effectiveAtk(moving);
    hq = damageHq(hq, rival, effects.damage);
    if (hq[rival].hp <= 0) return ended(moved, board, hq, rng, { type: "win", winner: player, reason: "hp" });
  }

  if (captured?.kind === "lion") {
    const square = respawnSquare(board, rival, rng);
    // A capture always empties the captor's origin square, so this cannot
    // happen; kept as a guard: with no empty square the lion is lost.
    if (!square) return ended(moved, board, hq, rng, { type: "win", winner: player, reason: "capture" });
    const { combatAtk: _discarded, ...lion } = captured;
    board[square.index] = { ...lion, stunned: true };
    rng = square.rng;
    effects.respawned = true;
  }

  // The rival's turn starts: its lion holding the far rank damages us (C-2).
  const rivalLion = lionSquare(board, rival);
  if (rivalLion !== null && fromIndex(rivalLion).row === farRank(rival) && !board[rivalLion]!.stunned) {
    effects.tryDamage = TRY_DAMAGE;
    hq = damageHq(hq, player, TRY_DAMAGE);
    if (hq[player].hp <= 0) {
      const over = ended(moved, board, hq, rng, { type: "win", winner: rival, reason: "hp" });
      return { ...over, turn: rival, moveNumber: state.moveNumber + 1 };
    }
  }

  const lastEvent = { ...moved.lastEvent, ...effects } as GameState["lastEvent"];
  return passTurn(state, { ...moved, board, hq, rng, lastEvent });
}

/** Lion-capture battle (P1/P2 win conditions, spec §4.1). */
function applyLionCaptureAction(state: GameState, action: GameAction): GameState {
  const player = state.turn;
  const moving = action.type === "move" ? state.board[toIndex(action.from)] : null;
  const captured = action.type === "move" ? state.board[toIndex(action.to)] : null;
  const moved = execute(state, action);

  if (captured?.kind === "lion") {
    const result = { type: "win", winner: player, reason: "capture" } as const;
    return { ...moved, result, lastEvent: result };
  }
  if (
    moving?.kind === "lion" &&
    action.to.row === farRank(player) &&
    !isSquareAttacked(moved.board, action.to, opponentOf(player))
  ) {
    const result = { type: "win", winner: player, reason: "try" } as const;
    return { ...moved, result, lastEvent: result };
  }
  return passTurn(state, moved);
}

/** One ruleset per battle, because each battle starts from its own setup. */
export function createRoguelikeRuleset(input: BattleSetup): Ruleset {
  // Copy before validating so later changes to the caller's arrays cannot
  // produce an initial state that skipped validation.
  const setup: BattleSetup = {
    board: [...input.board],
    hands: { north: [...input.hands.north], south: [...input.hands.south] },
    firstPlayer: input.firstPlayer,
    hq: input.hq ? { north: { ...input.hq.north }, south: { ...input.hq.south } } : undefined,
    seed: input.seed,
  };
  validateSetup(setup);
  return {
    id: "roguelike",
    name: "Roguelike",
    summary: "로그라이크 전투 규칙. 데이터 기반 기물, 자살수 허용, 비대칭 시작 배치, 본진 HP.",
    analysis: roguelikeAnalysis,
    createInitialState: () => createState(setup),
    legalActions,
    applyAction,
  };
}

/** The original 4-against-4 position, as a roguelike setup. Useful as a reference battle. */
export function originalSetup(): BattleSetup {
  const board: Array<Piece | null> = Array(BOARD_ROWS * BOARD_COLUMNS).fill(null);
  const place = (row: number, column: number, piece: Piece) => { board[toIndex({ row, column })] = piece; };
  place(0, 0, { id: "n-elephant", kind: "elephant", owner: "north" });
  place(0, 1, { id: "n-lion", kind: "lion", owner: "north" });
  place(0, 2, { id: "n-giraffe", kind: "giraffe", owner: "north" });
  place(1, 1, { id: "n-chick", kind: "chick", owner: "north" });
  place(2, 1, { id: "s-chick", kind: "chick", owner: "south" });
  place(3, 0, { id: "s-giraffe", kind: "giraffe", owner: "south" });
  place(3, 1, { id: "s-lion", kind: "lion", owner: "south" });
  place(3, 2, { id: "s-elephant", kind: "elephant", owner: "south" });
  return { board, hands: { north: [], south: [] } };
}
