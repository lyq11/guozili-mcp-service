const DEFAULT_TTL_MS = 5_000;
const COORDINATE_TOLERANCE = 0.01;
// EasyEDA inspection changes the active page before reading primitives. Concurrent
// page reads race on that shared editor focus and can silently return another page.
const DEFAULT_WARM_CONCURRENCY = 1;

function cloneWithoutWires(page) {
  return { ...page, wires: [] };
}

function pageEntries(catalog, context = null) {
  const schematicUuid = context?.schematic?.uuid;
  if (schematicUuid && Array.isArray(catalog?.schematics)) {
    const mains = catalog.schematics.filter((item) => /\[main\]/i.test(String(item.name || "")));
    const schematic = mains.find((item) => item.uuid === schematicUuid) || mains[0]
      || catalog.schematics.find((item) => item.uuid === schematicUuid);
    if (Array.isArray(schematic?.pages)) return schematic.pages;
  }
  const pages = Array.isArray(catalog?.pages) ? catalog.pages : [];
  if (!schematicUuid) return pages;
  const scoped = pages.filter((page) => page.schematicUuid === schematicUuid);
  return scoped.length ? scoped : pages;
}

function contextKey(context) {
  return context?.project?.uuid || "";
}

function cacheScope(catalog, context) {
  const mains = (catalog?.schematics || []).filter((item) => /\[main\]/i.test(String(item.name || "")));
  const selected = mains.find((item) => item.uuid === context?.schematic?.uuid) || mains[0]
    || (catalog?.schematics || []).find((item) => item.uuid === context?.schematic?.uuid);
  return selected ? { schematicUuid: selected.uuid, schematicName: selected.name, taggedMain: mains.length > 0 } : null;
}

function normalizeToken(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function attributesOf(component) {
  return Object.fromEntries((component?.attributes || []).map((attribute) => [attribute.key, attribute.value]));
}

function designatorPrefix(designator) {
  return String(designator || "").match(/^[A-Za-z]+/)?.[0]?.toUpperCase() || "PART";
}

function normalizeEngineeringValue(value) {
  const raw = normalizeToken(value).replace(/[Ωω]|ohms?|farads?|henrys?/g, "").replace(/\s+/g, "");
  const match = raw.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))([pnumkmgµμ]?)([a-z]*)$/i);
  if (!match) return raw;
  const multipliers = { p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, "μ": 1e-6, m: 1e-3, "": 1, k: 1e3, g: 1e9 };
  const multiplier = multipliers[match[2].toLocaleLowerCase()];
  if (multiplier === undefined) return raw;
  const numeric = Number(match[1]) * multiplier;
  const stable = numeric === 0 ? "0" : numeric.toExponential(12).replace(/\.0+e/, "e").replace(/(\.\d*?)0+e/, "$1e").replace(/e\+?(-?)0+/, "e$1");
  return `${stable}${match[3].toLocaleLowerCase()}`;
}

function equivalenceSpec(component, attributes) {
  const kind = designatorPrefix(component.designator);
  const nominal = attributes.Value || attributes.Resistance || attributes.Capacitance
    || attributes.Inductance || component.name || "";
  const footprint = attributes["Supplier Footprint"] || attributes.OriginFootprint
    || attributes["Origin Footprint"] || attributes.FootprintName || attributes.Package || "";
  const tolerance = attributes.Tolerance || attributes.Accuracy || "";
  return {
    kind,
    footprint: normalizeToken(footprint),
    nominal: normalizeEngineeringValue(nominal),
    tolerance: normalizeToken(tolerance).replace(/±|\s/g, ""),
    voltageRating: attributes["Voltage Rated"] || attributes["Rated Voltage"] || attributes["Rated Voltage (Max)"] || null,
    dielectric: attributes["Temperature Coefficient"] || attributes.Dielectric || null,
    power: attributes["Power(Watts)"] || attributes.Power || null,
  };
}

function componentRecord(pageUuid, pageName, component) {
  const attributes = attributesOf(component);
  const equivalent = equivalenceSpec(component, attributes);
  return {
    pageUuid,
    pageName,
    componentId: component.id,
    designator: component.designator || null,
    name: component.name || null,
    value: attributes.Value || null,
    deviceUuid: component.deviceUuid || null,
    libraryUuid: component.libraryUuid || null,
    manufacturer: attributes.Manufacturer || null,
    manufacturerPart: attributes["Manufacturer Part"] || null,
    supplier: attributes.Supplier || null,
    supplierPart: attributes["Supplier Part"] || null,
    footprint: attributes.Footprint || null,
    nets: [...new Set((component.pins || []).map((pin) => pin.net).filter(Boolean))],
    equivalent,
  };
}

