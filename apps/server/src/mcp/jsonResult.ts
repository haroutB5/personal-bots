/** JSON results cross a schema boundary before the transport stringifies them. */
type JsonResult = null | string | boolean | number | JsonResult[] | { [key: string]: JsonResult };
export function normalizeJsonResult(value: unknown): JsonResult {
  const parents = new Set<object>();
  const visit = (input: unknown): JsonResult => {
    if (input === undefined || input === null) return null;
    if (typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (typeof input !== "object")
      throw new Error("Tool result contains an unsupported JSON value.");
    if (parents.has(input)) throw new Error("Tool result contains a circular JSON value.");
    if (
      !Array.isArray(input) &&
      Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null
    ) {
      throw new Error("Tool result contains an unsupported JSON object.");
    }
    parents.add(input);
    try {
      if (Array.isArray(input)) return Array.from(input, visit);
      return Object.fromEntries(
        Object.entries(input)
          .filter(([, item]) => item !== undefined)
          .map(([key, item]) => [key, visit(item)]),
      );
    } finally {
      parents.delete(input);
    }
  };
  return visit(value);
}
