/** Only configured public origins influence CSRF and Secure cookies. */
export function publicOrigin(
  configured: string | undefined,
  requestUrl: string,
  development: boolean,
) {
  if (configured) {
    const url = new URL(configured);

    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("PUBLIC_ORIGIN must be a single HTTP(S) origin");

    return url.origin;
  }

  const url = new URL(requestUrl);

  if (development && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    return url.origin;
  throw new Error("PUBLIC_ORIGIN is required");
}

export function clientIp(
  remote: string | undefined,
  forwarded: string | null,
  trusted: string | undefined,
) {
  const normalize = (ip: string) => ip.replace(/^::ffff:/, "");
  const peer = normalize(remote || "unknown");
  const proxies = (trusted || "")
    .split(",")
    .map((ip) => normalize(ip.trim()))
    .filter(Boolean);

  // Trust only explicitly configured proxy hops; walk from the connection backwards.
  if (!proxies.includes(peer) || !forwarded) return peer;
  const chain = forwarded.split(",").map((ip) => normalize(ip.trim()));

  for (let i = chain.length - 1; i >= 0; i--) {
    const ip = chain[i]!;

    if (!/^[0-9a-fA-F:.]+$/.test(ip)) return peer;
    if (!proxies.includes(ip)) return ip;
  }

  return chain[0] || peer;
}
