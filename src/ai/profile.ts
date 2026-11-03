import type { PieceKind } from "../core/model";

/**
 * Everything the AI knows about "what a good position looks like".
 *
 * The search engine never reads these fields; it only asks an evaluator for a
 * number. Adding a future enemy personality (berserker, summoner, boss...)
 * means adding a profile here — and, if it needs a new feature, extending
 * `EvaluationFeatures` — never editing the search.
 *
 * All weights below are PROVISIONAL starting values chosen for a first playable
 * opponent. They have not been tuned against play data.
 */
export interface EvaluationProfile {
  readonly id: string;
  /** Fixed search depth in plies. Kept in the profile so difficulty is data, not code. */
  readonly searchDepth: number;
  readonly weights: EvaluationWeights;
}

export interface EvaluationWeights {
  /** Value of a piece standing on the board. */
  readonly material: Record<PieceKind, number>;
  /** Value of a captured piece held in hand, droppable onto any empty square. */
  readonly materialInHand: Record<PieceKind, number>;
  /** Per legal action of advantage. */
  readonly mobility: number;
  /** Per square of attack-coverage advantage. */
  readonly boardControl: number;
  /** Per square of lion-exposure advantage. */
  readonly lionSafety: number;
  /** Per rank of lion try-progress advantage. */
  readonly tryProgress: number;
  /**
   * Side to move can take the other lion. Must dwarf every other term but stay
   * well below the search's terminal scores, so a real win found by the search
   * still ranks higher. Never non-zero in the classic ruleset.
   */
  readonly lionCapture: number;
  /** Side to move can take the other lion, and that HQ survives the damage. */
  readonly lionThreat: number;
  /** Per point of HQ HP advantage (HP battles only). */
  readonly hqHp: number;
}

/**
 * Baseline opponent for the classic ruleset.
 *
 * Material scale: a chick is 100.
 *
 * - `lion: 0` is deliberate, not an oversight. Losing a lion is not a material
 *   loss in this ruleset — it ends the game, and the search scores that as a
 *   terminal win/loss which outranks any evaluation. Giving the lion a material
 *   value would only double-count an outcome the search already sees exactly.
 * - Giraffe slightly over elephant: orthogonal steps reach the far rank and the
 *   lion's escape squares more directly on a 3-wide board.
 * - Hen over both: it keeps a chick's forward push while gaining five directions.
 * - In-hand values sit ~10% above board values: a held piece can be dropped onto
 *   any empty square, so it is a flexible tempo/defence resource. This is the
 *   structural hook for spec item 8 (board vs hand valued separately).
 * - Positional weights are kept far below a chick on purpose. Material decides;
 *   mobility, control, lion safety and try progress only break near-ties.
 * - Per spec item 11 there is no flat "check bonus". Check shows up as lion
 *   exposure, and its real value (restricting the opponent) is what the search
 *   itself measures.
 */
export const standardClassicProfile: EvaluationProfile = {
  id: "standard",
  searchDepth: 4,
  weights: {
    material: { lion: 0, giraffe: 380, elephant: 350, chick: 100, hen: 450 },
    materialInHand: { lion: 0, giraffe: 420, elephant: 385, chick: 110, hen: 495 },
    mobility: 4,
    boardControl: 8,
    lionSafety: 12,
    tryProgress: 15,
    lionCapture: 100_000,
    // HP decides HP battles, so one point is worth a chick.
    // A hanging lion that does not lose the battle is worth its 10 damage.
    lionThreat: 1000,
    hqHp: 100,
  },
};
