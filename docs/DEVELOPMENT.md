# 开发文档：代码地图与交接指南

> 面向对象：**接手写代码的人**，不是 AI 客户端也不是终端用户。
> - 想知道"有哪些 MCP 工具、参数怎么填" → 看 [EASYEDA_MCP_TOOLS.md](EASYEDA_MCP_TOOLS.md)。
> - 想知道"协议怎么握手、备份策略细节" → 看 [EASYEDA_MCP_ARCHITECTURE.md](EASYEDA_MCP_ARCHITECTURE.md)。
> - 想知道"现在还差什么、下一步做什么" → 看 [PROJECT_FRAMEWORK.md](PROJECT_FRAMEWORK.md)。
> - 这份文档回答的是："代码在哪、每个文件负责什么、改一个东西要碰几个地方"。

---

## 0. 如果你是第一次接手，按这个顺序做

1. 读一遍本文档的第 1、2、3 节（20 分钟），建立"调用链路"的心智模型——这是整个项目唯一需要先理解、不能跳过的部分。
2. 跑一遍第 4 节的验证命令，确认环境是好的。
3. 打开 [PROJECT_FRAMEWORK.md](PROJECT_FRAMEWORK.md) 的"路线图"表格，看当前还有哪些已知问题待办。
4. 需要改动时，先在第 6 节找到你要碰的文件属于哪一类（新增整条能力 / 新增一种 operation / 改分析算法 / 改前端交互），照对应的 checklist 走。

---

## 1. 项目一句话

把 LCEDA Pro（嘉立创 EDA 专业版）的原理图 / PCB 操作，通过白名单 RPC 暴露成 MCP 工具，给 AI 客户端调用。核心约束：**没有任意代码执行通道**——新增能力必须显式出现在三处（MCP 参数 Schema、扩展能力清单 `CAPABILITIES`、扩展处理器 `handlers` 映射表），少一处就会被拒绝。

## 2. 两个包，各自的职责

```
仓库根目录                          easyeda-extension/
├─ src/                             ├─ src/
│  ├─ server.mjs      MCP 入口       │  ├─ index.ts       扩展生命周期 + UI
│  ├─ rpc-server.mjs  WS 服务端       │  ├─ handlers.ts    白名单方法实现（读取/校验/执行入口）
│  ├─ pcb-tools.mjs   PCB 工具注册    │  ├─ pcb-operations.ts  PCB 写操作注册表（validate+apply）
│  ├─ pcb-analysis.mjs PCB 纯函数分析 │  ├─ pcb-serialize.ts   PCB 图元序列化（handlers.ts 和 pcb-operations.ts 共用）
│  ├─ pcb-layout.mjs  器件对齐/分布/栅格 │  ├─ pcb-stackup.ts     叠层设置（createPcbFromSchematic 和 set_stackup 共用）
│  ├─ pcb-policy.mjs  批量网络走线策略 │  ├─ board-outline.ts   板框几何编译（矩形/多边形→直线+圆弧）
│  ├─ pcb-cache.mjs   PCB 快照缓存    │  ├─ pad-classification.ts  焊盘归属判定
│  ├─ project-cache.mjs 原理图缓存   │  ├─ protocol.ts    握手常量 + 能力清单
│  ├─ page-occupancy.mjs 占用网格    │  └─ test/          board-outline.mjs / pad-classification.mjs / pcb-operations.mjs
│  ├─ pin-layout.mjs  PIN 朝向推断
│  ├─ readability.mjs 可读性评分
│  └─ transactions.mjs 写操作串行化
└─ test/
```

- **根目录**跑在开发者本机，是普通 Node.js 进程，`node --test` 能直接测大部分逻辑，不需要打开 EasyEDA。
- **`easyeda-extension/`** 编译成 `.eext` 装进 EasyEDA 专业版本体，只能通过 `tsc --noEmit` 做类型检查，真正的运行时行为必须在 EasyEDA 里手动验证（`npm run test:smoke` 需要联机）。

## 3. 一次工具调用的完整路径

以 `pcb_modify_tracks` 为例，这是所有"写"类工具共用的模式：

