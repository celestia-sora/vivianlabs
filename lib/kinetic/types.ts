export type KineticWordState = "incoming" | "active" | "past" | "final";

export interface KineticWord {
  id: string;
  text: string;
  state: KineticWordState;
}

export const KINETIC_WINDOW = 6;

/**
 * Tiny external store so a controller can push frames to `KineticText`
 * without re-rendering the parent companion component.
 */
export class KineticStore {
  private words: readonly KineticWord[] = [];
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): readonly KineticWord[] => this.words;

  set(next: readonly KineticWord[]): void {
    if (sameWords(this.words, next)) return;
    this.words = next;
    for (const l of this.listeners) l();
  }

  clear(): void { this.set([]); }
}

function sameWords(a: readonly KineticWord[], b: readonly KineticWord[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].id !== b[i].id || a[i].text !== b[i].text || a[i].state !== b[i].state) return false;
  }
  return true;
}

export function windowWords(words: readonly KineticWord[], size = KINETIC_WINDOW): KineticWord[] {
  return words.length > size ? words.slice(words.length - size) : words.slice();
}
