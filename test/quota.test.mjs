// Host state-route tests plus a Client settings-wiring regression.
//
// Every case re-imports `index.js` so its per-provider cache starts empty, and
// points the CLI-login adapters at throwaway `CLAUDE_CONFIG_DIR` /
// `GEMINI_CLI_HOME` directories instead of the real home.
//
// Run with: node --test test/

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, beforeEach, test } from 'node:test'

const MODULE_URL = pathToFileURL(join(import.meta.dirname, '..', 'index.js')).href

let caseId = 0
let root
let originalFetch
let originalEnv

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'provider-quota-'))
  originalFetch = globalThis.fetch
  originalEnv = {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME,
    CODEX_HOME: process.env.CODEX_HOME,
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
    OPENCODE_GO_API_KEY: process.env.OPENCODE_GO_API_KEY,
    COMMANDCODE_API_KEY: process.env.COMMANDCODE_API_KEY,
    COMMAND_CODE_API_KEY: process.env.COMMAND_CODE_API_KEY,
    CLI_PROXY_MANAGEMENT_KEY: process.env.CLI_PROXY_MANAGEMENT_KEY,
    CLI_PROXY_MANAGEMENT_URL: process.env.CLI_PROXY_MANAGEMENT_URL,
  }
  process.env.USERPROFILE = join(root, 'home')
  process.env.HOME = join(root, 'home')
  // Every CLI-login provider starts logged out; each test opts in explicitly.
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.GEMINI_CLI_HOME
  delete process.env.CODEX_HOME
  delete process.env.OPENCODE_GO_API_KEY
  delete process.env.COMMANDCODE_API_KEY
  delete process.env.COMMAND_CODE_API_KEY
  delete process.env.CLI_PROXY_MANAGEMENT_KEY
  delete process.env.CLI_PROXY_MANAGEMENT_URL
  await mkdir(join(root, 'home'), { recursive: true })
})

after(() => {
  globalThis.fetch = originalFetch
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  void rm(root, { recursive: true, force: true })
})

/** A fetch double that records calls and answers from a URL 鈫?response table. */
function stubFetch(routes) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    calls.push({ url: target, init })
    const route = routes(target, init)
    if (route === undefined) throw new Error(`unexpected fetch: ${target}`)
    return route
  }
  return calls
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body)
    },
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value), 'utf8')
}

/** Wire the plugin into a fake profile and return its state route. */
async function startPlugin(options = {}) {
  const url = `${MODULE_URL}?case=${String(++caseId)}`
  const module = await import(url)
  const registered = []
  const credentialStore = options.credentialStore ?? new Map()
  const resolveCredential = async (ref) => {
    if (credentialStore.has(ref)) return { value: credentialStore.get(ref), source: 'test-store' }
    return options.resolve?.(ref)
  }
  const credentials = {
    resolve: resolveCredential,
    describe: options.describe ?? (async (ref) => ({
      configured: credentialStore.has(ref)
        || (typeof process.env[ref] === 'string' && process.env[ref].trim() !== '')
        || (ref === 'CLI_PROXY_MANAGEMENT_KEY' && options.resolve !== undefined),
      writable: true,
    })),
    set: async (ref, value) => {
      await options.set?.(ref, value)
      credentialStore.set(ref, value)
    },
    unset: async (ref) => {
      await options.unset?.(ref)
      credentialStore.delete(ref)
    },
  }
  const connection = {
    requestRejection(request) {
      return options.requestRejection?.(request)
    },
  }
  const ctx = {
    get(name) {
      if (name === 'credentials' && options.credentialsUnavailable !== true) return credentials
      if (name === 'connection' && options.connectionUnavailable !== true) return connection
      return undefined
    },
    llm: { listProviders: () => options.providers ?? [] },
    inject(names, callback) {
      // The upstream Command Code plugin is optional: without it the plugin
      // simply never enters that fiber, exactly like cordis.
      if (names.length === 1 && names[0] === 'commandcodeUsage') {
        if (options.commandCodeUsage === undefined) return
        callback({
          commandcodeUsage: options.commandCodeUsage,
          effect(fn) {
            return fn()
          },
        })
        return
      }
      assert.deepEqual(names, ['webServer'])
      callback({
        effect(fn) {
          return fn()
        },
        webServer: {
          getOrigin: () => 'http://127.0.0.1:14102',
          register(route) {
            registered.push(route)
            return () => {}
          },
        },
      })
    },
  }
  module.apply(ctx)
  assert.deepEqual(registered.map((route) => route.path).sort(), [
    '/provider-quota/settings',
    '/provider-quota/state',
  ])

  const stateHandler = registered.find((route) => route.path === '/provider-quota/state').handler
  const settingsHandler = registered.find((route) => route.path === '/provider-quota/settings').handler
  async function state({ refresh = false, includeCliProxyProviders = false } = {}) {
    const body = []
    const params = new URLSearchParams()
    if (refresh) params.set('refresh', '1')
    if (includeCliProxyProviders) params.set('includeCliProxyProviders', '1')
    const query = params.toString()
    const res = {
      writeHead() {},
      end(chunk) {
        body.push(String(chunk))
      },
    }
    await stateHandler({ method: 'GET', url: `/provider-quota/state${query === '' ? '' : `?${query}`}` }, res)
    return JSON.parse(body.join(''))
  }
  async function settings({ method = 'GET', body, origin = 'http://127.0.0.1:14102', headers = {} } = {}) {
    const chunks = []
    let status
    const requestHeaders = { host: '127.0.0.1:14102', ...headers }
    if (method === 'POST') {
      if (!Object.hasOwn(requestHeaders, 'content-type')) requestHeaders['content-type'] = 'application/json'
      if (!Object.hasOwn(requestHeaders, 'origin') && origin !== null) requestHeaders.origin = origin
    }
    const req = { method, url: '/provider-quota/settings', headers: requestHeaders }
    if (body !== undefined) {
      const bytes = Buffer.from(JSON.stringify(body))
      req[Symbol.asyncIterator] = async function* () { yield bytes }
    }
    const res = {
      writeHead(code) { status = code },
      end(chunk) { chunks.push(String(chunk)) },
    }
    await settingsHandler(req, res)
    return { status, payload: JSON.parse(chunks.join('')) }
  }
  state.settings = settings
  state.credentialStore = credentialStore
  // Test seam: let a case swap Antigravity's process/port/RPC transport.
  state.setAntigravityTransport = module.setAntigravityTransport
  return state
}

function entryOf(payload, provider) {
  return payload.providers.find((entry) => entry.provider === provider)
}

function windowOf(entry, tier) {
  return entry.windows.find((window) => window.tier === tier)
}

async function loginClaude(credentials) {
  const dir = join(root, 'claude-config')
  process.env.CLAUDE_CONFIG_DIR = dir
  await writeJson(join(dir, '.credentials.json'), credentials)
  return dir
}

async function loginGemini(credentials) {
  const dir = join(root, 'gemini-home')
  process.env.GEMINI_CLI_HOME = dir
  await writeJson(join(dir, 'oauth_creds.json'), credentials)
  return dir
}

const CLAUDE_USAGE = {
  five_hour: { utilization: 33, resets_at: '2026-11-25T12:00:00.000000+00:00' },
  seven_day: { utilization: 13, resets_at: '2026-11-30T00:59:59.000000+00:00' },
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 1, resets_at: '2026-11-29T03:00:00.000000+00:00' },
  extra_usage: { is_enabled: true, monthly_limit: 2000, used_credits: 500, utilization: null },
}

test('claude: 5-hour, weekly, model-scoped and extra-usage windows', async () => {
  await loginClaude({ claudeAiOauth: { accessToken: 'sk-ant-oat-1', expiresAt: Date.now() + 3_600_000 } })
  const calls = stubFetch((url) => (url.startsWith('https://api.anthropic.com/api/oauth/usage') ? response(200, CLAUDE_USAGE) : undefined))

  const state = await startPlugin()
  const payload = await state()
  const entry = entryOf(payload, 'claude')

  assert.equal(entry.status, 'ok')
  assert.equal(entry.providerName, 'Claude')
  assert.equal(windowOf(entry, 'five_hour').usedPercent, 33)
  assert.equal(new Date(windowOf(entry, 'five_hour').resetAt).toISOString(), '2026-11-25T12:00:00.000Z')
  assert.equal(windowOf(entry, 'weekly').usedPercent, 13)
  assert.deepEqual(entry.windows.find((window) => window.name === 'Sonnet'), {
    tier: 'other',
    usedPercent: 1,
    resetAt: Date.parse('2026-11-29T03:00:00.000Z'),
    name: 'Sonnet',
  })
  // extra_usage has no utilization, so the window comes from credits / limit.
  assert.equal(windowOf(entry, 'monthly').usedPercent, 25)

  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-ant-oat-1')
  assert.equal(calls[0].init.headers['anthropic-beta'], 'oauth-2025-04-20')
})

