// EasyEDA 插件侧的白名单 RPC 实现。
// 此文件是实际读取和修改当前编辑器文档的边界，MCP 本身不直接调用 EasyEDA API。
type JsonObject = Record<string, unknown>;

interface BackupRecord {
  schematicUuid: string;
  backupUuid: string;
  backupName: string;
}

// 键为“会话 ID + 原理图 UUID”。同一对话操作同一原理图时只会创建一次完整备份。
// Promise 在复制开始前就写入 Map，可避免两个 MCP 同时触发重复备份。
const sessionBackups = new Map<string, Promise<BackupRecord>>();

/** 读取必填字符串参数，并在 RPC 边界尽早拒绝空值或错误类型。 */
function stringParam(params: JsonObject, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || !value) throw new Error(`Invalid ${key}`);
  return value;
}

/** 提取事务操作数组；插件侧再次限制数量，不能只依赖 MCP 的 Zod 校验。 */
function operationsParam(params: JsonObject): JsonObject[] {
  if (!Array.isArray(params.operations) || params.operations.length < 1 || params.operations.length > 100) {
    throw new Error('operations must contain 1-100 items');
  }
  return params.operations as JsonObject[];
}

/**
 * 确保指定原理图页成为当前文档。
 * openDocument 返回后短暂等待，让编辑器完成图元加载，否则紧接着读取可能得到旧页面。
 */
async function openPage(pageUuid: string): Promise<void> {
  const current = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
  if (current?.uuid !== pageUuid) {
    const opened = await eda.dmt_EditorControl.openDocument(pageUuid);
    if (!opened) throw new Error(`Unable to open schematic page ${pageUuid}`);
    await new Promise(resolve => setTimeout(resolve, 180));
  }
}

/** 返回当前工程、原理图和页面的最小上下文，用于连接健康检查。 */
async function systemHealth(): Promise<unknown> {
  const project = await eda.dmt_Project.getCurrentProjectInfo();
  let schematic = null;
  let page = null;
  try { schematic = await eda.dmt_Schematic.getCurrentSchematicInfo(); } catch {}
  try { page = await eda.dmt_Schematic.getCurrentSchematicPageInfo(); } catch {}
  return {
    project: project ? { uuid: project.uuid, name: project.name, friendlyName: project.friendlyName } : null,
    schematic: schematic ? { uuid: schematic.uuid, name: schematic.name, boardName: schematic.parentBoardName } : null,
    page: page ? { uuid: page.uuid, name: page.name } : null,
  };
}

/**
 * 列出当前工程中的全部原理图及图页，不要求先打开任一图页。
 * 同时保留顶层 pages 扁平数组，兼容已经使用 schematic_list_pages 的 MCP 客户端。
 */
async function listPages(): Promise<unknown> {
  let project = null;
  try { project = await eda.dmt_Project.getCurrentProjectInfo(); } catch {}
  const schematicItems = await eda.dmt_Schematic.getAllSchematicsInfo();
  if (!project && schematicItems.length === 0) throw new Error('No open project');
  const schematics = schematicItems.map(schematic => ({
    uuid: schematic.uuid,
    name: schematic.name,
    boardName: schematic.parentBoardName,
    pages: schematic.page.map((page, index) => ({
      index: index + 1,
      uuid: page.uuid,
      name: page.name,
      schematicUuid: schematic.uuid,
      schematicName: schematic.name,
    })),
  }));
  const pages = schematics.flatMap(schematic => schematic.pages.map(page => ({
    ...page,
    boardName: schematic.boardName,
  })));
  return {
    project: project ? { uuid: project.uuid, name: project.name, friendlyName: project.friendlyName } : null,
    schematics,
    pages,
  };
}

/** Read the exact canvas bounds of a component together with its visible attribute text. */
async function getComponentBBox(componentId: string): Promise<{minX: number; minY: number; maxX: number; maxY: number} | undefined> {
  try {
    const attributes = await eda.sch_PrimitiveAttribute.getAll(componentId) || [];
    const attributeIds = attributes
      .filter(attribute => attribute.getState_ParentPrimitiveId() === componentId)
      .map(attribute => attribute.getState_PrimitiveId());
    return await eda.sch_Primitive.getPrimitivesBBox([componentId, ...attributeIds]);
  } catch {
    return undefined;
  }
}

type PrimitiveBounds = {minX: number; minY: number; maxX: number; maxY: number};

/** Build a local collision rectangle when EasyEDA's beta BBox API incorrectly stretches to page origin. */
async function getComponentCollisionBBox(component: any): Promise<PrimitiveBounds | undefined> {
  if (component.getState_ComponentType() === 'sheet') return undefined;
  const x = Number(component.getState_X());
  const y = Number(component.getState_Y());
  const pins = await component.getAllPins() || [];
  const points = [{ x, y }, ...pins.map((pin: any) => ({ x: Number(pin.getState_X()), y: Number(pin.getState_Y()) }))]
    .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (!points.length) return undefined;

  const measured = await getComponentBBox(component.getState_PrimitiveId());
  const pinReachX = points.reduce((maximum, point) => Math.max(maximum, Math.abs(point.x - x)), 0);
  const pinReachY = points.reduce((maximum, point) => Math.max(maximum, Math.abs(point.y - y)), 0);
  const allowanceX = Math.max(120, pinReachX + 120);
  const allowanceY = Math.max(120, pinReachY + 120);
  if (measured && measured.minX >= x - allowanceX && measured.maxX <= x + allowanceX
    && measured.minY >= y - allowanceY && measured.maxY <= y + allowanceY) return measured;

  if (component.getState_ComponentType() === 'netport') {
    const labelLength = Array.from(String(component.getState_Net() || '')).length;
    const horizontalWidth = Math.max(40, 24 + labelLength * 7);
    const vertical = component.getState_Rotation() === 90 || component.getState_Rotation() === 270;
    const width = vertical ? 20 : horizontalWidth;
    const height = vertical ? horizontalWidth : 20;
    return { minX: x - width / 2, minY: y - height / 2, maxX: x + width / 2, maxY: y + height / 2 };
  }

  const padding = 8;
  return {
    minX: Math.min(...points.map(point => point.x)) - padding,
    minY: Math.min(...points.map(point => point.y)) - padding,
    maxX: Math.max(...points.map(point => point.x)) + padding,
    maxY: Math.max(...points.map(point => point.y)) + padding,
  };
}

