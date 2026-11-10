// IndexedDB storage for Deluxe Drive.
// "nodes" holds file/folder metadata (small), "blobs" holds the actual file
// contents, "settings" holds preferences. Used for guests (no Deluxe account):
// their drive stays in this browser. Keeping metadata apart from
// blobs lets the whole tree load into memory without pulling file data.

const DB_NAME = 'deluxe-drive';
const DB_VERSION = 1;

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('This browser does not support IndexedDB.'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('nodes')) {
        database.createObjectStore('nodes', { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains('blobs')) {
        database.createObjectStore('blobs', { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains('settings')) {
        database.createObjectStore('settings', { keyPath: 'key' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open the drive database.'));
    request.onblocked = () => reject(new Error('The drive database is locked by another tab.'));
  });

  return dbPromise;
}

function withStore(storeName, mode, fn) {
  return openDB().then(
    (database) =>
      new Promise((resolve, reject) => {
        let transaction;
        try {
          transaction = database.transaction(storeName, mode);
        } catch (error) {
          reject(error);
          return;
        }

        const store = transaction.objectStore(storeName);
        let result;

        transaction.oncomplete = () => {
          if (result && typeof result === 'object' && 'result' in result) {
            resolve(result.result);
          } else {
            resolve(result);
          }
        };
        transaction.onerror = () => reject(transaction.error || new Error('Storage error.'));
        transaction.onabort = () => reject(transaction.error || new Error('Storage transaction aborted.'));

        try {
          result = fn(store);
        } catch (error) {
          try {
            transaction.abort();
          } catch (_) {
            /* already finished */
          }
          reject(error);
        }
      })
  );
}

export const db = {
  allNodes() {
    return withStore('nodes', 'readonly', (store) => store.getAll());
  },
  getNode(id) {
    return withStore('nodes', 'readonly', (store) => store.get(id));
  },
  putNode(node) {
    return withStore('nodes', 'readwrite', (store) => store.put(node));
  },
  putNodes(nodes) {
    return withStore('nodes', 'readwrite', (store) => {
      nodes.forEach((node) => store.put(node));
    });
  },
  deleteNode(id) {
    return withStore('nodes', 'readwrite', (store) => store.delete(id));
  },

  getBlob(id) {
    return withStore('blobs', 'readonly', (store) => store.get(id));
  },
  putBlob(id, blob) {
    return withStore('blobs', 'readwrite', (store) => store.put({ id, blob }));
  },
  deleteBlob(id) {
    return withStore('blobs', 'readwrite', (store) => store.delete(id));
  },

  getSetting(key) {
    return withStore('settings', 'readonly', (store) => store.get(key));
  },
  putSetting(key, value) {
    return withStore('settings', 'readwrite', (store) => store.put({ key, value }));
  },
  deleteSetting(key) {
    return withStore('settings', 'readwrite', (store) => store.delete(key));
  },

  clearAll() {
    return Promise.all([
      withStore('nodes', 'readwrite', (store) => store.clear()),
      withStore('blobs', 'readwrite', (store) => store.clear()),
      withStore('settings', 'readwrite', (store) => store.clear()),
    ]);
  },
};
