# 果子狸MCP服务

果子狸MCP服务把嘉立创 EDA / EasyEDA 专业版原理图和 PCB 连接到支持 MCP 的 AI 客户端。项目由两部分组成：

- `easyeda-extension/`：安装在嘉立创 EDA 专业版中的扩展，只执行明确列入白名单的结构化操作。
- `src/server.mjs`：运行在本机的 MCP stdio 服务，同时监听 `127.0.0.1:49620-49629`，供扩展自动发现和连接。

它不依赖 Run API Gateway，不开放 HTTP 代码执行接口，也不使用 `eval`、`Function` 或 `AsyncFunction` 执行外部代码。

## 主要功能

- 无需先打开图页即可列出当前工程中的全部原理图和图页。
- 读取页面、器件真实边界、PIN 电气类型、导线和网络信息。
- 将页面映射为分层二维占用网格，区分原始图元覆盖和实际放置禁区，并按完整矩形、安全间距、图框及标题栏搜索可用空白区域。
- 创建、批量移动、旋转、镜像、删除原理图器件及图元，并可将选定器件与完整导线折线作为一组平移。
- 创建导线、网络端口和网络标识，并按完整端口矩形自动避让器件与导线。
- 读取并修改器件原生属性，可真正写入和显示 `Value`，供属性面板、BOM 与后续检查使用。
- 执行原理图 DRC，并原样返回当前 EasyEDA 版本提供的结果。
- 只缓存关联 `[main]` 原理图的 PCB Board，包括板框、层、封装、焊盘、网络、走线、过孔、铺铜和设计规则。
- 检查 PCB 未布线网络、封装重叠、板外器件、原理图一致性和原生 DRC。
- 安全地成组移动、旋转和锁定封装，并使用显式规则创建走线、过孔和铺铜或从原理图导入变更。
- 分析器件密度、交叉连线、网络端口方向等可读性问题。
- 每次 MCP 进程首次修改一份原理图前自动创建一次完整备份；同一会话后续操作复用该安全点。
- 每次 MCP 进程首次修改一块 PCB 前自动创建游离 `[backup]` 副本；备份不会进入 `[main]` PCB 缓存。
- 在编辑器中显示连接状态悬浮框。

完整工具列表见 [docs/EASYEDA_MCP_TOOLS.md](docs/EASYEDA_MCP_TOOLS.md)，实现与协议见 [docs/EASYEDA_MCP_ARCHITECTURE.md](docs/EASYEDA_MCP_ARCHITECTURE.md)。

## 环境要求

- 嘉立创 EDA / EasyEDA 专业版 `3.2.x`。
- Node.js 20 或更高版本。
- 支持本地 stdio MCP 服务的客户端，例如 Codex。

## 安装扩展

1. 从 GitHub Releases 下载最新版 `guozili-mcp-service_v*.eext`，或按“从源码构建”生成安装包。
2. 打开嘉立创 EDA 专业版的扩展管理器。
3. 导入 `.eext` 文件并启用“果子狸MCP服务”。
4. 停用 Run API Gateway，刷新一次编辑器页面。
5. 顶部菜单进入“果子狸MCP服务”，可查看状态悬浮框、重新连接或停止连接。

扩展默认扫描 `49620-49629`。可通过“果子狸MCP服务 → 设置 MCP 端口”固定连接某个端口；输入 `0` 恢复自动扫描。固定端口时，应将 MCP 服务的 `EASYEDA_MCP_PORT_START` 与 `EASYEDA_MCP_PORT_END` 都设置为相同值。

## 安装本地 MCP 服务

```powershell
git clone https://github.com/lyq11/guozili-mcp-service.git
cd guozili-mcp-service
npm install
```

服务入口是 `src/server.mjs`。MCP 客户端应以 stdio 方式启动它；直接调试时也可以运行：

```powershell
npm start
```

以 Codex 的 `config.toml` 为例，将绝对路径替换为实际克隆位置：

```toml
[mcp_servers.guozili_easyeda]
command = "node"
args = ["C:\\path\\to\\guozili-mcp-service\\src\\server.mjs"]
startup_timeout_sec = 20
tool_timeout_sec = 120
```

保存配置后重启 MCP 客户端或新开一个任务。打开原理图后调用 `easyeda_health`，应能看到 MCP、WebSocket RPC 和 EasyEDA 当前上下文。

## 连接方式

扩展启动后会自动扫描 `49620-49629`，找到协议匹配的本机 MCP 服务后注册。默认仅监听环回地址，不接受局域网或公网连接。

可用环境变量：

| 变量 | 作用 |
| --- | --- |
| `EASYEDA_MCP_PORT_START` | 扫描端口范围起点，默认 `49620` |
| `EASYEDA_MCP_PORT_END` | 扫描端口范围终点，默认 `49629` |
| `EASYEDA_MCP_TOKEN` | 覆盖 MCP 服务端认证令牌；必须与自行构建的扩展保持一致 |
| `EASYEDA_MCP_SESSION_ID` | 固定会话 ID，通常无需设置 |
| `EASYEDA_MCP_DEBUG=1` | 向 stderr 输出 RPC 调试日志 |

发布包中的扩展使用内置的本机握手令牌。若要轮换令牌，请同时修改 `easyeda-extension/src/protocol.ts` 或通过自己的构建流程注入相同值。

## 从源码构建

```powershell
npm install
npm run check
npm run test:pin-layout
npm run test:rpc

cd easyeda-extension
npm install
npm run check
npm run build
```

生成的扩展包位于：

```text
easyeda-extension/dist/guozili-mcp-service_v0.3.1.eext
```

扩展安装并打开原理图后，可在仓库根目录执行联机冒烟测试：

```powershell
npm run test:smoke
```

## 安全边界

- WebSocket 仅绑定 `127.0.0.1`。
- MCP 和扩展通过 RPC v1 与令牌握手。
- 插件只接受固定能力清单内的结构化方法。
- 请求体最大 2 MiB，认证及 RPC 均设有超时。
- 写操作串行执行，但一组 EasyEDA API 操作不是数据库事务；失败时可使用自动备份恢复。

## 许可证

本项目使用 Apache License 2.0，详见 [LICENSE](LICENSE)。果子狸图标为本项目生成的原创资产，可随本项目在同一许可证下使用。
