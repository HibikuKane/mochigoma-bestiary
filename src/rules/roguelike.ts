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
  type Piece,
  type Player,
  type Position,
} from "../core/model";
import type { PositionAnalysis, Ruleset } from "../core/ruleset";
import { boardSteps, capturedForm, pieceSignature } from "./pieceData";

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
 * Win conditions stay classic (lion capture, safe try, no actions, threefold
 * repetition) until P3 replaces them with HQ HP.
 */

/** Starting position of one battle. Ids must already be unique and deterministic. */
export interface BattleSetup {
  /** Row-major, BOARD_ROWS × BOARD_COLUMNS. */
  readonly board: ReadonlyArray<Piece | null>;
  readonly hands: Hands;
  /** Defaults to south, the player's side in a run. */
  readonly firstPlayer?: Player;
}

function farRank(player: Player): number {
  return player === "south" ? 0 : BOARD_ROWS - 1;
}

function attackedSquares(board: Board, attacker: Player): ReadonlySet<number> {
  const squares = new Set<number>();
  board.forEach((candidate, index) => {
    if (!candidate || candidate.owner !== attacker) return;
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
};

export function roguelikePositionKey(state: Pick<GameState, "board" | "hands" | "turn">): string {
  const board = state.board.map((candidate) => (candidate ? pieceSignature(candidate) : "_")).join("|");
  const hand = (player: Player) => state.hands[player].map(pieceSignature).sort().join(",");
  return `${board}#n=${hand("north")}#s=${hand("south")}#turn=${state.turn}`;
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
    if (!candidate || candidate.owner !== player) return;
    const from = fromIndex(index);
    boardSteps(candidate).forEach(([row, column]) => {
      const to = { row: from.row + row, column: from.column + column };
      if (!isInsideBoard(to)) return;
      if (state.board[toIndex(to)]?.owner === player) return;
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
    if (setup.hands[player].some((candidate) => candidate.kind === "lion" || candidate.owner !== player)) {
      throw new Error(`${player}'s hand may only hold its own non-lion pieces.`);
    }
  }
  const ids = [...setup.board.filter((candidate): candidate is Piece => candidate !== null),
    ...setup.hands.north, ...setup.hands.south].map((candidate) => candidate.id);
  if (new Set(ids).size !== ids.length) throw new Error("Piece ids must be unique within a battle.");
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
  };
  return { ...state, history: [roguelikePositionKey(state)] };
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

/** One ruleset per battle, because each battle starts from its own setup. */
export function createRoguelikeRuleset(setup: BattleSetup): Ruleset {
  validateSetup(setup);
  return {
    id: "roguelike",
    name: "Roguelike",
    summary: "로그라이크 전투 규칙. 데이터 기반 기물, 자살수 허용, 비대칭 시작 배치.",
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
