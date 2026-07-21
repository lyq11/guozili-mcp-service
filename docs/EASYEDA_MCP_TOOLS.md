# 果子狸MCP服务工具说明

版本：`0.4.11`

EasyEDA MCP 通过本机 WebSocket RPC 连接 EasyEDA MCP Extension。接口全部采用结构化白名单，不依赖 Run API Gateway，也不执行任意 JavaScript。

当前共有 **24 个 MCP 工具**。日常修改优先使用直接工具，`schematic_apply_operations` 仅作为尚未封装能力的底层入口。

## 工具总览

| 工具 | 类型 | 用途 |
| --- | --- | --- |
| `easyeda_health` | 只读 | 检查连接并获取当前工程、原理图和图页 |
| `schematic_list_pages` | 只读 | 无需打开图页即可列出当前工程的全部原理图和图页 |
| `schematic_inspect_page` | 只读 | 读取器件真实 BBox、旋转/镜像、引脚电气类型/非连接状态、网络和导线 |
| `schematic_inspect_region` | 只读 | 只读取矩形区域内的器件和导线，便于局部布局与故障定位 |
| `schematic_get_page_occupancy` | 只读 | 构建或复用页面二维占用网格，返回画布映射和分层占用摘要 |
| `schematic_find_free_regions` | 只读 | 按目标矩形尺寸、安全间距和偏好坐标搜索空白放置区域 |
| `component_search` | 只读 | 搜索 EasyEDA/LCSC 器件库 |
| `schematic_analyze_readability` | 只读 | 评估原理图的人类可读性 |
| `schematic_apply_operations` | 写入 | 校验后立即执行白名单操作；本会话首次写入自动备份一次 |
| `schematic_rename_page` | 写入 | 直接重命名图页 |
| `schematic_delete_page` | 写入 | 直接删除图页 |
| `schematic_delete_primitives` | 写入 | 按 ID 删除器件和导线 |
| `schematic_place_components` | 写入 | 批量放置器件；应在布线前单独完成 |
| `schematic_move_components` | 写入 | 按图元 ID 将一个或多个既有普通器件移动到绝对坐标 |
| `schematic_transform_components` | 写入 | 批量移动、旋转或镜像已有普通器件，并返回引脚新旧坐标 |
| `schematic_move_components_with_wires` | 写入 | 以统一偏移量成组平移选定器件和完整导线折线 |
| `schematic_create_wires` | 写入 | 批量创建直接带网络名的导线，无需先放网络标签 |
| `schematic_connect_pin_pairs` | 写入 | 按器件 ID 和 PIN 号连接引脚对 |
| `schematic_create_net_flags` | 写入 | 创建原生电源、地、模拟地或保护地标志 |
| `schematic_create_ports_for_pins` | 写入 | 沿 PIN 朝外创建跨页/长距离端口 |
| `schematic_set_no_connects` | 写入 | 按器件与引脚号批量设置或取消原生非连接标识 |
| `schematic_set_component_attributes` | 写入 | 修改并显示器件原生属性，例如 `Value`；不会创建自由文字 |
| `schematic_create_texts` | 写入 | 批量创建人类可读文字标注 |
| `schematic_run_drc` | 只读 | 运行原理图严格 DRC |

## 页面二维占用缓存

默认画布范围为 `0..1635 × 0..1160`，默认单元尺寸为 `5`，因此通常映射为 `327 × 232` 个单元。若已有图元位于范围之外，缓存边界会自动扩展。内部使用行优先 `Uint8Array`，每格为位掩码：器件 `1`、导线 `2`、端口 `4`、本次计划占用 `8`、图框边缘 `16`、标题栏 `32`。

`schematic_get_page_occupancy` 分别返回 `geometryOccupiedRatio`（原始图元覆盖率）和 `placementBlockedRatio`（实际禁放率）。后者会按器件、端口、导线的安全间距膨胀，并默认预留图框边缘和右下标题栏；兼容字段 `occupiedRatio` 与 `placementBlockedRatio` 相同。`includeRows=true` 时额外返回非空行的行程压缩数据 `[行号, [[起始列, 结束列, 位掩码], ...]]`，避免传输完整二维数组。

```json
{
  "pageUuid": "图页UUID",
  "cellSize": 5,
  "componentClearance": 10,
  "portClearance": 10,
  "wireClearance": 5,
  "borderMargin": 20,
  "reserveTitleBlock": true,
  "includeRows": false
}
```

`schematic_find_free_regions` 按完整目标矩形和安全间距搜索，可一次寻找多个互不重叠的空白区域：

```json
{
  "pageUuid": "图页UUID",
  "width": 120,
  "height": 80,
  "count": 3,
  "clearance": 15,
  "preferredX": 1000,
  "preferredY": 700,
  "cellSize": 5
}
```