```
AI 客户端调用 MCP 工具 pcb_modify_tracks
        │
        ▼
src/pcb-tools.mjs   zod 校验入参 → 包成 { type: "modify_tracks", pcbUuid, changes }
        │
        ▼
src/server.mjs 的 execute()/writes.serialize()   同一 MCP 会话内的写操作排队执行
        │  bridge.call("pcb.operations.validate", …)
        ▼
easyeda-extension/src/handlers.ts
   validatePcbOperations()  先用缓存的快照做预检（网络存在？层合法？ID 存在？）
        │  校验通过后
        │  bridge.call("pcb.operations.apply", …)
        ▼
   applyPcbOperations()     首次写入先建 [backup] 副本 → 逐条调用 eda.pcb_* API → save()
        │
        ▼
   返回结果沿原路径传回 MCP → AI 客户端
```

只读工具（如 `pcb_inspect`）省略校验和备份两步，直接 `bridge.call` 对应的读方法。

## 4. 5 分钟验证环境

```powershell
npm install
npm run check                       # node --check 全部 .mjs + 顺带跑 easyeda-extension 的 tsc --noEmit
npm run test:pcb                    # pcb-analysis.mjs / pcb-cache.mjs
npm run test:pin-layout
npm run test:occupancy
npm run test:cache
npm run test:rpc

cd easyeda-extension
npm install
npm run check                       # tsc --noEmit
npm test                            # test/pad-classification.mjs
```

> Windows 提示：在 git-bash 里直接跑 `npm run xxx` 有时会报 `'node' 不是命令`——这是 git-bash/cmd 的 PATH 转发问题，不是代码问题。改用 PowerShell 或者直接调用 `node_modules/.bin/xxx` 就正常。

需要联机验证真实 EasyEDA 行为时，装好扩展、打开一份原理图，再跑：

```powershell
npm run test:smoke        # 或 --tools-only 只检查工具注册，不做真实写入
```

## 5. 核心模块函数索引

### 5.1 `src/server.mjs`（MCP 入口）

不导出函数；职责是拼装整个 MCP Server：

- 直接 `server.registerTool(...)` 注册的原理图只读/复合工具：`easyeda_health`、`schematic_list_pages`、`schematic_inspect_page`、`schematic_get_component_inventory`、`schematic_inspect_region`、`schematic_get_page_occupancy`、`schematic_find_free_regions`、`component_search`、`schematic_analyze_readability`、`schematic_apply_operations`、`schematic_run_drc`。
- `executeOperations(operations, reason)`：所有原理图写工具共用的唯一执行入口——展开 `create_port_for_pin` 之类的高层操作、预检、逐条串行调用插件、写完刷新占用缓存/工程目录缓存。
- `registerWriteTool(name, description, inputSchema, buildOperations)`：把"简洁参数 → operation 数组"的转换函数包成一个直接写工具，16 个 `schematic_*` 写工具都是这样注册出来的（`schematic_rename_page`、`schematic_place_components`、`schematic_create_wires`……）。
- 末尾调用 `registerPcbTools({...})` 挂载 PCB 侧工具。

### 5.2 `src/pcb-tools.mjs`

`registerPcbTools({ server, z, bridge, writes, projectCache, pcbCache, toolResult, toolError })`：定义 PCB 侧全部 zod schema（`transform`、`track`、`via`、`pad`、`pour`、`boardOutline`……）。**`PCB_OPERATION_SCHEMAS`** 是一个 `{ type, schema }` 数组，每个 PCB 写操作一条；`operation` 判别联合由 `PCB_OPERATION_SCHEMAS.map(entry => entry.schema)` 派生，不再手写数组（新增操作只加一条 `PCB_OPERATION_SCHEMAS` 记录，见 §6.1）。注册全部 33 个 `pcb_*` 工具，写工具共享内部 `execute(operations, reason)`，逻辑与 `server.mjs` 的 `executeOperations` 同构，但走 `pcb.operations.*` 而不是 `operations.*`。

### 5.3 `src/pcb-analysis.mjs`（纯函数，无副作用，最值得读）

| 函数 | 作用 |
| --- | --- |
| `boardBounds(snapshot)` | 从板框图元算外包矩形 |
| `findComponentOverlaps(snapshot, {clearance})` | 同层封装包围盒重叠检测 |
| `findOutsideComponents(snapshot, {margin})` | 板外器件检测 |
| `findBoardOutline(snapshot)` | 汇总 Board Outline 层的直线/圆弧/折线和外包边界 |
| `checkBoardOutline(snapshot, {tolerance})` | 按端点拓扑判断板框是否闭合；折线闭合性单独报告，无法解码时返回 `indeterminate` 而不是瞎猜 |
| `planComponentsBySchematicPage(snapshot, schematicComponents, options)` | 按原理图页分组，生成器件搬移到的目标坐标（纯规划，不落地） |
| `findDanglingTracks(snapshot, {tolerance, includeLocked})` | 找不接触任何焊盘/过孔的游离直线走线岛。内部 `connectedTrackGroups()` 先按 `(net, layer)` 分组再做 sweep-line 包围盒预筛，避免 O(n²) |
| `findUnroutedNets(snapshot, {tolerance})` | 按并查集判断每个网络的焊盘是否全部连通 |
| `compareSchematicToPcb(schematicComponents, snapshot, schematicNetNames)` | 原理图 vs PCB 的位号/属性/网络一致性比对 |
| `inspectWholeBoard(snapshot, options)` | 汇总以上几个检查，`pcb_check` 工具的实现 |