test('claude: a plain 403 retries once with cedar_ember', async () => {
  await loginClaude({ claudeAiOauth: { accessToken: 'sk-ant-oat-2', expiresAt: Date.now() + 3_600_000 } })
  const calls = stubFetch((url) => {
    if (url === 'https://api.anthropic.com/api/oauth/usage') return response(403, { error: { type: 'forbidden' } })
    if (url === 'https://api.anthropic.com/api/oauth/usage?cedar_ember=1') return response(200, CLAUDE_USAGE)
    return undefined
  })

  const state = await startPlugin()
  const entry = entryOf(await state(), 'claude')

  assert.equal(entry.status, 'ok')
  assert.deepEqual(calls.map((call) => call.url), [
    'https://api.anthropic.com/api/oauth/usage',
    'https://api.anthropic.com/api/oauth/usage?cedar_ember=1',
  ])
})

test('claude: an expired token asks for a re-login instead of calling out', async () => {
  await loginClaude({ claudeAiOauth: { accessToken: 'sk-ant-oat-3', expiresAt: Date.now() - 1000 } })
  const calls = stubFetch(() => undefined)

  const state = await startPlugin()
  const entry = entryOf(await state(), 'claude')

  assert.equal(entry.status, 'error')
  assert.equal(entry.error.kind, 'auth')
  assert.equal(calls.length, 0)
})

test('claude: no credentials file keeps the provider out of the payload', async () => {
  const calls = stubFetch(() => undefined)
  const state = await startPlugin()
  const payload = await state()

  assert.deepEqual(payload.providers, [])
  assert.equal(calls.length, 0)
})

test('claude: the usage answer is cached across a click-to-refresh', async () => {
  await loginClaude({ claudeAiOauth: { accessToken: 'sk-ant-oat-4', expiresAt: Date.now() + 3_600_000 } })
  const calls = stubFetch((url) => (url.startsWith('https://api.anthropic.com/api/oauth/usage') ? response(200, CLAUDE_USAGE) : undefined))

  const state = await startPlugin()
  await state()
  await state({ refresh: true })

  assert.equal(calls.length, 1)
})

test('codex: ChatGPT windows come from the local login', async () => {
  const codexHome = join(root, 'codex-home')
  process.env.CODEX_HOME = codexHome
  await writeJson(join(codexHome, 'auth.json'), {
    tokens: { access_token: 'codex-token', account_id: 'acct-1' },
  })
  const calls = stubFetch((url) => (url === 'https://chatgpt.com/backend-api/codex/usage'
    ? response(200, {
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 34, reset_at: 1_795_603_200 },
        secondary_window: { used_percent: 41, reset_at: 1_796_103_498 },
      },
    })
    : undefined))

  const state = await startPlugin()
  const entry = entryOf(await state(), 'codex')

  assert.equal(entry.status, 'ok')
  assert.equal(entry.planTier, 'PLUS')
  assert.equal(windowOf(entry, 'five_hour').usedPercent, 34)
  assert.equal(windowOf(entry, 'five_hour').resetAt, 1_795_603_200_000)
  assert.equal(windowOf(entry, 'weekly').usedPercent, 41)
  assert.equal(calls[0].init.headers['chatgpt-account-id'], 'acct-1')
})

test('gemini: one window per Code Assist model family, most constrained wins', async () => {
  await loginGemini({ access_token: 'google-token', expiry_date: Date.now() + 3_600_000 })
  const calls = stubFetch((url, init) => {
    if (url.endsWith(':loadCodeAssist')) {
      return response(200, {
        cloudaicompanionProject: { id: 'proj-123' },
        currentTier: { id: 'standard-tier' },
        paidTier: { name: 'Gemini Code Assist Standard' },
      })
    }
    if (url.endsWith(':retrieveUserQuota')) {
      assert.equal(JSON.parse(init.body).project, 'proj-123')
      return response(200, {
        buckets: [
          { modelId: 'gemini-2.5-pro', remainingFraction: 0.6, resetTime: '2026-11-26T00:00:00Z' },
          { modelId: 'gemini-3-pro-preview', remainingFraction: 0.35, resetTime: '2026-11-26T00:00:00Z' },
          { modelId: 'gemini-2.5-flash', remainingFraction: 0.9, resetTime: '2026-11-26T00:00:00Z' },
          { modelId: 'gemini-2.5-flash-lite', remainingFraction: 1, resetTime: '2026-11-26T00:00:00Z' },
        ],
      })
    }
    return undefined
  })

  const state = await startPlugin()
  const entry = entryOf(await state(), 'gemini')

  assert.equal(entry.status, 'ok')
  assert.equal(entry.planTier, 'Gemini Code Assist Standard')
  assert.deepEqual(entry.windows.map((window) => [window.name, Math.round(window.usedPercent)]), [
    ['Gemini Pro', 65],
    ['Gemini Flash', 10],
    ['Gemini Flash Lite', 0],
  ])
  assert.equal(calls.length, 2)
})

test('gemini: a missing Code Assist project comes from Cloud Resource Manager', async () => {
  await loginGemini({ access_token: 'google-token', expiry_date: Date.now() + 3_600_000 })
  let quotaProject
  stubFetch((url, init) => {
    if (url.endsWith(':loadCodeAssist')) return response(200, { currentTier: { id: 'standard-tier' } })
    if (url === 'https://cloudresourcemanager.googleapis.com/v1/projects') {
      return response(200, { projects: [{ projectId: 'someone-elses-project' }, { projectId: 'gen-lang-client-1234' }] })
    }
    if (url.endsWith(':retrieveUserQuota')) {
      quotaProject = JSON.parse(init.body).project
      return response(200, { buckets: [{ modelId: 'gemini-2.5-pro', remainingFraction: 0.25 }] })
    }
    return undefined
  })

  const state = await startPlugin()
  const entry = entryOf(await state(), 'gemini')

  assert.equal(entry.status, 'ok')
  assert.equal(entry.planTier, 'Paid')
  assert.equal(quotaProject, 'gen-lang-client-1234')
})

test('gemini: a 403 SUBSCRIPTION_REQUIRED reads as "account not eligible"', async () => {
  await loginGemini({ access_token: 'google-token', expiry_date: Date.now() + 3_600_000 })
  stubFetch((url) => (url.endsWith(':retrieveUserQuota')
    ? response(403, { error: { status: 'SUBSCRIPTION_REQUIRED', message: 'no license' } })
    : response(200, { cloudaicompanionProject: 'proj-9' })))

  const state = await startPlugin()
  const entry = entryOf(await state(), 'gemini')

  assert.equal(entry.status, 'error')
  assert.equal(entry.error.kind, 'unsupported')
})

test('gemini: the consumer-tier shutdown signal is reported as not eligible', async () => {
  await loginGemini({ access_token: 'google-token', expiry_date: Date.now() + 3_600_000 })
  stubFetch((url) => {
    if (url.endsWith(':loadCodeAssist')) {
      return response(200, {
        ineligibleTiers: [{ reasonCode: 'UNSUPPORTED_CLIENT', reasonMessage: 'migrate to Antigravity' }],
      })
    }
    return response(403, { error: { status: 'SUBSCRIPTION_REQUIRED' } })
  })

  const state = await startPlugin()
  const entry = entryOf(await state(), 'gemini')

  assert.equal(entry.status, 'error')
  assert.equal(entry.error.kind, 'unsupported')
  assert.match(entry.error.message, /Antigravity/)
})

test('registry: API-key providers keep working, and a missing key shows up as such', async () => {
  stubFetch((url) => (url === 'https://opencode.ai/zen/go/v1/usage'
    ? response(200, {
      usage: {
        rolling: { percent: 5, resetsAt: '2026-11-25T15:00:00Z' },
        weekly: { percent: 0, resetsAt: '2026-11-30T00:00:00Z' },
        monthly: { percent: 100, resetsAt: '2026-12-01T00:00:00Z' },
      },
    })
    : undefined))

  const state = await startPlugin({
    providers: [{ id: 'opencode-go' }, { id: 'command-code' }],
    resolve: async (envName) => (envName === 'OPENCODE_GO_API_KEY' ? { value: 'zen-key' } : undefined),
  })
  const payload = await state()

  const opencode = entryOf(payload, 'opencode-go')
  assert.equal(opencode.status, 'ok')
  assert.equal(windowOf(opencode, 'five_hour').usedPercent, 5)
  assert.equal(windowOf(opencode, 'monthly').usedPercent, 100)

  const commandCode = entryOf(payload, 'command-code')
  assert.equal(commandCode.status, 'error')
  assert.equal(commandCode.error.kind, 'no-credential')
})

