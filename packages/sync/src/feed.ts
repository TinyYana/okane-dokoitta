import type { ChangeFeed, EntitySnapshot, Mirror } from './types.js';

export function entityKey(entity: string, entityId: string): string {
  return `${entity}\u0000${entityId}`;
}

export function applyChangeFeed<TSnapshot extends EntitySnapshot>(
  mirror: Mirror<TSnapshot>,
  feed: ChangeFeed<TSnapshot>,
): { mirror: Mirror<TSnapshot>; since: string } {
  const next = new Map(mirror);
  for (const change of feed.changes) {
    next.set(entityKey(change.entity, change.entityId), {
      version: change.version,
      snapshot: change.snapshot,
    });
  }
  return { mirror: next, since: feed.nextSince };
}
