const SIDES = ["left", "right", "top", "bottom"];

// EasyEDA 网络端口的连接点方向与画布四边之间的对应关系。
const PORT_BY_SIDE = {
  left: { dx: -1, dy: 0, rotation: 0 },
  right: { dx: 1, dy: 0, rotation: 180 },
  top: { dx: 0, dy: -1, rotation: 270 },
  bottom: { dx: 0, dy: 1, rotation: 90 },
};

/**
 * 根据器件原点和引脚的画布绝对坐标，推断引脚位于器件的哪一侧。
 *
 * 这是几何推断：EasyEDA 当前返回值不包含符号边界框或引脚朝向。对于位于
 * 对角线附近的引脚，可用 axisBias 调整横向/纵向判定倾向。
 *
 * @param {{x: number, y: number, pins?: Array<object>}} component
 * @param {{axisBias?: number}} [options]
 * @returns {{
 *   kind: "none" | "single-sided" | "two-sided" | "three-sided" | "four-sided",
 *   occupiedSides: Array<"left" | "right" | "top" | "bottom">,
 *   pins: Array<object>,
 *   sides: {left: Array<object>, right: Array<object>, top: Array<object>, bottom: Array<object>}
 * }}
 */
export function inferPinLayout(component, { axisBias = 1 } = {}) {
  if (!component || !Number.isFinite(component.x) || !Number.isFinite(component.y)) {
    throw new TypeError("component.x and component.y must be finite numbers");
  }
  if (!Number.isFinite(axisBias) || axisBias <= 0) {
    throw new TypeError("axisBias must be a positive finite number");
  }

  const sourcePins = component.pins ?? [];
  if (!Array.isArray(sourcePins)) throw new TypeError("component.pins must be an array");

  const sides = Object.fromEntries(SIDES.map((side) => [side, []]));
  const pins = sourcePins.map((pin) => {
    if (!pin || !Number.isFinite(pin.x) || !Number.isFinite(pin.y)) {
      throw new TypeError("every pin.x and pin.y must be finite numbers");
    }

    const dx = pin.x - component.x;
    const dy = pin.y - component.y;
    // 横向距离乘以偏置后占优，则引脚归入左右侧；相等时也优先左右侧。
    const side = Math.abs(dx) * axisBias >= Math.abs(dy)
      ? (dx <= 0 ? "left" : "right")
      : (dy <= 0 ? "top" : "bottom");
    const inferred = { ...pin, side, order: 0 };
    sides[side].push(inferred);
    return inferred;
  });

  // 左右两侧按从上到下排序，上下两侧按从左到右排序。
  for (const side of ["left", "right"]) sides[side].sort(compareBy("y", "x"));
  for (const side of ["top", "bottom"]) sides[side].sort(compareBy("x", "y"));
  for (const side of SIDES) {
    sides[side].forEach((pin, index) => { pin.order = index + 1; });
  }

  const occupiedSides = SIDES.filter((side) => sides[side].length > 0);
  const kindByCount = ["none", "single-sided", "two-sided", "three-sided", "four-sided"];
  return { kind: kindByCount[occupiedSides.length], occupiedSides, pins, sides };
}

/**
 * 为指定引脚规划一个沿引脚外侧延伸的网络端口。
 * 返回的 line 从器件引脚直达端口连接点，端口旋转角保证连接点朝向器件。
 *
 * @param {{id?: string, x: number, y: number, pins?: Array<object>}} component
 * @param {string} pinNumber
 * @param {{offset?: number, axisBias?: number}} [options]
 */
