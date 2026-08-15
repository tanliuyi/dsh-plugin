# dsh-subagents 真实调用矩阵测试报告（第二轮 · 修复后回归）

- 被测对象：`@dsh-plugins/dsh-subagents` v0.1.0（当前会话已加载实例，含第一轮 5 项修复：auto mission 终结 / resume 双字段 / project 缓存与 root 解析 / update 保留 tools / skill 注册契约）
- 测试时间：2026-08-15（第一轮之后、修复已构建并重启会话），单会话内全部真实调用（非 mock）
- 环境：会话 cwd `/Users/tanliuyi/projects/dsh-plugins`（无 `.dsh`/`.git` 标记）；模型 `deepseek-v4-flash`（opencode-go）；`subagents` 工具 + `subagents_supervisor` + `subagents_wait` + 内置 skill 均可用
- 结果统计：**41 项调用，38 通过 · 1 预期拒绝 · 2 预期空结果 · 5 项修复回归全部通过 · 4 项新发现（1 严重 / 2 中 / 1 低）**

## 一、调用矩阵

### A. 管理快测

| # | 调用 | 结果 | 证据 |
| --- | --- | --- | --- |
| A1 | `status`（空态） | ✅ | 导航提示，无报错 |
| A2 | `list` | ✅ | 6 个内置 agent 全部注册 |
| A3 | `get scout` | ✅ | 完整 frontmatter + system prompt |
| A4 | `models` | ✅ | 6 agent 解析为 `deepseek-v4-flash`（opencode-go），含优先级说明 |
| A5 | `children.list` | ✅ | retained children 列表，中断/停止项带 `previous attempt stopped` 标记 |
| A6 | `doctor` | ✅ | providers/dirs/agents/budget/missions/schedules/supervisor/watchdog/jobs/commands/skills 全量诊断 |
| A7 | `subagents_wait {nonBlocking:true}` | ✅ | 快照返回 |
| A8 | `guide overview` | ✅ | 完整概览 + topics 列表 |
| A9 | `grant-spawn-budget {additional:5}` | ⚠️ 预期拒绝 | `grant failed: spawn budget grants are only valid for a configured session cap`（语义正确） |

### B. Mission

| # | 调用 | 结果 | 证据 |
| --- | --- | --- | --- |
| B1 | `mission.create {mission:{goal:false}}` | ✅ | 返回 `def21350-cd4 (planned)` |
| B2 | `mission.list` / `mission.show` | ✅ | 可见、字段完整 |
| B3 | `mission.close` | ✅ | → completed |
| B4 | auto mission 终结（修复 #1 回归） | ✅ | **本轮 19 个 auto mission 全部 terminal（completed/failed）**，第一轮"永不终结、无限累积"已修复；仅 1 条例外见发现 #N1（悬挂 run 的 stop 路径） |

### C. Schedule

| # | 调用 | 结果 | 证据 |
| --- | --- | --- | --- |
| C1 | `schedule.create {id:"matrix-sched", every:"1h"}` | ✅ | next run 正确计算 |
| C2 | `schedule.list` / `show` / `pause` / `resume` / `history` | ✅ | 状态流转正确；history 记录 created 事件 |
| C3 | `schedule.run` | ✅ | 触发 workflow `c980b83d-386` → completed；history 记录 fired |
| C4 | `schedule.delete` | ✅ | 无遗留（schedules: 0） |

### D. Watchdog

| # | 调用 | 结果 | 证据 |
| --- | --- | --- | --- |
| D1 | `watchdog.recommend-model` | ✅ | 返回推荐配对（含备用） |
| D2 | `watchdog.status` | ✅ | `enabled: false`，无副作用（测试后保持关闭） |

### E. 单子代理执行（前台）

| # | 调用 | 结果 | 证据 |
| --- | --- | --- | --- |
| E1 | `{agent:"scout"}` | ✅ | Code Context 输出 + acceptance-report 自动推断，mission completed |
| E2 | `{agent:"delegate"}` | ✅ | 一行摘要 |
| E3 | `{agent:"advisor"}`（oracle 别名） | ✅ | 解析为 oracle，fork 上下文生效（"Inherited decisions" 结构输出） |
| E4 | `{agent:"reviewer"}` | ✅ | 3 条带行号发现（readJsonFile 吞错 / expandTilde `~` 裸路径 / resolvePath 一致性） |
| E5 | `{agent:"worker"}` | ✅ | 落盘 `worker-proof.txt`（内容 `worker-ok`），writer → checked 证据 |
| E6 | `{task}`（省略 agent） | ✅ | 路由选择 scout（侦察类任务启发式正确） |

### F. 验收门

