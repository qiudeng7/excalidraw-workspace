import { defineApiHandler, resourceId } from "#server/utils/api";
import { body, json, fail } from "#server/utils/http";
import { apiRequest } from "#server/utils/request";
import { digest } from "#server/utils/passwords";
import { canvasCommand } from "#server/collaboration/service";
import { canonical } from "#shared/collaboration/merge";
import type { Operation } from "#shared/collaboration/types";

export default defineApiHandler(
  async (event) => {
    const operation = (await body(apiRequest(event))) as unknown as Operation;

    if (!Array.isArray(operation.elements))
      return fail(400, "INVALID_OPERATION", "协作操作格式无效");

    return json(
      await canvasCommand(event, resourceId(event), {
        type: "update",
        operation,
        digest: await digest(canonical(operation)),
      }),
    );
  },
  { public: true },
);