缓存指纹包含器件 ID、位置、旋转、镜像、BBox 以及导线 ID、网络和折线。页面图框 `sheet` 只定义画布，其边缘由独立禁放层表示；器件属性只有在 `parentPrimitiveId` 与器件 ID 一致时才合并进 BBox。若 BBox 相对器件原点和 PIN 跨度明显失真，缓存会忽略它并回退到局部几何范围。快照变化时自动重建；任何写入无论成功或失败都会主动失效相关页面缓存。

## 直接写工具

所有直接写工具共享同一个执行器：自动附带当前会话 ID、复用本会话唯一备份、串行写入，并在开始写入前对展开后的全部操作统一预检。页面写入完成或失败后，相应占用缓存都会失效并在下次读取时重建。

推荐固定工作流：

1. `schematic_inspect_region` 检查目标区域和外围禁放区。
2. `schematic_place_components` 放置新器件，或用 `schematic_transform_components` 调整已有器件的位置和方向。
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

#### transform_components

```json
{
  "type": "transform_components",
  "pageUuid": "图页UUID",
  "changes": [
    { "componentId": "$8I4640", "rotation": 90 },
    { "componentId": "$8I4641", "x": 1200, "y": 800, "mirror": true }
  ]
}
```

直接工具名称为 `schematic_transform_components`。每项至少提供 `x`、`y`、`rotation`、`mirror` 之一；省略的字段保持原值。`rotation` 允许 `0`、`90`、`180`、`270`，`mirror` 使用 EasyEDA 原生镜像状态。一次调用最多处理 50 个普通器件，且同一器件不能重复出现。

该操作不会自动修改导线。返回值包含每个器件及其引脚变换前后的坐标和 `moved` 标记，旋转或镜像后应据此检查并重接原有导线。

#### translate_group

```json
{
  "type": "translate_group",
  "pageUuid": "图页UUID",
  "componentIds": ["U1图元ID", "R1图元ID"],
  "wireIds": ["导线1图元ID", "导线2图元ID"],
  "deltaX": 80,
  "deltaY": -20
}
```

直接工具名称为 `schematic_move_components_with_wires`。`deltaX`、`deltaY` 是统一偏移量；器件坐标和每条导线的全部端点、拐点都会应用相同偏移，因此组内相对布局保持不变。

工具只移动明确传入的 ID，不自动查找“相连导线”。如果一条导线另一端仍连接未移动器件，不应把整条导线加入 `wireIds`，否则它会与静止器件断开；这种情况应单独修改或重新规划该导线。

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

该操作先识别 PIN 位于器件的左、右、上、下哪一侧，再生成直出、延长直出和多条正交绕行候选。已有器件使用 EasyEDA 返回的器件本体与可见属性文字联合 BBox；待创建端口按“符号 + 方向 + 完整网络名”估算一个保守矩形。端口矩形和整条导线路径都会参加碰撞检查，不能只看连接点坐标。

规划器会避开源器件矩形、其它器件、已有导线以及同批次中已经规划的端口矩形和导线，再按交叉数、拐点数和线长选择最顺的安全路径。所有候选都冲突时会中止写入，不会强行放置。

端口旋转角自动设置，不需要手工计算：左侧为 `0°`、右侧为 `180°`、上侧为 `270°`、下侧为 `90°`。

`offset` 是 PIN 到端口的最小距离，默认 `40`。长网络名造成端口矩形变宽时，规划器会自动增加实际距离。`axisBias` 是左右/上下分类偏置，默认 `1`；一般无需修改。MCP 会把该高层操作展开为一个 `create_net_port` 和一个 `create_wire`，并在返回值的 `pinPortPlans` 中报告 `portBounds`；`pinPortPlans.routing` 报告策略、评分、拐点、线长、器件阻挡数、端口压线数、导线交叉数和候选数量。

与手工填写 `x/y/rotation` 的 `create_net_port` 相比，新增端口应优先使用此操作，以免端口压住器件本体或朝器件内部延伸。

#### set_no_connects

非连接标识是引脚自身的原生 `noConnected` 状态，不是普通器件或网络符号。直接工具 `schematic_set_no_connects` 支持在一次调用中处理多个器件；设置前应通过 `schematic_inspect_page` 核对引脚号和当前 `noConnected` 状态。

```json
{
  "pageUuid": "图页UUID",
  "changes": [
    {
      "componentId": "U1图元ID",
      "pinNumbers": ["2", "9", "30", "31"],
      "noConnected": true
    }
  ],
  "reason": "标记确认不使用的引脚"
}
```

将 `noConnected` 设为 `false` 可以批量取消已有标识。底层 `schematic_apply_operations` 使用相同字段，但单条 operation 的 `type` 为 `set_no_connects`。

#### set_component_attribute

