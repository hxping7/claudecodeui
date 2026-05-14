import { AsyncLocalStorage } from 'async_hooks';

const storage = new AsyncLocalStorage();

export function getRequestContext() {
  return storage.getStore();
}

export function runInRequestContext(store, fn) {
  return storage.run(store, fn);
}

export function getCurrentUserHomeDir() {
  return storage.getStore()?.homeDir || null;
}