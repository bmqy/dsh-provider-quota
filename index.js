// Host half of the provider quota bar.
//
// Host JSON routes report quota state and expose CLIProxyAPI settings. The
// Client calls them with document-relative paths shared by DSH Desktop and Web;
// provider credentials and upstream requests stay on the Host, and settings
// secrets are never returned to the Client.
//
// Providers come from two places:
//   - the live LLM registry (`ctx.llm.listProviders()`), with API keys resolved
//     through the credential seam by environment-variable name, so a key
//     changed in Settings reaches the next poll without a restart;
//   - local coding CLIs that keep their own subscription login: Codex reads
//     `~/.codex/auth.json`, Claude Code `~/.claude/.credentials.json` and the
//     Gemini CLI `~/.gemini/oauth_creds.json`. A CLI whose login file is not
//     there is left out of the payload entirely, so the row never shows a
//     provider this machine cannot actually report on.
//
// Endpoint knowledge (verified against the live services, and cross-checked
// with the public projects that scrape the same APIs):
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
//   claude        GET https://api.anthropic.com/api/oauth/usage
//                 → five_hour · seven_day · seven_day_sonnet · seven_day_opus
//                   ({ utilization (used), resets_at (ISO-8601) }) plus
//                   extra_usage for the monthly spend cap; needs the Claude Code
//                   OAuth token and `anthropic-beta: oauth-2025-04-20`
//   gemini        POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist
//                 POST …/v1internal:retrieveUserQuota
//                 → buckets[] { modelId, remainingFraction, resetTime }, one per
//                   Code Assist model; the CLI's own OAuth token is the grant

import { execFile } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const runCommand = promisify(execFile)

const QUOTA_PATH = '/provider-quota/state'
const QUOTA_SETTINGS_PATH = '/provider-quota/settings'
const QUERY_TIMEOUT_MS = 10_000
const SETTINGS_MAX_BODY_BYTES = 16 * 1024
const CACHE_TTL_MS = 45_000
const DETECT_TTL_MS = 120_000
const DEFAULT_INTERVAL_SEC = 60

// `api.anthropic.com/api/oauth/usage` rate-limits aggressively, so the usage
// answer is kept longer than the others and click-to-refresh cannot hammer it.
const CLAUDE_CACHE_TTL_MS = 300_000
const CLAUDE_REFRESH_FLOOR_MS = 60_000
const GEMINI_CACHE_TTL_MS = 120_000

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const CLAUDE_BETA_HEADER = 'oauth-2025-04-20'
const CODE_ASSIST_URL = 'https://cloudcode-pa.googleapis.com/v1internal'
const GEMINI_CLIENT_METADATA = { ideType: 'GEMINI_CLI', pluginType: 'GEMINI' }

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

/**
 * Providers with an adapter here, and the env vars that may hold their API key,
 * most preferred first.
 *
 * Mars-Sea/dsh-commandcode-provider registers the provider id `commandcode` and
 * defaults its credential reference to `COMMANDCODE_API_KEY`, so that name is
 * tried first; `COMMAND_CODE_API_KEY` stays as the legacy name for installs made
 * before that plugin existed.
 */
const API_KEY_ENV = {
  'opencode-go': ['OPENCODE_GO_API_KEY'],
  'command-code': ['COMMANDCODE_API_KEY', 'COMMAND_CODE_API_KEY'],
}

/**
 * The upstream Command Code plugin (`Mars-Sea/dsh-commandcode-provider`)
 * registers `commandcodeUsage.report()` on the host. It already holds every
 * configured account, resolves the keys itself and answers the plan, credit
 * balances and the 5-hour / weekly windows, so it is the preferred source: it
 * is the same service that provider's own settings page reads.
 *
 * The optional service is picked up through `ctx.inject` (a profile without
 * that plugin simply never fires it), and the raw billing calls below stay as
 * the fallback for installs that only registered the LLM provider.
 */
const COMMAND_CODE_USAGE_CACHE_KEY = 'command-code#usage-service'
const COMMAND_CODE_USAGE_TTL_MS = 45_000
const COMMAND_CODE_USAGE_REFRESH_FLOOR_MS = 30_000

/** Set by `apply` when the upstream service is present; never by tests. */
let commandCodeUsage
/** Number of live `apply` fibers currently holding that service. */
let commandCodeUsageRefs = 0

/** Providers that are not part of the LLM registry but still have quota. */
const LOCAL_PROVIDERS = ['codex', 'claude', 'gemini', 'antigravity']

/** Registry ids that mean one of the CLI-login providers above. */
const PROVIDER_ALIASES = {
  anthropic: 'claude',
  'claude-code': 'claude',
  'gemini-cli': 'gemini',
  'google-gemini': 'gemini',
  // Mars-Sea/dsh-commandcode-provider registers this id for the same service
  // the canonical `command-code` adapter already speaks to.
  commandcode: 'command-code',
}

/** Display names for routes whose registry id is not self-explanatory. */
const PROVIDER_LABELS = {
  codex: 'Codex',
  'openai-codex': 'Codex',
  claude: 'Claude',
  anthropic: 'Claude',
  'claude-code': 'Claude',
  gemini: 'Gemini',
  'gemini-cli': 'Gemini',
  'google-gemini': 'Gemini',
  antigravity: 'Antigravity',
}

/** Code Assist model families, in the order the card lists them. */
const GEMINI_FAMILIES = [
  ['pro', 'Gemini Pro'],
  ['flash', 'Gemini Flash'],
  ['flash-lite', 'Gemini Flash Lite'],
]

/** At most this many per-model rows when no family name matches. */
const GEMINI_LOOSE_WINDOW_LIMIT = 4

