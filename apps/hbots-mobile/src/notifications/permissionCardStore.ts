import {
  answered,
  backgroundDone,
  cardShown,
  cardView,
  leftChat,
  messageSent,
  notNow,
  parseMemory,
  serializeMemory,
  type AskAnswer,
  type CardFacts,
  type CardMemory,
  type CardView,
} from "./permissionCard";

export interface CardStorage {
  read(): string | null;
  write(value: string): void;
}

export interface PermissionCardStore {
  get(): CardMemory;
  subscribe(listener: () => void): () => void;
  view(facts: CardFacts): CardView;
  messageSent(): void;
  leftChat(): void;
  shown(): void;
  notNow(now: number): void;
  answered(answer: AskAnswer): void;
  backgroundDone(): void;
}

/** Memory of the in-chat ask, saved after every change so a restart never asks again by accident. */
export function createPermissionCardStore(storage: CardStorage): PermissionCardStore {
  let memory = parseMemory(safeRead(storage));
  const listeners = new Set<() => void>();
  const set = (next: CardMemory) => {
    if (next === memory) return;
    memory = next;
    try {
      storage.write(serializeMemory(next));
    } catch {
      // A store that cannot save keeps the answer for this run only.
    }
    for (const listener of listeners) listener();
  };
  return {
    get: () => memory,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    view: (facts) => cardView(memory, facts),
    messageSent: () => set(messageSent(memory)),
    leftChat: () => set(leftChat(memory)),
    shown: () => set(cardShown(memory)),
    notNow: (now) => set(notNow(memory, now)),
    answered: (answer) => set(answered(memory, answer)),
    backgroundDone: () => set(backgroundDone(memory)),
  };
}

function safeRead(storage: CardStorage): string | null {
  try {
    return storage.read();
  } catch {
    return null;
  }
}
