const DEFAULT_TTL_MS = 5_000;

function boardIsInScope(board, schematicUuid) {
  const schematic = board?.schematic;
  const pcb = board?.pcb;
  return Boolean(pcb?.uuid)
    && /\[main\]/i.test(String(schematic?.name || ""))
    && !/\[backup\]/i.test(String(pcb?.name || ""))
    && (!schematicUuid || schematic?.uuid === schematicUuid);
}

export class PcbCache {
  constructor(bridge, projectCache, { ttlMs = Number(process.env.EASYEDA_PCB_CACHE_TTL_MS || DEFAULT_TTL_MS) } = {}) {
    this.bridge = bridge;
    this.projectCache = projectCache;
    this.ttlMs = Math.max(0, ttlMs);
    this.catalog = null;
    this.board = null;
    this.snapshot = null;
    this.fetchedAt = 0;
    this.initializedAt = null;
    this.error = null;
    this.initializePromise = null;
  }

  clear() {
    this.catalog = null;
    this.board = null;
    this.snapshot = null;
    this.fetchedAt = 0;
    this.initializedAt = null;
    this.error = null;
    this.initializePromise = null;
  }

  async initialize({ force = false } = {}) {
    if (!force && this.snapshot) return this.status();
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = this.#initialize().finally(() => { this.initializePromise = null; });
    return this.initializePromise;
  }

  async #initialize() {
    try {
      const catalog = await this.bridge.call("pcb.listBoards");
      const schematicUuid = this.projectCache.status().scope?.schematicUuid;
      const candidates = (catalog?.boards || []).filter((board) => boardIsInScope(board, schematicUuid));
      const board = candidates[0] || (!schematicUuid ? (catalog?.boards || []).find((item) => boardIsInScope(item)) : null);
      this.catalog = catalog;
      this.board = board || null;
      if (!board) {
        this.snapshot = null;
        this.error = "No PCB Board associated with a [main] schematic";
        this.initializedAt = new Date().toISOString();
        return this.status();
      }
      this.snapshot = await this.bridge.call("pcb.inspect", { pcbUuid: board.pcb.uuid });
      this.fetchedAt = Date.now();
      this.initializedAt = new Date().toISOString();
      this.error = null;
      return this.status();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async getCatalog({ refresh = false } = {}) {
    if (refresh || !this.catalog) await this.initialize({ force: refresh });
    return this.catalog;
  }

  async getSnapshot({ refresh = false } = {}) {
    const expired = !this.snapshot || Date.now() - this.fetchedAt > this.ttlMs;
    if (refresh || expired) await this.initialize({ force: true });
    if (!this.snapshot) throw new Error(this.error || "No [main] PCB is cached");
    return this.snapshot;
  }

  async refresh() {
    return this.initialize({ force: true });
  }

  status() {
    const snapshot = this.snapshot;
    return {
      initialized: Boolean(this.catalog),
      cached: Boolean(snapshot),
      initializedAt: this.initializedAt,
      pcbUuid: this.board?.pcb?.uuid || null,
      pcbName: this.board?.pcb?.name || null,
      schematicUuid: this.board?.schematic?.uuid || null,
      schematicName: this.board?.schematic?.name || null,
      componentCount: snapshot?.components?.length || 0,
      padCount: snapshot?.components?.reduce((sum, item) => sum + (item.pads?.length || 0), 0) || 0,
      netCount: snapshot?.nets?.length || 0,
      trackCount: (snapshot?.tracks?.length || 0) + (snapshot?.trackArcs?.length || 0) + (snapshot?.trackPolylines?.length || 0),
      viaCount: snapshot?.vias?.length || 0,
      pourCount: snapshot?.pours?.length || 0,
      ttlMs: this.ttlMs,
      warming: Boolean(this.initializePromise),
      error: this.error,
    };
  }
}

export { boardIsInScope };
