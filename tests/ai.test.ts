import { describe, expect, it } from "vitest";
import { toIndex, type GameAction, type GameState, type Piece, type PieceKind, type Player } from "../src/core/model";
import { classicRuleset } from "../src/rules/classic";
import {
  createAiOpponent, createEvaluator, createSearchEngine, createStandardOpponent,
  standardClassicProfile, WIN_SCORE, type EvaluationProfile,
} from "../src/ai";
import { createRandom } from "../src/ai/random";

type Placement = readonly [row: number, column: number, kind: PieceKind, owner: Player];

function stateWith(
  placements: ReadonlyArray<Placement>,
  turn: Player = "south",
  hands: { north: ReadonlyArray<PieceKind>; south: ReadonlyArray<PieceKind> } = { north: [], south: [] },
): GameState {
  const board: Array<Piece | null> = Array(12).fill(null);
  placements.forEach(([row, column, kind, owner], index) => {
    board[toIndex({ row, column })] = { id: `${owner}-${kind}-${index}`, kind, owner };
  });
  const hand = (owner: Player) =>
    hands[owner].map((kind, index) => ({ id: `${owner}-hand-${index}`, kind, owner }));
  return {
    board,
    hands: { north: hand("north"), south: hand("south") },
    turn,
    result: { type: "playing" },
    history: [],
    moveNumber: 1,
    lastEvent: { type: "start", player: turn },
  };
}

function describeAction(action: GameAction | null): string {
  if (!action) return "none";
  if (action.type === "drop") return `drop@${action.to.row},${action.to.column}`;
  return `${action.from.row},${action.from.column}->${action.to.row},${action.to.column}`;
}

/** Plain minimax with no pruning, used to prove alpha-beta returns the same score. */
function referenceMinimax(state: GameState, depth: number, perspective: Player, ply = 0): number {
  if (state.result.type !== "playing") {
    if (state.result.type === "draw") return 0;
    return state.result.winner === perspective ? WIN_SCORE - ply : -WIN_SCORE + ply;
  }
  const evaluator = createEvaluator(classicRuleset, standardClassicProfile);
  if (depth === 0) return evaluator.evaluate(state, perspective);
  const actions = classicRuleset.legalActions(state);
  if (actions.length === 0) return evaluator.evaluate(state, perspective);
  const scores = actions.map((action) =>
    referenceMinimax(classicRuleset.applyAction(state, action), depth - 1, perspective, ply + 1),
  );
  return state.turn === perspective ? Math.max(...scores) : Math.min(...scores);
}

