import { describe, expect, it } from "vitest";
import {
  toIndex, type GameAction, type GameState, type Piece, type PieceKind, type Player, type StepVector,
} from "../src/core/model";
import { classicRuleset } from "../src/rules/classic";
import {
  createRoguelikeRuleset, originalSetup, roguelikeAnalysis, roguelikePositionKey, type BattleSetup,
} from "../src/rules/roguelike";
import {
  CANONICAL_STEPS, MAX_STEPS, PIECE_DEFINITIONS, boardSteps, capturedForm, effectiveAtk, effectiveSteps,
} from "../src/rules/pieceData";
import { createAiOpponent, standardClassicProfile } from "../src/ai";
import { createRandom } from "../src/ai/random";

type Placement = readonly [row: number, column: number, piece: Piece];

let nextId = 0;
function make(kind: PieceKind, owner: Player, extra: Partial<Piece> = {}): Piece {
  nextId += 1;
  return { id: `t${nextId}`, kind, owner, ...extra };
}

function setupWith(
  placements: ReadonlyArray<Placement>,
  hands: { north?: Piece[]; south?: Piece[] } = {},
  firstPlayer: Player = "south",
): BattleSetup {
  const board: Array<Piece | null> = Array(12).fill(null);
  placements.forEach(([row, column, piece]) => { board[toIndex({ row, column })] = piece; });
  return { board, hands: { north: hands.north ?? [], south: hands.south ?? [] }, firstPlayer };
}

function key(action: GameAction): string {
  return action.type === "move"
    ? `m${action.from.row}${action.from.column}${action.to.row}${action.to.column}`
    : `d${action.player}${action.handIndex}${action.to.row}${action.to.column}`;
}

function move(fromRow: number, fromColumn: number, toRow: number, toColumn: number): GameAction {
  return { type: "move", from: { row: fromRow, column: fromColumn }, to: { row: toRow, column: toColumn } };
}

describe("piece data", () => {
  it("gives each kind its spec ATK, with the hen's promotion bonus built in", () => {
    expect(effectiveAtk({ kind: "chick" })).toBe(1);
    expect(effectiveAtk({ kind: "hen" })).toBe(2);
    expect(effectiveAtk({ kind: "giraffe" })).toBe(2);
    expect(effectiveAtk({ kind: "elephant" })).toBe(2);
    expect(effectiveAtk({ kind: "lion" })).toBe(3);
  });

  it("adds fusion and combat ATK on top of the kind ATK", () => {
    expect(effectiveAtk({ kind: "giraffe", fusionAtk: 1, combatAtk: 2 })).toBe(5);
  });

  it("moves exactly like the classic pieces when there is no extra data", () => {
    const classic = classicRuleset.createInitialState();
    const roguelike = createRoguelikeRuleset(originalSetup());
    const state = roguelike.createInitialState();
    expect(state.board).toEqual(classic.board);
    expect(roguelike.legalActions(state).map(key).sort())
      .toEqual(classicRuleset.legalActions(classic).map(key).sort());
  });

  it("merges extra steps after the kind steps, in canonical order, without duplicates", () => {
    const steps = effectiveSteps({ kind: "chick", extraSteps: [[0, -1], [-1, 0], [1, 1]] });
    expect(steps).toEqual([[-1, 0], [1, 1], [0, -1]]);
  });

  it("caps a non-lion piece at six directions, keeping the kind steps first", () => {
    const steps = effectiveSteps({ kind: "elephant", extraSteps: CANONICAL_STEPS });
    expect(steps).toHaveLength(MAX_STEPS);
    expect(steps.slice(0, 4)).toEqual(PIECE_DEFINITIONS.elephant.steps);
    // Then the first two missing directions in canonical order: forward, right.
    expect(steps.slice(4)).toEqual([[-1, 0], [0, 1]]);
  });

  it("ignores steps longer than one square", () => {
    const steps = effectiveSteps({ kind: "chick", extraSteps: [[-2, 0], [0, 0]] as StepVector[] });
    expect(steps).toEqual(PIECE_DEFINITIONS.chick.steps);
  });

  it("mirrors only the row direction for north", () => {
    const piece = make("chick", "north", { extraSteps: [[0, 1]] });
    expect(boardSteps(piece)).toEqual([[1, 0], [0, 1]]);
  });

  it("turns a captured piece into the captor's demoted piece and keeps permanent data only", () => {
    const hen = make("hen", "north", { extraSteps: [[1, 1]], fusionAtk: 2, combatAtk: 3 });
    const taken = capturedForm(hen, "south");
    expect(taken).toEqual({ id: hen.id, kind: "chick", owner: "south", extraSteps: [[1, 1]], fusionAtk: 2 });
    expect(taken).not.toHaveProperty("combatAtk");
  });
});

