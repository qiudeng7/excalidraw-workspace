import { defineApiHandler, resourceId } from "#server/utils/api";
import { json } from "#server/utils/http";
import { random, digest } from "#server/utils/passwords";
import { canvasCommand } from "#server/collaboration/service";

export default defineApiHandler(
  async (event) => {
    const ticket = random();

    await canvasCommand(event, resourceId(event), {
      type: "ticket",
      hash: await digest(ticket),
    });

    return json({ ticket });
  },
  { public: true },
);