// CLIProxyAPI exposes auth-file quotas through its read-only management API.
// The management key is resolved at request time and never cached or returned.
const CLI_PROXY_MANAGEMENT_KEY_REF = 'CLI_PROXY_MANAGEMENT_KEY'
const CLI_PROXY_MANAGEMENT_URL_ENV = 'CLI_PROXY_MANAGEMENT_URL'
const CLI_PROXY_DEFAULT_MANAGEMENT_URL = 'http://127.0.0.1:8317'
const CLI_PROXY_CACHE_TTL_MS = 45_000
const CLI_PROXY_REFRESH_FLOOR_MS = 30_000
const CLI_PROXY_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const CLI_PROXY_MAX_AUTH_FILES = 100
const CLI_PROXY_MAX_CONFIGURED_PROVIDERS = 100
const CLI_PROXY_MAX_CONCURRENCY = 4
const CLI_PROXY_BUILTIN_PROVIDERS = new Set(['codex', 'claude', 'antigravity', 'gemini-cli', 'kimi', 'xai', 'devin', 'meta'])
const CLI_PROXY_UPSTREAM = {
  codexUsage: 'https://chatgpt.com/backend-api/wham/usage',
  claudeUsage: 'https://api.anthropic.com/api/oauth/usage',
  claudeProfile: 'https://api.anthropic.com/api/oauth/profile',
  googleLoad: 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
  googleQuota: 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
  antigravityQuota: [
    'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
    'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary',
    'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  ],
  kimi: 'https://api.kimi.com/coding/v1/usages',
  kimiAi: 'https://api.kimi.ai/coding/v1/usages',
  meta: 'https://api.meta.ai/muse-code/key',
  xaiWeekly: 'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
  xaiMonthly: 'https://cli-chat-proxy.grok.com/v1/billing',
  devin: 'https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus',
}
const cliProxyCache = new Map()
const cliProxyInflight = new Map()
let cliProxyCacheGeneration = 0

function invalidateCliProxyCache() {
  cliProxyCacheGeneration += 1
  cliProxyCache.clear()
}

export const name = 'provider-quota'
export const inject = ['credentials', 'llm']

/** Per-provider cached payloads, keyed by route key. */
const cache = new Map()
/** In-flight queries, keyed by route key. */
const inflight = new Map()
/** Cached "is this CLI logged in" answers, keyed by route key. */
const detected = new Map()

function toFinite(value) {
  // `null` is a valid answer from these APIs ("no such window"), not zero.
  if (value === null || value === undefined || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

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

/** A window the client labels by name instead of by tier ("Sonnet", "Gemini Pro"). */
function namedWindow(name, usedPercent, resetAt) {
  const window = percentWindow('other', usedPercent, resetAt)
  window.name = name
  return window
}

function homePath(...parts) {
  return join(homedir(), ...parts)
}

function extraRoot(envName) {
  const value = process.env[envName]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Claude Code's OAuth credential file, honouring `CLAUDE_CONFIG_DIR`. */
function claudeCredentialPaths() {
  const roots = []
  const configured = extraRoot('CLAUDE_CONFIG_DIR')
  if (configured !== undefined) roots.push(configured)
  roots.push(homePath('.claude'))
  return [...new Set(roots.flatMap((root) => [join(root, '.credentials.json'), join(root, 'credentials.json')]))]
}

/** The Gemini CLI's OAuth credential file, honouring `GEMINI_CLI_HOME`. */
function geminiCredentialPaths() {
  const roots = []
  const configured = extraRoot('GEMINI_CLI_HOME')
  if (configured !== undefined) roots.push(configured)
  roots.push(homePath('.gemini'))
  return [...new Set(roots.map((root) => join(root, 'oauth_creds.json')))]
}

/** Codex CLI's login, honouring `CODEX_HOME`. */
function codexCredentialPaths() {
  const configured = extraRoot('CODEX_HOME')
  return [join(configured ?? homePath('.codex'), 'auth.json')]
}

/** Login files that prove a local CLI is usable; a missing one hides the chip. */
const LOGIN_PATHS = {
  codex: codexCredentialPaths,
  claude: claudeCredentialPaths,
  gemini: geminiCredentialPaths,
}

async function fileExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** First credential file that exists and parses; `undefined` when none does. */
async function readFirstJson(paths) {
  for (const path of paths) {
    const value = await readJsonFile(path)
    if (value !== undefined) return value
  }
  return undefined
}

function authError(message) {
  const error = new Error(message)
  error.status = 401
  return error
}

function unsupportedError(message) {
  const error = new Error(message)
  error.kind = 'unsupported'
  return error
}

async function httpError(response) {
  const error = new Error(`HTTP ${String(response.status)}`)
  error.status = response.status
  try {
    const text = await response.text()
    if (typeof text === 'string' && text !== '') {
      error.body = text.slice(0, 400)
      try {
        const parsed = JSON.parse(text)
        const code = parsed?.error?.status ?? parsed?.error?.code ?? parsed?.error?.details?.[0]?.reason
        if (typeof code === 'string' && code !== '') error.code = code
      } catch {
        // A non-JSON error body still keeps its HTTP status.
      }
    }
  } catch {
    // The body is optional; the status already explains the failure.
  }
  return error
}

async function fetchJson(url, options = {}) {
  const headers = { accept: 'application/json', ...options.headers }
  if (typeof options.token === 'string' && options.token !== '') {
    headers.authorization = `Bearer ${options.token}`
  }
  const init = { headers, signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) }
  if (options.method !== undefined) init.method = options.method
  if (options.body !== undefined) {
    init.method = options.method ?? 'POST'
    init.body = JSON.stringify(options.body)
    headers['content-type'] = 'application/json'
  }
  const response = await fetch(url, init)
  if (!response.ok) throw await httpError(response)
  return await response.json()
}

/** opencode.ai Go plan windows: rolling (5h), weekly, monthly. */
async function queryOpencodeGo({ apiKey }) {
  const payload = await fetchJson('https://opencode.ai/zen/go/v1/usage', { token: apiKey })
  const usage = payload?.usage ?? {}
  const windows = []
  for (const [field, tier] of [['rolling', 'five_hour'], ['weekly', 'weekly'], ['monthly', 'monthly']]) {
    const meter = usage[field]
    if (meter === null || typeof meter !== 'object') continue
    windows.push(percentWindow(tier, toFinite(meter.percent), isoToMs(meter.resetsAt)))
  }
  return { windows, planTier: 'Go' }
}

/** Command Code windows: 5-hour and weekly from credits, monthly from plan. */
async function queryCommandCode({ apiKey }) {
  const credits = await fetchJson('https://api.commandcode.ai/alpha/billing/credits', { token: apiKey })
  const limits = credits?.windowLimits ?? {}
  const windows = []

  for (const [field, tier] of [['fiveHour', 'five_hour'], ['weekly', 'weekly']]) {
    const window = limits[field]
    if (window === null || typeof window !== 'object') continue
    const used = toFinite(window.used)
    const cap = toFinite(window.cap)
    const usedPercent = used !== undefined && cap !== undefined && cap > 0 ? (used / cap) * 100 : undefined
    windows.push(percentWindow(tier, usedPercent, toFinite(window.resetAt)))
  }

  let subscription
  try {
    const subscriptions = await fetchJson('https://api.commandcode.ai/alpha/billing/subscriptions', { token: apiKey })
    subscription = subscriptions?.data ?? subscriptions
  } catch {
    subscription = undefined
  }

  const planId = typeof subscription?.planId === 'string' ? subscription.planId : undefined
  const allowance = planId === undefined ? undefined : COMMAND_CODE_MONTHLY_CREDITS[planId]
  const remaining = toFinite(credits?.credits?.monthlyCredits)
  if (allowance !== undefined && allowance > 0 && remaining !== undefined) {
    windows.push(percentWindow(
      'monthly',
      ((allowance - remaining) / allowance) * 100,
      isoToMs(subscription?.currentPeriodEnd),
    ))
  }

  const planTier = planId === undefined ? undefined : String(planId).replace(/^individual-/, '').toUpperCase()
  return { windows, planTier }
}

// ---------------------------------------------------------------------------
// Command Code through the upstream `commandcodeUsage` service
//
// `report()` answers `{ accounts: [{ id, label, configured, active, mark,
// cooldownUntil, report }] }`, where each inner report is the plugin's own
// normalized billing answer:
//
//   { failures, blocked, credits: { monthlyCredits, monthlyReported, fiveHour,
//     weekly, ... }, plan: { planId, name, monthlyCredits, currentPeriodEnd } }
//
// The bar shows ONE chip — the account that is currently serving requests — so
// a multi-account install still gets the vendor's mark and route key
// `command-code`, and the card describes that account alone.
//
// The report's strict meanings are load-bearing, and none of them is zero:
//   - an ABSENT `credits.fiveHour` / `.weekly` means the endpoint reported no
//     such window (an unlimited plan), not an exhausted one;
//   - `cap: 0` (or a missing cap) is uncapped spend, so it can never be drawn
//     as a fraction of a cap and is never "exhausted";
//   - `credits.monthlyReported === false` means the balance was omitted, which
//     cannot be told from a real zero, so no monthly window is drawn.
// ---------------------------------------------------------------------------

/** Plan tier from the report's plan, using the same rule as the raw adapter. */
function commandCodeReportTier(report) {
  const planId = report?.plan?.planId
  if (typeof planId === 'string' && planId !== '') return planId.replace(/^individual-/, '').toUpperCase()
  const name = typeof report?.plan?.name === 'string' ? report.plan.name.trim() : ''
  return name === '' ? undefined : name
}

/** The 5-hour / weekly / monthly windows one account report really measured. */
function commandCodeReportWindows(report) {
  const credits = report?.credits
  if (credits === null || typeof credits !== 'object') return []

  const windows = []
  for (const [field, tier] of [['fiveHour', 'five_hour'], ['weekly', 'weekly']]) {
    const limit = credits[field]
    // Absent, or a cap that is not a positive number, is not a quota: neither
    // can become a percentage, and neither may read as exhausted.
    if (limit === null || typeof limit !== 'object') continue
    const cap = toFinite(limit.cap)
    if (cap === undefined || cap <= 0) continue
    const used = toFinite(limit.used)
    const usedPercent = used === undefined ? undefined : (used / cap) * 100
    windows.push(percentWindow(tier, usedPercent, toFinite(limit.resetAt)))
  }

  // The monthly window needs both figures: the plan's allowance and the balance
  // the endpoint really reported (`monthlyReported !== false`).
  const allowance = toFinite(report?.plan?.monthlyCredits)
  const remaining = toFinite(credits.monthlyCredits)
  if (credits.monthlyReported !== false && allowance !== undefined && allowance > 0 && remaining !== undefined) {
    windows.push(percentWindow(
      'monthly',
      ((allowance - remaining) / allowance) * 100,
      toFinite(report?.plan?.currentPeriodEnd),
    ))
  }

  return windows
}

/** The account the bar reports on: the serving one, else the first configured. */
function commandCodeSelectedAccount(accounts) {
  const configured = accounts.filter((account) => (
    account !== null && typeof account === 'object' && account.configured !== false
  ))
  return configured.find((account) => account.active === true) ?? configured[0]
}

/** The single bar entry for the selected account; `undefined` when it has nothing to show. */
function commandCodeEntry(account) {
  const report = account.report !== null && typeof account.report === 'object' ? account.report : {}

  if (report.blocked === 'invalid-key') {
    return { status: 'error', provider: 'command-code', providerName: 'command-code', error: { kind: 'auth' } }
  }
  if (report.blocked !== undefined) {
    return {
      status: 'error',
      provider: 'command-code',
      providerName: 'command-code',
      error: { kind: 'http', message: String(report.blocked) },
    }
  }

  const windows = commandCodeReportWindows(report)
  if (windows.length === 0) {
    const failures = Array.isArray(report.failures)
      ? report.failures.filter((failure) => typeof failure === 'string' && failure !== '')
      : []
    const credits = report.credits
    const measured = credits !== null && typeof credits === 'object'
    // No credit block at all, or every endpoint failed: the account is usable
    // but its quota is temporarily unreadable, which the user should see rather
    // than a silently missing chip.
    if (!measured || failures.length > 0) {
      return {
        status: 'error',
        provider: 'command-code',
        providerName: 'command-code',
        fetchedAt: Date.now(),
        error: { kind: 'http', message: failures.length > 0 ? failures.join('; ') : 'no credit report' },
      }
    }
    // Measured credit block with no caps to divide by: a genuinely unlimited
    // plan has no percentage to show, so the chip stays away instead of
    // reporting a false zero.
    return undefined
  }

  return {
    status: 'ok',
    provider: 'command-code',
    providerName: 'command-code',
    planTier: commandCodeReportTier(report),
    fetchedAt: Date.now(),
    windows,
  }
}

/**
 * One report call for the serving account, cached like the raw adapters.
 *
 * `undefined` means the service could not answer (not installed, or it threw),
 * which is the only case that falls back to the raw billing endpoints. An empty
 * array means the service answered and this account has no measurable window
 * (every limit uncapped): the bar then shows no chip rather than a false zero.
 */
async function queryCommandCodeUsage(options) {
  const service = commandCodeUsage
  if (service === undefined || typeof service.report !== 'function') return undefined

  const cached = cache.get(COMMAND_CODE_USAGE_CACHE_KEY)
  if (cached !== undefined) {
    const age = Date.now() - cached.at
    const limit = options.refresh === true ? COMMAND_CODE_USAGE_REFRESH_FLOOR_MS : COMMAND_CODE_USAGE_TTL_MS
    if (age < limit) return cached.payload
  }
  const running = inflight.get(COMMAND_CODE_USAGE_CACHE_KEY)
  if (running !== undefined) return running

  const query = (async () => {
    try {
      const answer = await service.report()
      const accounts = Array.isArray(answer?.accounts) ? answer.accounts : []
      const account = commandCodeSelectedAccount(accounts)
      // Nothing configured: let the raw adapter report "no API key", which is
      // the actionable message here.
      if (account === undefined) return undefined
      const entry = commandCodeEntry(account)
      const payload = entry === undefined ? [] : [entry]
      cache.set(COMMAND_CODE_USAGE_CACHE_KEY, { at: Date.now(), payload })
      return payload
    } catch {
      // A missing key or a broken service falls back to the raw adapter.
      return undefined
    }
  })()

  inflight.set(COMMAND_CODE_USAGE_CACHE_KEY, query)
  try {
    return await query
  } finally {
    inflight.delete(COMMAND_CODE_USAGE_CACHE_KEY)
  }
}

/** Local Codex CLI: ChatGPT plan windows from its own login. */
async function queryCodex() {
  const auth = await readFirstJson(codexCredentialPaths())
  const accessToken = auth?.tokens?.access_token
  const accountId = auth?.tokens?.account_id
  if (typeof accessToken !== 'string' || accessToken === '') throw authError('no codex access token')

  const payload = await fetchJson('https://chatgpt.com/backend-api/codex/usage', {
    token: accessToken,
    headers: accountId === undefined ? {} : { 'chatgpt-account-id': accountId },
  })

  const rate = payload?.rate_limit ?? {}
  const windows = []
  for (const [field, tier] of [['primary_window', 'five_hour'], ['secondary_window', 'weekly']]) {
    const window = rate[field]
    if (window === null || typeof window !== 'object') continue
    const resetAt = toFinite(window.reset_at)
    windows.push(percentWindow(tier, toFinite(window.used_percent), resetAt === undefined ? undefined : resetAt * 1000))
  }

  const plan = typeof payload?.plan_type === 'string' ? payload.plan_type : undefined
  return { windows, planTier: plan === undefined ? undefined : plan.toUpperCase() }
}

/** Claude Code OAuth token from its credentials file. */
async function readClaudeOauth() {
  for (const path of claudeCredentialPaths()) {
    const value = await readJsonFile(path)
    const oauth = value?.claudeAiOauth ?? value
    const accessToken = oauth?.accessToken ?? oauth?.access_token
    if (typeof accessToken === 'string' && accessToken !== '') {
      return {
        accessToken,
        expiresAt: toFinite(oauth?.expiresAt ?? oauth?.expires_at),
        subscriptionType: typeof oauth?.subscriptionType === 'string' ? oauth.subscriptionType : undefined,
      }
    }
  }
  return undefined
}

/**
 * `api/oauth/usage` answers without a query on most accounts; the `cedar_ember`
 * variant is what the CLI's own usage panel asks for. Try plain first, fall back
 * once, and treat a repeated 400/401/403 as "this login cannot read usage"
 * (missing `user:profile` scope) rather than as a transient failure.
 */
async function fetchClaudeUsage(accessToken) {
  const headers = { 'anthropic-beta': CLAUDE_BETA_HEADER }
  try {
    return await fetchJson(CLAUDE_USAGE_URL, { token: accessToken, headers })
  } catch (error) {
    if (error?.status !== 400 && error?.status !== 403) throw error
    try {
      return await fetchJson(`${CLAUDE_USAGE_URL}?cedar_ember=1`, { token: accessToken, headers })
    } catch (retry) {
      const status = retry?.status
      if (status === 400 || status === 401 || status === 403) {
        throw authError(`claude usage HTTP ${String(status)}`)
      }
      throw retry
    }
  }
}

function claudePlanTier(oauth, payload) {
  const candidates = [
    payload?.subscription_type,
    payload?.subscriptionType,
    payload?.rate_limit_tier,
    oauth?.subscriptionType,
  ]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue
    return candidate.replace(/^default_claude_/, '').toUpperCase()
  }
  return undefined
}

/** Local Claude Code login: 5-hour, weekly and model-scoped weekly windows. */
async function queryClaude() {
  const oauth = await readClaudeOauth()
  if (oauth === undefined) throw authError('no claude login')
  if (oauth.expiresAt !== undefined && oauth.expiresAt > 0 && oauth.expiresAt < Date.now()) {
    // Refreshing here would rotate the grant out from under the CLI, so the
    // chip asks for a re-login instead and the CLI repairs its own token.
    throw authError('claude token expired')
  }

  const payload = await fetchClaudeUsage(oauth.accessToken)
  const windows = []
  for (const [field, tier] of [['five_hour', 'five_hour'], ['seven_day', 'weekly']]) {
    const meter = payload?.[field]
    if (meter === null || typeof meter !== 'object') continue
    windows.push(percentWindow(tier, toFinite(meter.utilization), isoToMs(meter.resets_at ?? meter.resetsAt)))
  }
  for (const [field, label] of [['seven_day_sonnet', 'Sonnet'], ['seven_day_opus', 'Opus']]) {
    const meter = payload?.[field]
    if (meter === null || typeof meter !== 'object') continue
    windows.push(namedWindow(label, toFinite(meter.utilization), isoToMs(meter.resets_at ?? meter.resetsAt)))
  }

  const extra = payload?.extra_usage
  if (extra !== null && typeof extra === 'object') {
    const limit = toFinite(extra.monthly_limit)
    const spent = toFinite(extra.used_credits)
    let usedPercent = toFinite(extra.utilization)
    if (usedPercent === undefined && limit !== undefined && limit > 0 && spent !== undefined) {
      usedPercent = (spent / limit) * 100
    }
    if (usedPercent !== undefined) windows.push(percentWindow('monthly', usedPercent))
  }

  return { windows, planTier: claudePlanTier(oauth, payload) }
}

/** The Gemini CLI's Code Assist login: the OAuth token in `oauth_creds.json`. */
async function readGeminiToken() {
  for (const path of geminiCredentialPaths()) {
    const value = await readJsonFile(path)
    const accessToken = value?.access_token
    if (typeof accessToken === 'string' && accessToken !== '') {
      return { accessToken, expiry: toFinite(value?.expiry_date) }
    }
  }
  return undefined
}

function geminiProjectId(assist) {
  const project = assist?.cloudaicompanionProject
  if (typeof project === 'string' && project !== '') return project
  if (project !== null && typeof project === 'object' && typeof project.id === 'string' && project.id !== '') {
    return project.id
  }
  return undefined
}

/**
 * Workspace accounts get no `cloudaicompanionProject` from `loadCodeAssist`, but
 * `retrieveUserQuota` requires one, so fall back to the Gemini-provisioned
 * project in Cloud Resource Manager.
 */
async function geminiProjectFromResourceManager(accessToken) {
  try {
    const payload = await fetchJson('https://cloudresourcemanager.googleapis.com/v1/projects', {
      token: accessToken,
    })
    const projects = Array.isArray(payload?.projects) ? payload.projects : []
    for (const project of projects) {
      if (project === null || typeof project !== 'object') continue
      const projectId = typeof project.projectId === 'string' ? project.projectId : ''
      if (projectId === '') continue
      const labelled = project.labels !== null
        && typeof project.labels === 'object'
        && project.labels['generative-language'] !== undefined
      if (labelled || projectId.startsWith('gen-lang-client')) return projectId
    }
  } catch {
    // The fallback is best effort; without it the quota call reports the error.
  }
  return undefined
}

/** Google's consumer-tier shutdown signal, if this account carries one. */
function geminiUnsupportedReason(assist) {
  const tiers = Array.isArray(assist?.ineligibleTiers) ? assist.ineligibleTiers : []
  for (const tier of tiers) {
    if (tier === null || typeof tier !== 'object') continue
    if (tier.reasonCode !== 'UNSUPPORTED_CLIENT') continue
    return typeof tier.reasonMessage === 'string' && tier.reasonMessage !== ''
      ? tier.reasonMessage
      : 'UNSUPPORTED_CLIENT'
  }
  return undefined
}

function geminiPlanTier(assist) {
  const paid = assist?.paidTier?.name
  if (typeof paid === 'string' && paid !== '') return paid
  const tier = assist?.currentTier?.id
  if (tier === 'standard-tier') return 'Paid'
  if (tier === 'free-tier') return 'Free'
  if (tier === 'legacy-tier') return 'Legacy'
  return undefined
}

function geminiFamilyOf(modelId) {
  const id = typeof modelId === 'string' ? modelId.toLowerCase() : ''
  if (id === '') return undefined
  if (id.includes('pro')) return 'pro'
  if (id.includes('flash-lite') || id.includes('flash_lite')) return 'flash-lite'
  if (id.includes('flash')) return 'flash'
  return undefined
}

/**
 * One window per model family (the most constrained bucket in it), because Code
 * Assist quota is granted per model and listing every tier would bury the row.
 */
function geminiWindows(buckets) {
  const groups = new Map()
  const loose = []

  for (const bucket of buckets) {
    if (bucket === null || typeof bucket !== 'object') continue
    const remaining = toFinite(bucket.remainingFraction)
    if (remaining === undefined) continue
    const clamp = Math.max(0, Math.min(1, remaining))
    const window = percentWindow('other', (1 - clamp) * 100, isoToMs(bucket.resetTime))
    const family = geminiFamilyOf(bucket.modelId)
    if (family === undefined) {
      if (typeof bucket.modelId === 'string' && bucket.modelId !== '') {
        loose.push(namedWindow(bucket.modelId, window.usedPercent, window.resetAt))
      }
      continue
    }
    const current = groups.get(family)
    if (current === undefined || (window.usedPercent ?? 0) > (current.usedPercent ?? 0)) {
      groups.set(family, window)
    }
  }

  const windows = []
  for (const [family, label] of GEMINI_FAMILIES) {
    const window = groups.get(family)
    if (window !== undefined) windows.push(namedWindow(label, window.usedPercent, window.resetAt))
  }
  if (windows.length > 0) return windows

  loose.sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0))
  return loose.slice(0, GEMINI_LOOSE_WINDOW_LIMIT)
}