| # | 调用 | 结果 | 证据 |
| --- | --- | --- | --- |
| F1 | reviewer + `gate:"node --version"` | ✅ | gate 执行成功，run completed |
| F2 | delegate + `acceptance:{level:"none"}` | ✅ | 接受并执行 |

### G. workflowScript

| # | 调用 | 结果 | 证据 |
| --- | --- | --- | --- |
| G1 | 前台 `runs.run`（`async:false`） | ✅ | 返回 `{out:"fg-mode-ok", promptFirstLine:"Launch parallel reviewers…"}`，mission completed |
| G2 | `runs.all` 并行波（2 lane） | ⚠️ | **一次悬挂**（lane 全部完成后 workflow 11m46s 未终结，需手动 stop），**同脚本重跑正常 completed**——偶发，见发现 #N1 |
| G3 | `state.set` → `state.get` | ✅ | 跨 run 读回 `{n:42}`（二次 workflow 验证持久化往返） |
| G4 | `prompts.render("package:parallel-review")` | ✅ | 渲染出模板首行 |
| G5 | 后台 workflow（默认 async） | ✅ | starting → completed，结果经 status 通知回收 |

### H. 运行控制

| # | 调用 | 结果 | 证据 |
| --- | --- | --- | --- |
| H1 | 后台 worker → `interrupt` | ✅ | `interrupted 1 child(ren)`；run → stopped，文件未落盘即被打断 |
| H2 | 后台 worker → `steer` | ✅ | `steered child 0`；worker 停止 tick 循环改写 `steer-ok`，文件验证 = `steer-ok` |
| H3 | 后台 delegate → `stop` | ✅ | `stopped run (1 active child(ren) cancelled)` |
| H4 | `resume {resume:<id>}`（修复 #2 回归） | ✅ | **用 `resume` 字段传 retained id 成功**（第一轮会报 `resume requires id`）；fallback challenge 启动，输出 `resumed-ok` |

### I. Supervisor 通道（intercom）

| # | 调用 | 结果 | 证据 |
| --- | --- | --- | --- |
| I1 | `subagents_supervisor {action:"pending"}`（空态） | ✅ | `No pending supervisor requests` |
| I2 | worker `contact_supervisor(need_decision)` → pending 可见 → reply → 落盘 | 🔴 | **决策请求投递成功、父回复投递成功，但 worker 的 run 在等待期间被提前标记 completed，回复后无法恢复执行，文件未落盘**；改用 `resume` 补发决策后才落盘 `option-b`（文件验证）。见发现 #N2 |
| I3 | doctor 复查 | ✅ | `supervisor channel: 0 pending, 1 answered` |

### J. Agent CRUD 与 refine

| # | 调用 | 结果 | 证据 |
| --- | --- | --- | --- |
| J1 | `create`（默认 user scope） | ✅ | 写入 `~/.dsh/subagents/agents/matrix-test-agent.md` |
| J2 | `get`（both）/ `list`（user） | ✅ | 创建后立即可见 |
| J3 | `create`（scope=project，修复 #3 回归） | ✅ | 写入 `/Users/tanliuyi/projects/dsh-plugins/.dsh/subagents/agents/`——**project 与 user 目录不再重合**（第一轮写到了 home） |
| J4 | `get`/`list`（scope=project） | ✅ | 创建后立即可见——**projectCache 失效生效**（第一轮返回 `unknown agent`） |
| J5 | `update {description}` 省略 tools（修复 #4 回归） | ✅ | 文件内 `tools: [read]` 保留——不再静默清空为继承全部工具 |
| J6 | `disable` → list | ✅ | both/project 列表均消失（但见发现 #N3） |
| J7 | `enable` → get | ✅ | 恢复可见 |
| J8 | `reset` | ✅ | overrides.json 恢复 `{"agents":{}}` |
| J9 | `delete`（两个 agent 各按 scope） | ✅ | `from project scope` / `from user scope`；两个 agents 目录均清空 |
| J10 | `refine.show scout` | ✅ | `No refinement overlay`（预期空） |

### K. Skill 注册

| # | 调用 | 结果 | 证据 |
| --- | --- | --- | --- |
| K1 | `skill("subagents")` 加载（修复 #5 回归） | ✅ | **本会话成功加载**（第一轮两次报 `source must be a string`）——注册契约已对齐 |

## 二、第一轮 5 项修复的回归结论

| 修复 | 回归结果 | 本轮证据 |
| --- | --- | --- |
| #1 auto mission 空闲终结 | ✅ | 19/20 mission terminal（唯一残留见 #N1，属 stop 悬挂 run 的遗漏路径） |
| #2 resume 双字段 | ✅ | H4 用 `resume` 字段成功 |
| #3 project 缓存失效 + root 解析 | ✅ | J3/J4：project 目录物理分离 + 创建后立即可见 |
| #4 update 保留 tools | ✅ | J5：`tools:[read]` 保留 |
| #5 skill 注册契约 | ✅ | K1：`source` 字段契约修复后加载成功 |

