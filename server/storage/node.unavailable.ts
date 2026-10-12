/** Workers must use their platform bindings, never fall back to private local storage. */
export async function nodeStorage(): Promise<never> {
  throw new Error("Cloudflare storage bindings DB and DATA are required");
}

export function nodeObjectDriver(): never {
  throw new Error("Node object storage is unavailable in Workers");
}
