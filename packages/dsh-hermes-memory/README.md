# @dsh-plugins/dsh-hermes-memory

[pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory)（MIT）的 dsh 移植：给 DeepSeek Harness 带来持久记忆、会话搜索与程序性技能。

- 🧠 **持久记忆** — MEMORY.md / USER.md / failures.md / 项目记忆，跨会话存活
- 🔍 **会话搜索** — `session_search` 搜索所有过去会话
- 🔄 **记忆工具** — `memory_add` / `memory_replace` / `memory_remove` / `memory_search`
- 📚 **程序性技能** — `skill_manage` 保存可复用流程（SKILL.md）
- ⚡ **后台学习循环** — 每 N 轮（或 N 次工具调用）自动 review 并保存
- 🔧 **纠正检测** — 用户纠正时立即保存，不等后台 review
- 🔄 **自动整合** — 记忆满时 LLM 合并条目而不是报错
- 🛡️ **机密扫描** — API key / token / SSH 私钥被阻止持久化
- 📌 **常驻指令** — `/memory-pin` 注入每个会话的硬规则
- 🏷️ **记忆分类** — failure / correction / insight / preference / convention / tool-quirk

## Minimal 预设

DSH 的 `minimal` 预设承诺只向模型提供持久 `bash` 与 `str_replace_editor`。本插件会在 live minimal agent 的 scope 中移除全部 memory/session/skill 模型工具；空白会话在首次回合前切换 preset 时会同步安装或撤销限制。`complete` persona 会抑制 Hermes prompt section，后台 review、纠正检测、session flush 与项目存储预热也会跳过 minimal 会话。

记忆存储和索引等 host 服务仍可常驻。DSH 当前的 command/skill registry 是 host-global，尚无 preset-scoped 可见性 API，因此 memory command 和 skill 名称仍可能出现在 UI 清单中；这不使对应模型工具或自动记忆行为在 minimal 中生效。

## 安装

```sh
# 本仓库内（本地路径）
dsh plugin --profile demo add ./packages/dsh-hermes-memory

# 发布后（npm registry）
dsh plugin --profile demo add @dsh-plugins/dsh-hermes-memory
```

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖（`dsh plugin --profile demo` 生成的配置层之后）：

```yaml
- id: dsh-hermes-memory
  name: '@dsh-plugins/dsh-hermes-memory'
  config:
    memoryMode: policy-only        # policy-only | legacy-inject
    memoryPolicyStyle: full        # full | compact | custom | none
    memoryCharLimit: 5000
    userCharLimit: 5000
    projectCharLimit: 5000
    nudgeInterval: 10
    nudgeToolCalls: 15
    reviewEnabled: true
    correctionDetection: true
    memoryOverflowStrategy: auto-consolidate   # auto-consolidate | reject | fifo-evict
    overflowGraceMs: 180000
    consolidationTimeoutMs: 180000
    standingInstructionsEnabled: true
    llmModelOverride: ''           # "provider/model" 或模型 id
    llmThinkingOverride: off       # off | minimal | low | medium | high | xhigh
    memoryDir: ''                  # 默认 $DSH_HOME/hermes-memory
    projectsMemoryDir: projects-memory
    failureInjectionEnabled: true
    failureInjectionMaxAgeDays: 7
    failureInjectionMaxEntries: 5
    flushOnCompact: true
    flushOnShutdown: true
    flushMinTurns: 6
    autoConsolidationWarnOnFailure: true
    correctionStrongPatterns: []   # 覆盖纠正检测强正则（空数组 = 无）
    correctionWeakPatterns: []
    correctionNegativePatterns: []
    correctionDirectiveWords: []
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `memoryMode` | `policy-only` | `policy-only` 只注入记忆策略；`legacy-inject` 注入完整记忆块 |
| `memoryPolicyStyle` | `full` | 策略文本风格；`custom` 用 `memoryPolicyCustomText`，`none` 不注入 |
| `memoryPolicyCustomText` | 未设置 | `memoryPolicyStyle: custom` 时的自定义策略文本 |
| `memoryCharLimit` / `userCharLimit` / `projectCharLimit` | `5000` | MEMORY.md / USER.md / 项目记忆字符上限 |
| `nudgeInterval` | `10` | 后台 review 的轮次间隔 |
| `nudgeToolCalls` | `15` | 工具调用数阈值（与轮次数取或） |
| `reviewRecentMessages` / `flushRecentMessages` | `0` | review/flush 纳入的最近消息数（0 = 全部） |
| `reviewEnabled` | `true` | 启用后台学习循环 |
| `flushOnCompact` / `flushOnShutdown` | `true` | 压缩前 / 会话结束时 flush |
| `flushMinTurns` | `6` | flush 触发前的最小用户轮次 |
| `memoryOverflowStrategy` | `auto-consolidate` | 记忆满时的策略（`reject` 报错 / `fifo-evict` 轮换旧条目） |
| `overflowGraceMs` | `180000` | 溢出后自动整合前的墙钟宽限 |
| `consolidationTimeoutMs` | `180000` | 整合运行超时 |
| `autoConsolidationWarnOnFailure` | `true` | 记录失败的自动整合到控制台 |
| `correctionDetection` | `true` | 检测用户纠正并立即保存 |
| `correction*Patterns` / `correctionDirectiveWords` | 默认模式 | 覆盖纠正检测模式（缺省 = 默认；`[]` = 无） |
| `failureInjectionEnabled` | `true` | legacy-inject 模式注入近期失败记忆 |
| `failureInjectionMaxAgeDays` / `failureInjectionMaxEntries` | `7` / `5` | 注入失败记忆的年龄/条数上限 |
| `standingInstructionsEnabled` | `true` | 注入 `/memory-pin` 钉住的常驻指令 |
| `llmModelOverride` | 未设置 | 后台 LLM 调用（review/flush/correction/整合）的模型覆盖 |
| `llmThinkingOverride` | 未设置 | 后台 LLM 调用的思考级别；设置了模型覆盖时默认 `off` |
| `memoryDir` | `$DSH_HOME/hermes-memory` | 全局存储目录（绝对路径或 `~` 开头） |
| `projectsMemoryDir` | `projects-memory` | 项目记忆目录（`$DSH_HOME` 下的单段目录名） |

## 使用

### 数据存放

```
$DSH_HOME/
├── hermes-memory/            ← 全局存储根
│   ├── MEMORY.md             ← agent 笔记（§ 分隔条目）
│   ├── USER.md               ← 用户画像
│   ├── failures.md           ← 失败/纠正/洞见
│   ├── STANDING.md           ← 常驻指令（/memory-pin）
│   ├── extended-memory.json  ← 搜索镜像（memory_search）
│   └── skills/<slug>/SKILL.md ← 全局技能
└── projects-memory/<project>/ ← 项目记忆
    ├── MEMORY.md
    └── skills/<slug>/SKILL.md
