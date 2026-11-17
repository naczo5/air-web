import { blankLayer, blankObject, colourAlpha, composeStage, charSlotOffset, type StageSprite } from "./display";
import { hasScene, loadScene, peekScene, sceneEntrypoint } from "./sceneStore";
import { lookaheadAssets, lookaheadWithBackdrop } from "./lookahead";
import type {
  AirRuntime,
  AudioState,
  BacklogEntry,
  GameManifest,
  Instruction,
  LayerState,
  RuntimeDiagnostic,
  RuntimeEvent,
  RuntimeMode,
  RuntimeState,
  DataValue,
  RealLiveExpression,
  RealLiveInstruction,
  SceneProgram,
  StageObject,
} from "../types";

const clone = <T>(value: T): T => structuredClone(value);

const safeDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref(): void }).unref();
    }
  });

const blankAudio = (): AudioState => ({ effects: [], musicPositionMs: 0 });

const initialState = (sceneId: string): RuntimeState => ({
  sceneId,
  instructionPointer: 0,
  callStack: [],
  variables: {},
  flags: {},
  integerMemory: {},
  stringMemory: {},
  storeRegister: 0,
  textBuffer: "",
  graphicsBuffers: {},
  viewedAssets: [],
  selectionHistory: [],
  layers: Array.from({ length: 8 }, blankLayer),
  objects: {},
  audio: blankAudio(),
  backlog: [],
});

type RuntimeOptions = {
  readTextIds?: Iterable<string>;
  onTextRead?: (id: string) => void;
};

export class AirRuntimeImpl implements AirRuntime {
  private listeners = new Set<(event: RuntimeEvent) => void>();
  private runtimeMode: RuntimeMode = "normal";
  private runtimeState: RuntimeState;
  private destroyed = false;
  private executionEpoch = 0;
  /** Throttles the (more expensive) next-scene scan. */
  private prefetchTick = 0;
  private activeExecution?: Promise<void>;
  /** Voice clip for the line currently being written (`1:23:x`). */
  private pendingVoice?: string;
  /** Voice clip for the line now leaving the text buffer. */
  private activeVoice?: string;
  private readonly readTextIds: Set<string>;

  constructor(private readonly manifest: GameManifest, private readonly options: RuntimeOptions = {}) {
    const firstScene = manifest.startScene ?? Object.keys(manifest.scenes)[0] ?? "demo";
    this.runtimeState = initialState(firstScene);
    this.readTextIds = new Set(options.readTextIds);
  }

  get state(): RuntimeState {
    return this.runtimeState;
  }

