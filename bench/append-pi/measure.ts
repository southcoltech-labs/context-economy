// SPDX-License-Identifier: Apache-2.0
//
// Explicit measurement, outside the Pi extension test set: `bun run bench/append-pi/measure.ts`. Not a gate.
import { measure } from '../append-measure-core'
import { piAdapter } from '../../extensions/context-bar/items'
import { walkMessages } from '../../plugins/context-bar/hooks/walk'

measure({
  host: 'pi',
  walkMessages,
  adapter: piAdapter,
  call: (id, args) => ({ role: 'assistant', content: [{ type: 'toolCall', id, name: 'bash', arguments: args }] }),
  next: () => ({ role: 'user', content: 'next' }),
})
