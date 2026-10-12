import { defineApiHandler } from "../utils/api";
import { json } from "../utils/http";

export default defineApiHandler(
  async (event) => {
    const repository = await event.context.repository();

    const admin = await repository.administrator();
    const settings = await repository.registration();

    return json({
      needsSetup: !admin,
      registrationEnabled: !!settings?.registration_enabled,
      emailVerification: false,
    });
  },
  { public: true },
);
