// SPDX-License-Identifier: Apache-2.0
//
// Explicit measurement, outside the plugin test set: bench/run-claude.sh copies the plugin (without its tests) next to this file and runs
// `claude plugin test` on the copy. Not a gate. The host refuses imports from outside the plugin folder, hence the copy.
import { test } from 'claude-code/testing'
import { measure } from './append-measure-core'
import { claudeAdapter } from './hooks/items'
import { walkMessages } from './hooks/walk'

test('append measurement (Claude adapter; exploratory, not a gate)', { timeoutMs: 180_000 }, () => {
  measure({
    host: 'claude',
    walkMessages,
    adapter: claudeAdapter,
    call: (id, input) => ({ role: 'assistant', text: '', toolUses: [{ tool: 'Bash', input, tool_use_id: id }] }),
    next: () => ({ role: 'user', text: 'next' }),
  })
})