export function planPortForPin(component, pinNumber, {
  offset = 40,
  axisBias = 1,
  obstacles,
  clearance = 10,
  laneSpacing = 20,
  maxLanes = 6,
  requireClearPath = true,
  net = "",
  direction: portDirection = "BI",
  occupancy,
} = {}) {
  if (!Number.isFinite(offset) || offset <= 0) {
    throw new TypeError("offset must be a positive finite number");
  }
  if (!Number.isFinite(clearance) || clearance < 0) {
    throw new TypeError("clearance must be a non-negative finite number");
  }
  if (!Number.isFinite(laneSpacing) || laneSpacing <= 0) {
    throw new TypeError("laneSpacing must be a positive finite number");
  }
  if (!Number.isInteger(maxLanes) || maxLanes < 0 || maxLanes > 20) {
    throw new TypeError("maxLanes must be an integer from 0 to 20");
  }

  const layout = inferPinLayout(component, { axisBias });
  const pin = layout.pins.find((item) => String(item.number) === String(pinNumber));
  if (!pin) throw new Error(`Pin ${pinNumber} not found on component ${component.id ?? "unknown"}`);

  const direction = PORT_BY_SIDE[pin.side];
  const candidates = makePortCandidates(pin, direction, offset, laneSpacing, maxLanes, net, portDirection);
  const evaluated = candidates.map((candidate) => ({
    ...candidate,
    ...evaluatePortCandidate(candidate, component, obstacles, clearance, occupancy),
  })).sort((left, right) => left.score - right.score || left.length - right.length || left.bends - right.bends);
  const selected = evaluated[0];
  if (requireClearPath && (selected.blockingComponents > 0 || selected.wireCrossings > 0
    || selected.portWireOverlaps > 0 || selected.gridBlockedCells > 0)) {
    throw new Error(`No clear outward port route for pin ${pinNumber} on component ${component.id ?? "unknown"}`);
  }
  const port = { ...selected.port, rotation: direction.rotation };
  return {
    componentId: component.id,
    pinNumber: String(pin.number),
    side: pin.side,
    order: pin.order,
    layoutKind: layout.kind,
    pin: { x: pin.x, y: pin.y },
    port,
    portBounds: selected.portBounds,
    line: selected.line,
    routing: {
      strategy: selected.strategy,
      score: selected.score,
      bends: selected.bends,
      length: selected.length,
      blockingComponents: selected.blockingComponents,
      wireCrossings: selected.wireCrossings,
      portWireOverlaps: selected.portWireOverlaps,
      gridBlockedCells: selected.gridBlockedCells,
      candidatesEvaluated: evaluated.length,
      clear: selected.blockingComponents === 0 && selected.wireCrossings === 0
        && selected.portWireOverlaps === 0 && selected.gridBlockedCells === 0,
    },
  };
}

function makePortCandidates(pin, direction, offset, laneSpacing, maxLanes, net, portDirection) {
  const candidates = [];
  const horizontal = direction.dx !== 0;
  for (let distanceStep = 0; distanceStep <= 6; distanceStep++) {
    const distance = offset + distanceStep * laneSpacing;
    const directPort = { x: pin.x + direction.dx * distance, y: pin.y + direction.dy * distance };
    candidates.push({
      strategy: distanceStep === 0 ? "direct" : "extended-direct",
      port: directPort,
      portBounds: estimatePortBounds(directPort, direction.rotation, net, portDirection),
      line: [pin.x, pin.y, directPort.x, directPort.y],
    });
    const stubDistance = Math.min(10, distance / 3);
    for (let lane = 1; lane <= maxLanes; lane++) {
      for (const sign of [-1, 1]) {
        const shift = sign * lane * laneSpacing;
        const port = horizontal
          ? { x: pin.x + direction.dx * distance, y: pin.y + shift }
          : { x: pin.x + shift, y: pin.y + direction.dy * distance };
        const stub = { x: pin.x + direction.dx * stubDistance, y: pin.y + direction.dy * stubDistance };
        const corner = horizontal ? { x: stub.x, y: port.y } : { x: port.x, y: stub.y };
        candidates.push({
          strategy: "detour",
          port,
          portBounds: estimatePortBounds(port, direction.rotation, net, portDirection),
          line: [pin.x, pin.y, stub.x, stub.y, corner.x, corner.y, port.x, port.y],
        });
      }
    }
  }
  return candidates;
}

