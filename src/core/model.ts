export const BOARD_ROWS = 4;
export const BOARD_COLUMNS = 3;

export type Player = "north" | "south";
export type PieceKind = "lion" | "giraffe" | "elephant" | "chick" | "hen";

export const PIECE_KINDS: ReadonlyArray<PieceKind> = ["lion", "giraffe", "elephant", "chick", "hen"];

/** A one-square step as seen by south: row -1 is forward, column +1 is right. */
export type StepVector = readonly [row: number, column: number];

export interface Piece {
  readonly id: string;
  readonly kind: PieceKind;
  readonly owner: Player;
  /**
   * The fields below are used by the roguelike ruleset only; the classic
   * ruleset ignores them. A missing field means "none" / 0.
   */
  /** Extra steps gained permanently (e.g. from fusion), as seen by south. */
  readonly extraSteps?: ReadonlyArray<StepVector>;
  /** ATK gained permanently for the run (e.g. from fusion). */
  readonly fusionAtk?: number;
  /** ATK gained for the current battle only; cleared when the piece is captured. */
  readonly combatAtk?: number;
  /** A respawned lion: cannot move and cannot be captured until its owner's turn ends. */
  readonly stunned?: boolean;
}

export interface Position {
  readonly row: number;
  readonly column: number;
}

export type Board = ReadonlyArray<Piece | null>;

export interface Hands {
  readonly north: ReadonlyArray<Piece>;
  readonly south: ReadonlyArray<Piece>;
}

export type WinReason = "capture" | "try" | "no-actions" | "hp";

export type GameResult =
  | { readonly type: "playing" }
  | { readonly type: "win"; readonly winner: Player; readonly reason: WinReason }
  | { readonly type: "draw"; readonly reason: "repetition" };

export type GameEvent =
  | { readonly type: "start"; readonly player: Player }
  | ({ readonly type: "move"; readonly player: Player; readonly piece: PieceKind; readonly captured: PieceKind | null; readonly promoted: boolean } & HqEffects)
  | ({ readonly type: "drop"; readonly player: Player; readonly piece: PieceKind } & HqEffects)
  | Exclude<GameResult, { readonly type: "playing" }>;

/** HQ effects of one action, reported with the move or drop (roguelike only). */
export interface HqEffects {
  /** Damage the acting side dealt to the opposing HQ. */
  readonly damage?: number;
  /** The opposing lion was captured and returned to its back rank, stunned. */
  readonly respawned?: boolean;
  /** Damage the next side's lion dealt at its turn start for holding the far rank. */
  readonly tryDamage?: number;
}

export interface Hq {
  readonly hp: number;
  readonly maxHp: number;
}

export interface GameState {
  readonly board: Board;
  readonly hands: Hands;
  readonly turn: Player;
  readonly result: GameResult;
  readonly history: ReadonlyArray<string>;
  readonly moveNumber: number;
  readonly lastEvent: GameEvent;
  /**
   * Roguelike only: each side's HQ. When present, battles are decided by HQ HP
   * instead of an immediate lion capture or try (docs/roguelike-spec.md §4.3).
   */
  readonly hq?: Readonly<Record<Player, Hq>>;
  /** Roguelike only: state of the seeded random source (spec §3). */
  readonly rng?: number;
}

export type Selection =
  | { readonly type: "board"; readonly position: Position }
  | { readonly type: "hand"; readonly player: Player; readonly index: number };

export type GameAction =
  | { readonly type: "move"; readonly from: Position; readonly to: Position }
  | { readonly type: "drop"; readonly player: Player; readonly handIndex: number; readonly to: Position };

export function opponentOf(player: Player): Player {
  return player === "south" ? "north" : "south";
}

export function toIndex(position: Position): number {
  return position.row * BOARD_COLUMNS + position.column;
}

export function fromIndex(index: number): Position {
  return {
    row: Math.floor(index / BOARD_COLUMNS),
    column: index % BOARD_COLUMNS,
  };
}

export function isInsideBoard(position: Position): boolean {
  return (
    position.row >= 0 &&
    position.row < BOARD_ROWS &&
    position.column >= 0 &&
    position.column < BOARD_COLUMNS
  );
}

export function samePosition(left: Position, right: Position): boolean {
  return left.row === right.row && left.column === right.column;
}
