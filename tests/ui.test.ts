// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LabApp } from "../src/ui/app";
import { standardClassicProfile } from "../src/ai";
import type { StageDefinition } from "../src/run/stages";

/** These suites exercise the classic baseline, so they start from the two-player mode. */
function mount(): { root: HTMLElement; app: LabApp } {
  const root = document.createElement("div");
  document.body.append(root);
  const app = new LabApp(root);
  // Pin the locale so assertions do not depend on the test environment's languages.
  choose(root, "language", "ko");
  choose(root, "mode", "local");
  return { root, app };
}

function click(root: HTMLElement, selector: string): void {
  const button = root.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`no element for ${selector}`);
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function choose(root: HTMLElement, id: string, value: string): void {
  const select = root.querySelector<HTMLSelectElement>(`#${id}`);
  if (!select) throw new Error(`no select #${id}`);
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Play one south move by taking the first piece that has a legal target. */
function playSouthMove(root: HTMLElement): void {
  const cells = Array.from(root.querySelectorAll<HTMLButtonElement>(".board__cell"));
  for (const cell of cells) {
    if (cell.disabled || !cell.querySelector(".piece--south")) continue;
    cell.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const target = root.querySelector<HTMLButtonElement>(".board__cell.is-legal");
    if (target) {
      target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return;
    }
  }
  throw new Error("no legal south move found");
}

function playableCells(root: HTMLElement): number {
  return Array.from(root.querySelectorAll<HTMLButtonElement>(".board__cell"))
    .filter((cell) => !cell.disabled).length;
}

function turnText(root: HTMLElement): string {
  return root.querySelector(".game__turn")?.textContent?.trim() ?? "";
}

describe("AI turn lifecycle in the UI", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; });

  it("resumes the AI turn after a restart prompt is cancelled", () => {
    const { root } = mount();
    // Two-player mode: south moves, so it is now north's turn.
    playSouthMove(root);
    expect(turnText(root)).toContain("북쪽");

    // Open the restart prompt, switch to AI mode while it is open, then cancel.
    click(root, "[data-reset]");
    expect(root.querySelector(".restart-prompt")).not.toBeNull();
    choose(root, "mode", "ai");
    click(root, "[data-cancel-reset]");

    vi.runAllTimers();

    // The AI owed a move here. It must have played it, handing the turn back.
    expect(turnText(root)).toContain("남쪽");
    expect(playableCells(root)).toBeGreaterThan(0);
  });

  it("locks the board while the AI is to move and unlocks it afterwards", () => {
    const { root } = mount();
    choose(root, "mode", "ai");
    playSouthMove(root);
    expect(playableCells(root)).toBe(0);
    vi.runAllTimers();
    expect(turnText(root)).toContain("남쪽");
    expect(playableCells(root)).toBeGreaterThan(0);
  });

  it("does not apply a search started before a restart to the new match", () => {
    const { root } = mount();
    choose(root, "mode", "ai");
    playSouthMove(root);
    const movesBeforeRestart = turnText(root);
    // Restart while the AI is still thinking.
    click(root, "[data-reset]");
    click(root, "[data-confirm-reset]");
    vi.runAllTimers();
    expect(movesBeforeRestart).toContain("북쪽");
    // A fresh match is south to move at move 1, and the discarded AI reply must not appear.
    expect(turnText(root)).toContain("1");
    expect(turnText(root)).toContain("남쪽");
  });

  it("keeps the two-player baseline working with no AI involvement", () => {
    const { root } = mount();
    playSouthMove(root);
    vi.runAllTimers();
    expect(turnText(root)).toContain("북쪽");
    expect(playableCells(root)).toBeGreaterThan(0);
  });
});

describe("search depth control", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; });

  it("is offered only while playing the AI", () => {
    const { root } = mount();
    expect(root.querySelector("#depth")).toBeNull();
    choose(root, "mode", "ai");
    expect(root.querySelector("#depth")).not.toBeNull();
    choose(root, "mode", "local");
    expect(root.querySelector("#depth")).toBeNull();
  });

  it("defaults to the standard profile's depth", () => {
    const { root, app } = mount();
    choose(root, "mode", "ai");
    expect(root.querySelector<HTMLSelectElement>("#depth")?.value)
      .toBe(String(standardClassicProfile.searchDepth));
    playSouthMove(root);
    vi.runAllTimers();
    expect(app.lastAiSearch?.depth).toBe(standardClassicProfile.searchDepth);
  });

  it("makes the AI search at the chosen depth", () => {
    const { root, app } = mount();
    choose(root, "mode", "ai");
    choose(root, "depth", "1");
    playSouthMove(root);
    vi.runAllTimers();
    expect(app.lastAiSearch?.depth).toBe(1);

    choose(root, "depth", "3");
    playSouthMove(root);
    vi.runAllTimers();
    expect(app.lastAiSearch?.depth).toBe(3);
  });

  it("discards a search that was already running at the old depth", () => {
    const { root, app } = mount();
    choose(root, "mode", "ai");
    playSouthMove(root);
    // The depth 4 search is scheduled but has not run yet.
    choose(root, "depth", "2");
    vi.runAllTimers();
    expect(app.lastAiSearch?.depth).toBe(2);
    expect(turnText(root)).toContain("남쪽");
  });
});

