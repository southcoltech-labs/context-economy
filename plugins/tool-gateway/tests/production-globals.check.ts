// SPDX-License-Identifier: Apache-2.0

// Typecheck regression, never run. The generated host declarations have no `setTimeout`, and production code must not gain
// one by accident: the test modules that need it declare it locally. If a program-wide declaration of `setTimeout` ever appears
// (a global declaration file, a wider lib or types entry), the directive below becomes unused and `tsc` fails here.
// @ts-expect-error setTimeout is not declared for production code
setTimeout(() => undefined, 0);

export {};
