import { createServer } from "node:http";
import { once } from "node:events";
import { createApp } from "../src/app.js";

export async function withOnboardingServer(
  onboard: (email: string) => Promise<unknown>,
  test: (url: string) => Promise<void>,
): Promise<void> {
  const server = createServer(createApp(onboard));
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test HTTP server has no TCP address.");
    await test(`http://127.0.0.1:${address.port}/onboarding`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
