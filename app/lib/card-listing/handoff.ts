import type { BulkListStagingItem } from '@/app/types';

/** sessionStorage key the Listing Generator uses to pass cards to Bulk List. */
export const BULK_LIST_HANDOFF_KEY = 'alphacard:bulk-list-handoff';

export function queueForBulkList(items: BulkListStagingItem[]): void {
  const existing = JSON.parse(sessionStorage.getItem(BULK_LIST_HANDOFF_KEY) || '[]') as BulkListStagingItem[];
  sessionStorage.setItem(BULK_LIST_HANDOFF_KEY, JSON.stringify([...existing, ...items]));
}
