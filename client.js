// Provider quota bar — a compact row above the composer showing plan usage for
// configured providers. Quota data comes from this package's Host half through
// document-relative routes that work in DSH Desktop and Web shells; upstream
// requests and provider credentials remain on the Host.
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
    // Keep these document-relative: DSH Desktop and Web mount the Client with
    // a relative base, while leading slashes can escape the Desktop API mount.
    const STATE_PATH = 'provider-quota/state'
    const SETTINGS_PATH = 'provider-quota/settings'
    const MIN_POLL_MS = 30_000
    const PROVIDER_VISIBILITY_KEY = 'dsh-provider-quota:provider-visibility'
    const LEGACY_LOCAL_VISIBILITY_KEY = 'dsh-provider-quota:local-provider-visibility'
    const DISPLAY_POSITIONS_KEY = 'dsh-provider-quota:display-positions'
    const DEFAULT_DISPLAY_POSITIONS = { composer: true, sidebar: false }

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
        noProviders: '暂无可显示余量',
        providerQuotaTitle: '供应商余量显示',
        providerQuotaHint: '展示位置和供应商可见性开关仅影响显示，不影响检测与刷新；CLIProxyAPI 配置会改变管理接口连接。',
        providerSettingsTab: '余量',
        providerListTitle: '供应商显示',
        refreshProviderList: '刷新列表',
        providerListError: '读取供应商列表失败',
        showProviderQuota: '显示 {provider} 余量',
        displayLocations: '显示位置',
        displayLocationsHint: '输入框上方和侧栏位置可独立开关，也可同时显示。此设置页始终可从“设置 → 插件”打开。',
        composerLocation: '输入框上方',
        sidebarLocation: '侧栏登录信息上方',
        sidebarSummary: '打开供应商余量详情',
        closeSidebarDetails: '关闭余量详情',
        sidebarPanelTitle: '供应商余量',
        sidebarProviderCount: '{count} 个供应商',
        allProvidersHidden: '当前已隐藏所有供应商余量',
        cliProxySettingsTitle: 'CLIProxyAPI 配置',
        cliProxySettingsHint: '需要 CLIProxyAPI 的管理密钥；普通供应商 API Key 不适用。下方“清除”会同时移除已保存的管理地址和密钥，环境变量设置不受影响。',
        cliProxyManagementUrl: '管理接口地址',
        cliProxyManagementUrlPlaceholder: 'http://127.0.0.1:8317',
        cliProxyManagementKey: '管理密钥',
        cliProxyManagementKeyPlaceholder: '输入管理密钥；留空表示不更改',
        cliProxyKeyConfigured: '管理密钥已配置',
        cliProxyKeyMissing: '尚未配置管理密钥',
        cliProxyKeyEntered: '新管理密钥已输入，尚未保存',
        cliProxySave: '保存设置',
        cliProxyClearSettings: '清除',
        settingsLoading: '正在读取配置…',
        settingsSaved: 'CLIProxyAPI 配置已保存',
        settingsCleared: '已清除保存在 DSH 中的管理地址和密钥',
        settingsLoadError: '读取配置失败',
        settingsEndpointUnavailable: '宿主配置接口未加载（404）；请重启 DSH 后重试',
        settingsSaveError: '保存配置失败',
        settingsPartialSave: '部分设置可能已保存，请重新核对管理地址和密钥后重试。',
        settingsErrorCredentialUnavailable: 'DSH 凭据存储服务未加载，无法保存管理密钥（credential-store-unavailable）',
        settingsErrorCredentialWriteFailed: 'DSH 凭据存储写入失败；为避免泄露密钥或路径，未显示原始异常（credential-store-write-failed）',
        settingsErrorCredentialPermission: '凭据存储无写入权限（credential-store-permission-denied）',
        settingsErrorCredentialReadOnly: '凭据存储为只读（credential-store-read-only）',
        settingsErrorCredentialNoSpace: '凭据存储所在磁盘空间不足（credential-store-no-space）',
        settingsErrorCredentialPath: '凭据存储路径不可用（credential-store-path-unavailable）',
        settingsErrorCredentialLock: '凭据存储正被占用或等待锁超时（credential-store-lock-timeout）',
        settingsErrorCredentialMigration: '凭据文件需要先迁移到当前格式（credential-store-migration-required）',
        settingsErrorCredentialDocument: '凭据文件格式无效（credential-store-document-invalid）',
        settingsErrorCredentialVersion: '凭据文件版本不受支持（credential-store-version-unsupported）',
        settingsErrorCredentialUnsafePermissions: '凭据文件权限过于宽松；请检查该文件的访问权限（credential-store-permissions-unsafe）',
        settingsErrorSameOrigin: '保存被拒绝：请求来源校验失败（same-origin-required）',
        settingsErrorSecurityUnavailable: 'Host 请求安全服务未加载，已拒绝保存（request-security-unavailable）',
        settingsErrorRequestRejected: 'Host 拒绝了此设置请求；请从 DSH 桌面端重新打开面板后重试（request-rejected）',
        settingsErrorJson: '保存失败：Host 接口要求 JSON 请求（application-json-required）',
        settingsErrorInvalidPayload: '保存失败：请求参数无效',
        settingsErrorNoChanges: '没有可保存的设置内容',
        settingsInvalidUrl: '地址无效；请使用 HTTP 或 HTTPS URL',
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
        noProviders: 'No quota providers found yet',
        providerQuotaTitle: 'Provider quota display',
        providerQuotaHint: 'Display-location and provider-visibility switches only affect display; CLIProxyAPI settings change the management connection.',
        providerSettingsTab: 'Provider quota',
        providerListTitle: 'Provider visibility',
        refreshProviderList: 'Refresh list',
        providerListError: 'Could not load provider list',
        showProviderQuota: 'Show {provider} quota',
        displayLocations: 'Display locations',
        displayLocationsHint: 'Composer and sidebar are independent and may both be shown. This page is always available from Settings → Plugins.',
        composerLocation: 'Above composer',
        sidebarLocation: 'Above sidebar account row',
        sidebarSummary: 'Open provider quota details',
        closeSidebarDetails: 'Close quota details',
        sidebarPanelTitle: 'Provider quota',
        sidebarProviderCount: '{count} providers',
        allProvidersHidden: 'All provider quotas are hidden',
        cliProxySettingsTitle: 'CLIProxyAPI settings',
        cliProxySettingsHint: 'Requires the CLIProxyAPI management secret; a normal provider API key will not work. Clear removes both the saved management URL and secret; environment variables are unaffected.',
        cliProxyManagementUrl: 'Management API URL',
        cliProxyManagementUrlPlaceholder: 'http://127.0.0.1:8317',
        cliProxyManagementKey: 'Management secret',
        cliProxyManagementKeyPlaceholder: 'Enter the management secret; leave blank to keep the current one',
        cliProxyKeyConfigured: 'Management secret is configured',
        cliProxyKeyMissing: 'Management secret is not configured',
        cliProxyKeyEntered: 'New management secret entered but not saved',
        cliProxySave: 'Save settings',
        cliProxyClearSettings: 'Clear',
        settingsLoading: 'Loading settings…',
        settingsSaved: 'CLIProxyAPI settings saved',
        settingsCleared: 'Saved DSH management URL and secret cleared',
        settingsLoadError: 'Could not load settings',
        settingsEndpointUnavailable: 'The Host settings endpoint is not loaded (404); restart DSH and try again.',
        settingsSaveError: 'Could not save settings',
        settingsPartialSave: 'Some settings may have been saved; verify the management URL and secret before retrying.',
        settingsErrorCredentialUnavailable: 'The DSH credential store is not available; the management secret cannot be saved (credential-store-unavailable).',
        settingsErrorCredentialWriteFailed: 'The DSH credential store could not write the setting. Raw details are hidden to protect secrets and file paths (credential-store-write-failed).',
        settingsErrorCredentialPermission: 'The credential store is not writable (credential-store-permission-denied).',
        settingsErrorCredentialReadOnly: 'The credential store is read-only (credential-store-read-only).',
        settingsErrorCredentialNoSpace: 'The credential store has no available disk space (credential-store-no-space).',
        settingsErrorCredentialPath: 'The credential store path is unavailable (credential-store-path-unavailable).',
        settingsErrorCredentialLock: 'The credential store is busy or its write lock timed out (credential-store-lock-timeout).',
        settingsErrorCredentialMigration: 'The credential file needs migration to the current format (credential-store-migration-required).',
        settingsErrorCredentialDocument: 'The credential file format is invalid (credential-store-document-invalid).',
        settingsErrorCredentialVersion: 'The credential file version is unsupported (credential-store-version-unsupported).',
        settingsErrorCredentialUnsafePermissions: 'The credential file permissions are too broad; review its access permissions (credential-store-permissions-unsafe).',
        settingsErrorSameOrigin: 'Save rejected: the request origin did not match DSH (same-origin-required).',
        settingsErrorSecurityUnavailable: 'The Host request-security service is unavailable; the save was rejected (request-security-unavailable).',
        settingsErrorRequestRejected: 'The Host rejected this settings request; reopen the panel in DSH Desktop and try again (request-rejected).',
        settingsErrorJson: 'Save failed: the Host endpoint requires a JSON request (application-json-required).',
        settingsErrorInvalidPayload: 'Save failed: the request fields are invalid.',
        settingsErrorNoChanges: 'There are no settings changes to save.',
        settingsInvalidUrl: 'Invalid URL; use an HTTP or HTTPS URL',
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
    const sidebarSlotStyle = {
      position: 'relative',
      boxSizing: 'border-box',
      width: '100%',
      minWidth: 0,
    }
    const sidebarActionRowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      width: '100%',
      minWidth: 0,
    }
    const sidebarSummaryButtonStyle = (wide) => ({
      display: 'flex',
      alignItems: 'center',
      justifyContent: wide ? 'flex-start' : 'center',
      flex: wide ? '1 1 auto' : '0 0 44px',
      gap: wide ? '7px' : '2px',
      boxSizing: 'border-box',
      width: wide ? 'auto' : '44px',
      minWidth: '44px',
      minHeight: '36px',
      padding: wide ? '5px 8px' : '4px',
      border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.28))',
      borderRadius: 'var(--dsw-radius-md, 8px)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      font: 'inherit',
      lineHeight: '18px',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    })
    const sidebarSummaryPercentStyle = {
      fontVariantNumeric: 'tabular-nums',
      fontWeight: 600,
    }
    const sidebarPopoverStyle = {
      position: 'absolute',
      left: 0,
      bottom: 'calc(100% + 8px)',
      zIndex: 50,
      boxSizing: 'border-box',
      width: '328px',
      maxWidth: 'calc(100vw - 24px)',
      maxHeight: 'min(70vh, 480px)',
      overflowY: 'auto',
      padding: '12px',
      border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.28))',
      borderRadius: '10px',
      background: 'var(--dsw-alias-bg-layer-1, #fff)',
      boxShadow: 'var(--dsw-elevation-soft, 0 8px 24px rgba(0,0,0,0.16))',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '12px',
      lineHeight: '18px',
    }
    const sidebarProviderRowStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '8px',
      minHeight: '30px',
      padding: '3px 0',
      borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.18))',
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
    const settingsPageStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      boxSizing: 'border-box',
      width: '100%',
      minWidth: 0,
      padding: '8px 0 20px',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '13px',
      lineHeight: '20px',
    }
    const settingsPageTitleStyle = {
      margin: 0,
      color: 'var(--dsw-alias-label-primary)',
      fontSize: '16px',
      fontWeight: 600,
      lineHeight: '24px',
    }
    const settingsPageHeaderStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '12px',
    }
    const settingsSectionHeaderStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '12px',
    }
    const providerSettingListStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: '4px',
      marginTop: '8px',
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
    const settingsSectionStyle = {
      boxSizing: 'border-box',
      padding: '14px 16px',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: '10px',
      background: 'var(--dsw-alias-bg-layer-1)',
    }
    const settingsFieldStyle = {
      display: 'block',
      marginTop: '8px',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: '11px',
      fontWeight: 500,
    }
    const settingsInputStyle = {
      display: 'block',
      boxSizing: 'border-box',
      width: '100%',
      marginTop: '3px',
      padding: '6px 8px',
      border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.28))',
      borderRadius: '6px',
      background: 'var(--dsw-alias-bg-base, #fff)',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: '12px',
      lineHeight: '16px',
    }
    const settingsStatusStyle = {
      marginTop: '7px',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '11px',
      lineHeight: '15px',
      overflowWrap: 'anywhere',
    }
    const settingsActionsStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '8px',
      marginTop: '10px',
    }
    const settingsActionButtonStyle = {
      padding: '5px 8px',
      border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.28))',
      borderRadius: '6px',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      font: 'inherit',
      cursor: 'pointer',
    }
    const settingsPrimaryButtonStyle = {
      ...settingsActionButtonStyle,
      borderColor: 'var(--dsw-alias-brand-primary, #3d72f6)',
      background: 'var(--dsw-alias-brand-primary, #3d72f6)',
      color: 'var(--dsw-alias-bg-base, #fff)',
      fontWeight: 600,
    }
    const providerSettingRowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      minHeight: '30px',
    }
    const providerSettingToggleRowStyle = {
      ...providerSettingRowStyle,
      justifyContent: 'space-between',
      boxSizing: 'border-box',
      width: '100%',
      padding: 0,
      border: 0,
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      textAlign: 'left',
      cursor: 'pointer',
    }
    const providerSettingNameStyle = {
      flex: '1 1 auto',
      minWidth: 0,
      overflowWrap: 'anywhere',
      color: 'var(--dsw-alias-label-primary)',
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
    // Keep the loading indicator in a single flex row at narrow widths.
    const loadingBodyStyle = {
      position: 'relative',
      zIndex: 1,
      display: 'flex',
      alignItems: 'center',
      flex: '1 1 0',
      minWidth: 0,
      gap: '10px',
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
      h(ProviderMark, { provider: entry.markProvider ?? entry.provider }),
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

    function settingsFailureMessage(error, t) {
      if (error?.status === 404) return t('settingsEndpointUnavailable')
      if (error?.code === 'invalid-management-url') return t('settingsInvalidUrl')

      const reasons = {
        'credential-store-permission-denied': 'settingsErrorCredentialPermission',
        'credential-store-read-only': 'settingsErrorCredentialReadOnly',
        'credential-store-no-space': 'settingsErrorCredentialNoSpace',
        'credential-store-path-unavailable': 'settingsErrorCredentialPath',
        'credential-store-lock-timeout': 'settingsErrorCredentialLock',
        'credential-store-migration-required': 'settingsErrorCredentialMigration',
        'credential-store-document-invalid': 'settingsErrorCredentialDocument',
        'credential-store-version-unsupported': 'settingsErrorCredentialVersion',
        'credential-store-permissions-unsafe': 'settingsErrorCredentialUnsafePermissions',
        'credential-store-write-failed': 'settingsErrorCredentialWriteFailed',
      }
      const codes = {
        'credential-store-unavailable': 'settingsErrorCredentialUnavailable',
        'same-origin-required': 'settingsErrorSameOrigin',
        'request-security-unavailable': 'settingsErrorSecurityUnavailable',
        'request-rejected': 'settingsErrorRequestRejected',
        'application-json-required': 'settingsErrorJson',
        'invalid-settings-body': 'settingsErrorInvalidPayload',
        'invalid-settings-fields': 'settingsErrorInvalidPayload',
        'invalid-settings-value': 'settingsErrorInvalidPayload',
        'invalid-management-key': 'settingsErrorInvalidPayload',
        'no-settings-to-save': 'settingsErrorNoChanges',
        'settings-unavailable': 'settingsLoadError',
        'settings-save-failed': reasons[error?.reason] ?? 'settingsErrorCredentialWriteFailed',
      }
      const partialPrefix = error?.partial === true ? `${t('settingsPartialSave')} ` : ''
      const translation = codes[error?.code] ?? reasons[error?.reason]
      if (translation !== undefined) return `${partialPrefix}${t(translation)}`

      const code = typeof error?.code === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(error.code)
        ? error.code
        : undefined
      const status = Number.isInteger(error?.status) ? `HTTP ${String(error.status)}` : undefined
      const detail = [code, status].filter(Boolean).join(' · ')
      return detail === ''
        ? `${partialPrefix}${t('settingsSaveError')}`
        : `${partialPrefix}${t('settingsSaveError')} (${detail})`
    }

    async function readCliProxySettings(signal) {
      const response = await fetch(SETTINGS_PATH, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
        signal,
      })
      if (!response.ok) {
        let payload
        try { payload = await response.json() } catch { payload = undefined }
        const error = new Error(`HTTP ${String(response.status)}`)
        error.status = response.status
        error.code = payload?.error
        error.reason = payload?.reason
        throw error
      }
      const value = await response.json()
      if (value === null || typeof value !== 'object'
        || typeof value.managementUrl !== 'string'
        || typeof value.managementKeyConfigured !== 'boolean') {
        throw new Error('unexpected settings payload')
      }
      return value
    }

    async function writeCliProxySettings(settings) {
      const response = await fetch(SETTINGS_PATH, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        cache: 'no-store',
        body: JSON.stringify(settings),
      })
      let value
      try { value = await response.json() } catch { value = undefined }
      if (!response.ok) {
        const error = new Error(`HTTP ${String(response.status)}`)
        error.status = response.status
        error.code = value?.error
        error.reason = value?.reason
        error.partial = value?.partial === true
        throw error
      }
      if (value === null || typeof value !== 'object' || value.ok !== true) {
        throw new Error('unexpected settings response')
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

    let providerVisibilitySnapshot
    const providerVisibilityListeners = new Set()

    function getProviderVisibility() {
      if (providerVisibilitySnapshot === undefined) providerVisibilitySnapshot = readProviderVisibility()
      return providerVisibilitySnapshot
    }

    function persistProviderVisibility(value) {
      providerVisibilitySnapshot = value
      try {
        window.localStorage.setItem(PROVIDER_VISIBILITY_KEY, JSON.stringify(value))
      } catch {
        // Keep the in-memory toggle usable when storage is unavailable.
      }
      for (const listener of providerVisibilityListeners) listener(value)
    }

    function useProviderVisibility() {
      const [visibility, setVisibility] = React.useState(getProviderVisibility)
      React.useEffect(() => {
        const listener = (value) => setVisibility(value)
        providerVisibilityListeners.add(listener)
        return () => providerVisibilityListeners.delete(listener)
      }, [])
      return [visibility, (provider) => {
        const current = getProviderVisibility()
        persistProviderVisibility({ ...current, [provider]: current[provider] === false })
      }]
    }

    function readDisplayPositions() {
      try {
        const raw = window.localStorage.getItem(DISPLAY_POSITIONS_KEY)
        if (raw === null) return { ...DEFAULT_DISPLAY_POSITIONS }
        const saved = JSON.parse(raw)
        if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) {
          return { ...DEFAULT_DISPLAY_POSITIONS }
        }
        return {
          composer: typeof saved.composer === 'boolean' ? saved.composer : DEFAULT_DISPLAY_POSITIONS.composer,
          sidebar: typeof saved.sidebar === 'boolean' ? saved.sidebar : DEFAULT_DISPLAY_POSITIONS.sidebar,
        }
      } catch {
        return { ...DEFAULT_DISPLAY_POSITIONS }
      }
    }

    let displayPositionsSnapshot
    const displayPositionsListeners = new Set()

    function getDisplayPositions() {
      if (displayPositionsSnapshot === undefined) displayPositionsSnapshot = readDisplayPositions()
      return displayPositionsSnapshot
    }

    function updateDisplayPosition(position) {
      const current = getDisplayPositions()
      const next = { ...current, [position]: !current[position] }
      displayPositionsSnapshot = next
      try {
        window.localStorage.setItem(DISPLAY_POSITIONS_KEY, JSON.stringify(next))
      } catch {
        // Keep the in-memory toggle usable when storage is unavailable.
      }
      for (const listener of displayPositionsListeners) listener(next)
    }

    function useDisplayPositions() {
      const [positions, setPositions] = React.useState(getDisplayPositions)
      React.useEffect(() => {
        const listener = (value) => setPositions(value)
        displayPositionsListeners.add(listener)
        return () => displayPositionsListeners.delete(listener)
      }, [])
      return [positions, updateDisplayPosition]
    }

    function CliProxySettings({ t }) {
      const [config, setConfig] = React.useState(null)
      const [url, setUrl] = React.useState('')
      const [secret, setSecret] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState(null)

      const acceptConfig = (value) => {
        setConfig({
          managementUrl: value.managementUrl,
          managementUrlValid: value.managementUrlValid !== false,
          managementKeyConfigured: value.managementKeyConfigured,
        })
        setUrl(value.managementUrl)
      }

      React.useEffect(() => {
        const controller = new AbortController()
        void readCliProxySettings(controller.signal).then((value) => {
          if (!controller.signal.aborted) acceptConfig(value)
        }).catch((error) => {
          if (!controller.signal.aborted) {
            setMessage({
              text: error?.status === 404 ? t('settingsEndpointUnavailable') : t('settingsLoadError'),
              error: true,
            })
          }
        })
        return () => controller.abort()
      }, [])

      const save = async (event) => {
        event.stopPropagation()
        const trimmedUrl = url.trim()
        if (trimmedUrl !== '') {
          try {
            const parsed = new URL(trimmedUrl)
            if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username !== '' || parsed.password !== '') {
              throw new Error('invalid URL')
            }
          } catch {
            setMessage({ text: t('settingsInvalidUrl'), error: true })
            return
          }
        }
        setBusy(true)
        setMessage(null)
        try {
          const value = await writeCliProxySettings({
            managementUrl: trimmedUrl,
            ...(secret.trim() === '' ? {} : { managementKey: secret }),
          })
          acceptConfig(value)
          setSecret('')
          setMessage({ text: t('settingsSaved'), error: false })
        } catch (error) {
          setMessage({ text: settingsFailureMessage(error, t), error: true })
        } finally {
          setBusy(false)
        }
      }

      const clearSettings = async (event) => {
        event.stopPropagation()
        setBusy(true)
        setMessage(null)
        try {
          const value = await writeCliProxySettings({
            clearManagementUrl: true,
            clearManagementKey: true,
          })
          acceptConfig(value)
          setSecret('')
          setMessage({ text: t('settingsCleared'), error: false })
        } catch (error) {
          setMessage({ text: settingsFailureMessage(error, t), error: true })
        } finally {
          setBusy(false)
        }
      }

      return h('div', { style: settingsSectionStyle, 'aria-busy': busy },
        h('div', { style: cardTitleStyle }, t('cliProxySettingsTitle')),
        h('div', { style: providerSettingsHintStyle }, t('cliProxySettingsHint')),
        h('label', { style: settingsFieldStyle },
          t('cliProxyManagementUrl'),
          h('input', {
            type: 'url',
            value: url,
            maxLength: 2048,
            placeholder: t('cliProxyManagementUrlPlaceholder'),
            autoComplete: 'url',
            style: settingsInputStyle,
            onChange: (event) => {
              setUrl(event.target.value)
              setMessage(null)
            },
            onClick: (event) => event.stopPropagation(),
          }),
        ),
        h('label', { style: settingsFieldStyle },
          t('cliProxyManagementKey'),
          h('input', {
            type: 'password',
            value: secret,
            maxLength: 8192,
            placeholder: t('cliProxyManagementKeyPlaceholder'),
            autoComplete: 'new-password',
            style: settingsInputStyle,
            onChange: (event) => {
              setSecret(event.target.value)
              setMessage(null)
            },
            onClick: (event) => event.stopPropagation(),
          }),
        ),
        h('div', {
          style: {
            ...settingsStatusStyle,
            color: config?.managementKeyConfigured && secret.trim() === ''
              ? SEVERITY_COLOR.ok
              : 'var(--dsw-alias-label-secondary)',
          },
          role: 'status',
        },
        secret.trim() !== ''
          ? t('cliProxyKeyEntered')
          : config === null
            ? (message?.error ? null : t('settingsLoading'))
            : config.managementKeyConfigured ? t('cliProxyKeyConfigured') : t('cliProxyKeyMissing'),
        config?.managementUrlValid === false ? ` · ${t('settingsInvalidUrl')}` : null,
        ),
        message !== null && !message.error
          ? h('div', { style: { ...settingsStatusStyle, color: SEVERITY_COLOR.ok }, role: 'status' }, message.text)
          : null,
        message?.error === true
          ? h('div', { style: { ...settingsStatusStyle, color: SEVERITY_COLOR.danger }, role: 'alert' }, message.text)
          : null,
        h('div', { style: settingsActionsStyle },
          h('button', {
            type: 'button',
            style: { ...settingsPrimaryButtonStyle, opacity: busy ? 0.65 : 1 },
            disabled: busy,
            onClick: save,
          }, t('cliProxySave')),
          h('button', {
            type: 'button',
            style: {
              ...settingsActionButtonStyle,
              opacity: busy ? 0.55 : 1,
            },
            disabled: busy,
            onClick: clearSettings,
          }, t('cliProxyClearSettings')),
        ),
      )
    }

    function SettingsSwitchRow({ label, enabled, onToggle }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': enabled,
        'aria-label': label,
        style: providerSettingToggleRowStyle,
        onClick: (event) => {
          event.stopPropagation()
          onToggle()
        },
      },
      h('span', { style: providerSettingNameStyle }, label),
      h('span', { style: providerSwitchTrackStyle(enabled) },
        h('span', { style: providerSwitchThumbStyle(enabled) }),
      ),
      )
    }

    function ProviderVisibilitySettings({ providers, phase, visibility, displayPositions, t, onToggle, onTogglePosition, onRefresh }) {
      return h('div', {
        style: settingsPageStyle,
        'aria-label': t('providerQuotaTitle'),
      },
      h('header', { style: settingsPageHeaderStyle },
        h('div', { style: { minWidth: 0 } },
          h('h2', { style: settingsPageTitleStyle }, t('providerQuotaTitle')),
          h('p', { style: { ...providerSettingsHintStyle, margin: '4px 0 0' } }, t('providerQuotaHint')),
        ),
      ),
      h('section', { style: settingsSectionStyle },
        h('h3', { style: { ...cardTitleStyle, fontSize: '13px' } }, t('displayLocations')),
        h('p', { style: providerSettingsHintStyle }, t('displayLocationsHint')),
        h(SettingsSwitchRow, {
          label: t('composerLocation'),
          enabled: displayPositions.composer,
          onToggle: () => onTogglePosition('composer'),
        }),
        h(SettingsSwitchRow, {
          label: t('sidebarLocation'),
          enabled: displayPositions.sidebar,
          onToggle: () => onTogglePosition('sidebar'),
        }),
      ),
      h('section', { style: settingsSectionStyle, 'aria-busy': phase === 'loading' },
        h('div', { style: settingsSectionHeaderStyle },
          h('h3', { style: { ...cardTitleStyle, margin: 0, fontSize: '13px' } }, t('providerListTitle')),
          h('button', {
            type: 'button',
            style: { ...settingsActionButtonStyle, whiteSpace: 'nowrap', opacity: phase === 'loading' ? 0.65 : 1 },
            disabled: phase === 'loading',
            onClick: onRefresh,
          }, t('refreshProviderList')),
        ),
        phase === 'loading'
          ? h('div', { style: { ...providerSettingsHintStyle, margin: '8px 0 0' }, role: 'status' }, t('loading'))
          : phase === 'error'
            ? h('div', { style: { ...providerSettingsHintStyle, margin: '8px 0 0' }, role: 'alert' }, t('providerListError'))
            : providers.length === 0
              ? h('div', { style: { ...providerSettingsHintStyle, margin: '8px 0 0' }, role: 'status' }, t('noProviders'))
              : h('div', { style: providerSettingListStyle }, providers.map((entry) => {
                const provider = entry.provider
                const enabled = visibility[provider] !== false
                const name = entry.providerName ?? provider
                return h('button', {
                  key: provider,
                  type: 'button',
                  role: 'switch',
                  'aria-checked': enabled,
                  'aria-label': t('showProviderQuota', { provider: name }),
                  style: providerSettingToggleRowStyle,
                  onClick: (event) => {
                    event.stopPropagation()
                    onToggle(provider)
                  },
                },
                h(ProviderMark, { provider: entry.markProvider ?? provider }),
                h('span', { style: providerSettingNameStyle }, name),
                h('span', { style: { ...providerSwitchTrackStyle(enabled), flex: '0 0 34px' } },
                  h('span', { style: providerSwitchThumbStyle(enabled) }),
                ),
                )
              })),
      ),
      h(CliProxySettings, { t }),
      )
    }

    function ProviderQuotaSettingsPage({ t }) {
      const [visibility, toggleProviderVisibility] = useProviderVisibility()
      const [displayPositions, toggleDisplayPosition] = useDisplayPositions()
      const [view, setView] = React.useState({ phase: 'loading', providers: [] })
      const [reloadNonce, setReloadNonce] = React.useState(0)

      React.useEffect(() => {
        const controller = new AbortController()
        const load = async () => {
          try {
            const value = await readState(reloadNonce > 0, controller.signal)
            if (controller.signal.aborted) return
            const providers = Array.isArray(value.providers) ? value.providers : []
            setView({ phase: providers.length === 0 ? 'empty' : 'ready', providers })
          } catch {
            if (!controller.signal.aborted) setView({ phase: 'error', providers: [] })
          }
        }
        void load()
        return () => controller.abort()
      }, [reloadNonce])

      const refresh = () => {
        setView((current) => ({ ...current, phase: 'loading' }))
        setReloadNonce((current) => current + 1)
      }

      return h(ProviderVisibilitySettings, {
        providers: view.providers,
        phase: view.phase,
        visibility,
        displayPositions,
        t,
        onToggle: toggleProviderVisibility,
        onTogglePosition: toggleDisplayPosition,
        onRefresh: refresh,
      })
    }

    function QuotaBar({ t, placement = 'composer', wide = true }) {
      const isSidebar = placement === 'sidebar'
      const [view, setView] = React.useState({ phase: 'loading', providers: [], intervalSec: 60 })
      const [providerVisibility] = useProviderVisibility()
      const [displayPositions] = useDisplayPositions()
      const placementEnabled = !isSidebar || displayPositions.sidebar
      const [sidebarOpen, setSidebarOpen] = React.useState(false)
      const sidebarSummaryTriggerRef = React.useRef(null)
      const sidebarPanelInitialFocusRef = React.useRef(null)
      const [nonce, setNonce] = React.useState(0)
      const [refreshing, setRefreshing] = React.useState(false)
      const [openProvider, setOpenProvider] = React.useState(null)
      const refreshRequestRef = React.useRef(false)
      const loadRef = React.useRef(null)
      const aliveRef = React.useRef(true)

      React.useEffect(() => {
        if (!placementEnabled) return undefined
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
      }, [nonce, placementEnabled])

      React.useEffect(() => {
        // Keep polling while the composer row is hidden so newly available providers show up.
        if (!placementEnabled) return undefined
        const ms = Math.max(MIN_POLL_MS, view.intervalSec * 1000)
        const timer = setInterval(() => { void loadRef.current?.(false) }, ms)
        return () => { clearInterval(timer) }
      }, [view.phase, view.intervalSec, placementEnabled])

      React.useEffect(() => {
        if (!placementEnabled) setSidebarOpen(false)
      }, [placementEnabled])

      React.useEffect(() => {
        if (sidebarOpen) sidebarPanelInitialFocusRef.current?.focus()
      }, [sidebarOpen])

      const onRowLeave = () => {
        setOpenProvider(null)
      }
      const closeSidebarDetails = () => {
        setSidebarOpen(false)
        sidebarSummaryTriggerRef.current?.focus()
      }

      const refresh = () => {
        refreshRequestRef.current = true
        setRefreshing(true)
        setNonce((value) => value + 1)
      }
      const providersToDisplay = view.providers.filter((entry) => (
        providerVisibility[entry.provider] !== false
      ))
      if (isSidebar && !displayPositions.sidebar) return null
      if (!isSidebar && !displayPositions.composer) return null
      if (isSidebar) {
        const summaryCandidates = providersToDisplay.map((entry) => {
          const windows = orderWindows(Array.isArray(entry.windows) ? entry.windows : [])
          const binding = windows.length > 0 ? bindingWindow(windows) : undefined
          return { entry, binding }
        }).filter((candidate) => Number.isFinite(candidate.binding?.remaining))
        summaryCandidates.sort((a, b) => a.binding.remaining - b.binding.remaining)
        const summary = summaryCandidates[0]
        const statusText = summary !== undefined
          ? formatPercent(summary.binding.remaining)
          : view.phase === 'loading' || refreshing
            ? t('loading')
            : view.phase === 'error' ? t('unavailable') : '—'
        const statusColor = summary === undefined
          ? undefined
          : SEVERITY_COLOR[severityOf(summary.binding.remaining)]
        const compactStatusText = summary !== undefined
          ? statusText
          : view.phase === 'loading' || refreshing
            ? '…'
            : view.phase === 'error' ? '!' : '—'
        const sidebarEmptyText = view.phase === 'loading' || refreshing
          ? t('loading')
          : view.phase === 'error'
            ? t('unavailable')
            : view.providers.length > 0 ? t('allProvidersHidden') : t('noProviders')
        return h('div', { style: sidebarSlotStyle },
          h('div', { style: sidebarActionRowStyle },
            h('button', {
              ref: sidebarSummaryTriggerRef,
              type: 'button',
              style: sidebarSummaryButtonStyle(wide),
              title: t('sidebarSummary'),
              'aria-label': t('sidebarSummary'),
              'aria-expanded': sidebarOpen,
              'aria-haspopup': 'dialog',
              'aria-controls': 'provider-quota-sidebar-details',
              onClick: (event) => {
                event.stopPropagation()
                setSidebarOpen((open) => !open)
              },
              onKeyDown: (event) => {
                if (event.key === 'Escape' && sidebarOpen) {
                  event.preventDefault()
                  event.stopPropagation()
                  closeSidebarDetails()
                }
              },
            },
            wide && summary !== undefined
              ? h(ProviderMark, { provider: summary.entry.markProvider ?? summary.entry.provider })
              : !wide ? h('svg', {
                width: 10,
                height: 10,
                viewBox: '0 0 12 12',
                fill: 'none',
                'aria-hidden': true,
                focusable: false,
                style: { color: statusColor },
              },
              h('path', {
                d: 'M2 9a4 4 0 1 1 8 0M6 6l2-1.5',
                stroke: 'currentColor',
                strokeWidth: 1.3,
                strokeLinecap: 'round',
              }),
              ) : null,
            wide ? h('span', null, t('label')) : null,
            h('span', {
              style: {
                ...sidebarSummaryPercentStyle,
                color: statusColor,
                fontSize: wide ? undefined : '10px',
              },
              role: 'status',
              'aria-live': 'polite',
            }, wide ? statusText : compactStatusText),
            wide ? h('span', {
              style: { marginLeft: 'auto', color: 'var(--dsw-alias-label-tertiary)' },
            }, t('sidebarProviderCount', { count: String(providersToDisplay.length) })) : null,
            ),
          ),
          sidebarOpen ? h('div', {
            id: 'provider-quota-sidebar-details',
            style: sidebarPopoverStyle,
            role: 'dialog',
            'aria-label': t('sidebarPanelTitle'),
            onClick: (event) => event.stopPropagation(),
            onKeyDown: (event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                closeSidebarDetails()
              }
            },
          },
          h('div', {
            style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' },
          },
          h('div', { style: { ...cardTitleStyle, margin: 0 } }, t('sidebarPanelTitle')),
          h('span', {
            style: { marginLeft: 'auto', color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px' },
          }, t('sidebarProviderCount', { count: String(providersToDisplay.length) })),
          h('button', {
            ref: sidebarPanelInitialFocusRef,
            type: 'button',
            style: refreshButtonStyle,
            title: t('refresh'),
            'aria-label': t('refresh'),
            onClick: (event) => {
              event.stopPropagation()
              refresh()
            },
          }, '↻'),
          h('button', {
            type: 'button',
            style: refreshButtonStyle,
            title: t('closeSidebarDetails'),
            'aria-label': t('closeSidebarDetails'),
            onClick: (event) => {
              event.stopPropagation()
              closeSidebarDetails()
            },
          }, '×'),
          ),
          providersToDisplay.length === 0
            ? h('div', { style: noteStyle }, sidebarEmptyText)
            : providersToDisplay.map((entry) => {
              const windows = orderWindows(Array.isArray(entry.windows) ? entry.windows : [])
              const binding = windows.length > 0 ? bindingWindow(windows) : undefined
              const remaining = binding?.remaining
              const summaryText = entry.status === 'error' && !Number.isFinite(remaining)
                ? failureLabel(entry, t)
                : formatPercent(remaining)
              return h('div', {
                key: entry.provider,
                style: { ...sidebarProviderRowStyle, flexDirection: 'column', alignItems: 'stretch', gap: '6px', padding: '8px 0' },
              },
              h('div', {
                style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 },
              },
              h(ProviderMark, { provider: entry.markProvider ?? entry.provider }),
              h('span', { style: { ...providerSettingNameStyle, flex: '1 1 auto' } }, entry.providerName ?? entry.provider),
              h('span', {
                style: {
                  ...figureStyle,
                  color: Number.isFinite(remaining) ? SEVERITY_COLOR[severityOf(remaining)] : undefined,
                  flex: '0 0 auto',
                },
              }, summaryText),
              ),
              windows.length > 0
                ? windows.map((window, index) => h(WindowRow, {
                  key: `${String(window.tier)}-${String(index)}`,
                  window,
                  t,
                }))
                : h('div', { style: noteStyle }, entry.status === 'error' ? failureLabel(entry, t) : t('noWindows')),
              )
            }),
          ) : null,
        )
      }
      if (view.phase === 'empty') {
        return h('div', { style: dockStyle },
          h('div', {
            style: { ...rootStyle, cursor: 'pointer' },
            role: 'group',
            'aria-label': t('label'),
            onMouseLeave: onRowLeave,
            onClick: refresh,
          },
          h('div', { style: fillStyle, 'aria-hidden': true }),
          h('span', null, t('noProviders')),
            ),
        )
      }
      if (view.phase === 'loading' || refreshing) {
        return h('div', { style: dockStyle },
          h('div', {
            style: rootStyle,
            role: 'group',
            'aria-label': t('loading'),
            'aria-live': 'polite',
            onMouseLeave: onRowLeave,
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
            h('div', { style: loadingLabelStyle, role: 'status' }, t('loading')),
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
            role: 'group',
            'aria-label': t('label'),
            onMouseLeave: onRowLeave,
          },
          h('div', { style: fillStyle, 'aria-hidden': true }),
          h('span', { role: 'status' }, t('unavailable')),
            ),
        )
      }
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
        // DSH renders this footer action before `sidebar.settings`, above its account/login row.
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'provider-quota',
          order: 100,
          label: () => t('label'),
          locale: NS,
        }, (props) => h(QuotaBar, { ...props, placement: 'sidebar', t: props.t ?? t })))
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab',
          id: 'provider-quota',
          order: 30,
          label: () => t('providerSettingsTab'),
        }, (props) => h(ProviderQuotaSettingsPage, { ...props, t: props.t ?? t })))
      },
    }
  },
})