`allPads(snapshot)` 是内部辅助函数：把 `components[].pads` 和顶层 `standalonePads` 合并成统一列表，几乎所有分析函数都靠它拿"全部焊盘"。**改焊盘相关逻辑时先看这个函数**，它决定了什么算一个焊盘。

### 5.4 `src/pcb-layout.mjs`（纯函数，`pcb_arrange_components` 的实现）

`planComponentArrangement(snapshot, componentIds, arrangements, {includeLocked})`：对给定器件顺序依次执行对齐（`align`：左/右/上/下/水平居中/垂直居中）、等边缘间距分布（`distribute`：水平/垂直）、栅格吸附（`snap_to_grid`），返回目标坐标的纯规划（不落地）。`pcb_arrange_components` 工具默认 `apply=false` 只预览，`apply=true` 才把规划结果包成 `transform_components` operation 真正写入。

### 5.5 `src/pcb-policy.mjs`（纯函数，`pcb_apply_net_track_policy` 的实现）

`planNetTrackPolicy(snapshot, options)`：按精确网络名或 glob 匹配网络，对其名下全部直线/圆弧/折线走线统一规划新的线宽/层/锁定状态，返回 `modify_tracks` 需要的 `changes` 数组（同样是纯规划，`apply=true` 才真正写入）。

### 5.6 缓存层

- **`src/pcb-cache.mjs` `PcbCache`**：只缓存关联 `[main]` 原理图、名字不含 `[backup]` 的 PCB Board。`getSnapshot({refresh})` 惰性拉取并缓存 `pcb.inspect` 结果；`status()` 返回器件/焊盘/网络/走线计数摘要。
- **`src/project-cache.mjs` `ProjectCache`**：缓存工程目录结构、图页列表、器件索引和网络名索引。`getPage`/`getComponentInventory`/`getNets` 是主要读接口；`refreshPages`/`rebuildCatalog` 在写操作后按需失效。

### 5.7 `src/page-occupancy.mjs`

`PageOccupancyGrid`：把一个原理图页映射成行优先 `Uint8Array` 占用网格（器件/导线/端口/计划占用/图框边缘/标题栏六个位掩码层）。`findFreeRectangles()` 是 `schematic_find_free_regions` 的核心算法。`PageOccupancyCache` 按页面指纹（器件坐标/旋转/镜像/BBox + 导线）做失效判断。

### 5.8 `src/pin-layout.mjs`

`inferPinLayout(component)` 判断器件是单侧/两侧/三侧/四侧布局，`planPortForPin(component, pinNumber, options)` 是 `create_port_for_pin` 高层操作的几何规划器（选边、避障候选、评分）。纯几何计算，不调用任何 `eda.*` API，因此可以在 MCP 侧完成而不需要升级扩展权限。

### 5.9 `src/readability.mjs`

`analyzeReadability(page)`：端口密度、零长度导线、器件拥挤、正交导线交叉打分，`schematic_analyze_readability` 的实现。**目前没有单元测试**（见 [PROJECT_FRAMEWORK.md](PROJECT_FRAMEWORK.md) 路线图 #1）。

### 5.10 `src/transactions.mjs`

`WriteCoordinator.serialize(callback)`：把并发写调用排成一条队列，保证同一时刻只有一条写操作在跟插件交互。`summarizeOperations(operations)` 生成 `{operationCount, counts, affectedPageUuids}` 摘要，用在每次写工具的返回值里。**也没有单元测试**。

### 5.11 `src/rpc-server.mjs` `EasyEdaRpcServer`

