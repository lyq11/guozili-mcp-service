/** Return pad IDs that are not present in any component's getAllPins() result. */
export function standalonePadIds(allPadIds: string[], componentPadIdGroups: string[][]): Set<string> {
  const componentPadIds = new Set(componentPadIdGroups.flat());
  return new Set(allPadIds.filter(id => !componentPadIds.has(id)));
}
