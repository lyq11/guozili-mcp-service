# 项目框架文档

> 这份文档是给人(不是给 AI 客户端)看的项目全景 + 路线图，和 [README.md](../README.md)、[EASYEDA_MCP_ARCHITECTURE.md](EASYEDA_MCP_ARCHITECTURE.md)、[EASYEDA_MCP_TOOLS.md](EASYEDA_MCP_TOOLS.md) 不冲突——那几份讲"怎么用/协议细节"，这份讲"整体骨架 + 哪块归哪个文件 + 接下来打算怎么改"。

## 怎么维护这份文档

- 每个模块表格是活的：改了实现就顺手改"实现路径"列，别等攒一堆再补。
- 路线图表格按"状态"排序，做完的条目移到底部的"已完成"里，别删掉——留个记录方便回头看当初为什么这么改。
- 新增模块/新的改进想法，直接在对应表格加一行，不用重新组织全文。
- 文末的"文档变更记录"只记这份文档本身的结构性调整（比如新增了一个大章节），不记内容小改动。

---

## 1. 项目定位

果子狸MCP服务：把嘉立创 EDA 专业版(LCEDA Pro)的原理图/PCB 操作，通过 MCP 协议暴露给 AI 客户端。核心约束：**没有任意代码执行通道**，所有能力必须显式出现在 MCP Schema + 扩展能力清单 + 扩展处理器三处，缺一处直接拒绝。

## 2. 架构总览

```
AI 客户端 ──MCP stdio──▶ src/server.mjs (本机 MCP 服务, ws://127.0.0.1:49620-49629)
                              │ RPC v1 (握手 + token + 超时)
                              ▼
                    easyeda-extension/ (装进 EDA 专业版的扩展)
                              │ 固定处理器 handlers.ts
                              ▼
                        eda.* 官方 API
```

协议细节、握手格式、备份策略见 [EASYEDA_MCP_ARCHITECTURE.md](EASYEDA_MCP_ARCHITECTURE.md)；完整工具参数见 [EASYEDA_MCP_TOOLS.md](EASYEDA_MCP_TOOLS.md)。

## 3. 功能模块清单

### 3.1 MCP 服务侧 (`src/`)

| 模块 | 职责 | 实现路径 | 测试 |
| --- | --- | --- | --- |
| MCP 入口 / 工具注册 | 启动 stdio 服务、注册所有 MCP 工具、WebSocket 监听 | [server.mjs](../src/server.mjs) | 无直接单测，靠 `test:smoke` 间接覆盖 |
| RPC 客户端 | 与扩展握手、发送 RPC、超时/重试 | [rpc-server.mjs](../src/rpc-server.mjs) | [test/rpc-server.mjs](../test/rpc-server.mjs) |
| 工程/原理图缓存 | 缓存工程结构、页面、网络索引 | [project-cache.mjs](../src/project-cache.mjs) | [test/project-cache.mjs](../test/project-cache.mjs) |
| 页面占用网格 | 分层二维占用网格，找空白区域 | [page-occupancy.mjs](../src/page-occupancy.mjs) | [test/page-occupancy.mjs](../test/page-occupancy.mjs) |
| PIN 朝向推断 | 判断 PIN 在器件的哪一侧，供建端口用 | [pin-layout.mjs](../src/pin-layout.mjs) | [test/pin-layout.mjs](../test/pin-layout.mjs) |
| 原理图可读性检查 | 密度、交叉连线、端口朝向 | [readability.mjs](../src/readability.mjs) | **无单测** |
| 事务/备份序列化 | 写操作串行化、会话级安全点 | [transactions.mjs](../src/transactions.mjs) | **无单测** |
| PCB 缓存 | 缓存关联 `[main]` 原理图的 PCB Board | [pcb-cache.mjs](../src/pcb-cache.mjs) | [test/pcb-cache.mjs](../test/pcb-cache.mjs) |
| PCB 分析 | 未布线网络、游离导线、板框完整性、封装重叠、板外器件等检查 | [pcb-analysis.mjs](../src/pcb-analysis.mjs) | [test/pcb-analysis.mjs](../test/pcb-analysis.mjs) |
| PCB 器件布局规划 | 对齐/等间距分布/栅格吸附的纯规划 | [pcb-layout.mjs](../src/pcb-layout.mjs) | [test/pcb-policy-layout.mjs](../test/pcb-policy-layout.mjs) |
| PCB 网络走线策略规划 | 按网络名/glob 批量规划走线线宽/层/锁定 | [pcb-policy.mjs](../src/pcb-policy.mjs) | [test/pcb-policy-layout.mjs](../test/pcb-policy-layout.mjs) |
| PCB 工具注册 | 注册 `pcb_*` 系列 MCP 工具（现 33 个） | [pcb-tools.mjs](../src/pcb-tools.mjs) | 依赖上面几个模块的测试间接覆盖；`test:tools` 冒烟校验工具注册 |

