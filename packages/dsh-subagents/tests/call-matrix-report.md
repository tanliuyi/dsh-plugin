# dsh-subagents 真实调用矩阵测试报告

- 被测对象：`@dsh-plugins/dsh-subagents` v0.1.0（已加载进会话的 `subagents` / `subagents_supervisor` / `subagents_wait` 工具 + 内置 skill 注册）
- 测试时间：2026-08-15，单会话内全部真实调用（非 mock）
- 环境：会话 cwd `/Users/tanliuyi/projects/dsh-plugins`（无 `.dsh`/`.git` 标记）；模型 `deepseek-v4-flash`（opencode-go）
- 结果统计：**36/40 通过 · 2 预期拒绝 · 1 预期空结果 · 5 项发现（含 4 个缺陷/风险）**

## 一、调用矩阵

### A. 管理快测

| # | 调用 | 结果 | 证据 |
| --- | --- | --- | --- |
| A1 | `status`（空态） | ✅ | 返回导航提示，无报错 |
| A2 | `list` | ✅ | 6 个内置 agent 全部注册 |
| A3 | `get scout` | ✅ | 完整配置（frontmatter+system prompt） |
| A4 | `models` | ✅ | 6 agent 全部解析为 `deepseek-v4-flash`（opencode-go），含优先级说明 |
| A5 | `children.list` | ✅ | retained children 列表；interrupt/stop 后标记 `previous attempt stopped` |
| A6 | `doctor` | ✅ | providers(spawn,fork)/dirs/discovered/budget/missions/schedules/supervisor/intercom/watchdog/jobs/commands/skills 全量诊断 |
| A7 | `subagents_wait {nonBlocking:true}` | ✅ | 快照返回 |
| A8 | `guide workflows` | ✅ | 完整工作流文档渲染 |
| A9 | `grant-spawn-budget {additional:5}` | ⚠️ 预期拒绝 | `grant failed: spawn budget grants are only valid for a configured session cap`（无 session cap 时的边界，语义正确） |

### B. Mission

| # | 调用 | 结果 | 证据 |
| --- | --- | --- | --- |
| B1 | `mission.create {mission:{goal:false}}` | ✅ | 返回 `dffbc862-127 (planned)` |
| B2 | `mission.list` / `mission.show` | ✅ | 可见、字段完整 |
| B3 | `mission.close` | ✅ | 状态 → completed |
| B4 | 自动 mission 生命周期 | 🔴 | 见发现 #1：run 完成后 auto mission 永不 terminal |

### C. Schedule

| # | 调用 | 结果 | 证据 |
| --- | --- | --- | --- |
| C1 | `schedule.create {id:"matrix-sched", every:"1h"}` | ✅ | next run 正确计算 |
| C2 | `schedule.list` / `show` / `pause` / `resume` / `history` | ✅ | 状态流转正确，history 记录 created/fired 事件 |
| C3 | `schedule.run` | ✅ | 触发 workflow run `3d1325a6-e1b` → completed 0s |
| C4 | `schedule.delete` | ✅ | 已删除，无遗留 |

### D. Watchdog

| # | 调用 | 结果 | 证据 |
| --- | --- | --- | --- |
| D1 | `watchdog.recommend-model` | ✅ | 返回推荐配对 |
| D2 | `watchdog.configure {model:"inherit", scope:"session"}` | ✅ | 写入 `{}` main 配置 |
| D3 | `watchdog.status` | ✅ | `enabled: false`，无副作用（测试后保持关闭） |

### E. 单子代理执行（前台）

| # | 调用 | 结果 | 证据 |
| --- | --- | --- | --- |
| E1 | `{agent:"scout"}` | ✅ | 模块侦察输出 + read-only → `attest` 自动推断（acceptance-report 生效） |
| E2 | `{agent:"delegate"}` | ✅ | README 摘要 |
| E3 | `{agent:"oracle"}`（默认 fork） | ✅ | 读取 spawn.ts/acceptance.ts 源码给出 3 个针对性挑战——fork 上下文确实继承 |
| E4 | `{agent:"reviewer"}` | ✅ | 3 条带行号发现 |
| E5 | `{agent:"worker"}` | ✅ | 落盘 `tests/.matrix-tmp/worker-proof.txt`（内容 `worker-ok`），writer → checked 证据 |
| E6 | `{task}`（省略 agent） | ✅ | 路由选择 → scout（侦察类任务启发式正确） |
| E7 | `{agent:"advisor"}`（alias） | ✅ | 解析为 oracle |
| E8 | `{agent:"matrix-zero-tools"}`（非法工具白名单） | ⚠️ 边界 | run 标记 `failed`，错误明确（fail-fast 生效）；但 failed 的同时仍返回了子代理输出文本（见观察 O1） |

### F. 验收门

| # | 调用 | 结果 | 证据 |
| --- | --- | --- | --- |
| F1 | `{agent:"reviewer", gate:"node --version"}` | ✅ | gate 执行成功，run completed |
| F2 | `{agent:"delegate", acceptance:{level:"none", reason:...}}` | ✅ | 接受并执行 |

### G. workflowScript

