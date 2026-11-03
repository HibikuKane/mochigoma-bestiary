import type { Board, GameAction, GameState, Player } from "./model";

/**
 * Read-only position queries a ruleset can expose so that non-rule code
 * (evaluation heuristics, hints, analysis UI) never re-derives movement rules.
 * Everything here is derivable from `legalActions`, but only at a cost that
 * makes per-node evaluation impractical.
 */
export interface PositionAnalysis {
  /** Board indices the player could capture into on their own turn, occupied or not. */
  attackedSquares(board: Board, attacker: Player): ReadonlySet<number>;
  /** Board index of the player's lion, or null when it is no longer on the board. */
  lionSquare(board: Board, owner: Player): number | null;
  /** Row the player's lion must reach for a try. */
  tryRank(player: Player): number;
  /**
   * HQ damage for capturing a lion, for rulesets where that does not end the
   * battle outright. Absent means a lion capture is decisive.
   */
  readonly lionCaptureDamage?: number;
}

export interface Ruleset {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  /** Optional: rulesets without it can still be played, just not evaluated positionally. */
  readonly analysis?: PositionAnalysis;
  createInitialState(): GameState;
  legalActions(state: GameState): ReadonlyArray<GameAction>;
  applyAction(state: GameState, action: GameAction): GameState;
}
