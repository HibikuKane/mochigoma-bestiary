import {
  PIECE_KINDS,
  fromIndex,
  isInsideBoard,
  opponentOf,
  toIndex,
  type GameAction,
  type GameState,
  type PieceKind,
  type Player,
} from "../core/model";
import type { PositionAnalysis, Ruleset } from "../core/ruleset";
import type { EvaluationProfile } from "./profile";

/**
 * Raw, weight-free measurements of a position, always from one player's point
 * of view and always as "mine minus theirs" so that a positive number is good
 * for that player.
 *
 * Weights live in the profile; this file must not contain tuning constants.
 * A future enemy personality that cares about something new (HP, key unit
 * alive, token count) adds a field here and a weight there — the search is
 * untouched either way.
 */
export interface EvaluationFeatures {
  readonly boardPieces: Record<PieceKind, number>;
  readonly handPieces: Record<PieceKind, number>;
  /** Legal action count advantage. */
  readonly mobility: number;
  /** Attack-coverage advantage, in squares. */
  readonly boardControl: number;
  /** Lion-exposure advantage: how much safer my lion's zone is than theirs. */
  readonly lionSafety: number;
  /** Try-progress advantage, in ranks. */
  readonly tryProgress: number;
  /**
   * +1 when the perspective is to move and can capture the rival lion, -1 when
   * the rival is to move and can capture mine, otherwise 0.
   *
   * The classic ruleset never lets a move leave the mover's lion attacked, so
   * this is always 0 there. Rulesets that allow such moves (roguelike) need it:
   * without it, a move at the search horizon that hangs the lion looks no
   * worse than any other.
   *
   * Only counted when the capture would decide the battle: always without
   * HQs, and with HQs only when the victim's HP cannot survive the lion
   * capture damage. Otherwise the same situation is a `lionThreat`.
   */
  readonly lionCapture: number;
  /** Same sign rules as `lionCapture`, for a lion capture the victim's HQ survives. */
  readonly lionThreat: number;
  /** My HQ HP minus the rival's, or 0 when the battle has no HQs. */
  readonly hqHp: number;
}

/** Per-term contributions, for debugging and for balancing profiles later. */
export interface EvaluationBreakdown {
  readonly material: number;
  readonly mobility: number;
  readonly boardControl: number;
  readonly lionSafety: number;
  readonly tryProgress: number;
  readonly lionCapture: number;
  readonly lionThreat: number;
  readonly hqHp: number;
  readonly total: number;
  readonly features: EvaluationFeatures;
}

export interface Evaluator {
  readonly profile: EvaluationProfile;
  extractFeatures(state: GameState, perspective: Player): EvaluationFeatures;
  evaluate(state: GameState, perspective: Player): number;
  explain(state: GameState, perspective: Player): EvaluationBreakdown;
  /** Search-order hint only; never part of the score. */
  orderingScore(state: GameState, action: GameAction): number;
}

function emptyCounts(): Record<PieceKind, number> {
  return { lion: 0, giraffe: 0, elephant: 0, chick: 0, hen: 0 };
}

/** Squares around the lion, used as a generic "danger zone" for safety scoring.
 *  This is a heuristic neighbourhood, not a movement rule: legality still comes
 *  from the ruleset alone. */
function lionZone(square: number): ReadonlyArray<number> {
  const origin = fromIndex(square);
  const zone: number[] = [];
  for (let row = -1; row <= 1; row += 1) {
    for (let column = -1; column <= 1; column += 1) {
      const target = { row: origin.row + row, column: origin.column + column };
      if (isInsideBoard(target)) zone.push(toIndex(target));
    }
  }
  return zone;
}

function exposure(zone: ReadonlyArray<number>, attacked: ReadonlySet<number>): number {
  return zone.reduce((total, square) => total + (attacked.has(square) ? 1 : 0), 0);
}

/** Ranks the lion still has to cross to reach a try, or null with no lion. */
function tryDistance(analysis: PositionAnalysis, state: GameState, player: Player): number | null {
  const square = analysis.lionSquare(state.board, player);
  if (square === null) return null;
  return Math.abs(fromIndex(square).row - analysis.tryRank(player));
}

/** Legal actions for a side that is not necessarily to move. The ruleset is
 *  still the only source of legality; we only ask it a hypothetical question,
 *  and never hand the rewritten state back to the game. */
function actionCount(ruleset: Ruleset, state: GameState, player: Player): number {
  if (state.turn === player) return ruleset.legalActions(state).length;
  return ruleset.legalActions({ ...state, turn: player }).length;
}