器件参数必须写入原生属性，不能用 `create_text` 冒充。直接工具 `schematic_set_component_attributes` 会按器件 ID 和属性名修改已有属性，并控制键和值的可见性：

```json
{
  "pageUuid": "图页UUID",
  "changes": [
    {
      "componentId": "C71图元ID",
      "key": "Value",
      "value": "100nF / 50V",
      "keyVisible": false,
      "valueVisible": true
    }
  ],
  "reason": "补齐器件实际参数"
}
```

`schematic_inspect_page` 返回每个器件的 `attributes` 数组，可用于写入前确认属性存在、写入后核对值和可见性。底层 operation 的 `type` 为 `set_component_attribute`。若库器件不存在指定属性，操作会在预检阶段停止，不会用自由文字兜底。

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

## PCB 工具

新增的高层 PCB 工具：

- `pcb_create_from_schematic`：从指定原理图创建 PCB，建立 EasyEDA Board 关联，并可立即导入原理图器件。
- `pcb_list_stackups`：读取当前/default 物理叠层、全部已保存叠层配置、铜层数和图层名称。
- `pcb_set_stackup`：设置 2–32 层偶数铜层、按顺序命名内层或按配置名称/原始配置覆写当前物理叠层。简单层数和完整物理配置互斥，避免含义冲突。
- `pcb_find_board_outline`：返回 Board Outline 层上的直线、圆弧、折线、图元 ID、数量与外包边界。
- `pcb_check_board_outline`：按端点拓扑检查直线/圆弧闭合性，并单独报告折线的闭合状态、断点和分支点。
- `pcb_create_board_outline`：在 Board Outline 层绘制矩形或多边形轮廓；闭合轮廓支持圆角，`closed=false` 的开放路径可用于补板框缺口。板框固定使用空网络，不复用铜走线操作。
- `pcb_group_components_by_schematic_page`：将 PCB 器件按原理图页打组排布。默认 `apply=false` 只返回布局方案；显式设置 `apply=true` 才会移动器件并创建会话 PCB 备份。
- `pcb_modify_tracks`：按走线图元 ID 原地修改线宽、铜层、网络或锁定状态，并保留图元 ID。
- `pcb_modify_vias`：按过孔图元 ID 原地修改位置、孔径、外径、类型、网络或锁定状态，并保留图元 ID。
- `pcb_apply_net_track_policy`：按精确网络名或 glob 匹配网络，对其全部直线、圆弧和折线走线统一设置线宽、层或锁定状态；默认 `apply=false` 仅预览。
- `pcb_arrange_components`：对指定器件顺序执行左/右/上/下/中心对齐、水平/垂直等边缘间距和栅格吸附；默认 `apply=false` 仅预览。

- 缓存与读取：`pcb_list_boards`、`pcb_inspect`、`pcb_inspect_region`。
- 检查：`pcb_check`、`pcb_find_unrouted_nets`、`pcb_find_dangling_tracks`、`pcb_check_component_overlaps`、`pcb_check_outside_components`、`pcb_check_schematic_consistency`、`pcb_run_drc`。
- 清理：`pcb_delete_dangling_tracks` 会在写入前重新扫描并删除未接触焊盘或过孔的游离直线走线岛；默认跳过含铺铜、圆弧/折线走线的网络和锁定导线。
- 创建：`pcb_create_pours`、`pcb_create_vias`、`pcb_create_pads` 分别创建铺铜、过孔和独立焊盘；不推断网络、电气层或制造尺寸。
- 安全写入：`pcb_transform_components`、`pcb_create_tracks`、`pcb_create_vias`、`pcb_create_pours`、`pcb_rebuild_pours`、`pcb_sync_from_schematic`。
- `pcb_fix_deterministic` 会先运行 DRC，再重建指定或全部铺铜，最后再次运行 DRC；不会自动修改线宽、间距、过孔或高电流网络规则。
- 所有 PCB 坐标和尺寸均使用 mil。走线层/线宽、过孔孔径/外径、铺铜层/边界宽度及网络必须显式提供。
- 初始化与写入只允许关联 `[main]` 原理图且 PCB 名不含 `[backup]` 的 Board。每个会话首次 PCB 写入前会创建一个游离 `[backup]` 副本。

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

- PCB 未布线分析用焊盘中心、直线走线和过孔建立连通图；弧形走线及铺铜会标记为不确定，最终以 EasyEDA 飞线和 DRC 为准。
- 写操作不是原子事务，中途失败不会自动恢复。
- 会话安全点按 MCP 进程识别，MCP 重启后第一次写入会创建新备份。
- `connect_pins` 尚未实现避障寻路。
- `create_port_for_pin` 使用器件原点和 PIN 坐标做几何推断；极不规则符号可通过 `axisBias` 调整，必要时仍可使用底层 `create_net_port` 手工定位。
- 可读性评分不代替人工审图和电气 DRC。