function evaluatePortCandidate(candidate, sourceComponent, obstacles, clearance, occupancy) {
  const routeSegments = polylineSegments(candidate.line);
  const components = Array.isArray(obstacles?.components) ? obstacles.components : [];
  const wires = Array.isArray(obstacles?.wires) ? obstacles.wires : [];
  let blockingComponents = 0;
  for (const component of components) {
    if (!component) continue;
    const bounds = componentBounds(component, clearance);
    const portOverlaps = rectanglesOverlap(candidate.portBounds, bounds);
    const routeOverlaps = component.id !== sourceComponent.id
      && routeSegments.some((segment) => segmentIntersectsBounds(segment, bounds));
    if (portOverlaps || routeOverlaps) {
      blockingComponents++;
    }
  }

  let wireCrossings = 0;
  let portWireOverlaps = 0;
  const existingSegments = wires.flatMap((wire) => polylineSegments(wire?.line));
  for (const existing of existingSegments) {
    if (segmentIntersectsBounds(existing, candidate.portBounds)) portWireOverlaps++;
  }
  for (const route of routeSegments) {
    for (const existing of existingSegments) {
      if (segmentsConflict(route, existing, { x: candidate.line[0], y: candidate.line[1] })) wireCrossings++;
    }
  }
  const length = routeSegments.reduce((sum, segment) => sum + Math.abs(segment.x2 - segment.x1) + Math.abs(segment.y2 - segment.y1), 0);
  const bends = Math.max(0, routeSegments.length - 1);
  const gridBlockedCells = occupancy && typeof occupancy.countBounds === "function"
    ? occupancy.countBounds(candidate.portBounds)
    : 0;
  return {
    blockingComponents,
    wireCrossings,
    portWireOverlaps,
    gridBlockedCells,
    length,
    bends,
    score: blockingComponents * 100000 + gridBlockedCells * 50000 + portWireOverlaps * 10000
      + wireCrossings * 1000 + bends * 20 + length,
  };
}

function componentBounds(component, padding) {
  if (component.bbox && Number.isFinite(component.bbox.minX) && Number.isFinite(component.bbox.minY)
    && Number.isFinite(component.bbox.maxX) && Number.isFinite(component.bbox.maxY)) {
    const bounds = {
      left: component.bbox.minX - padding,
      top: component.bbox.minY - padding,
      right: component.bbox.maxX + padding,
      bottom: component.bbox.maxY + padding,
    };
    if (componentBoundsArePlausible(component, bounds, padding)) return bounds;
  }
  if (component.bbox && Number.isFinite(component.bbox.left) && Number.isFinite(component.bbox.top)
    && Number.isFinite(component.bbox.right) && Number.isFinite(component.bbox.bottom)) {
    const bounds = {
      left: component.bbox.left - padding,
      top: component.bbox.top - padding,
      right: component.bbox.right + padding,
      bottom: component.bbox.bottom + padding,
    };
    if (componentBoundsArePlausible(component, bounds, padding)) return bounds;
  }
  const points = [{ x: component.x, y: component.y }, ...(Array.isArray(component.pins) ? component.pins : [])]
    .filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y));
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    left: Math.min(...xs) - padding,
    top: Math.min(...ys) - padding,
    right: Math.max(...xs) + padding,
    bottom: Math.max(...ys) + padding,
  };
}

function componentBoundsArePlausible(component, bounds, padding) {
  if (!Number.isFinite(component?.x) || !Number.isFinite(component?.y)) return true;
  const pins = (component.pins || []).filter((pin) => Number.isFinite(pin?.x) && Number.isFinite(pin?.y));
  const pinReachX = pins.reduce((maximum, pin) => Math.max(maximum, Math.abs(pin.x - component.x)), 0);
  const pinReachY = pins.reduce((maximum, pin) => Math.max(maximum, Math.abs(pin.y - component.y)), 0);
  const labelAllowance = Math.min(300, 40 + Array.from(String(component.net || "")).length * 8);
  const allowanceX = Math.max(120, pinReachX + 120, labelAllowance) + padding;
  const allowanceY = Math.max(120, pinReachY + 120) + padding;
  return bounds.left >= component.x - allowanceX && bounds.right <= component.x + allowanceX
    && bounds.top >= component.y - allowanceY && bounds.bottom <= component.y + allowanceY;
}