/**
 * 读取一页中的器件、引脚和导线，并转换为可序列化的普通对象。
 * includeWires=false 可减少大页面的 RPC 载荷。
 */
async function inspectPage(params: JsonObject): Promise<unknown> {
  const pageUuid = stringParam(params, 'pageUuid');
  await openPage(pageUuid);
  const page = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
  const ids = await eda.sch_PrimitiveComponent.getAllPrimitiveId();
  const components = await eda.sch_PrimitiveComponent.get(ids);
  const result = [];
  for (const component of components) {
    // 引脚属于器件内部对象，需要逐器件异步读取。
    const pins = await component.getAllPins() || [];
    const componentState = component.getState_Component() as unknown as {name?: string; libraryUuid?: string; uuid?: string};
    const componentId = component.getState_PrimitiveId();
    const bbox = await getComponentBBox(componentId);
    const attributes = (await eda.sch_PrimitiveAttribute.getAll(componentId) || [])
      .filter(attribute => attribute.getState_ParentPrimitiveId() === componentId)
      .map(attribute => ({
        id: attribute.getState_PrimitiveId(),
        key: attribute.getState_Key(),
        value: attribute.getState_Value(),
        keyVisible: attribute.getState_KeyVisible(),
        valueVisible: attribute.getState_ValueVisible(),
        x: attribute.getState_X(),
        y: attribute.getState_Y(),
      }));
    result.push({
      id: componentId,
      type: component.getState_ComponentType(),
      designator: component.getState_Designator(),
      name: componentState?.name,
      libraryUuid: componentState?.libraryUuid,
      deviceUuid: componentState?.uuid,
      net: component.getState_Net(),
      x: component.getState_X(), y: component.getState_Y(), rotation: component.getState_Rotation(),
      mirror: component.getState_Mirror(),
      bbox,
      attributes,
      pins: pins.map(pin => ({
        id: pin.getState_PrimitiveId(), name: pin.getState_PinName(), number: pin.getState_PinNumber(),
        x: pin.getState_X(), y: pin.getState_Y(), rotation: pin.getState_Rotation(), pinType: pin.getState_pinType(),
        noConnected: pin.getState_NoConnected() === true,
      })),
    });
  }
  // 导线折线保持 EasyEDA 原始坐标格式，供 MCP 可读性分析和后续编辑使用。
  const wires = params.includeWires === false ? [] : (await eda.sch_PrimitiveWire.getAll()).map(wire => ({
    id: wire.getState_PrimitiveId(), net: wire.getState_Net(), line: wire.getState_Line(),
  }));
  // Network labels are page-level attribute primitives, not components or free text.
  // Returning them explicitly lets callers diagnose and repair labels that merely sit near a wire.
  const netLabels = (await eda.sch_PrimitiveAttribute.getAll() || [])
    .filter(attribute => String(attribute.getState_PrimitiveType()).toLocaleLowerCase() === 'netlabel')
    .map(attribute => ({
      id: attribute.getState_PrimitiveId(),
      type: attribute.getState_PrimitiveType(),
      parentPrimitiveId: attribute.getState_ParentPrimitiveId(),
      key: attribute.getState_Key(),
      net: attribute.getState_Value(),
      keyVisible: attribute.getState_KeyVisible(),
      valueVisible: attribute.getState_ValueVisible(),
      x: attribute.getState_X(),
      y: attribute.getState_Y(),
      rotation: attribute.getState_Rotation(),
    }));
  if (!page) throw new Error('No active schematic page');
  return { page: { uuid: page.uuid, name: page.name }, components: result, netLabels, wires };
}

/** 搜索器件库，并只返回后续创建器件所需的稳定 UUID 与采购元数据。 */
async function searchComponents(params: JsonObject): Promise<unknown> {
  const query = stringParam(params, 'query');
  const limit = Math.max(1, Math.min(50, Number(params.limit) || 10));
  const items = await eda.lib_Device.search(query, undefined, undefined, undefined, limit, 1);
  return items.slice(0, limit).map(item => {
    const extra = item as unknown as Record<string, unknown>;
    return {
      uuid: item.uuid, libraryUuid: item.libraryUuid, name: item.name, symbolName: item.symbolName,
      footprintName: item.footprintName, manufacturer: extra.manufacturer, manufacturerId: extra.manufacturerId,
      supplier: extra.supplier, supplierId: extra.supplierId, description: item.description, properties: item.otherProperty,
    };
  });
}

/**
 * 在不修改文档的情况下验证操作白名单、页面存在性和被引用图元。
 * 这不是完整电气预检：例如导线是否会与现有网络意外合并，仍需更高层检查。
 */
