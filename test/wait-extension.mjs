// 手工联调辅助：启动本地 RPC 服务，并等待真实 EasyEDA 插件窗口连接。
import { EasyEdaRpcServer } from "../src/rpc-server.mjs";

// 可通过 EASYEDA_WAIT_MS 调整等待时长，默认 90 秒。
const durationMs = Number(process.env.EASYEDA_WAIT_MS || 90_000);
const rpc = new EasyEdaRpcServer();
await rpc.start();
const started = Date.now();
console.log(JSON.stringify({ event: "listening", port: rpc.port, durationMs }));
while (Date.now() - started < durationMs) {
  // 每 2 秒检查一次，连接成功就打印完整状态并正常退出。
  const status = await rpc.status();
  if (status.connectedWindows.length) {
    console.log(JSON.stringify({ event: "connected", elapsedMs: Date.now() - started, status }, null, 2));
    rpc.close();
    process.exit(0);
  }
  await new Promise(resolve => setTimeout(resolve, 2_000));
}
// 超时属于联调失败，使用非零退出码供脚本或 CI 判断。
console.error(JSON.stringify({ event: "timeout", elapsedMs: Date.now() - started }));
rpc.close();
process.exit(1);
