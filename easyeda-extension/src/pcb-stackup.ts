// Shared PCB stackup helper. Used by both PCB creation (createPcbFromSchematic in handlers.ts)
// and the set_stackup operation (pcb-operations.ts).
type JsonObject = Record<string, unknown>;

export const VALID_COPPER_LAYER_COUNTS = new Set([2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32]);

export async function applyPcbStackupSettings(rawSettings: unknown): Promise<unknown> {
  const settings = rawSettings as JsonObject;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid PCB stackup settings');
  const before = {
    copperLayerCount: await eda.pcb_Layer.getTheNumberOfCopperLayers(),
    name: await eda.pcb_Layer.getCurrentPhysicalStackingConfigurationName(),
    configuration: eda.pcb_Layer.getCurrentPhysicalStackingConfiguration(),
    layers: await eda.pcb_Layer.getAllLayers(),
  };
  if (settings.copperLayerCount !== undefined) {
    const count = Number(settings.copperLayerCount);
    if (!VALID_COPPER_LAYER_COUNTS.has(count)) throw new Error('Copper layer count must be an even number from 2 through 32');
    if (!await eda.pcb_Layer.setTheNumberOfCopperLayers(count as any)) throw new Error(`Unable to set PCB copper layer count to ${count}`);
  }
  if (settings.physicalStackingConfigurationName !== undefined && settings.physicalStackingConfiguration !== undefined) {
    throw new Error('Use either physicalStackingConfigurationName or physicalStackingConfiguration, not both');
  }
  if (settings.copperLayerCount !== undefined && (settings.physicalStackingConfigurationName !== undefined || settings.physicalStackingConfiguration !== undefined)) {
    throw new Error('Use either copperLayerCount or a physical stackup configuration, not both');
  }
  let configuration: JsonObject | undefined;
  if (settings.physicalStackingConfigurationName !== undefined) {
    const name = String(settings.physicalStackingConfigurationName || '');
    if (!name) throw new Error('physicalStackingConfigurationName cannot be empty');
    configuration = await eda.pcb_Layer.getPhysicalStackingConfiguration(name);
    if (!configuration) throw new Error(`Physical stackup configuration not found: ${name}`);
  } else if (settings.physicalStackingConfiguration !== undefined) {
    if (!settings.physicalStackingConfiguration || typeof settings.physicalStackingConfiguration !== 'object' || Array.isArray(settings.physicalStackingConfiguration)) throw new Error('physicalStackingConfiguration must be an object');
    configuration = settings.physicalStackingConfiguration as JsonObject;
  }
  if (configuration && !eda.pcb_Layer.overwriteCurrentPhysicalStackingConfiguration(configuration)) throw new Error('Unable to overwrite current physical stackup configuration');

  if (settings.layerNames !== undefined && settings.innerLayerNames !== undefined) throw new Error('Use either explicit layerNames or ordered innerLayerNames, not both');
  let layerNames = settings.layerNames as unknown;
  if (settings.innerLayerNames !== undefined) {
    if (!Array.isArray(settings.innerLayerNames) || settings.innerLayerNames.some(name => typeof name !== 'string' || !name)) throw new Error('innerLayerNames must contain non-empty names');
    const innerLayers = (await eda.pcb_Layer.getAllLayers()).filter(item => ![1, 2].includes(Number(item.id)) && ['SIGNAL', 'PLANE'].includes(String(item.type))).sort((left, right) => Number(left.id) - Number(right.id));
    if (settings.innerLayerNames.length > innerLayers.length) throw new Error(`Only ${innerLayers.length} enabled inner copper layers are available`);
    layerNames = settings.innerLayerNames.map((name, index) => ({ layer: Number(innerLayers[index].id), name }));
  }
  if (layerNames !== undefined) {
    if (!Array.isArray(layerNames) || layerNames.length > 30) throw new Error('layerNames must contain at most 30 inner-layer names');
    const layers = await eda.pcb_Layer.getAllLayers();
    const seen = new Set<number>();
    for (const raw of layerNames) {
      const change = raw as JsonObject; const layer = Number(change.layer); const name = String(change.name || '');
      if (!Number.isInteger(layer) || !name) throw new Error('Each layer name requires an integer layer and non-empty name');
      if (seen.has(layer)) throw new Error(`Layer appears more than once in layerNames: ${layer}`);
      seen.add(layer);
      const item = layers.find(candidate => Number(candidate.id) === layer);
      if (!item) throw new Error(`PCB layer not found after stackup change: ${layer}`);
      if ([1, 2].includes(layer) || !['SIGNAL', 'PLANE'].includes(String(item.type))) throw new Error(`Only enabled inner copper layers can be renamed: ${layer}`);
      if (!await eda.pcb_Layer.modifyLayer(layer as any, { name })) throw new Error(`Unable to rename PCB layer ${layer}`);
    }
  }
  return {
    before,
    after: {
      copperLayerCount: await eda.pcb_Layer.getTheNumberOfCopperLayers(),
      name: await eda.pcb_Layer.getCurrentPhysicalStackingConfigurationName(),
      configuration: eda.pcb_Layer.getCurrentPhysicalStackingConfiguration(),
      layers: await eda.pcb_Layer.getAllLayers(),
    },
  };
}