  get mode(): RuntimeMode {
    return this.runtimeMode;
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  startNewGame(): void {
    const firstScene = this.manifest.startScene ?? Object.keys(this.manifest.scenes)[0];
    if (!firstScene) throw new Error("Game manifest contains no scenes");
    this.invalidateExecution();
    this.resetSceneScoped();
    this.runtimeMode = "normal";
    this.runtimeState = initialState(firstScene);
    this.emit({ type: "state", state: clone(this.runtimeState) });
  }

  save(): RuntimeState {
    return clone(this.runtimeState);
  }

  load(state: RuntimeState): void {
    if (!hasScene(this.manifest, state.sceneId)) {
      throw new Error(`Cannot load unknown scene: ${state.sceneId}`);
    }
    this.invalidateExecution();
    this.resetSceneScoped();
    this.runtimeState = {
      ...initialState(state.sceneId),
      ...clone(state),
      integerMemory: { ...(state.integerMemory ?? {}) },
      stringMemory: { ...(state.stringMemory ?? {}) },
      storeRegister: state.storeRegister ?? 0,
      textBuffer: state.textBuffer ?? "",
      graphicsBuffers: { ...(state.graphicsBuffers ?? {}) },
      viewedAssets: [...(state.viewedAssets ?? [])],
      objects: clone(state.objects ?? {}),
      selectionHistory: clone(state.selectionHistory ?? []),
    };
    this.emit({ type: "state", state: clone(this.runtimeState) });
  }

  setMode(mode: RuntimeMode): void {
    const previous = this.runtimeMode;
    this.runtimeMode = mode;
    // Keep the current text paused when skip is stopped, even during its delay.
    // Crucially this must not reset scene-scoped state: `setMode` runs on every
    // panel open, and clearing the voice slots here silently dropped the clip
    // for the line on screen (measured: 26.8% of text pauses).
    if (mode === "normal") this.cancelExecution();
    this.emit({ type: "state", state: clone(this.runtimeState) });
    if (
      (mode === "skip" || mode === "skip-read" || mode === "auto")
      && previous === "normal"
      && this.runtimeState.waiting === "text"
      && !this.runtimeState.pendingChoice
    ) {
      void this.advance();
    }
  }

  setMusicPosition(positionMs: number): void {
    this.runtimeState.audio.musicPositionMs = Math.max(0, Math.round(positionMs));
  }

  async returnToPreviousChoice(): Promise<boolean> {
    if (this.destroyed || !this.runtimeState.selectionHistory.length) return false;
    this.invalidateExecution();
    this.resetSceneScoped();
    this.restorePreviousSelection();
    await this.startExecution();
    return true;
  }

  async choose(index: number): Promise<void> {
    if (this.destroyed) return;
    if (this.activeExecution) return this.activeExecution;
    const choice = this.runtimeState.pendingChoice;
    if (!choice) return;
    const target = choice.targets?.[index];
    const storeValue = choice.storeValues?.[index];
    if (target === undefined && storeValue === undefined) return;
    this.runtimeState.pendingChoice = undefined;
    this.runtimeState.waiting = undefined;
    if (storeValue !== undefined) this.runtimeState.storeRegister = storeValue;
    if (target !== undefined) this.runtimeState.instructionPointer = target;
    await this.startExecution();
  }

  async advance(): Promise<void> {
    if (this.destroyed) return;
    // Coalesce input before clearing a text pause owned by the running loop.
    if (this.activeExecution) return this.activeExecution;
    if (this.runtimeState.waiting === "end" || this.runtimeState.waiting === "choice") return;
    if (this.runtimeState.waiting === "text") this.runtimeState.waiting = undefined;
    await this.startExecution();
  }

  dispose(): void {
    this.destroyed = true;
    this.invalidateExecution();
    this.listeners.clear();
  }

  private invalidateExecution(): void {
    this.executionEpoch += 1;
    this.activeExecution = undefined;
  }

  /**
   * Cancel in-flight execution without discarding scene-scoped state.
   * `setMode` uses this: opening a panel stops skip/auto but must NOT drop the
   * voice clip belonging to the line currently on screen.
   */
  private cancelExecution(): void {
    this.executionEpoch += 1;
    this.activeExecution = undefined;
  }

  /**
   * Clear state that belongs to a scene rather than to `RuntimeState`.
   *
   * Called when the scene actually changes (load / new game / scene jump) so
   * nothing from a dead scene leaks into the next one:
   *
   * - Voice slots: a clip queued in the old scene must not voice the new one.
   * - The object table: the engine never tears the date plate down (there are
   *   zero `1:60:2(83)` and zero `1:81:1004/1:82:1004(83)` calls in the whole
   *   script), and dated scenes gate the plate behind `$5[2]`. Without a reset,
   *   a scene that disables the date keeps displaying the *previous* scene's
   *   plate — the Sora finale showed a July plate for 93 lines. Showing no
   *   badge for the first lines of a scene is far less wrong than showing
   *   yesterday's date.
   */
  private resetSceneScoped(): void {
    this.pendingVoice = undefined;
    this.activeVoice = undefined;
    this.runtimeState.objects = {};
  }

  private isCurrentExecution(epoch: number): boolean {
    return !this.destroyed && epoch === this.executionEpoch;
  }

  private startExecution(): Promise<void> {
    const epoch = this.executionEpoch;
    // Defer execution until the guard is installed, including for event callbacks
    // that synchronously call advance() while an instruction emits text/choices.
    const execution = Promise.resolve().then(() => this.runUntilPause(epoch)).finally(() => {
      if (this.activeExecution === execution) this.activeExecution = undefined;
    });
    this.activeExecution = execution;
    return execution;
  }

  private async runUntilPause(epoch: number): Promise<void> {
    let guard = 0;
    while (this.isCurrentExecution(epoch) && !this.runtimeState.waiting && guard++ < 50000) {
      let scene = peekScene(this.manifest, this.runtimeState.sceneId);
      if (!scene) {
        try {
          scene = await loadScene(this.manifest, this.runtimeState.sceneId);
        } catch (error) {
          // A superseded execution must not report or mutate anything.
          if (!this.isCurrentExecution(epoch)) return;
          this.diagnostic("scene", [this.runtimeState.sceneId], `Failed to load scene ${this.runtimeState.sceneId}: ${(error as Error).message}`);
          this.runtimeState.waiting = "end";
          this.emit({ type: "ended" });
          this.emit({ type: "state", state: clone(this.runtimeState) });
          return;
        }
        // `load()`/`startNewGame()`/`dispose()` may have replaced the runtime
        // state while the scene fetch was in flight. Resuming here would append
        // text from the abandoned branch into the newly loaded scene.
        if (!this.isCurrentExecution(epoch)) return;
      }
      const instruction = scene?.instructions[this.runtimeState.instructionPointer];
      if (!scene || !instruction) {
        this.diagnostic("scene", [], `Instruction pointer is outside scene ${this.runtimeState.sceneId}`);
        this.runtimeState.waiting = "end";
        this.emit({ type: "ended" });
        this.emit({ type: "state", state: clone(this.runtimeState) });
        return;
      }
      const instructionId = `${this.runtimeState.sceneId}:${this.runtimeState.instructionPointer}`;
      // Text emitted by a command flush uses this same id, so consult the
      // pre-existing read set for any op, before this instruction can emit.
      const wasRead = this.readTextIds.has(instructionId);
      this.runtimeState.instructionPointer += 1;
      await this.execute(instruction);
      if (!this.isCurrentExecution(epoch)) return;
      if (
        this.runtimeState.waiting === "text"
        && (this.runtimeMode === "skip" || (this.runtimeMode === "skip-read" && wasRead))
      ) {
        await safeDelay(25);
        if (this.isCurrentExecution(epoch)) this.runtimeState.waiting = undefined;
      }
      // Each text pause is the natural moment to warm what is coming next: the
      // player is reading, the network is idle, and on a slow link this is the
      // only window in which the next backdrop or voice can arrive in time.
      if (this.runtimeState.waiting === "text") {
        this.emitPrefetch(scene);
        // Cheap enough to repeat; the UI de-duplicates by asset id.
        if (this.prefetchTick++ % 12 === 0) this.emitScenePrefetch(scene);
      }
    }
    if (guard >= 50000) {
      this.diagnostic("guard", [], "Execution guard exceeded 50,000 instructions");
    }
    if (this.isCurrentExecution(epoch)) {
      this.emit({ type: "state", state: clone(this.runtimeState) });
    }
  }

  private async execute(instruction: Instruction): Promise<void> {
    switch (instruction.op) {
      case "text": {
        // A synthetic `text` op EMITS a line directly, so it has no one-block
        // delay: the clip queued for "the line being written" applies to this
        // line, unlike the buffered path where a flush emits the previous block.
        const voice = instruction.voice ?? this.pendingVoice;
        this.pendingVoice = undefined;
        this.activeVoice = undefined;
        const entry: BacklogEntry = {
          id: `${this.runtimeState.sceneId}:${this.runtimeState.instructionPointer - 1}`,
          sceneId: this.runtimeState.sceneId,
          text: instruction.text,
          speaker: instruction.speaker,
          voice,
        };
        this.runtimeState.backlog = [...this.runtimeState.backlog.slice(-199), entry];
        this.runtimeState.audio.voice = voice;
        this.runtimeState.waiting = "text";
        if (!this.readTextIds.has(entry.id)) {
          this.readTextIds.add(entry.id);
          this.options.onTextRead?.(entry.id);
        }
        this.emit({ type: "text", entry });
        break;
      }
      case "image": {
        const layer = instruction.layer ?? 0;
        const nextLayers = this.runtimeState.layers.map((current, index) => {
          // AIR background/screen opens replace the current display stack. The
          // prepared scene stream assigns these operations to layer 0.
          return layer === 0 && index > 0 ? blankLayer() : current;
        });
        nextLayers[layer] = {
          asset: instruction.asset,
          x: instruction.x ?? 0,
          y: instruction.y ?? 0,
          alpha: instruction.alpha ?? 1,
        };
        this.runtimeState.layers = nextLayers;
        this.markAssetViewed(instruction.asset);
        break;
      }
      case "clear": {
        const layer = instruction.layer ?? 0;
        this.runtimeState.layers[layer] = blankLayer();
        break;
      }
      case "music":
        this.runtimeState.audio.music = instruction.asset;
        this.runtimeState.audio.musicLoop = instruction.loop ?? true;
        this.runtimeState.audio.musicFadeMs = instruction.fadeMs;
        this.runtimeState.audio.musicPositionMs = 0;
        break;
      case "sound":
        this.runtimeState.audio.effects = [...this.runtimeState.audio.effects.slice(-7), instruction.asset];
        break;
      case "wait":
        if (this.runtimeMode === "normal") {
          await safeDelay(Math.min(instruction.durationMs, 5000));
        }
        break;
      case "choice":
        this.rememberSelection();
        this.runtimeState.pendingChoice = { options: instruction.options, targets: instruction.targets };
        this.runtimeState.waiting = "choice";
        this.emit({ type: "choice", options: instruction.options });
        break;
      case "assign":
        this.evaluateInteger(instruction.expression);
        break;
      case "branch":
        this.executeBranch(instruction);
        break;
      case "select": {
        this.rememberSelection();
        this.runtimeState.textBuffer = "";
        const visible = instruction.options
          .map((option, index) => ({ option, index }))
          .filter(({ option }) => !option.conditions.some((condition) =>
            condition.effect === 0x32 && (condition.expression ? this.evaluateInteger(condition.expression) !== 0 : true)
          ));
        const enabled = visible.filter(({ option }) => !option.conditions.some((condition) =>
          condition.effect === 0x31 && (condition.expression ? this.evaluateInteger(condition.expression) !== 0 : true)
        ));
        const options = enabled.map(({ option }) =>
          option.textExpression ? this.evaluateStringExpression(option.textExpression) : option.text
        );
        this.runtimeState.pendingChoice = { options, storeValues: enabled.map(({ index }) => index) };
        this.runtimeState.waiting = "choice";
        this.emit({ type: "choice", options });
        break;
      }
      case "command":
        await this.executeCommand(instruction);
        break;
      case "jump":
        this.runtimeState.instructionPointer = instruction.target;
        break;
      case "scene":
        if (!hasScene(this.manifest, instruction.sceneId)) {
          this.diagnostic("scene", [instruction.sceneId], `Cannot enter unknown scene ${instruction.sceneId}`);
          this.runtimeState.waiting = "end";
          this.emit({ type: "ended" });
          break;
        }
        this.runtimeState.sceneId = instruction.sceneId;
        this.runtimeState.instructionPointer = 0;
        // A clip queued in the scene we are leaving must not voice the next one.
        this.resetSceneScoped();
        this.runtimeState.pendingChoice = undefined;
        break;
      case "set":
        if (typeof instruction.value === "boolean") this.runtimeState.flags[instruction.name] = instruction.value;
        else this.runtimeState.variables[instruction.name] = instruction.value;
        break;
      case "end":
        this.runtimeState.waiting = "end";
        this.emit({ type: "ended" });
        break;
      default:
        this.diagnostic("unknown", [instruction], "Unsupported instruction");
    }
  }

  private memoryKey(bank: number, index: number): string {
    return `${bank}:${index}`;
  }

  private evaluateInteger(expression: RealLiveExpression): number {
    switch (expression.kind) {
      case "int": return expression.value;
      case "store": return this.runtimeState.storeRegister;
      case "memory": return this.runtimeState.integerMemory[this.memoryKey(expression.bank, this.evaluateInteger(expression.index))] ?? 0;
      case "unary": return expression.op === 1 ? -this.evaluateInteger(expression.value) : this.evaluateInteger(expression.value);
      case "binary": {
        const right = this.evaluateInteger(expression.right);
        if (expression.op >= 0x14 && expression.op <= 0x1e) {
          const left = this.evaluateInteger(expression.left);
          const value = expression.op === 0x1e ? right : this.binaryValue(expression.op - 0x14, left, right);
          this.setIntegerExpression(expression.left, value);
          return value;
        }
        return this.binaryValue(expression.op, this.evaluateInteger(expression.left), right);
      }
    }
  }

  private binaryValue(op: number, left: number, right: number): number {
    switch (op) {
      case 0: return left + right;
      case 1: return left - right;
      case 2: return left * right;
      case 3: return right === 0 ? left : Math.trunc(left / right);
      case 4: return right === 0 ? left : left % right;
      case 5: return left & right;
      case 6: return left | right;
      case 7: return left ^ right;
      case 8: return left << right;
      case 9: return left >> right;
      case 0x28: return Number(left === right);
      case 0x29: return Number(left !== right);
      case 0x2a: return Number(left <= right);
      case 0x2b: return Number(left < right);
      case 0x2c: return Number(left >= right);
      case 0x2d: return Number(left > right);
      case 0x3c: return Number(Boolean(left) && Boolean(right));
      case 0x3d: return Number(Boolean(left) || Boolean(right));
      default: return 0;
    }
  }

  private setIntegerExpression(expression: RealLiveExpression, value: number) {
    if (expression.kind === "store") this.runtimeState.storeRegister = value;
    else if (expression.kind === "memory") {
      this.runtimeState.integerMemory[this.memoryKey(expression.bank, this.evaluateInteger(expression.index))] = value;
    }
  }

  private evaluateStringExpression(expression: RealLiveExpression): string {
    if (expression.kind === "memory") {
      return this.runtimeState.stringMemory[this.memoryKey(expression.bank, this.evaluateInteger(expression.index))] ?? "";
    }
    return String(this.evaluateInteger(expression));
  }

  private evaluateData(value: DataValue): string | number | Array<string | number | unknown> {
    if (value.kind === "string") return value.value;
    if (value.kind === "expression") {
      return value.value.kind === "memory" && [0x0a, 0x0c, 0x12].includes(value.value.bank)
        ? this.evaluateStringExpression(value.value)
        : this.evaluateInteger(value.value);
    }
    return value.values.map((item) => this.evaluateData(item));
  }

  private dataExpression(value: DataValue | undefined): RealLiveExpression | undefined {
    return value?.kind === "expression" ? value.value : undefined;
  }

  private dataString(value: DataValue | undefined): string {
    if (!value) return "";
    const evaluated = this.evaluateData(value);
    return Array.isArray(evaluated) ? evaluated.join("") : String(evaluated);
  }

  private dataNumber(value: DataValue | undefined): number {
    if (!value) return 0;
    const evaluated = this.evaluateData(value);
    return typeof evaluated === "number" ? evaluated : Number(evaluated) || 0;
  }

  private executeBranch(instruction: Extract<RealLiveInstruction, { op: "branch" }>) {
    const condition = instruction.expression ? this.evaluateInteger(instruction.expression) : 0;
    let target: number | undefined;
    if (instruction.kind === "goto" || instruction.kind === "gosub") target = instruction.targets[0];
    else if (instruction.kind === "gotoIf" || instruction.kind === "gosubIf") target = condition ? instruction.targets[0] : undefined;
    else if (instruction.kind === "gotoUnless" || instruction.kind === "gosubUnless") target = condition ? undefined : instruction.targets[0];
    else if (instruction.kind === "gotoOn" || instruction.kind === "gosubOn") target = instruction.targets[condition];
    else if (instruction.kind === "gotoCase" || instruction.kind === "gosubCase") {
      const index = instruction.cases?.findIndex((candidate) => candidate === undefined || this.evaluateInteger(candidate) === condition) ?? -1;
      if (index >= 0) target = instruction.targets[index];
    }
    if (target === undefined) return;
    if (instruction.kind.startsWith("gosub")) {
      this.runtimeState.callStack.push({ sceneId: this.runtimeState.sceneId, instructionPointer: this.runtimeState.instructionPointer });
    }
    this.runtimeState.instructionPointer = target;
  }

  private resolveAsset(name: string): string | undefined {
    return this.manifest.assetAliases?.[name.replace(/\.[^.]+$/, "").toUpperCase()];
  }

  /**
   * Replace one object-table entry, keeping the map immutable.
   *
   * React only re-runs the canvas paint when a prop identity changes, and the
   * runtime hands the same `objects` reference to every state event, so a
   * mutation in place would leave a stale badge on screen after the date
   * rolls over.
   */
  private writeObject(id: number, update: (object: StageObject) => StageObject) {
    if (!Number.isInteger(id) || id < 0 || id > 999) return;
    const key = String(id);
    const current = this.runtimeState.objects[key] ?? blankObject();
    this.runtimeState.objects = { ...this.runtimeState.objects, [key]: update({ ...current }) };
  }

  /**
   * RealLive's object table (`1:60`-`1:62`, `1:71`, `1:72`, `1:81`, `1:82`).
   *
   * AIR keeps two independent display stacks. The graphics-buffer commands
   * (`1:33:*`, `1:40:100`) paint the scene; this table is composited over it
   * every frame. Everything the original draws as chrome lives here: the date
   * plate in slot 83, the message-window bars 81/82, and the menu/OP animation
   * slots 0-70.
   *
   * Slot 83 is the visible payoff. Its whole lifecycle is
   * `1:62:10(83)` (link) → `1:60:1(83)` (open) → `1:72:1000(83, $18[1003], 1)`
   * (graphic) → `1:82:1000(83, 16, 16)` (position), repeated before every line
   * of 76 scenes. There is no visibility call for 83 at all, so `1:60:1` is
   * what makes it on-screen; treating it as "create, hidden" would leave the
   * badge permanently invisible.
   */
  private executeObjectCommand(instruction: Extract<RealLiveInstruction, { op: "command" }>) {
    const { module, opcode, args } = instruction;
    const id = args.length ? this.dataNumber(args[0]) : 0;
    if (module === 60) {
      if (opcode === 1) {
        // ObjOpen. Also the only visibility source for slot 83.
        this.writeObject(id, (object) => ({ ...object, visible: true }));
      } else if (opcode === 2) {
        // ObjDelete: drop the slot entirely. `1:60:1` is the only thing that
        // brings it back, and it starts from `blankObject()`, so a later
        // re-open cannot inherit stale geometry or a stale graphic.
        const key = String(id);
        if (Object.hasOwn(this.runtimeState.objects, key)) {
          const { [key]: _removed, ...rest } = this.runtimeState.objects;
          this.runtimeState.objects = rest;
        }
      } else if (opcode === 111) {
        // ObjClear, used once at the end of each OP/ED program.
        this.runtimeState.objects = {};
      }
      return;
    }
    // `1:61:10`/`1:61:11` give an animation slot its source and start it;
    // `1:62:10` links a slot to the message-window surface. Both are setup for
    // the file-backed animation slots handled below and draw nothing.
    if (module === 61 || module === 62) return;
    if (module === 71) {
      if (opcode === 1000 || opcode === 1300) {
        // File-backed animation slots: `1:71:1000` for the OP_Axx strips (81
        // sites), `1:71:1300` for the four `S_LEAF` overlays in `seen8996`.
        // Recorded for save fidelity but not painted: their motion is driven
        // by `1:81:1006` tweens and `1:4:600/610` timers this port does not
        // implement, so a still frame would be less faithful than a blank one.
        const asset = this.resolveAsset(this.dataString(args[1]));
        if (asset) this.writeObject(id, (object) => ({ ...object, asset, fromFile: true }));
      }
      return;
    }
    if (module === 72) {
      if (opcode === 1000) {
        // `(id, graphic)` for menu plates and the title background;
        // `(id, graphic, mode)` for the date plate, where mode is 1 (normal).
        const asset = this.resolveAsset(this.dataString(args[1]));
        if (asset) {
          this.markAssetViewed(asset);
          this.writeObject(id, (object) => ({ ...object, asset, fromFile: false }));
        }
      } else if (opcode === 1101) {
        // `(id, x, y, w, h, flag)` — rectangle, and the size the graphic is
        // stretched to. The 81/82 bars are (0,0,640,50) and (0,430,640,50).
        const [x, y, width, height] = [this.dataNumber(args[1]), this.dataNumber(args[2]), this.dataNumber(args[3]), this.dataNumber(args[4])];
        this.writeObject(id, (object) => ({ ...object, x, y, width, height }));
      }
      return;
    }
    if (module === 81) {
      if (opcode === 1000) {
        // Create/position. Visibility stays as it is: every real caller
        // follows with `1:81:1004`.
        const [x, y] = [this.dataNumber(args[1]), this.dataNumber(args[2])];
        this.writeObject(id, (object) => ({ ...object, x, y }));
      } else if (opcode === 1003) {
        this.writeObject(id, (object) => ({ ...object, text: this.dataString(args[1]) }));
      } else if (opcode === 1004) {
        const visible = this.dataNumber(args[1]) !== 0;
        this.writeObject(id, (object) => ({ ...object, visible }));
      } else if (opcode === 1034) {
        const [x, y, width, height] = [this.dataNumber(args[1]), this.dataNumber(args[2]), this.dataNumber(args[3]), this.dataNumber(args[4])];
        this.writeObject(id, (object) => ({ ...object, x, y, width, height }));
      } else if (opcode === 1039) {
        const animState = this.dataNumber(args[1]);
        this.writeObject(id, (object) => ({ ...object, animState }));
      }
      // 1006 (position tween) and 1031 (16-argument animation setup) are
      // recorded as no-ops: they only appear in the OP/ED programs, whose
      // timing the port does not reproduce.
      return;
    }
    if (module === 82) {
      if (opcode === 1000) {
        const [x, y] = [this.dataNumber(args[1]), this.dataNumber(args[2])];
        this.writeObject(id, (object) => ({ ...object, x, y }));
      } else if (opcode === 1004) {
        const visible = this.dataNumber(args[1]) !== 0;
        this.writeObject(id, (object) => ({ ...object, visible }));
      } else if (opcode === 1016) {
        // `(id, r, g, b, a)` — the bars get opaque black and no graphic.
        const fill = { r: this.dataNumber(args[1]), g: this.dataNumber(args[2]), b: this.dataNumber(args[3]) };
        const alpha = colourAlpha(this.dataNumber(args[4]));
        this.writeObject(id, (object) => ({ ...object, fill, alpha }));
      } else if (opcode === 1039) {
        const animState = this.dataNumber(args[1]);
        this.writeObject(id, (object) => ({ ...object, animState }));
      }
    }
  }

  private markAssetViewed(asset: string) {
    if (!this.runtimeState.viewedAssets.includes(asset)) {
      this.runtimeState.viewedAssets = [...this.runtimeState.viewedAssets, asset];
    }
  }

  private rememberSelection() {
    const { selectionHistory: _history, ...checkpoint } = clone(this.runtimeState);
    checkpoint.instructionPointer = Math.max(0, checkpoint.instructionPointer - 1);
    checkpoint.waiting = undefined;
    checkpoint.pendingChoice = undefined;
    this.runtimeState.selectionHistory = [...this.runtimeState.selectionHistory.slice(-19), checkpoint];
  }

  private restorePreviousSelection() {
    const history = this.runtimeState.selectionHistory;
    const checkpoint = history.at(-1);
    if (!checkpoint) return;
    this.runtimeState = { ...clone(checkpoint), selectionHistory: history.slice(0, -1) };
  }

  private collectStrings(values: DataValue[]): string[] {
    const result: string[] = [];
    const visit = (value: DataValue) => {
      if (value.kind === "string") result.push(value.value);
      else if (value.kind === "expression" && value.value.kind === "memory" && [0x0a, 0x0c, 0x12].includes(value.value.bank)) {
        result.push(this.evaluateStringExpression(value.value));
      } else if (value.kind === "special" || value.kind === "complex") {
        value.values.forEach(visit);
      }
    };
    values.forEach(visit);
    return result.filter(Boolean);
  }
  /**
   * Sprite arguments from `1:33:75`/`1:33:77`/`1:40:100`. Each sprite is a
   * `(name, slot)` pair, either as a tagged special value or adjacent list
   * items. Slot numbers are matched against `GAMEEXE.INI`
   * `HAIKEICHR_PARAM`, whose entries exist for slots 0-9 and 60-70.
   */
  private spriteArguments(values: DataValue[]): StageSprite[] {
    const sprites: StageSprite[] = [];
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (value.kind === "special" || value.kind === "complex") {
        let name: string | undefined = undefined;
        let slot: number | undefined = undefined;
        for (const item of value.values) {
          if (item.kind === "string" && name === undefined) name = item.value;
          else if (item.kind === "expression") {
            const number = this.evaluateInteger(item.value);
            if (slot === undefined && Number.isFinite(number) && number >= 0 && number < 200) slot = number;
          }
        }
        if (name) sprites.push({ asset: name, slot });
        continue;
      }
      if (value.kind === "string") {
        const next = values[index + 1];
        const slot = next?.kind === "expression" ? this.evaluateInteger(next.value) : undefined;
        if (slot !== undefined) index += 1;
        sprites.push({ asset: value.value, slot });
      }
    }
    return sprites;
  }

