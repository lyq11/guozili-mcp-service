# 果子狸MCP服务工具说明

版本：`0.4.1`

EasyEDA MCP 通过本机 WebSocket RPC 连接 EasyEDA MCP Extension。接口全部采用结构化白名单，不依赖 Run API Gateway，也不执行任意 JavaScript。

当前共有 **18 个 MCP 工具**。日常修改优先使用直接工具，`schematic_apply_operations` 仅作为尚未封装能力的底层入口。

## 工具总览

| 工具 | 类型 | 用途 |
| --- | --- | --- |
| `easyeda_health` | 只读 | 检查连接并获取当前工程、原理图和图页 |
| `schematic_list_pages` | 只读 | 无需打开图页即可列出当前工程的全部原理图和图页 |
| `schematic_inspect_page` | 只读 | 读取图页中的器件、引脚、网络和导线 |
| `schematic_inspect_region` | 只读 | 只读取矩形区域内的器件和导线，便于局部布局与故障定位 |
| `component_search` | 只读 | 搜索 EasyEDA/LCSC 器件库 |
| `schematic_analyze_readability` | 只读 | 评估原理图的人类可读性 |
| `schematic_apply_operations` | 写入 | 校验后立即执行白名单操作；本会话首次写入自动备份一次 |
| `schematic_rename_page` | 写入 | 直接重命名图页 |
| `schematic_delete_page` | 写入 | 直接删除图页 |
| `schematic_delete_primitives` | 写入 | 按 ID 删除器件和导线 |
| `schematic_place_components` | 写入 | 批量放置器件；应在布线前单独完成 |
| `schematic_move_components` | 写入 | 按图元 ID 将一个或多个既有普通器件移动到绝对坐标 |
| `schematic_create_wires` | 写入 | 批量创建直接带网络名的导线，无需先放网络标签 |
| `schematic_connect_pin_pairs` | 写入 | 按器件 ID 和 PIN 号连接引脚对 |
| `schematic_create_net_flags` | 写入 | 创建原生电源、地、模拟地或保护地标志 |
| `schematic_create_ports_for_pins` | 写入 | 沿 PIN 朝外创建跨页/长距离端口 |
| `schematic_create_texts` | 写入 | 批量创建人类可读文字标注 |
| `schematic_run_drc` | 只读 | 运行原理图严格 DRC |

## 直接写工具

所有直接写工具共享同一个执行器：自动附带当前会话 ID、复用本会话唯一备份、串行写入，并在 MCP 侧逐条调用插件以避开 EasyEDA 连续创建图元时的竞态。

推荐固定工作流：

1. `schematic_inspect_region` 检查目标区域和外围禁放区。
2. `schematic_place_components` 放置新器件，或用 `schematic_move_components` 调整既有器件。
3. 再次检查 PIN 方向、器件间距及电源/地逃线通道。
4. `schematic_create_net_flags` 放必要的标准电源/地标志。
5. `schematic_create_wires` 直接创建带网络名的导线。
6. 运行 DRC 和可读性检查。

`schematic_create_wires` 示例：

```json
{
  "pageUuid": "图页UUID",
  "wires": [
    { "line": [740, 795, 800, 795, 800, 780, 915, 780], "net": "RS485_A" },
    { "line": [740, 805, 800, 805, 800, 820, 915, 820], "net": "RS485_B" }
  ],
  "reason": "创建RS-485平行主干"
}
```

`schematic_create_net_flags` 示例：

```json
{
  "pageUuid": "图页UUID",
  "flags": [
    { "identification": "Ground", "net": "GND", "x": 740, "y": 900, "rotation": 90 }
  ]
}
```

## 会话级备份策略

每次 MCP 进程启动都会生成新的 `sessionId`，通常对应一次 Codex 对话。

首次对某份原理图调用 `schematic_apply_operations` 时：

1. 插件校验全部操作。
2. 插件复制当前完整原理图，建立会话安全点。
3. 插件立即执行操作并逐条保存。
4. 返回 `backupUuid` 和 `backupCreated: true`。

同一会话继续修改同一份原理图时，不再复制，返回相同 `backupUuid` 和 `backupCreated: false`。如果同一会话切换到另一份原理图，另一份原理图会单独备份一次。

