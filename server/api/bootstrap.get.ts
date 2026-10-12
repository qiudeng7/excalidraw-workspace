import { administrator, registration } from "../db/accounts";
import { defineApiHandler } from "../utils/api";
import { json } from "../utils/http";

export default defineApiHandler(
  async (event) => {
    const admin = await administrator();
    const settings = await registration();

    return json({
      needsSetup: !admin,
      registrationEnabled: !!settings?.registrationEnabled,
      emailVerification: false,
    });
  },
  { public: true },
);
