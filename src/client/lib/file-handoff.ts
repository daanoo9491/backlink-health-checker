/**
 * Lets a file dropped on the Dashboard be picked up by the New Scan page.
 * (File objects can't travel in the URL, and this avoids a global state library.)
 */
let pending: File | null = null;

export function handOffFile(file: File) {
  pending = file;
}

/** Read without clearing, so React may call it more than once safely. */
export function peekHandedOffFile(): File | null {
  return pending;
}

export function clearHandedOffFile() {
  pending = null;
}
