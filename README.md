# dsh-plugin-browser

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) community plugin that drives a **headless browser** with Playwright. It registers six model-callable tools that let the model read JavaScript-rendered pages, take screenshots, and automate page interactions — the capabilities the built-in `web_fetch` (plain HTTP) cannot provide.

## Tools

| Tool | What it does |
|---|---|
| `browser_navigate(url)` | Open a URL, wait for load, return rendered title, body text, and links |
| `browser_snapshot()` | Return the current page's rendered text (use between automation steps) |
| `browser_click(selector)` | Click an element (any Playwright CSS selector) |
| `browser_type(selector, text)` | Fill a text input |
| `browser_screenshot(path?)` | Save a viewport PNG; defaults to `browser-<timestamp>.png` in `screenshotDir` |
| `browser_close()` | Close the current browser session and release resources |

Each agent gets its own isolated browser session; calls without an agent share a default session. Sessions start lazily on first use and close when the plugin unloads.

## Install

Install the bundle into the profile that boots your harness:

```sh
dsh plugin --profile <name> add dsh-plugin-browser
```

Then pick a browser. The plugin uses Playwright's bundled chromium by default, which means a one-time download of roughly 150 MB:

```sh
npx playwright install chromium   # run from the profile directory
```

**Already have Chrome or Edge?** Skip the download and point the plugin at the browser you have — either channel works on Windows, macOS, and Linux:

```yaml
# <profile>/cordis.patch.yml
- id: browser
  name: dsh-plugin-browser
  config:
    channel: chrome        # or: msedge
```

If no browser is reachable, the first browser tool call fails with a message naming both options, instead of Playwright's bare `Executable doesn't exist at …`.

Then boot and ask the model, for example: *"Open https://example.com and tell me what's on the page."* The model calls `browser_navigate` and receives the rendered text.

## Configure

Override the row in the profile's `cordis.patch.yml`:

```yaml
- id: browser
  name: dsh-plugin-browser
  config:
    timeoutMs: 30000      # navigation/click/type timeout
    maxTextChars: 20000   # cap on extracted body text per snapshot
    maxLinks: 20          # cap on links listed per snapshot
    screenshotDir: .      # default directory for screenshots
    channel: chrome       # Playwright channel: an installed system browser
    executablePath: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
```

`channel` and `executablePath` both replace Playwright's bundled chromium with a browser you already have — useful when you do not want the browser download. Use `channel` for a stock Chrome/Edge install; use `executablePath` for a specific binary (a portable build, a beta channel, a non-standard install location). `executablePath` wins when both are set.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm run build     # emits lib/index.js and lib/index.d.ts
pnpm run test
```

The test suite boots a local HTTP server and drives the bundled chromium, or the installed Chrome/Edge when the bundle is absent; it skips itself when neither is available, so it needs no real network.

## Structure

```
browser/
├── package.json       # bundle manifest (dsh.bundle), scripts, deps
├── cordis.patch.yml   # the configuration layer the bundle inserts
├── src/index.ts       # plugin: name / inject / Config / apply
├── src/session.ts     # headless session + per-agent session manager
├── src/tools.ts       # the six tool definitions
├── tests/browser.spec.ts
├── tsconfig.json
└── vitest.config.ts
```

## License

[MIT](LICENSE)
