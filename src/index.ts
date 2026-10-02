import { createApp } from "./app.js";
import { createOnboardingService } from "./onboarding-service.js";

const seconds = process.env.VERIFICATION_TOKEN_TTL_SECONDS;
if (!seconds || !/^\d+$/.test(seconds)) {
  throw new Error("Set VERIFICATION_TOKEN_TTL_SECONDS to a positive whole number before starting Dispatch.");
}
const onboard = createOnboardingService(Number(seconds) * 1000);
const portValue = process.env.PORT ?? "3000";
const port = Number(portValue);
if (!/^\d+$/.test(portValue) || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}
createApp(onboard).listen(port, "127.0.0.1", () => {
  console.log(`Dispatch API listening on http://127.0.0.1:${port}`);
});
