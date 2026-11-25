// Host half of the provider quota bar.
//
// One same-origin JSON route, `/provider-quota/state`, reports the plan usage
// of every configured provider plus the local Codex CLI; the browser half only
// renders that payload, so credentials and provider HTTP never reach the
// browser.
//
// Providers come from two places:
//   - the live LLM registry (`ctx.llm.listProviders()`), with API keys resolved
//     through the credential seam by environment-variable name, so a key
//     changed in Settings reaches the next poll without a restart;
//   - local coding CLIs that keep their own ChatGPT/subscription login (Codex
//     reads `~/.codex/auth.json`, the same credential its `/status` uses).
//
// Endpoint knowledge (verified against the live services):
//   opencode-go   GET https://opencode.ai/zen/go/v1/usage
//                 → usage.rolling (5-hour) · weekly · monthly,
//                   each { status, percent (used), resetsAt (ISO-8601) }
//   command-code  GET https://api.commandcode.ai/alpha/billing/credits
//                 → windowLimits.fiveHour / .weekly { used, cap, resetAt (ms) }
//                 GET https://api.commandcode.ai/alpha/billing/subscriptions
//                 → data.planId + data.currentPeriodEnd, paired with the plan's
//                   monthly credit allowance to derive the monthly window
//   codex         GET https://chatgpt.com/backend-api/codex/usage
//                 → plan_type, rate_limit.primary_window (5-hour) and
//                   rate_limit.secondary_window (weekly), each
//                   { used_percent, limit_window_seconds, reset_at (seconds) }

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const QUOTA_PATH = '/provider-quota/state'
const QUERY_TIMEOUT_MS = 10_000
const CACHE_TTL_MS = 45_000
const DEFAULT_INTERVAL_SEC = 60

/** Monthly credit allowance per Command Code plan id. */
const COMMAND_CODE_MONTHLY_CREDITS = {
  'individual-go': 10,
  'individual-go-v1': 10,
  'individual-goat': 70,
  'individual-pro': 30,
  'individual-pro-v1': 80,
  'individual-provider': 15,
  'individual-max': 150,
  'individual-ultra': 300,
  'teams-pro': 40,
}

/** Providers with an adapter here, and the env var holding their API key. */
const API_KEY_ENV = {
  'opencode-go': 'OPENCODE_GO_API_KEY',
  'command-code': 'COMMAND_CODE_API_KEY',
}

/** Providers that are not part of the LLM registry but still have quota. */
const LOCAL_PROVIDERS = ['codex']

/** Display names for routes whose registry id is not self-explanatory. */
const PROVIDER_LABELS = {
  codex: 'Codex',
  'openai-codex': 'Codex',
}

export const name = 'provider-quota'
export const inject = ['credentials', 'llm']

/** Per-provider cached payloads, keyed by route key. */
const cache = new Map()
/** In-flight queries, keyed by route key. */
const inflight = new Map()

function isoToMs(value) {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function percentWindow(tier, usedPercent, resetAt) {
  const window = { tier }
  if (Number.isFinite(usedPercent)) window.usedPercent = Math.max(0, Math.min(100, usedPercent))
  if (Number.isFinite(resetAt) && resetAt > 0) window.resetAt = resetAt
  return window
}

async function fetchJson(url, apiKey, extraHeaders = {}) {
  const headers = { accept: 'application/json', ...extraHeaders }
  if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  })
  if (!response.ok) {
    const error = new Error(`HTTP ${String(response.status)}`)
    error.status = response.status
    throw error
  }
  return await response.json()
}

/** opencode.ai Go plan windows: rolling (5h), weekly, monthly. */
async function queryOpencodeGo({ apiKey }) {
  const payload = await fetchJson('https://opencode.ai/zen/go/v1/usage', apiKey)
  const usage = payload?.usage ?? {}
  const windows = []
  for (const [field, tier] of [['rolling', 'five_hour'], ['weekly', 'weekly'], ['monthly', 'monthly']]) {
    const meter = usage[field]
    if (meter === null || typeof meter !== 'object') continue
    const percent = Number(meter.percent)
    windows.push(percentWindow(tier, Number.isFinite(percent) ? percent : undefined, isoToMs(meter.resetsAt)))
  }
  return { windows, planTier: 'Go' }
}

/** Command Code windows: 5-hour and weekly from credits, monthly from plan. */
async function queryCommandCode({ apiKey }) {
  const credits = await fetchJson('https://api.commandcode.ai/alpha/billing/credits', apiKey)
  const limits = credits?.windowLimits ?? {}
  const windows = []

  for (const [field, tier] of [['fiveHour', 'five_hour'], ['weekly', 'weekly']]) {
    const window = limits[field]
    if (window === null || typeof window !== 'object') continue
    const used = Number(window.used)
    const cap = Number(window.cap)
    const usedPercent = Number.isFinite(used) && Number.isFinite(cap) && cap > 0 ? (used / cap) * 100 : undefined
    windows.push(percentWindow(tier, usedPercent, Number(window.resetAt)))
  }

  let subscription
  try {
    const subscriptions = await fetchJson('https://api.commandcode.ai/alpha/billing/subscriptions', apiKey)
    subscription = subscriptions?.data ?? subscriptions
  } catch {
    subscription = undefined
  }

  const planId = typeof subscription?.planId === 'string' ? subscription.planId : undefined
  const allowance = planId === undefined ? undefined : COMMAND_CODE_MONTHLY_CREDITS[planId]
  const remaining = Number(credits?.credits?.monthlyCredits)
  if (Number.isFinite(allowance) && allowance > 0 && Number.isFinite(remaining)) {
    windows.push(percentWindow(
      'monthly',
      ((allowance - remaining) / allowance) * 100,
      isoToMs(subscription?.currentPeriodEnd),
    ))
  }

  const planTier = planId === undefined ? undefined : String(planId).replace(/^individual-/, '').toUpperCase()
  return { windows, planTier }
}