只绑定 `127.0.0.1`，扫描端口、握手鉴权（`constantTimeEqual` 防时序攻击）、维护多窗口连接表。`call(method, params, {windowId})` 是 MCP 侧发起 RPC 的唯一入口；`status()` 返回已连接窗口列表。`debug`/`logger` 构造参数控制诊断日志（详见 §7 Debug 开关）。**唯一有完整单测的核心模块**，改协议相关逻辑之前先看 `test/rpc-server.mjs` 怎么模拟插件端。

### 5.12 `easyeda-extension/src/protocol.ts`

握手常量：`SERVICE_ID`、`PROTOCOL_VERSION`、端口范围、`AUTH_TOKEN`、**`CAPABILITIES` 白名单数组**。新增一条全新 RPC 方法（不是新增 operation 类型）必须先在这里加一行。

### 5.13 `easyeda-extension/src/pcb-operations.ts`（PCB 写操作注册表，改 PCB 操作先看这里）

`PCB_OPERATIONS: Record<string, PcbOperationDefinition>`：每个 PCB operation `type` 一条 `{ validate, apply }`，替代了曾经两条各 ~230 行的 `else if` 链（那次重构的完整背景见 [PROJECT_FRAMEWORK.md](PROJECT_FRAMEWORK.md) 路线图"已完成 #7"，逐步思路见仓库根目录的 [AI-dis.md](../AI-dis.md)）。当前 12 个 key：`transform_components`、`create_board_outline`、`delete_board_outline`、`replace_board_outline`、`create_track`、`create_via`、`modify_tracks`、`modify_vias`、`set_stackup`、`create_pad`、`create_pour`、`delete_tracks`、`rebuild_pours`、`import_schematic_changes`（发文档时数了一遍，实际以 `Object.keys(PCB_OPERATIONS)` 为准）。

- `PcbOperationContext`：`validate()` 用的共享只读上下文（`componentIds`/`netNames`/`layerIds`/`copperLayerIds`/`copperLineIds`/`copperTrackIds`/`boardOutlineIds`/`viaById`/`pourIds`/`board`），由 `handlers.ts` 的 `buildPcbOperationContext()` 每次校验前算一次。
- `apply(operation)` **不带** `ctx` 参数——没有一个操作的执行阶段需要用到校验阶段算好的集合，都是现查现验（例如 `modify_tracks` 直接 `eda.pcb_PrimitiveLine.get(id)` 取当前状态）。
- `delete_board_outline`/`replace_board_outline` 复用了同文件里的 `getBoardOutlinePrimitiveRefs`/`deleteBoardOutlinePrimitiveRefs`/`createBoardOutlinePrimitives` 三个辅助函数；`replace_board_outline` 是"先创建新轮廓、再删旧轮廓"，创建失败会自动回滚已创建的新图元（不会留下半成品轮廓）。
- 对应单测：[easyeda-extension/test/pcb-operations.mjs](../easyeda-extension/test/pcb-operations.mjs)，只测 `validate()`（不需要连接 EasyEDA，因为 validate 不碰 `eda.*`——除了 `create_pour` 会调 `eda.pcb_MathPolygon.createPolygon`，测试里用一个最小 `globalThis.eda` 桩顶上）。**测试目前只覆盖了注册表最初的 12 个操作，`delete_board_outline`/`replace_board_outline` 后加的，还没补对应用例**——照抄文件里现成的 `assertValid`/`assertInvalid` 模式加两组就行。

### 5.14 `easyeda-extension/src/pcb-serialize.ts`

`serializePcbPad/Line/Arc/Polyline/Via/Pour`、`primitiveBBox`、`polygonSource`：把 `eda.*` 图元对象转成 JSON。`handlers.ts` 的只读路径（`inspectPcb` 等）和 `pcb-operations.ts` 的写操作结果序列化都从这里导入，避免两边各写一份、也避免 `handlers.ts` ↔ `pcb-operations.ts` 循环引用。

### 5.15 `easyeda-extension/src/pcb-stackup.ts`

`VALID_COPPER_LAYER_COUNTS`、`applyPcbStackupSettings(rawSettings)`：叠层设置的实际执行逻辑。被 `handlers.ts` 的 `createPcbFromSchematic`（建板时可选叠层）和 `pcb-operations.ts` 的 `set_stackup` 操作共用。

### 5.16 `easyeda-extension/src/board-outline.ts`

`BOARD_OUTLINE_LAYER`（=11）、`compileBoardOutline(rawOutline)`：把矩形/多边形的高层描述编译成具体的直线+圆弧图元列表（含圆角计算），供 `create_board_outline`/`replace_board_outline` 使用。纯几何函数，不碰 `eda.*`。