/** Command Code: credits carry the 5-hour and weekly windows, the plan the month. */
const COMMAND_CODE_CREDITS = {
  windowLimits: {
    fiveHour: { used: 120, cap: 400, resetAt: 1_795_603_200_000 },
    weekly: { used: 45, cap: 100, resetAt: 1_796_103_498_000 },
  },
  credits: { monthlyCredits: 55 },
}

const COMMAND_CODE_SUBSCRIPTION = {
  data: { planId: 'individual-goat', currentPeriodEnd: '2026-12-01T00:00:00Z' },
}

function stubCommandCode() {
  return stubFetch((url) => {
    if (url === 'https://api.commandcode.ai/alpha/billing/credits') return response(200, COMMAND_CODE_CREDITS)
    if (url === 'https://api.commandcode.ai/alpha/billing/subscriptions') return response(200, COMMAND_CODE_SUBSCRIPTION)
    return undefined
  })
}

test('commandcode: the upstream registry id yields one command-code chip with every window', async () => {
  const calls = stubCommandCode()
  const asked = []

  // Mars-Sea/dsh-commandcode-provider registers `commandcode` and saves the key
  // under COMMANDCODE_API_KEY; a legacy install may still list `command-code`.
  const state = await startPlugin({
    providers: [{ id: 'commandcode' }, { id: 'command-code' }],
    resolve: async (envName) => {
      asked.push(envName)
      return envName === 'COMMANDCODE_API_KEY' ? { value: 'cc-key' } : undefined
    },
  })
  const payload = await state()

  assert.deepEqual(payload.providers.map((entry) => entry.provider), ['command-code'])
  const entry = payload.providers[0]
  assert.equal(entry.status, 'ok')
  assert.equal(entry.planTier, 'GOAT')
  // used / cap, not percent: 120/400 and 45/100.
  assert.equal(windowOf(entry, 'five_hour').usedPercent, 30)
  assert.equal(windowOf(entry, 'five_hour').resetAt, 1_795_603_200_000)
  assert.equal(windowOf(entry, 'weekly').usedPercent, 45)
  assert.equal(windowOf(entry, 'weekly').resetAt, 1_796_103_498_000)
  // 55 of GOAT's 70 monthly credits left → 21.4% used, reset from the period end.
  assert.equal(Math.round(windowOf(entry, 'monthly').usedPercent), 21)
  assert.equal(windowOf(entry, 'monthly').resetAt, Date.parse('2026-12-01T00:00:00.000Z'))

  // The upstream plugin key is used; the optional CPA credential lookup is a separate no-op.
  assert.ok(asked.includes('COMMANDCODE_API_KEY'))
  assert.ok(asked.includes('CLI_PROXY_MANAGEMENT_KEY'))
  assert.deepEqual(calls.map((call) => call.url), [
    'https://api.commandcode.ai/alpha/billing/credits',
    'https://api.commandcode.ai/alpha/billing/subscriptions',
  ])
  assert.deepEqual(calls.map((call) => call.init.headers.authorization), ['Bearer cc-key', 'Bearer cc-key'])
})

test('commandcode: the legacy COMMAND_CODE_API_KEY still authenticates', async () => {
  process.env.COMMAND_CODE_API_KEY = 'legacy-key'
  const calls = stubCommandCode()

  const state = await startPlugin({ providers: [{ id: 'commandcode' }] })
  const entry = entryOf(await state(), 'command-code')

  assert.equal(entry.status, 'ok')
  assert.equal(windowOf(entry, 'five_hour').usedPercent, 30)
  assert.ok(calls.every((call) => call.init.headers.authorization === 'Bearer legacy-key'))
})

test('commandcode: the legacy COMMAND_CODE_API_KEY is still read through the credential seam', async () => {
  const calls = stubCommandCode()

  const state = await startPlugin({
    providers: [{ id: 'commandcode' }],
    resolve: async (envName) => (envName === 'COMMAND_CODE_API_KEY' ? { value: 'legacy-seam-key' } : undefined),
  })
  const entry = entryOf(await state(), 'command-code')

  assert.equal(entry.status, 'ok')
  assert.ok(calls.every((call) => call.init.headers.authorization === 'Bearer legacy-seam-key'))
})

test('commandcode: COMMANDCODE_API_KEY is preferred when both names are set', async () => {
  process.env.COMMANDCODE_API_KEY = 'upstream-key'
  process.env.COMMAND_CODE_API_KEY = 'legacy-key'
  const calls = stubCommandCode()

  const state = await startPlugin({ providers: [{ id: 'commandcode' }] })
  const entry = entryOf(await state(), 'command-code')

  assert.equal(entry.status, 'ok')
  assert.ok(calls.every((call) => call.init.headers.authorization === 'Bearer upstream-key'))
})

// ---------------------------------------------------------------------------
// Command Code through the upstream plugin's `commandcodeUsage.report()`
// service (Mars-Sea/dsh-commandcode-provider): the preferred source.
// ---------------------------------------------------------------------------

/** A stand-in for the upstream service; `report()` is the only method used. */
function commandCodeUsageService(accounts) {
  const calls = []
  return {
    calls,
    service: {
      async report() {
        calls.push(Date.now())
        return { accounts }
      },
    },
  }
}

/** One account as the upstream report shapes it (`CommandCodeAccountUsage`). */
function commandCodeAccount(overrides = {}) {
  return {
    id: 'default',
    label: 'Default',
    configured: true,
    active: true,
    mark: '',
    cooldownUntil: 0,
    report: {
      failures: [],
      credits: {
        monthlyCredits: 55,
        purchasedCredits: 0,
        freeCredits: 0,
        fiveHour: { used: 120, cap: 400, exceeded: false, resetAt: 1_795_603_200_000 },
        weekly: { used: 45, cap: 100, exceeded: false, resetAt: 1_796_103_498_000 },
      },
      plan: {
        planId: 'individual-goat',
        name: 'GOAT',
        status: 'active',
        monthlyCredits: 70,
        currentPeriodEnd: Date.parse('2026-12-01T00:00:00Z'),
      },
    },
    ...overrides,
  }
}

test('commandcode: the upstream report service feeds the bar with no billing call', async () => {
  const calls = stubFetch(() => undefined)
  const usage = commandCodeUsageService([commandCodeAccount()])

  const state = await startPlugin({
    providers: [{ id: 'commandcode' }],
    commandCodeUsage: usage.service,
  })
  const payload = await state()

  assert.deepEqual(payload.providers.map((entry) => entry.provider), ['command-code'])
  const entry = payload.providers[0]
  assert.equal(entry.status, 'ok')
  assert.equal(entry.providerName, 'command-code')
  assert.equal(entry.planTier, 'GOAT')
  assert.equal(windowOf(entry, 'five_hour').usedPercent, 30)
  assert.equal(windowOf(entry, 'five_hour').resetAt, 1_795_603_200_000)
  assert.equal(windowOf(entry, 'weekly').usedPercent, 45)
  assert.equal(Math.round(windowOf(entry, 'monthly').usedPercent), 21)
  assert.equal(windowOf(entry, 'monthly').resetAt, Date.parse('2026-12-01T00:00:00Z'))

  // The service is the source: no credential lookup, no billing endpoint.
  assert.equal(calls.length, 0)
  assert.equal(usage.calls.length, 1)
})