/** Local Gemini CLI login: per-model Code Assist quotas. */
async function queryGemini() {
  const token = await readGeminiToken()
  if (token === undefined) throw authError('no gemini login')
  if (token.expiry !== undefined && token.expiry > 0 && token.expiry < Date.now()) {
    throw authError('gemini token expired')
  }

  let assist
  try {
    assist = await fetchJson(`${CODE_ASSIST_URL}:loadCodeAssist`, {
      token: token.accessToken,
      body: { metadata: GEMINI_CLIENT_METADATA },
    })
  } catch {
    assist = undefined
  }

  // Google's consumer-tier shutdown shows up as an `UNSUPPORTED_CLIENT` tier on
  // an otherwise 200 answer. A named paid tier or `standard-tier` proves the
  // account is outside that shutdown, so the flag is ignored for those.
  const unsupported = geminiUnsupportedReason(assist)
  const licensed = typeof assist?.paidTier?.name === 'string' || assist?.currentTier?.id === 'standard-tier'
  if (unsupported !== undefined && !licensed) throw unsupportedError(unsupported)

  const projectId = geminiProjectId(assist) ?? await geminiProjectFromResourceManager(token.accessToken)
  if (projectId === undefined) throw authError('no gemini code assist project')

  let quota
  try {
    quota = await fetchJson(`${CODE_ASSIST_URL}:retrieveUserQuota`, {
      token: token.accessToken,
      body: { project: projectId },
    })
  } catch (error) {
    // Individual Google accounts lost Gemini CLI quota in June 2026; Google
    // answers with an eligibility signal or a bare 403 SUBSCRIPTION_REQUIRED.
    if (unsupported !== undefined) throw unsupportedError(unsupported)
    if (error?.status === 403) throw unsupportedError(error.code ?? 'HTTP 403')
    if (error?.status === 401) throw authError('gemini usage HTTP 401')
    throw error
  }

  const buckets = Array.isArray(quota?.buckets) ? quota.buckets : []
  return { windows: geminiWindows(buckets), planTier: geminiPlanTier(assist) }
}

// ---------------------------------------------------------------------------
// Antigravity (where consumer Gemini / Claude quota lives since June 2026)
//
// Gemini CLI's own OAuth quota was retired for individual Google accounts, and
// those plans now report through Antigravity. Antigravity has no reachable
// public endpoint: its `language_server` (Antigravity app / IDE) or `agy` CLI
// hosts a loopback Connect-RPC service, so this adapter copies codexbar's local
// probe — find the process, take its listening ports, gate on GetUnleashData,
// then read the quota RPC:
//
//   POST https://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary
//        { "forceRefresh": true }
//   → response.groups[] { displayName, buckets[] }
//       bucket { bucketId, displayName, window ("5h" | "weekly"),
//                remainingFraction, resetTime (ISO-8601 or epoch seconds) }
//
// Older builds answer only GetUserStatus (clientModelConfigs[].quotaInfo), and
// GetCommandModelConfigs is the last resort. Desktop servers authenticate local
// calls with `--csrf_token`; the CLI's server needs none.
// ---------------------------------------------------------------------------

const ANTIGRAVITY_SERVICE = '/exa.language_server_pb.LanguageServerService'
const ANTIGRAVITY_RPC = {
  unleash: `${ANTIGRAVITY_SERVICE}/GetUnleashData`,
  quotaSummary: `${ANTIGRAVITY_SERVICE}/RetrieveUserQuotaSummary`,
  userStatus: `${ANTIGRAVITY_SERVICE}/GetUserStatus`,
  modelConfigs: `${ANTIGRAVITY_SERVICE}/GetCommandModelConfigs`,
}

const ANTIGRAVITY_STATUS_BODY = {
  metadata: {
    ideName: 'antigravity',
    extensionName: 'antigravity',
    ideVersion: 'unknown',
    locale: 'en',
  },
}

const ANTIGRAVITY_UNLEASH_BODY = {
  context: {
    properties: {
      devMode: 'false',
      extensionVersion: 'unknown',
      hasAnthropicModelAccess: 'true',
      ide: 'antigravity',
      ideVersion: 'unknown',
      installationId: 'provider-quota',
      language: 'UNSPECIFIED',
      os: 'unknown',
      requestedModelId: 'MODEL_UNSPECIFIED',
    },
  },
}

/** Windows of both Antigravity pools, in the order the card lists them. */
const ANTIGRAVITY_TIERS = [
  'gemini_five_hour',
  'gemini_weekly',
  'third_party_five_hour',
  'third_party_weekly',
]

const ANTIGRAVITY_PROBE_TIMEOUT_MS = 2_500
const ANTIGRAVITY_FOUND_TTL_MS = 30_000
const ANTIGRAVITY_MISSING_TTL_MS = 300_000
const ANTIGRAVITY_CACHE_TTL_MS = 45_000
const ANTIGRAVITY_MAX_ENDPOINTS = 6

/** Cache for the process scan: cheap while Antigravity runs, quiet when absent. */
let antigravityScan = { at: 0, candidates: [] }

const LANGUAGE_SERVER_PATTERN = /(^|[/\\])language[_-]server(?:[_-][a-z0-9]+)*(?:\.exe)?(\s|$)/i
const ANTIGRAVITY_CLI_PATTERN = /(^|[/\\])(antigravity-cli|antigravity_cli)([\s/\\]|$)|(^|[/\\])agy(\s|$)/i
const ANTIGRAVITY_IDE_MARKERS = [
  'antigravity ide.app/',
  'antigravity ide.app\\',
  '--app_data_dir antigravity-ide',
  '--app_data_dir=antigravity-ide',
  '/extensions/antigravity/bin/language_server',
  '\\extensions\\antigravity\\bin\\language_server',
]
const ANTIGRAVITY_MARKERS = [
  'antigravity.app/',
  'antigravity.app\\',
  '/gemini.app/',
  '\\gemini.app\\',
  '/antigravity/',
  '\\antigravity\\',
]

/** Which of codexbar's three process kinds a command line is, if any. */
function antigravityProcessKind(command) {
  const value = typeof command === 'string' ? command.toLowerCase() : ''
  if (value === '') return undefined
  const looksLikeServer = LANGUAGE_SERVER_PATTERN.test(value)
  const looksLikeAntigravity = (value.includes('--app_data_dir') && value.includes('antigravity'))
    || ANTIGRAVITY_MARKERS.some((marker) => value.includes(marker))
  if (looksLikeServer && looksLikeAntigravity) {
    return ANTIGRAVITY_IDE_MARKERS.some((marker) => value.includes(marker)) ? 'ide' : 'app'
  }
  if (ANTIGRAVITY_CLI_PATTERN.test(value)) return 'cli'
  return undefined
}

function antigravityKindRank(kind) {
  if (kind === 'app') return 0
  if (kind === 'cli') return 1
  return 2
}

function antigravityFlag(command, name) {
  const match = new RegExp(`--${name}[=\\s]+("[^"]*"|\\S+)`, 'i').exec(command)
  if (match === null) return undefined
  return match[1].replace(/^"|"$/g, '')
}

function toPort(value) {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined
}

function epochOrIsoMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value > 1e12 ? value : value * 1000
  }
  if (typeof value === 'string' && value !== '') {
    const iso = Date.parse(value)
    if (Number.isFinite(iso)) return iso
    const seconds = Number(value)
    if (Number.isFinite(seconds) && seconds > 0) return seconds > 1e12 ? seconds : seconds * 1000
  }
  return undefined
}

/** Default transport: OS process/port lookups plus loopback POSTs. */
const defaultAntigravityTransport = {
  async listProcesses() {
    return process.platform === 'win32'
      ? await listProcessesWindows()
      : await listProcessesPosix()
  },

  async listPorts(pid) {
    return process.platform === 'win32' ? await listPortsWindows(pid) : await listPortsPosix(pid)
  },

  async postJson({ scheme, port, path, body, csrfToken, timeoutMs }) {
    return await postLocalJson({ scheme, port, path, body, csrfToken, timeoutMs })
  },
}

/** Replaced by tests; never by the plugin itself. */
let antigravityTransport = defaultAntigravityTransport

/** @internal test seam: swap the process/port/HTTP transport. */
export function setAntigravityTransport(transport) {
  antigravityTransport = transport ?? defaultAntigravityTransport
  antigravityScan = { at: 0, candidates: [] }
}

async function listProcessesWindows() {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine -match 'antigravity' -or $_.CommandLine -match 'agy' -or $_.Name -match 'language[_-]server') } | ForEach-Object { \"{0}`t{1}`t{2}\" -f $_.ProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { '' }), $_.CommandLine }",
  ].join('; ')
  const { stdout } = await runCommand(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: 8_000, maxBuffer: 8 << 20, windowsHide: true },
  )
  const processes = []
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const [pid, fileTime, ...rest] = line.split('\t')
    const command = rest.join('\t')
    const parsedPid = Number(pid)
    if (!Number.isInteger(parsedPid) || command === '') continue
    const ticks = Number(fileTime)
    // FILETIME is 100 ns ticks since 1601; convert to epoch milliseconds.
    const startedAt = Number.isFinite(ticks) && ticks > 0 ? (ticks / 10_000) - 116_444_736_000_000 : undefined
    processes.push({ pid: parsedPid, startedAt, command })
  }
  return processes
}

async function listProcessesPosix() {
  const { stdout } = await runCommand('ps', ['-ax', '-o', 'pid=,lstart=,command='], {
    timeout: 8_000,
    maxBuffer: 8 << 20,
    env: { ...process.env, LC_ALL: 'C' },
  })
  const processes = []
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line)
    if (match === null) continue
    processes.push({
      pid: Number(match[1]),
      startedAt: Date.parse(match[2]),
      command: match[3],
    })
  }
  return processes
}

async function listPortsWindows(pid) {
  const { stdout } = await runCommand('netstat', ['-ano', '-p', 'tcp'], { timeout: 8_000, maxBuffer: 8 << 20 })
  const ports = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes('LISTENING')) continue
    const columns = line.trim().split(/\s+/)
    if (columns.length < 5) continue
    if (Number(columns[columns.length - 1]) !== pid) continue
    const port = toPort(columns[1].slice(columns[1].lastIndexOf(':') + 1))
    if (port !== undefined && !ports.includes(port)) ports.push(port)
  }
  return ports.sort((a, b) => a - b)
}

async function listPortsPosix(pid) {
  const { stdout } = await runCommand(
    'lsof',
    ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(pid), '-F', 'pn'],
    { timeout: 8_000, maxBuffer: 4 << 20 },
  )
  const ports = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('n')) continue
    const port = toPort(line.slice(line.lastIndexOf(':') + 1))
    if (port !== undefined && !ports.includes(port)) ports.push(port)
  }
  return ports.sort((a, b) => a - b)
}

/**
 * Loopback POST. `rejectUnauthorized: false` is required: every Antigravity
 * server presents a self-signed certificate on 127.0.0.1.
 */
function postLocalJson({ scheme, port, path, body, csrfToken, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body ?? {})
    const headers = {
      accept: 'application/json',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      'connect-protocol-version': '1',
    }
    if (typeof csrfToken === 'string' && csrfToken !== '') headers['x-codeium-csrf-token'] = csrfToken
    const send = scheme === 'http' ? httpRequest : httpsRequest
    const request = send({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers,
      rejectUnauthorized: false,
      timeout: timeoutMs,
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json
        try {
          json = text === '' ? {} : JSON.parse(text)
        } catch {
          json = undefined
        }
        resolve({ status: response.statusCode ?? 0, json })
      })
    })
    request.on('timeout', () => { request.destroy(new Error('antigravity request timed out')) })
    request.on('error', reject)
    request.end(payload)
  })
}

