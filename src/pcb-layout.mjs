function bboxOf(component) {
  const box = component?.bbox;
  const left = Number(box?.minX ?? box?.left ?? component?.x);
  const right = Number(box?.maxX ?? box?.right ?? component?.x);
  const top = Number(box?.minY ?? box?.top ?? component?.y);
  const bottom = Number(box?.maxY ?? box?.bottom ?? component?.y);
  return [left, right, top, bottom].every(Number.isFinite) ? { left, right, top, bottom } : null;
}

function move(item, x, y) {
  const dx = x - item.x; const dy = y - item.y;
  item.x = x; item.y = y;
  item.box = { left: item.box.left + dx, right: item.box.right + dx, top: item.box.top + dy, bottom: item.box.bottom + dy };
}

/** Apply alignment/distribution/grid operations to a local component model and return one transform plan. */
export function planComponentArrangement(snapshot, componentIds, arrangements, { includeLocked = false } = {}) {
  const requested = [...new Set((componentIds || []).map(String))];
  const byId = new Map((snapshot?.components || []).map(component => [String(component.id), component]));
  const missing = requested.filter(id => !byId.has(id));
  const skippedLocked = requested.filter(id => byId.get(id)?.locked === true && !includeLocked);
  const items = requested.flatMap(id => {
    const component = byId.get(id); const box = bboxOf(component);
    if (!component || !box || (component.locked === true && !includeLocked)) return [];
    return [{ id, designator: component.designator, originalX: Number(component.x), originalY: Number(component.y), x: Number(component.x), y: Number(component.y), box }];
  });
  if (items.length < 1) return { unit: snapshot?.unit || "mil", changes: [], missing, skippedLocked, arrangements, components: [] };

  for (const operation of arrangements || []) {
    if (operation.type === "align") {
      const left = Math.min(...items.map(item => item.box.left)); const right = Math.max(...items.map(item => item.box.right));
      const top = Math.min(...items.map(item => item.box.top)); const bottom = Math.max(...items.map(item => item.box.bottom));
      for (const item of items) {
        if (operation.mode === "left") move(item, item.x + left - item.box.left, item.y);
        else if (operation.mode === "right") move(item, item.x + right - item.box.right, item.y);
        else if (operation.mode === "top") move(item, item.x, item.y + top - item.box.top);
        else if (operation.mode === "bottom") move(item, item.x, item.y + bottom - item.box.bottom);
        else if (operation.mode === "centerX") move(item, item.x + (left + right) / 2 - (item.box.left + item.box.right) / 2, item.y);
        else if (operation.mode === "centerY") move(item, item.x, item.y + (top + bottom) / 2 - (item.box.top + item.box.bottom) / 2);
      }
    } else if (operation.type === "distribute") {
      if (items.length < 3) continue;
      const horizontal = operation.axis === "horizontal";
      const ordered = [...items].sort((a, b) => horizontal ? a.box.left - b.box.left : a.box.top - b.box.top);
      const sizes = ordered.map(item => horizontal ? item.box.right - item.box.left : item.box.bottom - item.box.top);
      const firstEdge = horizontal ? ordered[0].box.left : ordered[0].box.top;
      const lastEdge = horizontal ? ordered.at(-1).box.right : ordered.at(-1).box.bottom;
      const gap = operation.gap === undefined ? (lastEdge - firstEdge - sizes.reduce((sum, value) => sum + value, 0)) / (ordered.length - 1) : Number(operation.gap);
      let cursor = firstEdge;
      for (const item of ordered) {
        if (horizontal) move(item, item.x + cursor - item.box.left, item.y);
        else move(item, item.x, item.y + cursor - item.box.top);
        cursor += (horizontal ? item.box.right - item.box.left : item.box.bottom - item.box.top) + gap;
      }
    } else if (operation.type === "snap_to_grid") {
      const originX = Number(operation.originX ?? 0); const originY = Number(operation.originY ?? 0);
      for (const item of items) move(item,
        originX + Math.round((item.x - originX) / Number(operation.gridX)) * Number(operation.gridX),
        originY + Math.round((item.y - originY) / Number(operation.gridY)) * Number(operation.gridY));
    }
  }
  const changes = items.flatMap(item => item.x === item.originalX && item.y === item.originalY ? [] : [{ componentId: item.id, x: item.x, y: item.y }]);
  return {
    unit: snapshot?.unit || "mil", includeLocked, missing, skippedLocked, arrangements,
    componentCount: items.length, changeCount: changes.length, changes,
    components: items.map(item => ({ id: item.id, designator: item.designator, before: { x: item.originalX, y: item.originalY }, after: { x: item.x, y: item.y }, bbox: item.box })),
  };
}
