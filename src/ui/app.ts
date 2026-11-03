import {
  fromIndex, samePosition, toIndex,
  type GameAction, type GameState, type Piece, type PieceKind,
  type Player, type Position, type Selection,
} from "../core/model";
import type { Ruleset } from "../core/ruleset";
import { classicRuleset } from "../rules/classic";
import { createRoguelikeRuleset } from "../rules/roguelike";
import { createAiOpponent, standardClassicProfile, type SearchResult } from "../ai";
import { battleSetup, chooseReward, currentStage, finishBattle, startRun, type RunState } from "../run/run";
import { STAGES, type StageDefinition } from "../run/stages";
import { GAME_MODES, SEARCH_DEPTHS, isGameMode, isSearchDepth, type GameMode } from "./mode";
import {
  dictionaries, formatEvent, isLocale, loadLocale, localeNames, saveLocale,
  type Locale, type Messages,
} from "../i18n";

/** The AI always plays north; south stays the human seat in both modes. */
const AI_SIDE: Player = "north";

/** Let the "thinking" line paint before the search blocks the main thread,
 *  and keep the reply from feeling instantaneous. */
const AI_THINK_DELAY_MS = 120;

const GLYPHS: Record<PieceKind, string> = {
  lion: "🦁", giraffe: "🦒", elephant: "🐘", chick: "🐣", hen: "🐔",
};

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]!);
}

export interface LabAppOptions {
  /** Stage table for runs. Tests pass short ones; the game uses STAGES. */
  readonly stages?: ReadonlyArray<StageDefinition>;
}

export class LabApp {
  /**
   * The classic match and the current run battle are kept apart, so switching
   * between run mode and the classic modes never throws either one away.
   */
  private classicState: GameState = classicRuleset.createInitialState();
  private run: RunState;
  private battleRuleset: Ruleset;
  private battleState: GameState;
  private readonly stages: ReadonlyArray<StageDefinition>;
  private selection: Selection | null = null;
  private locale: Locale = loadLocale(navigator.languages, () => window.localStorage);
  private confirmRestart = false;
  private mode: GameMode = "run";
  /** Provisional development control; see SEARCH_DEPTHS. */
  private searchDepth = standardClassicProfile.searchDepth;
  private thinking = false;
  /** Bumped whenever the current match or mode changes, so a search that is
   *  already running can tell that its result no longer applies. */
  private matchToken = 0;
  private aiSeed = Date.now();
  private lastSearch: SearchResult | null = null;

  constructor(private readonly root: HTMLElement, options: LabAppOptions = {}) {
    this.stages = options.stages ?? STAGES;
    this.run = startRun(Date.now() >>> 0, this.stages);
    this.battleRuleset = createRoguelikeRuleset(battleSetup(this.run));
    this.battleState = this.battleRuleset.createInitialState();
    this.root.addEventListener("click", (event) => this.handleClick(event));
    this.root.addEventListener("change", (event) => {
      const select = event.target;
      if (!(select instanceof HTMLSelectElement)) return;
      if (select.id === "mode" && isGameMode(select.value)) {
        this.setMode(select.value);
        return;
      }
      if (select.id === "depth") {
        const depth = Number(select.value);
        if (isSearchDepth(depth)) this.setSearchDepth(depth);
        return;
      }
      if (select.id !== "language" || !isLocale(select.value)) return;
      // Language is presentation only: it must never disturb the match or a running search.
      this.locale = select.value;
      saveLocale(this.locale, () => window.localStorage);
      this.render();
    });
    this.render();
  }

  private get messages(): Messages { return dictionaries[this.locale]; }

  private get ruleset(): Ruleset {
    return this.mode === "run" ? this.battleRuleset : classicRuleset;
  }

  private get state(): GameState {
    return this.mode === "run" ? this.battleState : this.classicState;
  }

  private set state(next: GameState) {
    if (this.mode === "run") this.battleState = next;
    else this.classicState = next;
  }

  /** Apply a move and, in a run, let a finished battle advance the run. */
  private commit(next: GameState): void {
    this.state = next;
    if (this.mode === "run") this.run = finishBattle(this.run, next.result);
  }

  /** Search depth the AI uses right now: the stage's in a run, the chosen one otherwise. */
  private get aiDepth(): number {
    return this.mode === "run" ? currentStage(this.run).aiDepth : this.searchDepth;
  }

