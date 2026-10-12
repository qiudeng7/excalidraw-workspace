// Wrangler bundles this wrapper after Nitro builds its HTTP application.
import nitro from "../.output/server/index.mjs";
export { CanvasRoom } from "#server/collaboration/durable-object";

export default {
  ...nitro,
  fetch(request, env, ctx) {
    const match = new URL(request.url).pathname.match(
      /^\/api\/canvases\/([^/]+)\/realtime$/,
    );

    if (match && request.headers.get("upgrade") === "websocket") {
      if (request.headers.get("origin") !== env.PUBLIC_ORIGIN)
        return new Response("Forbidden", { status: 403 });

      const id = decodeURIComponent(match[1]);
      const headers = new Headers(request.headers);
      headers.set("x-partykit-room", id);
      headers.delete("x-partykit-props");

      return env.CANVAS_ROOMS.get(env.CANVAS_ROOMS.idFromName(id)).fetch(
        new Request(request, { headers }),
      );
    }

    return nitro.fetch(request, env, ctx);
  },
};