/** Every Antigravity process this machine can report on, best candidate first. */
async function scanAntigravityCandidates() {
  const ttl = antigravityScan.candidates.length > 0 ? ANTIGRAVITY_FOUND_TTL_MS : ANTIGRAVITY_MISSING_TTL_MS
  if (Date.now() - antigravityScan.at < ttl) return antigravityScan.candidates

  let processes = []
  try {
    processes = await antigravityTransport.listProcesses()
  } catch {
    processes = []
  }

  const candidates = []
  for (const entry of processes) {
    const kind = antigravityProcessKind(entry.command)
    if (kind === undefined) continue
    const csrfToken = antigravityFlag(entry.command, 'csrf_token') ?? (kind === 'cli' ? '' : undefined)
    // A desktop server without its token cannot be queried; skip it and let a
    // later candidate answer (codexbar does the same).
    if (csrfToken === undefined) continue
    candidates.push({
      pid: entry.pid,
      kind,
      startedAt: toFinite(entry.startedAt),
      command: entry.command,
      csrfToken,
      extensionPort: toPort(antigravityFlag(entry.command, 'extension_server_port')),
      extensionCsrfToken: antigravityFlag(entry.command, 'extension_server_csrf_token'),
    })
  }

  candidates.sort((a, b) => antigravityKindRank(a.kind) - antigravityKindRank(b.kind)
    || (b.startedAt ?? 0) - (a.startedAt ?? 0))

  antigravityScan = { at: Date.now(), candidates }
  return candidates
}

async function antigravityAvailable() {
  try {
    return (await scanAntigravityCandidates()).length > 0
  } catch {
    return false
  }
}

function antigravityEndpoints(candidate, ports) {
  const endpoints = []
  for (const port of ports) {
    // codexbar probes both schemes on every listening port: the CLI answers
    // plain HTTP, the desktop servers HTTPS with a self-signed certificate.
    for (const scheme of ['https', 'http']) {
      endpoints.push({ scheme, port, csrfToken: candidate.csrfToken })
      if (endpoints.length >= ANTIGRAVITY_MAX_ENDPOINTS) return endpoints
    }
  }
  if (candidate.extensionPort !== undefined) {
    endpoints.push({
      scheme: 'http',
      port: candidate.extensionPort,
      csrfToken: candidate.extensionCsrfToken ?? candidate.csrfToken,
    })
  }
  return endpoints
}

async function antigravityReachable(endpoint) {
  try {
    const response = await antigravityTransport.postJson({
      scheme: endpoint.scheme,
      port: endpoint.port,
      path: ANTIGRAVITY_RPC.unleash,
      body: ANTIGRAVITY_UNLEASH_BODY,
      csrfToken: endpoint.csrfToken,
      timeoutMs: ANTIGRAVITY_PROBE_TIMEOUT_MS,
    })
    // Any HTTP answer means the port speaks the protocol; 401/500 included.
    return (response?.status ?? 0) > 0
  } catch {
    return false
  }
}

async function tryAntigravityRpc(endpoint, path, body) {
  try {
    const response = await antigravityTransport.postJson({
      scheme: endpoint.scheme,
      port: endpoint.port,
      path,
      body,
      csrfToken: endpoint.csrfToken,
      timeoutMs: ANTIGRAVITY_PROBE_TIMEOUT_MS,
    })
    if ((response?.status ?? 0) !== 200) return undefined
    return response.json
  } catch {
    return undefined
  }
}

/** Connect-RPC JSON wraps payloads in `response`; older builds do not. */
function antigravityUnwrap(payload) {
  if (payload === null || typeof payload !== 'object') return {}
  const inner = payload.response
  return inner !== null && typeof inner === 'object' ? inner : payload
}

function antigravityPlanTier(payload) {
  const body = antigravityUnwrap(payload)
  const status = body?.userStatus !== null && typeof body?.userStatus === 'object' ? body.userStatus : body
  const planInfo = status?.planStatus?.planInfo
  for (const candidate of [
    status?.userTier?.preferredName,
    status?.userTier?.name,
    planInfo?.preferredName,
    planInfo?.planName,
  ]) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return undefined
}

function antigravityGroupLabel(group) {
  const display = typeof group?.displayName === 'string' ? group.displayName.trim() : ''
  if (/gemini/i.test(display)) return 'Gemini'
  if (/claude|gpt|third/i.test(display)) return 'Claude/GPT'
  return display === '' ? 'Quota' : display
}

function antigravityGroupFamily(group) {
  const text = `${typeof group?.displayName === 'string' ? group.displayName : ''}`
  if (/gemini/i.test(text)) return 'gemini'
  if (/claude|gpt|third/i.test(text)) return 'third_party'
  return undefined
}

/** `5h` / `weekly`, from the explicit window field or the bucket id. */
function antigravityBucketCadence(bucket) {
  const explicit = typeof bucket?.window === 'string' ? bucket.window.trim().toLowerCase() : ''
  const source = explicit === ''
    ? `${bucket?.bucketId ?? ''} ${bucket?.displayName ?? ''}`.toLowerCase()
    : explicit
  if (source === '') return undefined
  if (/(^|[^a-z0-9])(session|5h|5-hour|five-hour)([^a-z0-9]|$)/.test(source)) return 'five_hour'
  if (source.includes('weekly') || source.includes('week')) return 'weekly'
  return undefined
}

function antigravityBucketLabel(bucket) {
  const cadence = antigravityBucketCadence(bucket)
  if (cadence === 'five_hour') return '5h'
  if (cadence === 'weekly') return 'weekly'
  const display = typeof bucket?.displayName === 'string' ? bucket.displayName.trim() : ''
  return display === '' ? 'quota' : display
}

/** `RetrieveUserQuotaSummary` → the two pools by 5-hour / weekly cadence. */
function antigravitySummaryWindows(payload) {
  const groups = antigravityUnwrap(payload)?.groups
  if (!Array.isArray(groups)) return []
  const byTier = new Map()
  const extras = []

  for (const group of groups) {
    if (group === null || typeof group !== 'object') continue
    const family = antigravityGroupFamily(group)
    const label = antigravityGroupLabel(group)
    const buckets = Array.isArray(group.buckets) ? group.buckets : []
    for (const bucket of buckets) {
      if (bucket === null || typeof bucket !== 'object' || bucket.disabled === true) continue
      // A bucket without a fraction carries no measurement (protobuf JSON drops
      // default values), which codexbar also treats as "usage unknown". Guessing
      // 0 or 100 here would invent a number either way.
      const remaining = toFinite(bucket.remainingFraction)
      if (remaining === undefined) continue
      const usedPercent = (1 - Math.max(0, Math.min(1, remaining))) * 100
      const resetAt = epochOrIsoMs(bucket.resetTime)
      const cadence = antigravityBucketCadence(bucket)
      if (family === undefined || cadence === undefined) {
        extras.push(namedWindow(`${label} ${antigravityBucketLabel(bucket)}`, usedPercent, resetAt))
        continue
      }
      const tier = `${family}_${cadence}`
      const current = byTier.get(tier)
      if (current === undefined || (usedPercent > (current.usedPercent ?? 0))) {
        byTier.set(tier, percentWindow(tier, usedPercent, resetAt))
      }
    }
  }

  const windows = []
  for (const tier of ANTIGRAVITY_TIERS) {
    const window = byTier.get(tier)
    if (window !== undefined) windows.push(window)
  }
  return [...windows, ...extras]
}

/** Older builds: per-model configs carrying only a session quota. */
function antigravityConfigWindows(payload) {
  const body = antigravityUnwrap(payload)
  const fromStatus = body?.userStatus?.cascadeModelConfigData?.clientModelConfigs
  const configs = Array.isArray(fromStatus)
    ? fromStatus
    : (Array.isArray(body?.clientModelConfigs) ? body.clientModelConfigs : [])
  const byTier = new Map()

  for (const config of configs) {
    if (config === null || typeof config !== 'object') continue
    const modelId = typeof config.modelOrAlias?.model === 'string'
      ? config.modelOrAlias.model
      : (typeof config.model === 'string' ? config.model : '')
    const label = typeof config.label === 'string' ? config.label : modelId
    const text = `${modelId} ${label}`.toLowerCase()
    if (text.trim() === '' || /lite|autocomplete|image/.test(text)) continue
    const family = /claude|gpt/.test(text) ? 'third_party' : (/gemini/.test(text) ? 'gemini' : undefined)
    if (family === undefined) continue
    const remaining = toFinite(config.quotaInfo?.remainingFraction)
    if (remaining === undefined) continue
    const usedPercent = (1 - Math.max(0, Math.min(1, remaining))) * 100
    const tier = `${family}_five_hour`
    const current = byTier.get(tier)
    if (current === undefined || usedPercent > (current.usedPercent ?? 0)) {
      byTier.set(tier, percentWindow(tier, usedPercent, epochOrIsoMs(config.quotaInfo?.resetTime)))
    }
  }

  const windows = []
  for (const tier of ANTIGRAVITY_TIERS) {
    const window = byTier.get(tier)
    if (window !== undefined) windows.push(window)
  }
  return windows
}

async function antigravityAttempt(endpoint) {
  if (!(await antigravityReachable(endpoint))) return undefined

  const summary = await tryAntigravityRpc(endpoint, ANTIGRAVITY_RPC.quotaSummary, { forceRefresh: true })
  if (summary !== undefined) {
    const windows = antigravitySummaryWindows(summary)
    if (windows.length > 0) {
      const status = await tryAntigravityRpc(endpoint, ANTIGRAVITY_RPC.userStatus, ANTIGRAVITY_STATUS_BODY)
      return { windows, planTier: status === undefined ? undefined : antigravityPlanTier(status) }
    }
  }

  const status = await tryAntigravityRpc(endpoint, ANTIGRAVITY_RPC.userStatus, ANTIGRAVITY_STATUS_BODY)
  if (status !== undefined) {
    const windows = antigravityConfigWindows(status)
    if (windows.length > 0) return { windows, planTier: antigravityPlanTier(status) }
  }

  const configs = await tryAntigravityRpc(endpoint, ANTIGRAVITY_RPC.modelConfigs, ANTIGRAVITY_STATUS_BODY)
  if (configs !== undefined) {
    const windows = antigravityConfigWindows(configs)
    if (windows.length > 0) return { windows }
  }

  return undefined
}

/** Local Antigravity app / IDE / `agy` CLI quota. */
async function queryAntigravity() {
  const candidates = await scanAntigravityCandidates()
  if (candidates.length === 0) throw new Error('antigravity is not running')

  let lastError
  for (const candidate of candidates) {
    let ports = []
    try {
      ports = await antigravityTransport.listPorts(candidate.pid)
    } catch (error) {
      lastError = error
      continue
    }
    for (const endpoint of antigravityEndpoints(candidate, ports)) {
      try {
        const result = await antigravityAttempt(endpoint)
        if (result !== undefined) return result
      } catch (error) {
        lastError = error
      }
    }
  }

  throw lastError ?? new Error('antigravity did not answer its quota RPC')
}

function cpaSafeText(value, maxLength = 80) {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  return String(value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength)
}

function cpaFirstText(...values) {
  for (const value of values) {
    const text = cpaSafeText(value)
    if (text !== '') return text
  }
  return ''
}

function cpaFlag(value) {
  if (value === true || value === 1) return true
  if (typeof value === 'string') return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase())
  return false
}

function cpaSlug(value) {
  return cpaSafeText(value, 100).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'account'
}

function cpaProviderLabel(value) {
  const provider = cpaSafeText(value, 48)
  const labels = {
    anthropic: 'Claude',
    claude: 'Claude',
    'claude-code': 'Claude',
    codex: 'Codex',
    openai: 'OpenAI',
    'openai-codex': 'Codex',
    gemini: 'Gemini',
    'gemini-cli': 'Gemini CLI',
    'google-gemini': 'Gemini',
    antigravity: 'Antigravity',
    kimi: 'Kimi',
    'moonshot': 'Kimi',
    'kimi-ai': 'Kimi',
    'kimi_ai': 'Kimi',
    meta: 'Meta',
    xai: 'xAI',
    grok: 'xAI',
    'x-ai': 'xAI',
    devin: 'Devin',
  }
  return labels[provider.toLowerCase()] ?? (provider === '' ? 'CLIProxyAPI' : provider)
}

function cliProxyNormalizeProvider(value) {
  const provider = cpaSafeText(value, 64).toLowerCase()
  if (['anthropic', 'claude-code'].includes(provider)) return 'claude'
  if (['openai-codex'].includes(provider)) return 'codex'
  if (['gemini', 'google-gemini'].includes(provider)) return 'gemini-cli'
  if (['grok', 'x-ai', 'x.ai'].includes(provider)) return 'xai'
  if (['moonshot', 'kimi-ai', 'kimi_ai'].includes(provider)) return 'kimi'
  return provider
}

/** Read the optional credential service through Cordis' supported lookup. */
function credentialsOf(ctx) {
  try {
    const service = typeof ctx?.get === 'function' ? ctx.get('credentials') : undefined
    if (service !== undefined && service !== null) return service
  } catch {
    // An optional credential provider may not be mounted in this profile.
  }
  return ctx?.credentials
}

/** Resolve CPA's management secret for every read; never retain it in cache/state. */
async function readCliProxyManagementKey(ctx) {
  try {
    const resolved = await credentialsOf(ctx)?.resolve?.(CLI_PROXY_MANAGEMENT_KEY_REF)
    const value = typeof resolved === 'string' ? resolved : resolved?.value
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  } catch {
    // Ambient environment credentials remain a supported fallback.
  }
  const ambient = process.env[CLI_PROXY_MANAGEMENT_KEY_REF]
  return typeof ambient === 'string' && ambient.trim() !== '' ? ambient.trim() : undefined
}

