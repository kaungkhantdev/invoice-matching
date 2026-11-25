import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

/** The built config.ts. It reads the settings once, when it's loaded, so each test starts a fresh Node. */
const CONFIG = new URL("../src/config.js", import.meta.url).href;

/** Every setting config.ts reads. */
const SETTINGS = [
  "GST_RATE",
  "ROUNDING_TOLERANCE",
  "BUYER_NAMES",
  "LINE_MATCH_MIN_SCORE",
  "BEDROCK_REGION",
  "BEDROCK_MODEL",
  "BEDROCK_EFFORT",
  "BEDROCK_CONCURRENCY",
  "TEXTRACT_REGION",
  "TEXTRACT_MAX_PAGES",
  "TEXTRACT_TPS",
  "READ_MAX_ATTEMPTS",
  "DATA_DIR",
  "UI_STORE_DIR",
  "PORT",
  "HOST",
  "WEB_ORIGINS",
];

/** Loads config.ts with only these settings (nothing from this shell or .env): its values, or the start-up error. */
function configWith(settings: Record<string, string>) {
  const script = `const { config } = await import(${JSON.stringify(CONFIG)}); console.log(JSON.stringify(config));`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { PATH: process.env.PATH, ...settings },
    encoding: "utf8",
  });
  return { config: run.status === 0 ? JSON.parse(run.stdout) : undefined, error: run.stderr };
}

describe("settings (.env)", () => {
  const defaults = configWith({}).config;

  it("has a default for every setting", () => {
    assert.deepEqual(defaults, {
      gstRate: "0.09",
      tolerance: "1",
      buyerNames: ["Industrial & Commercial Facilities Management Pte Ltd"],
      lineMatchMinScore: 0.5,
      bedrock: { region: "ap-southeast-1", model: "anthropic.claude-sonnet-5", effort: "medium", concurrency: 8 },
      textract: { region: "ap-southeast-1", maxPages: 5, tps: 1 },
      maxAttempts: 3,
      dataDir: "data",
      uiStoreDir: "output/ui",
      port: 3000,
      host: "127.0.0.1",
      webOrigins: ["http://localhost:5173", "http://127.0.0.1:5173"],
    });
  });

  it("a blank setting (GST_RATE=) uses its default, like a missing one", () => {
    assert.ok(defaults, "config.ts must load with no settings");
    for (const blank of ["", "   "]) {
      const settings = Object.fromEntries(SETTINGS.map((name) => [name, blank]));
      const { config, error } = configWith(settings);
      assert.ok(config, `settings set to ${JSON.stringify(blank)}: ${error}`);
      assert.deepEqual(config, defaults);
    }
  });

  it("a set value is used, without the spaces around it", () => {
    const { config } = configWith({
      GST_RATE: " 0.08 ",
      BUYER_NAMES: " ICFM Pte Ltd | ICFM Services ",
      BEDROCK_REGION: " ap-southeast-2 ",
      HOST: "0.0.0.0",
      PORT: "3001",
    });
    assert.equal(config.gstRate, "0.08");
    assert.deepEqual(config.buyerNames, ["ICFM Pte Ltd", "ICFM Services"]);
    assert.equal(config.bedrock.region, "ap-southeast-2");
    assert.equal(config.host, "0.0.0.0");
    assert.equal(config.port, 3001);
  });

  it("BUYER_NAMES with only separators uses the default name", () => {
    assert.deepEqual(configWith({ BUYER_NAMES: " | " }).config.buyerNames, defaults.buyerNames);
  });

  it("a typo in a rate stops the app at start, naming the setting", () => {
    const typo = configWith({ GST_RATE: "9%" });
    assert.equal(typo.config, undefined);
    assert.match(typo.error, /GST_RATE must be a number like 0\.09, not "9%"/);
    assert.match(configWith({ ROUNDING_TOLERANCE: "NaN" }).error, /ROUNDING_TOLERANCE must be a number/);
  });

  it("WEB_ORIGINS: the page's addresses, without a path; one without http:// stops the app at start", () => {
    const docker = configWith({ WEB_ORIGINS: " http://localhost:8080/ | https://invoices.example.com " });
    assert.deepEqual(docker.config.webOrigins, ["http://localhost:8080", "https://invoices.example.com"]);
    for (const typo of ["localhost:8080", "ftp://localhost:8080"]) {
      const { config, error } = configWith({ WEB_ORIGINS: typo });
      assert.equal(config, undefined);
      assert.match(error, new RegExp(`WEB_ORIGINS must be web addresses like http://localhost:5173, not "${typo}"`));
    }
  });
});
