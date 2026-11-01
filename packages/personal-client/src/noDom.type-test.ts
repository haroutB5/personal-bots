// The package must stay free of browser globals so it can run on a phone. Each directive
// below fails tsc as "Unused '@ts-expect-error' directive" if the DOM lib ever comes back.

// @ts-expect-error window is a browser global
export const noWindow = typeof window;
// @ts-expect-error document is a browser global
export const noDocument = typeof document;
// @ts-expect-error localStorage is a browser global
export const noLocalStorage = typeof localStorage;
// @ts-expect-error indexedDB is a browser global
export const noIndexedDb = typeof indexedDB;
