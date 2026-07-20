/** 把 EasyEDA 返回的 [x1, y1, x2, y2, ...] 四元组序列展开为独立线段。 */
function segments(line) {
  const result = [];
  for (let index = 0; index + 3 < line.length; index += 4) {
    const [x1, y1, x2, y2] = line.slice(index, index + 4);
    result.push({ x1, y1, x2, y2 });
  }
  return result;
}

/** 判断坐标是否正好位于线段端点；端点相接不计为“交叉”。 */
function isEndpoint(segment, x, y) {
  return (segment.x1 === x && segment.y1 === y) || (segment.x2 === x && segment.y2 === y);
}

/**
 * 粗略判断两条正交线段是否在非共同端点处交叉。
 * 当前算法不处理斜线，也不判断同网交叉是否已经放置结点。
 */
function crossing(a, b) {
  const aHorizontal = a.y1 === a.y2;
  const bHorizontal = b.y1 === b.y2;
  if (aHorizontal === bHorizontal) return false;
  const horizontal = aHorizontal ? a : b;
  const vertical = aHorizontal ? b : a;
  const x = vertical.x1;
  const y = horizontal.y1;
  const inside =
    x >= Math.min(horizontal.x1, horizontal.x2) &&
    x <= Math.max(horizontal.x1, horizontal.x2) &&
    y >= Math.min(vertical.y1, vertical.y2) &&
    y <= Math.max(vertical.y1, vertical.y2);
  if (!inside) return false;
  return !(isEndpoint(horizontal, x, y) && isEndpoint(vertical, x, y));
}

/**
 * 根据端口密度、零长度线、器件间距和导线交叉估算原理图可读性。
 * 分数是启发式指标，用于发现“机器能读、人难读”的版面，不等同于电气 DRC。
 */
export function analyzeReadability(page) {
  // 只统计实体器件和网络端口；电源旗标等其它图元不会进入器件密度计算。
  const parts = page.components.filter((item) => item.type === "part");
  const netports = page.components.filter((item) => item.type === "netport");
  const zeroLengthWires = page.wires.filter((wire) => {
    const line = wire.line || [];
    return line.length >= 4 && line.every((value, index) => value === line[index % 2]);
  });

  // 两两计算器件中心距离；45 是当前经验阈值，单位沿用 EasyEDA 坐标系。
  const closePairs = [];
  for (let left = 0; left < parts.length; left++) {
    for (let right = left + 1; right < parts.length; right++) {
      const a = parts[left];
      const b = parts[right];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (distance < 45) closePairs.push({ a: a.designator || a.id, b: b.designator || b.id, distance: Math.round(distance) });
    }
  }

  // 将所有导线拆段后做两两交叉检测，并跳过同一个导线图元内部的折线段。
  const allSegments = page.wires.flatMap((wire) =>
    segments(wire.line || []).map((segment) => ({ ...segment, wireId: wire.id, net: wire.net })),
  );
  let crossingCount = 0;
  const crossingExamples = [];
  for (let left = 0; left < allSegments.length; left++) {
    for (let right = left + 1; right < allSegments.length; right++) {
      if (allSegments[left].wireId === allSegments[right].wireId) continue;
      if (crossing(allSegments[left], allSegments[right])) {
        crossingCount++;
        if (crossingExamples.length < 10) {
          const a = allSegments[left];
          const b = allSegments[right];
          const horizontal = a.y1 === a.y2 ? a : b;
          const vertical = a.y1 === a.y2 ? b : a;
          crossingExamples.push({
            x: vertical.x1,
            y: horizontal.y1,
            a: { wireId: a.wireId, net: a.net },
            b: { wireId: b.wireId, net: b.net },
          });
        }
      }
    }
  }

  const portRatio = parts.length ? netports.length / parts.length : netports.length;
  const findings = [];
  if (portRatio > 1) findings.push({ level: "warn", code: "excessive_net_ports", message: "网络端口数量超过实体器件数量；功能块内部应优先直接连线。" });
  if (zeroLengthWires.length) findings.push({ level: "warn", code: "zero_length_wires", count: zeroLengthWires.length, message: "存在零长度导线，通常是为网络命名而生成的机器式连接。" });
  if (closePairs.length) findings.push({ level: "warn", code: "crowded_components", count: closePairs.length, examples: closePairs.slice(0, 10), message: "部分器件中心距离小于45单位，版面可能拥挤。" });
  if (crossingCount) findings.push({ level: "warn", code: "wire_crossings", count: crossingCount, examples: crossingExamples, message: "检测到正交导线交叉；应通过移动器件或调整拐点减少交叉。" });

  // 各类问题分别封顶扣分，保证单一异常不会完全掩盖其它指标。
  const score = Math.max(
    0,
    Math.round(100 - Math.min(30, portRatio * 12) - Math.min(20, zeroLengthWires.length * 2) - Math.min(25, closePairs.length * 2) - Math.min(25, crossingCount * 3)),
  );

  return {
    page: { uuid: page.page.uuid, name: page.page.name },
    score,
    metrics: {
      parts: parts.length,
      netports: netports.length,
      portToPartRatio: Number(portRatio.toFixed(2)),
      wires: page.wires.length,
      wireSegments: allSegments.length,
      zeroLengthWires: zeroLengthWires.length,
      closeComponentPairs: closePairs.length,
      estimatedWireCrossings: crossingCount,
    },
    findings,
    guidance: [
      "同一功能块内按信号流从左到右排列器件。",
      "局部连接使用直接正交导线；网络端口仅用于跨页、电源和长距离网络。",
      "保护器件靠近外部连接器，去耦电容靠近电源引脚。",
      "功能块之间至少保留60单位空白，并用标题文字标注。",
    ],
  };
}
