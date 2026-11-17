// SPDX-License-Identifier: Apache-2.0

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * True when the module whose `import.meta.url` is given is the script Node was started with. Both sides are real
 * paths: through a symlinked folder `process.argv[1]` is the path as typed, and a bare comparison made the script
 * exit 0 with no output. False when there is no usable script path (standard input, `-e`, a missing file), so
 * importing the module from such a start still works.
 */
export function isEntry(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try { return metaUrl === pathToFileURL(realpathSync(argv1)).href; } catch { return false; }
}
