/**
 * Lets a file dropped on the Dashboard be picked up by the New Scan page.
 * (File objects can't travel in the URL, and this avoids a global state library.)
 */
let pending: File | null = null;

export function handOffFile(file: File) {
  pending = file;
}

export function takeHandedOffFile(): File | null {
  const f = pending;
  pending = null;
  return f;
}