  /** `1:33:75`: buffer a backdrop plus sprites and open them together. */
  private bufferSpriteStack(values: DataValue[], fallback: string | undefined) {
    const background = values.length ? this.dataString(values[0]) : fallback ?? "";
    const sprites = this.spriteArguments(values.slice(1));
    const resolvedBackground = background ? this.resolveAsset(background) : undefined;
    if (resolvedBackground) this.runtimeState.graphicsBuffers["0"] = resolvedBackground;
    const resolved = sprites.flatMap((sprite) => {
      const asset = this.resolveAsset(sprite.asset);
      return asset ? [{ asset, slot: sprite.slot }] : [];
    });
    // Already resolved: `resolveAsset` would uppercase the `image:` prefix and
    // fail to match an alias a second time, silently dropping every sprite.
    this.paintStage(resolvedBackground, resolved);
  }


  /**
   * `1:40:100` compositor: the first asset argument is the backdrop, every
   * `sp(name, slot)` argument is a character sprite placed by the slot offsets
   * from GAMEEXE.INI (`HAIKEICHR_PARAM`).
   */
  private displayStage(background: string | undefined, sprites: StageSprite[]) {
    if (!background && !sprites.length) return;
    const resolvedBackground = background ? this.resolveAsset(background) : undefined;
    const resolvedSprites = sprites.flatMap((sprite) => {
      const asset = this.resolveAsset(sprite.asset);
      return asset ? [{ asset, slot: sprite.slot }] : [];
    });
    if (!resolvedBackground && background && !resolvedSprites.length) return;
    this.paintStage(resolvedBackground, resolvedSprites);
  }

