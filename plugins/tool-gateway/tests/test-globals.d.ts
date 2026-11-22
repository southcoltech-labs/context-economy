// SPDX-License-Identifier: Apache-2.0

// Typecheck only; it adds nothing at run time. The tests wait on real time with `setTimeout`, which the test runtime provides
// but the generated host declarations (es2023 only, no DOM or Node types) do not declare. Only that one call shape is
// declared, so any other missing global still fails the typecheck.
declare function setTimeout(callback: (...args: never[]) => void, ms?: number): unknown;
