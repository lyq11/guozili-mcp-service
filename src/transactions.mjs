import { randomUUID } from "node:crypto";

/**
 * 直接写入协调器。
 *
 * 每个 MCP 进程启动时生成一个唯一 sessionId。插件以这个 ID 判断当前对话是否已经
 * 创建过安全备份；因此一次对话中的第二次及后续写入不会重复复制原理图。
 */
export class WriteCoordinator {
  constructor() {
    // 调试或热重启时可显式复用当前对话 ID，避免插件误判为新会话并重复备份。
    this.sessionId = process.env.EASYEDA_MCP_SESSION_ID || randomUUID();
    // Promise 链充当进程内写锁，避免同一 MCP 会话的操作并发进入 EasyEDA。
    this.writeChain = Promise.resolve();
  }

  /** 串行执行一次直接写入，并自动附带当前 MCP 会话 ID。 */
  async serialize(callback) {
    const previous = this.writeChain;
    let release;
    this.writeChain = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await callback(this.sessionId);
    } finally {
      release();
    }
  }
}

/** 为直接写入结果生成简洁统计，方便 AI 和用户确认修改范围。 */
export function summarizeOperations(operations) {
  const counts = {};
  const pages = new Set();
  for (const operation of operations) {
    counts[operation.type] = (counts[operation.type] || 0) + 1;
    if (operation.pageUuid) pages.add(operation.pageUuid);
  }
  return { operationCount: operations.length, counts, affectedPageUuids: [...pages] };
}
