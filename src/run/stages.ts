import type { PieceKind } from "../core/model";

/**
 * Stage table for the first playable run (docs/roguelike-spec.md §5).
 * Every value here is PROVISIONAL: a starting point to be tuned by play.
 */
export type StageTier = "normal" | "elite" | "boss";

export interface EnemyPlacement {
  readonly row: number;
  readonly column: number;
  readonly kind: PieceKind;
}

export interface StageDefinition {
  readonly id: string;
  readonly tier: StageTier;
  /** Enemy (north) pieces on the board. Must contain exactly one lion. */
  readonly enemyBoard: ReadonlyArray<EnemyPlacement>;
  /** Enemy pieces that start in hand. */
  readonly enemyHand: ReadonlyArray<PieceKind>;
  /** AI search depth for this battle. */
  readonly aiDepth: number;
  /** Enemy HQ HP (spec §4.3). */
  readonly enemyHp: number;
}

/** Player HQ HP, restored to full before every battle (spec §4.3, provisional). */
export const PLAYER_HP = 15;

/** North's original squares, so early enemies are the classic setup with pieces missing. */
const LION = { row: 0, column: 1, kind: "lion" } as const;
const CHICK = { row: 1, column: 1, kind: "chick" } as const;
const ELEPHANT = { row: 0, column: 0, kind: "elephant" } as const;
const GIRAFFE = { row: 0, column: 2, kind: "giraffe" } as const;

export const STAGES: ReadonlyArray<StageDefinition> = [
  { id: "normal-1", tier: "normal", enemyBoard: [LION, CHICK], enemyHand: [], aiDepth: 1, enemyHp: 10 },
  { id: "normal-2", tier: "normal", enemyBoard: [LION, CHICK, ELEPHANT], enemyHand: [], aiDepth: 2, enemyHp: 10 },
  { id: "elite-1", tier: "elite", enemyBoard: [LION, CHICK, ELEPHANT, GIRAFFE], enemyHand: [], aiDepth: 3, enemyHp: 15 },
  { id: "boss-1", tier: "boss", enemyBoard: [LION, CHICK, ELEPHANT, GIRAFFE], enemyHand: ["chick"], aiDepth: 4, enemyHp: 25 },
];

/** Reward choices after a won battle. P2 offers plain base pieces only (spec §5, H-6). */
export const REWARD_KINDS: ReadonlyArray<PieceKind> = ["chick", "giraffe", "elephant"];