### 3.2 扩展侧 (`easyeda-extension/src/`)

| 模块 | 职责 | 实现路径 | 测试 |
| --- | --- | --- | --- |
| 扩展入口 | 生命周期、状态悬浮框、端口扫描 | [index.ts](../easyeda-extension/src/index.ts) | 无 |
| RPC 处理器 | 读取 + PCB/原理图操作的校验入口分发 | [handlers.ts](../easyeda-extension/src/handlers.ts) | 无直接单测；PCB 操作的实际逻辑已搬到下面的 `pcb-operations.ts` 并有单测 |
| **PCB 操作注册表** | 每个 PCB operation 一条 `{validate, apply}`，取代原来两条 else-if 链 | [pcb-operations.ts](../easyeda-extension/src/pcb-operations.ts) | [test/pcb-operations.mjs](../easyeda-extension/test/pcb-operations.mjs)（测全部 operation 的 `validate()`） |
| PCB 图元序列化 | `eda.*` 图元 → JSON，`handlers.ts` 和 `pcb-operations.ts` 共用 | [pcb-serialize.ts](../easyeda-extension/src/pcb-serialize.ts) | 无直接单测，靠上面两处的间接覆盖 |
| PCB 叠层设置 | 铜层数/物理叠层配置/内层命名的实际执行 | [pcb-stackup.ts](../easyeda-extension/src/pcb-stackup.ts) | 无直接单测 |
| 板框几何编译 | 矩形/多边形高层描述 → 直线+圆弧图元（含圆角） | [board-outline.ts](../easyeda-extension/src/board-outline.ts) | [test/board-outline.mjs](../easyeda-extension/test/board-outline.mjs) |
| 协议常量 | 握手 token、协议版本、`CAPABILITIES` 白名单 | [protocol.ts](../easyeda-extension/src/protocol.ts) | 无 |
| 焊盘归属判定 | 从全部焊盘中区分"独立焊盘" vs "属于某器件的焊盘" | [pad-classification.ts](../easyeda-extension/src/pad-classification.ts) | [test/pad-classification.mjs](../easyeda-extension/test/pad-classification.mjs) |

---

## 4. 路线图 / 待改进

| # | 问题 | 影响 | 实现路径（怎么做） | 优先级 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 1 | `readability.mjs`、`transactions.mjs`、`server.mjs` 无单元测试 | 出问题不会被常规命令发现，只能等联机冒烟测试才暴露 | 参照 `test/pcb-analysis.mjs` 的模式，给 `readability.mjs` 构造假 snapshot 写 `test/readability.mjs`；给 `transactions.mjs` 测序列化顺序/异常路径；`server.mjs` 里可抽取的纯函数（如 operation 展开逻辑）拆到独立模块，脱离真实 EDA 连接单测 | 中 | 待办 |
| 2 | `easyeda-extension` 的 `tsc --noEmit` 没接入自动化流程 | 类型错误可能长期留在工作区（已发生过一次：`getState_ParentComponentPrimitiveId` 不存在） | 根目录加一个 `"verify"` script：`npm run check && npm run test:pcb && npm run test:pin-layout && npm run test:occupancy && npm run test:cache && npm run test:rpc && cd easyeda-extension && npm run check && npm test`；README 里注明发 PR 前先跑 `npm run verify` | 高 | **部分完成**：根 `package.json` 的 `check` script 现在末尾串了 `npm --prefix easyeda-extension run check`，`npm run check` 已能捕获扩展侧的 tsc 错误（已用 PowerShell 验证跑通）。剩下的缺口：还没有一个把 `check` + 全部 `test:*` + 扩展 `npm test` 串起来的统一 `verify` 命令，README 也还没写"发 PR 前先跑什么" |
| 3 | 没有 CI | 全靠人肉记得跑测试，容易漏 | 新增 `.github/workflows/ci.yml`，PR/push 时跑 `#2` 里那条 `verify` 流程 | 中 | 待办 |
| 4 | 版本号要在 4 个文件手动同步（`package.json`、`package-lock.json`、`easyeda-extension/extension.json`、`easyeda-extension/package.json`） | 容易漏改/改错，`CHANGELOG` 和实际版本号对不上 | 写 `scripts/bump-version.mjs`，传入新版本号后同时改 4 个文件的 `version` 字段，再跑一次 `npm install` 刷新 lockfile | 低 | 待办 |
| 6 | 仓库卫生：根目录 `.codex-easyeda-inspect.mjs` 是一次性调试脚本（硬编码了具体器件位号），`.claude/` 目录未跟踪也未 `.gitignore` | 容易被 `git add -A` 误提交进正式历史 | 决定 `.codex-easyeda-inspect.mjs` 是否要保留成通用工具：保留则参数化（器件位号/半径走 argv）并移到 `scripts/` 纳入版本控制；不需要则删除。`.claude/` 视情况加进 `.gitignore` | 低 | 待办 |