/** Resolve the management URL from DSH credentials, environment, or the default. */
async function readCliProxyManagementUrl(ctx) {
  try {
    const resolved = await credentialsOf(ctx)?.resolve?.(CLI_PROXY_MANAGEMENT_URL_ENV)
    const value = typeof resolved === 'string' ? resolved : resolved?.value
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  } catch {
    // Ambient environment configuration remains a supported fallback.
  }
  const ambient = process.env[CLI_PROXY_MANAGEMENT_URL_ENV]
  return typeof ambient === 'string' && ambient.trim() !== ''
    ? ambient.trim()
    : CLI_PROXY_DEFAULT_MANAGEMENT_URL
}

function cliProxyManagementOrigin(configured = undefined) {
  const raw = typeof configured === 'string' && configured.trim() !== ''
    ? configured.trim()
    : CLI_PROXY_DEFAULT_MANAGEMENT_URL
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return undefined
    const path = url.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '').replace(/\/+$/, '')
    return `${url.origin}${path}`
  } catch {
    return undefined
  }
}

function cliProxyHttpError(status) {
  const error = new Error('CLIProxyAPI management request failed')
  error.status = status
  error.kind = status === 401 ? 'auth' : status === 403 ? 'forbidden' : 'http'
  return error
}

async function readCliProxyResponseBody(response) {
  const reader = response.body?.getReader?.()
  if (reader === undefined) {
    const raw = await response.text()
    if (Buffer.byteLength(raw, 'utf8') > CLI_PROXY_MAX_RESPONSE_BYTES) throw new Error('CLIProxyAPI response too large')
    return raw
  }

  const chunks = []
  let byteLength = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value)
      byteLength += chunk.byteLength
      if (byteLength > CLI_PROXY_MAX_RESPONSE_BYTES) {
        try { await reader.cancel() } catch { /* ignore cancellation errors */ }
        throw new Error('CLIProxyAPI response too large')
      }
      chunks.push(chunk)
    }
  } catch (error) {
    try { await reader.cancel() } catch { /* ignore cancellation errors */ }
    throw error
  } finally {
    try { reader.releaseLock() } catch { /* ignore release errors */ }
  }

  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

/** Bounded transport; never reads or returns an error body. */
async function fetchCliProxyJson(url, managementKey, options = {}) {
  const headers = { accept: 'application/json', authorization: `Bearer ${managementKey}` }
  const init = {
    method: options.method ?? 'GET',
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  }
  if (options.body !== undefined) {
    init.method = options.method ?? 'POST'
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }

  const response = await fetch(url, init)
  if (!response.ok) throw cliProxyHttpError(response.status)
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > CLI_PROXY_MAX_RESPONSE_BYTES) throw new Error('CLIProxyAPI response too large')
  const raw = await readCliProxyResponseBody(response)
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('CLIProxyAPI returned invalid JSON')
  }
}

/** Return only safe provider labels and service URLs; never expose credentials. */
function cliProxyConfiguredProviderRows(payload) {
  const records = Array.isArray(payload) ? payload : payload?.['openai-compatibility']
  if (!Array.isArray(records)) throw new Error('CLIProxyAPI provider-list response has an unexpected shape')

  return records.slice(0, CLI_PROXY_MAX_CONFIGURED_PROVIDERS).flatMap((record) => {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) return []
    const name = cpaFirstText(record.name, record.id).slice(0, 120)
    const rawBaseUrl = cpaFirstText(record['base-url'], record.baseUrl)
    let baseUrl
    if (rawBaseUrl !== '') {
      try {
        const url = new URL(rawBaseUrl)
        if (['http:', 'https:'].includes(url.protocol)) {
          // Drop userinfo, query, and fragment in case a URL was misconfigured
          // with embedded credentials. Keep only the service origin + path.
          baseUrl = `${url.origin}${url.pathname}`.slice(0, 2048)
        }
      } catch {
        // Omit malformed service addresses instead of echoing raw input.
      }
    }
    if (name === '' && baseUrl === undefined) return []
    return [{
      ...(name === '' ? {} : { name }),
      ...(baseUrl === undefined ? {} : { baseUrl }),
      disabled: cpaFlag(record.disabled),
    }]
  })
}

function cliProxyProviderConfigError(error) {
  if (error?.kind === 'auth') return 'management-auth-failed'
  if (error?.kind === 'forbidden') return 'management-forbidden'
  if (error?.kind === 'http') return 'management-http-error'
  if (error?.message?.includes('unexpected shape')) return 'invalid-response'
  if (error?.message?.includes('invalid management URL')) return 'invalid-management-url'
  return 'unavailable'
}

async function queryCliProxyConfiguredProviders(ctx) {
  const managementKey = await readCliProxyManagementKey(ctx)
  if (managementKey === undefined) return { status: 'unconfigured', providers: [] }

  const origin = cliProxyManagementOrigin(await readCliProxyManagementUrl(ctx))
  if (origin === undefined) return { status: 'error', error: 'invalid-management-url', providers: [] }

  try {
    const payload = await fetchCliProxyJson(`${origin}/v0/management/openai-compatibility`, managementKey)
    return { status: 'ok', providers: cliProxyConfiguredProviderRows(payload) }
  } catch (error) {
    return { status: 'error', error: cliProxyProviderConfigError(error), providers: [] }
  }
}

function cliProxyUnwrap(value) {
  let current = value
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current === 'string') {
      try {
        current = JSON.parse(current)
      } catch {
        return undefined
      }
    }
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return current
    if (Array.isArray(current.groups) || Array.isArray(current.windows) || current.subscription !== undefined) return current
    const nested = current.quota ?? current.body ?? current.data ?? current.result
    if (nested === undefined || nested === null || nested === current) return current
    current = nested
  }
  return current
}

function cliProxyObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cliProxyPath(value, ...path) {
  let current = value
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

function cliProxyWindow(tier, usedPercent, resetAt, name = '') {
  if (!Number.isFinite(usedPercent) && !Number.isFinite(resetAt)) return undefined
  return {
    tier,
    ...(Number.isFinite(usedPercent) ? { usedPercent: Math.max(0, Math.min(100, usedPercent)) } : {}),
    ...(Number.isFinite(resetAt) && resetAt > 0 ? { resetAt } : {}),
    ...(name === '' ? {} : { name }),
  }
}

function cliProxyRelativeReset(value) {
  const seconds = toFinite(value)
  return seconds !== undefined && seconds >= 0 ? Date.now() + seconds * 1000 : undefined
}

function cliProxyPlanFromBody(body) {
  if (!cliProxyObject(body)) return undefined
  const plan = cpaFirstText(
    body.plan_type, body.planType, body.account_type, body.accountType,
    body.paidTier?.name, body.paid_tier?.name, body.currentTier?.name, body.currentTier?.id,
    body.current_tier?.name, body.current_tier?.id,
    body.subscription?.tierName, body.subscription?.tier_name, body.subscription?.plan,
    body.organization?.organization_type,
  )
  return plan === '' ? undefined : plan.slice(0, 48)
}

function cliProxyCodexWindows(body) {
  const rows = []
  const addLimit = (info, label = '') => {
    if (!cliProxyObject(info)) return
    const exhausted = cpaFlag(info.limit_reached ?? info.limitReached) || info.allowed === false
    for (const [slot, raw, fallbackTier] of [
      ['primary', info.primary_window ?? info.primaryWindow, 'five_hour'],
      ['secondary', info.secondary_window ?? info.secondaryWindow, 'weekly'],
    ]) {
      if (!cliProxyObject(raw)) continue
      const seconds = toFinite(raw.limit_window_seconds ?? raw.limitWindowSeconds)
      const tier = seconds === 18_000 ? 'five_hour' : seconds === 604_800 ? 'weekly' : (seconds === undefined ? fallbackTier : 'other')
      let used = cliProxyPercent(raw.used_percent ?? raw.usedPercent)
      const resetAt = cliProxyEpoch(raw.reset_at ?? raw.resetAt) ?? cliProxyRelativeReset(raw.reset_after_seconds ?? raw.resetAfterSeconds)
      if (used === undefined && exhausted) used = 100
      const name = label === '' ? '' : `${label} ${slot === 'primary' ? '5h' : 'weekly'}`
      const window = cliProxyWindow(tier, used, resetAt, name)
      if (window !== undefined) rows.push(window)
    }
  }
  addLimit(body?.rate_limit ?? body?.rateLimit)
  addLimit(body?.code_review_rate_limit ?? body?.codeReviewRateLimit, 'Code review')
  const extras = body?.additional_rate_limits ?? body?.additionalRateLimits
  if (Array.isArray(extras)) {
    extras.forEach((item, index) => {
      if (!cliProxyObject(item)) return
      addLimit(item.rate_limit ?? item.rateLimit, cpaFirstText(item.limit_name, item.limitName, item.metered_feature, item.meteredFeature, `Extra ${index + 1}`))
    })
  }
  return rows
}

function cliProxyClaudeWindows(body) {
  const rows = []
  const definitions = [
    ['five_hour', 'five_hour', '5h'],
    ['seven_day', 'weekly', 'weekly'],
    ['seven_day_oauth_apps', 'weekly', 'OAuth apps weekly'],
    ['seven_day_opus', 'weekly', 'Opus weekly'],
    ['seven_day_sonnet', 'weekly', 'Sonnet weekly'],
    ['seven_day_cowork', 'weekly', 'Cowork weekly'],
    ['iguana_necktie', 'weekly', 'Fable weekly'],
  ]
  for (const [key, tier, label] of definitions) {
    const raw = body?.[key]
    if (!cliProxyObject(raw)) continue
    const window = cliProxyWindow(tier, cliProxyPercent(raw.utilization), cliProxyEpoch(raw.resets_at ?? raw.resetsAt ?? raw.reset_at ?? raw.resetAt), tier === 'weekly' && key !== 'seven_day' ? label : '')
    if (window !== undefined) rows.push(window)
  }
  if (Array.isArray(body?.limits)) {
    for (const limit of body.limits) {
      if (!cliProxyObject(limit) || cpaSafeText(limit.kind, 40).toLowerCase() !== 'weekly_scoped') continue
      const model = cpaSafeText(cliProxyPath(limit, 'scope', 'model', 'display_name'), 64)
      if (model === '') continue
      const window = cliProxyWindow('weekly', cliProxyPercent(limit.percent), cliProxyEpoch(limit.resets_at ?? limit.resetAt), model)
      if (window !== undefined) rows.push(window)
    }
  }
  const extra = body?.extra_usage
  const limit = toFinite(extra?.monthly_limit)
  const used = toFinite(extra?.used_credits)
  if (limit !== undefined && limit > 0 && used !== undefined) {
    const window = cliProxyWindow('monthly', used / limit * 100, undefined, 'Extra usage')
    if (window !== undefined) rows.push(window)
  }
  return rows
}

function cliProxyClaudePlan(profile) {
  const hasMax = cliProxyPath(profile, 'account', 'has_claude_max')
  const hasPro = cliProxyPath(profile, 'account', 'has_claude_pro')
  const orgType = cpaSafeText(cliProxyPath(profile, 'organization', 'organization_type'), 64).toLowerCase()
  const status = cpaSafeText(cliProxyPath(profile, 'organization', 'subscription_status'), 32).toLowerCase()
  if (cpaFlag(hasMax)) return 'Max'
  if (cpaFlag(hasPro)) return 'Pro'
  if (orgType === 'claude_team' && status === 'active') return 'Team'
  if (orgType === 'claude_enterprise' && status === 'active') return 'Enterprise'
  if (hasMax === false && hasPro === false) return 'Free'
  return cliProxyPlanFromBody(profile)
}

function cliProxyGoogleHeaders(metadata) {
  return {
    Authorization: 'Bearer $TOKEN$',
    'Content-Type': 'application/json',
    'User-Agent': 'google-api-nodejs-client/9.15.1',
    'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
    'Client-Metadata': JSON.stringify(metadata),
  }
}

function cliProxyAntigravityHeaders() {
  return { Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json', 'User-Agent': 'antigravity/hub/2.23.0 darwin/arm64' }
}

function cliProxyProjectId(entry) {
  return cpaFirstText(
    entry?.project_id, entry?.projectId,
    cliProxyPath(entry, 'metadata', 'project_id'), cliProxyPath(entry, 'metadata', 'projectId'),
    cliProxyPath(entry, 'attributes', 'project_id'), cliProxyPath(entry, 'attributes', 'projectId'),
    cliProxyPath(entry, 'attributes', 'gemini_virtual_project'),
    cliProxyPath(entry, 'cloudaicompanion_project', 'id'), cliProxyPath(entry, 'cloudaicompanionProject', 'id'),
  )
}

function cliProxyGoogleProject(body) {
  const project = body?.cloudaicompanionProject ?? body?.cloudaicompanion_project
  return cliProxyObject(project) ? cpaFirstText(project.id) : cpaFirstText(project)
}

function cliProxyGooglePlan(body) {
  return cpaFirstText(body?.paidTier?.name, body?.paid_tier?.name, body?.currentTier?.name, body?.currentTier?.id, body?.current_tier?.name, body?.current_tier?.id) || cliProxyPlanFromBody(body)
}

function cliProxyKimiPrefersAi(entry) {
  const hints = [entry?.domain, cliProxyPath(entry, 'metadata', 'domain'), cliProxyPath(entry, 'attributes', 'domain'), entry?.base_url, cliProxyPath(entry, 'metadata', 'base_url'), cliProxyPath(entry, 'attributes', 'base_url'), entry?.provider, entry?.type, entry?.name, entry?.id]
  for (const value of hints) {
    const hint = cpaSafeText(value, 120).toLowerCase()
    if (hint === '') continue
    if (['ai', 'kimi-ai', 'kimi_ai', 'kimi.ai'].includes(hint) || /(?:^|[./])kimi\.ai(?:[/:]|$)/.test(hint)) return true
    if (['com', 'kimi', 'kimi.com'].includes(hint) || /(?:^|[./])kimi\.com(?:[/:]|$)/.test(hint)) return false
  }
  return /kimi[-_.]ai/i.test(`${cpaSafeText(entry?.id)} ${cpaSafeText(entry?.name)}`)
}

function cliProxyKimiWindows(body) {
  const rows = []
  const add = (raw, label, duration, unit, fallbackTier = 'other') => {
    if (!cliProxyObject(raw)) return
    const limit = toFinite(raw.limit)
    const usedAmount = toFinite(raw.used)
    const remainingAmount = toFinite(raw.remaining)
    let remaining
    if (limit !== undefined && limit > 0) {
      if (remainingAmount !== undefined) remaining = remainingAmount / limit * 100
      else if (usedAmount !== undefined) remaining = 100 - usedAmount / limit * 100
    }
    let tier = cliProxyTier(label)
    if (tier === 'other' && toFinite(duration) !== undefined) {
      const amount = toFinite(duration)
      const u = cpaSafeText(unit, 24).toLowerCase()
      const seconds = u.startsWith('week') ? amount * 604800 : u.startsWith('day') ? amount * 86400 : u.startsWith('hour') ? amount * 3600 : amount * 60
      if (seconds === 18_000) tier = 'five_hour'
      else if (seconds === 604_800) tier = 'weekly'
      else if (seconds >= 28 * 86400 && seconds <= 31 * 86400) tier = 'monthly'
    }
    if (tier === 'other' && label === 'usage') tier = fallbackTier
    const resetAt = cliProxyEpoch(raw.reset_at ?? raw.resetAt ?? raw.reset_time ?? raw.resetTime) ?? cliProxyRelativeReset(raw.reset_in ?? raw.resetIn ?? raw.ttl)
    const window = cliProxyWindow(tier, remaining === undefined ? (usedAmount !== undefined && limit !== undefined && limit > 0 ? usedAmount / limit * 100 : undefined) : 100 - remaining, resetAt, tier === 'other' ? label : '')
    if (window !== undefined) rows.push(window)
  }
  if (Array.isArray(body?.limits)) {
    body.limits.forEach((item, index) => {
      if (!cliProxyObject(item)) return
      const detail = cliProxyObject(item.detail) ? item.detail : item
      const win = cliProxyObject(item.window) ? item.window : {}
      add(detail, cpaFirstText(detail.name, detail.title, detail.scope, item.name, item.title), win.duration ?? item.duration ?? detail.duration, win.timeUnit ?? item.timeUnit ?? detail.timeUnit)
    })
  }
  if (cliProxyObject(body?.usage)) add(body.usage, 'usage', undefined, undefined, 'weekly')
  return rows
}

function cliProxyXaiWindows(body, period) {
  const config = cliProxyObject(body?.config) ? body.config : body
  const rows = []
  const current = cliProxyObject(config?.currentPeriod) ? config.currentPeriod : cliProxyObject(config?.current_period) ? config.current_period : {}
  const periodEnd = cliProxyEpoch(current.end ?? config?.billingPeriodEnd ?? config?.billing_period_end)
  const creditUsage = cliProxyPercent(config?.creditUsagePercent ?? config?.credit_usage_percent)
  if (creditUsage !== undefined && period !== 'monthly') rows.push(cliProxyWindow('weekly', creditUsage, periodEnd, 'Credits'))
  const val = (value) => cliProxyObject(value) ? toFinite(value.val) : toFinite(value)
  const monthlyLimit = val(config?.monthlyLimit ?? config?.monthly_limit)
  const used = val(config?.used)
  if (monthlyLimit !== undefined && monthlyLimit > 0 && used !== undefined) {
    rows.push(cliProxyWindow('monthly', used / monthlyLimit * 100, period === 'monthly' ? periodEnd : undefined, 'Monthly credits'))
  }
  const products = config?.productUsage ?? config?.product_usage
  if (Array.isArray(products)) {
    products.forEach((item, index) => {
      if (!cliProxyObject(item)) return
      const usage = cliProxyPercent(item.usagePercent ?? item.usage_percent)
      if (usage === undefined) return
      const product = cpaSafeText(item.product, 64) || `Product ${index + 1}`
      rows.push(cliProxyWindow('weekly', usage, periodEnd, product))
    })
  }
  return rows.filter(Boolean)
}

function cliProxyDevinResult(body) {
  const status = cliProxyObject(body?.userStatus?.planStatus) ? body.userStatus.planStatus : {}
  const planInfo = cliProxyObject(status.planInfo) ? status.planInfo : cliProxyObject(body?.planInfo) ? body.planInfo : {}
  const rows = []
  for (const [id, key] of [['daily', 'daily'], ['weekly', 'weekly']]) {
    const remaining = cliProxyPercent(status[`${key}QuotaRemainingPercent`])
    const resetAt = cliProxyEpoch(status[`${key}QuotaResetAtUnix`])
    const window = cliProxyWindow(id === 'weekly' ? 'weekly' : 'other', remaining === undefined ? undefined : 100 - remaining, resetAt, id === 'daily' ? 'Daily' : '')
    if (window !== undefined) rows.push(window)
  }
  if (rows.length === 0) throw new Error('CLIProxyAPI returned no Devin quota data')
  return { windows: rows, planTier: cpaSafeText(planInfo.planName, 48) || undefined }
}

function cliProxyMetaResult(body) {
  const usage = cliProxyObject(body?.subs_usage) ? body.subs_usage : {}
  const rows = []
  for (const [id, raw] of [['window', usage.window], ['weekly', usage.weekly]]) {
    if (!cliProxyObject(raw)) continue
    const used = cliProxyPercent(raw.used_percent)
    const resetAt = cliProxyEpoch(raw.resets_at)
    const mins = toFinite(raw.window_duration_mins)
    const tier = id === 'weekly' ? 'weekly' : mins !== undefined && mins * 60 === 18_000 ? 'five_hour' : mins !== undefined && mins >= 28 * 1440 && mins <= 31 * 1440 ? 'monthly' : 'other'
    const window = cliProxyWindow(tier, used, resetAt, tier === 'other' ? id : '')
    if (window !== undefined) rows.push(window)
  }
  return { windows: rows, planTier: cpaSafeText(body?.subs_tier_name ?? usage.tier, 48) || undefined }
}

function cliProxyUpstreamError(status) {
  const error = new Error('CLIProxyAPI upstream request failed')
  error.kind = status === 401 ? 'auth' : status === 403 ? 'forbidden' : status === 404 ? 'unsupported' : 'http'
  return error
}

async function cliProxyManagementApiCall(origin, managementKey, payload) {
  const response = await fetchCliProxyJson(`${origin}/v0/management/api-call`, managementKey, { method: 'POST', body: payload })
  if (!cliProxyObject(response)) throw new Error('CLIProxyAPI api-call response has an unexpected shape')
  const status = toFinite(response.status_code ?? response.statusCode ?? response.status)
  if (status === undefined) throw new Error('CLIProxyAPI api-call response has no status')
  if (status < 200 || status >= 300) throw cliProxyUpstreamError(status)
  const body = cliProxyUnwrap(response.body ?? response.data)
  if (!cliProxyObject(body)) throw new Error('CLIProxyAPI upstream response has an unexpected shape')
  return body
}

function cliProxyApiCall(origin, managementKey, authIndex, method, url, header, data = undefined) {
  return cliProxyManagementApiCall(origin, managementKey, {
    auth_index: authIndex,
    method,
    url,
    header,
    ...(data === undefined ? {} : { data: JSON.stringify(data) }),
  })
}

async function cliProxyLoadGoogleProject(origin, managementKey, authIndex, metadata, antigravity = false) {
  const header = antigravity ? cliProxyAntigravityHeaders() : cliProxyGoogleHeaders(metadata)
  return cliProxyApiCall(origin, managementKey, authIndex, 'POST', CLI_PROXY_UPSTREAM.googleLoad, header, { metadata })
}

async function cliProxyProbeBuiltin(origin, managementKey, file, details, normalizedProvider) {
  const authIndex = details.authIndex
  const api = (method, url, header, data) => cliProxyApiCall(origin, managementKey, authIndex, method, url, header, data)
  if (normalizedProvider === 'codex') {
    const header = { Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json', 'User-Agent': 'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal' }
    const accountId = cpaFirstText(file.chatgpt_account_id, file.account_id, cliProxyPath(file, 'tokens', 'account_id'), cliProxyPath(file, 'tokens', 'chatgpt_account_id'), cliProxyPath(file, 'metadata', 'account_id'), cliProxyPath(file, 'attributes', 'account_id'))
    if (accountId !== '') header['Chatgpt-Account-Id'] = accountId
    const body = await api('GET', CLI_PROXY_UPSTREAM.codexUsage, header)
    return { windows: cliProxyCodexWindows(body), planTier: cliProxyPlanFromBody(body) }
  }
  if (normalizedProvider === 'claude') {
    const header = { Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json', 'anthropic-beta': 'oauth-2025-04-20' }
    const [usage, profile] = await Promise.all([
      api('GET', CLI_PROXY_UPSTREAM.claudeUsage, header),
      api('GET', CLI_PROXY_UPSTREAM.claudeProfile, header).catch(() => undefined),
    ])
    return { windows: cliProxyClaudeWindows(usage), planTier: cliProxyClaudePlan(profile) ?? cliProxyPlanFromBody(usage) }
  }
  if (normalizedProvider === 'gemini-cli') {
    const metadata = { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' }
    let project = cliProxyProjectId(file)
    let plan
    let planRequest
    if (project === '') {
      const loaded = await cliProxyLoadGoogleProject(origin, managementKey, authIndex, metadata)
      project = cliProxyGoogleProject(loaded)
      plan = cliProxyGooglePlan(loaded)
    } else {
      planRequest = cliProxyLoadGoogleProject(origin, managementKey, authIndex, metadata).then(cliProxyGooglePlan, () => undefined)
    }
    if (project === '') throw new Error('CLIProxyAPI Gemini project is unavailable')
    const body = await api('POST', CLI_PROXY_UPSTREAM.googleQuota, cliProxyGoogleHeaders({ ...metadata, duetProject: project }), { project })
    if (planRequest !== undefined) plan = (await planRequest) || plan
    return { windows: geminiWindows(Array.isArray(body.buckets) ? body.buckets : []), planTier: plan }
  }
  if (normalizedProvider === 'antigravity') {
    const metadata = { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' }
    let project = cliProxyProjectId(file)
    let plan
    let planRequest
    if (project === '') {
      const loaded = await cliProxyLoadGoogleProject(origin, managementKey, authIndex, metadata, true)
      project = cliProxyGoogleProject(loaded)
      plan = antigravityPlanTier(loaded) ?? cliProxyGooglePlan(loaded)
    } else {
      planRequest = cliProxyLoadGoogleProject(origin, managementKey, authIndex, metadata, true).then((body) => antigravityPlanTier(body) ?? cliProxyGooglePlan(body), () => undefined)
    }
    if (project === '') throw new Error('CLIProxyAPI Antigravity project is unavailable')
    const windowsByKey = new Map()
    let lastError
    for (const url of CLI_PROXY_UPSTREAM.antigravityQuota) {
      try {
        const body = await api('POST', url, cliProxyAntigravityHeaders(), { project })
        plan = plan || antigravityPlanTier(body) || cliProxyGooglePlan(body)
        for (const window of antigravitySummaryWindows(body)) {
          const key = `${window.tier}:${window.name ?? ''}`
          if (!windowsByKey.has(key)) windowsByKey.set(key, window)
        }
        if ([...windowsByKey.values()].some((window) => /gemini/i.test(`${window.tier} ${window.name ?? ''}`))) break
      } catch (error) {
        lastError = error
      }
    }
    let windows = [...windowsByKey.values()]
    if (!windows.some((window) => /gemini/i.test(`${window.tier} ${window.name ?? ''}`))) {
      try {
        const body = await api('POST', CLI_PROXY_UPSTREAM.googleQuota, cliProxyAntigravityHeaders(), { project })
        windows = [...windows, ...geminiWindows(Array.isArray(body.buckets) ? body.buckets : [])]
        plan = plan || antigravityPlanTier(body) || cliProxyGooglePlan(body)
      } catch (error) {
        lastError = lastError ?? error
      }
    }
    if (planRequest !== undefined) plan = (await planRequest) || plan
    if (windows.length === 0) throw lastError ?? new Error('CLIProxyAPI Antigravity quota is unavailable')
    return { windows, planTier: plan }
  }
  if (normalizedProvider === 'kimi') {
    const hosts = cliProxyKimiPrefersAi(file) ? [CLI_PROXY_UPSTREAM.kimiAi, CLI_PROXY_UPSTREAM.kimi] : [CLI_PROXY_UPSTREAM.kimi, CLI_PROXY_UPSTREAM.kimiAi]
    let lastError
    for (const url of hosts) {
      try {
        const body = await api('GET', url, { Authorization: 'Bearer $TOKEN$' })
        return { windows: cliProxyKimiWindows(body), planTier: cliProxyPlanFromBody(body) }
      } catch (error) {
        lastError = error
        if (!['auth', 'forbidden'].includes(error?.kind)) break
      }
    }
    throw lastError ?? new Error('CLIProxyAPI Kimi quota is unavailable')
  }
  if (normalizedProvider === 'xai') {
    const header = {
      Authorization: 'Bearer $TOKEN$',
      'x-xai-token-auth': 'xai-grok-cli',
      'x-grok-client-version': '0.2.91',
      accept: '*/*',
      'user-agent': 'grok-pager/0.2.91 grok-shell/0.2.91 (windows; amd64)',
    }
    const userId = cpaFirstText(file.sub, file.subject, file.user_id, file.userId, cliProxyPath(file, 'metadata', 'sub'), cliProxyPath(file, 'metadata', 'user_id'), cliProxyPath(file, 'attributes', 'sub'))
    if (userId !== '') header['x-userid'] = userId
    const [weekly, monthly] = await Promise.allSettled([
      api('GET', CLI_PROXY_UPSTREAM.xaiWeekly, header),
      api('GET', CLI_PROXY_UPSTREAM.xaiMonthly, header),
    ])
    if (weekly.status === 'rejected' && monthly.status === 'rejected') throw weekly.reason
    const windows = [
      ...(weekly.status === 'fulfilled' ? cliProxyXaiWindows(weekly.value, 'weekly') : []),
      ...(monthly.status === 'fulfilled' ? cliProxyXaiWindows(monthly.value, 'monthly') : []),
    ]
    return { windows, planTier: windows.length === 0 ? 'Paid' : undefined }
  }
  if (normalizedProvider === 'devin') {
    const body = await api('POST', CLI_PROXY_UPSTREAM.devin, { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, {
      metadata: { ideName: 'chisel', ideVersion: '3000.10.21', apiKey: '$TOKEN$', locale: 'en', os: 'darwin', extensionVersion: '3000.10.21', clientName: 'chisel' },
    })
    return cliProxyDevinResult(body)
  }
  if (normalizedProvider === 'meta') {
    const name = cpaFirstText(file.name, file.id)
    if (name === '' || cpaFlag(file.runtime_only ?? file.runtimeOnly)) throw new Error('CLIProxyAPI Meta token is unavailable')
    const downloaded = await fetchCliProxyJson(`${origin}/v0/management/auth-files/download?name=${encodeURIComponent(name)}`, managementKey)
    const token = cliProxyUnwrap(downloaded)?.dca_token
    if (typeof token !== 'string' || !/^dca:\S+$/.test(token)) throw new Error('CLIProxyAPI Meta token is unavailable')
    const body = await api('POST', CLI_PROXY_UPSTREAM.meta, { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'x-api-version': '1.0.0' }, {})
    return cliProxyMetaResult(body)
  }
  throw new Error('CLIProxyAPI provider is unsupported')
}

function cliProxyEpoch(value) {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()))) {
    const number = Number(value)
    if (!Number.isFinite(number) || number <= 0) return undefined
    const milliseconds = number > 1e12 ? number : number * 1000
    return Number.isFinite(milliseconds) ? milliseconds : undefined
  }
  if (typeof value === 'string') {
    const milliseconds = Date.parse(value)
    return Number.isFinite(milliseconds) ? milliseconds : undefined
  }
  return undefined
}

function cliProxyPercent(value, fraction = false) {
  if (typeof value === 'string' && value.trim().endsWith('%')) value = value.trim().slice(0, -1)
  const number = toFinite(value)
  if (number === undefined) return undefined
  const percent = fraction && number >= 0 && number <= 1 ? number * 100 : number
  return Math.max(0, Math.min(100, percent))
}

function cliProxyTier(...values) {
  const label = values.map((value) => cpaSafeText(value, 64).toLowerCase()).filter(Boolean).join(' ')
  if (/(?:5\s*[-_ ]?h|five\s*[-_ ]?hour|300\s*min)/.test(label)) return 'five_hour'
  if (/(?:weekly|week|7\s*[-_ ]?d|seven\s*[-_ ]?day)/.test(label)) return 'weekly'
  if (/(?:monthly|month|30\s*[-_ ]?d)/.test(label)) return 'monthly'
  return 'other'
}

function cliProxyQuotaWindows(rawPayload) {
  const payload = cliProxyUnwrap(rawPayload)
  if (payload === null || typeof payload !== 'object') return []
  const rows = []
  const add = (bucket, groupLabel = '') => {
    if (bucket === null || typeof bucket !== 'object' || Array.isArray(bucket)) return
    const bucketLabel = cpaFirstText(bucket.displayName, bucket.display_name, bucket.label, bucket.name, bucket.bucketId, bucket.bucket_id)
    const tier = cliProxyTier(bucket.window, bucket.windowType, bucket.window_type, bucket.duration, bucketLabel, groupLabel)
    let remaining = cliProxyPercent(bucket.remainingFraction ?? bucket.remaining_fraction, true)
    if (remaining === undefined) remaining = cliProxyPercent(bucket.remainingPercent ?? bucket.remaining_percent ?? bucket.remaining)
    let used = cliProxyPercent(bucket.usedPercent ?? bucket.used_percent)
    if (used === undefined && remaining === undefined) {
      const amount = toFinite(bucket.used ?? bucket.consumed)
      const limit = toFinite(bucket.limit ?? bucket.total)
      if (amount !== undefined && limit !== undefined && limit > 0) used = Math.max(0, Math.min(100, amount / limit * 100))
    }
    if (used === undefined && remaining !== undefined) used = 100 - remaining
    if (remaining === undefined && used !== undefined) remaining = 100 - used
    if (used === undefined && remaining === undefined) return

    const resetAt = cliProxyEpoch(bucket.resetTime ?? bucket.reset_time ?? bucket.resetAt ?? bucket.reset_at ?? bucket.resetsAt ?? bucket.resets_at)
    const nameParts = [groupLabel, bucketLabel].filter((part, index, list) => part !== '' && list.indexOf(part) === index)
    const windowName = (tier === 'other' || nameParts.length > 1) ? nameParts.join(' · ') : ''
    rows.push({
      tier,
      usedPercent: used,
      ...(resetAt === undefined ? {} : { resetAt }),
      ...(windowName === '' ? {} : { name: windowName }),
    })
  }

  if (Array.isArray(payload.windows)) {
    for (const window of payload.windows) add(window)
  }
  if (Array.isArray(payload.groups)) {
    for (const group of payload.groups) {
      if (group === null || typeof group !== 'object' || Array.isArray(group)) continue
      const groupLabel = cpaFirstText(group.displayName, group.display_name, group.label, group.name, group.id)
      const buckets = Array.isArray(group.buckets) ? group.buckets : Array.isArray(group.windows) ? group.windows : []
      for (const bucket of buckets) add(bucket, groupLabel)
      if (buckets.length === 0) add(group, groupLabel)
    }
  }
  return rows
}

function cliProxyPlan(payload) {
  const subscription = payload !== null && typeof payload === 'object' ? payload.subscription : undefined
  const plan = cpaFirstText(subscription?.tierName, subscription?.tier_name, subscription?.plan, subscription?.tierId, subscription?.tier_id)
  return plan === '' ? undefined : plan.slice(0, 48)
}

function cliProxyErrorEntry(provider, providerName, error, fetchedAt = Date.now()) {
  const kind = error?.kind === 'auth' || error?.kind === 'forbidden' || error?.kind === 'unsupported'
    ? error.kind
    : 'http'
  return { status: 'error', provider, providerName, fetchedAt, error: { kind } }
}

function cliProxyAuthIndex(file) {
  const value = file.auth_index ?? file.authIndex ?? file.index
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : ''
  if (typeof value !== 'string') return ''
  const index = value.trim()
  return index.length > 0 && index.length <= 256 && !/[\u0000-\u001f\u007f]/.test(index) ? index : ''
}

function cliProxyPublicProvider(sourceProvider) {
  const normalized = cliProxyNormalizeProvider(sourceProvider)
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized) ? normalized : 'plugin'
}

function cliProxyFileEntry(file, index) {
  const indexText = cliProxyAuthIndex(file)
  const ordinal = String(index + 1)
  const internalName = cpaFirstText(file.name, file.id, indexText, `auth-file-${ordinal}`)
  const sourceProvider = cpaFirstText(file.provider, file.quota_provider, file.quotaProvider, file.type)
  const publicProvider = cliProxyPublicProvider(sourceProvider)
  const provider = `cli-proxy-${cpaSlug(publicProvider)}-${ordinal}`
  const providerName = `CLIProxy · ${cpaProviderLabel(publicProvider)} · Account #${ordinal}`.slice(0, 120)
  return {
    provider,
    providerName,
    markProvider: publicProvider,
    internalName,
    sourceProvider,
    authIndex: indexText,
  }
}

async function mapConcurrent(items, concurrency, fn) {
  const output = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      output[index] = await fn(items[index], index)
    }
  }))
  return output
}