export function createEvaluator(ruleset: Ruleset, profile: EvaluationProfile): Evaluator {
  const analysis = ruleset.analysis;
  const { weights } = profile;

  function extractFeatures(state: GameState, perspective: Player): EvaluationFeatures {
    const rival = opponentOf(perspective);
    const boardPieces = emptyCounts();
    const handPieces = emptyCounts();

    state.board.forEach((candidate) => {
      if (!candidate) return;
      boardPieces[candidate.kind] += candidate.owner === perspective ? 1 : -1;
    });
    state.hands[perspective].forEach((candidate) => { handPieces[candidate.kind] += 1; });
    state.hands[rival].forEach((candidate) => { handPieces[candidate.kind] -= 1; });

    const mobility = actionCount(ruleset, state, perspective) - actionCount(ruleset, state, rival);
    const hqHp = state.hq ? state.hq[perspective].hp - state.hq[rival].hp : 0;

    if (!analysis) {
      return {
        boardPieces, handPieces, mobility, boardControl: 0, lionSafety: 0, tryProgress: 0,
        lionCapture: 0, lionThreat: 0, hqHp,
      };
    }

    const mineAttacks = analysis.attackedSquares(state.board, perspective);
    const rivalAttacks = analysis.attackedSquares(state.board, rival);
    const boardControl = mineAttacks.size - rivalAttacks.size;

    const myLion = analysis.lionSquare(state.board, perspective);
    const rivalLion = analysis.lionSquare(state.board, rival);
    const myExposure = myLion === null ? 0 : exposure(lionZone(myLion), rivalAttacks);
    const rivalExposure = rivalLion === null ? 0 : exposure(lionZone(rivalLion), mineAttacks);
    const lionSafety = rivalExposure - myExposure;

    const myDistance = tryDistance(analysis, state, perspective);
    const rivalDistance = tryDistance(analysis, state, rival);
    const tryProgress =
      myDistance === null || rivalDistance === null ? 0 : rivalDistance - myDistance;

    // Only the side to move can take a lion now; a stunned lion cannot be taken.
    const takeable = (lion: number | null, attackers: ReadonlySet<number>) =>
      lion !== null && attackers.has(lion) && !state.board[lion]?.stunned;
    const decisive = (victim: Player) =>
      !state.hq || analysis.lionCaptureDamage === undefined || state.hq[victim].hp <= analysis.lionCaptureDamage;
    let lionCapture = 0;
    let lionThreat = 0;
    if (state.turn === perspective && takeable(rivalLion, mineAttacks)) {
      if (decisive(rival)) lionCapture = 1; else lionThreat = 1;
    } else if (state.turn === rival && takeable(myLion, rivalAttacks)) {
      if (decisive(perspective)) lionCapture = -1; else lionThreat = -1;
    }

    return {
      boardPieces, handPieces, mobility, boardControl, lionSafety, tryProgress, lionCapture, lionThreat, hqHp,
    };
  }

  function explain(state: GameState, perspective: Player): EvaluationBreakdown {
    const features = extractFeatures(state, perspective);
    const material = PIECE_KINDS.reduce(
      (total, kind) =>
        total +
        features.boardPieces[kind] * weights.material[kind] +
        features.handPieces[kind] * weights.materialInHand[kind],
      0,
    );
    const mobility = features.mobility * weights.mobility;
    const boardControl = features.boardControl * weights.boardControl;
    const lionSafety = features.lionSafety * weights.lionSafety;
    const tryProgress = features.tryProgress * weights.tryProgress;
    const lionCapture = features.lionCapture * weights.lionCapture;
    const lionThreat = features.lionThreat * weights.lionThreat;
    const hqHp = features.hqHp * weights.hqHp;
    return {
      material, mobility, boardControl, lionSafety, tryProgress, lionCapture, lionThreat, hqHp,
      total: material + mobility + boardControl + lionSafety + tryProgress + lionCapture + lionThreat + hqHp,
      features,
    };
  }

  return {
    profile,
    extractFeatures,
    explain,
    evaluate: (state, perspective) => explain(state, perspective).total,
    orderingScore: (state, action) => {
      if (action.type !== "move") return 0;
      const victim = state.board[toIndex(action.to)];
      if (!victim) return 0;
      // A lion capture ends the game; rank it above every other capture.
      return victim.kind === "lion" ? Number.MAX_SAFE_INTEGER : weights.material[victim.kind];
    },
  };
}
