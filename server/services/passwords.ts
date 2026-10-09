const hex = (bytes: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
export const random = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export const digest = async (s: string) =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
export async function hashPassword(password: string, salt = random()) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new TextEncoder().encode(salt),
      iterations: 100000,
    },
    key,
    256,
  );
  return `pbkdf2-sha256$100000$${salt}$${hex(bits)}`;
}
export async function verifyPassword(password: string, stored: string) {
  const candidate = await hashPassword(password, stored.split("$")[2]);
  if (candidate.length !== stored.length) return false;
  let difference = 0;
  for (let i = 0; i < candidate.length; i++)
    difference |= candidate.charCodeAt(i) ^ stored.charCodeAt(i);
  return difference === 0;
}
