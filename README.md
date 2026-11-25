# 供应商余量（DSH 本地插件）

![紧凑态](docs/compact.png)

![悬停明细](docs/hover.png)

在对话框输入框上方常驻一行，用**紧凑形式**列出所有已配置供应商的套餐余量；
鼠标悬停某个供应商徽标，弹出完整明细（5 小时 / 每周 / 每月窗口、已用与剩余、
重置倒计时与具体时刻、套餐名、读取时间）。点这一行会立即重读（绕过 45 秒缓存）。

紧凑态：

```
[opencode 官方图标] 0% 5d 1h   [command-code 官方图标] 0% 1d 11h   [OpenAI 官方图标] 64% 6d 1h
```

- 行首不再有「余量」文字或图标，直接从第一家供应商开始；整行的无障碍名仍是「余量」。
- 每个供应商的徽标 = **官方站点 favicon**（`opencode.ai`、`commandcode.ai`、`openai.com` 的 `favicon.ico`，
  转成 32px PNG data URL 内联在 `client.js` 的 `MARK_ICONS` 里——不联网、不受 CSP 限制）。
  没有登记图标的供应商回退成首字母徽标。
- 整行左边距与**输入框里「发消息或创建任务」那句话的起始字符对齐**：
  `paddingLeft: max(0px, calc((100% - var(--dsh-composer-card-max-width, 712px)) / 2 + 8px))`
  （卡片在 dock 里居中，输入区本身有 14px 内边距，徽标自身还有 6px 内边距，14 − 6 = 8）。
  实测徽标左缘与文字首字都在 x=435。
- 百分数是**剩余**比例，取该供应商**最吃紧**的那个窗口（剩余最少者）。
- 后面的 `5d 1h` 是那个窗口的**重置倒计时**。
- 剩余 ≤0 标红；徽标悬停弹出卡片，离开整行即收起。

悬停卡片（示例，command-code）：

```
command-code · 套餐 GOAT · 已用尽
每周窗口                        0% 已用尽
[━━━━━━━━━━━━━━━━━━━━━━━━]
已用 100% · 1d 11h 后重置 · 11/26 23:24
每月窗口                        12%
[━]
已用 88% · 17d 10h 后重置 · 12/12 22:22
更新于 11:32
```

## 数据来自哪里

宿主半边注册一条同源 JSON 路由 `GET /provider-quota/state`，浏览器半边只渲染它：

- **供应商列表**来自运行时 LLM 注册表（`ctx.llm.listProviders()`）。在「设置 → 模型」里新增 /
  删除供应商会自动反映，不用改本插件。
- **本地 CLI** 不在注册表里，单独作为常驻来源列在 `LOCAL_PROVIDERS`：目前是 `codex`
  （读 `~/.codex/auth.json` 里 Codex CLI 自己的 ChatGPT 登录态，和 `codex /status` 用的是同一把 token）。
- **API Key** 通过凭据 seam 按环境变量名解析（`OPENCODE_GO_API_KEY`、`COMMAND_CODE_API_KEY`），
  改密钥后下一次轮询就生效；解析失败时回退到进程环境变量，再失败则在悬停卡里显示「未配置密钥」。
- **用量接口**（对真实服务验证过）：

| 供应商 | 接口 | 映射 |
|---|---|---|
| `opencode-go` | `GET https://opencode.ai/zen/go/v1/usage` | `usage.rolling` → 5 小时、`weekly`、`monthly`；`percent` 是**已用**比例，`resetsAt` 是 ISO 时间 |
| `command-code` | `GET https://api.commandcode.ai/alpha/billing/credits` | `windowLimits.fiveHour` / `.weekly` 的 `used` `cap` `resetAt`（epoch 毫秒） |
| `command-code`（每月） | `GET https://api.commandcode.ai/alpha/billing/subscriptions` | `data.planId` + `data.currentPeriodEnd`，配合套餐月度额度（GOAT=70、Pro=30…）换算月窗 |
| `codex`（本地 CLI） | `GET https://chatgpt.com/backend-api/codex/usage` | `plan_type`（PLUS/PRO…）+ `rate_limit.primary_window` → 5 小时、`secondary_window` → 每周；`used_percent`、`reset_at`（秒） |

没有内置适配器的供应商（例如自建中转 `cpa`）不会出现——它们没有可查的余量接口。
新增一家：在 `index.js` 里写一个 `query<Provider>({ apiKey })`，返回
`{ windows: [{ tier, usedPercent, resetAt }], planTier }`，再登记到 `ADAPTERS` 和 `API_KEY_ENV`。

## 刷新节奏

- 默认 60 秒轮询（主机侧另有 45 秒缓存，多个标签页不会重复打供应商接口）。
- 点击这一行 → 带 `?refresh=1` 立即重读。
- 读取失败时保留上一次数字；从未成功过则显示「读取失败」，不会挤占布局。

## 安装

- 插件目录：`~/.dsh/profiles/<profile>/plugins/provider-quota/`
  （Windows 上是 `C:\Users\<你>\.dsh\profiles\<profile>\plugins\provider-quota\`）。
  建议把本仓库 clone 到别处，再让插件目录作为**指向仓库的 junction / 符号链接**，
  这样改仓库里的文件就是改已安装的插件。
- 配置档补丁：`~/.dsh/profiles/<profile>/cordis.patch.yml` 末尾

  ```yaml
  - insert:
      - id: provider-quota
        name: "./plugins/provider-quota/index.js"
  ```

- 浏览器半边（`client.js`）改动会被 HMR 自动换成新 bundle；
  **宿主半边（`index.js`）改动需要重载条目**（重启 DSH，或把上面这段 insert 摘掉再贴回）；
  改 `package.json` 必须重启 DSH。

## 微调

| 想要 | 改哪里 |
|---|---|
| 位置 | `client.js` 注册的 `name`：`conversation.input.dock`（上方，当前）、`conversation.composer.dock`（下方，与统计胶囊同行会折行）、`conversation.input.right`（发送键左侧，太窄） |
| 顺序 | 同一 dock 内按 `order` 升序：todo=0、本行=5、queue=20 |
| 紧凑态显示哪个窗口 | `bindingWindow()`：现在取剩余最少者；想固定显示 5 小时就把该函数改成 `windows.find(w => w.tier==='five_hour')` |
| 多加一个本地 CLI | `index.js` 里写 `query<Cli>()`，在 `ADAPTERS` 登记 `{ needsApiKey: false, query }`，再把 id 加进 `LOCAL_PROVIDERS`（它不在 LLM 注册表里），最后给 `client.js` 的 `MARK_ICONS` 补一张图标 |
| 徽标文字 | 官方图标在 `MARK_ICONS`（键是供应商路由键，值是 data URL）；没登记的走 `markOf()` 首字母徽标 |
| 字号 / 颜色 | `client.js` 顶部的样式常量，颜色用 DSH 设计变量 `--dsw-alias-*`，跟随主题 |
| 文案 | `copy.zh` / `copy.en` 两份字典 |

## 许可证

[MIT](LICENSE) © bmqy