function groupValue(record, groupBy) {
  if (groupBy === "equivalentSpec") {
    const { kind, footprint, nominal, tolerance } = record.equivalent;
    return [kind, footprint, nominal, tolerance].join(" | ");
  }
  if (groupBy === "model") {
    return record.manufacturerPart || record.deviceUuid || record.supplierPart
      || [record.name, record.value].filter(Boolean).join(" | ");
  }
  return record[groupBy] || "";
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      try { results[index] = { status: "fulfilled", value: await worker(items[index]) }; }
      catch (reason) { results[index] = { status: "rejected", reason }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

/**
 * Session-scoped EasyEDA project cache.
 *
 * A registration warms every page once. Reads then reuse the full page snapshot,
 * while writes refresh only affected pages. A short TTL catches editor-side manual
 * changes because the current EasyEDA API does not expose document revisions.
 */
export class ProjectCache {
  constructor(bridge, {
    ttlMs = Number(process.env.EASYEDA_CACHE_TTL_MS || DEFAULT_TTL_MS),
    warmConcurrency = Number(process.env.EASYEDA_CACHE_CONCURRENCY || DEFAULT_WARM_CONCURRENCY),
  } = {}) {
    this.bridge = bridge;
    this.ttlMs = Math.max(0, ttlMs);
    this.warmConcurrency = Math.max(1, Math.floor(warmConcurrency));
    this.catalog = null;
    this.context = null;
    this.key = "";
    this.scope = null;
    this.pages = new Map();
    this.components = [];
    this.pageErrors = new Map();
    this.initializedAt = null;
    this.initializePromise = null;
    this.generation = 0;
  }

  clear() {
    this.catalog = null;
    this.context = null;
    this.key = "";
    this.scope = null;
    this.pages.clear();
    this.components = [];
    this.pageErrors.clear();
    this.initializedAt = null;
    this.initializePromise = null;
    this.generation += 1;
  }

  async initialize({ force = false } = {}) {
    if (!force && this.catalog && this.pages.size) return this.status();
    if (this.initializePromise) return this.initializePromise;
    const generation = ++this.generation;
    this.initializePromise = this.#initialize(generation).finally(() => {
      if (generation === this.generation) this.initializePromise = null;
    });
    return this.initializePromise;
  }

  async #initialize(generation) {
    const [context, catalog] = await Promise.all([
      this.bridge.call("system.health"),
      this.bridge.call("schematic.listPages"),
    ]);
    const uniquePages = [...new Map(pageEntries(catalog, context).map((page) => [page.uuid, page])).values()];
    const settled = await mapWithConcurrency(uniquePages, this.warmConcurrency, async (page) => ({
      pageUuid: page.uuid,
      value: await this.bridge.call("schematic.inspectPage", { pageUuid: page.uuid, includeWires: true }),
    }));
    if (generation !== this.generation) return this.status();
    this.context = context;
    this.catalog = catalog;
    this.key = contextKey(context);
    this.scope = cacheScope(catalog, context);
    const snapshots = settled.filter((item) => item.status === "fulfilled").map((item) => item.value);
    this.pages = new Map(snapshots.map(({ pageUuid, value }) => [pageUuid, {
      value,
      fetchedAt: Date.now(),
    }]));
    this.pageErrors = new Map(settled.flatMap((item, index) => item.status === "rejected" ? [[
      uniquePages[index].uuid,
      item.reason instanceof Error ? item.reason.message : String(item.reason),
    ]] : []));
    this.#rebuildComponentIndex();
    this.initializedAt = new Date().toISOString();
    return this.status();
  }

  async ensureContext() {
    if (!this.catalog) return this.initialize();
    const context = await this.bridge.call("system.health");
    if (contextKey(context) !== this.key) return this.initialize({ force: true });
    this.context = context;
    return this.status();
  }

  async getCatalog({ refresh = false } = {}) {
    if (refresh || !this.catalog) await this.initialize({ force: refresh });
    return this.catalog;
  }

  async getPage(pageUuid, { includeWires = true, refresh = false } = {}) {
    if (!this.catalog) await this.initialize();
    const cached = this.pages.get(pageUuid);
    const expired = !cached || Date.now() - cached.fetchedAt > this.ttlMs;
    if (refresh || expired) await this.refreshPages([pageUuid]);
    const page = this.pages.get(pageUuid)?.value;
    if (!page) throw new Error(`Page not found in project cache: ${pageUuid}`);
    return includeWires ? page : cloneWithoutWires(page);
  }

  async refreshPages(pageUuids) {
    const unique = [...new Set(pageUuids.filter(Boolean))];
    const known = new Set(pageEntries(this.catalog, this.context).map((page) => page.uuid));
    const targets = unique.filter((uuid) => known.has(uuid));
    const settled = await mapWithConcurrency(targets, this.warmConcurrency, async (pageUuid) => ({
      pageUuid,
      value: await this.bridge.call("schematic.inspectPage", { pageUuid, includeWires: true }),
    }));
    const results = settled.filter((item) => item.status === "fulfilled").map((item) => item.value);
    const fetchedAt = Date.now();
    for (const { pageUuid, value } of results) {
      this.pages.set(pageUuid, { value, fetchedAt });
      this.pageErrors.delete(pageUuid);
    }
    settled.forEach((item, index) => {
      if (item.status === "rejected") this.pageErrors.set(targets[index], item.reason instanceof Error ? item.reason.message : String(item.reason));
    });
    if (results.length) this.#rebuildComponentIndex();
    return results.length;
  }

  #rebuildComponentIndex() {
    this.components = [];
    for (const [pageUuid, snapshot] of this.pages) {
      const pageName = snapshot.value?.page?.name || null;
      for (const component of snapshot.value?.components || []) {
        if (component.type !== "part") continue;
        this.components.push(componentRecord(pageUuid, pageName, component));
      }
    }
  }

  async getComponentInventory({ groupBy = "model", includeSingletons = true } = {}) {
    if (!this.catalog) await this.initialize();
    const groups = new Map();
    for (const component of this.components) {
      const displayKey = groupValue(component, groupBy);
      const key = normalizeToken(displayKey);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, { key: displayKey, normalizedKey: key, components: [] });
      groups.get(key).components.push(component);
    }
    const items = [...groups.values()]
      .filter((group) => includeSingletons || group.components.length > 1)
      .map((group) => ({
        ...group,
        count: group.components.length,
        variants: {
          values: [...new Set(group.components.map((item) => item.value).filter(Boolean))],
          manufacturerParts: [...new Set(group.components.map((item) => item.manufacturerPart).filter(Boolean))],
          supplierParts: [...new Set(group.components.map((item) => item.supplierPart).filter(Boolean))],
          footprints: [...new Set(group.components.map((item) => item.footprint).filter(Boolean))],
          deviceUuids: [...new Set(group.components.map((item) => item.deviceUuid).filter(Boolean))],
          voltageRatings: [...new Set(group.components.map((item) => item.equivalent.voltageRating).filter(Boolean))],
          dielectrics: [...new Set(group.components.map((item) => item.equivalent.dielectric).filter(Boolean))],
          powers: [...new Set(group.components.map((item) => item.equivalent.power).filter(Boolean))],
        },
      }))
      .sort((left, right) => right.count - left.count || left.normalizedKey.localeCompare(right.normalizedKey));
    return {
      groupBy,
      componentCount: this.components.length,
      failedPageCount: this.pageErrors.size,
      failedPages: [...this.pageErrors.entries()].map(([pageUuid, error]) => ({ pageUuid, error })),
      groupCount: items.length,
      duplicateGroupCount: items.filter((item) => item.count > 1).length,
      groups: items,
    };
  }

  async getComponents() {
    if (!this.catalog) await this.initialize();
    return this.components.map((component) => ({ ...component }));
  }

  async rebuildCatalog() {
    return this.initialize({ force: true });
  }

  status() {
    return {
      initialized: Boolean(this.catalog),
      initializedAt: this.initializedAt,
      contextKey: this.key || null,
      scope: this.scope,
      pageCount: this.pages.size,
      componentCount: this.components.length,
      failedPageCount: this.pageErrors.size,
      failedPages: [...this.pageErrors.entries()].map(([pageUuid, error]) => ({ pageUuid, error })),
      ttlMs: this.ttlMs,
      coordinateTolerance: COORDINATE_TOLERANCE,
      warming: Boolean(this.initializePromise),
    };
  }
}

export { COORDINATE_TOLERANCE };
