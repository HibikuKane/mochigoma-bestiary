import { describe, expect, it } from "vitest";
import {
  toIndex, type GameAction, type GameState, type Hq, type Piece, type PieceKind, type Player,
} from "../src/core/model";
import {
  LION_CAPTURE_DAMAGE, TRY_DAMAGE, createRoguelikeRuleset, roguelikePositionKey, type BattleSetup,
} from "../src/rules/roguelike";
import { createAiOpponent, createEvaluator, standardClassicProfile } from "../src/ai";
import { battleSetup, startRun } from "../src/run/run";
import { PLAYER_HP, STAGES } from "../src/run/stages";

let nextId = 0;
function make(kind: PieceKind, owner: Player, extra: Partial<Piece> = {}): Piece {
  nextId += 1;
  return { id: `h${nextId}`, kind, owner, ...extra };
}

type Placement = readonly [row: number, column: number, piece: Piece];

function hpSetup(
  placements: ReadonlyArray<Placement>,
  hp: { north?: number; south?: number } = {},
  options: { firstPlayer?: Player; seed?: number; hands?: { north?: Piece[]; south?: Piece[] } } = {},
): BattleSetup {
  const board: Array<Piece | null> = Array(12).fill(null);
  placements.forEach(([row, column, piece]) => { board[toIndex({ row, column })] = piece; });
  const hq = (value: number): Hq => ({ hp: value, maxHp: Math.max(value, 15) });
  return {
    board,
    hands: { north: options.hands?.north ?? [], south: options.hands?.south ?? [] },
    firstPlayer: options.firstPlayer ?? "south",
    hq: { north: hq(hp.north ?? 15), south: hq(hp.south ?? 15) },
    seed: options.seed ?? 1,
  };
}

function move(fromRow: number, fromColumn: number, toRow: number, toColumn: number): GameAction {
  return { type: "move", from: { row: fromRow, column: fromColumn }, to: { row: toRow, column: toColumn } };
}

function key(action: GameAction): string {
  return action.type === "move"
    ? `m${action.from.row}${action.from.column}${action.to.row}${action.to.column}`
    : `d${action.player}${action.handIndex}${action.to.row}${action.to.column}`;
}

function at(state: GameState, row: number, column: number): Piece | null {
  return state.board[toIndex({ row, column })];
}

function play(setup: BattleSetup, ...actions: GameAction[]): GameState {
  const ruleset = createRoguelikeRuleset(setup);
  let state = ruleset.createInitialState();
  for (const action of actions) {
    const next = ruleset.applyAction(state, action);
    expect(next, `illegal action ${key(action)}`).not.toBe(state);
    state = next;
  }
  return state;
}

describe("HQ damage", () => {
  it("deals the capturing piece's ATK to the enemy HQ", () => {
    const state = play(hpSetup([
      [3, 1, make("lion", "south")], [0, 1, make("lion", "north")],
      [2, 0, make("giraffe", "south")], [1, 0, make("chick", "north")],
    ], { north: 10 }), move(2, 0, 1, 0));
    expect(state.hq?.north.hp).toBe(8);
    expect(state.lastEvent).toMatchObject({ type: "move", captured: "chick", damage: 2 });
    expect(state.result.type).toBe("playing");
  });

  it("uses the ATK before a promotion caused by the same move", () => {
    const state = play(hpSetup([
      [3, 1, make("lion", "south")], [0, 1, make("lion", "north")],
      [1, 0, make("chick", "south")], [0, 0, make("elephant", "north")],
    ], { north: 10 }), move(1, 0, 0, 0));
    expect(at(state, 0, 0)).toMatchObject({ kind: "hen" });
    expect(state.hq?.north.hp).toBe(9);
  });

  it("adds fusion and combat ATK to the damage", () => {
    const state = play(hpSetup([
      [3, 1, make("lion", "south")], [0, 1, make("lion", "north")],
      [2, 0, make("giraffe", "south", { fusionAtk: 1, combatAtk: 2 })], [1, 0, make("chick", "north")],
    ], { north: 10 }), move(2, 0, 1, 0));
    expect(state.hq?.north.hp).toBe(5);
  });

  it("ends the battle when an HQ reaches 0 and never shows negative HP", () => {
    const state = play(hpSetup([
      [3, 1, make("lion", "south")], [0, 1, make("lion", "north")],
      [2, 0, make("giraffe", "south")], [1, 0, make("chick", "north")],
    ], { north: 1 }), move(2, 0, 1, 0));
    expect(state.result).toEqual({ type: "win", winner: "south", reason: "hp" });
    expect(state.hq?.north.hp).toBe(0);
  });
});