  /** Paint an already-resolved backdrop and sprite list. */
  private paintStage(background: string | undefined, sprites: StageSprite[]) {
    const next = composeStage(this.runtimeState.layers, background, sprites);
    next.forEach((layer) => { if (layer.asset) this.markAssetViewed(layer.asset); });
    this.runtimeState.layers = next;
  }


  /** Paint an already-resolved asset id as layer 0, keeping other layers. */
  private paintBackground(asset: string) {
    this.markAssetViewed(asset);
    if (!this.runtimeState.layers.length) {
      this.runtimeState.layers = Array.from({ length: 8 }, () => blankLayer());
    }
    this.runtimeState.layers[0] = { asset, x: 0, y: 0, alpha: 1 };
  }

  /**
   * Buffered open (`1:33:72`/`1052`) and buffered replay (`1:33:77`).
   *
   * AIR's scenes buffer a background stack and then replay it; the replay is
   * what actually paints the stage. Buffers 0-3 hold backgrounds and 30+/50+
   * hold UI plates and CGs, so only the background buffers replace layer 0;
   * every other buffer opens on top of the current backdrop instead of
   * clearing it.
   */
  /**
   * Buffered open (`1:33:72`) and buffered replay (`1:33:77`).
   *
   * AIR buffers a background stack and then replays it; the replay is what
   * paints the stage. Every `1:33:77` in the shipped data names buffer 2 (see
   * `seen0163:450`, `seen0225:3686`, `seen0250:698`, `seen0311:2147`), so the
   * buffer supplies layer 0 and any `sp(name, slot)` arguments are drawn above
   * it. Buffers 30+/50+ hold UI plates and CGs, which open on top of the
   * current backdrop instead of clearing it.
   */
  private openGraphicsBuffer(buffer: number, sprites: StageSprite[] = []) {
    const asset = this.runtimeState.graphicsBuffers[String(buffer)];
    if (!asset && !sprites.length) return;
    if (asset) this.markAssetViewed(asset);
    // Buffered entries are already manifest asset ids, so paint them directly
    // instead of re-resolving them as resource names.
    if (buffer <= 3) {
      this.paintStage(asset, this.resolveSprites(sprites));
      return;
    }
    const overlay = asset ? [{ asset, slot: undefined }, ...this.resolveSprites(sprites)] : this.resolveSprites(sprites);
    this.paintStage(undefined, overlay);
  }