  private beginBattle(): void {
    this.battleRuleset = createRoguelikeRuleset(battleSetup(this.run));
    this.battleState = this.battleRuleset.createInitialState();
    this.matchToken += 1;
    this.thinking = false;
    this.lastSearch = null;
    this.selection = null;
    this.confirmRestart = false;
  }

  private startNewRun(): void {
    this.run = startRun(Date.now() >>> 0, this.stages);
    this.beginBattle();
  }

  private takeReward(index: number): void {
    if (this.mode !== "run" || this.run.phase !== "reward" || this.confirmRestart) return;
    const next = chooseReward(this.run, index);
    if (next === this.run) return;
    this.run = next;
    this.beginBattle();
    this.render();
  }

  /** Last AI decision, exposed for debugging and future profile balancing. */
  get lastAiSearch(): SearchResult | null { return this.lastSearch; }

  private selectedActions(): ReadonlyArray<GameAction> {
    const selection = this.selection;
    if (!selection) return [];
    return this.ruleset.legalActions(this.state).filter((action) => {
      if (selection.type === "board" && action.type === "move") return samePosition(selection.position, action.from);
      return selection.type === "hand" && action.type === "drop"
        && selection.player === action.player && selection.index === action.handIndex;
    });
  }

  /** True while the human must not touch the board: the AI is to move, or is thinking. */
  private get locked(): boolean {
    return this.thinking || this.isAiTurn();
  }

  private isAiTurn(): boolean {
    return this.mode !== "local" && this.state.result.type === "playing" && this.state.turn === AI_SIDE;
  }

  private setMode(mode: GameMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    // Discard any in-flight search. Both the classic match and the run battle
    // are kept, so switching modes never throws away a game in progress.
    this.matchToken += 1;
    this.thinking = false;
    this.selection = null;
    this.render();
  }

  /** Take effect from the AI's next move; the current one is no longer wanted. */
  private setSearchDepth(depth: number): void {
    if (depth === this.searchDepth) return;
    this.searchDepth = depth;
    this.matchToken += 1;
    this.thinking = false;
    this.render();
  }

  /**
   * Hand the position to the AI, off the current task so the UI can repaint first.
   *
   * This is called at the end of every render rather than from each event
   * handler. Scheduling from handlers meant every new path had to remember to
   * do it, and cancelling the restart prompt was a path that did not: the board
   * stayed locked on the AI's turn with nothing pending. Re-deriving "is the AI
   * owed a move?" from the state after each render removes that whole class of
   * missed wake-up.
   *
   * Re-entrancy is safe: `thinking` is set before the nested render, so the
   * render below returns from this method immediately.
   */
  private scheduleAiMove(): void {
    if (!this.isAiTurn() || this.thinking || this.confirmRestart) return;
    // Defensive: the ruleset ends the game when a player has no action, so this
    // should not happen. If it ever did, scheduling a search that returns no
    // move would re-arm itself from the next render forever.
    if (this.ruleset.legalActions(this.state).length === 0) return;
    this.thinking = true;
    const token = this.matchToken;
    this.render();
    window.setTimeout(() => this.playAiMove(token), AI_THINK_DELAY_MS);
  }

  private playAiMove(token: number): void {
    if (token !== this.matchToken) return;
    // Seeding per move keeps tie-breaking varied within a match while a whole
    // match stays reproducible from its seed.
    const seed = this.mode === "run"
      ? this.run.seed + this.run.stageIndex * 1000 + this.state.moveNumber
      : this.aiSeed + this.state.moveNumber;
    const opponent = createAiOpponent(this.ruleset, {
      profile: { ...standardClassicProfile, searchDepth: this.aiDepth },
      perspective: AI_SIDE,
      seed,
    });
    const result = opponent.chooseMove(this.state);
    // The match may have been restarted or the mode switched while we searched.
    if (token !== this.matchToken) return;

    this.thinking = false;
    this.lastSearch = result;
    this.reportSearch(result);
    if (result.action) this.commit(this.ruleset.applyAction(this.state, result.action));
    this.render();
  }