describe("lion capture", () => {
  const lionBattle = () => hpSetup([
    [3, 1, make("lion", "south")], [1, 1, make("lion", "north")],
    [2, 1, make("giraffe", "south")], [0, 2, make("chick", "north")],
  ]);

  it("deals fixed damage and returns the lion stunned to the middle of its back rank", () => {
    const state = play(lionBattle(), move(2, 1, 1, 1));
    expect(state.hq?.north.hp).toBe(15 - LION_CAPTURE_DAMAGE);
    expect(state.result.type).toBe("playing");
    expect(at(state, 0, 1)).toMatchObject({ kind: "lion", owner: "north", stunned: true });
    expect(state.hands.south).toEqual([]);
    expect(state.lastEvent).toMatchObject({ captured: "lion", damage: LION_CAPTURE_DAMAGE, respawned: true });
  });

  it("keeps the returned lion still on its owner's turn and untouchable through the captor's next turn", () => {
    const ruleset = createRoguelikeRuleset(lionBattle());
    // South takes the lion; it returns stunned to (0,1).
    let state = ruleset.applyAction(ruleset.createInitialState(), move(2, 1, 1, 1));
    // North's turn: the lion cannot move, so North moves the chick.
    expect(ruleset.legalActions(state).some((action) =>
      action.type === "move" && action.from.row === 0 && action.from.column === 1)).toBe(false);
    state = ruleset.applyAction(state, move(0, 2, 1, 2));
    // South's turn, right after: the giraffe next to the lion may not take it again.
    expect(at(state, 0, 1)).toMatchObject({ kind: "lion", stunned: true });
    expect(ruleset.legalActions(state).map(key)).not.toContain(key(move(1, 1, 0, 1)));
    state = ruleset.applyAction(state, move(3, 1, 3, 0));
    // North's next turn: the stun is over and the lion moves again.
    expect(at(state, 0, 1)).not.toHaveProperty("stunned");
    expect(ruleset.legalActions(state).some((action) =>
      action.type === "move" && action.from.row === 0 && action.from.column === 1)).toBe(true);
    expect(state.hq?.north.hp).toBe(15 - LION_CAPTURE_DAMAGE);
  });

  it("falls back to the left, then right back-rank square", () => {
    const left = play(hpSetup([
      [3, 1, make("lion", "south")], [1, 1, make("lion", "north")],
      [2, 1, make("giraffe", "south")], [0, 1, make("chick", "north")],
    ]), move(2, 1, 1, 1));
    expect(at(left, 0, 0)).toMatchObject({ kind: "lion", stunned: true });
    const right = play(hpSetup([
      [3, 1, make("lion", "south")], [1, 1, make("lion", "north")],
      [2, 1, make("giraffe", "south")], [0, 1, make("chick", "north")], [0, 0, make("elephant", "north")],
    ]), move(2, 1, 1, 1));
    expect(at(right, 0, 2)).toMatchObject({ kind: "lion", stunned: true });
  });

  it("uses a seeded random square off the far rank when the back rank is full", () => {
    const crowded = (seed: number) => hpSetup([
      [3, 1, make("lion", "south")], [1, 1, make("lion", "north")], [2, 1, make("giraffe", "south")],
      [0, 0, make("elephant", "north")], [0, 1, make("chick", "north")], [0, 2, make("giraffe", "north")],
    ], {}, { seed });
    const squares = new Set<number>();
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const first = play(crowded(seed), move(2, 1, 1, 1));
      const again = play(crowded(seed), move(2, 1, 1, 1));
      const index = first.board.findIndex((piece) => piece?.owner === "north" && piece.kind === "lion");
      expect(again.board.findIndex((piece) => piece?.owner === "north" && piece.kind === "lion")).toBe(index);
      expect(Math.floor(index / 3)).not.toBe(3);
      expect(first.board[index]).toMatchObject({ stunned: true });
      squares.add(index);
    }
    expect(squares.size).toBeGreaterThan(1);
  });

  it("wins outright when the lion damage empties the HQ", () => {
    const setup = lionBattle();
    const state = play({ ...setup, hq: { ...setup.hq!, north: { hp: 10, maxHp: 10 } } }, move(2, 1, 1, 1));
    expect(state.result).toEqual({ type: "win", winner: "south", reason: "hp" });
  });
});

