type JsonObject = Record<string, unknown>;
type Point = {x: number; y: number};

export const BOARD_OUTLINE_LAYER = 11;

export type OutlinePrimitive = {
  type: 'line' | 'arc'; startX: number; startY: number; endX: number; endY: number;
  angle?: number; lineWidth: number; locked: boolean;
};

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const positive = (value: unknown): value is number => finite(value) && value > 0;
const segmentLength = (left: Point, right: Point) => Math.hypot(right.x - left.x, right.y - left.y);

/** Convert a rectangle/polygon board-outline request into exact EasyEDA line and arc primitives. */
export function compileBoardOutline(rawOutline: unknown): OutlinePrimitive[] {
  const outline = rawOutline as JsonObject;
  if (!outline || !['rectangle', 'polygon'].includes(String(outline.type))) throw new Error('Unsupported board outline type');
  const lineWidth = Number(outline.lineWidth);
  const radius = Number(outline.cornerRadius);
  if (!positive(lineWidth)) throw new Error('Board outline lineWidth must be positive');
  if (!finite(radius) || radius < 0) throw new Error('Board outline cornerRadius must be non-negative');

  let points: Point[];
  let closed: boolean;
  if (outline.type === 'rectangle') {
    const x = Number(outline.x); const y = Number(outline.y);
    const width = Number(outline.width); const height = Number(outline.height);
    if (![x, y].every(Number.isFinite) || !positive(width) || !positive(height)) throw new Error('Rectangle x/y must be finite and width/height must be positive');
    if (radius > Math.min(width, height) / 2) throw new Error('Rectangle cornerRadius cannot exceed half its shortest side');
    points = [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
    closed = true;
  } else {
    if (!Array.isArray(outline.points)) throw new Error('Polygon points are required');
    points = outline.points.map((raw) => ({ x: Number((raw as JsonObject).x), y: Number((raw as JsonObject).y) }));
    if (points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) throw new Error('Polygon coordinates must be finite');
    closed = outline.closed !== false;
    if (closed && points.length > 2 && points[0].x === points.at(-1)?.x && points[0].y === points.at(-1)?.y) points.pop();
    if (points.length < (closed ? 3 : 2)) throw new Error(closed ? 'A closed polygon requires at least 3 distinct points' : 'An open repair path requires at least 2 points');
    if (!closed && radius > 0) throw new Error('An open repair path cannot use cornerRadius');
  }

  for (let index = 1; index < points.length; index += 1) if (segmentLength(points[index - 1], points[index]) < 1e-9) throw new Error('Board outline contains consecutive duplicate points');
  if (closed && segmentLength(points.at(-1)!, points[0]) < 1e-9) throw new Error('Board outline contains consecutive duplicate points');

  if (!closed || radius === 0) {
    const primitives: OutlinePrimitive[] = [];
    const count = closed ? points.length : points.length - 1;
    for (let index = 0; index < count; index += 1) {
      const start = points[index]; const end = points[(index + 1) % points.length];
      primitives.push({ type: 'line', startX: start.x, startY: start.y, endX: end.x, endY: end.y, lineWidth, locked: outline.locked === true });
    }
    return primitives;
  }

  const corners = points.map((point, index) => {
    const previous = points[(index - 1 + points.length) % points.length];
    const next = points[(index + 1) % points.length];
    const incomingLength = segmentLength(previous, point); const outgoingLength = segmentLength(point, next);
    const incoming = { x: (point.x - previous.x) / incomingLength, y: (point.y - previous.y) / incomingLength };
    const outgoing = { x: (next.x - point.x) / outgoingLength, y: (next.y - point.y) / outgoingLength };
    const turn = Math.atan2(incoming.x * outgoing.y - incoming.y * outgoing.x, incoming.x * outgoing.x + incoming.y * outgoing.y);
    if (Math.abs(Math.PI - Math.abs(turn)) < 1e-8) throw new Error(`Board outline has a 180-degree corner at point ${index}`);
    const tangentDistance = Math.abs(turn) < 1e-8 ? 0 : radius * Math.tan(Math.abs(turn) / 2);
    return {
      start: { x: point.x - incoming.x * tangentDistance, y: point.y - incoming.y * tangentDistance },
      end: { x: point.x + outgoing.x * tangentDistance, y: point.y + outgoing.y * tangentDistance },
      angle: turn * 180 / Math.PI, tangentDistance,
    };
  });
  for (let index = 0; index < points.length; index += 1) {
    const next = (index + 1) % points.length;
    if (corners[index].tangentDistance + corners[next].tangentDistance > segmentLength(points[index], points[next]) + 1e-8) {
      throw new Error(`cornerRadius is too large for polygon edge ${index}`);
    }
  }
  const primitives: OutlinePrimitive[] = [];
  for (let index = 0; index < corners.length; index += 1) {
    const previous = corners[(index - 1 + corners.length) % corners.length]; const corner = corners[index];
    if (segmentLength(previous.end, corner.start) > 1e-9) primitives.push({ type: 'line', startX: previous.end.x, startY: previous.end.y, endX: corner.start.x, endY: corner.start.y, lineWidth, locked: outline.locked === true });
    if (Math.abs(corner.angle) > 1e-8) primitives.push({ type: 'arc', startX: corner.start.x, startY: corner.start.y, endX: corner.end.x, endY: corner.end.y, angle: corner.angle, lineWidth, locked: outline.locked === true });
  }
  return primitives;
}
