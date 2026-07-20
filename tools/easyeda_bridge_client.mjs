#!/usr/bin/env node

// 调试工具：从标准输入读取 JavaScript，并发送给旧版 HTTP Bridge 的 /execute 接口。
// 正式 EasyEDA MCP 使用白名单 RPC，不依赖此工具，也不允许执行任意 JavaScript。
const port = process.env.EASYEDA_BRIDGE_PORT || "49620";
let code = "";
// 使用流式读取，允许通过管道传入多行脚本。
for await (const chunk of process.stdin) code += chunk;

if (!code.trim()) {
  console.error("Provide EasyEDA JavaScript on stdin.");
  process.exit(2);
}

// Bridge 只监听本机地址；请求体仍可能执行任意代码，因此仅用于受控调试。
const response = await fetch(`http://127.0.0.1:${port}/execute`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ code }),
});

const payload = await response.json();
console.log(JSON.stringify(payload, null, 2));
if (!response.ok || payload.success === false) process.exit(1);
