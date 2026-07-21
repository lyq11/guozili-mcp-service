export const OCCUPANCY = Object.freeze({
  COMPONENT: 1,
  WIRE: 2,
  PORT: 4,
  PLANNED: 8,
  BORDER: 16,
  TITLE_BLOCK: 32,
  ALL: 63,
});

const DEFAULT_CANVAS = Object.freeze({ left: 0, top: 0, right: 1635, bottom: 1160 });
const DEFAULT_OPTIONS = Object.freeze({
  componentClearance: 10,
  portClearance: 10,
  wireClearance: 5,
  borderMargin: 20,
  reserveTitleBlock: true,
});

/** Compact two-dimensional occupancy map backed by a row-major Uint8Array. */
export class PageOccupancyGrid {
  constructor(page, options = {}) {
    const { cellSize = 5, canvas = DEFAULT_CANVAS, exactCanvas = false } = options;
    if (!Number.isFinite(cellSize) || cellSize <= 0) throw new TypeError("cellSize must be positive");
    this.cellSize = cellSize;
    this.bounds = exactCanvas ? { ...canvas } : expandedCanvasBounds(page, canvas, cellSize);
    this.columns = Math.ceil((this.bounds.right - this.bounds.left) / cellSize);
    this.rows = Math.ceil((this.bounds.bottom - this.bounds.top) / cellSize);
    this.cells = new Uint8Array(this.columns * this.rows);
    this.geometryCells = new Uint8Array(this.columns * this.rows);
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.pageUuid = page?.page?.uuid;
    this.fingerprint = pageFingerprint(page);
    this.populate(page);
  }

