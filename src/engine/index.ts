// The one place the registry picks its AWML engine.
import { wasmEngine } from "./wasm";
import type { Engine } from "./types";

export type { Engine, Files, FitReport, FitResult, Summary } from "./types";

export const engine: Engine = wasmEngine;
