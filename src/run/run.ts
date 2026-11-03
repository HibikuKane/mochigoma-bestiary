import {
  BOARD_COLUMNS, BOARD_ROWS, toIndex,
  type GameResult, type Piece, type PieceKind, type StepVector,
} from "../core/model";
import type { BattleSetup } from "../rules/roguelike";
import { PLAYER_HP, REWARD_KINDS, STAGES, type StageDefinition } from "./stages";

/**
 * Run state: everything that outlives a single battle (spec §5).
 *
 * It is deliberately separate from the battle's `GameState`. A battle only
 * ever reads the roster to build its setup and never writes back, which is
 * what makes run pieces come back after a battle no matter what happened to
 * them on the board (spec §4.2, H-3).
 */
export interface RosterPiece {
  readonly id: string;
  readonly kind: PieceKind;
  readonly extraSteps?: ReadonlyArray<StepVector>;
  readonly fusionAtk?: number;
}

export type RunPhase = "battle" | "reward" | "victory" | "defeat";

export interface RunState {
  /** Seeds the AI for every battle, so a run can be replayed exactly. */
  readonly seed: number;
  readonly stages: ReadonlyArray<StageDefinition>;
  readonly stageIndex: number;
  readonly phase: RunPhase;
  readonly roster: ReadonlyArray<RosterPiece>;
  /** Choices on offer while `phase` is "reward". */
  readonly rewardOptions: ReadonlyArray<PieceKind>;
  readonly rewardHistory: ReadonlyArray<PieceKind>;
  /** How the run ended, while `phase` is "defeat". */
  readonly defeat: "loss" | "draw" | null;
  /** Next number for a deterministic roster id. */
  readonly nextPieceNumber: number;
  /** Player HQ HP at the start of each battle. */
  readonly playerMaxHp: number;
}

/** Original starting set and squares for the player (spec §5, provisional). */
const PLAYER_SLOTS: ReadonlyArray<{ row: number; column: number; kind: PieceKind }> = [
  { row: 3, column: 0, kind: "giraffe" },
  { row: 3, column: 1, kind: "lion" },
  { row: 3, column: 2, kind: "elephant" },
  { row: 2, column: 1, kind: "chick" },
];

export function startRun(
  seed: number,
  stages: ReadonlyArray<StageDefinition> = STAGES,
  playerMaxHp: number = PLAYER_HP,
): RunState {
  if (stages.length === 0) throw new Error("A run needs at least one stage.");
  const roster = PLAYER_SLOTS.map((slot, index) => ({ id: `r${index + 1}`, kind: slot.kind }));
  return {
    seed, stages, stageIndex: 0, phase: "battle", roster,
    rewardOptions: [], rewardHistory: [], defeat: null, nextPieceNumber: roster.length + 1, playerMaxHp,
  };
}

export function currentStage(run: RunState): StageDefinition {
  return run.stages[run.stageIndex];
}

function toPlayerPiece(piece: RosterPiece): Piece {
  return { ...piece, owner: "south" };
}

/**
 * The setup for the current battle: one roster piece of each original kind on
 * its original square, everything else in hand (spec §5, provisional).
 */
export function battleSetup(run: RunState): BattleSetup {
  const board: Array<Piece | null> = Array(BOARD_ROWS * BOARD_COLUMNS).fill(null);
  const placed = new Set<string>();
  for (const slot of PLAYER_SLOTS) {
    const piece = run.roster.find((candidate) => candidate.kind === slot.kind && !placed.has(candidate.id));
    if (!piece) continue;
    placed.add(piece.id);
    board[toIndex(slot)] = toPlayerPiece(piece);
  }
  const southHand = run.roster.filter((piece) => !placed.has(piece.id)).map(toPlayerPiece);

  const stage = currentStage(run);
  stage.enemyBoard.forEach((placement, index) => {
    board[toIndex(placement)] = { id: `e${run.stageIndex + 1}-${index + 1}`, kind: placement.kind, owner: "north" };
  });
  const northHand = stage.enemyHand.map((kind, index): Piece => ({
    id: `e${run.stageIndex + 1}-h${index + 1}`, kind, owner: "north",
  }));

  return {
    board,
    hands: { north: northHand, south: southHand },
    firstPlayer: "south",
    // Every battle starts both HQs at full HP (spec §4.3, provisional).
    hq: {
      north: { hp: stage.enemyHp, maxHp: stage.enemyHp },
      south: { hp: run.playerMaxHp, maxHp: run.playerMaxHp },
    },
    seed: (run.seed + run.stageIndex * 7919) >>> 0,
  };
}

/**
 * Applies a finished battle's result. The player is south. A loss ends the
 * run, and so does a draw (spec §4.1, H-8 provisional: a draw is a loss).
 */
export function finishBattle(run: RunState, result: GameResult): RunState {
  if (run.phase !== "battle" || result.type === "playing") return run;
  if (result.type === "draw") return { ...run, phase: "defeat", defeat: "draw" };
  if (result.winner !== "south") return { ...run, phase: "defeat", defeat: "loss" };
  if (run.stageIndex === run.stages.length - 1) return { ...run, phase: "victory" };
  return { ...run, phase: "reward", rewardOptions: REWARD_KINDS };
}

/** Adds the chosen reward to the roster permanently and moves on to the next battle. */
export function chooseReward(run: RunState, optionIndex: number): RunState {
  const kind = run.rewardOptions[optionIndex];
  if (run.phase !== "reward" || !kind) return run;
  return {
    ...run,
    phase: "battle",
    stageIndex: run.stageIndex + 1,
    roster: [...run.roster, { id: `r${run.nextPieceNumber}`, kind }],
    rewardOptions: [],
    rewardHistory: [...run.rewardHistory, kind],
    nextPieceNumber: run.nextPieceNumber + 1,
  };
}
