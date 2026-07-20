# EasyEDA MCP 架构与协议

## 架构

```text
Codex
  │ MCP stdio
  ▼
EasyEDA MCP Server
  │ ws://127.0.0.1:49620-49629/easyeda-mcp
  │ 认证、固定 RPC、请求超时
  ▼
EasyEDA MCP Extension
  │ 固定处理器
  ▼
EasyEDA eda.* API
```

MCP Server 同时承担原 Bridge 的监听职责。EasyEDA 扩展逐个扫描本机端口，只有握手中的服务名和协议版本正确时才注册。因此不再需要单独启动 `bridge-server.mjs`。

## RPC v1

服务端握手：

```json
{"type":"handshake","service":"easyeda-mcp","protocolVersion":1,"authentication":"token"}
```

扩展注册：

```json
{"type":"register","protocolVersion":1,"token":"…","windowId":"…","capabilities":["system.health"]}
```

请求与结果：

```json
{"type":"rpc","id":"…","method":"schematic.listPages","params":{}}
{"type":"result","id":"…","result":{}}
```

错误：

```json
{"type":"error","id":"…","error":"…"}
```

## 白名单方法

| RPC 方法 | 权限 | 说明 |
|---|---:|---|
| `system.health` | 读 | 当前工程、原理图和图页 |
| `schematic.listPages` | 读 | 原理图图页列表 |
| `schematic.inspectPage` | 读 | 器件、引脚、网络与导线 |
| `library.searchComponents` | 读 | 搜索器件库 |
| `operations.apply` | 写 | 校验后直接执行；当前会话首次写入自动备份 |
| `schematic.runDrc` | 读/计算 | 执行原理图 DRC |

插件中不存在任意代码入口。新增能力时必须在 MCP 参数 Schema、扩展能力清单和扩展处理器三处显式定义。

## 与 Run API Gateway 的差异

| 项目 | Run API Gateway | EasyEDA MCP Extension |
|---|---|---|
| 调用内容 | JavaScript 字符串 | 方法名和 JSON 参数 |
| 执行机制 | `AsyncFunction` | 固定函数映射 |
| 中间进程 | 独立 Bridge | MCP 内嵌 WS 服务 |
| HTTP `/execute` | 有 | 无 |
| 未知方法 | 可通过代码访问 | 拒绝 |
| 写操作约束 | 调用者自行负责 | 白名单校验、会话首次备份、串行写入 |

## 会话级备份与直接写入

MCP 每次启动生成一个随机 `sessionId`。调用 `schematic_apply_operations` 时，MCP 会先把 `create_port_for_pin` 这类几何高层操作展开成插件白名单内的端口和导线操作，再将该 ID 与展开后的操作数组发送给插件。插件使用：

```text
sessionId + schematicUuid
```

作为备份键。该键第一次出现时，插件先复制完整原理图；后续写入直接复用同一 `backupUuid`，不再创建副本。

```text
第一次写入：校验 → 创建安全备份 → 执行 → 保存
后续写入：  校验 → 复用安全备份 → 执行 → 保存
```

写操作在 MCP 侧串行进入插件，但一组操作在 EasyEDA 内仍是逐条执行，不是原子事务。中途失败时前序操作可能已经保存。

## PIN 布局与朝外端口

`src/pin-layout.mjs` 根据器件原点和全部 PIN 的画布绝对坐标，推断每个 PIN 位于 `left/right/top/bottom` 哪一侧。`schematic_inspect_page` 会把布局类型、占用侧边、PIN 侧边与侧内顺序附加到插件原始返回值。

`create_port_for_pin` 使用同一套推断结果，把端口沿 PIN 所在侧向外平移，自动选择旋转角，并生成 PIN 到端口连接点的直线。几何计算保留在 MCP 侧，因此无需升级 EasyEDA 插件的 RPC 权限或加入新的底层写入口。

## 迁移

1. 构建并导入 `easyeda-mcp-extension_v0.1.7.eext`。
2. 覆盖升级扩展后刷新一次 EasyEDA 页面，使后台 `onStartupFinished` 实例载入新版本；普通 MCP 重启不需要刷新。
3. 确认新扩展显示“已连接”。
4. 停用 Run API Gateway。
5. 停止旧的 `easyeda-api-skill` Bridge。
6. 重启 Codex MCP 或新开一个任务，使新的 MCP 进程生效。
7. 调用 `easyeda_health` 和只读工具验证；直接写工具会真实修改文档，不在冒烟测试中自动调用。