/** Conservative rectangle for a not-yet-created port, including its symbol and visible net label. */
function estimatePortBounds(port, rotation, net, direction) {
  const labelLength = Array.from(String(net || "")).length;
  const directionLength = Array.from(String(direction || "")).length;
  const horizontalWidth = Math.max(40, 24 + labelLength * 7 + directionLength * 3);
  const horizontalHeight = 20;
  const vertical = rotation === 90 || rotation === 270;
  const width = vertical ? horizontalHeight : horizontalWidth;
  const height = vertical ? horizontalWidth : horizontalHeight;
  return makeBounds(port.x - width / 2, port.y - height / 2, port.x + width / 2, port.y + height / 2);
}

function rectanglesOverlap(left, right) {
  return !(left.right < right.left || left.left > right.right || left.bottom < right.top || left.top > right.bottom);
}

function polylineSegments(line) {
  if (!Array.isArray(line)) return [];
  if (line.length > 0 && Array.isArray(line[0])) return line.flatMap(polylineSegments);
  const result = [];
  for (let index = 0; index + 3 < line.length; index += 2) {
    result.push({ x1: line[index], y1: line[index + 1], x2: line[index + 2], y2: line[index + 3] });
  }
  return result.filter((segment) => Object.values(segment).every(Number.isFinite));
}

function pointInsideBounds(point, bounds) {
  return point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom;
}

function segmentIntersectsBounds(segment, bounds) {
  if (pointInsideBounds({ x: segment.x1, y: segment.y1 }, bounds) || pointInsideBounds({ x: segment.x2, y: segment.y2 }, bounds)) return true;
  if (segment.y1 === segment.y2) {
    return segment.y1 >= bounds.top && segment.y1 <= bounds.bottom
      && Math.max(segment.x1, segment.x2) >= bounds.left && Math.min(segment.x1, segment.x2) <= bounds.right;
  }
  if (segment.x1 === segment.x2) {
    return segment.x1 >= bounds.left && segment.x1 <= bounds.right
      && Math.max(segment.y1, segment.y2) >= bounds.top && Math.min(segment.y1, segment.y2) <= bounds.bottom;
  }
  return true;
}

function segmentsConflict(left, right, allowedEndpoint) {
  const leftHorizontal = left.y1 === left.y2;
  const rightHorizontal = right.y1 === right.y2;
  if (leftHorizontal !== rightHorizontal) {
    const horizontal = leftHorizontal ? left : right;
    const vertical = leftHorizontal ? right : left;
    const point = { x: vertical.x1, y: horizontal.y1 };
    const intersects = point.x >= Math.min(horizontal.x1, horizontal.x2) && point.x <= Math.max(horizontal.x1, horizontal.x2)
      && point.y >= Math.min(vertical.y1, vertical.y2) && point.y <= Math.max(vertical.y1, vertical.y2);
    return intersects && (point.x !== allowedEndpoint.x || point.y !== allowedEndpoint.y);
  }
  if (leftHorizontal) {
    if (left.y1 !== right.y1) return false;
    const overlapStart = Math.max(Math.min(left.x1, left.x2), Math.min(right.x1, right.x2));
    const overlapEnd = Math.min(Math.max(left.x1, left.x2), Math.max(right.x1, right.x2));
    return overlapStart <= overlapEnd && !(overlapStart === overlapEnd && overlapStart === allowedEndpoint.x && left.y1 === allowedEndpoint.y);
  }
  if (left.x1 !== right.x1) return false;
  const overlapStart = Math.max(Math.min(left.y1, left.y2), Math.min(right.y1, right.y2));
  const overlapEnd = Math.min(Math.max(left.y1, left.y2), Math.max(right.y1, right.y2));
  return overlapStart <= overlapEnd && !(overlapStart === overlapEnd && overlapStart === allowedEndpoint.y && left.x1 === allowedEndpoint.x);
}