/** Local Codex CLI: ChatGPT plan windows from its own login. */
async function queryCodex() {
  const authPath = join(homedir(), '.codex', 'auth.json')
  let auth
  try {
    auth = JSON.parse(await readFile(authPath, 'utf8'))
  } catch {
    const error = new Error('no codex login')
    error.status = 401
    throw error
  }
  const accessToken = auth?.tokens?.access_token
  const accountId = auth?.tokens?.account_id
  if (typeof accessToken !== 'string' || accessToken === '') {
    const error = new Error('no codex access token')
    error.status = 401
    throw error
  }

  const payload = await fetchJson(
    'https://chatgpt.com/backend-api/codex/usage',
    accessToken,
    accountId === undefined ? {} : { 'chatgpt-account-id': accountId },
  )

  const rate = payload?.rate_limit ?? {}
  const windows = []
  for (const [field, tier] of [['primary_window', 'five_hour'], ['secondary_window', 'weekly']]) {
    const window = rate[field]
    if (window === null || typeof window !== 'object') continue
    const used = Number(window.used_percent)
    const resetAt = Number(window.reset_at)
    windows.push(percentWindow(
      tier,
      Number.isFinite(used) ? used : undefined,
      Number.isFinite(resetAt) ? resetAt * 1000 : undefined,
    ))
  }

  const plan = typeof payload?.plan_type === 'string' ? payload.plan_type : undefined
  return { windows, planTier: plan === undefined ? undefined : plan.toUpperCase() }
}

const ADAPTERS = {
  'opencode-go': { needsApiKey: true, query: queryOpencodeGo },
  'command-code': { needsApiKey: true, query: queryCommandCode },
  codex: { needsApiKey: false, query: queryCodex },
}

/** Resolve a provider's API key through the credential seam. */
async function readApiKey(ctx, provider) {
  const envName = API_KEY_ENV[provider]
  if (envName === undefined) return undefined
  try {
    const resolved = await ctx.credentials.resolve(envName)
    if (resolved !== null && typeof resolved === 'object' && typeof resolved.value === 'string' && resolved.value !== '') {
      return resolved.value
    }
  } catch {
    // A credential seam failure falls through to the process environment.
  }
  const ambient = process.env[envName]
  return typeof ambient === 'string' && ambient !== '' ? ambient : undefined
}

async function queryProvider(ctx, provider, options) {
  const adapter = ADAPTERS[provider]
  if (adapter === undefined) return undefined

  if (options.refresh !== true) {
    const cached = cache.get(provider)
    if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) return cached.payload
  }
  const running = inflight.get(provider)
  if (running !== undefined) return running

  const query = (async () => {
    const providerName = PROVIDER_LABELS[provider] ?? provider
    const apiKey = adapter.needsApiKey ? await readApiKey(ctx, provider) : undefined
    if (adapter.needsApiKey && apiKey === undefined) {
      return { status: 'error', provider, providerName, error: { kind: 'no-credential' } }
    }
    try {
      const result = await adapter.query({ apiKey, ctx })
      const payload = {
        status: 'ok',
        provider,
        providerName,
        ...(result.planTier === undefined ? {} : { planTier: result.planTier }),
        fetchedAt: Date.now(),
        windows: result.windows,
      }
      cache.set(provider, { at: Date.now(), payload })
      return payload
    } catch (error) {
      return {
        status: 'error',
        provider,
        providerName,
        fetchedAt: Date.now(),
        error: {
          kind: error?.status === 401 ? 'auth' : 'http',
          message: String(error?.message ?? error),
        },
      }
    }
  })()

  inflight.set(provider, query)
  try {
    return await query
  } finally {
    inflight.delete(provider)
  }
}

/** The whole bar payload: one entry per provider that reports quota. */
async function snapshot(ctx, options) {
  let providers = []
  try {
    providers = (ctx.llm?.listProviders?.() ?? []).map((entry) => entry.id)
  } catch {
    providers = []
  }
  const candidates = [...new Set([...providers, ...LOCAL_PROVIDERS])].filter((id) => ADAPTERS[id] !== undefined)
  const effective = candidates.length > 0 ? candidates : Object.keys(ADAPTERS)
  const results = await Promise.all(effective.map((provider) => queryProvider(ctx, provider, options)))
  return {
    intervalSec: DEFAULT_INTERVAL_SEC,
    providers: results.filter((entry) => entry !== undefined),
  }
}

export function apply(ctx) {
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: QUOTA_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('method not allowed')
          return
        }
        try {
          const refresh = new URL(req.url ?? '/', 'http://localhost').searchParams.get('refresh') === '1'
          const payload = await snapshot(ctx, { refresh })
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(JSON.stringify(payload))
        } catch (error) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: String(error?.message ?? error) }))
        }
      },
    }), 'provider-quota: state route')
  })
}