describe("holding the far rank", () => {
  const trySetup = (northHp = 15) => hpSetup([
    [1, 0, make("lion", "south")], [3, 2, make("lion", "north")], [2, 2, make("chick", "north")],
  ], { north: northHp });

  it("does not end the battle on reaching the far rank", () => {
    const state = play(trySetup(), move(1, 0, 0, 0));
    expect(state.result.type).toBe("playing");
    expect(state.hq?.north.hp).toBe(15);
  });

  it("deals damage at each of the owner's turn starts while the lion stays", () => {
    let state = play(trySetup(), move(1, 0, 0, 0), move(3, 2, 3, 1));
    expect(state.hq?.north.hp).toBe(15 - TRY_DAMAGE);
    expect(state.lastEvent).toMatchObject({ type: "move", player: "north", tryDamage: TRY_DAMAGE });
    const ruleset = createRoguelikeRuleset(trySetup());
    state = ruleset.applyAction(state, move(0, 0, 0, 1));
    state = ruleset.applyAction(state, move(3, 1, 3, 2));
    expect(state.hq?.north.hp).toBe(15 - 2 * TRY_DAMAGE);
  });

  it("stops once the lion leaves the far rank", () => {
    const state = play(trySetup(), move(1, 0, 0, 0), move(3, 2, 3, 1), move(0, 0, 1, 0), move(3, 1, 3, 2));
    expect(state.hq?.north.hp).toBe(15 - TRY_DAMAGE);
  });

  it("wins when the far-rank damage empties the HQ", () => {
    const state = play(trySetup(5), move(1, 0, 0, 0), move(3, 2, 3, 1));
    expect(state.result).toEqual({ type: "win", winner: "south", reason: "hp" });
    expect(state.hq?.north.hp).toBe(0);
  });
});

describe("HP battle bookkeeping", () => {
  it("includes HQ HP in the repetition key", () => {
    const placements: ReadonlyArray<Placement> = [[3, 1, make("lion", "south")], [0, 1, make("lion", "north")]];
    const full = createRoguelikeRuleset(hpSetup(placements)).createInitialState();
    const hurt = createRoguelikeRuleset(hpSetup(placements, { north: 9 })).createInitialState();
    expect(roguelikePositionKey(full)).not.toBe(roguelikePositionKey(hurt));
  });

  it("rejects invalid HQs and stunned pieces in a setup", () => {
    const placements: ReadonlyArray<Placement> = [[3, 1, make("lion", "south")], [0, 1, make("lion", "north")]];
    const base = hpSetup(placements);
    expect(() => createRoguelikeRuleset({ ...base, hq: { ...base.hq!, north: { hp: 0, maxHp: 10 } } })).toThrow(/HQ/);
    expect(() => createRoguelikeRuleset({ ...base, hq: { ...base.hq!, north: { hp: 11, maxHp: 10 } } })).toThrow(/HQ/);
    expect(() => createRoguelikeRuleset(hpSetup([
      [3, 1, make("lion", "south", { stunned: true })], [0, 1, make("lion", "north")],
    ]))).toThrow(/stunned/);
  });

  it("starts every run battle with full HQs from the stage table", () => {
    let run = startRun(1);
    const setup = battleSetup(run);
    expect(setup.hq).toEqual({ north: { hp: STAGES[0].enemyHp, maxHp: STAGES[0].enemyHp }, south: { hp: PLAYER_HP, maxHp: PLAYER_HP } });
    run = { ...run, stageIndex: 3 };
    expect(battleSetup(run).hq?.north).toEqual({ hp: 25, maxHp: 25 });
  });
});

