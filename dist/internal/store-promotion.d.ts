import { type LocalStoreOptions } from './local-store.js';
/** Offline and format-only. Checkpoints are private fault-injection hooks. */
export declare function promoteTaskStore(directory: string, originalTaskId: string, locale?: string, options?: LocalStoreOptions): Promise<string>;
