const DATABASE_NAME = "shangtu-notebook";
const STORE_NAME = "notebook-state";
const STATE_KEY = "current";
let writeQueue = Promise.resolve();

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("notebook_store_open_failed"));
  });
}

function complete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("notebook_store_write_failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("notebook_store_write_aborted"));
  });
}

export async function loadNotebookState<T>(): Promise<T | null> {
  if (!("indexedDB" in globalThis)) return null;
  try {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(STATE_KEY);
    const value = await new Promise<unknown>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("notebook_store_read_failed"));
    });
    database.close();
    return value as T ?? null;
  } catch {
    return null;
  }
}

export function saveNotebookState<T>(state: T): Promise<void> {
  if (!("indexedDB" in globalThis)) return Promise.resolve();
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(state, STATE_KEY);
      await complete(transaction);
    } finally {
      database.close();
    }
  });
  return writeQueue;
}
