// The one place the registry picks its AWML engine. Replace the stub with the
// WebAssembly build of the AWML Go package by changing this import.
import { stubEngine } from "./stub";
import type { Engine } from "./types";

export type { Engine, Files, Summary } from "./types";

export const engine: Engine = stubEngine;