/**
 * 给页面检查结果补充布局元数据，但不丢弃插件返回的任何原始字段。
 * AI 可以直接读取 component.pinLayout 和每个 pin 的 side/order。
 */
export function annotatePagePinLayouts(page) {
  if (!page || !Array.isArray(page.components)) return page;
  return {
    ...page,
    components: page.components.map((component) => {
      // netport/netflag 的唯一 PIN 常与图元原点重合，不能用相对坐标推断四边。
      if (component.type && component.type !== "part") return component;
      const layout = inferPinLayout(component);
      return {
        ...component,
        pinLayout: { kind: layout.kind, occupiedSides: layout.occupiedSides },
        pins: layout.pins,
      };
    }),
  };
}

function compareBy(primary, secondary) {
  return (left, right) =>
    left[primary] - right[primary] ||
    left[secondary] - right[secondary] ||
    String(left.number ?? left.id ?? "").localeCompare(String(right.number ?? right.id ?? ""));
}

/**
 * 使用器件原点和全部 PIN 端点估算一个原理图功能模块的占用范围。
 * keepOutBounds 在估算范围外增加 padding，可直接作为文字和新图元的禁放区。
 *
 * @param {Array<{x: number, y: number, pins?: Array<{x: number, y: number}>}>} components
 * @param {{padding?: number}} [options]
 * @returns {{
 *   contentBounds: {left: number, top: number, right: number, bottom: number, width: number, height: number, centerX: number, centerY: number},
 *   keepOutBounds: {left: number, top: number, right: number, bottom: number, width: number, height: number, centerX: number, centerY: number},
 *   componentCount: number,
 *   pinCount: number,
 *   approximate: true
 * } | null}
 */
export function estimateModuleBounds(components, { padding = 20 } = {}) {
  if (!Array.isArray(components)) throw new TypeError("components must be an array");
  if (!Number.isFinite(padding) || padding < 0) {
    throw new TypeError("padding must be a non-negative finite number");
  }

  const points = [];
  let pinCount = 0;
  for (const component of components) {
    if (!component || !Number.isFinite(component.x) || !Number.isFinite(component.y)) {
      throw new TypeError("every component.x and component.y must be finite numbers");
    }
    points.push({ x: component.x, y: component.y });

    const pins = component.pins ?? [];
    if (!Array.isArray(pins)) throw new TypeError("component.pins must be an array");
    for (const pin of pins) {
      if (!pin || !Number.isFinite(pin.x) || !Number.isFinite(pin.y)) {
        throw new TypeError("every pin.x and pin.y must be finite numbers");
      }
      points.push({ x: pin.x, y: pin.y });
      pinCount++;
    }
  }

  if (!points.length) return null;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const contentBounds = makeBounds(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
  const keepOutBounds = makeBounds(
    contentBounds.left - padding,
    contentBounds.top - padding,
    contentBounds.right + padding,
    contentBounds.bottom + padding,
  );

  return {
    contentBounds,
    keepOutBounds,
    componentCount: components.length,
    pinCount,
    approximate: true,
  };
}

/** 判断待放置矩形是否与模块禁放区相交；边界接触也视为相交。 */
export function boundsOverlap(left, right) {
  validateBounds(left, "left bounds");
  validateBounds(right, "right bounds");
  return !(
    left.right < right.left ||
    left.left > right.right ||
    left.bottom < right.top ||
    left.top > right.bottom
  );
}

function makeBounds(left, top, right, bottom) {
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    centerX: (left + right) / 2,
    centerY: (top + bottom) / 2,
  };
}

function validateBounds(bounds, label) {
  if (
    !bounds ||
    !Number.isFinite(bounds.left) ||
    !Number.isFinite(bounds.top) ||
    !Number.isFinite(bounds.right) ||
    !Number.isFinite(bounds.bottom) ||
    bounds.left > bounds.right ||
    bounds.top > bounds.bottom
  ) {
    throw new TypeError(`${label} must contain valid left, top, right and bottom coordinates`);
  }
}