async function validateOperations(params: JsonObject): Promise<unknown> {
  const operations = operationsParam(params);
  // 工程级读取不依赖当前焦点图页，因此关闭所有图页后仍可以校验目标 pageUuid。
  const pages = await eda.dmt_Schematic.getAllSchematicPagesInfo();
  const schematics = await eda.dmt_Schematic.getAllSchematicsInfo();
  const schematicIds = new Set(schematics.map(schematic => schematic.uuid));
  const pageIds = new Set(pages.map(page => page.uuid));
  const pageToSchematic = new Map(pages.map(page => [page.uuid, page.parentSchematicUuid]));
  const affectedSchematicIds = new Set<string>();
  const findings: JsonObject[] = [];
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    const type = String(operation.type || '');
    const pageUuid = String(operation.pageUuid || '');
    if (!ALLOWED_OPERATIONS.has(type)) { findings.push({ index, level: 'error', message: 'Unsupported operation', type }); continue; }
    if (type === 'rename_schematic' && !schematicIds.has(String(operation.schematicUuid || ''))) {
      findings.push({ index, level: 'error', message: 'Schematic does not exist', schematicUuid: operation.schematicUuid });
      continue;
    }
    if (pageUuid && !pageIds.has(pageUuid)) { findings.push({ index, level: 'error', message: 'Schematic page does not exist', pageUuid }); continue; }
    if (pageUuid) affectedSchematicIds.add(String(pageToSchematic.get(pageUuid)));
    if (type === 'delete_page') {
      const schematicUuid = pageToSchematic.get(pageUuid);
      const siblingCount = pages.filter(page => page.parentSchematicUuid === schematicUuid).length;
      if (siblingCount <= 1) findings.push({ index, level: 'error', message: 'Cannot delete the only schematic page' });
    }
    // 只有引用现有图元的操作需要打开页面并核对 ID。
    if (type === 'delete_primitives' || type === 'connect_pins' || type === 'move_component' || type === 'transform_components'
      || type === 'translate_group' || type === 'set_no_connects' || type === 'set_component_attribute' || type === 'set_net_label'
      || type === 'create_port_with_wire') {
      await openPage(pageUuid);
      const componentIds = new Set(await eda.sch_PrimitiveComponent.getAllPrimitiveId());
      const wireIds = new Set(await eda.sch_PrimitiveWire.getAllPrimitiveId());
      const textIds = new Set(await eda.sch_PrimitiveText.getAllPrimitiveId());
      if (type === 'delete_primitives') {
        for (const id of (operation.componentIds as string[] || [])) if (!componentIds.has(id)) findings.push({ index, level: 'error', message: 'Component not found', id });
        for (const id of (operation.wireIds as string[] || [])) if (!wireIds.has(id)) findings.push({ index, level: 'error', message: 'Wire not found', id });
        for (const id of (operation.textIds as string[] || [])) if (!textIds.has(id)) findings.push({ index, level: 'error', message: 'Text not found', id });
      } else if (type === 'connect_pins') {
        for (const endpoint of [operation.from, operation.to] as JsonObject[]) {
          if (!endpoint || !componentIds.has(String(endpoint.componentId))) findings.push({ index, level: 'error', message: 'Endpoint component not found', id: endpoint?.componentId });
        }
      } else if (type === 'move_component' && !componentIds.has(String(operation.componentId))) {
        findings.push({ index, level: 'error', message: 'Component not found', id: operation.componentId });
      } else if (type === 'transform_components') {
        const changes = operation.changes as unknown;
        if (!Array.isArray(changes) || changes.length < 1 || changes.length > 50) {
          findings.push({ index, level: 'error', message: 'changes must contain 1-50 component transformations' });
          continue;
        }
        const seenIds = new Set<string>();
        for (const rawChange of changes) {
          const change = rawChange as JsonObject;
          const componentId = String(change?.componentId || '');
          if (!componentId || !componentIds.has(componentId)) {
            findings.push({ index, level: 'error', message: 'Component not found', id: componentId });
            continue;
          }
          if (seenIds.has(componentId)) {
            findings.push({ index, level: 'error', message: 'Component appears more than once in changes', id: componentId });
            continue;
          }
          seenIds.add(componentId);
          const hasTransform = change.x !== undefined || change.y !== undefined || change.rotation !== undefined || change.mirror !== undefined;
          if (!hasTransform) findings.push({ index, level: 'error', message: 'Transformation must include x, y, rotation, or mirror', id: componentId });
          if (change.x !== undefined && (typeof change.x !== 'number' || !Number.isFinite(change.x))) findings.push({ index, level: 'error', message: 'x must be a finite number', id: componentId });
          if (change.y !== undefined && (typeof change.y !== 'number' || !Number.isFinite(change.y))) findings.push({ index, level: 'error', message: 'y must be a finite number', id: componentId });
          if (change.rotation !== undefined && ![0, 90, 180, 270].includes(Number(change.rotation))) findings.push({ index, level: 'error', message: 'rotation must be 0, 90, 180, or 270', id: componentId });
          if (change.mirror !== undefined && typeof change.mirror !== 'boolean') findings.push({ index, level: 'error', message: 'mirror must be boolean', id: componentId });
          const component = await eda.sch_PrimitiveComponent.get(componentId);
          if (!component || Array.isArray(component) || component.getState_ComponentType() !== 'part') {
            findings.push({ index, level: 'error', message: 'transform_components requires part components', id: componentId });
          }
        }
      } else if (type === 'translate_group') {
        const selectedComponentIds = operation.componentIds as string[] || [];
        const selectedWireIds = operation.wireIds as string[] || [];
        if (selectedComponentIds.length === 0 && selectedWireIds.length === 0) {
          findings.push({ index, level: 'error', message: 'translate_group requires at least one component or wire' });
        }
        if (Number(operation.deltaX) === 0 && Number(operation.deltaY) === 0) {
          findings.push({ index, level: 'error', message: 'translate_group delta cannot be zero' });
        }
        for (const id of selectedComponentIds) if (!componentIds.has(id)) findings.push({ index, level: 'error', message: 'Component not found', id });
        for (const id of selectedWireIds) if (!wireIds.has(id)) findings.push({ index, level: 'error', message: 'Wire not found', id });
      } else if (type === 'set_no_connects') {
        const componentId = String(operation.componentId || '');
        const pinNumbers = operation.pinNumbers as unknown;
        if (!componentIds.has(componentId)) {
          findings.push({ index, level: 'error', message: 'Component not found', id: componentId });
          continue;
        }
        if (!Array.isArray(pinNumbers) || pinNumbers.length < 1 || pinNumbers.length > 100
          || pinNumbers.some(pinNumber => typeof pinNumber !== 'string' || !pinNumber)) {
          findings.push({ index, level: 'error', message: 'pinNumbers must contain 1-100 non-empty strings' });
          continue;
        }
        if (new Set(pinNumbers).size !== pinNumbers.length) {
          findings.push({ index, level: 'error', message: 'pinNumbers must not contain duplicates' });
          continue;
        }
        if (typeof operation.noConnected !== 'boolean') {
          findings.push({ index, level: 'error', message: 'noConnected must be boolean' });
          continue;
        }
        const component = await eda.sch_PrimitiveComponent.get(componentId);
        if (!component || Array.isArray(component) || component.getState_ComponentType() !== 'part') {
          findings.push({ index, level: 'error', message: 'set_no_connects requires a part component', id: componentId });
          continue;
        }
        const availablePinNumbers = new Set((await component.getAllPins() || []).map(pin => pin.getState_PinNumber()));
        for (const pinNumber of pinNumbers) {
          if (!availablePinNumbers.has(pinNumber)) findings.push({ index, level: 'error', message: 'Pin not found', id: componentId, pinNumber });
        }
      } else if (type === 'set_component_attribute') {
        const componentId = String(operation.componentId || '');
        const key = String(operation.key || '');
        if (!componentIds.has(componentId)) {
          findings.push({ index, level: 'error', message: 'Component not found', id: componentId });
          continue;
        }
        if (!key || typeof operation.value !== 'string') {
          findings.push({ index, level: 'error', message: 'set_component_attribute requires a non-empty key and string value', id: componentId });
          continue;
        }
        const attributes = await eda.sch_PrimitiveAttribute.getAll(componentId) || [];
        const attribute = attributes.find(item => item.getState_ParentPrimitiveId() === componentId
          && item.getState_Key().toLocaleLowerCase() === key.toLocaleLowerCase());
        if (!attribute) findings.push({ index, level: 'error', message: `Attribute not found: ${key}`, id: componentId });
      } else if (type === 'set_net_label') {
        const labelId = String(operation.labelId || '');
        const label = await eda.sch_PrimitiveAttribute.get(labelId);
        if (!label || Array.isArray(label)
          || String(label.getState_PrimitiveType()).toLocaleLowerCase() !== 'netlabel') {
          findings.push({ index, level: 'error', message: 'Native net label not found', id: labelId });
          continue;
        }
        const hasChange = operation.x !== undefined || operation.y !== undefined || operation.net !== undefined;
        if (!hasChange) findings.push({ index, level: 'error', message: 'set_net_label requires x, y, or net', id: labelId });
        if (operation.x !== undefined && (typeof operation.x !== 'number' || !Number.isFinite(operation.x))) {
          findings.push({ index, level: 'error', message: 'x must be a finite number', id: labelId });
        }
        if (operation.y !== undefined && (typeof operation.y !== 'number' || !Number.isFinite(operation.y))) {
          findings.push({ index, level: 'error', message: 'y must be a finite number', id: labelId });
        }
        if (operation.net !== undefined && (typeof operation.net !== 'string' || !operation.net)) {
          findings.push({ index, level: 'error', message: 'net must be a non-empty string', id: labelId });
        }
      } else if (type === 'create_port_with_wire') {
        const sourceComponentId = String(operation.sourceComponentId || '');
        if (!componentIds.has(sourceComponentId)) {
          findings.push({ index, level: 'error', message: 'Source component not found', id: sourceComponentId });
        }
        const line = operation.line as unknown;
        if (!Array.isArray(line) || line.length < 4 || line.length % 2 !== 0
          || line.some(coordinate => typeof coordinate !== 'number' || !Number.isFinite(coordinate))) {
          findings.push({ index, level: 'error', message: 'create_port_with_wire requires a finite x/y polyline' });
        }
        const expectedBounds = operation.expectedBounds as JsonObject;
        if (!isFiniteBounds(expectedBounds)) {
          findings.push({ index, level: 'error', message: 'create_port_with_wire requires finite expectedBounds' });
        }
      }
    }
  }
  if (affectedSchematicIds.size > 1) {
    findings.push({ level: 'error', message: 'One write request cannot span multiple schematics' });
  }
  return { valid: !findings.some(item => item.level === 'error'), findings, pageCount: pages.length };
}

