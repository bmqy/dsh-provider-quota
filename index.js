// Host half of the provider quota bar.
//
// One same-origin JSON route, `/provider-quota/state`, reports the plan usage
// of every configured provider plus the local coding CLIs; the browser half
// only renders that payload, so credentials and provider HTTP never reach the
// browser.
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
const QUERY_TIMEOUT_MS = 10_000
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
      const resolved = await ctx.credentials.resolve(envName)
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

  const results = await Promise.all(eligible.map(async (provider) => {
    if (provider === 'command-code') {
      const entries = await queryCommandCodeUsage(options)
      // The shared service answered (even with no chip to draw): never ask the
      // billing endpoints behind its back.
      if (entries !== undefined) return entries
    }
    return [await queryProvider(ctx, provider, options)]
  }))

  return {
    intervalSec: DEFAULT_INTERVAL_SEC,
    providers: results.flat().filter((entry) => entry !== undefined),
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
