import type { Piece, PieceKind, Player, StepVector } from "../core/model";

/**
 * Data-driven piece definitions for the roguelike ruleset
 * (docs/roguelike-spec.md §2–3). The classic ruleset keeps its own table on
 * purpose so the comparison baseline never changes when this one does.
 *
 * Every step list is written from south's point of view, in canonical order.
 */
export interface PieceDefinition {
  readonly steps: ReadonlyArray<StepVector>;
  /** Kind ATK. For a hen this already includes the +1 promotion bonus. */
  readonly atk: number;
}

/**
 * Canonical step order: forward, then clockwise (spec §3, provisional).
 * Truncating merged steps follows this order, so it must stay fixed.
 */
export const CANONICAL_STEPS: ReadonlyArray<StepVector> = [
  [-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1],
];

/** Non-lion pieces may move in at most this many directions (spec §3, E-3). */
export const MAX_STEPS = 6;

function stepsOf(...indices: number[]): ReadonlyArray<StepVector> {
  return indices.map((index) => CANONICAL_STEPS[index]);
}

export const PIECE_DEFINITIONS: Readonly<Record<PieceKind, PieceDefinition>> = {
  chick: { steps: stepsOf(0), atk: 1 },
  hen: { steps: stepsOf(0, 1, 2, 4, 6, 7), atk: 2 },
  giraffe: { steps: stepsOf(0, 2, 4, 6), atk: 2 },
  elephant: { steps: stepsOf(1, 3, 5, 7), atk: 2 },
  lion: { steps: stepsOf(0, 1, 2, 3, 4, 5, 6, 7), atk: 3 },
};

function canonicalIndex(step: StepVector): number {
  return CANONICAL_STEPS.findIndex(([row, column]) => row === step[0] && column === step[1]);
}

export function isOneSquareStep(step: StepVector): boolean {
  return canonicalIndex(step) >= 0;
}

/** Sorts steps into canonical order and drops duplicates and invalid entries. */
export function normalizeSteps(steps: ReadonlyArray<StepVector>): ReadonlyArray<StepVector> {
  const indices = new Set(steps.map(canonicalIndex).filter((index) => index >= 0));
  return [...indices].sort((left, right) => left - right).map((index) => CANONICAL_STEPS[index]);
}

/**
 * The steps a piece can take, as seen by south: kind steps first, then extra
 * steps in canonical order, without duplicates, capped at MAX_STEPS for every
 * piece except the lion.
 */
export function effectiveSteps(piece: Pick<Piece, "kind" | "extraSteps">): ReadonlyArray<StepVector> {
  const base = PIECE_DEFINITIONS[piece.kind].steps;
  if (!piece.extraSteps || piece.extraSteps.length === 0) return base;
  const merged = [...base];
  for (const step of normalizeSteps(piece.extraSteps)) {
    if (piece.kind !== "lion" && merged.length >= MAX_STEPS) break;
    if (!merged.some(([row, column]) => row === step[0] && column === step[1])) merged.push(step);
  }
  return merged;
}

/** North mirrors only the row direction (spec: "dy × -1"), like the classic ruleset. */
function forNorth(steps: ReadonlyArray<StepVector>): ReadonlyArray<StepVector> {
  return steps.map(([row, column]) => [row === 0 ? 0 : -row, column] as const);
}

const NORTH_BASE_STEPS = Object.fromEntries(
  Object.entries(PIECE_DEFINITIONS).map(([kind, definition]) => [kind, forNorth(definition.steps)]),
) as unknown as Readonly<Record<PieceKind, ReadonlyArray<StepVector>>>;

/** Steps on the actual board for the piece's owner. */
export function boardSteps(piece: Pick<Piece, "kind" | "owner" | "extraSteps">): ReadonlyArray<StepVector> {
  const hasExtras = Boolean(piece.extraSteps && piece.extraSteps.length > 0);
  if (piece.owner === "north" && !hasExtras) return NORTH_BASE_STEPS[piece.kind];
  const steps = effectiveSteps(piece);
  return piece.owner === "south" ? steps : forNorth(steps);
}

/** Kind ATK + permanent fusion ATK + this-battle ATK (spec §3, H-7 provisional). */
export function effectiveAtk(piece: Pick<Piece, "kind" | "fusionAtk" | "combatAtk">): number {
  return PIECE_DEFINITIONS[piece.kind].atk + (piece.fusionAtk ?? 0) + (piece.combatAtk ?? 0);
}

/**
 * What a captured piece becomes in the captor's hand (spec §4.2, C-4): it
 * changes sides, loses promotion and this-battle effects, and keeps what it
 * gained permanently.
 */
export function capturedForm(piece: Piece, captor: Player): Piece {
  const { combatAtk: _discarded, ...rest } = piece;
  return { ...rest, owner: captor, kind: piece.kind === "hen" ? "chick" : piece.kind };
}

/** Compact identity of a piece's rule-relevant data, for repetition keys. */
export function pieceSignature(piece: Piece): string {
  const extras = piece.extraSteps && piece.extraSteps.length > 0
    ? `+${normalizeSteps(piece.extraSteps).map(([row, column]) => `${row}${column}`).join(",")}`
    : "";
  const fusion = piece.fusionAtk ? `f${piece.fusionAtk}` : "";
  const combat = piece.combatAtk ? `c${piece.combatAtk}` : "";
  return `${piece.owner[0]}:${piece.kind}${extras}${fusion}${combat}`;
}
