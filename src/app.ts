import express from "express";
import type { ErrorRequestHandler } from "express";
import { parseOnboardingEmail } from "./onboarding-input.js";

export function createApp(onboard: (email: string) => Promise<unknown>) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "8kb" }));

  app.post("/onboarding", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.is("application/json")) {
      res.status(415).json({ error: "Request must use application/json." });
      return;
    }
    let email: string;
    try {
      const body: unknown = req.body;
      email = parseOnboardingEmail(body);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid onboarding request." });
      return;
    }
    try {
      await onboard(email);
      res.status(202).json({ message: "Check your inbox for the next step" });
    } catch {
      // Persistence errors can contain email addresses or credentials. Do not expose or log them.
      res.status(503).json({ error: "Unable to process onboarding right now. Please try again." });
    }
  });

  const errors: ErrorRequestHandler = (error: unknown, req, res, next) => {
    if (res.headersSent) { next(error); return; }
    res.set("Cache-Control", "no-store");
    const tooLarge = typeof error === "object" && error !== null && "type" in error && error.type === "entity.too.large";
    const invalidJson = typeof error === "object" && error !== null && "type" in error && error.type === "entity.parse.failed";
    if (tooLarge) res.status(413).json({ error: "Request body exceeds the 8 KB limit." });
    else if (invalidJson) res.status(400).json({ error: "Request body must contain valid JSON." });
    else res.status(500).json({ error: "Unable to process the request." });
  };
  app.use(errors);
  return app;
}