describe("roguelike ruleset", () => {
  it("allows a move that leaves the lion attacked, which classic forbids", () => {
    const setup = setupWith([
      [3, 1, make("lion", "south")], [0, 2, make("lion", "north")], [1, 0, make("elephant", "north")],
    ]);
    const roguelike = createRoguelikeRuleset(setup);
    const state = roguelike.createInitialState();
    const intoDanger = move(3, 1, 2, 1);
    expect(classicRuleset.legalActions(state).map(key)).not.toContain(key(intoDanger));
    expect(roguelike.legalActions(state).map(key)).toContain(key(intoDanger));

    const next = roguelike.applyAction(state, intoDanger);
    expect(next.turn).toBe("north");
    const punished = roguelike.applyAction(next, move(1, 0, 2, 1));
    expect(punished.result).toEqual({ type: "win", winner: "north", reason: "capture" });
  });

  it("only adds self-endangering moves on top of classic's legal moves", () => {
    // Walk deterministic random games and compare move sets at every position.
    const roguelike = createRoguelikeRuleset(originalSetup());
    let extrasSeen = 0;
    for (const seed of [42, 7, 1234]) {
      const random = createRandom(seed);
      let state = roguelike.createInitialState();
      for (let ply = 0; ply < 60 && state.result.type === "playing"; ply += 1) {
        const actions = roguelike.legalActions(state);
        const classic = new Set(classicRuleset.legalActions(state).map(key));
        const mine = new Set(actions.map(key));
        classic.forEach((action) => expect(mine.has(action)).toBe(true));
        for (const extra of actions.filter((action) => !classic.has(key(action)))) {
          extrasSeen += 1;
          const after = roguelike.applyAction(state, extra);
          const lion = roguelikeAnalysis.lionSquare(after.board, state.turn)!;
          const rival = state.turn === "south" ? "north" : "south";
          expect(roguelikeAnalysis.attackedSquares(after.board, rival).has(lion)).toBe(true);
        }
        state = roguelike.applyAction(state, actions[Math.floor(random() * actions.length)]);
      }
    }
    expect(extrasSeen).toBeGreaterThan(0);
  });

  it("starts from an uneven setup with fewer enemy pieces", () => {
    const setup = setupWith([
      [0, 1, make("lion", "north")], [1, 1, make("chick", "north")],
      [3, 0, make("giraffe", "south")], [3, 1, make("lion", "south")],
      [3, 2, make("elephant", "south")], [2, 1, make("chick", "south")],
    ], { south: [make("chick", "south")] });
    const state = createRoguelikeRuleset(setup).createInitialState();
    expect(state.board.filter((piece) => piece?.owner === "north")).toHaveLength(2);
    expect(state.board.filter((piece) => piece?.owner === "south")).toHaveLength(4);
    expect(state.hands.south).toHaveLength(1);
    expect(state.turn).toBe("south");
    expect(state.result.type).toBe("playing");
  });

  it("rejects setups without exactly one lion per side or with duplicate ids", () => {
    const southLion = make("lion", "south");
    expect(() => createRoguelikeRuleset(setupWith([[3, 1, southLion]]))).toThrow();
    expect(() => createRoguelikeRuleset(setupWith([
      [3, 1, southLion], [0, 1, { ...southLion, owner: "north" }],
    ]))).toThrow();
  });

  it("moves a piece along its extra steps", () => {
    const winged = make("chick", "south", { extraSteps: [[0, 1]] });
    const setup = setupWith([[3, 0, make("lion", "south")], [0, 2, make("lion", "north")], [2, 0, winged]]);
    const ruleset = createRoguelikeRuleset(setup);
    const state = ruleset.createInitialState();
    const next = ruleset.applyAction(state, move(2, 0, 2, 1));
    expect(next.board[toIndex({ row: 2, column: 1 })]).toMatchObject({ id: winged.id });
  });

  it("captures into hand with permanent data kept and promotion and combat data removed", () => {
    const fusedHen = make("hen", "north", { extraSteps: [[1, 1]], fusionAtk: 1, combatAtk: 2 });
    const setup = setupWith([
      [3, 1, make("lion", "south")], [0, 1, make("lion", "north")],
      [2, 0, make("giraffe", "south")], [1, 0, fusedHen],
    ]);
    const ruleset = createRoguelikeRuleset(setup);
    const next = ruleset.applyAction(ruleset.createInitialState(), move(2, 0, 1, 0));
    expect(next.hands.south).toEqual([{ id: fusedHen.id, kind: "chick", owner: "south", extraSteps: [[1, 1]], fusionAtk: 1 }]);
    expect(next.lastEvent).toEqual({ type: "move", player: "south", piece: "giraffe", captured: "hen", promoted: false });
  });

  it("promotes a fused chick and keeps its extra steps", () => {
    const fused = make("chick", "south", { extraSteps: [[1, 1]], fusionAtk: 1 });
    const setup = setupWith([[3, 1, make("lion", "south")], [0, 2, make("lion", "north")], [1, 0, fused]]);
    const ruleset = createRoguelikeRuleset(setup);
    const next = ruleset.applyAction(ruleset.createInitialState(), move(1, 0, 0, 0));
    const promoted = next.board[toIndex({ row: 0, column: 0 })]!;
    expect(promoted).toMatchObject({ kind: "hen", extraSteps: [[1, 1]], fusionAtk: 1 });
    // Hen steps (6) already fill the cap, so the extra back-right step is cut.
    expect(effectiveSteps(promoted)).toEqual(PIECE_DEFINITIONS.hen.steps);
    expect(effectiveAtk(promoted)).toBe(3);
  });

  it("does not promote a chick dropped onto the far rank", () => {
    const setup = setupWith(
      [[3, 1, make("lion", "south")], [0, 2, make("lion", "north")]],
      { south: [make("chick", "south")] },
    );
    const ruleset = createRoguelikeRuleset(setup);
    const next = ruleset.applyAction(ruleset.createInitialState(), {
      type: "drop", player: "south", handIndex: 0, to: { row: 0, column: 0 },
    });
    expect(next.board[0]).toMatchObject({ kind: "chick", owner: "south" });
  });

  it("tells fused pieces apart from plain ones in the repetition key", () => {
    const plain = setupWith([[3, 1, make("lion", "south")], [0, 1, make("lion", "north")], [2, 0, make("chick", "south")]]);
    const fused = setupWith([
      [3, 1, make("lion", "south")], [0, 1, make("lion", "north")], [2, 0, make("chick", "south", { fusionAtk: 1 })],
    ]);
    const plainState = createRoguelikeRuleset(plain).createInitialState();
    const fusedState = createRoguelikeRuleset(fused).createInitialState();
    expect(roguelikePositionKey(plainState)).not.toBe(roguelikePositionKey(fusedState));
  });

  it("rejects illegal actions and never mutates its input", () => {
    const ruleset = createRoguelikeRuleset(originalSetup());
    const state = ruleset.createInitialState();
    const snapshot = JSON.stringify(state);
    expect(ruleset.applyAction(state, move(3, 0, 0, 0))).toBe(state);
    ruleset.applyAction(state, ruleset.legalActions(state)[0]);
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it("creates the same initial state every time from the same setup", () => {
    const setup = originalSetup();
    expect(createRoguelikeRuleset(setup).createInitialState())
      .toEqual(createRoguelikeRuleset(setup).createInitialState());
  });
});

describe("AI on the roguelike ruleset", () => {
  function playOut(setup: BattleSetup, southDepth: number, northDepth: number, maxPlies = 200): GameState {
    const ruleset = createRoguelikeRuleset(setup);
    const players = {
      south: createAiOpponent(ruleset, { profile: { ...standardClassicProfile, searchDepth: southDepth }, perspective: "south", seed: 3 }),
      north: createAiOpponent(ruleset, { profile: { ...standardClassicProfile, searchDepth: northDepth }, perspective: "north", seed: 5 }),
    };
    let state = ruleset.createInitialState();
    for (let ply = 0; ply < maxPlies && state.result.type === "playing"; ply += 1) {
      const { action } = players[state.turn].chooseMove(state);
      expect(action).not.toBeNull();
      const legal = ruleset.legalActions(state).map(key);
      expect(legal).toContain(key(action!));
      state = ruleset.applyAction(state, action!);
    }
    return state;
  }

  it("plays a full battle from an uneven setup to a result", () => {
    const setup = setupWith([
      [0, 1, make("lion", "north")], [1, 1, make("chick", "north")],
      [3, 0, make("giraffe", "south")], [3, 1, make("lion", "south")],
      [3, 2, make("elephant", "south")], [2, 1, make("chick", "south")],
    ]);
    const end = playOut(setup, 2, 1);
    expect(end.result.type).not.toBe("playing");
  });

  it("takes a lion left hanging by a self-endangering move", () => {
    const setup = setupWith([
      [2, 1, make("lion", "south")], [0, 2, make("lion", "north")], [1, 0, make("elephant", "north")],
    ], {}, "north");
    const ruleset = createRoguelikeRuleset(setup);
    const ai = createAiOpponent(ruleset, { profile: standardClassicProfile, perspective: "north", seed: 1 });
    const { action } = ai.chooseMove(ruleset.createInitialState());
    expect(key(action!)).toBe(key(move(1, 0, 2, 1)));
  });
});