// 插件最终允许执行的写操作集合；即使绕过 MCP Schema，也不能调用集合外方法。
const ALLOWED_OPERATIONS = new Set([
  'rename_schematic',
  'rename_page', 'delete_page', 'delete_primitives', 'create_component', 'move_component', 'transform_components', 'translate_group', 'create_wire',
  'connect_pins', 'create_net_port', 'create_port_with_wire', 'create_net_flag', 'set_no_connects', 'set_component_attribute', 'set_net_label', 'create_text',
]);

/** 根据器件 ID 和引脚号解析绝对坐标，供 connect_pins 自动生成折线。 */
async function getPin(componentId: string, pinNumber: string): Promise<{x: number; y: number}> {
  const component = await eda.sch_PrimitiveComponent.get(componentId);
  if (!component || Array.isArray(component)) throw new Error(`Component not found: ${componentId}`);
  const pins = await component.getAllPins() || [];
  const pin = pins.find(item => item.getState_PinNumber() === String(pinNumber));
  if (!pin) throw new Error(`Pin ${pinNumber} not found on component ${componentId}`);
  return { x: pin.getState_X(), y: pin.getState_Y() };
}

/** 平移导线的一维或分段坐标数组，并保持原有嵌套结构。 */
function translateWireLine(line: Array<number> | Array<Array<number>>, deltaX: number, deltaY: number): Array<number> | Array<Array<number>> {
  if (line.length > 0 && Array.isArray(line[0])) {
    return (line as Array<Array<number>>).map(segment => translateWireLine(segment, deltaX, deltaY) as Array<number>);
  }
  return (line as Array<number>).map((coordinate, index) => coordinate + (index % 2 === 0 ? deltaX : deltaY));
}

