// The gate commands one change runs. They come from where the change left trunk, so a
// change cannot edit the command that judges it. A gate the change edited, added or
// removed is named, never obeyed. Pure: the caller reads git and passes the two files in.

export const GATES_FILE = "scripts/personal/node/gates-linux.scoped.json";

const parse = (source, where) => {
  let data;
  try {
    data = JSON.parse(source);
  } catch (error) {
    return { problem: `gates file at ${where} is not valid JSON: ${error.message}` };
  }
  if (!Array.isArray(data) || data.some((def) => typeof def?.id !== "string"))
    return { problem: `gates file at ${where} needs an array of gates with an id` };
  return { defs: data };
};

const canonical = (value) =>
  JSON.stringify(value, (_key, inner) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : 1)))
      : inner,
  );

/**
 * `defs` are the base's gates, the only ones a plan runs. `changes` lists every gate
 * whose definition differs at head, sorted by id, or the one deleted file. `problems` is an unreadable head
 * file: the base still runs, so it warns and never blocks. A missing or unreadable
 * base file throws, because there is nothing to run.
 */
export function gateDefsFromBase({ baseSource, headSource }) {
  if (baseSource == null)
    throw new Error(
      `no gates file at base: ${GATES_FILE}. This branch left trunk before that file existed. Merge trunk into the branch, then plan again.`,
    );
  const base = parse(baseSource, "base");
  if (base.problem) throw new Error(base.problem);
  if (headSource == null) return { defs: base.defs, changes: [{ id: GATES_FILE, kind: "file-deleted" }], problems: [] };
  const head = parse(headSource, "head");
  if (head.problem) return { defs: base.defs, changes: [], problems: [head.problem] };
  const atBase = new Map(base.defs.map((def) => [def.id, canonical(def)]));
  const atHead = new Map(head.defs.map((def) => [def.id, canonical(def)]));
  const changes = [
    ...[...atHead].filter(([id, def]) => atBase.has(id) && atBase.get(id) !== def).map(([id]) => ({ id, kind: "edited" })),
    ...[...atHead.keys()].filter((id) => !atBase.has(id)).map((id) => ({ id, kind: "added" })),
    ...[...atBase.keys()].filter((id) => !atHead.has(id)).map((id) => ({ id, kind: "removed" })),
  ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { defs: base.defs, changes, problems: [] };
}

const WORDING = {
  edited: (id) => `gate command changed in this change: ${id}; the base command runs`,
  "file-deleted": (id) => `gates file deleted in this change: ${id}; the base commands run`,
  removed: (id) => `gate removed in this change: ${id}; the base command runs`,
  added: (id) => `gate added in this change: ${id}; it has no base command and does not run here`,
};

export const gateChanges = (changes) => changes.map(({ id, kind }) => WORDING[kind](id));
