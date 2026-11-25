// Provider quota bar — a compact row above the composer showing plan usage for
// EVERY configured provider. It renders `GET /provider-quota/state`, served by
// this package's host half, which discovers providers from the LLM registry,
// resolves their keys through the credential seam and normalizes each
// provider's quota endpoint.
//
// Compact face: one chip per provider — mark, remaining share of the most
// binding window, and that window's countdown ("0% 5d 1h"). Hovering a chip
// opens a card with every window: 5-hour, weekly, monthly, used vs remaining,
// absolute and relative reset time, plan tier and fetch time.
//
// Placement: `conversation.input.dock` (the full-width band directly above the
// composer card, shared with the todo and goal docks). Order 5 keeps it above
// the queue dock (20).

window.__ModuleLoader__.load({
  id: '@local/dsh-provider-quota',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'provider-quota'
    const STATE_PATH = '/provider-quota/state'
    const MIN_POLL_MS = 30_000

    const copy = {
      zh: {
        label: '余量',
        loading: '读取中…',
        unavailable: '读取失败',
        noCredential: '未配置密钥',
        reauth: '需要重新登录',
        refresh: '点击刷新供应商余量',
        fiveHour: '5 小时窗口',
        weekly: '每周窗口',
        monthly: '每月窗口',
        other: '其它窗口',
        balance: '余额',
        exhausted: '已用尽',
        remaining: '剩余 {percent}%',
        used: '已用 {percent}%',
        resetAt: '重置 {time}',
        resetIn: '{time} 后重置',
        noReset: '无重置时间',
        idle: '本轮未使用',
        plan: '套餐 {tier}',
        fetched: '更新于 {time}',
        noWindows: '没有可显示的窗口',
      },
      en: {
        label: 'Quota',
        loading: 'Loading…',
        unavailable: 'Unavailable',
        noCredential: 'no API key',
        reauth: 'sign-in required',
        refresh: 'Click to refresh provider quota',
        fiveHour: '5-hour window',
        weekly: 'Weekly window',
        monthly: 'Monthly window',
        other: 'Other window',
        balance: 'Balance',
        exhausted: 'exhausted',
        remaining: '{percent}% left',
        used: '{percent}% used',
        resetAt: 'resets {time}',
        resetIn: 'resets in {time}',
        noReset: 'no reset time',
        idle: 'unused this window',
        plan: 'Plan {tier}',
        fetched: 'fetched {time}',
        noWindows: 'no windows to show',
      },
    }

    const TIER_ORDER = ['five_hour', 'weekly', 'monthly', 'other', 'balance']
    const TIER_KEYS = {
      five_hour: 'fiveHour',
      weekly: 'weekly',
      monthly: 'monthly',
      other: 'other',
      balance: 'balance',
    }

    const rootStyle = {
      position: 'relative',
      display: 'flex',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: '4px 14px',
      flex: '1 1 auto',
      margin: '2px 0 0',
      padding: '0 4px',
      // Align with the composer's own text: the card is centred in this dock
      // and its textarea pads 14px, so the row starts exactly under the
      // placeholder's first character.
      paddingLeft: 'max(0px, calc((100% - var(--dsh-composer-card-max-width, 712px)) / 2 + 8px))',
      paddingRight: 'max(0px, calc((100% - var(--dsh-composer-card-max-width, 712px)) / 2 + 8px))',
      fontSize: '12px',
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-secondary)',
      userSelect: 'none',
    }
    const chipStyle = {
      position: 'relative',
      display: 'inline-flex',
      alignItems: 'center',
      gap: '5px',
      padding: '0 6px',
      borderRadius: '999px',
      color: 'var(--dsw-alias-label-secondary)',
      whiteSpace: 'nowrap',
      cursor: 'default',
    }
    const chipActiveStyle = {
      background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.12))',
    }
    const markStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '16px',
      height: '16px',
      borderRadius: '5px',
      fontSize: '9px',
      fontWeight: 600,
      letterSpacing: '-0.02em',
      color: 'var(--dsw-alias-label-secondary)',
      background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.18))',
      flex: '0 0 auto',
    }
    const figureStyle = {
      fontVariantNumeric: 'tabular-nums',
      fontWeight: 500,
      whiteSpace: 'nowrap',
    }
    const countdownStyle = {
      fontVariantNumeric: 'tabular-nums',
      color: 'var(--dsw-alias-label-tertiary)',
      whiteSpace: 'nowrap',
    }
    const cardStyle = {
      position: 'absolute',
      bottom: 'calc(100% + 6px)',
      left: 0,
      zIndex: 40,
      minWidth: '268px',
      maxWidth: '340px',
      padding: '10px 12px',
      borderRadius: '10px',
      border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.28))',
      background: 'var(--dsw-alias-bg-layer-1, #fff)',
      boxShadow: 'var(--dsw-elevation-soft, 0 8px 24px rgba(0,0,0,0.16))',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '12px',
      lineHeight: '18px',
      cursor: 'default',
    }
    const cardTitleStyle = {
      color: 'var(--dsw-alias-label-primary)',
      fontWeight: 600,
      fontSize: '12.5px',
      margin: '0 0 6px',
    }
    const tierTextStyle = {
      color: 'var(--dsw-alias-label-tertiary)',
      fontSize: '11px',
      whiteSpace: 'nowrap',
    }
    const trackStyle = {
      position: 'relative',
      height: '4px',
      borderRadius: '999px',
      background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.18))',
      overflow: 'hidden',
    }
    const noteStyle = {
      margin: '6px 0 0',
      color: 'var(--dsw-alias-label-tertiary)',
      fontSize: '11px',
    }

    const SEVERITY_COLOR = {
      danger: 'var(--dsw-alias-state-error-primary, #d92d20)',
      warn: 'var(--dsw-alias-state-warning-primary, #d97706)',
      ok: 'var(--dsw-alias-state-success-primary, #12b76a)',
      unknown: 'var(--dsw-alias-label-tertiary, #98a2b3)',
    }

    /** Remaining share (0–100) of one window; the host reports used share. */
    function remainingOf(window) {
      if (Number.isFinite(window.remainingPercent)) return window.remainingPercent
      if (Number.isFinite(window.usedPercent)) return Math.max(0, 100 - window.usedPercent)
      return Number.NaN
    }

    function severityOf(remaining) {
      if (!Number.isFinite(remaining)) return 'unknown'
      if (remaining <= 0) return 'danger'
      if (remaining <= 20) return 'warn'
      return 'ok'
    }

    function formatPercent(value) {
      if (!Number.isFinite(value)) return '—'
      return `${String(Math.round(value))}%`
    }

    function localeTag() {
      return typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'zh-CN'
    }

    /** "5d 1h" · "3h 12m" · "12m" · "now". */
    function formatCountdown(epochMs) {
      if (!Number.isFinite(epochMs)) return ''
      const delta = epochMs - Date.now()
      if (delta <= 0) return '0m'
      const minutes = Math.floor(delta / 60_000)
      const days = Math.floor(minutes / 1440)
      const hours = Math.floor((minutes % 1440) / 60)
      const rest = minutes % 60
      if (days > 0) return hours > 0 ? `${String(days)}d ${String(hours)}h` : `${String(days)}d`
      if (hours > 0) return rest > 0 ? `${String(hours)}h ${String(rest)}m` : `${String(hours)}h`
      return `${String(Math.max(rest, 1))}m`
    }

    function formatAbsolute(epochMs) {
      if (!Number.isFinite(epochMs)) return ''
      const target = new Date(epochMs)
      const sameDay = target.toDateString() === new Date().toDateString()
      const time = new Intl.DateTimeFormat(localeTag(), { hour: '2-digit', minute: '2-digit' }).format(target)
      if (sameDay) return time
      const day = new Intl.DateTimeFormat(localeTag(), { month: 'numeric', day: 'numeric' }).format(target)
      return `${day} ${time}`
    }

    function orderWindows(windows) {
      const known = windows.filter((window) => TIER_ORDER.includes(window.tier))
      known.sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier))
      return [...known, ...windows.filter((window) => !TIER_ORDER.includes(window.tier))]
    }

    /** The binding window: the one with the least headroom, latency excluded. */
    function bindingWindow(windows) {
      let best
      for (const window of windows) {
        const remaining = remainingOf(window)
        if (!Number.isFinite(remaining)) continue
        const score = remaining - (Number.isFinite(window.resetAt) ? 0 : 0.5)
        if (best === undefined || score < best.score) best = { window, remaining, score }
      }
      return best === undefined ? { window: windows[0], remaining: remainingOf(windows[0]) } : best
    }

    function tierLabel(window, t) {
      const key = TIER_KEYS[window.tier]
      return key === undefined ? (window.name ?? t('other')) : t(key)
    }

    /** Two initials for the provider mark: "opencode-go" → "og", "command-code" → "cc". */
    function markOf(provider) {
      const parts = String(provider).split(/[-_.\s]+/).filter(Boolean)
      if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
      return String(provider).slice(0, 2).toUpperCase()
    }

    /** Official site favicons (32px PNG data URLs); unknown routes fall back to initials. */
    const MARK_ICONS = {
      'opencode-go': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABZklEQVR42u1XW27CMBCcjVcEoyAh9R6RuEC5Y8W9kHIVIvzjZPrRmlJwywZIo1ZdyT+2E49nX2N5Wq2ICa3AxDY5AL26QwRy488JAOR9ALoY77qhc+4+AFVVQeQ2DkgihDAcgIggxojlcold08B7D5JmIGlvCAHrusZ+v4eqghl3mBgoy3IU+k1Z0MUIkuj73nxw3/cgaYofWxacUB9CyFKZXOe9h6RvDC5T661EBIfDAeu6Rtu2n3yaYqaqKuyaBovF4oF14Mzatr0IqgRgnEKUCaw0TgGQNAXd7wbgnMPzZoMQAoqiuIh87/1gEIMZUFWoahaAqo7vApLHkZv/1wN/UJBk6nyuL3w1/3AA8/n8jbpMFqS1UQCQRFmWeNluv21Gs9lskHZQw8nHFEsHWMDCoAdNAJzqR3u1Rva7e5yhMKml+3Vdd7Mku9rmr72MksD4UVF6zsCkstypTvswAQn+94IR7RXVbsCdUA1rAwAAAABJRU5ErkJggg==',
      'command-code': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAFX0lEQVR42rWYTUwVVxTHf/PB40nI4/lRW8LGqBVwUXdqgbR+xBiMiQutbgwxSoymLkx4MbIoTdw1JgrCpiXG1IVstOLHwmd1Vb+al5RFFwVCrYYu4L0SWqIi8Gb+XTgznTe8h7bWm9zMzL3/uefMueec/z1j8KqZgOvdfwysBT4F1gMfABWA7c0blG7yri6QB54Bo8A94CHwEzDoreFjgwWXA18Dz73Jd9F/BzpCcoOPWQ78HALOAY73JW8r1LfGXGjs25DlAfjGm5j5n4SW6k5IkeO+8I2e2fNR4aZpyjCMks/R/ob4vKfIz0DCBj7ynCwf3hPDMHDdV35p2zaScBwnmJNU4H1RvOu6wXMEb3kKrAU+MYGmqHf7L6xYsYIzZ86QyWR48OABHR0dLF26FEkYhkEUv2rVKrq6ushkMty/f5/29naqqqrm4T1LmMB7AL+EnCUw28qVKzU0NKRou337tpLJpAzDkGmaAb62tlZPnjyZh79+/boqKytlGEZ4O/Le9SuAP6P7CKizs1OS9PjxYx09elSpVErj4+OSpCNHjgiQbdsBvre3V5I0ODiow4cPq729XRMTE5KklpYWAbIsK+yMAr4DmI06k2VZGhgYkOM4am1tDcbPnj0rx3F06dIlWZYl27ZlWZbi8bgGBwflOI4OHDgQ4Ht6euQ4jnp7ewWELeA7+z07lOH+2SCJ2dlZABYvXhyMj4yMYJomsVgscEgAx3GoqKjANE2Gh4eD8WQyCcDc3FypzFllR1OraZq4rsvNmzdZv349J06coLq6mqdPn7J9+3YA6urqaGtrC5yvrKyMRCIBwMGDB9m4cSPr1q1j9+7dmKZJOp0O1g4rDpRRKpaXLVumdDqtt23d3d2B6YtswXABKUTDKpFIsH//fpqamli0aBG1tbXU19czNjZGJpMpsNrWrVuJx+M8evSIbDZLLpcjnU5z+fLlYFsjYWgAv1IqqxXLeKlUSpLU399fMB6LxTQ6OipJ2rZt25vyg4Df7JK86iUP0zQxDIN8Ph9NJgUWi95blvWKl113XtYMv2ovwO0F6TVsxuiCxTCu65ZU+I0UCAuPx+O4rott28HXxWKxAFteXh4IKysrC+b8UC7GHX4EL+iEq1evJpVKsWnTJsrLy0kkEixZsoQXL16QzWYL8DU1Ndi2zfj4OC9fvmRqaor+/n66urqYmJiIKuE74UjJMFyzZk3R3P5vWzqdVlVVVZQLgjAsqoCfRiVpaGhIra2t2rx5sy5cuCBJevjwoZqbm7Vjxw41Nzdr165dyuVykqSOjg5t2bJFbW1tymazkqRDhw5FucBXYJAQMRTlgnBuP3bsmCTpypUr80LLD8OGhoZgrLOzU47j6Pz586US0YDpUeO8EJyZmQGgpqYmGN+wYQOu6zI1NYVpmliWFXDD5OQkruvS2NgY4KurqwGYnp4udXr+C+CP6HkA0MmTJyVJk5OT6unp0cWLFzU9PS1J2rNnT2ApH3/q1ClJUi6X07lz59TX16fZ2VlJ0s6dO0vRcR/AQLEDSTKZ1LVr116b28PccevWrXn406dPB9giB5IvDaAb+NxTwAqHYUVFBXv37qWxsZGZmRnu3r3L1atX58W1/1xZWcm+fftoaGjg2bNn3Llzhxs3bhTLA3nvGNACsD9UCyzIBQv1UvgS4w7wEtgCUAfkQsflgpctywrM598vpMQb4P2i5wdgkW+SL0KT+XdUlLgh4QI+I1QeGcDFSPEwF7KK+x+643V/rXDRcypUIxTUBMeBH99haXYH2BcWHuZLn5gqPedYAtQDHwLvAwmvghKvb8+BSWDMqztGgCzwffR3wN+s6q2kjf1DegAAAABJRU5ErkJggg==',
      codex: 'data:image/png;base64,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',
      'openai-codex': 'data:image/png;base64,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',
    }

    function ProviderMark({ provider }) {
      const icon = MARK_ICONS[provider]
      if (icon !== undefined) {
        return h('img', {
          src: icon,
          alt: '',
          width: 16,
          height: 16,
          style: { width: '16px', height: '16px', borderRadius: '3px', display: 'block', flex: '0 0 auto' },
        })
      }
      return h('span', { style: markStyle }, markOf(provider))
    }

    function WindowRow({ window, t }) {
      const remaining = remainingOf(window)
      const severity = severityOf(remaining)
      const percent = Number.isFinite(remaining) ? Math.max(0, Math.min(100, remaining)) : 0
      const details = []
      if (Number.isFinite(window.usedPercent)) details.push(t('used', { percent: String(Math.round(window.usedPercent)) }))
      if (Number.isFinite(window.resetAt)) {
        details.push(`${t('resetIn', { time: formatCountdown(window.resetAt) })} · ${formatAbsolute(window.resetAt)}`)
      } else if (!Number.isFinite(window.usedPercent) || window.usedPercent === 0) {
        details.push(t('idle'))
      } else {
        details.push(t('noReset'))
      }
      return h('div', { style: { padding: '3px 0' } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' } },
          h('span', { style: tierTextStyle }, tierLabel(window, t)),
          h('span', { style: { ...figureStyle, color: remaining <= 0 ? SEVERITY_COLOR.danger : undefined } },
            formatPercent(remaining),
            remaining <= 0 ? ` ${t('exhausted')}` : '',
          ),
        ),
        h('div', { style: { ...trackStyle, marginTop: '3px' } },
          h('div', {
            style: {
              position: 'absolute', inset: '0 auto 0 0',
              width: `${String(percent)}%`,
              background: SEVERITY_COLOR[severity],
              borderRadius: '999px',
            },
          }),
        ),
        h('div', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px', marginTop: '2px' } },
          details.join(' · '),
        ),
      )
    }

    function QuotaCard({ entry, t }) {
      const windows = orderWindows(Array.isArray(entry.windows) ? entry.windows : [])
      const name = entry.providerName ?? entry.provider
      const exhausted = windows.some((window) => remainingOf(window) <= 0)
      return h('div', { style: cardStyle, role: 'tooltip' },
        h('div', { style: cardTitleStyle },
          name,
          entry.planTier === undefined ? '' : ` · ${t('plan', { tier: entry.planTier })}`,
          exhausted ? ` · ${t('exhausted')}` : '',
        ),
        windows.length === 0
          ? h('div', { style: noteStyle }, entry.status !== 'error'
            ? t('noWindows')
            : entry.error?.kind === 'no-credential'
              ? t('noCredential')
              : entry.error?.kind === 'auth' ? t('reauth') : t('unavailable'))
          : windows.map((window, index) => h(WindowRow, {
            key: `${String(window.tier)}-${String(index)}`,
            window,
            t,
          })),
        Number.isFinite(entry.fetchedAt)
          ? h('div', { style: noteStyle }, t('fetched', { time: formatAbsolute(entry.fetchedAt) }))
          : null,
      )
    }

    function ProviderChip({ entry, t, open, onOpen, onClose }) {
      const windows = orderWindows(Array.isArray(entry.windows) ? entry.windows : [])
      const binding = windows.length > 0 ? bindingWindow(windows) : undefined
      const remaining = binding === undefined ? Number.NaN : binding.remaining
      const severity = severityOf(remaining)
      const hasData = binding !== undefined
      const countdown = hasData && Number.isFinite(binding.window?.resetAt)
        ? formatCountdown(binding.window.resetAt)
        : ''
      const failed = entry.status === 'error' || !hasData
      return h('span', {
        style: open ? { ...chipStyle, ...chipActiveStyle } : chipStyle,
        onMouseEnter: onOpen,
        onMouseLeave: onClose,
        onFocus: onOpen,
        onBlur: onClose,
        tabIndex: 0,
        role: 'button',
        title: entry.providerName ?? entry.provider,
        'aria-label': entry.providerName ?? entry.provider,
      },
      h(ProviderMark, { provider: entry.provider }),
      failed
        ? h('span', { style: { color: SEVERITY_COLOR.danger } },
          entry.status !== 'error'
            ? t('unavailable')
            : entry.error?.kind === 'no-credential'
              ? t('noCredential')
              : entry.error?.kind === 'auth' ? t('reauth') : t('unavailable'))
        : h('span', { style: { ...figureStyle, color: remaining <= 0 ? SEVERITY_COLOR.danger : undefined } },
          formatPercent(remaining)),
      hasData && countdown !== '' ? h('span', { style: countdownStyle }, countdown) : null,
      open ? h(QuotaCard, { entry, t }) : null,
      )
    }

    async function readState(refresh, signal) {
      const query = refresh ? '?refresh=1' : ''
      const response = await fetch(`${STATE_PATH}${query}`, {
        headers: { accept: 'application/json' },
        signal,
      })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      const value = await response.json()
      if (value === null || typeof value !== 'object' || !Array.isArray(value.providers)) {
        throw new Error('unexpected quota payload')
      }
      return value
    }

    function QuotaBar({ t }) {
      const [view, setView] = React.useState({ phase: 'loading', providers: [], intervalSec: 60 })
      const [nonce, setNonce] = React.useState(0)
      const [openProvider, setOpenProvider] = React.useState(null)
      const loadRef = React.useRef(null)
      const aliveRef = React.useRef(true)

      React.useEffect(() => {
        aliveRef.current = true
        const controller = new AbortController()
        const load = async (refresh) => {
          try {
            const value = await readState(refresh, controller.signal)
            if (!aliveRef.current) return
            setView({
              phase: value.providers.length === 0 ? 'empty' : 'ready',
              providers: value.providers,
              intervalSec: Number(value.intervalSec) > 0 ? Number(value.intervalSec) : 60,
            })
          } catch {
            if (!aliveRef.current) return
            setView((current) => (
              current.phase === 'ready' ? current : { phase: 'error', providers: [], intervalSec: 60 }
            ))
          }
        }
        loadRef.current = load
        void load(false)
        return () => {
          aliveRef.current = false
          controller.abort()
        }
      }, [nonce])

      React.useEffect(() => {
        if (view.phase === 'empty') return undefined
        const ms = Math.max(MIN_POLL_MS, view.intervalSec * 1000)
        const timer = setInterval(() => { void loadRef.current?.(false) }, ms)
        return () => { clearInterval(timer) }
      }, [view.phase, view.intervalSec])

      // Close the hover card when the pointer leaves the whole row.
      const onRowLeave = () => { setOpenProvider(null) }

      if (view.phase === 'empty') return null
      const refresh = () => { setNonce((value) => value + 1) }
      if (view.phase === 'loading') {
        return h('div', { style: rootStyle, 'aria-label': t('label') },
          h('span', null, t('loading')),
        )
      }
      if (view.phase === 'error') {
        return h('div', {
          style: { ...rootStyle, cursor: 'pointer' },
          title: t('refresh'),
          onClick: refresh,
          role: 'status',
          'aria-label': t('label'),
        },
        h('span', null, t('unavailable')),
        )
      }
      return h('div', {
        style: rootStyle,
        role: 'status',
        title: t('refresh'),
        'aria-label': t('label'),
        onMouseLeave: onRowLeave,
        onClick: refresh,
      },
      view.providers.map((entry) => h(ProviderChip, {
        key: entry.provider,
        entry,
        t,
        open: openProvider === entry.provider,
        onOpen: () => { setOpenProvider(entry.provider) },
        onClose: () => { setOpenProvider((current) => (current === entry.provider ? null : current)) },
      })),
      )
    }

    return {
      name: 'provider-quota',
      inject: ['slots', 'locale'],
      apply(ctx) {
        if (ctx.locale?.register !== undefined) {
          ctx.effect(() => ctx.locale.register(NS, copy), 'provider-quota: dictionaries')
        }
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'provider-quota',
          order: 5,
          locale: NS,
        }, (props) => h(QuotaBar, { ...props, t: props.t ?? t })))
      },
    }
  },
})
