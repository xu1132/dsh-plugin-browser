/**
 * A DeepSeek Harness community plugin that drives a headless Playwright
 * browser. Registers six model-facing tools: rendered-page navigation and
 * snapshots, click/type automation, screenshots, and session close. Each agent
 * gets an isolated browser session; plugin unload closes every session.
 *
 * @module dsh-plugin-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BrowserSessionManager } from './session.ts'
import { browserTools } from './tools.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'browser-plugin'

/** The tool registry the plugin registers into. */
export const inject = ['tools']

/** Plugin configuration. Invalid values fail plugin load. */
export interface Config {
  /** Path to a system browser executable. Omit to use Playwright's bundled chromium. */
  executablePath?: string
  /** Playwright browser channel selecting an installed system browser (`chrome`, `msedge`, …). */
  channel?: string
  /** Navigation/click/type timeout in milliseconds. */
  timeoutMs: number
  /** Cap on characters of extracted body text per snapshot. */
  maxTextChars: number
  /** Cap on links listed per snapshot. */
  maxLinks: number
  /** Directory where screenshots land when no path is requested. */
  screenshotDir: string
}

/** Schemastery schema validating {@link Config}; deployment-varying fields default here. */
export const Config: z<Config> = z.object({
  executablePath: z.string(),
  channel: z.string(),
  timeoutMs: z.number().default(30000),
  maxTextChars: z.number().default(20000),
  maxLinks: z.number().default(20),
  screenshotDir: z.string().default('.'),
})

/** Reject non-positive numeric config at load time. */
function assertPositive(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`browser-plugin: ${name} must be a positive integer`)
  }
}

/**
 * Register the browser tools for the lifetime of `ctx`.
 * @param ctx - plugin context; registrations and live sessions are disposed with it.
 * @param config - validated browser and extraction configuration.
 */
export function apply(ctx: Context, config: Config): void {
  assertPositive('timeoutMs', config.timeoutMs)
  assertPositive('maxTextChars', config.maxTextChars)
  assertPositive('maxLinks', config.maxLinks)
  const manager = new BrowserSessionManager({
    ...(config.executablePath !== undefined ? { executablePath: config.executablePath } : {}),
    ...(config.channel !== undefined ? { channel: config.channel } : {}),
    timeoutMs: config.timeoutMs,
    maxTextChars: config.maxTextChars,
    maxLinks: config.maxLinks,
  })
  // Live browser processes must not outlive the plugin. Teardown is
  // fire-and-forget so plugin unload never blocks on browser shutdown.
  ctx.effect(() => {
    return () => {
      void manager.dispose()
    }
  })
  for (const tool of browserTools({ manager, timeoutMs: config.timeoutMs, screenshotDir: config.screenshotDir })) {
    ctx.tools.register(tool)
  }
}
