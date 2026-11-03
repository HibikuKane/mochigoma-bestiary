import { describe, expect, it } from "vitest";
import { toIndex, type GameState, type Piece } from "../src/core/model";
import { createRoguelikeRuleset } from "../src/rules/roguelike";
import { battleSetup, chooseReward, currentStage, finishBattle, startRun, type RunState } from "../src/run/run";
import { REWARD_KINDS, STAGES } from "../src/run/stages";
import { createAiOpponent, standardClassicProfile } from "../src/ai";

function at(state: { board: ReadonlyArray<Piece | null> }, row: number, column: number): Piece | null {
  return state.board[toIndex({ row, column })];
}

function winAndPick(run: RunState, option: number): RunState {
  return chooseReward(finishBattle(run, { type: "win", winner: "south", reason: "capture" }), option);
}

describe("run flow", () => {
  it("starts with the original four pieces at battle 1", () => {
    const run = startRun(1);
    expect(run.phase).toBe("battle");
    expect(run.stageIndex).toBe(0);
    expect(run.roster.map((piece) => piece.kind).sort()).toEqual(["chick", "elephant", "giraffe", "lion"]);
  });

  it("places the roster on the original squares and the first enemy with fewer pieces", () => {
    const setup = battleSetup(startRun(1));
    expect(at(setup, 3, 0)).toMatchObject({ kind: "giraffe", owner: "south" });
    expect(at(setup, 3, 1)).toMatchObject({ kind: "lion", owner: "south" });
    expect(at(setup, 3, 2)).toMatchObject({ kind: "elephant", owner: "south" });
    expect(at(setup, 2, 1)).toMatchObject({ kind: "chick", owner: "south" });
    expect(setup.hands.south).toEqual([]);
    const enemies = setup.board.filter((piece) => piece?.owner === "north");
    const players = setup.board.filter((piece) => piece?.owner === "south");
    expect(enemies.length).toBeLessThan(players.length);
    expect(at(setup, 0, 1)).toMatchObject({ kind: "lion", owner: "north" });
  });

  it("offers three base-piece rewards after a win", () => {
    const run = finishBattle(startRun(1), { type: "win", winner: "south", reason: "try" });
    expect(run.phase).toBe("reward");
    expect(run.rewardOptions).toEqual(REWARD_KINDS);
    expect(run.rewardOptions).toHaveLength(3);
  });

  it("adds the chosen reward to the roster and starts the next battle with it in hand", () => {
    const run = winAndPick(startRun(1), 1);
    expect(run.phase).toBe("battle");
    expect(run.stageIndex).toBe(1);
    expect(run.rewardHistory).toEqual(["giraffe"]);
    const setup = battleSetup(run);
    expect(setup.hands.south.map((piece) => piece.kind)).toEqual(["giraffe"]);
    expect(at(setup, 3, 0)).toMatchObject({ kind: "giraffe" });
  });

  it("issues deterministic, unique ids", () => {
    const first = winAndPick(winAndPick(startRun(1), 0), 0);
    const second = winAndPick(winAndPick(startRun(99), 0), 0);
    expect(first.roster.map((piece) => piece.id)).toEqual(second.roster.map((piece) => piece.id));
    const setup = battleSetup(first);
    const ids = [...setup.board.filter(Boolean), ...setup.hands.south, ...setup.hands.north].map((piece) => piece!.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ends the run on a loss, and on a draw as a loss", () => {
    const lost = finishBattle(startRun(1), { type: "win", winner: "north", reason: "capture" });
    expect(lost).toMatchObject({ phase: "defeat", defeat: "loss" });
    const drawn = finishBattle(startRun(1), { type: "draw", reason: "repetition" });
    expect(drawn).toMatchObject({ phase: "defeat", defeat: "draw" });
  });

  it("clears the run after winning the last battle", () => {
    let run = startRun(1);
    for (let stage = 0; stage < STAGES.length - 1; stage += 1) run = winAndPick(run, 0);
    expect(currentStage(run).tier).toBe("boss");
    expect(finishBattle(run, { type: "win", winner: "south", reason: "capture" }).phase).toBe("victory");
  });

  it("ignores results while the battle is still going and rewards outside the reward phase", () => {
    const run = startRun(1);
    expect(finishBattle(run, { type: "playing" })).toBe(run);
    expect(chooseReward(run, 0)).toBe(run);
  });

  it("restores the roster after a battle no matter what happened on the board", () => {
    const run = startRun(1);
    const ruleset = createRoguelikeRuleset(battleSetup(run));
    // Lose the chick and promote nothing: south chick takes north chick, north lion retakes.
    let state: GameState = ruleset.createInitialState();
    state = ruleset.applyAction(state, { type: "move", from: { row: 2, column: 1 }, to: { row: 1, column: 1 } });
    state = ruleset.applyAction(state, { type: "move", from: { row: 0, column: 1 }, to: { row: 1, column: 1 } });
    expect(state.board.filter((piece) => piece?.owner === "south")).toHaveLength(3);
    const next = winAndPick(run, 2);
    const setup = battleSetup(next);
    const south = [...setup.board.filter((piece) => piece?.owner === "south"), ...setup.hands.south];
    expect(south.map((piece) => piece!.kind).sort()).toEqual(["chick", "elephant", "elephant", "giraffe", "lion"]);
  });

  it("gives every stage a valid battle that the AI can open from", () => {
    let run = startRun(1);
    for (let stage = 0; stage < STAGES.length; stage += 1) {
      const ruleset = createRoguelikeRuleset(battleSetup(run));
      const state = ruleset.createInitialState();
      expect(state.turn).toBe("south");
      const reply = ruleset.applyAction(state, ruleset.legalActions(state)[0]);
      const ai = createAiOpponent(ruleset, {
        profile: { ...standardClassicProfile, searchDepth: Math.min(currentStage(run).aiDepth, 2) },
        perspective: "north", seed: 1,
      });
      if (reply.result.type === "playing") expect(ai.chooseMove(reply).action).not.toBeNull();
      if (stage < STAGES.length - 1) run = winAndPick(run, 0);
    }
  });
});
