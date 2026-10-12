import { blob } from "@nuxthub/blob";
import { defineApiHandler, resourceId } from "../../../../utils/api";
import { body, json, fail } from "../../../../utils/http";
import { apiRequest } from "../../../../utils/request";
import { digest } from "../../../../utils/passwords";
import { canvasCommand } from "../../../../collaboration/service";
import type { Access } from "../../../../../shared/collaboration/types";

export default defineApiHandler(
  async (event) => {
    const id = resourceId(event);
    const access = await canvasCommand<Access>(event, id, { type: "access" });

    if (access.role === "viewer")
      return fail(403, "READ_ONLY", "查看者不能上传图片");
    const file = await body(apiRequest(event));

    if (
      typeof file.id !== "string" ||
      !file.id ||
      file.id.length > 200 ||
      ["__proto__", "constructor", "prototype"].includes(file.id) ||
      typeof file.dataURL !== "string" ||
      file.dataURL.length > 10 * 1024 * 1024 ||
      !/^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(
        file.dataURL,
      )
    )
      return fail(400, "INVALID_ASSET", "图片格式无效或超过 10 MB");
    const key = `collaboration/${id}/assets/${await digest(file.dataURL)}.json`;

    await blob.put(key, JSON.stringify(file), {
      contentType: "application/json",
    });
    // Reauthorization after upload prevents a permission revocation from publishing references.
    await canvasCommand(event, id, {
      type: "asset",
      file: {
        id: file.id,
        objectKey: key,
        mimeType: file.dataURL.slice(5, file.dataURL.indexOf(";")),
        created:
          typeof file.created === "number" && Number.isFinite(file.created)
            ? file.created
            : Date.now(),
      },
    });

    return json({ id: file.id });
  },
  { public: true },
);