test('commandcode: the serving account is the one chip, even with several accounts', async () => {
  const idle = commandCodeAccount({
    id: 'account-2',
    label: 'Go #2',
    active: false,
    report: {
      failures: [],
      credits: {
        monthlyCredits: 0,
        purchasedCredits: 0,
        freeCredits: 0,
        fiveHour: { used: 400, cap: 400, exceeded: true, resetAt: 1_795_603_200_000 },
        weekly: { used: 10, cap: 100, exceeded: false, resetAt: 1_796_103_498_000 },
      },
      plan: {
        planId: 'individual-go',
        name: 'Go',
        status: 'active',
        monthlyCredits: 10,
        currentPeriodEnd: Date.parse('2026-12-01T00:00:00Z'),
      },
    },
  })
  const usage = commandCodeUsageService([idle, commandCodeAccount()])

  const state = await startPlugin({
    providers: [{ id: 'commandcode' }],
    commandCodeUsage: usage.service,
  })
  const payload = await state()

  // One chip, the vendor's own mark and route key, built from the ACTIVE
  // account — not from the exhausted idle one.
  assert.deepEqual(payload.providers.map((entry) => [entry.provider, entry.providerName]), [
    ['command-code', 'command-code'],
  ])
  const entry = payload.providers[0]
  assert.equal(entry.status, 'ok')
  assert.equal(entry.planTier, 'GOAT')
  assert.equal(windowOf(entry, 'five_hour').usedPercent, 30)
  assert.equal(windowOf(entry, 'weekly').usedPercent, 45)
  assert.equal(Math.round(windowOf(entry, 'monthly').usedPercent), 21)
})

test('commandcode: without an active account the first configured one is used', async () => {
  const usage = commandCodeUsageService([
    commandCodeAccount({ id: 'account-2', active: false, configured: false, report: { failures: ['credits'] } }),
    commandCodeAccount({ id: 'account-3', label: 'Backup', active: false }),
  ])

  const state = await startPlugin({
    providers: [{ id: 'commandcode' }],
    commandCodeUsage: usage.service,
  })
  const payload = await state()

  assert.deepEqual(payload.providers.map((entry) => entry.provider), ['command-code'])
  assert.equal(payload.providers[0].status, 'ok')
  assert.equal(windowOf(payload.providers[0], 'five_hour').usedPercent, 30)
})

test('commandcode: uncapped and unreported limits are never drawn as zeros or exhaustion', async () => {
  const usage = commandCodeUsageService([commandCodeAccount({
    report: {
      failures: [],
      credits: {
        // `fiveHour` is absent, `weekly.cap === 0` is uncapped spend, and
        // `monthlyReported === false` means the balance was omitted.
        monthlyCredits: 0,
        monthlyReported: false,
        purchasedCredits: 0,
        freeCredits: 0,
        weekly: { used: 7, cap: 0, exceeded: false, resetAt: 1_796_103_498_000 },
      },
      plan: {
        planId: 'individual-go',
        name: 'Go',
        status: 'active',
        monthlyCredits: 10,
        currentPeriodEnd: Date.parse('2026-12-01T00:00:00Z'),
      },
    },
  })])

  const state = await startPlugin({
    providers: [{ id: 'commandcode' }],
    commandCodeUsage: usage.service,
  })
  const payload = await state()

  // Nothing measurable: no chip at all, rather than a 0% (exhausted) one, and
  // no fallback request to the billing endpoints either.
  assert.deepEqual(payload.providers, [])
})

test('commandcode: an uncapped window leaves the reported monthly window to carry the chip', async () => {
  const usage = commandCodeUsageService([commandCodeAccount({
    report: {
      failures: [],
      credits: {
        monthlyCredits: 20,
        purchasedCredits: 0,
        freeCredits: 0,
        fiveHour: { used: 900, cap: 0, exceeded: false, resetAt: 1_795_603_200_000 },
        weekly: { used: 50, cap: 0, exceeded: false, resetAt: 1_796_103_498_000 },
      },
      plan: {
        planId: 'individual-goat',
        name: 'GOAT',
        status: 'active',
        monthlyCredits: 70,
        currentPeriodEnd: Date.parse('2026-12-01T00:00:00Z'),
      },
    },
  })])

  const state = await startPlugin({
    providers: [{ id: 'commandcode' }],
    commandCodeUsage: usage.service,
  })
  const entry = entryOf(await state(), 'command-code')

  assert.equal(entry.status, 'ok')
  assert.deepEqual(entry.windows.map((window) => window.tier), ['monthly'])
  // 20 of GOAT's 70 credits left: 71% used, so 29% left — not exhausted.
  assert.equal(Math.round(windowOf(entry, 'monthly').usedPercent), 71)
})

test('commandcode: a selected account with no credit report shows as unreadable, not missing', async () => {
  const calls = stubFetch(() => undefined)
  const usage = commandCodeUsageService([commandCodeAccount({ report: { failures: [] } })])

  const state = await startPlugin({
    providers: [{ id: 'commandcode' }],
    commandCodeUsage: usage.service,
  })
  const entry = entryOf(await state(), 'command-code')

  // The service answered and the account is configured, but no quota could be
  // read: a visible failure chip, and no billing fallback request.
  assert.equal(entry.status, 'error')
  assert.equal(entry.error.kind, 'http')
  assert.equal(calls.length, 0)
})

test('commandcode: when every report endpoint failed the chip names the failure', async () => {
  const usage = commandCodeUsageService([commandCodeAccount({
    report: { failures: ['credits', 'subscriptions'] },
  })])

  const state = await startPlugin({
    providers: [{ id: 'commandcode' }],
    commandCodeUsage: usage.service,
  })
  const entry = entryOf(await state(), 'command-code')

  assert.equal(entry.status, 'error')
  assert.equal(entry.error.kind, 'http')
  assert.match(entry.error.message, /credits/)
})

test('commandcode: a rejected key in the report reads as "sign-in required"', async () => {
  const usage = commandCodeUsageService([commandCodeAccount({
    report: { failures: ['credits'], blocked: 'invalid-key' },
  })])

  const state = await startPlugin({
    providers: [{ id: 'commandcode' }],
    commandCodeUsage: usage.service,
  })
  const entry = entryOf(await state(), 'command-code')

  assert.equal(entry.status, 'error')
  assert.equal(entry.error.kind, 'auth')
})

test('commandcode: an active but unconfigured slot is skipped, never drawn as an error', async () => {
  const unconfigured = commandCodeAccount({
    id: 'account-2',
    label: 'Spare',
    configured: false,
    active: true,
    report: { failures: ['credits'], blocked: 'invalid-key' },
  })
  const usage = commandCodeUsageService([unconfigured, commandCodeAccount()])

  const state = await startPlugin({
    providers: [{ id: 'commandcode' }],
    commandCodeUsage: usage.service,
  })
  const payload = await state()

  // The unusable slot would answer `invalid-key`; it is skipped, and the one
  // configured account supplies the chip with its own plan and windows.
  assert.deepEqual(payload.providers.map((entry) => entry.provider), ['command-code'])
  assert.equal(payload.providers[0].status, 'ok')
  assert.equal(payload.providers[0].planTier, 'GOAT')
  assert.equal(windowOf(payload.providers[0], 'five_hour').usedPercent, 30)
})

test('commandcode: a broken report service falls back to the billing endpoints', async () => {
  const calls = stubCommandCode()

  const state = await startPlugin({
    providers: [{ id: 'commandcode' }],
    commandCodeUsage: {
      async report() {
        throw new Error('MISSING_CREDENTIAL')
      },
    },
    resolve: async (envName) => (envName === 'COMMANDCODE_API_KEY' ? { value: 'cc-key' } : undefined),
  })
  const entry = entryOf(await state(), 'command-code')

  assert.equal(entry.status, 'ok')
  assert.equal(windowOf(entry, 'five_hour').usedPercent, 30)
  assert.equal(calls.length, 2)
})

test('registry: vendor aliases resolve to one chip per provider', async () => {
  await loginClaude({ claudeAiOauth: { accessToken: 'sk-ant-oat-5', expiresAt: Date.now() + 3_600_000 } })
  stubFetch((url) => (url.startsWith('https://api.anthropic.com/api/oauth/usage') ? response(200, CLAUDE_USAGE) : undefined))

  const state = await startPlugin({ providers: [{ id: 'anthropic' }, { id: 'claude' }, { id: 'cpa' }] })
  const payload = await state()

  assert.deepEqual(payload.providers.map((entry) => entry.provider), ['claude'])
})

// ---------------------------------------------------------------------------
// Antigravity: the local Connect-RPC probe (codexbar's app / ide / agy paths).
// ---------------------------------------------------------------------------

const ANTIGRAVITY_APP = '/Applications/Antigravity.app/Contents/Resources/app/out/vs/language_server_macos_arm'
  + ' --app_data_dir antigravity --csrf_token tok-app --extension_server_port 61234'
const ANTIGRAVITY_IDE = '/Applications/Antigravity IDE.app/extensions/antigravity/bin/language_server_macos_arm'
  + ' --app_data_dir antigravity-ide --csrf_token tok-ide'