| # | 调用 | 结果 | 证据 |
| --- | --- | --- | --- |
| G1 | 前台 `runs.run`（`async:false`） | ✅ | 返回 `workflow-foreground-ok`，mission completed |
| G2 | `runs.all` 并行波（2 reviewer） | ✅ | 两 lane 并行完成，输出聚合正确 |
| G3 | `state.set` → `state.get` | ✅ | `{n:42}` 往返一致 |
| G4 | `prompts.render("package:parallel-review")` | ✅ | 渲染出模板第一行 |
| G5 | 后台 workflow（默认 async） | ✅ | starting → completed，结果 `workflow-bg-ok` 经 status 通知回收 |

### H. 运行控制

| # | 调用 | 结果 | 证据 |
| --- | --- | --- | --- |
| H1 | 后台 delegate → `interrupt` | ✅ | `interrupted 1 child(ren)`；最终状态 stopped |
| H2 | 后台 delegate → `steer` | ✅ | `steered child 0`；run 最终输出 `steered-ok`（消息确实生效） |
| H3 | 后台 delegate → `stop` | ✅ | `stopped run (1 active child(ren) cancelled)` |
| H4 | `resume {id:<retained-run-id>, message}` | ✅ | fallback challenge 新启动，输出 `resumed-ok` |
| H5 | `resume {resume:<id>}`（schema 字段名） | 🔴 | 见发现 #2：参数名不一致，静默丢失报 `resume requires id` |

### I. Supervisor 通道（intercom）

| # | 调用 | 结果 | 证据 |
| --- | --- | --- | --- |
| I1 | `subagents_supervisor {action:"pending"}`（空态） | ✅ | `No pending supervisor requests` |
| I2 | worker 任务内 `contact_supervisor(need_decision)` → `pending` 可见 → `reply` → worker 落盘 | ✅ | 端到端闭环：文件内容 = `option-b`（父决策生效）；doctor 显示 `2 answered` |
| I3 | 观察：worker 首次 reply 后未继续，再次发起确认请求 `515d149e` | ⚠️ 观察 | 两次 reply 后才继续（worker 可能未消费到第一条回复或自主二次确认，见观察 O2） |

### J. Agent CRUD 与 refine

| # | 调用 | 结果 | 证据 |
| --- | --- | --- | --- |
| J1 | `create {config:{name:"matrix-test-agent",tools:["read"]}}`（scope=project） | ✅ | 写入 `/Users/tanliuyi/.dsh/subagents/agents/`（home 目录，见发现 #3） |
| J2 | `get`（默认 both） | ✅ | 解析成功 |
| J3 | `get`（scope=project）/ `list`（scope=project） | 🔴 | `unknown agent`——create 后 project 层看不到，见发现 #3 |
| J4 | `update {config:{description}}`（默认 scope） | ✅ | 描述生效 |
| J5 | `update` 省略 tools | 🔴 | 原 `tools:[read]` allowlist 被静默清空 → 退化为继承全部工具，见发现 #4 |
| J6 | `disable` → `list` | ✅ | agent 从列表消失 |
| J7 | `enable` → `get` | ✅ | 恢复可见 |
| J8 | `reset` | ✅ | overrides.json 清空（`{"agents":{}}` 验证） |
| J9 | `delete` | ✅ | agents 目录已空 |
| J10 | `refine.show scout` | ✅ | `No refinement overlay for scout`（预期空） |

### K. Skill 注册

| # | 调用 | 结果 | 证据 |
| --- | --- | --- | --- |
| K1 | `skill("subagents")` 加载 | 🔴 | 两次一致报错 `loaded skill "subagents" source must be a string`，见发现 #5 |

## 二、发现项

### #1（缺陷）auto mission 永不 terminal，mission store 无限累积
run（单子代理/工作流）结束时 `execution.ts` 只调用 `missions.updateRunStatus(...)`，从不调用 `missions.close(...)`（`missions/store.ts` 有 close，`mission.close` 动作可用但执行路径不用）。实证：本轮 19 个 auto mission 全部在 run completed 后保持 `active`，加上先前遗留共 24 个；`retainTerminal: 200` 只清理 terminal 记录，对 active 无效。建议：run 树终结时把 auto mission 置为 terminal（或提供 auto-close 配置）。

### #2（缺陷）`resume` 参数名与实现不一致
`tool.ts` schema 同时声明 `resume`（"Retained child id..."）与 `id`（"Run id for ... resume"），handler 只读 `id`。按 schema 语义用 `resume` 字段传 retained id → 静默忽略 → `resume requires id`。模型会被 schema 误导（本次测试即先踩中）。建议：schema 移除 `resume` 字段或 handler 兼容两者。

### #3（缺陷）project 作用域缓存不失效 + 项目根解析落 home
- `AgentRegistry.projectCache` 无失效机制：`create` 写入 agent 文件后，同一会话内 `list(scope="project")`/`get(scope="project")` 仍返回陈旧（空）缓存 → `unknown agent`；而默认 `both` 走每次刷新的 user 路径可解析。create/update/delete 后应使 projectCache 失效。
- 同时 `resolveProjectRoot` 在本仓库（无 `.dsh`/`.git`）向上解析到 `~`，导致 project 与 user 作用域物理目录重合（`~/.dsh/subagents/agents`），scope=project 的 create 实际写入了 user 目录，语义混淆。建议在无项目标记时显式警告或拒绝 project 作用域。

