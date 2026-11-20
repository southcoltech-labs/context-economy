// SPDX-License-Identifier: Apache-2.0

/** Pi extension entry: registration only. Load for dev with `pi -e <this dir>/index.ts`. */
import { SettingsManager } from '@earendil-works/pi-coding-agent'
import { BAR_CONFIG_PATH, isContextBarOff, loadBarConfig } from './config'
import { registerContextBar } from './register'

type Pi = Parameters<typeof registerContextBar>[0]
type SessionCtx = { sessionManager: { buildSessionProjection(): { messages: unknown[] } } }

export default function contextBar(pi: Pi): void {
  if (isContextBarOff(process.env)) return
  const settings = SettingsManager.create(process.cwd())
  registerContextBar(pi, {
    compaction: model => {
      const c = settings.getCompactionSettings(model)
      return { enabled: c.enabled, reserveTokens: c.reserveTokens }
    },
    // Model-visible, compaction-aware list: ReadonlySessionManager.buildSessionProjection() (session-manager.d.ts:178,321).
    messages: ctx => (ctx as unknown as SessionCtx).sessionManager.buildSessionProjection().messages,
    config: () => loadBarConfig(BAR_CONFIG_PATH),
  })
}