当前策略以效率为优先，不提供逐次预览、确认或自动回滚。一次调用中的操作依次执行；中途失败时，前序操作可能已经保存，可通过会话备份人工恢复。

## 1. easyeda_health

检查 MCP、RPC 和 EasyEDA 插件连接，并读取当前编辑上下文。

参数：无。

主要返回字段：

- `connection.endpoint`：插件连接地址。
- `connection.connectedWindows`：已认证的 EasyEDA 窗口。
- `context.project`：当前工程。
- `context.schematic`：当前原理图。
- `context.page`：当前图页。

## 2. schematic_list_pages

列出当前工程中的全部原理图及其图页，不需要先打开任何图页。顶层 `schematics` 保留原理图层级，顶层 `pages` 提供兼容旧客户端的扁平图页列表；每页都包含所属原理图 UUID 和名称。

参数：无。

## 3. schematic_inspect_page

读取指定图页的器件、引脚、位置、网络和导线。修改前应先调用该工具确认真实图元 ID 和坐标。

MCP 会根据器件原点和 PIN 的画布绝对坐标补充布局信息：

- `component.pinLayout.kind`：`none`、`single-sided`、`two-sided`、`three-sided` 或 `four-sided`。
- `component.pinLayout.occupiedSides`：器件实际占用的 `left/right/top/bottom`。
- `pin.side`：该 PIN 位于器件哪一侧。
- `pin.order`：该 PIN 在当前侧从上到下或从左到右的顺序。

| 参数 | 类型 | 必需 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `pageUuid` | string | 是 | — | 图页 UUID |
| `includeWires` | boolean | 否 | `true` | 是否返回导线数据 |

### 3.1 schematic_inspect_region

读取局部矩形区域，避免大页面结果过大。参数包括 `pageUuid`、`left`、`top`、`right`、`bottom`，以及可选的 `includeComponents`、`includeWires`。

布局时应先用该工具检查目标区域和外围安全边距，再放置器件；器件布局确认后才开始布线。

## 4. component_search

搜索器件库，返回创建器件需要的 `libraryUuid` 和 `uuid`，以及型号、封装和采购信息。

| 参数 | 类型 | 必需 | 默认值 | 限制 |
| --- | --- | --- | --- | --- |
| `query` | string | 是 | — | 名称、型号或关键词 |
| `limit` | integer | 否 | `10` | 1～50 |

## 5. schematic_analyze_readability

分析指定图页的人类可读性，返回 0～100 分。该工具检查端口密度、零长度导线、器件拥挤和正交导线交叉，不代替电气 DRC。

| 参数 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `pageUuid` | string | 是 | 图页 UUID |

## 6. schematic_apply_operations

校验后立即修改 EasyEDA。无需预览、事务 ID 或 `COMMIT` 确认。

| 参数 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `reason` | string | 是 | 本次修改目的，最多 500 字符 |
| `operations` | array | 是 | 1～100 个白名单操作 |

返回示例：

```json
{
  "sessionId": "MCP会话UUID",
  "reason": "优化RS485连接",
  "summary": {
    "operationCount": 3,
    "counts": { "create_wire": 3 },
    "affectedPageUuids": ["图页UUID"]
  },
  "success": true,
  "schematicUuid": "原理图UUID",
  "backupUuid": "会话安全备份UUID",
  "backupCreated": true,
  "results": []
}
```

### 支持的操作

#### rename_page

```json
{
  "type": "rename_page",
  "pageUuid": "图页UUID",
  "name": "uart_rs485"
}
```

#### delete_page

```json
{
  "type": "delete_page",
  "pageUuid": "图页UUID"
}
```

仅剩一个图页时不会执行。

#### delete_primitives

```json
{
  "type": "delete_primitives",
  "pageUuid": "图页UUID",
  "componentIds": ["器件图元ID"],
  "wireIds": ["导线图元ID"]
}
```

#### create_component

```json
{
  "type": "create_component",
  "pageUuid": "图页UUID",
  "libraryUuid": "器件库UUID",
  "deviceUuid": "器件UUID",
  "x": 700,
  "y": 800,
  "rotation": 0,
  "designator": "U63",
  "addIntoBom": true,
  "addIntoPcb": true
}
```

