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
};

export type FlowchartEdge = {
  from: string;
  to: string;
  label?: string;
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
