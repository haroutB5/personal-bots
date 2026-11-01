// The package must stay free of browser globals so it can run on a phone. Each directive
// below fails tsc as "Unused '@ts-expect-error' directive" if the DOM lib ever comes back.
// localStorage is not listed because @types/node declares it. HTMLElement is not listed
// because @types/react declares an empty one.

// @ts-expect-error window is a browser global
export const noWindow = typeof window;
// @ts-expect-error document is a browser global
export const noDocument = typeof document;
// @ts-expect-error indexedDB is a browser global
export const noIndexedDb = typeof indexedDB;
// @ts-expect-error requestAnimationFrame is a browser global
export const noAnimationFrame = typeof requestAnimationFrame;
