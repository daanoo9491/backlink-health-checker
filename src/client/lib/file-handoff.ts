/**
 * Lets a file or links dropped on the Dashboard be picked up by the New Scan
 * page. (Files can't travel in the URL, and this avoids a global state library.)
 */
export type HandOff = { kind: 'file'; file: File } | { kind: 'text'; text: string };

let pending: HandOff | null = null;

export function handOffFile(file: File) {
  pending = { kind: 'file', file };
}

export function handOffText(text: string) {
  pending = { kind: 'text', text };
}

/** Read without clearing, so React may call it more than once safely. */
export function peekHandOff(): HandOff | null {
  return pending;
}

export function clearHandOff() {
  pending = null;
}