  private resolveSprites(sprites: StageSprite[]): StageSprite[] {
    return sprites.flatMap((sprite) => {
      const asset = this.resolveAsset(sprite.asset);
      return asset ? [{ asset, slot: sprite.slot }] : [];
    });
  }

  private emitTextBuffer() {
    const raw = this.runtimeState.textBuffer;
    this.runtimeState.textBuffer = "";
    const speakerStart = raw.indexOf("\u0001");
    const speakerEnd = speakerStart >= 0 ? raw.indexOf("\u0002", speakerStart + 1) : -1;
    const clean = (value: string) => value.replace(/[\u0000\u0003-\u001f]/g, "").replaceAll("\\n", "\n").trim();
    const speaker = speakerStart >= 0 && speakerEnd > speakerStart ? clean(raw.slice(speakerStart + 1, speakerEnd)) : undefined;
    const text = clean(speakerEnd > speakerStart ? raw.slice(speakerEnd + 1) : raw);
    // Rotate the voice slots even when this flush emits nothing. An empty
    // buffer or the SeenEnd sentinel still consumes a block, and skipping the
    // promotion there would offset every later line in the scene by one clip
    // (28 lines across 18 scenes in the shipped data).
    if (!text || /^ＳｅｅｎＥｎｄ/i.test(text)) {
      this.activeVoice = this.pendingVoice;
      this.pendingVoice = undefined;
      return;
    }
    // Voice attribution. Each script block appends the PREVIOUS line
    // (`1:10:100($18[1901])`), writes the current one (`1:10:0($18[1900], …)`)
    // and only then flushes — so a flush emits the line written in the block
    // before it. A `1:23:x` in a block therefore names the line that will be
    // emitted by the NEXT flush, verified across 12 scenes: with an immediate
    // handoff the clip matched the following block 79.6% of the time and its
    // own block 0% of the time.
    //
    // `activeVoice` is the clip for the line now leaving the buffer;
    // `pendingVoice` is the clip for the line currently being written.
    const voice = this.activeVoice;
    this.activeVoice = this.pendingVoice;
    this.pendingVoice = undefined;
    this.runtimeState.audio.voice = voice;
    const entry: BacklogEntry = {
      id: `${this.runtimeState.sceneId}:${this.runtimeState.instructionPointer - 1}`,
      sceneId: this.runtimeState.sceneId,
      text,
      speaker,
      voice,
    };
    this.runtimeState.backlog = [...this.runtimeState.backlog.slice(-499), entry];
    this.runtimeState.waiting = "text";
    if (!this.readTextIds.has(entry.id)) {
      this.readTextIds.add(entry.id);
      this.options.onTextRead?.(entry.id);
    }
    this.emit({ type: "text", entry });
  }