  /** Spec item 21: enough to answer "why did it think that was good?" without UI work. */
  private reportSearch(result: SearchResult): void {
    const chosen = result.action
      ? result.action.type === "move"
        ? `${result.action.from.row},${result.action.from.column} -> ${result.action.to.row},${result.action.to.column}`
        : `drop -> ${result.action.to.row},${result.action.to.column}`
      : "none";
    console.debug("[ai]", {
      move: chosen, score: result.score, depth: result.depth,
      nodes: result.nodes, elapsedMs: result.elapsedMs,
      evaluation: result.breakdown && {
        material: result.breakdown.material, mobility: result.breakdown.mobility,
        boardControl: result.breakdown.boardControl, lionSafety: result.breakdown.lionSafety,
        tryProgress: result.breakdown.tryProgress, lionCapture: result.breakdown.lionCapture,
        total: result.breakdown.total,
      },
    });
  }

  private selectBoard(position: Position): void {
    if (this.state.result.type !== "playing" || this.confirmRestart || this.locked) return;
    const action = this.selectedActions().find((candidate) => samePosition(candidate.to, position));
    if (action) {
      this.commit(this.ruleset.applyAction(this.state, action));
      this.selection = null;
      this.render();
      return;
    }
    const piece = this.state.board[toIndex(position)];
    this.selection = piece?.owner === this.state.turn ? { type: "board", position } : null;
    this.render();
  }

  private handleClick(event: MouseEvent): void {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>("button");
    if (!button || button.disabled) return;
    if (button.hasAttribute("data-reset")) {
      this.confirmRestart = this.hasProgress();
      if (!this.confirmRestart) this.reset();
      else this.render();
    } else if (button.hasAttribute("data-new-run")) {
      this.reset();
    } else if (button.dataset.rewardIndex !== undefined) {
      this.takeReward(Number(button.dataset.rewardIndex));
    } else if (button.hasAttribute("data-confirm-reset")) {
      this.reset();
    } else if (button.hasAttribute("data-cancel-reset")) {
      this.confirmRestart = false;
      this.render();
    } else if (button.dataset.cell !== undefined) {
      this.selectBoard(fromIndex(Number(button.dataset.cell)));
    } else if (button.dataset.handPlayer && !this.confirmRestart && !this.locked && this.state.result.type === "playing") {
      const player = button.dataset.handPlayer as Player;
      if (player !== this.state.turn) return;
      this.selection = { type: "hand", player, index: Number(button.dataset.handIndex) };
      this.render();
    }
  }

  /** Whether restarting would throw away something the player has played. */
  private hasProgress(): boolean {
    if (this.mode !== "run") return this.state.moveNumber > 1 && this.state.result.type === "playing";
    if (this.run.phase === "victory" || this.run.phase === "defeat") return false;
    return this.run.stageIndex > 0 || this.run.phase === "reward" || this.state.moveNumber > 1;
  }

  private reset(): void {
    if (this.mode === "run") {
      this.startNewRun();
      this.render();
      return;
    }
    // Invalidate any search still running against the previous match.
    this.matchToken += 1;
    this.thinking = false;
    this.lastSearch = null;
    this.aiSeed = Date.now();
    this.state = classicRuleset.createInitialState();
    this.selection = null;
    this.confirmRestart = false;
    this.render();
  }

  private resultText(): string {
    const { result, turn, moveNumber } = this.state;
    const m = this.messages;
    if (result.type === "playing") return m.turn(m.sides[turn], moveNumber);
    if (result.type === "draw") return m.draw;
    return m.win(m.sides[result.winner], m.reasons[result.reason]);
  }

  private pieceMarkup(piece: Piece): string {
    return `<span class="piece piece--${piece.owner}" aria-hidden="true">
      <span class="piece__glyph">${GLYPHS[piece.kind]}</span>
      <span class="piece__name">${escape(this.messages.pieces[piece.kind])}</span>
    </span>`;
  }

  private renderHand(player: Player): string {
    const m = this.messages;
    const label = m.hand(m.sides[player]);
    const content = this.state.hands[player].map((piece, index) => {
      const selected = this.selection?.type === "hand" && this.selection.player === player && this.selection.index === index;
      const disabled = player !== this.state.turn || this.state.result.type !== "playing"
        || this.confirmRestart || this.locked;
      return `<button class="hand-piece${selected ? " is-selected" : ""}"
        data-hand-player="${player}" data-hand-index="${index}" data-focus="hand-${player}-${index}"
        aria-label="${escape(m.place(m.pieces[piece.kind]))}" aria-pressed="${selected}" ${disabled ? "disabled" : ""}>
        ${this.pieceMarkup(piece)}</button>`;
    }).join("") || `<span class="hand__empty">${escape(m.emptyHand)}</span>`;
    return `<section class="hand hand--${player}" aria-label="${escape(label)}">
      <span class="hand__label">${escape(label)}</span><div class="hand__pieces">${content}</div></section>`;
  }