describe("AI in HP battles", () => {
  it("values HQ HP symmetrically", () => {
    const setup = hpSetup([[3, 1, make("lion", "south")], [0, 1, make("lion", "north")]], { north: 7 });
    const ruleset = createRoguelikeRuleset(setup);
    const evaluator = createEvaluator(ruleset, standardClassicProfile);
    const state = ruleset.createInitialState();
    expect(evaluator.extractFeatures(state, "south").hqHp).toBe(8);
    expect(evaluator.evaluate(state, "south")).toBe(-evaluator.evaluate(state, "north"));
  });

  it("treats a hanging lion as decisive only when the HQ cannot absorb the damage", () => {
    // North to move; north's elephant can take the south lion on (2,1).
    const placements: ReadonlyArray<Placement> = [
      [2, 1, make("lion", "south")], [0, 2, make("lion", "north")], [1, 0, make("elephant", "north")],
    ];
    const survive = createRoguelikeRuleset(hpSetup(placements, { south: 15 }, { firstPlayer: "north" }));
    const fatal = createRoguelikeRuleset(hpSetup(placements, { south: 10 }, { firstPlayer: "north" }));
    const survives = createEvaluator(survive, standardClassicProfile).extractFeatures(survive.createInitialState(), "south");
    const dies = createEvaluator(fatal, standardClassicProfile).extractFeatures(fatal.createInitialState(), "south");
    expect(survives).toMatchObject({ lionThreat: -1, lionCapture: 0 });
    expect(dies).toMatchObject({ lionThreat: 0, lionCapture: -1 });
  });

  it("does not hand over its lion for a chick when that costs 10 HP", () => {
    const setup = hpSetup([
      [3, 1, make("lion", "south")], [0, 2, make("lion", "north")],
      [2, 1, make("chick", "north")], [1, 0, make("elephant", "north")],
    ]);
    const ruleset = createRoguelikeRuleset(setup);
    for (const depth of [1, 2]) {
      const ai = createAiOpponent(ruleset, { profile: { ...standardClassicProfile, searchDepth: depth }, perspective: "south", seed: 1 });
      expect(key(ai.chooseMove(ruleset.createInitialState()).action!)).not.toBe(key(move(3, 1, 2, 1)));
    }
  });

  it("plays every run stage to a finished battle", () => {
    let run = startRun(3);
    for (let stage = 0; stage < STAGES.length; stage += 1) {
      run = { ...run, stageIndex: stage };
      const ruleset = createRoguelikeRuleset(battleSetup(run));
      const depth = Math.min(STAGES[stage].aiDepth, 2);
      const players = {
        south: createAiOpponent(ruleset, { profile: { ...standardClassicProfile, searchDepth: 2 }, perspective: "south", seed: stage + 1 }),
        north: createAiOpponent(ruleset, { profile: { ...standardClassicProfile, searchDepth: depth }, perspective: "north", seed: stage + 7 }),
      };
      let state = ruleset.createInitialState();
      for (let ply = 0; ply < 300 && state.result.type === "playing"; ply += 1) {
        const { action } = players[state.turn].chooseMove(state);
        expect(ruleset.legalActions(state).map(key)).toContain(key(action!));
        state = ruleset.applyAction(state, action!);
        expect(state.hq!.north.hp).toBeGreaterThanOrEqual(0);
        expect(state.hq!.south.hp).toBeGreaterThanOrEqual(0);
      }
      expect(state.result.type, `stage ${stage + 1} did not finish`).not.toBe("playing");
    }
  });
});