const ANTIGRAVITY_CLI = '/home/u/.local/bin/agy'

const ANTIGRAVITY_SUMMARY = {
  response: {
    groups: [
      {
        displayName: 'Gemini Models',
        buckets: [
          { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.96, resetTime: '2026-12-01T00:00:00Z' },
          { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.87, resetTime: '2026-11-25T20:00:00Z' },
        ],
      },
      {
        displayName: 'Claude and GPT models',
        buckets: [
          { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.79, resetTime: '2026-12-01T00:00:00Z' },
          { bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: '2026-11-25T20:00:00Z' },
        ],
      },
    ],
  },
}

function antigravityFake({ processes, ports = {}, rpc }) {
  const calls = []
  return {
    calls,
    transport: {
      async listProcesses() {
        return processes
      },
      async listPorts(pid) {
        return ports[pid] ?? []
      },
      async postJson(request) {
        calls.push(request)
        return rpc(request)
      },
    },
  }
}

test('antigravity: summary buckets split into the Gemini and Claude/GPT pools', async () => {
  const fake = antigravityFake({
    processes: [{ pid: 4242, startedAt: 1_000, command: ANTIGRAVITY_APP }],
    ports: { 4242: [50_065] },
    rpc: ({ path, csrfToken }) => {
      if (path.endsWith('/GetUnleashData')) {
        assert.equal(csrfToken, 'tok-app')
        return { status: 200, json: {} }
      }
      if (path.endsWith('/RetrieveUserQuotaSummary')) return { status: 200, json: ANTIGRAVITY_SUMMARY }
      if (path.endsWith('/GetUserStatus')) {
        return { status: 200, json: { response: { userStatus: { userTier: { name: 'Google AI Pro' } } } } }
      }
      return { status: 404, json: {} }
    },
  })

  const state = await startPlugin()
  state.setAntigravityTransport(fake.transport)
  const entry = entryOf(await state(), 'antigravity')

  assert.equal(entry.status, 'ok')
  assert.equal(entry.providerName, 'Antigravity')
  assert.equal(entry.planTier, 'Google AI Pro')
  assert.deepEqual(entry.windows.map((window) => [window.tier, Math.round(window.usedPercent)]), [
    ['gemini_five_hour', 13],
    ['gemini_weekly', 4],
    ['third_party_five_hour', 0],
    ['third_party_weekly', 21],
  ])
  // HTTPS first, then the same port over HTTP, then the extension server port.
  assert.deepEqual(
    fake.calls.slice(0, 1).map((call) => `${call.scheme}:${String(call.port)}`),
    ['https:50065'],
  )
})

test('antigravity: the most recently started CLI wins over a stale one', async () => {
  const stale = '/opt/antigravity-cli/bin/agy'
  const fake = antigravityFake({
    processes: [
      { pid: 100, startedAt: 1_000, command: ANTIGRAVITY_CLI },
      { pid: 200, startedAt: 2_000, command: stale },
    ],
    ports: { 100: [40_001], 200: [40_002] },
    rpc: ({ port, path }) => {
      if (path.endsWith('/GetUnleashData')) return { status: 200, json: {} }
      if (path.endsWith('/RetrieveUserQuotaSummary')) {
        return {
          status: 200,
          json: {
            response: {
              groups: [{
                displayName: 'Gemini Models',
                buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: port === 40_002 ? 0.5 : 0.1 }],
              }],
            },
          },
        }
      }
      return { status: 404, json: {} }
    },
  })

  const state = await startPlugin()
  state.setAntigravityTransport(fake.transport)
  const entry = entryOf(await state(), 'antigravity')

  assert.equal(entry.status, 'ok')
  assert.equal(windowOf(entry, 'gemini_five_hour').usedPercent, 50)
  assert.ok(fake.calls.every((call) => call.port === 40_002))
})

test('antigravity: a desktop server without its --csrf_token is ignored', async () => {
  const tokenless = ANTIGRAVITY_APP.replace(' --csrf_token tok-app', '')
  const fake = antigravityFake({
    processes: [{ pid: 7, startedAt: 1_000, command: tokenless }],
    ports: { 7: [50_000] },
    rpc: () => {
      throw new Error('must not be called')
    },
  })

  const state = await startPlugin()
  state.setAntigravityTransport(fake.transport)
  const payload = await state()

  assert.deepEqual(payload.providers, [])
  assert.equal(fake.calls.length, 0)
})

test('antigravity: no quota summary falls back to the legacy GetUserStatus payload', async () => {
  const fake = antigravityFake({
    processes: [{ pid: 909, startedAt: 1_000, command: ANTIGRAVITY_IDE }],
    ports: { 909: [50_100] },
    rpc: ({ path }) => {
      if (path.endsWith('/GetUnleashData')) return { status: 200, json: {} }
      if (path.endsWith('/RetrieveUserQuotaSummary')) return { status: 404, json: {} }
      if (path.endsWith('/GetUserStatus')) {
        return {
          status: 200,
          json: {
            response: {
              userStatus: {
                userTier: { name: 'Pro' },
                cascadeModelConfigData: {
                  clientModelConfigs: [
                    { label: 'Gemini 3 Pro', modelOrAlias: { model: 'gemini-3-pro' }, quotaInfo: { remainingFraction: 0.4 } },
                    { label: 'Claude Sonnet', modelOrAlias: { model: 'claude-sonnet-4' }, quotaInfo: { remainingFraction: 0.25 } },
                    { label: 'Gemini Flash Lite', modelOrAlias: { model: 'gemini-3-flash-lite' }, quotaInfo: { remainingFraction: 0.9 } },
                  ],
                },
              },
            },
          },
        }
      }
      return { status: 404, json: {} }
    },
  })

  const state = await startPlugin()
  state.setAntigravityTransport(fake.transport)
  const entry = entryOf(await state(), 'antigravity')

  assert.equal(entry.status, 'ok')
  assert.equal(entry.planTier, 'Pro')
  // Lite models are not quota representatives, so Gemini Pro's 60% used wins.
  assert.deepEqual(entry.windows.map((window) => [window.tier, Math.round(window.usedPercent)]), [
    ['gemini_five_hour', 60],
    ['third_party_five_hour', 75],
  ])
})

test('antigravity: an unreachable server reports a failure instead of throwing', async () => {
  const fake = antigravityFake({
    processes: [{ pid: 55, startedAt: 1_000, command: ANTIGRAVITY_CLI }],
    ports: { 55: [49_999] },
    rpc: () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:49999')
    },
  })

  const state = await startPlugin()
  state.setAntigravityTransport(fake.transport)
  const entry = entryOf(await state(), 'antigravity')

  assert.equal(entry.status, 'error')
  assert.equal(entry.error.kind, 'http')
})

test('CLIProxyAPI: lists quota-capable auth files and normalizes their windows safely', async () => {
  const managementKey = 'management-secret-must-not-leak'
  process.env.CLI_PROXY_MANAGEMENT_URL = 'http://127.0.0.1:8317/v1/'
  const calls = stubFetch((url, init) => {
    assert.equal(init.headers.authorization, `Bearer ${managementKey}`)
    if (url === 'http://127.0.0.1:8317/v0/management/auth-files') {
      return response(200, {
        files: [
          {
            name: 'claude-account.json',
            provider: 'quota-plugin',
            email: 'claude@example.test',
            auth_index: 'a1b2c3d4e5f67890',
            supports_quota: true,
            access_token: 'auth-file-token-must-not-leak',
          },
          { name: 'unsupported.json', provider: 'openai', auth_index: 8, supports_quota: false },
          { name: 'disabled.json', provider: 'gemini', auth_index: 9, supports_quota: true, disabled: true },
        ],
      })
    }
    if (url === 'http://127.0.0.1:8317/v0/management/quota/fetch') {
      assert.equal(init.method, 'POST')
      assert.deepEqual(JSON.parse(init.body), { auth_index: 'a1b2c3d4e5f67890', provider: 'quota-plugin' })
      return response(200, {
        groups: [{
          displayName: 'Claude Pro',
          buckets: [
            { bucketId: 'five-hour', window: '5h', remainingFraction: 0.72, resetTime: '2026-11-27T12:00:00.000Z' },
            { bucketId: 'weekly', window: 'weekly', remainingFraction: 0.4, resetTime: 1_795_000_000 },
          ],
        }],
        subscription: { tierName: 'Pro' },
      })
    }
    return undefined
  })
  const state = await startPlugin({
    resolve: async (ref) => {
      assert.equal(ref, 'CLI_PROXY_MANAGEMENT_KEY')
      return { value: managementKey, source: 'test' }
    },
  })

  const payload = await state()
  const entries = payload.providers.filter((entry) => entry.provider.startsWith('cli-proxy-'))
  assert.equal(entries.length, 1)
  const entry = entries[0]
  assert.equal(entry.status, 'ok')
  assert.equal(entry.providerName, 'CLIProxy · quota-plugin · Account #1')
  assert.equal(entry.markProvider, 'quota-plugin')
  assert.equal(entry.planTier, 'Pro')
  assert.equal(entry.windows[0].usedPercent, 28)
  assert.equal(entry.windows[0].tier, 'five_hour')
  assert.equal(entry.windows[0].resetAt, Date.parse('2026-11-27T12:00:00.000Z'))
  assert.equal(entry.windows[1].usedPercent, 60)
  assert.equal(calls.length, 2)
  assert.ok(calls.every((call) => !call.init.body?.includes(managementKey)))
  const publicState = JSON.stringify(payload)
  assert.equal(publicState.includes(managementKey), false)
  assert.equal(publicState.includes('auth-file-token-must-not-leak'), false)
  assert.equal(publicState.includes('a1b2c3d4e5f67890'), false)
  assert.equal(publicState.includes('claude@example.test'), false)
  assert.equal(publicState.includes('claude-account.json'), false)
})