### 5.17 `easyeda-extension/src/handlers.ts`（读取 + 校验/执行入口，按功能分类看）

- **读取**：`systemHealth`、`listPages`、`listPcbBoards`、`inspectPcb`、`inspectPcbRegion`、`inspectPage`、`searchComponents`、`serializePcbComponent`（其余序列化函数已搬到 `pcb-serialize.ts`，见 5.14）。
- **PCB 校验/执行**：`buildPcbOperationContext(board)` 建 `PcbOperationContext` → `validatePcbOperations`/`applyPcbOperations` 查 `PCB_OPERATIONS` 注册表并委托，本身不再包含任何具体操作的逻辑（详见 5.13）。
- **原理图校验/执行**：`validateOperations`/`applyOperations`——**仍是**按 `type` 的 `else if` 链（16 种操作），还没做注册表化，是 [PROJECT_FRAMEWORK.md](PROJECT_FRAMEWORK.md) 路线图里明确写的下一步候选。
- **备份**：`ensureSessionBackup`/`ensureSessionPcbBackup`——按 `sessionId:documentUuid` 做幂等的会话级备份。
- **`dispatch(method, params)`**：唯一入口，查 `handlers` 映射表，查不到直接抛错——这是"不存在任意代码执行"的最后一道闸门。

### 5.18 `easyeda-extension/src/index.ts`

扩展生命周期（`activate`/`deactivate`）、菜单命令（`reconnect`/`stopConnection`/`configurePort`/`toggleDebug`/`about`/`showStatusPanel`）、状态悬浮框渲染、端口扫描重连（`scanAndConnect`/`tryPort`）。这是唯一有 UI 交互的文件，改动后**必须**装进真实 EasyEDA 里点一遍菜单验证，`tsc --noEmit` 只能保证类型对，不保证界面行为对。

### 5.19 `easyeda-extension/src/pad-classification.ts`

`standalonePadIds(allPadIds, componentPadIdGroups)`：从全部焊盘 ID 里排除已知属于某器件的焊盘 ID，得到"独立焊盘"。这个文件是从一次真实 bug 里拆出来的——之前直接用一个不存在的 API 方法判断焊盘归属，参见 [PROJECT_FRAMEWORK.md](PROJECT_FRAMEWORK.md) 路线图"已完成 #0"。

---

## 6. 新增一个能力时该碰哪几个文件

项目里"新增能力"分两种，touch 的文件数不一样，别混淆。

### 6.1 新增一种 PCB operation（走 `pcb.operations.apply` 这条已有通道，`pcb-operations.ts` 注册表化之后）

例子：新增 `pcb_modify_tracks`。两个必改的地方（比注册表化之前的 4 处少了一半，白名单和分支链都是自动派生的，不用再单独改）：

1. `src/pcb-tools.mjs`：加 zod shape（如 `trackChange`），在 `PCB_OPERATION_SCHEMAS` 数组里加一条 `{ type: "modify_tracks", schema: z.object({ type: z.literal("modify_tracks"), ... }) }`，再 `server.registerTool("pcb_modify_tracks", {...})` 包一个直接工具。
2. `easyeda-extension/src/pcb-operations.ts`：在 `PCB_OPERATIONS` 里加一条 `modify_tracks: { validate(...), apply(...) }`。`validate` 只读 `ctx`（不碰 `eda.*`，除非像 `create_pour` 那样确实需要现查一个几何对象），`apply` 现查现验目标图元、调用 `eda.pcb_Primitive*.modify(...)`、返回结果值（存/校验/error 抛出交给 `handlers.ts` 的薄封装统一处理，不用在这里管）。

**不需要改** `easyeda-extension/src/handlers.ts`——白名单和调度都是从 `PCB_OPERATIONS`/`PCB_OPERATION_SCHEMAS` 派生的。

顺手加测试：`easyeda-extension/test/pcb-operations.mjs` 里对新操作的 `validate()` 补一个合法 + 一个非法用例（模式抄现成的那几个）。

再加文档：`docs/EASYEDA_MCP_TOOLS.md` 补一条工具说明，`CHANGELOG.md`/`easyeda-extension/CHANGELOG.md` 各加一条，四处版本号（`package.json`、`package-lock.json`、`easyeda-extension/package.json`、`easyeda-extension/extension.json`）同步（目前是手动做，见 [PROJECT_FRAMEWORK.md](PROJECT_FRAMEWORK.md) 路线图 #4）。

