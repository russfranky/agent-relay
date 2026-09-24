import { randomInt } from "node:crypto";
import { WORDS } from "./words.js";

export function randomCode() {
  const a = WORDS[randomInt(WORDS.length)];
  const b = WORDS[randomInt(WORDS.length)];
  const n = randomInt(10, 100); // 10–99
  return `${a}-${b}-${n}`;
}

export function generateUniqueCode(existsFn, maxAttempts = 40) {
  for (let i = 0; i < maxAttempts; i++) {
    const code = randomCode();
    if (!existsFn(code)) return code;
  }
  return null;
}

export async function generateUniqueCodeAsync(existsFn, maxAttempts = 40) {
  for (let i = 0; i < maxAttempts; i++) {
    const code = randomCode();
    if (!(await existsFn(code))) return code;
  }
  return null;
}

export const BOX_ID_RE = /^[a-z]+-[a-z]+-(?:[1-9][0-9])$/;
