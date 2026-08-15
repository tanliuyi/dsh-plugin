# 插件清单（自动生成）

> 本文件由 `scripts/sync-docs.mjs` 自动生成，**禁止手改**。重新生成：`pnpm docs:sync`。

## 包一览

| 包 | 版本 | 类型 | 描述 | 符合性 |
| --- | --- | --- | --- | --- |
| [@dsh-plugins/dsh-hermes-memory](../../packages/dsh-hermes-memory) | 0.1.0 | bundle | pi-hermes-memory 的 dsh 移植：持久记忆（MEMORY.md/USER.md/项目记忆）+ memory/session/skill 工具  | ✅ |
| [@dsh-plugins/dsh-subagents](../../packages/dsh-subagents) | 0.1.0 | bundle | pi-subagents 的 dsh 移植：子代理委派工具（subagents）、内置 agents、missions、workflows、后台运行、inter | ✅ |
| [@dsh-plugins/example-hello](../../packages/example-hello) | 0.1.0 | bundle | 示例插件：注册一个 greet 工具，演示工具注册、配置 Schema 与 Bundle 打包 | ✅ |

## 检查报告

### dsh-hermes-memory

- ✅ name：包名 @dsh-plugins/dsh-hermes-memory 必须匹配 @dsh-plugins/<kebab-case>
- ✅ 目录名：目录名 dsh-hermes-memory 必须等于包短名 dsh-hermes-memory
- ✅ version：version "0.1.0" 必须是合法 semver
- ✅ description：description 必须是非空字符串（规范要求一句话说明）
- ✅ type：type 必须是 "module"（当前 "module"）
- ✅ license：license 必须是合法 SPDX 表达式（当前 "MIT"）
- ✅ README：包必须提供 README.md（见 docs/spec/docs.md）
- ✅ scripts.build：必须提供 build 脚本（产出 lib/）
- ✅ scripts.test：必须提供 test 脚本（可为空用例但必须可运行）
- ✅ main：main 指向 lib/index.js（已构建）
- ✅ dsh.bundle.patch：patch ./cordis.patch.yml 存在

### dsh-subagents

- ✅ name：包名 @dsh-plugins/dsh-subagents 必须匹配 @dsh-plugins/<kebab-case>
- ✅ 目录名：目录名 dsh-subagents 必须等于包短名 dsh-subagents
- ✅ version：version "0.1.0" 必须是合法 semver
- ✅ description：description 必须是非空字符串（规范要求一句话说明）
- ✅ type：type 必须是 "module"（当前 "module"）
- ✅ license：license 必须是合法 SPDX 表达式（当前 "MIT"）
- ✅ README：包必须提供 README.md（见 docs/spec/docs.md）
- ✅ scripts.build：必须提供 build 脚本（产出 lib/）
- ✅ scripts.test：必须提供 test 脚本（可为空用例但必须可运行）
- ✅ main：main 指向 lib/index.js（已构建）
- ✅ dsh.bundle.patch：patch ./cordis.patch.yml 存在

### example-hello

- ✅ name：包名 @dsh-plugins/example-hello 必须匹配 @dsh-plugins/<kebab-case>
- ✅ 目录名：目录名 example-hello 必须等于包短名 example-hello
- ✅ version：version "0.1.0" 必须是合法 semver
- ✅ description：description 必须是非空字符串（规范要求一句话说明）
- ✅ type：type 必须是 "module"（当前 "module"）
- ✅ license：license 必须是合法 SPDX 表达式（当前 "MIT"）
- ✅ README：包必须提供 README.md（见 docs/spec/docs.md）
- ✅ scripts.build：必须提供 build 脚本（产出 lib/）
- ✅ scripts.test：必须提供 test 脚本（可为空用例但必须可运行）
- ✅ main：main 指向 lib/index.js（已构建）
- ✅ dsh.bundle.patch：patch ./cordis.patch.yml 存在

## 仓库结构与文档检查

- ✅ docs/README.md：文件缺失：docs/README.md
- ✅ docs/development/index.md：文件缺失：docs/development/index.md
- ✅ docs/spec/index.md：文件缺失：docs/spec/index.md
- ✅ .agents/skills/sync-plugin-docs/SKILL.md：文件缺失：.agents/skills/sync-plugin-docs/SKILL.md
- ✅ scripts/sync-docs.mjs：文件缺失：scripts/sync-docs.mjs
- ✅ scripts/sync-upstream.mjs：文件缺失：scripts/sync-upstream.mjs
- ✅ scripts/upstream-baseline.json：文件缺失：scripts/upstream-baseline.json

---

共 3 个包，检查 40 项，失败 0 项：✅ 全部通过
