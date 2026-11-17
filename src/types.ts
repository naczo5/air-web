export type AssetKind = "image" | "audio" | "voice" | "font";

export type AssetRef = {
  id: string;
  kind: AssetKind;
  url: string;
  width?: number;
  height?: number;
  durationMs?: number;
  loop?: boolean;
  codec?: string;
  source?: string;
};

export type AssetManifest = Record<string, AssetRef>;

export type RealLiveExpression =
  | { kind: "int"; value: number }
  | { kind: "store" }
  | { kind: "memory"; bank: number; index: RealLiveExpression }
  | { kind: "unary"; op: number; value: RealLiveExpression }
  | { kind: "binary"; op: number; left: RealLiveExpression; right: RealLiveExpression };

export type DataValue =
  | { kind: "string"; value: string }
  | { kind: "expression"; value: RealLiveExpression }
  | { kind: "complex"; values: DataValue[] }
  | { kind: "special"; tag: number; values: DataValue[] };

export type RealLiveInstruction =
  | { op: "text"; offset: number; text: string; voice?: string; speaker?: string }
  | { op: "assign"; offset: number; expression: RealLiveExpression }
  | {
      op: "branch";
      offset: number;
      moduleType: number;
      module: number;
      opcode: number;
      argc: number;
      overload: number;
      kind: "goto" | "gotoIf" | "gotoUnless" | "gotoOn" | "gotoCase" | "gosub" | "gosubIf" | "gosubUnless" | "gosubOn" | "gosubCase";
      expression?: RealLiveExpression;
      targets: number[];
      cases?: Array<RealLiveExpression | undefined>;
    }
  | {
      op: "select";
      offset: number;
      moduleType: number;
      module: number;
      opcode: number;
      argc: number;
      overload: number;
      window?: RealLiveExpression;
      options: Array<{ text: string; textExpression?: RealLiveExpression; conditions: Array<{ expression?: RealLiveExpression; effect: number; argument?: RealLiveExpression }> }>;
    }
  | { op: "command"; offset: number; moduleType: number; module: number; opcode: number; argc: number; overload: number; args: DataValue[] };

export type Instruction =
  | { op: "text"; text: string; voice?: string; speaker?: string }
  | { op: "image"; asset: string; layer?: number; x?: number; y?: number; alpha?: number }
  | { op: "clear"; layer?: number }
  | { op: "music"; asset?: string; loop?: boolean; fadeMs?: number }
  | { op: "sound"; asset: string }
  | { op: "wait"; durationMs: number }
  | { op: "choice"; options: string[]; targets: number[] }
  | { op: "jump"; target: number }
  | { op: "scene"; sceneId: string }
  | { op: "set"; name: string; value: number | string | boolean }
  | { op: "end" }
  | RealLiveInstruction;

export type SceneProgram = {
  id: string;
  title?: string;
  instructions: Instruction[];
  entry?: number;
  entrypoints?: Record<string, number>;
};

export type FlowchartNode = {
  id: string;
  sceneId: string;
  instruction: number;
  label: string;
  /** Story date caption from the scene title, e.g. "July 17 (Monday)". */
  date?: string;
  /** Which story entry reaches this node, used for the arc filter. */
  arc?: string;
  kind?: "scene" | "choice" | "ending";
  /** For choice nodes: the option labels, in child order. */
  options?: string[];
  /**
   * Graphic name (resolved through `assetAliases`) of the first backdrop the
   * scene paints. Recorded while preparing so the chart never has to read a
   * scene program, which lazy packed builds do not have in memory.
   */
  thumb?: string;
};

export type FlowchartEdge = {
  from: string;
  to: string;
  label?: string;
  /**
   * Where the transition happens inside `from`. Choice edges point at the
   * choice node; scene exits record the instruction that performs the jump.
   */
  instruction?: number;
  option?: number;
};

export type FlowchartManifest = {
  nodes: FlowchartNode[];
  edges: FlowchartEdge[];
};

export type GameManifest = {
  id: "air-se";
  title: string;
  logicalSize: { width: number; height: number };
  startScene?: string;
  scenes: Record<string, SceneProgram>;
  assets: AssetManifest;
  assetAliases?: Record<string, string>;
  galleryAssets?: string[];
  flowchart: FlowchartManifest;
  generatedAt: string;
  sourceSummary?: {
    fileCount: number;
    totalBytes: number;
    seenEntries: number;
  };
};