> 原理图侧的 `operations.apply` 通道**还没有**做同样的注册表化——`validateOperations`/`applyOperations` 仍是手写的 `else if` 链，新增一种原理图 operation 目前还是要碰 `ALLOWED_OPERATIONS` 白名单 + 两条分支链，和这里描述的 PCB 流程不一样。这个不一致是已知的、故意先不做的（见 [PROJECT_FRAMEWORK.md](PROJECT_FRAMEWORK.md) 路线图），别假设两边现在是同一套模式。

### 6.2 新增一条全新 RPC 方法（不复用 operations 通道，比如 `pcb.create`）

三个必改的地方（架构文档里说的"三处显式定义"）：

1. `easyeda-extension/src/protocol.ts`：`CAPABILITIES` 数组加一行方法名。
2. `easyeda-extension/src/handlers.ts`：写实现函数，塞进 `handlers` 映射表。
3. MCP 侧（`src/server.mjs` 或 `src/pcb-tools.mjs`）：新增或复用一个工具，内部 `bridge.call("新方法名", params)`。

任何一处漏掉，`dispatch()` 会直接抛 `RPC method is not allowed`，或者 MCP 侧压根没有工具能触发它——这是设计上刻意的，不是 bug。

### 6.3 改分析算法（`pcb-analysis.mjs` / `pcb-layout.mjs` / `pcb-policy.mjs` / `page-occupancy.mjs` / `pin-layout.mjs` / `readability.mjs`）

这几个是纯函数模块，不碰 `eda.*` API，改完直接 `node --test test/xxx.mjs` 就能验证，不需要打开 EasyEDA。**优先在这一层加逻辑**，能不碰 `handlers.ts` 就不碰——`handlers.ts` 的每一行都跑在插件沙箱里，出错只能靠联机调试，成本高得多。

---

## 7. 关键约定 / 容易踩的坑

- **PCB 坐标和尺寸单位固定是 mil**，别的地方传公制单位过来要先转换。
- **写操作全部串行化**（`WriteCoordinator`），但一组 operation 在 EasyEDA 内不是数据库事务——中途失败前序可能已保存，靠会话备份人工恢复，不会自动回滚。
- **首次写入自动建备份**：原理图按 `sessionId:schematicUuid`，PCB 按 `sessionId:pcbUuid`，键相同就复用备份不再复制。
- **Debug 日志开关**：EasyEDA 菜单"开启/关闭 Debug 日志"或环境变量 `EASYEDA_MCP_DEBUG=1`。前者是"这一个窗口"级别，后者是"MCP 进程全局"级别；两个都会对 token 脱敏、对超长载荷截断到 4000 字符。
- **Windows + git-bash 跑 npm 脚本可能报 `'node' 不是命令`**：这是 shell 转发问题，换 PowerShell 或者直接调用 `node_modules/.bin/` 下的可执行文件。
- **改 `easyeda-extension` 记得跑 `npm run check`（tsc）**：根目录的 `npm run check` 现在会自动 `npm --prefix easyeda-extension run check`，但如果你只在 `easyeda-extension/` 目录下工作、没跑根目录命令，容易忘记类型检查——这正是之前 `pad-classification` bug 发生的原因。
- **仓库里目前有几个未纳入版本控制但还在用的东西**：`.codex-easyeda-inspect.mjs`、`.codex-easyeda-delete-dangling.mjs`、`.claude/`——是不是要转正、放进 `scripts/` 还是删掉，见 [PROJECT_FRAMEWORK.md](PROJECT_FRAMEWORK.md) 路线图 #6，接手前最好先跟前一个开发者/AI 会话确认这些文件的意图，不要直接删。

---

## 文档变更记录

- 2026-07-21：创建本文档，补上代码地图、调用链路和"新增能力 checklist"，与 `PROJECT_FRAMEWORK.md`（路线图）、`EASYEDA_MCP_TOOLS.md`（工具参数）分工。
- 2026-07-21：PCB 写操作改注册表模式后同步更新——文件树加上 `pcb-layout.mjs`/`pcb-policy.mjs`/`pcb-operations.ts`/`pcb-serialize.ts`/`pcb-stackup.ts`/`board-outline.ts`；§5 补齐这几个新文件的函数索引，重写 `handlers.ts` 条目（不再描述已删除的两条 `else if` 链）；§6.1"新增一种 operation"清单从 4 处改成 2 处，并注明原理图侧还没做同样的注册表化。
