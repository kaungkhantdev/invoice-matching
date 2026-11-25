import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { NextFunction, Request, Response } from "express";
import { AppModule } from "./app.module.js";
import { config } from "./config.js";

// Usage: npm start   →   the API on http://localhost:3000/api. The page is a separate project (web/).
// PORT, HOST and WEB_ORIGINS: see config.ts (127.0.0.1 by default: this computer only).
const { port, host, webOrigins } = config;

const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ["error", "warn"] });
app.setGlobalPrefix("api");

// Only this computer's browser, on the page, may use the API. Listening on 127.0.0.1 isn't enough on its own:
// a website you visit could otherwise reach it through "DNS rebinding" or send it cross-site requests.
// The page's server forwards /api here (Vite in development, nginx in Docker), so no CORS is needed:
// a request arrives addressed to the API itself (Vite) or to the page's address (nginx), from the page's address.
const allowed = new Set([`localhost:${port}`, `127.0.0.1:${port}`, ...webOrigins.map((origin) => new URL(origin).host)]);
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  const hostAllowed = allowed.has(req.headers.host ?? "");
  // Requests without an Origin header (same-origin GETs, curl) pass on the Host check alone.
  const originAllowed = !origin || allowed.has(origin.replace(/^https?:\/\//, ""));
  if (!hostAllowed || !originAllowed) {
    res.status(403).json({ message: `Forbidden: open the page at ${webOrigins[0]}` });
    return;
  }
  next();
});

// The page used to be served here: send anyone who opens the API's own address to the page.
app.getHttpAdapter().getInstance().get("/", (_req: Request, res: Response) => res.redirect(webOrigins[0]));

await app.listen(port, host);
console.log(`Invoice matching API: http://localhost:${port}/api (the page: ${webOrigins[0]})`);
