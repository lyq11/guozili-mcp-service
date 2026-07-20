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
export function planPortForPin(component, pinNumber, { offset = 40, axisBias = 1 } = {}) {
  if (!Number.isFinite(offset) || offset <= 0) {
    throw new TypeError("offset must be a positive finite number");
  }

  const layout = inferPinLayout(component, { axisBias });
  const pin = layout.pins.find((item) => String(item.number) === String(pinNumber));
  if (!pin) throw new Error(`Pin ${pinNumber} not found on component ${component.id ?? "unknown"}`);

  const direction = PORT_BY_SIDE[pin.side];
  const port = {
    x: pin.x + direction.dx * offset,
    y: pin.y + direction.dy * offset,
    rotation: direction.rotation,
  };
  return {
    componentId: component.id,
    pinNumber: String(pin.number),
    side: pin.side,
    order: pin.order,
    layoutKind: layout.kind,
    pin: { x: pin.x, y: pin.y },
    port,
    line: [pin.x, pin.y, port.x, port.y],
  };
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
