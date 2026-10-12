import { defineApiHandler, resourceId } from "../../../../utils/api";
import { json } from "../../../../utils/http";
import { random, digest } from "../../../../utils/passwords";
import { canvasCommand } from "../../../../collaboration/service";

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