  populate(page) {
    this.#markPageKeepouts(page);
    for (const component of page?.components || []) {
      if (component.type === "sheet") continue;
      const bounds = componentBounds(component);
      if (!bounds) continue;
      const layer = component.type === "netport" ? OCCUPANCY.PORT : OCCUPANCY.COMPONENT;
      this.#markGeometryBounds(bounds, layer, component.type === "netport"
        ? this.options.portClearance
        : this.options.componentClearance);
    }
    for (const wire of page?.wires || []) this.#markGeometryPolyline(wire.line, OCCUPANCY.WIRE, this.options.wireClearance);
  }

  worldToCell(x, y) {
    return {
      column: Math.floor((x - this.bounds.left) / this.cellSize),
      row: Math.floor((y - this.bounds.top) / this.cellSize),
    };
  }

  cellToWorld(column, row) {
    return {
      x: this.bounds.left + (column + 0.5) * this.cellSize,
      y: this.bounds.top + (row + 0.5) * this.cellSize,
    };
  }

  markBounds(bounds, layer = OCCUPANCY.PLANNED) {
    validateBounds(bounds);
    const range = this.#cellRange(bounds);
    if (!range) return;
    for (let row = range.top; row <= range.bottom; row++) {
      for (let column = range.left; column <= range.right; column++) {
        this.cells[row * this.columns + column] |= layer;
      }
    }
  }

  markPolyline(line, layer = OCCUPANCY.PLANNED) {
    this.#markPolylineOn(this.cells, line, layer, 0);
  }

  #markGeometryBounds(bounds, layer, clearance) {
    this.#markBoundsOn(this.geometryCells, bounds, layer);
    this.#markBoundsOn(this.cells, expandBounds(bounds, clearance), layer);
  }

  #markGeometryPolyline(line, layer, clearance) {
    this.#markPolylineOn(this.geometryCells, line, layer, 0);
    this.#markPolylineOn(this.cells, line, layer, clearance);
  }

  #markPolylineOn(target, line, layer, clearance) {
    for (const segment of polylineSegments(line)) {
      const distance = Math.max(Math.abs(segment.x2 - segment.x1), Math.abs(segment.y2 - segment.y1));
      const steps = Math.max(1, Math.ceil(distance / (this.cellSize / 2)));
      for (let step = 0; step <= steps; step++) {
        const ratio = step / steps;
        this.#markPointOn(
          target,
          segment.x1 + (segment.x2 - segment.x1) * ratio,
          segment.y1 + (segment.y2 - segment.y1) * ratio,
          layer,
          clearance,
        );
      }
    }
  }

  countBounds(bounds, mask = OCCUPANCY.ALL) {
    validateBounds(bounds);
    const range = this.#cellRange(bounds);
    if (!range) return 1;
    let count = 0;
    for (let row = range.top; row <= range.bottom; row++) {
      for (let column = range.left; column <= range.right; column++) {
        if ((this.cells[row * this.columns + column] & mask) !== 0) count++;
      }
    }
    return count;
  }

  isBoundsFree(bounds, mask = OCCUPANCY.ALL) {
    return this.countBounds(bounds, mask) === 0;
  }

  findFreeRectangles({ width, height, count = 1, clearance = 10, preferredX, preferredY } = {}) {
    for (const [name, value] of [["width", width], ["height", height]]) {
      if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be positive`);
    }
    if (!Number.isInteger(count) || count < 1 || count > 50) throw new TypeError("count must be an integer from 1 to 50");
    if (!Number.isFinite(clearance) || clearance < 0) throw new TypeError("clearance must be non-negative");

    const working = new PageOccupancyGrid({ page: { uuid: this.pageUuid }, components: [], wires: [] }, {
      cellSize: this.cellSize,
      canvas: this.bounds,
      exactCanvas: true,
      borderMargin: 0,
      reserveTitleBlock: false,
    });
    working.cells.set(this.cells);
    working.geometryCells.set(this.geometryCells);
    const results = [];
    for (let index = 0; index < count; index++) {
      const candidate = working.#findOne(width, height, clearance, preferredX, preferredY);
      if (!candidate) break;
      results.push(candidate);
      working.markBounds(candidate.keepOutBounds, OCCUPANCY.PLANNED);
    }
    return results;
  }

  describe({ includeRows = false } = {}) {
    const byLayer = {};
    for (const [name, layer] of Object.entries(OCCUPANCY)) {
      if (name === "ALL") continue;
      byLayer[name.toLowerCase()] = this.cells.reduce((sum, value) => sum + ((value & layer) !== 0 ? 1 : 0), 0);
    }
    const occupiedCells = this.cells.reduce((sum, value) => sum + (value !== 0 ? 1 : 0), 0);
    const geometryOccupiedCells = this.geometryCells.reduce((sum, value) => sum + (value !== 0 ? 1 : 0), 0);
    return {
      pageUuid: this.pageUuid,
      canvas: this.bounds,
      cellSize: this.cellSize,
      columns: this.columns,
      rows: this.rows,
      totalCells: this.cells.length,
      occupiedCells,
      freeCells: this.cells.length - occupiedCells,
      geometryOccupiedCells,
      geometryOccupiedRatio: Number((geometryOccupiedCells / this.cells.length).toFixed(4)),
      placementBlockedCells: occupiedCells,
      placementBlockedRatio: Number((occupiedCells / this.cells.length).toFixed(4)),
      placementPolicy: {
        componentClearance: this.options.componentClearance,
        portClearance: this.options.portClearance,
        wireClearance: this.options.wireClearance,
        borderMargin: this.options.borderMargin,
        reserveTitleBlock: this.showTitleBlock,
        titleBlockBounds: this.titleBlockBounds || null,
      },
      // Backward-compatible alias. This now means placement-blocked, not literal ink coverage.
      occupiedRatio: Number((occupiedCells / this.cells.length).toFixed(4)),
      occupiedByLayer: byLayer,
      ...(includeRows ? { rowRuns: this.#rleRows() } : {}),
    };
  }

  #findOne(width, height, clearance, preferredX, preferredY) {
    const expandedWidth = width + clearance * 2;
    const expandedHeight = height + clearance * 2;
    const cellWidth = Math.ceil(expandedWidth / this.cellSize);
    const cellHeight = Math.ceil(expandedHeight / this.cellSize);
    if (cellWidth > this.columns || cellHeight > this.rows) return null;
    const targetX = Number.isFinite(preferredX) ? preferredX : (this.bounds.left + this.bounds.right) / 2;
    const targetY = Number.isFinite(preferredY) ? preferredY : (this.bounds.top + this.bounds.bottom) / 2;
    let best = null;
    for (let row = 0; row <= this.rows - cellHeight; row++) {
      for (let column = 0; column <= this.columns - cellWidth; column++) {
        const keepOutBounds = {
          left: this.bounds.left + column * this.cellSize,
          top: this.bounds.top + row * this.cellSize,
          right: this.bounds.left + (column + cellWidth) * this.cellSize,
          bottom: this.bounds.top + (row + cellHeight) * this.cellSize,
        };
        if (!this.isBoundsFree(keepOutBounds)) continue;
        const x = (keepOutBounds.left + keepOutBounds.right) / 2;
        const y = (keepOutBounds.top + keepOutBounds.bottom) / 2;
        const score = (x - targetX) ** 2 + (y - targetY) ** 2;
        if (!best || score < best.score) {
          best = {
            x,
            y,
            width,
            height,
            bounds: { left: x - width / 2, top: y - height / 2, right: x + width / 2, bottom: y + height / 2 },
            keepOutBounds,
            score,
          };
        }
      }
    }
    return best;
  }

  #cellRange(bounds) {
    if (bounds.right < this.bounds.left || bounds.left > this.bounds.right
      || bounds.bottom < this.bounds.top || bounds.top > this.bounds.bottom) return null;
    return {
      left: clamp(Math.floor((bounds.left - this.bounds.left) / this.cellSize), 0, this.columns - 1),
      top: clamp(Math.floor((bounds.top - this.bounds.top) / this.cellSize), 0, this.rows - 1),
      right: clamp(Math.floor((bounds.right - this.bounds.left) / this.cellSize), 0, this.columns - 1),
      bottom: clamp(Math.floor((bounds.bottom - this.bounds.top) / this.cellSize), 0, this.rows - 1),
    };
  }

  #markBoundsOn(target, bounds, layer) {
    validateBounds(bounds);
    const range = this.#cellRange(bounds);
    if (!range) return;
    for (let row = range.top; row <= range.bottom; row++) {
      for (let column = range.left; column <= range.right; column++) {
        target[row * this.columns + column] |= layer;
      }
    }
  }

  #markPointOn(target, x, y, layer, clearance = 0) {
    const { column, row } = this.worldToCell(x, y);
    if (column < 0 || row < 0 || column >= this.columns || row >= this.rows) return;
    const radius = Math.ceil(clearance / this.cellSize);
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const targetColumn = column + dx;
        const targetRow = row + dy;
        if (targetColumn < 0 || targetRow < 0 || targetColumn >= this.columns || targetRow >= this.rows) continue;
        target[targetRow * this.columns + targetColumn] |= layer;
      }
    }
  }

  #markPageKeepouts(page) {
    this.showTitleBlock = this.options.reserveTitleBlock && pageShowsTitleBlock(page);
    const margin = this.options.borderMargin;
    if (margin > 0) {
      const { left, top, right, bottom } = this.bounds;
      this.markBounds({ left, top, right, bottom: top + margin }, OCCUPANCY.BORDER);
      this.markBounds({ left, top: bottom - margin, right, bottom }, OCCUPANCY.BORDER);
      this.markBounds({ left, top, right: left + margin, bottom }, OCCUPANCY.BORDER);
      this.markBounds({ left: right - margin, top, right, bottom }, OCCUPANCY.BORDER);
    }
    if (this.showTitleBlock) {
      this.titleBlockBounds = titleBlockBounds(this.bounds);
      this.markBounds(this.titleBlockBounds, OCCUPANCY.TITLE_BLOCK);
    }
  }

  #rleRows() {
    const rows = [];
    for (let row = 0; row < this.rows; row++) {
      const runs = [];
      let value = this.cells[row * this.columns];
      let start = 0;
      for (let column = 1; column <= this.columns; column++) {
        const next = column < this.columns ? this.cells[row * this.columns + column] : -1;
        if (next !== value) {
          if (value !== 0) runs.push([start, column - 1, value]);
          start = column;
          value = next;
        }
      }
      if (runs.length) rows.push([row, runs]);
    }
    return rows;
  }
}

export class PageOccupancyCache {
  constructor() { this.items = new Map(); }

  get(pageUuid, page, options = {}) {
    const key = `${pageUuid}:${JSON.stringify({
      cellSize: options.cellSize || 5,
      componentClearance: options.componentClearance ?? DEFAULT_OPTIONS.componentClearance,
      portClearance: options.portClearance ?? DEFAULT_OPTIONS.portClearance,
      wireClearance: options.wireClearance ?? DEFAULT_OPTIONS.wireClearance,
      borderMargin: options.borderMargin ?? DEFAULT_OPTIONS.borderMargin,
      reserveTitleBlock: options.reserveTitleBlock ?? DEFAULT_OPTIONS.reserveTitleBlock,
    })}`;
    const fingerprint = pageFingerprint(page);
    const cached = this.items.get(key);
    if (cached?.fingerprint === fingerprint) return cached.grid;
    const grid = new PageOccupancyGrid(page, options);
    this.items.set(key, { fingerprint, grid });
    return grid;
  }

  invalidate(pageUuids) {
    const ids = new Set(Array.isArray(pageUuids) ? pageUuids : [pageUuids]);
    for (const [key, item] of this.items) {
      if (ids.has(item.grid.pageUuid)) this.items.delete(key);
    }
  }
}

function expandedCanvasBounds(page, canvas, cellSize) {
  const points = [];
  for (const component of page?.components || []) {
    if (component.type === "sheet") continue;
    const bounds = componentBounds(component);
    if (bounds) points.push({ x: bounds.left, y: bounds.top }, { x: bounds.right, y: bounds.bottom });
  }
  for (const wire of page?.wires || []) {
    for (const segment of polylineSegments(wire.line)) {
      points.push({ x: segment.x1, y: segment.y1 }, { x: segment.x2, y: segment.y2 });
    }
  }
  const margin = cellSize * 2;
  const minX = points.length ? Math.min(...points.map((point) => point.x)) : canvas.left;
  const minY = points.length ? Math.min(...points.map((point) => point.y)) : canvas.top;
  const maxX = points.length ? Math.max(...points.map((point) => point.x)) : canvas.right;
  const maxY = points.length ? Math.max(...points.map((point) => point.y)) : canvas.bottom;
  return {
    left: minX < canvas.left ? Math.floor((minX - margin) / cellSize) * cellSize : canvas.left,
    top: minY < canvas.top ? Math.floor((minY - margin) / cellSize) * cellSize : canvas.top,
    right: maxX > canvas.right ? Math.ceil((maxX + margin) / cellSize) * cellSize : canvas.right,
    bottom: maxY > canvas.bottom ? Math.ceil((maxY + margin) / cellSize) * cellSize : canvas.bottom,
  };
}

function expandBounds(bounds, clearance = 0) {
  return {
    left: bounds.left - clearance,
    top: bounds.top - clearance,
    right: bounds.right + clearance,
    bottom: bounds.bottom + clearance,
  };
}

function pageShowsTitleBlock(page) {
  return page?.page?.showTitleBlock !== false;
}

function titleBlockBounds(canvas) {
  const width = canvas.right - canvas.left;
  const height = canvas.bottom - canvas.top;
  return {
    left: canvas.left + width * 0.56,
    // EasyEDA schematic coordinates grow upward; the visually bottom title block is at low Y.
    top: canvas.top,
    right: canvas.right,
    bottom: canvas.top + height * 0.14,
  };
}

function componentBounds(component) {
  if (component?.type === "sheet") return null;
  if (component?.bbox && Number.isFinite(component.bbox.minX)) {
    const bounds = { left: component.bbox.minX, top: component.bbox.minY, right: component.bbox.maxX, bottom: component.bbox.maxY };
    if (componentBoundsArePlausible(component, bounds)) return bounds;
  }
  if (component?.bbox && Number.isFinite(component.bbox.left) && componentBoundsArePlausible(component, component.bbox)) return component.bbox;
  if (component?.type === "netport" && Number.isFinite(component?.x) && Number.isFinite(component?.y)) {
    const labelLength = Array.from(String(component.net || component.name || "")).length;
    const horizontalWidth = Math.max(40, 24 + labelLength * 7);
    const horizontalHeight = 20;
    const vertical = component.rotation === 90 || component.rotation === 270;
    const width = vertical ? horizontalHeight : horizontalWidth;
    const height = vertical ? horizontalWidth : horizontalHeight;
    return {
      left: component.x - width / 2,
      top: component.y - height / 2,
      right: component.x + width / 2,
      bottom: component.y + height / 2,
    };
  }
  const points = [{ x: component?.x, y: component?.y }, ...(component?.pins || [])]
    .filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y));
  if (!points.length) return null;
  return {
    left: Math.min(...points.map((point) => point.x)),
    top: Math.min(...points.map((point) => point.y)),
    right: Math.max(...points.map((point) => point.x)),
    bottom: Math.max(...points.map((point) => point.y)),
  };
}

function componentBoundsArePlausible(component, bounds) {
  if (!Number.isFinite(component?.x) || !Number.isFinite(component?.y)) return true;
  const pins = (component.pins || []).filter((pin) => Number.isFinite(pin?.x) && Number.isFinite(pin?.y));
  const pinReachX = pins.reduce((maximum, pin) => Math.max(maximum, Math.abs(pin.x - component.x)), 0);
  const pinReachY = pins.reduce((maximum, pin) => Math.max(maximum, Math.abs(pin.y - component.y)), 0);
  const labelAllowance = Math.min(300, 40 + Array.from(String(component.net || "")).length * 8);
  const allowanceX = Math.max(120, pinReachX + 120, labelAllowance);
  const allowanceY = Math.max(120, pinReachY + 120);
  return bounds.left >= component.x - allowanceX && bounds.right <= component.x + allowanceX
    && bounds.top >= component.y - allowanceY && bounds.bottom <= component.y + allowanceY;
}

function polylineSegments(line) {
  if (!Array.isArray(line)) return [];
  if (line.length > 0 && Array.isArray(line[0])) return line.flatMap(polylineSegments);
  const result = [];
  for (let index = 0; index + 3 < line.length; index += 2) {
    result.push({ x1: line[index], y1: line[index + 1], x2: line[index + 2], y2: line[index + 3] });
  }
  return result;
}

function pageFingerprint(page) {
  return JSON.stringify({
    page: page?.page,
    components: (page?.components || []).map((item) => [item.id, item.x, item.y, item.rotation, item.mirror, item.bbox]),
    wires: (page?.wires || []).map((item) => [item.id, item.net, item.line]),
  });
}

function validateBounds(bounds) {
  if (!bounds || !Number.isFinite(bounds.left) || !Number.isFinite(bounds.top)
    || !Number.isFinite(bounds.right) || !Number.isFinite(bounds.bottom)
    || bounds.left > bounds.right || bounds.top > bounds.bottom) {
    throw new TypeError("bounds must contain finite left, top, right and bottom values");
  }
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
