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

const blankLayer = (): LayerState => ({ x: 0, y: 0, alpha: 1 });

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
  private activeExecution?: Promise<void>;
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
    this.runtimeMode = "normal";
    this.runtimeState = initialState(firstScene);
    this.emit({ type: "state", state: clone(this.runtimeState) });
  }

  save(): RuntimeState {
    return clone(this.runtimeState);
  }

  load(state: RuntimeState): void {
    if (!this.manifest.scenes[state.sceneId]) {
      throw new Error(`Cannot load unknown scene: ${state.sceneId}`);
    }
    this.invalidateExecution();
    this.runtimeState = {
      ...initialState(state.sceneId),
      ...clone(state),
      integerMemory: { ...(state.integerMemory ?? {}) },
      stringMemory: { ...(state.stringMemory ?? {}) },
      storeRegister: state.storeRegister ?? 0,
      textBuffer: state.textBuffer ?? "",
      graphicsBuffers: { ...(state.graphicsBuffers ?? {}) },
      viewedAssets: [...(state.viewedAssets ?? [])],
      selectionHistory: clone(state.selectionHistory ?? []),
    };
    this.emit({ type: "state", state: clone(this.runtimeState) });
  }

  setMode(mode: RuntimeMode): void {
    const previous = this.runtimeMode;
    this.runtimeMode = mode;
    // Keep the current text paused when skip is stopped, even during its delay.
    if (mode === "normal") this.invalidateExecution();
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
      const scene = this.manifest.scenes[this.runtimeState.sceneId];
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
      if (
        this.runtimeState.waiting === "text"
        && (this.runtimeMode === "skip" || (this.runtimeMode === "skip-read" && wasRead))
      ) {
        await safeDelay(25);
        if (this.isCurrentExecution(epoch)) this.runtimeState.waiting = undefined;
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
        const entry: BacklogEntry = {
          id: `${this.runtimeState.sceneId}:${this.runtimeState.instructionPointer - 1}`,
          sceneId: this.runtimeState.sceneId,
          text: instruction.text,
          speaker: instruction.speaker,
          voice: instruction.voice,
        };
        this.runtimeState.backlog = [...this.runtimeState.backlog.slice(-199), entry];
        this.runtimeState.audio.voice = instruction.voice;
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
        if (!this.manifest.scenes[instruction.sceneId]) {
          this.diagnostic("scene", [instruction.sceneId], `Cannot enter unknown scene ${instruction.sceneId}`);
          this.runtimeState.waiting = "end";
          this.emit({ type: "ended" });
          break;
        }
        this.runtimeState.sceneId = instruction.sceneId;
        this.runtimeState.instructionPointer = 0;
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

  private displayAssets(assetIds: string[]) {
    if (!assetIds.length) return;
    const next = Array.from({ length: Math.max(8, this.runtimeState.layers.length) }, () => blankLayer());
    assetIds.slice(0, next.length).forEach((asset, index) => {
      next[index] = { asset, x: 0, y: 0, alpha: 1 };
      this.markAssetViewed(asset);
    });
    this.runtimeState.layers = next;
  }

  private displayCharacterSprites(items: Array<{ asset: string; slot?: number }>) {
    if (!items.length) {
      this.runtimeState.layers = [this.runtimeState.layers[0] ?? blankLayer(), ...Array.from({ length: 7 }, () => blankLayer())];
      return;
    }

    const hasSlot62 = items.some((item) => item.slot === 62);
    const hasSlot63 = items.some((item) => item.slot === 63);
    const isDual = items.length === 2 || (hasSlot62 && hasSlot63);

    const charLayers: LayerState[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const resolved = this.resolveAsset(item.asset);
      if (!resolved) continue;
      this.markAssetViewed(resolved);

      let x = 0;
      if (item.slot === 61) {
        x = -160;
      } else if (item.slot === 62) {
        x = isDual ? -125 : 0;
      } else if (item.slot === 63) {
        x = isDual ? 125 : 160;
      } else if (items.length === 2) {
        x = i === 0 ? -125 : 125;
      } else if (items.length === 3) {
        x = i === 0 ? -160 : (i === 1 ? 0 : 160);
      }

      charLayers.push({ asset: resolved, x, y: 0, alpha: 1 });
    }

    // Keep background on layer 0, character sprites on layers 1..n
    const bgLayer = this.runtimeState.layers[0] ?? blankLayer();
    const nextLayers: LayerState[] = [
      bgLayer,
      ...charLayers,
      ...Array.from({ length: Math.max(0, 7 - charLayers.length) }, () => blankLayer()),
    ];
    this.runtimeState.layers = nextLayers;
  }

  private displayBackground(assetId: string) {
    const resolved = this.resolveAsset(assetId);
    if (!resolved) return;
    this.markAssetViewed(resolved);
    if (!this.runtimeState.layers.length) {
      this.runtimeState.layers = Array.from({ length: 8 }, () => blankLayer());
    }
    this.runtimeState.layers[0] = { asset: resolved, x: 0, y: 0, alpha: 1 };
  }

  private emitTextBuffer() {
    const raw = this.runtimeState.textBuffer;
    this.runtimeState.textBuffer = "";
    const speakerStart = raw.indexOf("\u0001");
    const speakerEnd = speakerStart >= 0 ? raw.indexOf("\u0002", speakerStart + 1) : -1;
    const clean = (value: string) => value.replace(/[\u0000\u0003-\u001f]/g, "").replaceAll("\\n", "\n").trim();
    const speaker = speakerStart >= 0 && speakerEnd > speakerStart ? clean(raw.slice(speakerStart + 1, speakerEnd)) : undefined;
    const text = clean(speakerEnd > speakerStart ? raw.slice(speakerEnd + 1) : raw);
    if (!text || /^ＳｅｅｎＥｎｄ/i.test(text)) return;
    const entry: BacklogEntry = {
      id: `${this.runtimeState.sceneId}:${this.runtimeState.instructionPointer - 1}`,
      sceneId: this.runtimeState.sceneId,
      text,
      speaker,
      voice: this.runtimeState.audio.voice,
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
      } else {
        // Init (0), Choice (200), GetLineStatus (12), LineCount (21)
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
          const nextVal = (this.runtimeState.stringMemory[key] ?? "") + this.dataString(args[1]);
          this.runtimeState.stringMemory[key] = nextVal;
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
        const dest = this.dataExpression(args[0]);
        if (dest?.kind === "memory") {
          this.runtimeState.stringMemory[this.memoryKey(dest.bank, this.evaluateInteger(dest.index))] = String(this.dataNumber(args[1]));
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
        const target = this.manifest.scenes[sceneId];
        if (!target) {
          this.diagnostic("scene", [sceneId], `Cannot transition to unknown scene ${sceneId}`);
          return;
        }
        if (opcode !== 11) this.runtimeState.callStack.push({ sceneId: this.runtimeState.sceneId, instructionPointer: this.runtimeState.instructionPointer });
        this.runtimeState.sceneId = sceneId;
        this.runtimeState.instructionPointer = target.entrypoints?.[String(entrypoint)] ?? 0;
        this.runtimeState.pendingChoice = undefined;
        return;
      }
    }
    if (moduleType === 1 && module === 23) {
      if ([0, 1, 7, 8, 9, 10].includes(opcode)) {
        const name = `Z${this.dataNumber(args[0]).toString().padStart(9, "0")}`;
        this.runtimeState.audio.voice = this.resolveAsset(name);
      } else if (opcode === 5) this.runtimeState.audio.voice = undefined;
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
      if ([50, 51, 70, 71, 1050, 1051].includes(opcode) && asset) {
        this.runtimeState.graphicsBuffers[String(this.dataNumber(args.at(-1)))] = asset;
      } else if ([72, 1052].includes(opcode)) {
        const buffered = this.runtimeState.graphicsBuffers[String(this.dataNumber(args[0]))];
        if (buffered) this.displayAssets([buffered]);
      } else if ([73, 74, 76, 1053, 1054, 1056].includes(opcode) && asset) {
        this.displayAssets([asset]);
      } else if ([75, 77, 1055, 1057].includes(opcode)) {
        this.displayAssets(this.collectStrings(args).flatMap((name) => {
          const resolved = this.resolveAsset(name);
          return resolved ? [resolved] : [];
        }));
      }
      return;
    }
    if (moduleType === 1 && module === 40 && opcode === 100) {
      let bgAsset: string | undefined = undefined;
      const charItems: Array<{ asset: string; slot?: number }> = [];

      for (const arg of args) {
        if (arg.kind === "string") {
          if (!bgAsset && (arg.value.toUpperCase().startsWith("BG") || arg.value.toUpperCase().startsWith("FGM") || !charItems.length)) {
            bgAsset = arg.value;
          } else {
            charItems.push({ asset: arg.value });
          }
        } else if (arg.kind === "special" || arg.kind === "complex") {
          let strVal: string | undefined = undefined;
          let slotVal: number | undefined = undefined;
          for (const val of arg.values) {
            if (val.kind === "string") strVal = val.value;
            else if (val.kind === "expression") {
              const num = this.evaluateInteger(val.value);
              if (num >= 60 && num <= 69) slotVal = num;
            }
          }
          if (strVal) charItems.push({ asset: strVal, slot: slotVal });
        }
      }

      if (bgAsset) {
        this.displayBackground(bgAsset);
      }
      if (charItems.length > 0) {
        this.displayCharacterSprites(charItems);
      } else if (!bgAsset) {
        this.displayAssets(this.collectStrings(args).flatMap((name) => {
          const resolved = this.resolveAsset(name);
          return resolved ? [resolved] : [];
        }));
      }
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
}