  private renderBoard(): string {
    const m = this.messages;
    const actions = this.selectedActions();
    const cells = this.state.board.map((piece, index) => {
      const position = fromIndex(index);
      const selected = this.selection?.type === "board" && samePosition(this.selection.position, position);
      const legal = actions.some((action) => samePosition(action.to, position));
      const occupant = piece ? `${m.sides[piece.owner]} ${m.pieces[piece.kind]}` : m.emptySquare;
      const label = m.square(position.row + 1, position.column + 1, occupant, legal);
      return `<button class="board__cell${selected ? " is-selected" : ""}${legal ? " is-legal" : ""}${legal && piece ? " is-capture" : ""}"
        data-cell="${index}" data-focus="cell-${index}" aria-label="${escape(label)}" aria-pressed="${Boolean(selected)}"
        ${this.confirmRestart || this.state.result.type !== "playing" || this.locked ? "disabled" : ""}>
        ${piece ? this.pieceMarkup(piece) : ""}</button>`;
    }).join("");
    return `<div class="board" role="group" aria-label="${escape(m.boardLabel)}">${cells}</div>`;
  }

  private selectionHint(): string {
    const m = this.messages;
    const selection = this.selection;
    if (!selection) return `<p>${escape(m.selectHint)}</p>`;
    const piece = selection.type === "board"
      ? this.state.board[toIndex(selection.position)] : this.state.hands[selection.player][selection.index];
    if (!piece) return "";
    const hint = this.selectedActions().length === 0 ? m.noTargets
      : selection.type === "hand" ? m.dropHint : m.movement[piece.kind];
    return `<strong>${escape(m.selected(m.pieces[piece.kind]))}</strong><p>${escape(hint)}</p>`;
  }

  private modeLine(): string {
    const m = this.messages;
    if (this.mode === "run") return m.modeRun;
    return this.mode === "ai" ? m.modeAi : m.mode;
  }

  private renderRunStatus(): string {
    const m = this.messages;
    const stage = currentStage(this.run);
    const label = m.stage(this.run.stageIndex + 1, this.run.stages.length, m.tiers[stage.tier]);
    const roster = this.run.roster.map((piece) =>
      `<li title="${escape(m.pieces[piece.kind])}"><span aria-hidden="true">${GLYPHS[piece.kind]}</span><span class="visually-hidden">${escape(m.pieces[piece.kind])}</span></li>`).join("");
    return `<section class="run-status" aria-label="${escape(label)}">
      <strong class="run-status__stage">${escape(label)}</strong>
      <div class="run-status__roster"><span>${escape(m.roster)}</span><ul>${roster}</ul></div>
    </section>`;
  }

  private renderRunPanel(): string {
    const m = this.messages;
    const run = this.run;
    if (run.phase === "battle") return "";
    if (run.phase === "reward") {
      const options = run.rewardOptions.map((kind, index) => `<button class="reward" data-reward-index="${index}"
        data-focus="reward-${index}" aria-label="${escape(m.takeReward(m.pieces[kind]))}" ${this.confirmRestart ? "disabled" : ""}>
        <span class="reward__glyph" aria-hidden="true">${GLYPHS[kind]}</span>
        <span class="reward__text"><strong>${escape(m.pieces[kind])}</strong><span>${escape(m.movement[kind])}</span></span>
      </button>`).join("");
      return `<section class="run-panel" aria-label="${escape(m.rewardTitle)}">
        <h3>${escape(m.rewardTitle)}</h3><p>${escape(m.rewardHint)}</p>
        <div class="run-panel__rewards">${options}</div></section>`;
    }
    const message = run.phase === "victory" ? m.runVictory(run.stages.length)
      : run.defeat === "draw" ? m.runDraw(run.stageIndex + 1) : m.runDefeat(run.stageIndex + 1);
    return `<section class="run-panel run-panel--${run.phase}" aria-label="${escape(message)}">
      <h3>${escape(message)}</h3>
      <button class="run-panel__new" data-new-run data-focus="new-run" ${this.confirmRestart ? "disabled" : ""}>${escape(m.newRun)}</button></section>`;
  }