function isFiniteBounds(bounds: JsonObject | undefined): bounds is JsonObject & {left: number; top: number; right: number; bottom: number} {
  return !!bounds && typeof bounds.left === 'number' && Number.isFinite(bounds.left)
    && typeof bounds.top === 'number' && Number.isFinite(bounds.top)
    && typeof bounds.right === 'number' && Number.isFinite(bounds.right)
    && typeof bounds.bottom === 'number' && Number.isFinite(bounds.bottom)
    && bounds.left <= bounds.right && bounds.top <= bounds.bottom;
}

function normalizeBounds(bounds: {minX: number; minY: number; maxX: number; maxY: number} | JsonObject): {left: number; top: number; right: number; bottom: number} {
  if ('minX' in bounds) return { left: Number(bounds.minX), top: Number(bounds.minY), right: Number(bounds.maxX), bottom: Number(bounds.maxY) };
  return { left: Number(bounds.left), top: Number(bounds.top), right: Number(bounds.right), bottom: Number(bounds.bottom) };
}

function rectanglesOverlap(left: {left: number; top: number; right: number; bottom: number}, right: {left: number; top: number; right: number; bottom: number}): boolean {
  return !(left.right < right.left || left.left > right.right || left.bottom < right.top || left.top > right.bottom);
}

function wireIntersectsBounds(line: Array<number> | Array<Array<number>>, bounds: {left: number; top: number; right: number; bottom: number}): boolean {
  if (line.length > 0 && Array.isArray(line[0])) return (line as Array<Array<number>>).some(item => wireIntersectsBounds(item, bounds));
  const flat = line as Array<number>;
  for (let index = 0; index + 3 < flat.length; index += 2) {
    const x1 = flat[index]; const y1 = flat[index + 1]; const x2 = flat[index + 2]; const y2 = flat[index + 3];
    if ((x1 >= bounds.left && x1 <= bounds.right && y1 >= bounds.top && y1 <= bounds.bottom)
      || (x2 >= bounds.left && x2 <= bounds.right && y2 >= bounds.top && y2 <= bounds.bottom)) return true;
    if (y1 === y2 && y1 >= bounds.top && y1 <= bounds.bottom
      && Math.max(x1, x2) >= bounds.left && Math.min(x1, x2) <= bounds.right) return true;
    if (x1 === x2 && x1 >= bounds.left && x1 <= bounds.right
      && Math.max(y1, y2) >= bounds.top && Math.min(y1, y2) <= bounds.bottom) return true;
  }
  return false;
}

/**
 * 确保当前 MCP 会话已经为当前原理图建立安全点。
 * 同一会话如果切换到另一份原理图，新原理图仍会单独备份一次。
 */
async function ensureSessionBackup(sessionId: string, schematicUuid: string): Promise<BackupRecord & {created: boolean}> {
  const key = `${sessionId}:${schematicUuid}`;
  const existing = sessionBackups.get(key);
  if (existing) return { ...(await existing), created: false };

  const pending = (async (): Promise<BackupRecord> => {
    const backupUuid = await eda.dmt_Schematic.copySchematic(schematicUuid);
    if (!backupUuid) throw new Error('Unable to create session schematic backup; write aborted');
    const schematics = await eda.dmt_Schematic.getAllSchematicsInfo();
    const copied = schematics.find(item => item.uuid === backupUuid);
    const generatedName = String(copied?.name || `schematic_${backupUuid.slice(0, 8)}`);
    const backupName = `${generatedName.replace(/\[(?:main|backup)\]/gi, '').replace(/\s+_/g, '_').trim()} [backup]`;
    const renamed = await eda.dmt_Schematic.modifySchematicName(backupUuid, backupName);
    if (!renamed) throw new Error(`Session backup was created but could not be tagged [backup]: ${backupUuid}`);
    return { schematicUuid, backupUuid, backupName };
  })();
  sessionBackups.set(key, pending);

  try {
    const record = await pending;
    // 插件可能长期运行，限制历史会话记录数量，避免 Map 无限增长。
    if (sessionBackups.size > 64) {
      const oldestKey = sessionBackups.keys().next().value;
      if (oldestKey && oldestKey !== key) sessionBackups.delete(oldestKey);
    }
    return { ...record, created: true };
  } catch (error) {
    // 复制失败时移除缓存，下一次写入可以重新尝试；本次写入不会开始。
    sessionBackups.delete(key);
    throw error;
  }
}

/**
 * 校验并直接执行白名单写操作。
 *
 * 本会话首次写入当前原理图前创建一次完整备份，后续调用直接复用该安全点。
 * 操作仍按顺序执行并逐条保存；中途失败时不会自动回滚，可用返回的 backupUuid 人工恢复。
 */