### #4（缺陷，安全敏感）`update` 省略 tools 会静默清空原 allowlist
`agentConfigFromManagementConfig`（management.ts L105-106）中 `tools` 赋值无 `?? existing?.tools` 回退（其余字段均有）。实证：`create {tools:["read"]}` 后 `update {description}` → 文件内 `tools` 行消失 → 解析为"继承父会话全部工具"，工具权限被静默放大。建议与其它字段一致回退 existing.tools。

### #5（兼容性）内置 skill 注册后无法加载
`skill.ts` 用 `skills.register({content: string, resourceBase})` 注册，会话技能目录可见该 skill，但 `skill` 工具加载报 `source must be a string`（两次复现）。疑似注册契约与加载器期望字段（`source`）不一致。建议核对 dsh `ctx.skills` 注册/加载契约并修复（或移除注册）。

### 观察项
- **O1** zero-tools 边界：run 正确标记 `failed` 且错误信息明确，但同时返回了子代理输出文本（`zero-tools-probe`）——fail-fast 生效但结果面仍"有输出"，消费方需以 status 为准。
- **O2** supervisor 端到端需要两次 reply：worker 首条 reply 投递后 worker 未继续，再次发起确认请求后才落盘。不排除 worker 提示词行为，建议观察 intercom 投递确认路径。
- **O3** `grant-spawn-budget` 在未配置 session cap 时明确拒绝（非 bug，语义良好）。
- **O4** 每次子代理运行自动创建 mission 且默认可见（`mission.list` 噪音随 #1 放大）。

## 三、清理记录

- 测试 fixture：`tests/.matrix-tmp/` 已删除（worker-proof.txt / supervisor-decision.txt）
- 测试 agent：`matrix-test-agent`、`matrix-zero-tools` 均已 delete；`~/.dsh/subagents/agents/` 为空；overrides.json 恢复 `{"agents":{}}`
- 测试 schedule：`matrix-sched` 已 delete（schedules: 0）
- watchdog：保持 disabled（仅写入 `{}` inherit 配置）
- missions：本轮创建的 23 个 auto/显式 mission 全部 `mission.close` → completed（24 条记录全 terminal）
- 本轮 run 记录 21 条保留在 run store（正常历史）

## 四、未覆盖（成本/副作用控制）

- researcher 真实网络调研（需要 web_search 工具链，成本高）
- watchdog 实际开启后的回合边界评审（会改变会话行为）
- refine 实际起草覆盖层（会写 `<root>/.dsh/subagents/refinements/`）
- `mission.update / resolve-decision / attach-run`、`schedule.run-due`、`watchdog.check`（增量动作，语义已被同组动作覆盖）
- 深度嵌套（maxSubagentDepth）与预算耗尽路径

## 五、修复记录（2026-08-15，随本报告同轮完成）

5 项发现全部修复，新增 6 个测试文件/用例覆盖，`pnpm build` + `pnpm test`（102 用例）全绿。

| # | 修复 | 改动 |
| --- | --- | --- |
| 1 | auto mission 空闲终结 | `missions/store.ts`：`MissionRecord.auto` + `finalizeIfIdle`（仅 auto 且全部 run 终态时置 terminal；显式 mission 不触碰）；`runs/execution.ts`：`autoMission` 标记 `auto: true`，launchSingle/workflow 收尾（成功/失败路径）调用 `finalizeAutoMission` |
| 2 | resume 参数兼容 | `runs/execution.ts`：`params.id ?? params.resume`；`tool.ts`/`docs/tool-reference.md`：`resume` 标注 deprecated alias |
| 3 | project 缓存失效 + root 解析 | `agents/registry.ts`：`invalidate(projectRoot)`；`runs/management-actions.ts`：create/update/delete/eject/disable/enable/reset 写后失效；`util.ts`：`resolveProjectRoot` 命中 home 视为无项目根返回 cwd（project 与 user 目录不再重合） |
| 4 | update 保留 tools 白名单 | `agents/management.ts`：`tools`/`extensions` 缺失时回退 `existing`（消除静默放大为继承全部工具） |
| 5 | skill 注册契约 | `skill.ts`：`content` → `source`（对齐 dsh-skill `validateSkillDefinition` 契约） |

新增测试：`tests/missions.test.ts`（finalizeIfIdle 三态）、`tests/registry.test.ts`（invalidate 前后可见性）、`tests/runs.test.ts`（resume 双字段与缺参报错）、`tests/util.test.ts`（resolveProjectRoot home 短路）、`tests/management.test.ts`（tools/extensions 回退）、`tests/skill.test.ts`（source 契约 + 无 skills 服务 no-op）。

注意：插件实例在会话启动时加载，上述修复对**当前会话**的已加载实例不生效；`pnpm build` 产物已更新，重启 dsh 会话后生效。