test('CLIProxyAPI: optional provider-list probe returns only cleaned names and service URLs', async () => {
  const managementKey = 'provider-list-management-secret'
  const credentialStore = new Map([['CLI_PROXY_MANAGEMENT_KEY', managementKey]])
  const calls = stubFetch((url, init) => {
    assert.equal(init.headers.authorization, `Bearer ${managementKey}`)
    if (url === 'http://127.0.0.1:8317/v0/management/auth-files') return response(200, { files: [] })
    if (url === 'http://127.0.0.1:8317/v0/management/openai-compatibility') {
      assert.equal(init.method, 'GET')
      return response(200, {
        'openai-compatibility': [
          {
            name: 'Provider One',
            'base-url': 'https://api.one.example/v1?token=url-token-must-not-leak#fragment',
            'api-key-entries': [{ name: 'main', 'api-key': 'provider-api-key-must-not-leak' }],
          },
          {
            name: 'Provider Two',
            'base-url': 'http://user:password@127.0.0.1:9000/v1',
            disabled: true,
            headers: { Authorization: 'header-secret-must-not-leak' },
          },
        ],
      })
    }
    return undefined
  })
  const state = await startPlugin({ credentialStore })

  const payload = await state({ includeCliProxyProviders: true })
  assert.deepEqual(payload.cliProxyConfiguredProviders, {
    status: 'ok',
    providers: [
      { name: 'Provider One', baseUrl: 'https://api.one.example/v1', disabled: false },
      { name: 'Provider Two', baseUrl: 'http://127.0.0.1:9000/v1', disabled: true },
    ],
  })
  assert.equal(calls.filter((call) => call.url.endsWith('/openai-compatibility')).length, 1)
  const publicState = JSON.stringify(payload)
  for (const secret of [managementKey, 'url-token-must-not-leak', 'provider-api-key-must-not-leak', 'header-secret-must-not-leak', 'password']) {
    assert.equal(publicState.includes(secret), false)
  }
})

test('CLIProxyAPI: provider-list probe returns only a safe management error category', async () => {
  const managementKey = 'provider-list-management-secret'
  const credentialStore = new Map([['CLI_PROXY_MANAGEMENT_KEY', managementKey]])
  stubFetch((url, init) => {
    assert.equal(init.headers.authorization, `Bearer ${managementKey}`)
    return response(401, 'error body that must never be returned')
  })
  const state = await startPlugin({ credentialStore })

  const payload = await state({ includeCliProxyProviders: true })
  assert.deepEqual(payload.cliProxyConfiguredProviders, {
    status: 'error',
    error: 'management-auth-failed',
    providers: [],
  })
  assert.equal(JSON.stringify(payload).includes('error body that must never be returned'), false)
  assert.equal(JSON.stringify(payload).includes(managementKey), false)
})

test('CLIProxyAPI: Host environment credentials work without Client settings UI', async () => {
  const managementKey = 'ambient-management-secret'
  process.env.CLI_PROXY_MANAGEMENT_KEY = managementKey
  const calls = stubFetch((url, init) => {
    assert.equal(url, 'http://127.0.0.1:8317/v0/management/auth-files')
    assert.equal(init.headers.authorization, `Bearer ${managementKey}`)
    return response(200, { files: [] })
  })
  const state = await startPlugin()
  const payload = await state({ refresh: true })
  const settings = await state.settings()

  assert.deepEqual(payload.providers, [])
  assert.equal(settings.status, 200)
  assert.equal(settings.payload.managementKeyConfigured, true)
  assert.equal(JSON.stringify(settings).includes(managementKey), false)
  assert.equal(calls.length, 1)
})

