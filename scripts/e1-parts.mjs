// SPDX-License-Identifier: Apache-2.0

// Step data for the E1 driver's parts. Piece 1 ships the engine only, so the registry is empty:
// the step data (E1a Parts C and D, then the E1b parts) arrives in piece 3.
// `e1a(vars)` returns the steps of an E1a run; `e1b[<part>](vars)` those of an E1b part.
export const parts = { e1a: undefined, e1b: {} };
