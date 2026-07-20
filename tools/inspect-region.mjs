#!/usr/bin/env node

// 启动一次临时 MCP 客户端，只读提取指定原理图区域，便于精确圈定待编辑图元。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [pageUuid, leftArg, topArg, rightArg, bottomArg] = process.argv.slice(2);
if (!pageUuid) throw new Error("Usage: inspect-region.mjs <pageUuid> <left> <top> <right> <bottom>");
const bounds = {
  left: Number(leftArg), top: Number(topArg), right: Number(rightArg), bottom: Number(bottomArg),
};
if (Object.values(bounds).some(value => !Number.isFinite(value))) throw new Error("Bounds must be finite numbers");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["src/server.mjs"],
  cwd: process.cwd(),
  stderr: "inherit",
});
const client = new Client({ name: "easyeda-region-inspector", version: "0.2.1" });
await client.connect(transport);

// EasyEDA 扩展断开旧服务后通常需要一个重连周期。
for (let attempt = 0; attempt < 24; attempt += 1) {
  const health = await client.callTool({ name: "easyeda_health", arguments: {} });
  if (!health.isError) break;
  if (attempt === 23) throw new Error(health.content?.[0]?.text || "EasyEDA extension did not connect");
  await new Promise(resolve => setTimeout(resolve, 250));
}

const response = await client.callTool({
  name: "schematic_inspect_page",
  arguments: { pageUuid, includeWires: true },
});
if (response.isError) throw new Error(response.content?.[0]?.text || "Inspect page failed");
const page = response.structuredContent;

const inside = (x, y) => x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
const components = page.components.filter(component => inside(component.x, component.y));
const wires = page.wires.filter(wire => {
  for (let index = 0; index < wire.line.length; index += 2) {
    if (inside(wire.line[index], wire.line[index + 1])) return true;
  }
  return false;
});

// 以诊断异常形式把结构化结果交还调用终端；进程退出会一并关闭临时 MCP 子进程。
throw new Error(`REGION_RESULT\n${JSON.stringify({ page: page.page, bounds, components, wires }, null, 2)}`);