test('CLIProxyAPI: built-in OAuth auth files work without supports_quota and keep identities private', async () => {
  const managementKey = 'management-secret-must-not-leak'
  process.env.CLI_PROXY_MANAGEMENT_URL = 'http://127.0.0.1:8317'
  const authFiles = [
    { name: 'private-codex.json', email: 'codex@example.test', provider: 'openai-codex', auth_index: 'a1b2c3d4c0de0001', supports_quota: false, access_token: 'oauth-codex-secret' },
    { name: 'private-claude.json', email: 'claude@example.test', provider: 'claude-code', auth_index: 'a1b2c3d4c0de0002', access_token: 'oauth-claude-secret' },
    { name: 'private-gemini.json', email: 'gemini@example.test', provider: 'gemini-cli', auth_index: 'a1b2c3d4c0de0003', access_token: 'oauth-gemini-secret' },
    { name: 'private-antigravity.json', email: 'ag@example.test', provider: 'antigravity', auth_index: 'a1b2c3d4c0de0004', access_token: 'oauth-ag-secret' },
    { name: 'private-kimi.json', email: 'kimi@example.test', provider: 'moonshot', auth_index: 'a1b2c3d4c0de0005', access_token: 'oauth-kimi-secret' },
    { name: 'private-xai.json', email: 'xai@example.test', provider: 'grok', auth_index: 'a1b2c3d4c0de0006', access_token: 'oauth-xai-secret' },
    { name: 'private-devin.json', email: 'devin@example.test', provider: 'devin', auth_index: 'a1b2c3d4c0de0007', access_token: 'oauth-devin-secret' },
    { name: 'private-meta.json', email: 'meta@example.test', provider: 'meta', auth_index: 'a1b2c3d4c0de0008', access_token: 'oauth-meta-secret' },
  ]
  const apiCalls = []
  const managementResponse = (body) => response(200, { status_code: 200, body })
  const calls = stubFetch((url, init) => {
    assert.equal(init.headers.authorization, `Bearer ${managementKey}`)
    if (url.endsWith('/v0/management/auth-files')) return response(200, { files: authFiles })
    if (url.startsWith('http://127.0.0.1:8317/v0/management/auth-files/download?')) {
      assert.equal(url, 'http://127.0.0.1:8317/v0/management/auth-files/download?name=private-meta.json')
      return response(200, { dca_token: 'dca:private-meta-token' })
    }
    if (!url.endsWith('/v0/management/api-call')) return undefined
    const request = JSON.parse(init.body)
    apiCalls.push(request)
    assert.equal(typeof request.auth_index, 'string')
    assert.equal(typeof request.method, 'string')
    assert.equal(typeof request.url, 'string')
    assert.equal(typeof request.header, 'object')
    if (request.url === 'https://chatgpt.com/backend-api/wham/usage') {
      return managementResponse({ rate_limit: { primary_window: { used_percent: 25, reset_after_seconds: 1800 }, secondary_window: { used_percent: 40 } } })
    }
    if (request.url === 'https://api.anthropic.com/api/oauth/usage') {
      return managementResponse({ five_hour: { utilization: 35, resets_at: '2026-11-28T00:00:00Z' }, seven_day: { utilization: 55 } })
    }
    if (request.url === 'https://api.anthropic.com/api/oauth/profile') {
      return managementResponse({ account: { has_claude_pro: true } })
    }
    if (request.url === 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist') {
      const project = request.auth_index === 'a1b2c3d4c0de0003' ? 'gemini-project' : 'antigravity-project'
      return managementResponse({ cloudaicompanionProject: { id: project }, paidTier: { name: 'Pro' } })
    }
    if (request.url === 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota') {
      return managementResponse({ buckets: [{ modelId: 'gemini-2.5-pro', remainingFraction: 0.7, resetTime: '2026-11-28T00:00:00Z' }] })
    }
    if (request.url === 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary') {
      return managementResponse({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.75 }] }] })
    }
    if (request.url === 'https://api.kimi.com/coding/v1/usages') {
      return managementResponse({ usage: { used: 20, limit: 100, reset_in: 3600 } })
    }
    if (request.url === 'https://cli-chat-proxy.grok.com/v1/billing?format=credits') {
      return managementResponse({ creditUsagePercent: 25, currentPeriod: { end: '2026-11-30T00:00:00Z' } })
    }
    if (request.url === 'https://cli-chat-proxy.grok.com/v1/billing') {
      return managementResponse({ monthlyLimit: { val: 100 }, used: { val: 40 } })
    }
    if (request.url === 'https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus') {
      assert.equal(JSON.parse(request.data).metadata.apiKey, '$TOKEN$')
      return managementResponse({ userStatus: { planStatus: { dailyQuotaRemainingPercent: 80, weeklyQuotaRemainingPercent: 60, planInfo: { planName: 'Pro' } } } })
    }
    if (request.url === 'https://api.meta.ai/muse-code/key') {
      assert.equal(request.header.Authorization, 'Bearer dca:private-meta-token')
      return managementResponse({ subs_tier_name: 'Pro', subs_usage: { window: { window_duration_mins: 300, used_percent: 20 }, weekly: { used_percent: 40 } } })
    }
    throw new Error(`unexpected built-in URL: ${request.url}`)
  })
  const state = await startPlugin({ resolve: async (ref) => (ref === 'CLI_PROXY_MANAGEMENT_KEY' ? { value: managementKey } : undefined) })

  const payload = await state()
  const entries = payload.providers.filter((entry) => entry.provider.startsWith('cli-proxy-'))
  assert.equal(entries.length, authFiles.length)
  assert.ok(entries.every((entry) => entry.status === 'ok'))
  assert.equal(apiCalls.length, 12)
  assert.ok(apiCalls.every((request) => authFiles.some((file) => file.auth_index === request.auth_index)))
  assert.equal(windowOf(entryOf(payload, 'cli-proxy-codex-1'), 'five_hour').usedPercent, 25)
  assert.equal(entryOf(payload, 'cli-proxy-claude-2').planTier, 'Pro')
  assert.equal(Math.round(windowOf(entryOf(payload, 'cli-proxy-gemini-cli-3'), 'other').usedPercent), 30)
  assert.equal(windowOf(entryOf(payload, 'cli-proxy-antigravity-4'), 'gemini_five_hour').usedPercent, 25)
  assert.equal(windowOf(entryOf(payload, 'cli-proxy-kimi-5'), 'weekly').usedPercent, 20)
  assert.equal(windowOf(entryOf(payload, 'cli-proxy-xai-6'), 'weekly').usedPercent, 25)
  assert.equal(windowOf(entryOf(payload, 'cli-proxy-xai-6'), 'monthly').usedPercent, 40)
  assert.equal(entryOf(payload, 'cli-proxy-devin-7').planTier, 'Pro')
  assert.equal(windowOf(entryOf(payload, 'cli-proxy-meta-8'), 'five_hour').usedPercent, 20)
  assert.ok(calls.every((call) => !call.init.body?.includes(managementKey)))
  const publicState = JSON.stringify(payload)
  for (const secret of [managementKey, ...authFiles.map((file) => file.auth_index), 'private-codex.json', 'private-meta.json', 'codex@example.test', 'oauth-codex-secret', 'oauth-claude-secret', 'oauth-gemini-secret', 'oauth-ag-secret', 'oauth-kimi-secret', 'oauth-xai-secret', 'oauth-devin-secret', 'oauth-meta-secret', 'dca:private-meta-token']) {
    assert.equal(publicState.includes(secret), false, `public state must not contain ${secret}`)
  }
})

test('CLIProxyAPI: does not call management APIs until a key is configured', async () => {
  globalThis.fetch = async () => {
    throw new Error('must not call CLIProxyAPI without a management key')
  }
  const state = await startPlugin()
  assert.deepEqual((await state()).providers, [])
})

test('Host routes: save CLIProxyAPI credentials and retrieve quota without the Client UI', async () => {
  const managementKey = 'settings-secret-must-not-leak'
  const calls = stubFetch((url, init) => {
    if (url === 'http://localhost:8317/v0/management/auth-files') {
      assert.equal(init.headers.authorization, `Bearer ${managementKey}`)
      return response(200, { files: [{ name: 'private-direct.json', provider: 'direct-provider', auth_index: 'a1b2c3d4e5f67890', supports_quota: true }] })
    }
    if (url === 'http://localhost:8317/v0/management/quota/fetch') {
      assert.equal(init.headers.authorization, `Bearer ${managementKey}`)
      assert.deepEqual(JSON.parse(init.body), { auth_index: 'a1b2c3d4e5f67890', provider: 'direct-provider' })
      return response(200, { windows: [{ window: '5h', usedPercent: 25 }] })
    }
    return undefined
  })
  const state = await startPlugin()

  const initial = await state.settings()
  assert.equal(initial.status, 200)
  assert.equal(initial.payload.managementUrl, 'http://127.0.0.1:8317')
  assert.equal(initial.payload.managementKeyConfigured, false)

  const saved = await state.settings({
    method: 'POST',
    body: { managementUrl: 'http://localhost:8317/v1/', managementKey },
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.payload.managementUrl, 'http://localhost:8317/v1/')
  assert.equal(saved.payload.managementKeyConfigured, true)
  assert.equal(JSON.stringify(saved).includes(managementKey), false)

  const quotaPayload = await state()
  assert.equal(quotaPayload.providers.length, 1)
  assert.equal(quotaPayload.providers[0].provider, 'cli-proxy-direct-provider-1')
  assert.equal(quotaPayload.providers[0].windows[0].usedPercent, 25)
  assert.deepEqual(calls.map((call) => call.url), [
    'http://localhost:8317/v0/management/auth-files',
    'http://localhost:8317/v0/management/quota/fetch',
  ])
  assert.equal(JSON.stringify(quotaPayload).includes('a1b2c3d4e5f67890'), false)
  assert.equal(JSON.stringify(quotaPayload).includes('settings-secret-must-not-leak'), false)

  const cleared = await state.settings({
    method: 'POST',
    body: { clearManagementUrl: true, clearManagementKey: true },
  })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.payload.managementUrl, 'http://127.0.0.1:8317')
  assert.equal(cleared.payload.managementKeyConfigured, false)
  assert.equal(JSON.stringify(cleared).includes(managementKey), false)
  assert.equal(calls.length, 2)
})

test('CLIProxyAPI settings: changing the management key invalidates cached quota', async () => {
  const oldKey = 'previous-management-secret'
  const newKey = 'current-management-secret'
  const calls = []
  const credentialStore = new Map([['CLI_PROXY_MANAGEMENT_KEY', oldKey]])
  stubFetch((url, init) => {
    calls.push({ url, authorization: init.headers.authorization })
    if (init.headers.authorization === `Bearer ${oldKey}`) return response(200, { files: [] })
    if (init.headers.authorization !== `Bearer ${newKey}`) return response(401, { error: 'unauthorized' })
    if (url === 'http://127.0.0.1:8317/v0/management/auth-files') {
      return response(200, { files: [{ name: 'current-account.json', provider: 'quota-plugin', auth_index: 'opaque-current-index', supports_quota: true }] })
    }
    if (url === 'http://127.0.0.1:8317/v0/management/quota/fetch') {
      return response(200, { windows: [{ window: '5h', usedPercent: 20 }] })
    }
    return undefined
  })
  const state = await startPlugin({ credentialStore })
  assert.deepEqual((await state()).providers, [])

  const saved = await state.settings({ method: 'POST', body: { managementKey: newKey } })
  assert.equal(saved.status, 200)
  assert.equal(saved.payload.managementKeyConfigured, true)
  const refreshed = await state({ refresh: true })

  assert.equal(refreshed.providers.length, 1)
  assert.equal(refreshed.providers[0].provider, 'cli-proxy-quota-plugin-1')
  assert.equal(refreshed.providers[0].windows[0].usedPercent, 20)
  assert.deepEqual(calls.map((call) => call.authorization), [
    `Bearer ${oldKey}`,
    `Bearer ${newKey}`,
    `Bearer ${newKey}`,
  ])
  assert.equal(JSON.stringify(refreshed).includes(newKey), false)
  assert.equal(JSON.stringify(refreshed).includes('opaque-current-index'), false)
})