async function fetchCliProxyAuthQuota(ctx, origin, managementKey) {
  const list = await fetchCliProxyJson(`${origin}/v0/management/auth-files`, managementKey)
  const files = Array.isArray(list) ? list : list?.files ?? list?.auth_files ?? list?.authFiles
  if (!Array.isArray(files)) throw new Error('CLIProxyAPI auth-files response has an unexpected shape')

  const seen = new Set()
  const supported = files.slice(0, CLI_PROXY_MAX_AUTH_FILES).filter((file) => {
    if (file === null || typeof file !== 'object' || Array.isArray(file)) return false
    const status = cpaFirstText(file.status).toLowerCase()
    if (cpaFlag(file.disabled) || status === 'disabled' || status === 'unavailable') return false
    const name = cpaFirstText(file.name, file.id, file.auth_index, file.authIndex)
    const authIndex = cliProxyAuthIndex(file)
    const sourceProvider = cpaFirstText(file.provider, file.quota_provider, file.quotaProvider, file.type)
    const normalizedProvider = cliProxyNormalizeProvider(sourceProvider)
    const builtin = CLI_PROXY_BUILTIN_PROVIDERS.has(normalizedProvider)
    const pluginQuota = cpaFlag(file.supports_quota ?? file.supportsQuota)
    if (!builtin && !pluginQuota) return false
    const identity = authIndex === '' ? `${normalizedProvider}\u0000${name.toLowerCase()}` : `index:${authIndex}`
    if (name === '' || seen.has(identity)) return false
    seen.add(identity)
    return true
  })

  return await mapConcurrent(supported, CLI_PROXY_MAX_CONCURRENCY, async (file, index) => {
    const details = cliProxyFileEntry(file, index)
    if (details.authIndex === '') return cliProxyErrorEntry(details.provider, details.providerName, { kind: 'unsupported' })
    try {
      const normalizedProvider = cliProxyNormalizeProvider(details.sourceProvider)
      if (CLI_PROXY_BUILTIN_PROVIDERS.has(normalizedProvider)) {
        const result = await cliProxyProbeBuiltin(origin, managementKey, file, details, normalizedProvider)
        return {
          status: 'ok',
          provider: details.provider,
          providerName: details.providerName,
          markProvider: details.markProvider,
          ...(result.planTier === undefined ? {} : { planTier: result.planTier }),
          fetchedAt: Date.now(),
          windows: Array.isArray(result.windows) ? result.windows : [],
        }
      }
      const body = await fetchCliProxyJson(`${origin}/v0/management/quota/fetch`, managementKey, {
        method: 'POST',
        body: {
          auth_index: details.authIndex,
          ...(details.sourceProvider === '' ? {} : { provider: details.sourceProvider }),
        },
      })
      const payload = cliProxyUnwrap(body)
      if (payload === undefined) throw new Error('CLIProxyAPI quota response has an unexpected shape')
      const planTier = cliProxyPlan(payload)
      return {
        status: 'ok',
        provider: details.provider,
        providerName: details.providerName,
        markProvider: details.markProvider,
        ...(planTier === undefined ? {} : { planTier }),
        fetchedAt: Date.now(),
        windows: cliProxyQuotaWindows(payload),
      }
    } catch (error) {
      return cliProxyErrorEntry(details.provider, details.providerName, error)
    }
  })
}

/** One row per quota-capable CLIProxyAPI auth file; public rows contain no secrets. */
async function queryCliProxyQuota(ctx, options) {
  const managementKey = await readCliProxyManagementKey(ctx)
  if (managementKey === undefined) return []
  const origin = cliProxyManagementOrigin(await readCliProxyManagementUrl(ctx))
  if (origin === undefined) return [cliProxyErrorEntry('cli-proxy-api', 'CLIProxyAPI', new Error('invalid management URL'))]

  const generation = cliProxyCacheGeneration
  const cached = cliProxyCache.get(origin)
  if (cached !== undefined && cached.generation === generation) {
    const age = Date.now() - cached.at
    const floor = options.refresh === true ? CLI_PROXY_REFRESH_FLOOR_MS : CLI_PROXY_CACHE_TTL_MS
    if (age < floor) return cached.providers
  }
  const inflightKey = `${origin}\u0000${generation}`
  const running = cliProxyInflight.get(inflightKey)
  if (running !== undefined) return running

  const query = (async () => {
    try {
      const providers = await fetchCliProxyAuthQuota(ctx, origin, managementKey)
      if (cliProxyCacheGeneration === generation) {
        cliProxyCache.set(origin, { generation, at: Date.now(), providers })
      }
      return providers
    } catch (error) {
      return [cliProxyErrorEntry('cli-proxy-api', 'CLIProxyAPI', error)]
    }
  })()
  cliProxyInflight.set(inflightKey, query)
  try {
    return await query
  } finally {
    cliProxyInflight.delete(inflightKey)
  }
}

const ADAPTERS = {
  'opencode-go': { needsApiKey: true, query: queryOpencodeGo },
  'command-code': { needsApiKey: true, query: queryCommandCode },
  codex: { requiresLogin: true, query: queryCodex },
  claude: {
    requiresLogin: true,
    query: queryClaude,
    ttlMs: CLAUDE_CACHE_TTL_MS,
    refreshFloorMs: CLAUDE_REFRESH_FLOOR_MS,
  },
  gemini: { requiresLogin: true, query: queryGemini, ttlMs: GEMINI_CACHE_TTL_MS, refreshFloorMs: 60_000 },
  antigravity: {
    available: antigravityAvailable,
    query: queryAntigravity,
    ttlMs: ANTIGRAVITY_CACHE_TTL_MS,
    refreshFloorMs: 30_000,
  },
}

