import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { chromium } from 'playwright'
import { apply, Config, inject, name } from '../src/index.ts'
import { assertBrowserAvailable, BrowserSession, BrowserSessionManager } from '../src/session.ts'

// Prefer Playwright's bundled chromium (the real user path, installed with
// `playwright install chromium`); fall back to a system Chrome/Edge channel;
// skip the suite when neither is available.
const bundledPath = chromium.executablePath()
const bundled = existsSync(bundledPath)
const channel = bundled ? undefined : 'chrome'

const testSignal = new AbortController().signal

type PluginFiber = Awaited<ReturnType<Context['plugin']>>

let ctx: Context | undefined
let fiber: PluginFiber | undefined
let server: Server
let base: string
let SHOT_DIR: string

describe.skipIf(!bundled && channel === undefined)('dsh-plugin-browser', () => {
  beforeAll(async () => {
    SHOT_DIR = mkdtempSync(join(tmpdir(), 'dsh-browser-'))
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      res.setHeader('content-type', 'text/html; charset=utf-8')
      switch (url.pathname) {
        case '/':
          res.end('<html><head><title>Home</title></head><body><h1>Hello Browser</h1><a href="/about">About</a></body></html>')
          break
        case '/about':
          res.end('<html><head><title>About</title></head><body><p>About page content</p></body></html>')
          break
        case '/form':
          res.end('<html><head><title>Form</title></head><body><form action="/submit" method="get"><input id="name" name="name"><button id="submit" type="submit">Go</button></form></body></html>')
          break
        case '/submit':
          res.end(`<html><head><title>Submitted</title></head><body><p>Hello, ${url.searchParams.get('name') ?? ''}</p></body></html>`)
          break
        default:
          res.statusCode = 404
          res.end('not found')
      }
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    fiber = await ctx.plugin({ name, inject, Config, apply }, {
      ...(channel !== undefined ? { channel } : {}),
      timeoutMs: 15000,
      maxTextChars: 20000,
      maxLinks: 20,
      screenshotDir: SHOT_DIR,
    })
  })

  afterAll(async () => {
    // Disposing the plugin fiber runs the effect disposer, which closes the
    // browser session and removes its temp profile.
    await fiber?.dispose()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(SHOT_DIR, { recursive: true, force: true })
  })

  it('navigates a URL and returns its rendered text and links', async () => {
    const result = await ctx!.tools.execute({
      signal: testSignal,
      callId: ToolCallId('c1'),
      name: 'browser_navigate',
      arguments: { url: base },
    })
    expect(result.isError).toBe(false)
    const value = result.value as { title: string; url: string; text: string; links: string[] }
    expect(value.title).toBe('Home')
    expect(value.text).toContain('Hello Browser')
    expect(value.links.some(link => link.includes('/about'))).toBe(true)
  })

  it('clicks a link and reflects the new page', async () => {
    const clicked = await ctx!.tools.execute({
      signal: testSignal,
      callId: ToolCallId('c2'),
      name: 'browser_click',
      arguments: { selector: 'a[href="/about"]' },
    })
    expect(clicked.isError).toBe(false)
    const snapshot = await ctx!.tools.execute({
      signal: testSignal,
      callId: ToolCallId('c3'),
      name: 'browser_snapshot',
      arguments: {},
    })
    const value = snapshot.value as { title: string; text: string }
    expect(value.title).toBe('About')
    expect(value.text).toContain('About page content')
  })

  it('fills a form and submits it', async () => {
    await ctx!.tools.execute({
      signal: testSignal,
      callId: ToolCallId('c4'),
      name: 'browser_navigate',
      arguments: { url: `${base}/form` },
    })
    const typed = await ctx!.tools.execute({
      signal: testSignal,
      callId: ToolCallId('c5'),
      name: 'browser_type',
      arguments: { selector: '#name', text: 'Ada' },
    })
    expect(typed.isError).toBe(false)
    const submitted = await ctx!.tools.execute({
      signal: testSignal,
      callId: ToolCallId('c6'),
      name: 'browser_click',
      arguments: { selector: '#submit' },
    })
    expect(submitted.isError).toBe(false)
    const snapshot = await ctx!.tools.execute({
      signal: testSignal,
      callId: ToolCallId('c7'),
      name: 'browser_snapshot',
      arguments: {},
    })
    expect((snapshot.value as { text: string }).text).toContain('Hello, Ada')
  })

  it('saves a non-empty screenshot', async () => {
    const shot = await ctx!.tools.execute({
      signal: testSignal,
      callId: ToolCallId('c8'),
      name: 'browser_screenshot',
      arguments: {},
    })
    expect(shot.isError).toBe(false)
    const path = String(shot.value)
    expect(existsSync(path)).toBe(true)
    expect(statSync(path).size).toBeGreaterThan(0)
  })

  it('closes the session and starts a fresh one', async () => {
    const closed = await ctx!.tools.execute({
      signal: testSignal,
      callId: ToolCallId('c9'),
      name: 'browser_close',
      arguments: {},
    })
    expect(closed.isError).toBe(false)
    expect((closed.value as { message: string }).message).toBe('browser session closed')
    const reopened = await ctx!.tools.execute({
      signal: testSignal,
      callId: ToolCallId('c10'),
      name: 'browser_navigate',
      arguments: { url: base },
    })
    expect(reopened.isError).toBe(false)
    expect((reopened.value as { title: string }).title).toBe('Home')
  })
})

