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
// Placement: `conversation.input.dock` (the strip directly above the composer
// card, shared with the todo and goal strips). Order 5 keeps it above the queue
// dock (20). The strip is drawn as the same card the goal strip uses — 12px
// radius, elevation panel stroke + shadow, menu surface on a backdrop-blurred
// layer, 16px inside the composer card — because this band floats over the
// thread and message text keeps scrolling underneath it.

window.__ModuleLoader__.load({
  id: '@local/dsh-provider-quota',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'provider-quota'
    const STATE_PATH = '/provider-quota/state'
    const MIN_POLL_MS = 30_000
    const PROVIDER_VISIBILITY_KEY = 'dsh-provider-quota:provider-visibility'
    const LEGACY_LOCAL_VISIBILITY_KEY = 'dsh-provider-quota:local-provider-visibility'

    const copy = {
      zh: {
        label: '余量',
        loading: '读取中…',
        unavailable: '读取失败',
        noCredential: '未配置密钥',
        reauth: '需要重新登录',
        unsupported: '该账号不可用',
        unsupportedNote: '这个账号没有可查额度的许可（个人账号的 Gemini CLI 额度已停止提供）',
        refresh: '点击刷新供应商余量',
        fiveHour: '5 小时窗口',
        weekly: '每周窗口',
        monthly: '每月窗口',
        geminiFiveHour: 'Gemini 5 小时',
        geminiWeekly: 'Gemini 每周',
        thirdPartyFiveHour: 'Claude/GPT 5 小时',
        thirdPartyWeekly: 'Claude/GPT 每周',
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
        providerDisplay: '显示设置',
        providerQuotaTitle: '供应商余量显示',
        providerQuotaHint: '仅控制余量条显示，不影响检测和刷新',
        manageProviderDisplay: '管理供应商余量显示',
        showProviderQuota: '显示 {provider} 余量',
      },
      en: {
        label: 'Quota',
        loading: 'Loading…',
        unavailable: 'Unavailable',
        noCredential: 'no API key',
        reauth: 'sign-in required',
        unsupported: 'account not eligible',
        unsupportedNote: 'This account has no quota-eligible license (Gemini CLI quota for individual accounts was retired).',
        refresh: 'Click to refresh provider quota',
        fiveHour: '5-hour window',
        weekly: 'Weekly window',
        monthly: 'Monthly window',
        geminiFiveHour: 'Gemini 5-hour',
        geminiWeekly: 'Gemini weekly',
        thirdPartyFiveHour: 'Claude/GPT 5-hour',
        thirdPartyWeekly: 'Claude/GPT weekly',
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
        providerDisplay: 'Display settings',
        providerQuotaTitle: 'Provider quota display',
        providerQuotaHint: 'Controls display only; detection and refresh are unchanged.',
        manageProviderDisplay: 'Manage provider quota display',
        showProviderQuota: 'Show {provider} quota',
      },
    }

    const TIER_ORDER = [
      'five_hour',
      'weekly',
      'monthly',
      // Antigravity reports two pools, each with a 5-hour and a weekly window.
      'gemini_five_hour',
      'gemini_weekly',
      'third_party_five_hour',
      'third_party_weekly',
      'other',
      'balance',
    ]
    const TIER_KEYS = {
      five_hour: 'fiveHour',
      weekly: 'weekly',
      monthly: 'monthly',
      gemini_five_hour: 'geminiFiveHour',
      gemini_weekly: 'geminiWeekly',
      third_party_five_hour: 'thirdPartyFiveHour',
      third_party_weekly: 'thirdPartyWeekly',
      other: 'other',
      balance: 'balance',
    }

    // Geometry of a dock strip, taken from the shipped goal strip: the outer
    // element reserves the composer's side clearance plus the dock inset, the
    // inner card caps at the composer card width minus four insets and centres
    // itself, so every strip in this dock lines up 16px inside the composer
    // card.
    const dockStyle = {
      boxSizing: 'border-box',
      width: 'calc(100% - 2 * var(--dsh-composer-side-clearance, 16px) - 4 * var(--dsh-composer-dock-inset, 8px))',
      margin: '0 auto',
    }
    // Card of a dock strip, copied 1:1 from the goal strip of the running app
    // (`@deepseek-ai/dsh-client-ui-goal` · `.Gc24Bq_bar`): 12px radius token, no
    // border — the half-pixel stroke comes from `--dsw-elevation-panel`, which
    // reads `--dsw-elevation-stroke-color` — plus that same panel shadow, 36px
    // tall, and the menu surface (`rgba(252,253,254,.7)` + 40px backdrop blur)
    // painted on a layer under the content. Two notes:
    // · minHeight instead of height, so a narrow pane that wraps the chips
    //   grows the card instead of clipping it;
    // · the fill is not decoration — this strip floats over the thread, so
    //   without it message text scrolls visibly between the chips.
    const fillStyle = {
      position: 'absolute',
      inset: 0,
      zIndex: 0,
      borderRadius: 'inherit',
      background: 'var(--dsw-specific-menu, var(--dsw-menu-surface-fill, #fff))',
      backdropFilter: 'var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%))',
      pointerEvents: 'none',
    }
    const rootStyle = {
      isolation: 'isolate',
      boxSizing: 'border-box',
      position: 'relative',
      display: 'flex',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: '4px 14px',
      width: '100%',
      maxWidth: 'calc(var(--dsh-composer-card-max-width, 712px) - 4 * var(--dsh-composer-dock-inset, 8px))',
      minHeight: '36px',
      margin: '0 auto',
      // Chips carry their own 6px side padding, so this puts the first mark
      // 12px from the card edge — the goal strip's own left inset.
      padding: '4px 6px',
      border: 0,
      borderRadius: 'var(--dsw-radius-md, 12px)',
      '--dsw-elevation-stroke-color': 'var(--dsw-alias-border-l1)',
      boxShadow: 'var(--dsw-elevation-panel, 0 0 0 0.5px var(--dsw-alias-border-l1))',
      fontSize: '12px',
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-secondary)',
      userSelect: 'none',
    }
    const chipStyle = {
      position: 'relative',
      // Above the card's own fill layer.
      zIndex: 1,
      display: 'inline-flex',
      alignItems: 'center',
      gap: '5px',
      padding: '0 6px',
      borderRadius: '999px',
      color: 'var(--dsw-alias-label-secondary)',
      whiteSpace: 'nowrap',
      cursor: 'default',
    }
    // Open (hover/focus) cue: no fill on the chip — an SVG arch with a curved
    // upper edge and a straight baseline. It sits below the provider figures,
    // and stays mounted while closed so opacity/position can fade both ways.
    const chipHoverStyle = {
      color: 'var(--dsw-alias-label-primary)',
    }
    const chipArcStyle = {
      position: 'absolute',
      left: '4px',
      // The SVG's flat baseline aligns with the strip card's lower edge;
      // closed rests below it, then rises into place on hover/focus.
      bottom: '-10px',
      width: 'calc(100% - 8px)',
      height: '7px',
      overflow: 'visible',
      opacity: 0,
      transform: 'translateY(4px)',
      transition: 'opacity 180ms ease-out, transform 180ms ease-out',
      pointerEvents: 'none',
    }
    const chipArcVisibleStyle = {
      opacity: 1,
      transform: 'translateY(0)',
    }
    const chipArcPath = 'M 0 4 Q 50 -1 100 4 L 100 6 L 0 6 Z'
    const chipArcFill = 'var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06))'
    // Every provider mark occupies the same 16px layout box. The Codex favicon
    // has more internal padding than the adjacent square favicons, so optically
    // enlarge its artwork while keeping the box (and text alignment) unchanged.
    const MARK_SIZE = 16
    const MARK_ICON_SCALE = { codex: 4 / 3, 'openai-codex': 4 / 3 }
    const markStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: `${MARK_SIZE}px`,
      height: `${MARK_SIZE}px`,
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
    const providerSettingsPanelStyle = {
      position: 'absolute',
      right: 0,
      bottom: '100%',
      zIndex: 41,
      boxSizing: 'border-box',
      width: '256px',
      maxWidth: 'calc(100vw - 48px)',
      maxHeight: 'min(70vh, 480px)',
      overflowY: 'auto',
      padding: '12px',
      borderRadius: '10px',
      border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.28))',
      background: 'var(--dsw-alias-bg-layer-1, #fff)',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '12px',
      lineHeight: '18px',
      cursor: 'default',
      userSelect: 'text',
    }
    const providerSettingsButtonStyle = {
      position: 'relative',
      zIndex: 1,
      display: 'inline-flex',
      alignItems: 'center',
      gap: '5px',
      marginLeft: 'auto',
      padding: '4px 7px',
      border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.28))',
      borderRadius: '999px',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      font: 'inherit',
      lineHeight: '16px',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }
    const refreshButtonStyle = {
      position: 'relative',
      zIndex: 1,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: '0 0 auto',
      width: '28px',
      height: '28px',
      padding: 0,
      border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.28))',
      borderRadius: '999px',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      cursor: 'pointer',
    }
    const providerSettingsHintStyle = {
      margin: '0 0 8px',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '11px',
      lineHeight: '15px',
    }
    const providerSettingRowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      minHeight: '30px',
    }
    const providerSettingNameStyle = {
      flex: '1 1 auto',
      minWidth: 0,
      overflowWrap: 'anywhere',
      color: 'var(--dsw-alias-label-primary)',
    }
    const providerSwitchButtonStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: '0 0 auto',
      width: '44px',
      height: '28px',
      padding: 0,
      border: 0,
      borderRadius: '999px',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
    }
    const providerSwitchTrackStyle = (enabled) => ({
      display: 'inline-flex',
      alignItems: 'center',
      width: '34px',
      height: '20px',
      boxSizing: 'border-box',
      padding: '2px',
      border: enabled ? 0 : '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.55))',
      borderRadius: '999px',
      background: enabled
        ? 'var(--dsw-alias-brand-primary, #3d72f6)'
        : 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.28))',
      transition: 'background-color 150ms ease-out',
    })
    const providerSwitchThumbStyle = (enabled) => ({
      display: 'block',
      width: '16px',
      height: '16px',
      borderRadius: '50%',
      background: 'var(--dsw-alias-bg-layer-1, #fff)',
      transform: enabled ? 'translateX(14px)' : 'translateX(0)',
      transition: 'transform 150ms ease-out',
    })
    const loadingBodyStyle = {
      position: 'relative',
      zIndex: 1,
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      width: '100%',
      padding: '2px 6px',
    }
    const loadingSpinnerStyle = {
      display: 'block',
      flex: '0 0 auto',
      width: '18px',
      height: '18px',
    }
    const loadingLabelStyle = {
      color: 'var(--dsw-alias-label-primary)',
      fontSize: '13px',
      fontWeight: 500,
      lineHeight: '18px',
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
      // --dsw-alias-bg-layer-2 is #fff in the light theme, i.e. invisible on the
      // card; a surface tint keeps the groove visible in both themes.
      background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.18))',
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

    /** One localized phrase for a provider that has no window to show. */
    function failureLabel(entry, t) {
      if (entry.status !== 'error') return t('unavailable')
      const kind = entry.error?.kind
      if (kind === 'no-credential') return t('noCredential')
      if (kind === 'auth') return t('reauth')
      if (kind === 'unsupported') return t('unsupported')
      return t('unavailable')
    }

    function tierLabel(window, t) {
      // A host-supplied name wins: Claude's per-model weeks and Gemini's model
      // groups share tier `other`, and "其它窗口" would hide which one it is.
      if (typeof window.name === 'string' && window.name !== '') return window.name
      const key = TIER_KEYS[window.tier]
      return key === undefined ? t('other') : t(key)
    }

    /** Two initials for the provider mark: "opencode-go" → "og", "command-code" → "cc". */
    function markOf(provider) {
      const parts = String(provider).split(/[-_.\s]+/).filter(Boolean)
      if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
      return String(provider).slice(0, 2).toUpperCase()
    }

    /** Registry ids that share a vendor mark ("anthropic" → the Claude star). */
    const MARK_ALIASES = {
      anthropic: 'claude',
      'claude-code': 'claude',
      'gemini-cli': 'gemini',
      'google-gemini': 'gemini',
    }

    /** Official site favicons (32px PNG data URLs); unknown routes fall back to initials. */
    const MARK_ICONS = {
      antigravity: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAFIklEQVR42u1WXWgcVRT+zr0zsz/dbHaTNDa1SFUsatRaW7UKZiP4U6ioCLOi4kNffKj4A4LWik4GbZuiKD5oUV+q4IO7INhHCyXRF2upIpISKVKr2Na0+d/szty59x4fEkU0P9v4++B5Gph7vvnOd75z5gL/x78ctNxEZgj0lQQAVI91crlaNf8IY+aFSfMyClq2AuPvr7sXp8Wd4rQn0qOZQ6n9hz/4W1swVzmdOroxPTESv1OcEQ9mRxy4ZzzInxyocTqgpuOH22/8vIYQTAA3gyuaJdDXByKCHapl+qKWjgdPqII9nhTMSc7pMyJtV2Szdzup7CsUwv7lCgQBRBjCvvfZ1vUUySM840o5Jik7ISk/BhTGErRNKpOvJZKULrUdOPgJA4KwNJmmFOju9gkARk3+sbNel3tCXcDf8Rr6jtbgB7kap9xVOON1IM62oy4yj//CuhlTOktXH4hyOTT9nz580UjcsiXSBdSSLAmTRYY9TAiLGTeC8qYIusYFz731xF0PXE5hOFzxfYklxnNJAse6uwkAfoo7b0684oUj4yuMUkXJSQ6eTWGaGLEbIUlNiURP6FS+2FaXYyUAw82ouySBqu9bABjTbVti08kTjRySuB02ycExacQEJFJBezUkPEFuMsVZm94K4K1mlhM18Z4fORBkR8yq43W1anV9usBaFcmqHIT2kNaElkSjqOtYqaa4S09Re3RustWOXXrfG4+NMpgIxMszYRAQAJyM194wHXV2zdTaEasOSlQRWrfaxLSYhs2badFqx90OnE2toh/TXRhpWdv6Y25dDwD0BYsXuSiBUm+vAIB6o/322KwhFbcbq4qwSc6A84LcgkQ6LxOnVcxQ1ky4BYymVurx/CU4m+m6bRZlQCy3BQRmlAYGZP1b96CQa3qTSVezykjhFslGyTiBhmGJpcBl2bRc6UQxr0BiO1OuTMXnjnRESU8YXhwBTFigDQuy8ysVASKeHM6sU6p4TTLtsTVZCKdINtLvSuv2RJHTSydlr2NlTxzbfdpLUUN6GDXMU27+6lO54tWzWAt/Z8EpGBkaIoApSb65yU1f0GZmjJJuwbNRsv/LZ71tvzs+DGD75n6jRNp7oqa08lak0/FMowfAkSuHcP4mHAxDAxCzTfu24TBR3jP15LiA+yTA5FdYgpl++3y6IXZEEb7QjuNNxeA6uWVmpjAke34EgkAAjMteO3UFmcytiMFE0hCJ547uoEm/AlEtkwERA8TVMhm/CnEypMgCOxJANTRYQWza8nKyGWBCwKJpAn53HwHEnsajUhY86eSEjc3HKpIf+RWW1fIffzLVMmwpYOfwURxSkf1QOxBaCqFYbgeI/e75DS/+aD6W1TKZK1493S1E/n5hHMuxrjmCnzkWkqoOged3NPEgYFElAyN2qgjnYg02Evfc0s83VMtkfJ/lkgSqZTIAIHW636Fsh4AQBNp5dEfqa7/CEov0EyHZIGDx+fN0wgBPaYA0iRYD+7IfsFetkpkdyXn3AFMQgAYwIEazG3Y5Xv5pyQQd6de/2uk+iYAFwoWq/11UWKJMZuNLHMoMXpAE6IZ9O6u+f6IXa1U4H45fmZXnqr3TD12/j/nafq3X70l2+35FLmSgxdf4bM51u3jnpj0c3fwm86bdvA0A5mvFrwnX7q2XNuxN9q9/MbnjF2WWfYWew9ywh3s29vMb173Em+cumE1izs35n7rHL6EezZdQAsQgYBc13HmSKAFisA9zu+P/+A/Fz9treVn5kM8lAAAAAElFTkSuQmCC',
      claude: 'data:image/png;base64,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',
      gemini: 'data:image/png;base64,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',
      'opencode-go': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABZklEQVR42u1XW27CMBCcjVcEoyAh9R6RuEC5Y8W9kHIVIvzjZPrRmlJwywZIo1ZdyT+2E49nX2N5Wq2ICa3AxDY5AL26QwRy488JAOR9ALoY77qhc+4+AFVVQeQ2DkgihDAcgIggxojlcold08B7D5JmIGlvCAHrusZ+v4eqghl3mBgoy3IU+k1Z0MUIkuj73nxw3/cgaYofWxacUB9CyFKZXOe9h6RvDC5T661EBIfDAeu6Rtu2n3yaYqaqKuyaBovF4oF14Mzatr0IqgRgnEKUCaw0TgGQNAXd7wbgnMPzZoMQAoqiuIh87/1gEIMZUFWoahaAqo7vApLHkZv/1wN/UJBk6nyuL3w1/3AA8/n8jbpMFqS1UQCQRFmWeNluv21Gs9lskHZQw8nHFEsHWMDCoAdNAJzqR3u1Rva7e5yhMKml+3Vdd7Mku9rmr72MksD4UVF6zsCkstypTvswAQn+94IR7RXVbsCdUA1rAwAAAABJRU5ErkJggg==',
      'command-code': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAFX0lEQVR42rWYTUwVVxTHf/PB40nI4/lRW8LGqBVwUXdqgbR+xBiMiQutbgwxSoymLkx4MbIoTdw1JgrCpiXG1IVstOLHwmd1Vb+al5RFFwVCrYYu4L0SWqIi8Gb+XTgznTe8h7bWm9zMzL3/uefMueec/z1j8KqZgOvdfwysBT4F1gMfABWA7c0blG7yri6QB54Bo8A94CHwEzDoreFjgwWXA18Dz73Jd9F/BzpCcoOPWQ78HALOAY73JW8r1LfGXGjs25DlAfjGm5j5n4SW6k5IkeO+8I2e2fNR4aZpyjCMks/R/ob4vKfIz0DCBj7ynCwf3hPDMHDdV35p2zaScBwnmJNU4H1RvOu6wXMEb3kKrAU+MYGmqHf7L6xYsYIzZ86QyWR48OABHR0dLF26FEkYhkEUv2rVKrq6ushkMty/f5/29naqqqrm4T1LmMB7AL+EnCUw28qVKzU0NKRou337tpLJpAzDkGmaAb62tlZPnjyZh79+/boqKytlGEZ4O/Le9SuAP6P7CKizs1OS9PjxYx09elSpVErj4+OSpCNHjgiQbdsBvre3V5I0ODiow4cPq729XRMTE5KklpYWAbIsK+yMAr4DmI06k2VZGhgYkOM4am1tDcbPnj0rx3F06dIlWZYl27ZlWZbi8bgGBwflOI4OHDgQ4Ht6euQ4jnp7ewWELeA7+z07lOH+2SCJ2dlZABYvXhyMj4yMYJomsVgscEgAx3GoqKjANE2Gh4eD8WQyCcDc3FypzFllR1OraZq4rsvNmzdZv349J06coLq6mqdPn7J9+3YA6urqaGtrC5yvrKyMRCIBwMGDB9m4cSPr1q1j9+7dmKZJOp0O1g4rDpRRKpaXLVumdDqtt23d3d2B6YtswXABKUTDKpFIsH//fpqamli0aBG1tbXU19czNjZGJpMpsNrWrVuJx+M8evSIbDZLLpcjnU5z+fLlYFsjYWgAv1IqqxXLeKlUSpLU399fMB6LxTQ6OipJ2rZt25vyg4Df7JK86iUP0zQxDIN8Ph9NJgUWi95blvWKl113XtYMv2ovwO0F6TVsxuiCxTCu65ZU+I0UCAuPx+O4rott28HXxWKxAFteXh4IKysrC+b8UC7GHX4EL+iEq1evJpVKsWnTJsrLy0kkEixZsoQXL16QzWYL8DU1Ndi2zfj4OC9fvmRqaor+/n66urqYmJiIKuE74UjJMFyzZk3R3P5vWzqdVlVVVZQLgjAsqoCfRiVpaGhIra2t2rx5sy5cuCBJevjwoZqbm7Vjxw41Nzdr165dyuVykqSOjg5t2bJFbW1tymazkqRDhw5FucBXYJAQMRTlgnBuP3bsmCTpypUr80LLD8OGhoZgrLOzU47j6Pz586US0YDpUeO8EJyZmQGgpqYmGN+wYQOu6zI1NYVpmliWFXDD5OQkruvS2NgY4KurqwGYnp4udXr+C+CP6HkA0MmTJyVJk5OT6unp0cWLFzU9PS1J2rNnT2ApH3/q1ClJUi6X07lz59TX16fZ2VlJ0s6dO0vRcR/AQLEDSTKZ1LVr116b28PccevWrXn406dPB9giB5IvDaAb+NxTwAqHYUVFBXv37qWxsZGZmRnu3r3L1atX58W1/1xZWcm+fftoaGjg2bNn3Llzhxs3bhTLA3nvGNACsD9UCyzIBQv1UvgS4w7wEtgCUAfkQsflgpctywrM598vpMQb4P2i5wdgkW+SL0KT+XdUlLgh4QI+I1QeGcDFSPEwF7KK+x+643V/rXDRcypUIxTUBMeBH99haXYH2BcWHuZLn5gqPedYAtQDHwLvAwmvghKvb8+BSWDMqztGgCzwffR3wN+s6q2kjf1DegAAAABJRU5ErkJggg==',
      codex: 'data:image/png;base64,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',
      'openai-codex': 'data:image/png;base64,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',
    }

    function ProviderMark({ provider }) {
      const icon = MARK_ICONS[provider] ?? MARK_ICONS[MARK_ALIASES[provider]]
      if (icon !== undefined) {
        const scale = MARK_ICON_SCALE[provider] ?? 1
        return h('img', {
          src: icon,
          alt: '',
          width: MARK_SIZE,
          height: MARK_SIZE,
          style: {
            width: `${MARK_SIZE}px`,
            height: `${MARK_SIZE}px`,
            objectFit: 'contain',
            transform: scale === 1 ? undefined : `scale(${scale})`,
            transformOrigin: 'center',
            borderRadius: '3px',
            display: 'block',
            flex: '0 0 auto',
          },
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
          ? h('div', { style: noteStyle },
            entry.status === 'error' ? failureLabel(entry, t) : t('noWindows'),
            entry.status === 'error' && entry.error?.kind === 'unsupported'
              ? ` · ${t('unsupportedNote')}`
              : '',
          )
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
        style: open ? { ...chipStyle, ...chipHoverStyle } : chipStyle,
        onMouseEnter: onOpen,
        onMouseLeave: onClose,
        onFocus: onOpen,
        onBlur: onClose,
        tabIndex: 0,
        role: 'group',
        title: entry.providerName ?? entry.provider,
        'aria-label': entry.providerName ?? entry.provider,
      },
      h('svg', {
        key: 'arc',
        style: open ? { ...chipArcStyle, ...chipArcVisibleStyle } : chipArcStyle,
        viewBox: '0 0 100 7',
        preserveAspectRatio: 'none',
        'aria-hidden': true,
        focusable: false,
      },
      h('path', { d: chipArcPath, fill: chipArcFill }),
      ),
      h(ProviderMark, { provider: entry.provider }),
      failed
        ? h('span', { style: { color: SEVERITY_COLOR.danger } }, failureLabel(entry, t))
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

    function readVisibilityValue(raw) {
      try {
        const saved = JSON.parse(raw)
        if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) return null
        const entries = Object.entries(saved)
        if (entries.some(([provider, enabled]) => provider === '' || typeof enabled !== 'boolean')) return null
        return Object.fromEntries(entries)
      } catch {
        return null
      }
    }

    function readProviderVisibility() {
      try {
        const currentRaw = window.localStorage.getItem(PROVIDER_VISIBILITY_KEY)
        if (currentRaw !== null) {
          const current = readVisibilityValue(currentRaw)
          if (current !== null) return current
        }
        const legacyRaw = window.localStorage.getItem(LEGACY_LOCAL_VISIBILITY_KEY)
        return legacyRaw === null ? {} : (readVisibilityValue(legacyRaw) ?? {})
      } catch {
        // Storage can be disabled by browser policy; use the default display.
        return {}
      }
    }

    function persistProviderVisibility(value) {
      try {
        window.localStorage.setItem(PROVIDER_VISIBILITY_KEY, JSON.stringify(value))
      } catch {
        // Keep the in-memory toggle usable when storage is unavailable.
      }
    }

    function ProviderVisibilitySettings({ providers, visibility, t, onToggle }) {
      return h('div', {
        style: providerSettingsPanelStyle,
        role: 'dialog',
        'aria-label': t('providerQuotaTitle'),
        onClick: (event) => event.stopPropagation(),
      },
      h('div', { style: cardTitleStyle }, t('providerQuotaTitle')),
      h('div', { style: providerSettingsHintStyle }, t('providerQuotaHint')),
      providers.map((entry) => {
        const provider = entry.provider
        const enabled = visibility[provider] !== false
        const name = entry.providerName ?? provider
        return h('div', { key: provider, style: providerSettingRowStyle },
          h(ProviderMark, { provider }),
          h('span', { style: providerSettingNameStyle }, name),
          h('button', {
            type: 'button',
            role: 'switch',
            'aria-checked': enabled,
            'aria-label': t('showProviderQuota', { provider: name }),
            style: providerSwitchButtonStyle,
            onClick: (event) => {
              event.stopPropagation()
              onToggle(provider)
            },
          },
          h('span', { style: providerSwitchTrackStyle(enabled) },
            h('span', { style: providerSwitchThumbStyle(enabled) }),
          ),
          ),
        )
      }),
      )
    }

    function QuotaBar({ t }) {
      const [view, setView] = React.useState({ phase: 'loading', providers: [], intervalSec: 60 })
      const [providerVisibility, setProviderVisibility] = React.useState(readProviderVisibility)
      const [providerSettingsOpen, setProviderSettingsOpen] = React.useState(false)
      const [nonce, setNonce] = React.useState(0)
      const [refreshing, setRefreshing] = React.useState(false)
      const [openProvider, setOpenProvider] = React.useState(null)
      const refreshRequestRef = React.useRef(false)
      const loadRef = React.useRef(null)
      const aliveRef = React.useRef(true)

      React.useEffect(() => {
        persistProviderVisibility(providerVisibility)
      }, [providerVisibility])

      React.useEffect(() => {
        aliveRef.current = true
        const controller = new AbortController()
        const load = async (refresh) => {
          try {
            const value = await readState(refresh, controller.signal)
            if (!aliveRef.current) return
            setRefreshing(false)
            setView({
              phase: value.providers.length === 0 ? 'empty' : 'ready',
              providers: value.providers,
              intervalSec: Number(value.intervalSec) > 0 ? Number(value.intervalSec) : 60,
            })
          } catch {
            if (!aliveRef.current) return
            setRefreshing(false)
            setView((current) => (
              current.phase === 'ready' || current.phase === 'empty'
                ? current
                : { phase: 'error', providers: [], intervalSec: 60 }
            ))
          }
        }
        loadRef.current = load
        const forceRefresh = refreshRequestRef.current
        refreshRequestRef.current = false
        void load(forceRefresh)
        return () => {
          aliveRef.current = false
          controller.abort()
        }
      }, [nonce])

      React.useEffect(() => {
        // Keep polling while the row is hidden so newly available providers show up.
        const ms = Math.max(MIN_POLL_MS, view.intervalSec * 1000)
        const timer = setInterval(() => { void loadRef.current?.(false) }, ms)
        return () => { clearInterval(timer) }
      }, [view.phase, view.intervalSec])

      // Close popovers when the pointer leaves the whole quota strip.
      const onRowLeave = () => {
        setOpenProvider(null)
        setProviderSettingsOpen(false)
      }
      const toggleProviderVisibility = (provider) => {
        setProviderVisibility((current) => ({
          ...current,
          [provider]: current[provider] === false,
        }))
        setOpenProvider(null)
      }

      if (view.phase === 'empty') return null
      const refresh = () => {
        refreshRequestRef.current = true
        setRefreshing(true)
        setNonce((value) => value + 1)
      }
      if (view.phase === 'loading' || refreshing) {
        return h('div', { style: dockStyle },
          h('div', {
            style: rootStyle,
            role: 'status',
            'aria-label': t('loading'),
            'aria-live': 'polite',
          },
          h('div', { style: fillStyle, 'aria-hidden': true }),
          h('div', { style: loadingBodyStyle },
            h('svg', { style: loadingSpinnerStyle, viewBox: '0 0 24 24', 'aria-hidden': true, focusable: false },
              h('g', null,
                h('circle', {
                  cx: 12, cy: 12, r: 9,
                  fill: 'none',
                  stroke: 'var(--dsw-alias-interactive-bg-active, rgba(127,127,127,0.2))',
                  strokeWidth: 3,
                }),
                h('path', {
                  d: 'M12 3a9 9 0 0 1 9 9',
                  fill: 'none',
                  stroke: 'var(--dsw-alias-brand-primary, #3d72f6)',
                  strokeWidth: 3,
                  strokeLinecap: 'round',
                }),
                h('animateTransform', {
                  attributeName: 'transform',
                  type: 'rotate',
                  from: '0 12 12',
                  to: '360 12 12',
                  dur: '800ms',
                  repeatCount: 'indefinite',
                }),
              ),
            ),
            h('div', { style: loadingLabelStyle }, t('loading')),
          ),
          ),
        )
      }
      if (view.phase === 'error') {
        return h('div', { style: dockStyle },
          h('div', {
            style: { ...rootStyle, cursor: 'pointer' },
            title: t('refresh'),
            onClick: refresh,
            role: 'status',
            'aria-label': t('label'),
          },
          h('div', { style: fillStyle, 'aria-hidden': true }),
          h('span', null, t('unavailable')),
          ),
        )
      }
      const providersToDisplay = view.providers.filter((entry) => (
        providerVisibility[entry.provider] !== false
      ))

      return h('div', { style: dockStyle },
        h('div', {
          style: rootStyle,
          role: 'group',
          title: t('refresh'),
          'aria-label': t('label'),
          onMouseLeave: onRowLeave,
          onClick: refresh,
        },
        h('div', { style: fillStyle, 'aria-hidden': true }),
        h('button', {
          type: 'button',
          style: refreshButtonStyle,
          title: t('refresh'),
          'aria-label': t('refresh'),
          onClick: (event) => {
            event.stopPropagation()
            refresh()
          },
        },
        h('svg', {
          width: 14,
          height: 14,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': true,
          focusable: false,
        },
        h('path', {
          d: 'M13.5 5.4A5.5 5.5 0 1 0 14 8',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M13.1 2.8v3.1H10',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        ),
        ),
        providersToDisplay.map((entry) => h(ProviderChip, {
          key: entry.provider,
          entry,
          t,
          open: openProvider === entry.provider,
          onOpen: () => { setOpenProvider(entry.provider) },
          onClose: () => { setOpenProvider((current) => (current === entry.provider ? null : current)) },
        })),
        view.providers.length > 0
          ? h('button', {
            type: 'button',
            style: providerSettingsButtonStyle,
            title: t('manageProviderDisplay'),
            'aria-label': t('manageProviderDisplay'),
            'aria-expanded': providerSettingsOpen,
            'aria-haspopup': 'dialog',
            onClick: (event) => {
              event.stopPropagation()
              setOpenProvider(null)
              setProviderSettingsOpen((open) => !open)
            },
          },
          h('svg', {
            width: 14,
            height: 14,
            viewBox: '0 0 16 16',
            fill: 'none',
            'aria-hidden': true,
            focusable: false,
          },
          h('path', {
            d: 'M2.5 4h11M2.5 8h11M2.5 12h11',
            stroke: 'currentColor',
            strokeWidth: 1.4,
            strokeLinecap: 'round',
          }),
          h('circle', { cx: 6, cy: 4, r: 1.4, fill: 'var(--dsw-alias-bg-layer-1, #fff)', stroke: 'currentColor', strokeWidth: 1.2 }),
          h('circle', { cx: 10, cy: 8, r: 1.4, fill: 'var(--dsw-alias-bg-layer-1, #fff)', stroke: 'currentColor', strokeWidth: 1.2 }),
          h('circle', { cx: 5, cy: 12, r: 1.4, fill: 'var(--dsw-alias-bg-layer-1, #fff)', stroke: 'currentColor', strokeWidth: 1.2 }),
          ),
          h('span', null, t('providerDisplay')),
          )
          : null,
        providerSettingsOpen && view.providers.length > 0
          ? h(ProviderVisibilitySettings, {
            providers: view.providers,
            visibility: providerVisibility,
            t,
            onToggle: toggleProviderVisibility,
          })
          : null,
        ),
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