/** Resolve a provider's API key through the credential seam. */
async function readApiKey(ctx, provider) {
  const envNames = API_KEY_ENV[provider]
  if (envNames === undefined) return undefined
  // Names in order; within one name the credential seam is asked before the
  // process environment, so a key saved in Settings beats a stray shell value.
  for (const envName of envNames) {
    try {
      const resolved = await credentialsOf(ctx)?.resolve?.(envName)
      if (resolved !== null && typeof resolved === 'object' && typeof resolved.value === 'string' && resolved.value !== '') {
        return resolved.value
      }
    } catch {
      // A credential seam failure falls through to the process environment.
    }
    const ambient = process.env[envName]
    if (typeof ambient === 'string' && ambient !== '') return ambient
  }
  return undefined
}

/** Whether a CLI-login provider is actually usable on this machine. */
async function hasLogin(provider) {
  const paths = LOGIN_PATHS[provider]
  if (paths === undefined) return true
  const cached = detected.get(provider)
  if (cached !== undefined && Date.now() - cached.at < DETECT_TTL_MS) return cached.value
  let value = false
  for (const path of paths()) {
    if (await fileExists(path)) {
      value = true
      break
    }
  }
  detected.set(provider, { at: Date.now(), value })
  return value
}

function errorKindOf(error) {
  if (error?.kind === 'unsupported') return 'unsupported'
  if (error?.status === 401) return 'auth'
  if (error?.status === 403) return 'forbidden'
  return 'http'
}

async function queryProvider(ctx, provider, options) {
  const adapter = ADAPTERS[provider]
  if (adapter === undefined) return undefined

  const cached = cache.get(provider)
  if (cached !== undefined) {
    const age = Date.now() - cached.at
    const limit = options.refresh === true ? (adapter.refreshFloorMs ?? 0) : (adapter.ttlMs ?? CACHE_TTL_MS)
    if (age < limit) return cached.payload
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
          kind: errorKindOf(error),
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

function adapterKeyOf(id) {
  if (ADAPTERS[id] !== undefined) return id
  const alias = PROVIDER_ALIASES[id]
  return alias !== undefined && ADAPTERS[alias] !== undefined ? alias : undefined
}

/** The whole bar payload: one entry per provider that reports quota. */
async function snapshot(ctx, options) {
  let providers = []
  try {
    providers = (ctx.llm?.listProviders?.() ?? []).map((entry) => entry.id)
  } catch {
    providers = []
  }

  const candidates = []
  for (const id of [...providers, ...LOCAL_PROVIDERS]) {
    const key = adapterKeyOf(String(id))
    if (key === undefined || candidates.includes(key)) continue
    candidates.push(key)
  }

  const eligible = []
  for (const provider of candidates) {
    const adapter = ADAPTERS[provider]
    if (adapter.requiresLogin === true && !(await hasLogin(provider))) continue
    if (typeof adapter.available === 'function' && !(await adapter.available())) continue
    eligible.push(provider)
  }

  const [results, cliProxyProviders] = await Promise.all([
    Promise.all(eligible.map(async (provider) => {
      if (provider === 'command-code') {
        const entries = await queryCommandCodeUsage(options)
        // The shared service answered (even with no chip to draw): never ask the
        // billing endpoints behind its back.
        if (entries !== undefined) return entries
      }
      return [await queryProvider(ctx, provider, options)]
    })),
    queryCliProxyQuota(ctx, options),
  ])

  return {
    intervalSec: DEFAULT_INTERVAL_SEC,
    providers: [...results.flat().filter((entry) => entry !== undefined), ...cliProxyProviders],
  }
}

function settingsResponse(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(payload))
}

function admitSettingsRequest(ctx, req, res, expectedMethod) {
  if (req.method !== expectedMethod) {
    settingsResponse(res, 405, { error: 'method-not-allowed' })
    return false
  }

  // `webServer.getOrigin()` describes the Web listener, not the Desktop
  // document's API mount. Use DSH Connection's Host/Origin and browser-auth
  // checks, which also admit the Desktop shell's authenticated no-Origin calls.
  const connection = ctx.get?.('connection')
  if (typeof connection?.requestRejection !== 'function') {
    settingsResponse(res, 503, { error: 'request-security-unavailable' })
    return false
  }

  if (expectedMethod === 'POST') {
    const headers = req.headers ?? {}
    if (headers['sec-fetch-site'] === 'cross-site') {
      settingsResponse(res, 403, { error: 'same-origin-required' })
      return false
    }
    const suppliedOrigin = headers.origin
    if (suppliedOrigin !== undefined) {
      const host = headers.host
      let sameAuthority = false
      try {
        sameAuthority = typeof suppliedOrigin === 'string'
          && typeof host === 'string'
          && new URL(suppliedOrigin).host.toLowerCase() === host.toLowerCase()
      } catch {
        // An invalid Origin is rejected below without echoing it.
      }
      if (!sameAuthority) {
        settingsResponse(res, 403, { error: 'same-origin-required' })
        return false
      }
    }
  }

  let rejection
  try {
    rejection = connection.requestRejection(req)
  } catch {
    rejection = 403
  }
  if (rejection !== undefined) {
    const status = rejection === 401 || rejection === 403 ? rejection : 403
    settingsResponse(res, status, { error: 'request-rejected' })
    return false
  }
  return true
}

function settingsRouteError(status, code) {
  const error = new Error(code)
  error.status = status
  return error
}

/** Return only a safe, allowlisted credential-store diagnosis; never expose paths or input. */
function safeCredentialFailureReason(error) {
  switch (error?.code) {
    case 'EACCES':
    case 'EPERM': return 'credential-store-permission-denied'
    case 'EROFS': return 'credential-store-read-only'
    case 'ENOSPC':
    case 'EDQUOT': return 'credential-store-no-space'
    case 'ENOENT':
    case 'ENOTDIR': return 'credential-store-path-unavailable'
    case 'EBUSY':
    case 'ETIMEDOUT': return 'credential-store-lock-timeout'
  }
  const message = typeof error?.message === 'string' ? error.message : ''
  if (message.includes('pre-release flat layout')) return 'credential-store-migration-required'
  if (message.includes('invalid document') || message.includes('must be a mapping')) {
    return 'credential-store-document-invalid'
  }
  if (message.includes('declares version')) return 'credential-store-version-unsupported'
  if (message.includes('readable beyond its owner')) return 'credential-store-permissions-unsafe'
  return 'credential-store-write-failed'
}

async function readSettingsBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > SETTINGS_MAX_BODY_BYTES) throw settingsRouteError(413, 'settings-body-too-large')
    chunks.push(bytes)
  }
  let body
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw settingsRouteError(400, 'invalid-settings-body')
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw settingsRouteError(400, 'invalid-settings-body')
  }
  const allowed = new Set(['managementUrl', 'managementKey', 'clearManagementUrl', 'clearManagementKey'])
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw settingsRouteError(400, 'invalid-settings-fields')
  }
  return body
}

async function cliProxySettingsSnapshot(ctx) {
  const credentials = credentialsOf(ctx)
  const managementUrl = await readCliProxyManagementUrl(ctx)
  let managementKeyConfigured
  try {
    const info = await credentials?.describe?.(CLI_PROXY_MANAGEMENT_KEY_REF)
    if (typeof info?.configured === 'boolean') managementKeyConfigured = info.configured
  } catch {
    // Use resolve below as a compatibility fallback for credential providers.
  }
  if (managementKeyConfigured === undefined) {
    managementKeyConfigured = (await readCliProxyManagementKey(ctx)) !== undefined
  }
  return {
    managementUrl,
    managementUrlValid: cliProxyManagementOrigin(managementUrl) !== undefined,
    managementKeyConfigured,
  }
}

async function handleCliProxySettings(req, res, ctx) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    settingsResponse(res, 405, { error: 'method-not-allowed' })
    return
  }
  if (!admitSettingsRequest(ctx, req, res, req.method)) return

  if (req.method === 'GET') {
    try {
      settingsResponse(res, 200, await cliProxySettingsSnapshot(ctx))
    } catch {
      settingsResponse(res, 500, { error: 'settings-unavailable' })
    }
    return
  }
  const contentType = req.headers?.['content-type']
  if (typeof contentType !== 'string' || contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    settingsResponse(res, 415, { error: 'application-json-required' })
    return
  }

  let body
  try {
    body = await readSettingsBody(req)
  } catch (error) {
    settingsResponse(res, error?.status ?? 400, { error: error?.message ?? 'invalid-settings-body' })
    return
  }

  const hasManagementUrl = Object.hasOwn(body, 'managementUrl')
  const hasManagementKey = Object.hasOwn(body, 'managementKey')
  const clearManagementUrl = body.clearManagementUrl === true
  const clearManagementKey = body.clearManagementKey === true
  if ((hasManagementUrl && typeof body.managementUrl !== 'string')
    || (hasManagementKey && typeof body.managementKey !== 'string')
    || (Object.hasOwn(body, 'clearManagementUrl') && typeof body.clearManagementUrl !== 'boolean')
    || (Object.hasOwn(body, 'clearManagementKey') && typeof body.clearManagementKey !== 'boolean')
    || (hasManagementUrl && clearManagementUrl)
    || (hasManagementKey && clearManagementKey)
    || (hasManagementUrl && body.managementUrl.length > 2048)
    || (hasManagementKey && body.managementKey.length > 8192)) {
    settingsResponse(res, 400, { error: 'invalid-settings-value' })
    return
  }

  const rawUrl = hasManagementUrl ? body.managementUrl.trim() : undefined
  if (rawUrl !== undefined && rawUrl !== '' && cliProxyManagementOrigin(rawUrl) === undefined) {
    settingsResponse(res, 400, { error: 'invalid-management-url' })
    return
  }
  const rawKey = hasManagementKey ? body.managementKey.trim() : undefined
  if (rawKey !== undefined && rawKey.length > 8192) {
    settingsResponse(res, 400, { error: 'invalid-management-key' })
    return
  }
  const changeUrl = hasManagementUrl || clearManagementUrl
  const changeKey = clearManagementKey || (rawKey !== undefined && rawKey !== '')
  if (!changeUrl && !changeKey) {
    settingsResponse(res, 400, { error: 'no-settings-to-save' })
    return
  }
  const credentials = credentialsOf(ctx)
  if (typeof credentials?.set !== 'function' || typeof credentials?.unset !== 'function') {
    settingsResponse(res, 503, { error: 'credential-store-unavailable' })
    return
  }

  let urlWriteCompleted = false
  let keyWriteCompleted = false
  try {
    if (changeUrl) {
      if (clearManagementUrl || rawUrl === '') await credentials.unset(CLI_PROXY_MANAGEMENT_URL_ENV)
      else await credentials.set(CLI_PROXY_MANAGEMENT_URL_ENV, rawUrl)
      urlWriteCompleted = true
    }
    if (changeKey) {
      if (clearManagementKey) await credentials.unset(CLI_PROXY_MANAGEMENT_KEY_REF)
      else await credentials.set(CLI_PROXY_MANAGEMENT_KEY_REF, rawKey)
      keyWriteCompleted = true
    }
    if (urlWriteCompleted || keyWriteCompleted) invalidateCliProxyCache()
    settingsResponse(res, 200, { ok: true, ...await cliProxySettingsSnapshot(ctx) })
  } catch (error) {
    if (urlWriteCompleted || keyWriteCompleted) invalidateCliProxyCache()
    // Never serialize credential-service messages; they may contain a path or input value.
    const completedWrites = Number(urlWriteCompleted) + Number(keyWriteCompleted)
    const requestedWrites = Number(changeUrl) + Number(changeKey)
    settingsResponse(res, 500, {
      error: 'settings-save-failed',
      reason: safeCredentialFailureReason(error),
      ...(completedWrites > 0 && completedWrites < requestedWrites ? { partial: true } : {}),
    })
  }
}

export function apply(ctx) {
  // Optional: the upstream Command Code plugin's own multi-account report. A
  // profile without that plugin never enters this fiber.
  ctx.inject(['commandcodeUsage'], (scope) => {
    // Refcounted so a reload / repeated apply cannot clear a service another
    // live fiber still holds; the last disposer (upstream unloaded) drops it
    // and the next snapshot falls back to the raw billing endpoints.
    commandCodeUsage = scope.commandcodeUsage
    commandCodeUsageRefs += 1
    scope.effect(() => () => {
      commandCodeUsageRefs = Math.max(0, commandCodeUsageRefs - 1)
      if (commandCodeUsageRefs === 0) commandCodeUsage = undefined
    }, 'provider-quota: commandcode usage')
  })

  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => {
      const disposers = []
      try {
        disposers.push(scope.webServer.register({
          kind: 'exact',
          path: QUOTA_PATH,
          handler: async (req, res) => {
            if (req.method !== 'GET') {
              res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
              res.end('method not allowed')
              return
            }
            try {
              const query = new URL(req.url ?? '/', 'http://localhost').searchParams
              const refresh = query.get('refresh') === '1'
              const payload = await snapshot(ctx, { refresh })
              if (query.get('includeCliProxyProviders') === '1') {
                // Opt-in diagnostic: return only names, cleaned service URLs,
                // and disabled flags from CLIProxyAPI's compatibility list.
                payload.cliProxyConfiguredProviders = await queryCliProxyConfiguredProviders(ctx)
              }
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
        }))
        disposers.push(scope.webServer.register({
          kind: 'exact',
          path: QUOTA_SETTINGS_PATH,
          handler: (req, res) => handleCliProxySettings(req, res, ctx),
        }))
      } catch (error) {
        for (const dispose of disposers.reverse()) dispose?.()
        throw error
      }
      return () => {
        for (const dispose of disposers.reverse()) dispose?.()
      }
    }, 'provider-quota: state and settings routes')
  })
}