export type LayerState = {
  asset?: string;
  x: number;
  y: number;
  alpha: number;
};

/**
 * One entry of RealLive's on-screen object table.
 *
 * AIR drives this layer instead of the graphics-buffer stack for anything that
 * floats over the scene: the date plate (object 83), the two message-window
 * bars (81/82) and the menu/OP animation slots (0-70). `1:60:1` creates an
 * object, `1:72:1000` assigns its graphic, `1:72:1101`/`1:81:1034` its
 * rectangle, `1:82:1000`/`1:81:1000` its position, `1:81:1004`/`1:82:1004` its
 * visibility and `1:82:1016` its colour and alpha.
 *
 * `asset` is an already-resolved manifest asset id, never a URL: packed builds
 * serve object graphics as byte ranges through `AssetLoader`.
 */
export type StageObject = {
  asset?: string;
  x: number;
  y: number;
  /** Rectangle from `1:72:1101`/`1:81:1034`; absent means the graphic's natural size. */
  width?: number;
  height?: number;
  visible: boolean;
  /** 0-1, from the alpha byte of `1:82:1016`. */
  alpha: number;
  /** Solid fill for objects that carry no graphic (the 81/82 window bars). */
  fill?: { r: number; g: number; b: number };
  /** `1:81:1003` label text. Recorded for save fidelity; the DOM owns text. */
  text?: string;
  /** `1:81:1039`/`1:82:1039` animation state. Non-zero means engine-animated. */
  animState?: number;
  /**
   * True when the graphic was attached by `1:71:1000` (a file-backed animation
   * slot) rather than `1:72:1000` (a direct `ObjSet`). Only the menu and OP
   * programs use the file form, and they place those slots with tween/keyframe
   * commands this port does not implement.
   */
  fromFile?: boolean;
};

export type AudioState = {
  music?: string;
  musicLoop?: boolean;
  musicFadeMs?: number;
  voice?: string;
  effects: string[];
  musicPositionMs: number;
};

export type BacklogEntry = {
  id: string;
  sceneId: string;
  text: string;
  speaker?: string;
  voice?: string;
};

export type RuntimeState = {
  sceneId: string;
  instructionPointer: number;
  callStack: Array<{ sceneId: string; instructionPointer: number }>;
  variables: Record<string, number | string>;
  flags: Record<string, boolean | number>;
  integerMemory: Record<string, number>;
  stringMemory: Record<string, string>;
  storeRegister: number;
  textBuffer: string;
  graphicsBuffers: Record<string, string>;
  viewedAssets: string[];
  /**
   * RealLive object table keyed by object id. Composites above the scene
   * layers; see `StageObject` for the opcodes that maintain it.
   */
  objects: Record<string, StageObject>;
  selectionHistory: RuntimeCheckpoint[];
  layers: LayerState[];
  audio: AudioState;
  backlog: BacklogEntry[];
  waiting?: "text" | "choice" | "timer" | "end";
  pendingChoice?: { options: string[]; targets?: number[]; storeValues?: number[] };
};

export type RuntimeCheckpoint = Omit<RuntimeState, "selectionHistory">;

export type RuntimeMode = "normal" | "skip" | "skip-read" | "auto";

export type RuntimeEvent =
  | { type: "state"; state: RuntimeState }
  | { type: "text"; entry: BacklogEntry }
  | { type: "choice"; options: string[] }
  | { type: "diagnostic"; diagnostic: RuntimeDiagnostic }
  /**
   * Assets the next few instructions will need. The UI warms them so a slow
   * link fetches during the current line instead of after it.
   */
  | { type: "prefetch"; images: string[]; audio: string[] }
  | { type: "ended" };

export type RuntimeDiagnostic = {
  sceneId: string;
  instructionPointer: number;
  opcode: string;
  operands: unknown[];
  message: string;
};

export interface AirRuntime {
  readonly state: RuntimeState;
  readonly mode: RuntimeMode;
  startNewGame(): void;
  advance(): Promise<void>;
  choose(index: number): Promise<void>;
  save(): RuntimeState;
  load(state: RuntimeState): void;
  setMode(mode: RuntimeMode): void;
  onEvent(listener: (event: RuntimeEvent) => void): () => void;
}
