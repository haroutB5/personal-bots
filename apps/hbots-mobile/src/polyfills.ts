/**
 * Hermes in this React Native build does not implement the ES2023 array
 * methods the shared package uses (toSorted, toReversed, findLast) or the
 * ES2022 at(). Each fallback returns a new array where the spec says so.
 */
const arrayPrototype = Array.prototype as Array<unknown> & {
  toSorted?: (compareFn?: (left: unknown, right: unknown) => number) => Array<unknown>;
  toReversed?: () => Array<unknown>;
  findLast?: (
    predicate: (value: unknown, index: number, array: Array<unknown>) => boolean,
  ) => unknown;
  at?: (index: number) => unknown;
};

if (typeof arrayPrototype.toSorted !== "function") {
  Object.defineProperty(arrayPrototype, "toSorted", {
    configurable: true,
    writable: true,
    value: function toSorted(
      this: Array<unknown>,
      compareFn?: (left: unknown, right: unknown) => number,
    ) {
      return Array.from(this).sort(compareFn);
    },
  });
}

if (typeof arrayPrototype.toReversed !== "function") {
  Object.defineProperty(arrayPrototype, "toReversed", {
    configurable: true,
    writable: true,
    value: function toReversed(this: Array<unknown>) {
      return Array.from(this).reverse();
    },
  });
}

if (typeof arrayPrototype.findLast !== "function") {
  Object.defineProperty(arrayPrototype, "findLast", {
    configurable: true,
    writable: true,
    value: function findLast(
      this: Array<unknown>,
      predicate: (value: unknown, index: number, array: Array<unknown>) => boolean,
    ) {
      for (let index = this.length - 1; index >= 0; index -= 1) {
        const value = this[index];
        if (predicate(value, index, this)) return value;
      }
      return undefined;
    },
  });
}

if (typeof arrayPrototype.at !== "function") {
  Object.defineProperty(arrayPrototype, "at", {
    configurable: true,
    writable: true,
    value: function at(this: Array<unknown>, index: number) {
      const position = Math.trunc(index);
      return this[position < 0 ? this.length + position : position];
    },
  });
}
