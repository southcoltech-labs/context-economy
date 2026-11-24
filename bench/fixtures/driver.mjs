// SPDX-License-Identifier: Apache-2.0
// Fixture driver: the real runner wiring (execute) around a stand-in child script. Env: DRV_CHILD, DRV_DEADLINE, DRV_MAXKEEP.
import { execute } from '../run-lib.mjs'
await execute({
  host: 'pi', deadlineMs: Number(process.env.DRV_DEADLINE ?? 20000), cmd: process.env.DRV_CMD ?? process.execPath,
  args: process.env.DRV_CHILD ? [process.env.DRV_CHILD] : [], cwd: process.cwd(), maxKeep: process.env.DRV_MAXKEEP ? Number(process.env.DRV_MAXKEEP) : undefined,
})