  private async executeCommand(instruction: Extract<RealLiveInstruction, { op: "command" }>) {
    const { moduleType, module, opcode, overload, args } = instruction;
    if (moduleType === 1 && [60, 61, 62, 71, 72, 81, 82].includes(module)) {
      this.executeObjectCommand(instruction);
      return;
    }
    if (moduleType === 2 && module === 1 && opcode === 12) {
      const subOp = this.dataNumber(args[1]);
      if (subOp === 10) {
        // rlBabel FormatText: copy input dialogue buffer strS[1900] to strS[1901]
        const raw = this.runtimeState.stringMemory[this.memoryKey(0x12, 1900)] ?? "";
        this.runtimeState.stringMemory[this.memoryKey(0x12, 1901)] = raw;
        this.runtimeState.storeRegister = 1;
      } else if (subOp === 13) {
        // rlBabel Cleanup
        this.runtimeState.storeRegister = 0;
      } else if (subOp === 12) {
        // GetLineStatus: 1 = the message loop is idle/complete, which is the
        // index that leaves via the `0:1:10` return at `seen0180:23677`. The
        // other indices handle per-frame input states this model never enters.
        // (Returning 0 selected the *error* branch, which wrote "Error:" into
        // the dialogue buffer — so 1 is correct here.)
        this.runtimeState.storeRegister = 1;
      } else {
        // Init (0), Choice (200), LineCount (21)
        this.runtimeState.storeRegister = 1;
      }
      return;
    }
    if (moduleType === 1 && module === 10) {
      if (opcode === 0) {
        const dest = this.dataExpression(args[0]);
        if (dest?.kind === "memory") {
          const index = this.evaluateInteger(dest.index);
          const value = this.dataString(args[1]).slice(0, overload === 1 ? this.dataNumber(args[2]) : undefined);
          this.runtimeState.stringMemory[this.memoryKey(dest.bank, index)] = value;
        }
      } else if (opcode === 1) {
        const dest = this.dataExpression(args[0]);
        if (dest?.kind === "memory") {
          const index = this.evaluateInteger(dest.index);
          this.runtimeState.stringMemory[this.memoryKey(dest.bank, index)] = "";
        }
      } else if (opcode === 2) {
        const dest = this.dataExpression(args[0]);
        if (dest?.kind === "memory") {
          const index = this.evaluateInteger(dest.index);
          const key = this.memoryKey(dest.bank, index);
          const base = this.runtimeState.stringMemory[key] ?? "";
          const addition = this.dataString(args[1]);
          // Self-append (`1:10:2 ($18[1900], $18[1900])`) is the engine's string
          // doubling idiom, and one scene pads a dialogue buffer with it in a
          // `$store`-controlled loop (`seen0440:1599-1602`). A wrong loop
          // condition therefore turns into unbounded concatenation that ends in
          // `RangeError: Invalid string length` — an uncatchable-looking hard
          // crash. Dialogue buffers are hundreds of bytes, so cap the growth
          // and let a broken loop degrade instead of taking the page down.
          const MAX_DIALOGUE_STRING = 1 << 20;
          const combined = base + addition;
          this.runtimeState.stringMemory[key] =
            combined.length > MAX_DIALOGUE_STRING ? combined.slice(0, MAX_DIALOGUE_STRING) : combined;
        }
      } else if (opcode === 3) {
        const dest = this.dataExpression(args[0]);
        if (dest?.kind === "memory") {
          const key = this.memoryKey(dest.bank, this.evaluateInteger(dest.index));
          this.runtimeState.storeRegister = (this.runtimeState.stringMemory[key] ?? "").length;
        }
      } else if (opcode === 4) {
        const dest = this.dataExpression(args[0]);
        if (dest?.kind === "memory") {
          const key = this.memoryKey(dest.bank, this.evaluateInteger(dest.index));
          const s1 = this.runtimeState.stringMemory[key] ?? "";
          const s2 = this.dataString(args[1]);
          this.runtimeState.storeRegister = s1 === s2 ? 0 : (s1 < s2 ? -1 : 1);
        }
      } else if (opcode === 11) {
        // str_copy / str_copy_part
        let destExpr: RealLiveExpression | undefined = undefined;
        let srcStr = "";
        if (args.length >= 3) {
          destExpr = this.dataExpression(args[0]);
          const start = this.dataNumber(args[2]);
          const len = overload === 1 ? this.dataNumber(args[3]) : undefined;
          srcStr = this.dataString(args[1]).slice(start, len !== undefined ? start + len : undefined);
        } else if (args.length === 2) {
          if (args[1]?.kind === "expression" && args[1].value?.kind === "memory") {
            destExpr = args[1].value;
            srcStr = this.dataString(args[0]);
          } else if (args[0]?.kind === "expression" && args[0].value?.kind === "memory") {
            destExpr = args[0].value;
            srcStr = this.dataString(args[1]);
          }
        }
        if (destExpr && destExpr.kind === "memory") {
          this.runtimeState.stringMemory[this.memoryKey(destExpr.bank, this.evaluateInteger(destExpr.index))] = srcStr;
        }
      } else if (opcode === 17) {
        // `1:10:17 ($5[n], $18[m], width)` formats an integer into a string.
        // The SOURCE is argument 0 and the DESTINATION is argument 1 (verified
        // across 10,552 call sites and the `1:10:0` / `1:10:2` prefix+concat
        // sequence that follows). The width argument zero-pads, which is what
        // builds plate names like `SDT0716` from prefix `SDT07` and day `16`.
        const dest = this.dataExpression(args[1]);
        if (dest?.kind === "memory") {
          const width = args[2] ? this.dataNumber(args[2]) : 0;
          const raw = String(this.dataNumber(args[0]));
          const value = Number.isFinite(width) && width > 0 ? raw.padStart(width, "0") : raw;
          this.runtimeState.stringMemory[this.memoryKey(dest.bank, this.evaluateInteger(dest.index))] = value;
        }
      } else if (opcode === 100) {
        let text = overload === 1 ? String(this.dataNumber(args[0])) : this.dataString(args[0]);
        if (!text && args[0]?.kind === "expression" && args[0].value?.kind === "memory") {
          const mem = args[0].value;
          if (mem.bank === 0x12 && this.evaluateInteger(mem.index) === 1901) {
            text = this.runtimeState.stringMemory[this.memoryKey(0x12, 1900)] ?? "";
          }
        }
        this.runtimeState.textBuffer += text;
      }
      return;
    }
    if (moduleType === 0 && module === 3) {
      if (opcode === 3) this.runtimeState.textBuffer += "\n";
      else if (opcode === 17 || opcode === 205 || opcode === 210) {
        this.emitTextBuffer();
      }
      else if (opcode === 151 || opcode === 152 || opcode === 161 || opcode === 162) this.runtimeState.textBuffer = "";
      return;
    }
    if (moduleType === 0 && module === 1) {
      if (opcode === 10 || opcode === 13 || opcode === 17 || opcode === 19) {
        const frame = this.runtimeState.callStack.pop();
        if (frame) {
          this.runtimeState.sceneId = frame.sceneId;
          this.runtimeState.instructionPointer = frame.instructionPointer;
        } else {
          this.runtimeState.waiting = "end";
          this.emit({ type: "ended" });
        }
        return;
      }
      if ([11, 12, 18].includes(opcode)) {
        const scene = this.dataNumber(args[0]);
        const entrypoint = args[1] ? this.dataNumber(args[1]) : 0;
        const sceneId = `seen${scene.toString().padStart(4, "0")}`;
        if (!hasScene(this.manifest, sceneId)) {
          this.diagnostic("scene", [sceneId], `Cannot transition to unknown scene ${sceneId}`);
          return;
        }
        if (opcode !== 11) this.runtimeState.callStack.push({ sceneId: this.runtimeState.sceneId, instructionPointer: this.runtimeState.instructionPointer });
        this.runtimeState.sceneId = sceneId;
        this.runtimeState.instructionPointer = sceneEntrypoint(this.manifest, sceneId, entrypoint) ?? 0;
        this.runtimeState.pendingChoice = undefined;
        // Voice and object state are scene-scoped; a jump must not carry either
        // into the next scene (11 = goto, 12/18 = gosub).
        this.resetSceneScoped();
        return;
      }
    }
    if (moduleType === 1 && module === 23) {
      if ([0, 1, 7, 8, 9, 10].includes(opcode)) {
        const name = `Z${this.dataNumber(args[0]).toString().padStart(9, "0")}`;
        // Names the line being written now, which the next flush emits.
        this.pendingVoice = this.resolveAsset(name);
      } else if (opcode === 5) {
        this.pendingVoice = undefined;
        this.activeVoice = undefined;
        this.runtimeState.audio.voice = undefined;
      }
      return;
    }
    if (moduleType === 1 && module === 20) {
      if (opcode === 0 || opcode === 2) {
        this.runtimeState.audio.music = this.resolveAsset(this.dataString(args[0]));
        this.runtimeState.audio.musicLoop = opcode === 0;
        this.runtimeState.audio.musicFadeMs = this.dataNumber(args[1]);
        this.runtimeState.audio.musicPositionMs = 0;
      } else if ([5, 6, 105, 106].includes(opcode)) {
        this.runtimeState.audio.musicFadeMs = this.dataNumber(args[0]);
        this.runtimeState.audio.music = undefined;
      }
      return;
    }
    if (moduleType === 1 && (module === 21 || module === 22)) {
      if ([0, 1, 2].includes(opcode)) {
        const asset = this.resolveAsset(this.dataString(args[0]));
        if (asset) this.runtimeState.audio.effects = [...this.runtimeState.audio.effects.slice(-15), asset];
      } else if ([5, 9, 10, 20, 105, 106].includes(opcode)) {
        this.runtimeState.audio.effects = [];
      }
      return;
    }
    if (moduleType === 1 && module === 33) {
      const fileName = this.dataString(args[0]);
      const asset = this.resolveAsset(fileName);
      const slotOf = (value: DataValue | undefined, fallback = 0) => {
        const number = this.dataNumber(value);
        return Number.isFinite(number) ? number : fallback;
      };
      // 50/51/70/71/1050/1051 buffer a layer. The buffer/slot is ALWAYS the
      // second argument, in both the 2-arg form `(name, buffer)` and the 8-arg
      // form `(name, buffer, x, y, ...)`. Using the trailing argument instead
      // filed entries under a coordinate (`"80"`, `"220"`), so the matching
      // `1:33:72`/`77` open by first argument could never find them.
      if ([50, 51, 70, 71, 1050, 1051].includes(opcode) && asset) {
        this.runtimeState.graphicsBuffers[String(slotOf(args[1]))] = asset;
      } else if ([72, 1052].includes(opcode)) {
        // Open a buffered layer.
        this.openGraphicsBuffer(slotOf(args[0]));
      } else if ([73, 74, 76, 1053, 1054, 1056].includes(opcode) && asset) {
        // Load into the buffer *and* open it. Background slots 0-3 replace the
        // backdrop; character slots 4+ open on top of it.
        const slot = slotOf(args[1]);
        this.runtimeState.graphicsBuffers[String(slot)] = asset;
        if (slot <= 3) this.paintBackground(asset);
        else this.openGraphicsBuffer(slot);
      } else if ([75, 1055, 1057].includes(opcode)) {
        // Load a backdrop plus character sprites in one call, then open it.
        this.bufferSpriteStack(args, asset);
      } else if (opcode === 77) {
        // Replay the buffered stack: the first argument names the background
        // buffer; later `(name, slot)` arguments are sprites drawn over it.
        const buffer = slotOf(args[0]);
        const sprites = this.spriteArguments(args.slice(1));
        this.openGraphicsBuffer(buffer, sprites);
      }
      return;
    }
    if (moduleType === 1 && module === 40 && opcode === 100) {
      // The composite stage call: first argument is the backdrop (usually the
      // string memory `$18[1000]`), later `sp(name, slot)` arguments are
      // sprites. Every argument must be evaluated, including memory reads —
      // otherwise a scene that changes backdrop *and* draws a CG keeps the
      // previous backdrop on screen.
      const background = args.length ? this.dataString(args[0]) : "";
      const sprites = this.spriteArguments(args.slice(1));
      if (background || sprites.length) this.displayStage(background || undefined, sprites);
      return;
    }
    if (moduleType === 1 && module === 4) {
      if (opcode === 100 && this.runtimeMode === "normal") {
        await safeDelay(Math.min(this.dataNumber(args[0]), 5000));
      } else if (opcode === 1200) {
        this.runtimeState.waiting = "end";
        this.emit({ type: "ended" });
      } else if (opcode === 1204 || opcode === 1205) {
        this.restorePreviousSelection();
      } else if (opcode === 1000) {
        const maximum = Math.max(1, this.dataNumber(args[0]));
        this.runtimeState.storeRegister = Math.floor(Math.random() * maximum);
      } else if (opcode === 1120) {
        this.runtimeState.storeRegister = Number.parseInt(this.runtimeState.sceneId.slice(4), 10) || 0;
      } else if (opcode === 1500) {
        this.runtimeState.storeRegister = this.manifest.galleryAssets?.length ?? 0;
      } else if (opcode === 1501) {
        const gallery = new Set(this.manifest.galleryAssets ?? []);
        this.runtimeState.storeRegister = this.runtimeState.viewedAssets.filter((asset) => gallery.has(asset)).length;
      } else if (opcode === 1502) {
        const total = this.manifest.galleryAssets?.length ?? 0;
        const gallery = new Set(this.manifest.galleryAssets ?? []);
        const viewed = this.runtimeState.viewedAssets.filter((asset) => gallery.has(asset)).length;
        this.runtimeState.storeRegister = total ? Math.floor((viewed / total) * 100) : 0;
      } else if (opcode === 1504) {
        const asset = this.resolveAsset(this.dataString(args[0]));
        this.runtimeState.storeRegister = asset && this.runtimeState.viewedAssets.includes(asset) ? 1 : 0;
      } else if (opcode === 3501) {
        // Result of the preceding `1:4:3502` text-width query. The original
        // uses it to measure a dialogue buffer and pad it: `seen0440:1599`
        // appends `strS[1900]` to itself and doubles `$store` until it reaches
        // 512. Leaving `$store` at 0 made that loop never satisfy its exit
        // (`0 * 2 === 0`), so the buffer doubled until V8 threw
        // "RangeError: Invalid string length" — a hard crash, not a stall.
        // The width query is about the current dialogue buffer, so report its
        // length, which is the value the loop is trying to grow past.
        this.runtimeState.storeRegister = (this.runtimeState.stringMemory[this.memoryKey(0x12, 1900)] ?? "").length;
      } else if (opcode === 3502) {
        // Begin a text-width query; the result arrives with `1:4:3501`.
        this.runtimeState.storeRegister = 0;
      } else if ([110, 111, 112, 114, 120, 121].includes(opcode)) {
        // Time and BGM position query opcodes (returns ms timestamp)
        // Returning a large timestamp ensures transition loops like OP/ED credits (seen8005/seen8994) advance cleanly.
        this.runtimeState.storeRegister = 999999;
      } else if ([600, 601, 610, 620, 630, 800, 1211, 1212, 2051].includes(opcode)) {
        // Transition and timer queries return 0 (completed)
        this.runtimeState.storeRegister = 0;
      } else if (opcode === 133) {
        // Input and event poll - clear status registers
        for (const arg of args) {
          const expr = this.dataExpression(arg);
          if (expr) this.setIntegerExpression(expr, 0);
        }
        this.runtimeState.storeRegister = 0;
      } else {
        this.runtimeState.storeRegister = 0;
      }
    }
  }