  private render(): void {
    const m = this.messages;
    const focused = document.activeElement?.getAttribute("data-focus");
    const helpOpen = this.root.querySelector<HTMLDetailsElement>("details")?.open ?? false;
    const restartLabel = this.mode === "run" ? m.newRun : m.restart;
    const restartQuestion = this.mode === "run" ? m.restartRunQuestion : m.restartQuestion;
    document.documentElement.lang = this.locale;
    document.title = m.title;
    document.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute("content", m.description);
    this.root.innerHTML = `<main class="shell">
      <header class="topbar">
        <div><p class="brand">MOCHIGOMA BESTIARY</p><h1>${escape(m.title)}</h1><p class="mode">${escape(this.modeLine())}</p></div>
        <div class="topbar__controls">
          <div class="mode-control"><label for="mode">${escape(m.modeLabel)}</label>
            <select id="mode" data-focus="mode">${GAME_MODES.map((mode) =>
              `<option value="${mode}" ${mode === this.mode ? "selected" : ""}>${escape(m.modes[mode])}</option>`).join("")}</select>
          </div>
          ${this.mode === "ai" ? `<div class="depth-control"><label for="depth">${escape(m.depthLabel)}</label>
            <select id="depth" data-focus="depth">${SEARCH_DEPTHS.map((depth) =>
              `<option value="${depth}" ${depth === this.searchDepth ? "selected" : ""}>${depth}</option>`).join("")}</select>
          </div>` : ""}
          <div class="language-control"><label for="language">${escape(m.language)}</label>
            <select id="language" data-focus="language">${Object.entries(localeNames).map(([locale, name]) =>
              `<option value="${locale}" lang="${locale}" ${locale === this.locale ? "selected" : ""}>${name}</option>`).join("")}</select>
          </div>
        </div>
      </header>
      <div class="play-layout">
        <section class="game" aria-label="${escape(m.title)}">
          <div class="game__status"><div role="status" aria-live="polite" aria-atomic="true">
            <h2 class="game__turn">${escape(this.resultText())}</h2>
            <p class="game__event">${escape(formatEvent(this.state.lastEvent, m))}</p>
            ${this.thinking ? `<p class="game__thinking">${escape(m.aiThinking)}</p>` : ""}
          </div><button class="reset-button" data-reset data-focus="reset">${escape(restartLabel)}</button></div>
          ${this.confirmRestart ? `<section class="restart-prompt" aria-label="${escape(restartQuestion)}">
            <p>${escape(restartQuestion)}</p><div>
              <button data-cancel-reset data-focus="cancel-reset">${escape(m.cancel)}</button>
              <button data-confirm-reset data-focus="confirm-reset">${escape(restartLabel)}</button>
            </div></section>` : ""}
          ${this.mode === "run" ? this.renderRunStatus() : ""}
          ${this.renderHand("north")}${this.renderBoard()}${this.renderHand("south")}
          ${this.mode === "run" ? this.renderRunPanel() : ""}
          <div class="selection-hint" aria-live="polite">${this.state.result.type === "playing" ? this.selectionHint() : `<p>${escape(this.resultText())}</p>`}</div>
        </section>
        <aside class="guide"><details ${helpOpen ? "open" : ""}><summary data-focus="help">${escape(m.helpTitle)}</summary>
          <ol>${(this.mode === "run" ? m.runHelp : [...m.help, ...(this.mode === "ai" ? [m.aiHelp, m.depthHelp] : [])])
            .map((text) => `<li>${escape(text)}</li>`).join("")}</ol>
          <ul class="piece-guide">${Object.entries(m.pieces).map(([kind, name]) => `<li>
            <span aria-hidden="true">${GLYPHS[kind as PieceKind]}</span><div><strong>${escape(name)}</strong>
            <p>${escape(m.movement[kind as PieceKind])}</p></div></li>`).join("")}</ul>
        </details></aside>
      </div>
    </main>`;
    if (focused) {
      const next = Array.from(this.root.querySelectorAll<HTMLElement>("[data-focus]")).find((element) => element.dataset.focus === focused);
      (next ?? this.root.querySelector<HTMLElement>("[data-reset]"))?.focus({ preventScroll: true });
    }
    // The screen now matches the state, so decide from that state alone whether
    // the AI still owes a move. No caller has to remember to ask.
    this.scheduleAiMove();
  }
}