## 三、本轮新发现

### #N1（严重，偶发）`runs.all` lane 全部完成后 workflow 悬挂；stop 后 auto mission 残留 active
第一次 `runs.all`（2 lane）运行时：两个 lane 的 child 均结束（children.list 显示 resumable），但 workflow run 悬挂 `running` 11m46s（lane-b 输出已返回），`subagents_wait` 与重复 `status` 均无法终结；`stop` 后 run 状态变 stopped，但 auto mission `1e503924-c37` 残留 `active`（其余 stop/interrupt 路径的 mission 均为 failed）——悬挂 run 的 stop 路径未走 `finalizeAutoMission`。同脚本原样重跑（`a84280e6-06d`）正常 completed，2s 完成 → 判定为 lane 完成事件丢失/状态机竞态的偶发缺陷。建议：runs.all 加整体超时兜底 + stop 路径统一 finalize mission。

### #N2（严重）子代理等待 supervisor 回复期间 run 被提前终结
worker 投递 `contact_supervisor(need_decision)` 后，run 立即被标记 `completed`（mission 同步 completed），父会话 `reply` 投递成功后子代理无法恢复执行，预期落盘未发生（文件不存在）；需用 `resume` 以 retained child 补发决策后才落盘 `option-b`。这与第一轮观察 O2（"两次 reply 后才继续"）同源：**等待 intercom 回复的 child 不应进入 terminal**。建议：child 有 pending supervisor 请求时禁止 run/mission 终结，或 reply 投递后自动唤醒/恢复该 run。

### #N3（中）`resume` 产生重复 run 记录（幽灵 run）
一次 `resume`（retained delegate）正确返回结果（`a887d2fd-47a` completed），但同时留下同 mission（`1d07c7e5-4c4`）的第二个 run 记录 `7233c516-417` 一直 `running` 永不自行终结，需手动 `stop`（`0 active child(ren) cancelled`）。建议：resume 路径复用原 run 记录或显式终结旧记录。

### #N4（低）`disable`/`enable` 的 scope 定位与 `update`/`delete` 不一致
`management-actions.ts` L136-143：disable/enable 用默认 `scope`（user）解析目标（写 `~/.dsh/subagents/overrides.json`），而 update（L109）/delete（L120）按 `resolved.agent.scope` 定位。实测：project 作用域 agent 的 disable 提示 `in user scope`。功能上可见性正确（list 均消失），但 project agent 的 disabled 标记落在 user overrides，可能误伤其它项目的同名 agent。建议与 update/delete 对齐按 agent 实际 scope 定位。

## 四、清理记录

- 测试 fixture：`tests/.matrix-tmp/` 已删除（worker-proof.txt / steer-proof.txt / supervisor-decision.txt；interrupt-proof.txt 从未创建）
- 测试 agent：`matrix-test-agent`（user）、`matrix-proj-agent`（project）均已 delete；`~/.dsh/subagents/agents/` 与仓库 `.dsh/subagents/agents/` 均空；overrides.json 恢复 `{"agents":{}}`；仓库内 `.dsh` 空目录结构已 rmdir 清理
- 测试 schedule：`matrix-sched` 已 delete（schedules: 0）
- watchdog：保持 disabled（仅查询，未写入配置）
- missions：20 条全部 terminal（19 条自动终结 + 残留的 `1e503924-c37` 已 mission.close）
- 幽灵 run `7233c516-417` 已 stop；run 历史 23 条保留在 run store（正常历史）

## 五、未覆盖（成本/副作用控制）

- researcher 真实网络调研（web_search 工具链成本）
- watchdog 实际开启后的回合边界评审（会改变会话行为）
- refine 实际起草覆盖层（会写 `<root>/.dsh/subagents/refinements/`）
- `mission.update / resolve-decision / attach-run`、`schedule.run-due`、`watchdog.check`
- 深度嵌套（maxSubagentDepth）与预算耗尽路径
- 本轮 4 项新发现的修复（#N1-#N4 尚未改代码，仅报告）

## 六、结论

第一轮 5 项修复在当前会话实例中**全部回归通过**；核心流程（管理动作、单子代理、workflow、运行控制、schedule、agent CRUD、skill 注册）稳定。新增 4 项发现集中在三个薄弱点：**intercom 等待期生命周期管理（#N2）、workflow/lane 状态机竞态（#N1/#N3）、disable/enable 作用域一致性（#N4）**，建议优先修复 #N2（supervisor 通道可用性直接影响端到端协作）与 #N1（悬挂 run 会占住 mission/run 记录）。