async function applyOperations(params: JsonObject): Promise<unknown> {
  const sessionId = stringParam(params, 'sessionId');
  const operations = operationsParam(params);
  const validation = await validateOperations(params) as {valid: boolean; findings: unknown[]};
  if (!validation.valid) throw new Error(`Operation validation failed: ${JSON.stringify(validation.findings)}`);
  // 没有活动图页时先打开本批操作的目标页，确保后续获取原理图和创建备份指向正确文档。
  const firstPageUuid = operations.map(operation => String(operation.pageUuid || '')).find(Boolean);
  if (firstPageUuid) await openPage(firstPageUuid);
  const schematic = await eda.dmt_Schematic.getCurrentSchematicInfo();
  if (!schematic) throw new Error('No active schematic');
  // 备份只在本会话第一次写当前原理图时发生，失败则阻止任何后续修改。
  const backup = await ensureSessionBackup(sessionId, schematic.uuid);
  const results = [];
  // 注意：此循环没有补偿动作；效率优先模式依靠会话安全点，而不是逐事务回滚。
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    const type = String(operation.type);
    const pageUuid = String(operation.pageUuid || '');
    if (pageUuid) await openPage(pageUuid);
    let value: unknown;
    switch (type) {
      case 'rename_schematic': value = await eda.dmt_Schematic.modifySchematicName(String(operation.schematicUuid), String(operation.name)); break;
      case 'rename_page': value = await eda.dmt_Schematic.modifySchematicPageName(pageUuid, String(operation.name)); break;
      case 'delete_page': value = await eda.dmt_Schematic.deleteSchematicPage(pageUuid); break;
      case 'delete_primitives': {
        // 线和器件分开删除；空数组直接视为成功，避免无意义 API 调用。
        const wireIds = operation.wireIds as string[] || [];
        const componentIds = operation.componentIds as string[] || [];
        const textIds = operation.textIds as string[] || [];
        value = {
          wiresDeleted: wireIds.length ? await eda.sch_PrimitiveWire.delete(wireIds) : true,
          componentsDeleted: componentIds.length ? await eda.sch_PrimitiveComponent.delete(componentIds) : true,
          textsDeleted: textIds.length ? await eda.sch_PrimitiveText.delete(textIds) : true,
        };
        break;
      }
      case 'create_component': {
        // 使用库 UUID + 器件 UUID 创建实体，并按需覆盖位号。
        const component = await eda.sch_PrimitiveComponent.create(
          { libraryUuid: String(operation.libraryUuid), uuid: String(operation.deviceUuid) },
          Number(operation.x), Number(operation.y), undefined, Number(operation.rotation) || 0, false,
          operation.addIntoBom !== false, operation.addIntoPcb !== false,
        );
        if (!component) throw new Error('Component creation failed');
        if (operation.designator) { component.setState_Designator(String(operation.designator)); await component.done(); }
        value = { componentId: component.getState_PrimitiveId(), designator: component.getState_Designator() };
        break;
      }
      case 'move_component': {
        // 使用官方 modify 接口设置绝对坐标；仅允许移动普通器件，网络端口和标志不走此入口。
        const componentId = String(operation.componentId);
        const existing = await eda.sch_PrimitiveComponent.get(componentId);
        if (!existing || Array.isArray(existing)) throw new Error(`Component not found: ${componentId}`);
        const before = { x: existing.getState_X(), y: existing.getState_Y() };
        const moved = await eda.sch_PrimitiveComponent.modify(componentId, {
          x: Number(operation.x),
          y: Number(operation.y),
        });
        if (!moved) throw new Error(`Component move failed: ${componentId}`);
        value = {
          componentId,
          designator: moved.getState_Designator(),
          before,
          after: { x: moved.getState_X(), y: moved.getState_Y() },
        };
        break;
      }
      case 'transform_components': {
        // Wires are intentionally left unchanged; pin coordinates are returned so callers can reconnect them safely.
        const transformedComponents = [];
        for (const rawChange of operation.changes as JsonObject[]) {
          const componentId = String(rawChange.componentId);
          const existing = await eda.sch_PrimitiveComponent.get(componentId);
          if (!existing || Array.isArray(existing)) throw new Error(`Component not found: ${componentId}`);
          const beforePins = (await existing.getAllPins() || []).map(pin => ({
            pinNumber: pin.getState_PinNumber(),
            x: pin.getState_X(),
            y: pin.getState_Y(),
          }));
          const before = {
            x: existing.getState_X(),
            y: existing.getState_Y(),
            rotation: existing.getState_Rotation(),
            mirror: existing.getState_Mirror(),
          };
          const transformed = await eda.sch_PrimitiveComponent.modify(componentId, {
            x: rawChange.x === undefined ? before.x : Number(rawChange.x),
            y: rawChange.y === undefined ? before.y : Number(rawChange.y),
            rotation: rawChange.rotation === undefined ? before.rotation : Number(rawChange.rotation),
            mirror: rawChange.mirror === undefined ? before.mirror : rawChange.mirror === true,
          });
          if (!transformed) throw new Error(`Component transformation failed: ${componentId}`);
          const afterPins = await transformed.getAllPins() || [];
          const afterPinsByNumber = new Map(afterPins.map(pin => [pin.getState_PinNumber(), pin]));
          const pins = beforePins.map(pin => {
            const pinNumber = pin.pinNumber;
            const afterPin = afterPinsByNumber.get(pinNumber);
            const pinBefore = { x: pin.x, y: pin.y };
            const pinAfter = afterPin ? { x: afterPin.getState_X(), y: afterPin.getState_Y() } : null;
            return { pinNumber, before: pinBefore, after: pinAfter, moved: !pinAfter || pinBefore.x !== pinAfter.x || pinBefore.y !== pinAfter.y };
          });
          transformedComponents.push({
            componentId,
            designator: transformed.getState_Designator(),
            before,
            after: {
              x: transformed.getState_X(),
              y: transformed.getState_Y(),
              rotation: transformed.getState_Rotation(),
              mirror: transformed.getState_Mirror(),
            },
            pins,
          });
        }
        value = { components: transformedComponents, wiresModified: false };
        break;
      }
      case 'translate_group': {
        // 整块平移采用统一增量：器件修改坐标，导线所有端点和拐点保持相对形状一起移动。
        const deltaX = Number(operation.deltaX);
        const deltaY = Number(operation.deltaY);
        const movedComponents = [];
        const movedWires = [];
        for (const componentId of operation.componentIds as string[] || []) {
          const component = await eda.sch_PrimitiveComponent.get(componentId);
          if (!component || Array.isArray(component)) throw new Error(`Component not found: ${componentId}`);
          const before = { x: component.getState_X(), y: component.getState_Y() };
          const moved = await eda.sch_PrimitiveComponent.modify(componentId, {
            x: before.x + deltaX,
            y: before.y + deltaY,
          });
          if (!moved) throw new Error(`Component move failed: ${componentId}`);
          movedComponents.push({ componentId, before, after: { x: moved.getState_X(), y: moved.getState_Y() } });
        }
        for (const wireId of operation.wireIds as string[] || []) {
          const wire = await eda.sch_PrimitiveWire.get(wireId);
          if (!wire || Array.isArray(wire)) throw new Error(`Wire not found: ${wireId}`);
          const before = wire.getState_Line();
          const after = translateWireLine(before, deltaX, deltaY);
          const moved = await eda.sch_PrimitiveWire.modify(wireId, { line: after });
          if (!moved) throw new Error(`Wire move failed: ${wireId}`);
          movedWires.push({ wireId, before, after: moved.getState_Line() });
        }
        value = { deltaX, deltaY, components: movedComponents, wires: movedWires };
        break;
      }
      case 'create_wire': {
        // 未提供 net 时让 EasyEDA 按端点和交点继承网络；这也可能造成意外并网。
        const wire = await eda.sch_PrimitiveWire.create(operation.line as number[], operation.net ? String(operation.net) : undefined);
        if (!wire) throw new Error('Wire creation failed');
        value = { wireId: wire.getState_PrimitiveId(), net: wire.getState_Net(), line: wire.getState_Line() };
        break;
      }
      case 'connect_pins': {
        const fromArg = operation.from as JsonObject;
        const toArg = operation.to as JsonObject;
        const from = await getPin(String(fromArg.componentId), String(fromArg.pinNumber));
        const to = await getPin(String(toArg.componentId), String(toArg.pinNumber));
        // 同轴时使用直线，否则生成一个直角；horizontalFirst 决定先横走还是先竖走。
        const line = from.x === to.x || from.y === to.y ? [from.x, from.y, to.x, to.y]
          : operation.horizontalFirst !== false ? [from.x, from.y, to.x, from.y, to.x, to.y]
            : [from.x, from.y, from.x, to.y, to.x, to.y];
        const wire = await eda.sch_PrimitiveWire.create(line, operation.net ? String(operation.net) : undefined);
        if (!wire) throw new Error('Pin connection failed');
        value = { wireId: wire.getState_PrimitiveId(), net: wire.getState_Net(), line: wire.getState_Line() };
        break;
      }
      case 'create_net_port': {
        // 网络端口用于跨页、长距离或电源连接，不应代替功能块内部直接连线。
        const port = await eda.sch_PrimitiveComponent.createNetPort(
          String(operation.direction) as 'IN' | 'OUT' | 'BI', String(operation.net),
          Number(operation.x), Number(operation.y), Number(operation.rotation) || 0, false,
        );
        if (!port) throw new Error('Net port creation failed');
        value = { componentId: port.getState_PrimitiveId(), net: port.getState_Net() };
        break;
      }
      case 'create_port_with_wire': {
        // Treat a port as a complete rectangle. Create, measure and verify it before committing the connecting wire.
        const obstacleIds = await eda.sch_PrimitiveComponent.getAllPrimitiveId();
        const obstacles = await eda.sch_PrimitiveComponent.get(obstacleIds);
        const obstacleBounds = [];
        for (const obstacle of obstacles) {
          const bounds = await getComponentCollisionBBox(obstacle);
          if (bounds) obstacleBounds.push({ componentId: obstacle.getState_PrimitiveId(), bounds: normalizeBounds(bounds) });
        }
        const existingWires = await eda.sch_PrimitiveWire.getAll();
        let portId: string | undefined;
        let wireId: string | undefined;
        try {
          const port = await eda.sch_PrimitiveComponent.createNetPort(
            String(operation.direction) as 'IN' | 'OUT' | 'BI', String(operation.net),
            Number(operation.x), Number(operation.y), Number(operation.rotation) || 0, false,
          );
          if (!port) throw new Error('Net port creation failed');
          portId = port.getState_PrimitiveId();
          const measured = await getComponentBBox(portId);
          const portX = Number(operation.x);
          const portY = Number(operation.y);
          const measuredIsPlausible = measured && measured.minX >= portX - 300 && measured.maxX <= portX + 300
            && measured.minY >= portY - 300 && measured.maxY <= portY + 300;
          const actualBounds = measuredIsPlausible
            ? normalizeBounds(measured)
            : normalizeBounds(operation.expectedBounds as JsonObject);
          const componentCollision = obstacleBounds.find(item => rectanglesOverlap(actualBounds, item.bounds));
          if (componentCollision) throw new Error(`Port rectangle overlaps component ${componentCollision.componentId}`);
          const wireCollision = existingWires.find(existing => wireIntersectsBounds(existing.getState_Line(), actualBounds));
          if (wireCollision) throw new Error(`Port rectangle overlaps wire ${wireCollision.getState_PrimitiveId()}`);

          const wire = await eda.sch_PrimitiveWire.create(operation.line as number[], String(operation.net));
          if (!wire) throw new Error('Port wire creation failed');
          wireId = wire.getState_PrimitiveId();
          value = {
            componentId: portId,
            wireId,
            net: port.getState_Net(),
            line: wire.getState_Line(),
            expectedBounds: operation.expectedBounds,
            actualBounds,
          };
        } catch (error) {
          let rollbackSucceeded = true;
          if (wireId) rollbackSucceeded = (await eda.sch_PrimitiveWire.delete([wireId])) !== false && rollbackSucceeded;
          if (portId) rollbackSucceeded = (await eda.sch_PrimitiveComponent.delete([portId])) !== false && rollbackSucceeded;
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`${message}; create_port_with_wire rollback=${rollbackSucceeded ? 'ok' : 'failed'}`);
        }
        break;
      }
      case 'create_net_flag': {
        // 使用 EasyEDA 原生网络标志，不再通过公共器件库 UUID 模拟电源或地符号。
        const flag = await eda.sch_PrimitiveComponent.createNetFlag(
          String(operation.identification) as 'Power' | 'Ground' | 'AnalogGround' | 'ProtectGround',
          String(operation.net), Number(operation.x), Number(operation.y), Number(operation.rotation) || 0, false,
        );
        if (!flag) throw new Error('Net flag creation failed');
        value = { componentId: flag.getState_PrimitiveId(), net: flag.getState_Net() };
        break;
      }
      case 'set_no_connects': {
        // 非连接标识是器件引脚自身的 noConnected 状态，不是需要放置的普通符号。
        const componentId = String(operation.componentId);
        const component = await eda.sch_PrimitiveComponent.get(componentId);
        if (!component || Array.isArray(component)) throw new Error(`Component not found: ${componentId}`);
        const pins = await component.getAllPins() || [];
        const pinsByNumber = new Map(pins.map(pin => [pin.getState_PinNumber(), pin]));
        const noConnected = operation.noConnected === true;
        const changes = [];
        for (const pinNumber of operation.pinNumbers as string[]) {
          const pin = pinsByNumber.get(pinNumber);
          if (!pin) throw new Error(`Pin ${pinNumber} not found on component ${componentId}`);
          const before = pin.getState_NoConnected() === true;
          if (before !== noConnected) {
            pin.setState_NoConnected(noConnected);
            await pin.done();
          }
          changes.push({ pinNumber, before, after: noConnected, changed: before !== noConnected });
        }
        value = { componentId, noConnected, pins: changes };
        break;
      }
      case 'set_component_attribute': {
        const componentId = String(operation.componentId);
        const key = String(operation.key);
        const attributes = await eda.sch_PrimitiveAttribute.getAll(componentId) || [];
        const attribute = attributes.find(item => item.getState_ParentPrimitiveId() === componentId
          && item.getState_Key().toLocaleLowerCase() === key.toLocaleLowerCase());
        if (!attribute) throw new Error(`Attribute ${key} not found on component ${componentId}`);
        const before = {
          value: attribute.getState_Value(),
          keyVisible: attribute.getState_KeyVisible(),
          valueVisible: attribute.getState_ValueVisible(),
        };
        const modified = await eda.sch_PrimitiveAttribute.modify(attribute, {
          value: String(operation.value),
          keyVisible: operation.keyVisible === true,
          valueVisible: operation.valueVisible !== false,
        });
        if (!modified) throw new Error(`Attribute ${key} update failed on component ${componentId}`);
        value = {
          componentId,
          attributeId: modified.getState_PrimitiveId(),
          key: modified.getState_Key(),
          before,
          after: {
            value: modified.getState_Value(),
            keyVisible: modified.getState_KeyVisible(),
            valueVisible: modified.getState_ValueVisible(),
          },
        };
        break;
      }
      case 'set_net_label': {
        const labelId = String(operation.labelId);
        const existing = await eda.sch_PrimitiveAttribute.get(labelId);
        if (!existing || Array.isArray(existing)
          || String(existing.getState_PrimitiveType()).toLocaleLowerCase() !== 'netlabel') {
          throw new Error(`Native net label not found: ${labelId}`);
        }
        const before = {
          net: existing.getState_Value(),
          x: existing.getState_X(),
          y: existing.getState_Y(),
        };
        const property: {x?: number; y?: number; value?: string} = {};
        if (operation.x !== undefined) property.x = Number(operation.x);
        if (operation.y !== undefined) property.y = Number(operation.y);
        if (operation.net !== undefined) property.value = String(operation.net);
        const modified = await eda.sch_PrimitiveAttribute.modify(existing, property);
        if (!modified) throw new Error(`Net label update failed: ${labelId}`);
        value = {
          labelId,
          before,
          after: {
            net: modified.getState_Value(),
            x: modified.getState_X(),
            y: modified.getState_Y(),
          },
        };
        break;
      }
      case 'create_text': {
        // 文本只承担人类可读标注，不影响电气网络。
        const text = await eda.sch_PrimitiveText.create(
          Number(operation.x), Number(operation.y), String(operation.text), Number(operation.rotation) || 0,
          null, null, Number(operation.fontSize) || 8, operation.bold === true,
        );
        if (!text) throw new Error('Text creation failed');
        value = { textId: text.getState_PrimitiveId() };
        break;
      }
      default: throw new Error(`Unsupported operation: ${type}`);
    }
    // 每条修改后立即保存，所以后续失败时前序修改已经持久化。
    if (pageUuid && type !== 'delete_page' && type !== 'rename_page') await eda.sch_Document.save();
    results.push({ index, type, value });
  }
  return {
    success: true,
    schematicUuid: schematic.uuid,
    backupUuid: backup.backupUuid,
    backupName: backup.backupName,
    backupCreated: backup.created,
    results,
  };
}

/** 打开指定页面并运行 EasyEDA 严格原理图 DRC。 */
async function runDrc(params: JsonObject): Promise<unknown> {
  const pageUuid = stringParam(params, 'pageUuid');
  await openPage(pageUuid);
  const page = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
  if (!page) throw new Error('No active schematic page');
  const result = await eda.sch_Drc.check(true, false, true);
  return { page: { uuid: page.uuid, name: page.name }, result };
}

// RPC 方法到处理函数的唯一映射表；dispatch 不会动态执行调用方传入的函数名。
const handlers: Record<string, (params: JsonObject) => Promise<unknown>> = {
  'system.health': systemHealth,
  'schematic.listPages': listPages,
  'schematic.inspectPage': inspectPage,
  'library.searchComponents': searchComponents,
  'operations.validate': validateOperations,
  'operations.apply': applyOperations,
  'schematic.runDrc': runDrc,
};

/** 白名单分发入口；所有来自 MCP 的 RPC 最终都经过这里。 */
export async function dispatch(method: string, params: JsonObject = {}): Promise<unknown> {
  const handler = handlers[method];
  if (!handler) throw new Error(`RPC method is not allowed: ${method}`);
  return handler(params);
}