describe('BrowserSessionManager', () => {
  // The agent loop dispatches parallel tool calls, so two first calls can
  // arrive together. They must share one launch: two browsers would double
  // the process count and leave the loser unreachable through closeSession.
  it('shares one launch across concurrent first calls', async () => {
    const manager = new BrowserSessionManager({
      timeoutMs: 1000,
      maxTextChars: 100,
      maxLinks: 1,
    })
    let launches = 0
    let closed = 0
    const fake = { close: async () => { closed += 1 } } as unknown as BrowserSession
    const spy = vi.spyOn(BrowserSession, 'create').mockImplementation(async () => {
      launches += 1
      await new Promise((resolve) => setTimeout(resolve, 20))
      return fake
    })

    const [first, second] = await Promise.all([
      manager.requireSession(),
      manager.requireSession(),
    ])
    expect(launches).toBe(1)
    expect(first).toBe(second)

    expect(await manager.closeSession()).toBe(true)
    expect(closed).toBe(1)
    expect(await manager.closeSession()).toBe(false)

    spy.mockRestore()
    await manager.dispose()
  })

  // A close that races an in-flight launch must still shut that browser down
  // instead of dropping the handle.
  it('closes a session whose launch was still in flight', async () => {
    const manager = new BrowserSessionManager({
      timeoutMs: 1000,
      maxTextChars: 100,
      maxLinks: 1,
    })
    let closed = 0
    const fake = { close: async () => { closed += 1 } } as unknown as BrowserSession
    const spy = vi.spyOn(BrowserSession, 'create').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return fake
    })

    const pending = manager.requireSession()
    expect(await manager.closeSession()).toBe(true)
    await pending
    expect(closed).toBe(1)

    spy.mockRestore()
    await manager.dispose()
  })
})

describe('assertBrowserAvailable', () => {
  // A missing browser is a setup mistake the user can fix from the message
  // alone, so it must not surface as Playwright's bare path error.
  it('names both remedies when no browser is reachable', () => {
    const spy = vi.spyOn(chromium, 'executablePath').mockReturnValue('/nonexistent/chrome')
    expect(() => assertBrowserAvailable({ timeoutMs: 1000, maxTextChars: 100, maxLinks: 1 }))
      .toThrow(/playwright install chromium[\s\S]*channel: chrome/)
    spy.mockRestore()
  })

  it('accepts an explicit channel without checking the bundle', () => {
    const spy = vi.spyOn(chromium, 'executablePath').mockReturnValue('/nonexistent/chrome')
    expect(() => assertBrowserAvailable({ channel: 'chrome', timeoutMs: 1000, maxTextChars: 100, maxLinks: 1 }))
      .not.toThrow()
    spy.mockRestore()
  })
})