  private diagnostic(opcode: string, operands: unknown[], message: string): void {
    const diagnostic: RuntimeDiagnostic = {
      sceneId: this.runtimeState.sceneId,
      instructionPointer: this.runtimeState.instructionPointer,
      opcode,
      operands,
      message,
    };
    this.emit({ type: "diagnostic", diagnostic });
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /**
   * Announce the assets the next lines will need so the UI can warm them.
   * See `lookaheadAssets` for the resolution rules and why it is branch-blind.
   *
   * Called on every text pause. The window is sized in dialogue lines rather
   * than instructions because a line is ~5 instructions: a 40-instruction window
   * looks only ~8 lines ahead, which on a slow link is not enough lead time for
   * a voice range request to land before the player clicks into it.
   */
  private emitPrefetch(scene: SceneProgram): void {
    const look = lookaheadWithBackdrop(scene, this.runtimeState.instructionPointer, {
      stringMemory: this.runtimeState.stringMemory,
      resolve: (name) => this.resolveAsset(name),
    });
    if (!look.images.length && !look.audio.length) return;
    this.emit({ type: "prefetch", images: look.images, audio: look.audio });
  }

  /**
   * Warm the opening of the scene(s) this one can transition into.
   *
   * A scene change is the worst stall: the backdrop of the new scene has to
   * arrive *before* anything can be drawn, and it is the largest asset the port
   * loads (~170 KB median, up to ~940 KB). Warming the next scene's first
   * backdrop while the current scene is still playing turns that into a fetch
   * that has already finished.
   *
   * Only scenes already in memory can be scanned (the lazy store would
   * otherwise fetch a scene program just to read it), so this is opportunistic:
   * it covers the common case where the next scene was loaded by the lookahead
   * above, and does nothing when the program is not resident.
   */
  private emitScenePrefetch(scene: SceneProgram): void {
    const images: string[] = [];
    for (const instruction of scene.instructions) {
      if (instruction.op === "scene" && instruction.sceneId) {
        const next = peekScene(this.manifest, instruction.sceneId);
        if (!next) continue;
        const look = lookaheadAssets(next, 0, {
          lookahead: 30,
          maxImages: 2,
          maxAudio: 2,
          stringMemory: this.runtimeState.stringMemory,
          resolve: (name) => this.resolveAsset(name),
        });
        images.push(...look.images);
        if (images.length >= 4) break;
        continue;
      }
      if (instruction.op !== "command" || instruction.moduleType !== 0 || instruction.module !== 1) continue;
      if (![11, 18].includes(instruction.opcode)) continue;
      const first = instruction.args?.[0];
      const target = first?.kind === "expression" && first.value?.kind === "int" ? first.value.value : undefined;
      if (typeof target !== "number") continue;
      const next = peekScene(this.manifest, `seen${target.toString().padStart(4, "0")}`);
      if (!next) continue;
      const look = lookaheadAssets(next, 0, {
        lookahead: 30,
        maxImages: 2,
        maxAudio: 2,
        stringMemory: this.runtimeState.stringMemory,
        resolve: (name) => this.resolveAsset(name),
      });
      images.push(...look.images);
      if (images.length >= 4) break;
    }
    const unique = [...new Set(images)];
    if (unique.length) this.emit({ type: "prefetch", images: unique, audio: [] });
  }
}