```

记忆条目用 `§` 分隔，可直接编辑；每次写入都经过机密扫描（API key、token、
SSH 私钥、注入/外泄模式被阻止）。

### 工具

| 工具 | 说明 |
| --- | --- |
| `memory_add` / `memory_replace` / `memory_remove` | 目标：`memory` / `user` / `project` / `failure`（failure 支持 `category` 与 `failure_reason`） |
| `memory_search` | 搜索扩展存储（`project` / `target` / `category` 过滤；支持 CJK 子串） |
| `session_search` | 跨会话全文搜索（复用 dsh 的 sessionQuery 索引） |
| `skill_manage` | `create` / `view` / `patch` / `update` / `delete` 程序性技能 |

后台学习循环默认开启：每 10 轮（或 15 次工具调用）自动 review 并保存值得记住的内容；
用户纠正会立即保存为 `[correction]` 失败记忆。

### 命令

| 命令 | 说明 |
| --- | --- |
| `/memory-insights` | 查看已存记忆 |
| `/memory-skills` | 列出技能 |
| `/memory-consolidate` | 手动触发整合 |
| `/memory-interview` | 访谈预填用户画像 |
| `/memory-switch-project` | 列出项目记忆 |
| `/memory-index-sessions` | 显示 dsh 会话索引状态 |
| `/memory-sync-markdown` | 手动把 Markdown 记忆对账进搜索镜像 |
| `/memory-preview-context` | 预览注入的提示词上下文 |
| `/memory-pin` | 钉一条注入每个会话的常驻指令（`remove <n>` / `clear` / `list`） |
| `/learn-memory-tool` | 记忆系统使用指南 |

## 与上游（pi-hermes-memory）的差异

| 方面 | 上游（Pi） | 本移植（dsh） |
| --- | --- | --- |
| 存储根 | `~/.pi/agent/` | `$DSH_HOME`（默认 `~/.dsh`） |
| 会话搜索 | 自带 SQLite FTS5 索引 Pi 会话 JSONL | 复用 `ctx.sessionQuery` 的 dsh 全文索引；`/memory-index-sessions` 只报告状态 |
| 扩展记忆存储 | better-sqlite3（FTS5 trigram） | `extended-memory.json` + 内存关键词/子串搜索（CJK 短词也可命中，零原生依赖） |
| 后台 LLM 传输 | `completeSimple()` 进程内 + `pi -p` 子进程回退 | 只有进程内 `llm.stream()`（dsh 无 pi 子进程） |
| 项目上下文 | session_start 时从 cwd 检测单一活跃项目 | 每次工具调用从 `exec.agent` 的会话 cwd 惰性解析（多会话安全） |
| 技能发现 | Pi `resources_discover` 钩子 | dsh `skills.registerProvider` 提供者 |
| 提示词注入 | `before_agent_start` 拼接 systemPrompt | `systemPrompt.section` 有序段 |
| 命令 UI | TUI notify/select | 命令返回文本结果直接渲染 |
| 存储锁 | 跨进程 SQLite 锁 | 进程内 FIFO 互斥（单 dsh 进程） |
| 未移植 | `reviewTransport`、`sessionSearch.variant: anchors`、`childExtensionPaths`、legacy 迁移、TUI 技能管理器 | 见上 |

## 开发

```sh
pnpm build   # tsc → lib/
pnpm test    # node:test + tsx
```
