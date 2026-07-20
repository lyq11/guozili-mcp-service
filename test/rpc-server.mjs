// RPC 协议单元测试：验证错误令牌被拒绝、正确客户端可注册，以及请求/响应能配对。
import assert from "node:assert/strict";
import WebSocket from "ws";
import { EasyEdaRpcServer } from "../src/rpc-server.mjs";

const token = "test-token";
const rpc = new EasyEdaRpcServer({ portStart: 49720, portEnd: 49729, token, timeoutMs: 2_000 });
await rpc.start();

// 第一阶段：模拟入侵客户端使用错误令牌，服务器应以策略违规代码 1008 断开。
const unauthorized = new WebSocket(`ws://127.0.0.1:${rpc.port}/easyeda-mcp`);
await new Promise((resolve, reject) => {
  const deadline = setTimeout(() => reject(new Error("Unauthorized client was not rejected")), 2_000);
  unauthorized.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "handshake") {
      unauthorized.send(JSON.stringify({ type: "register", protocolVersion: 1, token: "wrong-token", windowId: "intruder" }));
    }
  });
  unauthorized.on("close", (code) => {
    clearTimeout(deadline);
    assert.equal(code, 1008);
    resolve();
  });
});

// 第二阶段：模拟 EasyEDA 插件，完成注册并实现 system.health 白名单方法。
const extension = new WebSocket(`ws://127.0.0.1:${rpc.port}/easyeda-mcp`);
extension.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.type === "handshake") {
    extension.send(JSON.stringify({
      type: "register",
      protocolVersion: 1,
      token,
      windowId: "mock-window",
      capabilities: ["system.health"],
    }));
  } else if (message.type === "rpc") {
    assert.equal(message.method, "system.health");
    extension.send(JSON.stringify({ type: "result", id: message.id, result: { ok: true } }));
  }
});

// 等待模拟插件出现在服务器状态中，避免固定 sleep 造成不稳定测试。
await new Promise((resolve, reject) => {
  const deadline = setTimeout(() => reject(new Error("Mock extension registration timed out")), 2_000);
  const poll = setInterval(async () => {
    if ((await rpc.status()).connectedWindows.length) {
      clearTimeout(deadline);
      clearInterval(poll);
      resolve();
    }
  }, 20);
});

// 验证 MCP 侧 call() 能收到模拟插件按同一请求 id 返回的结果。
assert.deepEqual(await rpc.call("system.health"), { ok: true });
const status = await rpc.status();
assert.equal(status.connectedWindows[0].windowId, "mock-window");
assert.equal(status.protocolVersion, 1);

extension.close();
rpc.close();
console.log("RPC server protocol test passed");