describe("roguelike run in the UI", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; });

  /** South's giraffe on (3,0) can take this lion on its first move. */
  const quickWin: StageDefinition = {
    id: "test-win", tier: "normal", enemyBoard: [{ row: 2, column: 0, kind: "lion" }], enemyHand: [], aiDepth: 1,
  };
  /** The north giraffe on (1,0) covers (2,0), where south's lion can step. */
  const trap: StageDefinition = {
    id: "test-trap", tier: "boss",
    enemyBoard: [{ row: 0, column: 1, kind: "lion" }, { row: 1, column: 0, kind: "giraffe" }],
    enemyHand: [], aiDepth: 1,
  };

  function mountRun(stages?: ReadonlyArray<StageDefinition>): HTMLElement {
    const root = document.createElement("div");
    document.body.append(root);
    new LabApp(root, stages ? { stages } : {});
    choose(root, "language", "ko");
    return root;
  }

  function tap(root: HTMLElement, cell: number): void {
    click(root, `[data-cell="${cell}"]`);
  }

  function stageText(root: HTMLElement): string {
    return root.querySelector(".run-status__stage")?.textContent ?? "";
  }

  it("opens in run mode at the first battle with the starting roster", () => {
    const root = mountRun();
    expect(root.querySelector<HTMLSelectElement>("#mode")?.value).toBe("run");
    expect(root.querySelector(".brand")?.textContent).toBe("MOCHIGOMA BESTIARY");
    expect(stageText(root)).toContain("전투 1/4");
    expect(root.querySelectorAll(".run-status__roster li")).toHaveLength(4);
    expect(root.querySelector("#depth")).toBeNull();
    const enemies = root.querySelectorAll(".board .piece--north").length;
    const mine = root.querySelectorAll(".board .piece--south").length;
    expect(enemies).toBeLessThan(mine);
  });

  it("offers rewards after a win and starts the next battle with the reward in hand", () => {
    const root = mountRun([quickWin, quickWin]);
    tap(root, 9);
    tap(root, 6);
    expect(root.querySelectorAll("[data-reward-index]")).toHaveLength(3);

    click(root, '[data-reward-index="1"]');
    expect(stageText(root)).toContain("전투 2/2");
    expect(root.querySelectorAll(".hand--south .hand-piece")).toHaveLength(1);
    expect(root.querySelectorAll(".run-status__roster li")).toHaveLength(5);

    tap(root, 9);
    tap(root, 6);
    expect(root.querySelector(".run-panel--victory")).not.toBeNull();
    click(root, "[data-new-run]");
    expect(stageText(root)).toContain("전투 1/2");
    expect(root.querySelectorAll(".hand--south .hand-piece")).toHaveLength(0);
    expect(root.querySelectorAll(".run-status__roster li")).toHaveLength(4);
  });

  it("ends the run when the AI takes a lion left in danger", () => {
    const root = mountRun([trap]);
    tap(root, 10);
    tap(root, 6);
    vi.runAllTimers();
    expect(root.querySelector(".run-panel--defeat")?.textContent).toContain("전투 1");
    expect(root.querySelectorAll("[data-reward-index]")).toHaveLength(0);
  });

  it("keeps the run battle and the classic game apart when switching modes", () => {
    const root = mountRun();
    playSouthMove(root);
    choose(root, "mode", "local");
    expect(turnText(root)).toContain("1수");
    expect(root.querySelector(".run-status")).toBeNull();
    choose(root, "mode", "run");
    expect(turnText(root)).toContain("북쪽");
    vi.runAllTimers();
    expect(turnText(root)).toContain("남쪽");
    expect(turnText(root)).toContain("3수");
  });

  it("keeps the reward choice on screen across a language switch", () => {
    const root = mountRun([quickWin, quickWin]);
    tap(root, 9);
    tap(root, 6);
    choose(root, "language", "ja");
    expect(root.querySelectorAll("[data-reward-index]")).toHaveLength(3);
    expect(root.querySelector(".run-panel h3")?.textContent).toContain("勝利");
  });

  it("asks before abandoning a run in progress", () => {
    const root = mountRun([quickWin, quickWin]);
    tap(root, 9);
    tap(root, 6);
    click(root, '[data-reward-index="0"]');
    click(root, "[data-reset]");
    expect(root.querySelector(".restart-prompt")?.textContent).toContain("런을 포기");
    click(root, "[data-confirm-reset]");
    expect(stageText(root)).toContain("전투 1/2");
  });
});
