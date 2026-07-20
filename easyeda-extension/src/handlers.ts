// EasyEDA 插件侧的白名单 RPC 实现。
// 此文件是实际读取和修改当前编辑器文档的边界，MCP 本身不直接调用 EasyEDA API。
type JsonObject = Record<string, unknown>;

interface BackupRecord {
  schematicUuid: string;
  backupUuid: string;
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

/** 列出当前原理图的全部图页，不改变任何文档内容。 */
async function listPages(): Promise<unknown> {
  const schematic = await eda.dmt_Schematic.getCurrentSchematicInfo();
  if (!schematic) throw new Error('No active schematic');
  const pages = await eda.dmt_Schematic.getCurrentSchematicAllSchematicPagesInfo();
  return {
    schematic: { uuid: schematic.uuid, name: schematic.name, boardName: schematic.parentBoardName },
    pages: pages.map((page, index) => ({ index: index + 1, uuid: page.uuid, name: page.name })),
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
    result.push({
      id: component.getState_PrimitiveId(),
      type: component.getState_ComponentType(),
      designator: component.getState_Designator(),
      name: componentState?.name,
      libraryUuid: componentState?.libraryUuid,
      deviceUuid: componentState?.uuid,
      net: component.getState_Net(),
      x: component.getState_X(), y: component.getState_Y(), rotation: component.getState_Rotation(),
      pins: pins.map(pin => ({
        id: pin.getState_PrimitiveId(), name: pin.getState_PinName(), number: pin.getState_PinNumber(),
        x: pin.getState_X(), y: pin.getState_Y(),
      })),
    });
  }
  // 导线折线保持 EasyEDA 原始坐标格式，供 MCP 可读性分析和后续编辑使用。
  const wires = params.includeWires === false ? [] : (await eda.sch_PrimitiveWire.getAll()).map(wire => ({
    id: wire.getState_PrimitiveId(), net: wire.getState_Net(), line: wire.getState_Line(),
  }));
  if (!page) throw new Error('No active schematic page');
  return { page: { uuid: page.uuid, name: page.name }, components: result, wires };
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
  const pages = await eda.dmt_Schematic.getCurrentSchematicAllSchematicPagesInfo();
  const pageIds = new Set(pages.map(page => page.uuid));
  const findings: JsonObject[] = [];
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    const type = String(operation.type || '');
    const pageUuid = String(operation.pageUuid || '');
    if (!ALLOWED_OPERATIONS.has(type)) { findings.push({ index, level: 'error', message: 'Unsupported operation', type }); continue; }
    if (pageUuid && !pageIds.has(pageUuid)) { findings.push({ index, level: 'error', message: 'Schematic page does not exist', pageUuid }); continue; }
    if (type === 'delete_page' && pages.length <= 1) findings.push({ index, level: 'error', message: 'Cannot delete the only schematic page' });
    // 只有引用现有图元的操作需要打开页面并核对 ID。
    if (type === 'delete_primitives' || type === 'connect_pins') {
      await openPage(pageUuid);
      const componentIds = new Set(await eda.sch_PrimitiveComponent.getAllPrimitiveId());
      const wireIds = new Set(await eda.sch_PrimitiveWire.getAllPrimitiveId());
      if (type === 'delete_primitives') {
        for (const id of (operation.componentIds as string[] || [])) if (!componentIds.has(id)) findings.push({ index, level: 'error', message: 'Component not found', id });
        for (const id of (operation.wireIds as string[] || [])) if (!wireIds.has(id)) findings.push({ index, level: 'error', message: 'Wire not found', id });
      } else {
        for (const endpoint of [operation.from, operation.to] as JsonObject[]) {
          if (!endpoint || !componentIds.has(String(endpoint.componentId))) findings.push({ index, level: 'error', message: 'Endpoint component not found', id: endpoint?.componentId });
        }
      }
    }
  }
  return { valid: !findings.some(item => item.level === 'error'), findings, pageCount: pages.length };
}

// 插件最终允许执行的写操作集合；即使绕过 MCP Schema，也不能调用集合外方法。
const ALLOWED_OPERATIONS = new Set([
  'rename_page', 'delete_page', 'delete_primitives', 'create_component', 'create_wire',
  'connect_pins', 'create_net_port', 'create_net_flag', 'create_text',
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
    return { schematicUuid, backupUuid };
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
      case 'rename_page': value = await eda.dmt_Schematic.modifySchematicPageName(pageUuid, String(operation.name)); break;
      case 'delete_page': value = await eda.dmt_Schematic.deleteSchematicPage(pageUuid); break;
      case 'delete_primitives': {
        // 线和器件分开删除；空数组直接视为成功，避免无意义 API 调用。
        const wireIds = operation.wireIds as string[] || [];
        const componentIds = operation.componentIds as string[] || [];
        value = {
          wiresDeleted: wireIds.length ? await eda.sch_PrimitiveWire.delete(wireIds) : true,
          componentsDeleted: componentIds.length ? await eda.sch_PrimitiveComponent.delete(componentIds) : true,
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
  'operations.apply': applyOperations,
  'schematic.runDrc': runDrc,
};

/** 白名单分发入口；所有来自 MCP 的 RPC 最终都经过这里。 */
export async function dispatch(method: string, params: JsonObject = {}): Promise<unknown> {
  const handler = handlers[method];
  if (!handler) throw new Error(`RPC method is not allowed: ${method}`);
  return handler(params);
}
