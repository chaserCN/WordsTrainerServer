const forceFullSyncUserIds = new Set<string>();

export function requestForceFullSync(userId: string): void {
  forceFullSyncUserIds.add(userId);
}

export function hasForceFullSync(userId: string): boolean {
  return forceFullSyncUserIds.has(userId);
}

export function consumeForceFullSync(userId: string): boolean {
  return forceFullSyncUserIds.delete(userId);
}
