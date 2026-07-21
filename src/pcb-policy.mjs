function globRegex(pattern, caseSensitive) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, caseSensitive ? "" : "i");
}

/** Plan an ID-preserving bulk property update for every copper route on selected nets. */
export function planNetTrackPolicy(snapshot, options = {}) {
  const selectors = [...new Set((options.netNames || []).map(String).filter(Boolean))];
  const matchMode = options.matchMode || "exact";
  const caseSensitive = options.caseSensitive === true;
  const includeLocked = options.includeLocked === true;
  const matches = (net) => selectors.some((selector) => matchMode === "glob"
    ? globRegex(selector, caseSensitive).test(String(net || ""))
    : caseSensitive ? String(net || "") === selector : String(net || "").toLowerCase() === selector.toLowerCase());
  const primitives = [
    ...(snapshot?.tracks || []).map(item => ({ ...item, primitiveType: "line" })),
    ...(snapshot?.trackArcs || []).map(item => ({ ...item, primitiveType: "arc" })),
    ...(snapshot?.trackPolylines || []).map(item => ({ ...item, primitiveType: "polyline" })),
  ];
  const selected = primitives.filter(item => matches(item.net));
  const skippedLocked = selected.filter(item => item.locked === true && !includeLocked);
  const changes = selected.flatMap(item => {
    if (item.locked === true && !includeLocked) return [];
    const change = { trackId: item.id };
    if (options.width !== undefined && Number(item.width) !== Number(options.width)) change.width = Number(options.width);
    if (options.layer !== undefined && Number(item.layer) !== Number(options.layer)) change.layer = Number(options.layer);
    if (options.locked !== undefined && item.locked !== options.locked) change.locked = options.locked === true;
    return Object.keys(change).length > 1 ? [change] : [];
  });
  const matchedNets = [...new Set(selected.map(item => String(item.net)))].sort();
  const unmatchedSelectors = selectors.filter(selector => !(snapshot?.nets || []).some(net => matchMode === "glob"
    ? globRegex(selector, caseSensitive).test(String(net))
    : caseSensitive ? String(net) === selector : String(net).toLowerCase() === selector.toLowerCase()));
  return {
    unit: snapshot?.unit || "mil",
    selectors,
    matchMode,
    caseSensitive,
    includeLocked,
    policy: { width: options.width ?? null, layer: options.layer ?? null, locked: options.locked ?? null },
    matchedNets,
    unmatchedSelectors,
    matchedTrackCount: selected.length,
    changeCount: changes.length,
    skippedLocked: skippedLocked.map(item => ({ id: item.id, net: item.net, primitiveType: item.primitiveType })),
    matchedByType: {
      lines: selected.filter(item => item.primitiveType === "line").length,
      arcs: selected.filter(item => item.primitiveType === "arc").length,
      polylines: selected.filter(item => item.primitiveType === "polyline").length,
    },
    changes,
  };
}
