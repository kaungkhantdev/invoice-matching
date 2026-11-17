import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { NextFunction, Request, Response } from "express";
import { join } from "node:path";
import { UiModule } from "./ui/ui.module.js";

// Usage: npm run ui   →   http://localhost:3000
const port = Number(process.env.PORT ?? 3000);

const app = await NestFactory.create<NestExpressApplication>(UiModule, { logger: ["error", "warn"] });

// Only this computer's browser, on this page, may use the API. Listening on 127.0.0.1 isn't enough on its own:
// a website you visit could otherwise reach it through "DNS rebinding" or send it cross-site requests.
const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (!allowedHosts.has(req.headers.host ?? "") || (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, "")))) {
    res.status(403).json({ message: "Forbidden: open the page at http://localhost:" + port });
    return;
  }
  next();
});
app.useStaticAssets(join(process.cwd(), "public"));
// 127.0.0.1 only: the page is for this computer, not the network.
await app.listen(port, "127.0.0.1");
console.log(`Invoice matching UI: http://localhost:${port}`);