### 已完成

| # | 问题 | 完成方式 | 完成日期 |
| --- | --- | --- | --- |
| 0 | `standalonePads` 判定依赖不存在的 `getState_ParentComponentPrimitiveId` API，导致器件焊盘被重复计入独立焊盘 | 抽出 [pad-classification.ts](../easyeda-extension/src/pad-classification.ts) 的 `standalonePadIds()`，用 `components.getAllPins()` 反查代替不存在的 API，并补了对应单测 | 2026-07-21 |
| 7 | PCB 写操作"写死"：当时 12 种 operation 分散在 `pcb-tools.mjs` 的判别联合、`handlers.ts` 的 `ALLOWED_PCB_OPERATIONS` 白名单、`validatePcbOperations`/`applyPcbOperations` 两条 ~230 行的 `else if` 链，四处手动同步 | 新增 [pcb-operations.ts](../easyeda-extension/src/pcb-operations.ts) 注册表（每个操作一个 `{validate, apply}` 条目，白名单从注册表 key 派生，不再手动维护），配套抽出 [pcb-serialize.ts](../easyeda-extension/src/pcb-serialize.ts)、[pcb-stackup.ts](../easyeda-extension/src/pcb-stackup.ts) 避免循环引用；`pcb-tools.mjs` 的判别联合也改成从 `PCB_OPERATION_SCHEMAS` 数组派生。新增 [easyeda-extension/test/pcb-operations.mjs](../easyeda-extension/test/pcb-operations.mjs) 直接单测 `validate()`（无需连接 EasyEDA）。`tsc --noEmit`、扩展 `npm test`、`npm run test:tools`（真实启动 MCP 子进程校验全部 `pcb_*` 工具注册）均通过。**后续验证**：注册表落地后又加了 `delete_board_outline`/`replace_board_outline` 两种操作（现共 14 个 key），确认按 [DEVELOPMENT.md](DEVELOPMENT.md) §6.1 的"两处改动"流程能顺利扩展，没有退回旧模式——`pcb_*` 工具数从 27 涨到 33 | 2026-07-21 |
| 5 | `findDanglingTracks` 是 O(n²) 两两比较线段 | 先按 `(net, layer)` 分组，组内按 bounds.left 排序做 sweep，超出 `bounds.right + tolerance` 即 break，另加 y 轴 bbox 早退；pad/via 触碰检查也按 net 分组 + bbox 早退。新增 `comparisonStats` 输出供观测实际比较对数。4000 条随机走线（20 个 net/layer 分组）实测 ~6.6ms；300 组随机布局与 O(n²) 暴力参考实现比对分组结果一致，无回归 | 2026-07-21 |

---

## 5. 版本记录索引

- 根服务：[CHANGELOG.md](../CHANGELOG.md)
- 扩展：[easyeda-extension/CHANGELOG.md](../easyeda-extension/CHANGELOG.md)

---

## 文档变更记录

- 2026-07-21：创建本文档，梳理模块清单和路线图初版。
- 2026-07-21：新增 `pcb_delete_board_outline`/`pcb_replace_board_outline` 工具后，模块清单加上 `pcb-layout.mjs`、`pcb-policy.mjs`、`pcb-operations.ts`、`pcb-serialize.ts`、`pcb-stackup.ts`、`board-outline.ts` 六个文件；路线图 #7 补充注册表扩展到 14 个操作、`pcb_*` 工具涨到 33 个的验证记录。