`rotation` 只允许 `0`、`90`、`180`、`270`。

#### move_component

```json
{
  "type": "move_component",
  "pageUuid": "图页UUID",
  "componentId": "器件图元ID",
  "x": 820,
  "y": 760
}
```

直接工具 `schematic_move_components` 的 `movements` 数组可一次提交 1～50 个上述移动目标。`x`、`y` 是器件的新绝对坐标，不是偏移量。调用前应先检查页面获取稳定的图元 ID；该工具只移动普通器件，不移动网络端口或网络标志，也不会主动重画既有导线。

#### create_wire

```json
{
  "type": "create_wire",
  "pageUuid": "图页UUID",
  "line": [100, 100, 180, 100, 180, 140],
  "net": "UART_TXD"
}
```

`line` 每两个数字表示一个坐标。省略 `net` 时 EasyEDA 会根据端点和交点继承网络；必须避免导线穿过其它网络，否则可能意外并网。

#### connect_pins

```json
{
  "type": "connect_pins",
  "pageUuid": "图页UUID",
  "from": { "componentId": "U1图元ID", "pinNumber": "4" },
  "to": { "componentId": "U2图元ID", "pinNumber": "1" },
  "net": "UART_TXD",
  "horizontalFirst": true
}
```

该操作只生成直线或一个直角，不会自动避障。

#### create_net_port

```json
{
  "type": "create_net_port",
  "pageUuid": "图页UUID",
  "direction": "BI",
  "net": "RS485_A",
  "x": 900,
  "y": 800,
  "rotation": 0
}
```

网络端口建议只用于跨页、电源或真正的长距离网络。

同一页内仅为网络命名时不需要创建网络端口；`create_wire` 的 `net` 字段可直接指定网络名。局部功能块应优先使用这种直接导线。

#### create_port_for_pin（推荐）

```json
{
  "type": "create_port_for_pin",
  "pageUuid": "图页UUID",
  "componentId": "U1图元ID",
  "pinNumber": "4",
  "direction": "OUT",
  "net": "UART_TXD",
  "offset": 40,
  "axisBias": 1
}
```

该操作先识别 PIN 位于器件的左、右、上、下哪一侧，再沿 PIN 朝外的方向放置端口并生成一条直线。端口旋转角自动设置，不需要手工计算：左侧为 `0°`、右侧为 `180°`、上侧为 `270°`、下侧为 `90°`。

`offset` 是 PIN 到端口的距离，默认 `40`。`axisBias` 是左右/上下分类偏置，默认 `1`；一般无需修改。MCP 会把该高层操作展开为一个 `create_net_port` 和一个 `create_wire`，并在返回值的 `pinPortPlans` 中报告推断出的侧边、坐标和导线路径。

与手工填写 `x/y/rotation` 的 `create_net_port` 相比，新增端口应优先使用此操作，以免端口压住器件本体或朝器件内部延伸。

#### create_text

```json
{
  "type": "create_text",
  "pageUuid": "图页UUID",
  "x": 650,
  "y": 700,
  "text": "RS-485接口保护与终端",
  "rotation": 0,
  "fontSize": 10,
  "bold": true
}
```

## 7. schematic_run_drc

在指定图页运行 EasyEDA 严格原理图 DRC。

| 参数 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `pageUuid` | string | 是 | 图页 UUID |

部分 EasyEDA Pro 版本只返回错误和警告数量。

## 推荐调用顺序

```text
easyeda_health
    ↓
schematic_inspect_page
    ↓
component_search（需要新增器件时）
    ↓
schematic_apply_operations（直接执行；首次自动备份）
    ↓
schematic_run_drc
    ↓
schematic_inspect_page / schematic_analyze_readability（复核）
```

## 当前限制

- 尚未开放 PCB 布局和布线工具。
- 写操作不是原子事务，中途失败不会自动恢复。
- 会话安全点按 MCP 进程识别，MCP 重启后第一次写入会创建新备份。
- `connect_pins` 尚未实现避障寻路。
- `create_port_for_pin` 使用器件原点和 PIN 坐标做几何推断；极不规则符号可通过 `axisBias` 调整，必要时仍可使用底层 `create_net_port` 手工定位。
- 可读性评分不代替人工审图和电气 DRC。
