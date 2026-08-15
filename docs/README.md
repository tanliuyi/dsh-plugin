# dsh-plugins 文档

本目录是 dsh-plugins 仓库的文档中心，分为三部分：

| 目录 | 内容 | 维护方式 |
| --- | --- | --- |
| [`development/`](development/index.md) | **插件开发文档**：从零编写一个 dsh 插件（工具、配置、服务、事件、打包发布、测试） | 人工维护，约定变更时更新 |
| [`spec/`](spec/index.md) | **插件规范文档**：本仓库的包结构、命名、代码、文档与发布规范（机器可检查部分由脚本校验） | 人工维护，约定变更时更新 |
| [`plugins/INDEX.md`](plugins/INDEX.md) | **插件清单**：当前所有插件包的一览表与符合性检查报告 | **自动生成，禁止手改** |

## 文档同步机制

同步分两个方向，均由脚本维护、SKILL 驱动：

### 1. 上游变更同步（dsh 上游 → 本仓库）

dsh 上游（deepseek-harness）迭代很快，插件开发文档/契约会持续变化。`scripts/sync-upstream.mjs` 通过基线（`scripts/upstream-baseline.json`，记录上次同步的 commit SHA + 关注文件哈希）检测上游与插件开发相关文档的变更：

```sh
pnpm docs:upstream          # 检测变更 + 更新基线
pnpm docs:upstream:check    # 只检测（CI/巡检门禁）：有未同步变更则非零退出
```

检测到变更后，按 [`.agents/skills/sync-plugin-docs/SKILL.md`](../.agents/skills/sync-plugin-docs/SKILL.md) 评估影响并移植到 `docs/development/` 与 `docs/spec/`。

### 2. 本地同步（packages/ → 本仓库文档）

`scripts/sync-docs.mjs` 扫描 `packages/*` 下每个插件包的 `package.json` 与目录结构：

1. 重新生成 `docs/plugins/INDEX.md`（插件清单 + 规范符合性报告）；
2. 执行规范符合性检查：包命名、版本、README、bundle 声明、license 等；
3. `--check` 模式下任何漂移（包括 INDEX.md 过期）都会以非零退出码失败。

```sh
pnpm docs:sync    # 重新生成 + 检查（本地修改后运行）
pnpm docs:check   # 只检查（CI 门禁）
```

同步规则：

- **上游变了 → 移植文档**：运行 `pnpm docs:upstream`，按 SKILL 评估/移植到 `docs/development/` 与 `docs/spec/`，必要时同步更新 `packages/example-hello` 与本地插件包。
- **代码变了 → 同步清单**：新增、重命名、删除、改描述/版本/依赖的插件包，运行 `pnpm docs:sync`。
- **约定变了 → 同步文档**：本仓库的约定（目录布局、命名、代码风格、发布流程）变更时，必须同时更新 `development/` 与 `spec/` 中对应章节，保持两套文档一致。
- 自动化执行以上流程的完整指令见 [`.agents/skills/sync-plugin-docs/SKILL.md`](../.agents/skills/sync-plugin-docs/SKILL.md)。

## 参考资料（上游）

- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) — dsh 本体仓库
- 官方插件开发教程（`docs/user/develop/`）：[basic](https://github.com/deepseek-ai/deepseek-harness/tree/master/docs/user/develop/basic)、[framework](https://github.com/deepseek-ai/deepseek-harness/tree/master/docs/user/develop/framework)、[practice](https://github.com/deepseek-ai/deepseek-harness/tree/master/docs/user/develop/practice)
- [Cordis](https://github.com/cordiverse/cordis) — dsh 使用的插件框架