describe("minimax search", () => {
  it("takes the most valuable free capture at depth 1", () => {
    // South giraffe can take an undefended elephant or an undefended chick.
    const state = stateWith([
      [3, 1, "lion", "south"], [0, 1, "lion", "north"],
      [2, 1, "giraffe", "south"],
      [1, 1, "elephant", "north"], [2, 2, "chick", "north"],
    ]);
    const engine = createSearchEngine(classicRuleset, createEvaluator(classicRuleset, standardClassicProfile));
    const result = engine.search(state, { perspective: "south", depth: 1, seed: 1 });
    expect(describeAction(result.action)).toBe("2,1->1,1");
  });

  it("declines a capture that loses more to the reply once it can see the reply", () => {
    // The chick on (1,0) is defended by the giraffe on (0,0): giraffe for chick is a bad trade.
    const placements: ReadonlyArray<Placement> = [
      [3, 2, "lion", "south"], [0, 2, "lion", "north"],
      [2, 0, "giraffe", "south"],
      [1, 0, "chick", "north"], [0, 0, "giraffe", "north"],
    ];
    const engine = createSearchEngine(classicRuleset, createEvaluator(classicRuleset, standardClassicProfile));
    const greedy = engine.search(stateWith(placements), { perspective: "south", depth: 1, seed: 1 });
    const careful = engine.search(stateWith(placements), { perspective: "south", depth: 2, seed: 1 });
    expect(describeAction(greedy.action)).toBe("2,0->1,0");
    expect(describeAction(careful.action)).not.toBe("2,0->1,0");
  });

  it("plays an immediately winning capture and scores it as a terminal win", () => {
    const state = stateWith([
      [3, 0, "lion", "south"], [1, 1, "lion", "north"],
      [2, 1, "giraffe", "south"], [0, 2, "chick", "north"],
    ]);
    const result = createStandardOpponent(classicRuleset, "south", 1).chooseMove(state);
    expect(describeAction(result.action)).toBe("2,1->1,1");
    expect(result.score).toBeGreaterThan(WIN_SCORE - 100);
  });

  it("prefers the line that avoids an immediate loss", () => {
    // Moving the giraffe off (1,1) lets the north lion try into row 3 next turn.
    const state = stateWith([
      [3, 0, "lion", "south"], [2, 1, "lion", "north"],
      [1, 1, "giraffe", "south"], [3, 2, "elephant", "south"],
    ]);
    const result = createStandardOpponent(classicRuleset, "south", 1).chooseMove(state);
    expect(result.score).toBeGreaterThan(-WIN_SCORE + 100);
  });

  it("returns the same scores as unpruned minimax", () => {
    const state = classicRuleset.createInitialState();
    const engine = createSearchEngine(classicRuleset, createEvaluator(classicRuleset, standardClassicProfile));
    for (const depth of [1, 2, 3]) {
      const result = engine.search(state, { perspective: "south", depth, seed: 1 });
      const expected = Math.max(
        ...classicRuleset.legalActions(state).map((action) =>
          referenceMinimax(classicRuleset.applyAction(state, action), depth - 1, "south", 1),
        ),
      );
      expect(result.candidates[0].score).toBe(expected);
    }
  });

  it("never mutates the live game state", () => {
    const state = classicRuleset.createInitialState();
    const snapshot = JSON.stringify(state);
    createStandardOpponent(classicRuleset, "south", 1).chooseMove(state);
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it("returns no action once the game is over", () => {
    const finished: GameState = {
      ...classicRuleset.createInitialState(),
      result: { type: "win", winner: "south", reason: "capture" },
    };
    expect(createStandardOpponent(classicRuleset, "north", 1).chooseMove(finished).action).toBeNull();
  });

  it("is reproducible for a given seed and can differ between seeds", () => {
    const state = classicRuleset.createInitialState();
    const first = createStandardOpponent(classicRuleset, "south", 7).chooseMove(state);
    const again = createStandardOpponent(classicRuleset, "south", 7).chooseMove(state);
    expect(describeAction(again.action)).toBe(describeAction(first.action));
    const tiedScores = first.candidates.filter((candidate) => candidate.score === first.score);
    const chosen = new Set(
      [1, 2, 3, 4, 5, 6, 7, 8].map((seed) =>
        describeAction(createStandardOpponent(classicRuleset, "south", seed).chooseMove(state).action)),
    );
    expect(chosen.size).toBeLessThanOrEqual(tiedScores.length);
    expect(tiedScores.length > 1 ? chosen.size : 1).toBeGreaterThan(tiedScores.length > 1 ? 1 : 0);
  });
});

describe("evaluation", () => {
  const evaluator = createEvaluator(classicRuleset, standardClassicProfile);

  it("scores an extra piece higher than the same position without it", () => {
    const base: ReadonlyArray<Placement> = [
      [3, 1, "lion", "south"], [0, 1, "lion", "north"],
    ];
    const without = evaluator.evaluate(stateWith(base), "south");
    const withGiraffe = evaluator.evaluate(stateWith([...base, [2, 0, "giraffe", "south"]]), "south");
    expect(withGiraffe).toBeGreaterThan(without);
  });

  it("values a captured piece in hand separately from one on the board", () => {
    const placements: ReadonlyArray<Placement> = [[3, 1, "lion", "south"], [0, 1, "lion", "north"]];
    const inHand = evaluator.evaluate(
      stateWith(placements, "south", { north: [], south: ["chick"] }), "south");
    const { weights } = standardClassicProfile;
    expect(weights.materialInHand.chick).not.toBe(weights.material.chick);
    expect(inHand).toBeGreaterThan(evaluator.evaluate(stateWith(placements), "south"));
  });

  it("is symmetric: what is good for south is bad for north", () => {
    const state = stateWith([
      [3, 1, "lion", "south"], [0, 1, "lion", "north"], [2, 0, "giraffe", "south"],
    ]);
    expect(evaluator.evaluate(state, "south")).toBe(-evaluator.evaluate(state, "north"));
  });

  it("changes the score of the same position when the profile weights change", () => {
    const state = stateWith([
      [3, 1, "lion", "south"], [0, 1, "lion", "north"], [2, 0, "giraffe", "south"],
    ]);
    const heavy: EvaluationProfile = {
      ...standardClassicProfile,
      id: "material-heavy",
      weights: { ...standardClassicProfile.weights, material: { lion: 0, giraffe: 3800, elephant: 3500, chick: 1000, hen: 4500 } },
    };
    expect(createEvaluator(classicRuleset, heavy).evaluate(state, "south"))
      .not.toBe(evaluator.evaluate(state, "south"));
  });

  it("never scores a capturable lion in classic, where moves cannot leave the lion attacked", () => {
    const random = createRandom(11);
    for (let game = 0; game < 3; game += 1) {
      let state = classicRuleset.createInitialState();
      for (let ply = 0; ply < 60 && state.result.type === "playing"; ply += 1) {
        expect(evaluator.extractFeatures(state, "south").lionCapture).toBe(0);
        expect(evaluator.extractFeatures(state, "north").lionCapture).toBe(0);
        const actions = classicRuleset.legalActions(state);
        state = classicRuleset.applyAction(state, actions[Math.floor(random() * actions.length)]);
      }
    }
  });

  it("reports a breakdown whose terms add up to the total", () => {
    const breakdown = evaluator.explain(classicRuleset.createInitialState(), "south");
    expect(breakdown.material + breakdown.mobility + breakdown.boardControl
      + breakdown.lionSafety + breakdown.tryProgress + breakdown.lionCapture
      + breakdown.lionThreat + breakdown.hqHp).toBe(breakdown.total);
  });
});

describe("profile swapping", () => {
  const materialHeavy: EvaluationProfile = {
    id: "material-heavy", searchDepth: 2,
    weights: {
      material: { lion: 0, giraffe: 380, elephant: 350, chick: 100, hen: 450 },
      materialInHand: { lion: 0, giraffe: 420, elephant: 385, chick: 110, hen: 495 },
      mobility: 0, boardControl: 0, lionSafety: 0, tryProgress: 0, lionCapture: 0, lionThreat: 0, hqHp: 0,
    },
  };
  const tryRush: EvaluationProfile = {
    ...materialHeavy, id: "try-rush",
    weights: {
      ...materialHeavy.weights,
      material: { lion: 0, giraffe: 0, elephant: 0, chick: 0, hen: 0 },
      materialInHand: { lion: 0, giraffe: 0, elephant: 0, chick: 0, hen: 0 },
      tryProgress: 500,
    },
  };

  it("changes the chosen move without touching the search engine", () => {
    // Taking the chick is the material choice; walking the lion up is the try choice.
    const state = stateWith([
      [3, 1, "lion", "south"], [0, 0, "lion", "north"],
      [2, 2, "giraffe", "south"], [1, 2, "chick", "north"],
    ]);
    const greedy = createAiOpponent(classicRuleset, { profile: materialHeavy, perspective: "south", seed: 1 });
    const rusher = createAiOpponent(classicRuleset, { profile: tryRush, perspective: "south", seed: 1 });
    expect(describeAction(greedy.chooseMove(state).action)).toBe("2,2->1,2");
    expect(describeAction(rusher.chooseMove(state).action)).not.toBe("2,2->1,2");
  });
});