test('CLIProxyAPI settings: uses ctx.get and identifies an unavailable credential service', async () => {
  const state = await startPlugin({ credentialsUnavailable: true })
  const result = await state.settings({
    method: 'POST',
    body: { managementKey: 'must-not-be-stored' },
  })
  assert.equal(result.status, 503)
  assert.deepEqual(result.payload, { error: 'credential-store-unavailable' })
  assert.equal(state.credentialStore.has('CLI_PROXY_MANAGEMENT_KEY'), false)
})

test('CLIProxyAPI settings: reports safe partial writes without leaking input', async () => {
  const managementKey = 'settings-secret-must-not-leak'
  const state = await startPlugin({
    set: async (ref) => {
      if (ref !== 'CLI_PROXY_MANAGEMENT_KEY') return
      const error = new Error(`write denied for ${managementKey} at C:\\private\\credentials.yaml`)
      error.code = 'EACCES'
      throw error
    },
  })
  const result = await state.settings({
    method: 'POST',
    body: { managementUrl: 'http://localhost:8317', managementKey },
  })
  assert.equal(result.status, 500)
  assert.deepEqual(result.payload, {
    error: 'settings-save-failed',
    reason: 'credential-store-permission-denied',
    partial: true,
  })
  assert.equal(state.credentialStore.get('CLI_PROXY_MANAGEMENT_URL'), 'http://localhost:8317')
  assert.equal(state.credentialStore.has('CLI_PROXY_MANAGEMENT_KEY'), false)
  assert.equal(JSON.stringify(result).includes(managementKey), false)
  assert.equal(JSON.stringify(result).includes('C:\\private'), false)
})

test('CLIProxyAPI settings: rejects cross-origin writes and invalid management URLs', async () => {
  const state = await startPlugin()
  const denied = await state.settings({
    method: 'POST',
    origin: 'https://attacker.example',
    body: { managementKey: 'must-not-be-stored' },
  })
  assert.equal(denied.status, 403)
  assert.equal(state.credentialStore.has('CLI_PROXY_MANAGEMENT_KEY'), false)

  const invalid = await state.settings({
    method: 'POST',
    body: { managementUrl: 'file:///etc/passwd' },
  })
  assert.equal(invalid.status, 400)
  assert.equal(state.credentialStore.has('CLI_PROXY_MANAGEMENT_URL'), false)
})

test('CLIProxyAPI settings: Desktop Host calls without Origin can save through Connection admission', async () => {
  const managementKey = 'desktop-settings-secret-must-not-leak'
  let securityChecks = 0
  const state = await startPlugin({
    requestRejection(request) {
      securityChecks += 1
      assert.equal(request.headers.origin, undefined)
      return undefined
    },
  })
  const result = await state.settings({
    method: 'POST',
    origin: null,
    body: { managementKey },
  })

  assert.equal(result.status, 200)
  assert.equal(securityChecks, 1)
  assert.equal(state.credentialStore.get('CLI_PROXY_MANAGEMENT_KEY'), managementKey)
  assert.equal(JSON.stringify(result).includes(managementKey), false)
})

test('CLIProxyAPI settings: fails closed when Host request security is unavailable or denies the call', async () => {
  const unavailable = await startPlugin({ connectionUnavailable: true })
  const unavailableResult = await unavailable.settings({
    method: 'POST',
    body: { managementKey: 'must-not-be-stored' },
  })
  assert.equal(unavailableResult.status, 503)
  assert.deepEqual(unavailableResult.payload, { error: 'request-security-unavailable' })
  assert.equal(unavailable.credentialStore.has('CLI_PROXY_MANAGEMENT_KEY'), false)

  const denied = await startPlugin({ requestRejection: () => 401 })
  const deniedResult = await denied.settings({
    method: 'POST',
    origin: null,
    body: { managementKey: 'must-not-be-stored' },
  })
  assert.equal(deniedResult.status, 401)
  assert.deepEqual(deniedResult.payload, { error: 'request-rejected' })
  assert.equal(denied.credentialStore.has('CLI_PROXY_MANAGEMENT_KEY'), false)
})

test('CLIProxyAPI: preserves same-named auth files with distinct auth indices', async () => {
  process.env.CLI_PROXY_MANAGEMENT_URL = 'http://127.0.0.1:8317'
  const calls = stubFetch((url, init) => {
    if (url.endsWith('/v0/management/auth-files')) {
      return response(200, {
        files: [
          { name: 'duplicate-account.json', provider: 'custom-test', auth_index: 'a1b2c3d4e5f67890', supports_quota: true },
          { name: 'duplicate-account.json', provider: 'custom-test', auth_index: 'a1b2c3d4e5f67891', supports_quota: true },
        ],
      })
    }
    if (url.endsWith('/v0/management/quota/fetch')) {
      const index = JSON.parse(init.body).auth_index
      const usedPercent = index === 'a1b2c3d4e5f67890' ? 7 : 8
      return response(200, { windows: [{ window: '5h', usedPercent }] })
    }
    return undefined
  })
  const state = await startPlugin({ resolve: async (ref) => (ref === 'CLI_PROXY_MANAGEMENT_KEY' ? { value: 'test-key' } : undefined) })

  const entries = (await state()).providers.filter((entry) => entry.provider.startsWith('cli-proxy-'))
  assert.equal(entries.length, 2)
  assert.notEqual(entries[0].provider, entries[1].provider)
  assert.deepEqual(entries.map((entry) => entry.windows[0].usedPercent), [7, 8])
  assert.ok(entries[0].providerName.endsWith('#1'))
  assert.ok(entries[1].providerName.endsWith('#2'))
  const publicState = JSON.stringify(entries)
  assert.equal(publicState.includes('a1b2c3d4e5f67890'), false)
  assert.equal(publicState.includes('a1b2c3d4e5f67891'), false)
  assert.equal(calls.length, 3)
})

test('CLIProxyAPI: skips auth files without quota support', async () => {
  process.env.CLI_PROXY_MANAGEMENT_URL = 'http://127.0.0.1:8317'
  const calls = stubFetch((url) => url.endsWith('/v0/management/auth-files')
    ? response(200, { files: [{ name: 'plain.json', provider: 'openai', auth_index: 2, supports_quota: false }] })
    : undefined)
  const state = await startPlugin({ resolve: async (ref) => (ref === 'CLI_PROXY_MANAGEMENT_KEY' ? { value: 'test-key' } : undefined) })

  assert.deepEqual((await state()).providers, [])
  assert.equal(calls.length, 1)
})

test('CLIProxyAPI: management errors expose only a safe status category', async () => {
  process.env.CLI_PROXY_MANAGEMENT_URL = 'http://127.0.0.1:8317'
  const calls = stubFetch((url) => url.endsWith('/v0/management/auth-files')
    ? response(401, { message: 'secret-bearing upstream body' })
    : undefined)
  const state = await startPlugin({ resolve: async (ref) => (ref === 'CLI_PROXY_MANAGEMENT_KEY' ? { value: 'private-management-key' } : undefined) })

  const entry = entryOf(await state(), 'cli-proxy-api')
  assert.equal(entry.status, 'error')
  assert.equal(entry.error.kind, 'auth')
  assert.equal(calls.length, 1)
  const publicState = JSON.stringify(entry)
  assert.equal(publicState.includes('private-management-key'), false)
  assert.equal(publicState.includes('secret-bearing upstream body'), false)
})

test('Client: provider controls register in Plugins settings, not quota bars', async () => {
  const [clientSource, packageText] = await Promise.all([
    readFile(join(import.meta.dirname, '..', 'client.js'), 'utf8'),
    readFile(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
  ])
  const manifest = JSON.parse(packageText)

  assert.match(clientSource, /ctx\.slots\.inject\('settings\.plugins\.tab'/)
  assert.match(clientSource, /name: 'settings\.plugins\.tab',[\s\S]*?id: 'provider-quota',[\s\S]*?order: 30,[\s\S]*?label: \(\) => t\('providerSettingsTab'\)/)
  assert.match(clientSource, /h\(ProviderQuotaSettingsPage/)
  assert.match(clientSource, /if \(!isSidebar && !displayPositions\.composer\) return null/)
  assert.doesNotMatch(clientSource, /renderSettingsButton|renderSettingsPanel|providerSettingsOpen/)
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings-plugins'))
})
