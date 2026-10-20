const assert = require("node:assert/strict");
const { execFile, execFileSync } = require("node:child_process");
const { createServer } = require("node:http");
const { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const execute = promisify(execFile);
const root = path.resolve(__dirname, "..");
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this check through npm run test:package");
const currentPlaywright = require(path.join(root, "package-lock.json")).packages["node_modules/@playwright/test"].version;

function childEnvironment(overrides = {}) {
  const environment = { ...process.env, ...overrides };
  const npmUserConfig = overrides.npm_config_userconfig;
  for (const name of Object.keys(environment)) {
    if (/^(?:JEST_WORKER_ID|PLAYWRIGHT_.*|PW_.*|PWDEBUG|NODE_USE_ENV_PROXY|HTTPS?_PROXY|ALL_PROXY|NO_PROXY)$/i.test(name) ||
        /^npm_config_(?:.*registry|userconfig)$/i.test(name)) {
      delete environment[name];
    }
  }
  environment.npm_config_registry = "https://registry.npmjs.org/";
  if (npmUserConfig) environment.npm_config_userconfig = npmUserConfig;
  return environment;
}

async function runNpm(args, cwd, npmConfigFile) {
  return execute(process.execPath, [npmCli, ...args], {
    cwd,
    env: childEnvironment(npmConfigFile ? { npm_config_userconfig: npmConfigFile } : {}),
    timeout: 120000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function installConsumer(directory, tarball, playwrightVersion, npmConfigFile) {
  await runNpm([
    "install", "--prefix", directory, "--no-save", "--package-lock=false", "--ignore-scripts",
    "--no-audit", "--no-fund", "--legacy-peer-deps", tarball,
    `@playwright/test@${playwrightVersion}`, "@types/node@22.20.3",
  ], directory, npmConfigFile);
}

function createReceiver() {
  let behavior = "success";
  let firstResponseClosed = false;
  const requests = [];
  const server = createServer((request, response) => {
    const firstResponseClosedBeforeRequest = firstResponseClosed;
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const index = requests.push({
        url: request.url || "", body, responseClosed: false,
        firstResponseClosedBeforeRequest, receivedAt: Date.now(),
      }) - 1;
      response.once("close", () => {
        requests[index].responseClosed = true;
        if (index === 0) firstResponseClosed = true;
      });
      if (index === 0 && behavior === "stall-headers") return;
      if (index === 0 && behavior === "stall-body") {
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.write("partial response");
        return;
      }
      if (index === 1 && behavior === "fail-second") {
        response.statusCode = 500;
        requests[index].statusCode = response.statusCode;
        response.end("synthetic receiver rejection");
        return;
      }
      response.statusCode = 200;
      requests[index].statusCode = response.statusCode;
      response.end("1");
    });
  });
  return {
    requests,
    setBehavior(value) { behavior = value; firstResponseClosed = false; requests.length = 0; },
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Local receiver did not start");
      return `http://127.0.0.1:${address.port}/webhook?sig=synthetic-package-secret`;
    },
    async close() {
      server.closeAllConnections?.();
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

function writeConsumerFiles(directory) {
  const tests = path.join(directory, "tests");
  mkdirSync(tests, { recursive: true });
  writeFileSync(path.join(directory, "package.json"), JSON.stringify({ private: true, type: "commonjs" }));
  writeFileSync(path.join(tests, "artifact.spec.cjs"), `
const { EventEmitter } = require("node:events");
const { expect, test: base } = require("@playwright/test");
const rootReporter = require("@martymcfly9597/playwright-msteams-reporter");
const healthReporter = require("@martymcfly9597/playwright-msteams-reporter/healthReporter");
const models = require("@martymcfly9597/playwright-msteams-reporter/models");
const { captureEnvSignals } = require("@martymcfly9597/playwright-msteams-reporter/healthCapture");
if (typeof rootReporter.default !== "function" || typeof healthReporter.default !== "function" ||
  typeof captureEnvSignals !== "function" || typeof models !== "object") {
  throw new Error("Packed CommonJS package entry points failed");
}
const existing = base.extend({ existingFixture: async ({}, use) => use("preserved") });
const test = existing.extend({
  environmentEvidence: async ({}, use, testInfo) => {
    const page = Object.assign(new EventEmitter(), { url: () => "https://app.acme.example/start" });
    const context = Object.assign(new EventEmitter(), { pages: () => [page] });
    const capture = captureEnvSignals({ page, context, testInfo, options: { includeHosts: ["app.acme.example"], retainOnPass: true } });
    if (process.env.PACKED_SIGNAL === "1") capture.record({ kind: "service-busy", description: "Synthetic busy state" });
    try { await use(undefined); } finally { capture.dispose(); }
  },
});
test("packed CommonJS reporter and fixture", async ({ existingFixture, environmentEvidence }) => {
  expect(existingFixture).toBe("preserved");
  expect(environmentEvidence).toBeUndefined();
  console.log("PACKED_STDOUT_ONCE");
});
`);
  writeFileSync(path.join(tests, "types.spec.ts"), `
import { expect, test } from "@playwright/test";
import { captureEnvSignals, type EnvSignalCaptureOptions } from "@martymcfly9597/playwright-msteams-reporter/healthCapture";
import type { HealthReporterOptions } from "@martymcfly9597/playwright-msteams-reporter/healthReporter";
const captureOptions: EnvSignalCaptureOptions = { includeHosts: ["app.acme.example"], retainOnPass: true };
const reporterOptions: HealthReporterOptions = { webhookUrlEnv: "PACKED_WEBHOOK", quiet: true };
test("packed TypeScript declarations resolve", async () => {
  expect(captureOptions.includeHosts).toEqual(["app.acme.example"]);
  expect(reporterOptions.webhookUrlEnv).toBe("PACKED_WEBHOOK");
  expect(typeof captureEnvSignals).toBe("function");
});
`);
  writeFileSync(path.join(tests, "legacy.spec.cjs"), `
const { expect, test } = require("@playwright/test");
test("legacy runner reports a real failure without result annotations", () => {
  expect(1).toBe(2);
});
`);
  writeFileSync(path.join(tests, "large.spec.cjs"), `
const { expect, test } = require("@playwright/test");
for (let index = 0; index < 12; index += 1) {
  test("Unicode title " + "🚀".repeat(100) + " " + index, () => {
    expect("synthetic").toBe("synthetic mismatch " + "λ🚀".repeat(700));
  });
}
`);
  writeFileSync(path.join(tests, "types-consumer.ts"), `
import type { MsTeamsReporterOptions } from "@martymcfly9597/playwright-msteams-reporter";
import type { EnvSignalCaptureOptions } from "@martymcfly9597/playwright-msteams-reporter/healthCapture";
import type { HealthReporterOptions } from "@martymcfly9597/playwright-msteams-reporter/healthReporter";
const original: MsTeamsReporterOptions = { webhookUrlEnv: "PACKED_WEBHOOK", webhookType: "msteams" };
const health: HealthReporterOptions = { webhookUrlEnv: "PACKED_WEBHOOK", webhookType: "powerautomate" };
const capture: EnvSignalCaptureOptions = { includeHosts: ["app.acme.example"] };
void [original, health, capture];
`);
}

function configSource({ directory, format, webhookType, includeHealth, includeTypes, legacyFailure, largeFailure, timeoutMs, outputFile }) {
  const consumer = path.join(directory, "node_modules", "@martymcfly9597", "playwright-msteams-reporter", "dist");
  const reporters = [
    [path.join(consumer, "index.js"), {
      webhookUrlEnv: "PACKED_WEBHOOK", webhookType, title: "Original Results", quiet: false, debug: true, webhookTimeoutMs: timeoutMs,
    }],
    ...(includeHealth ? [[path.join(consumer, "healthReporter.js"), {
      webhookUrlEnv: "PACKED_WEBHOOK", webhookType,
      title: largeFailure ? "Release gate Unicode 🚀 ".repeat(100) : "Packed Health",
      maxPayloadBytes: largeFailure ? 4096 : 26000, maxTests: largeFailure ? 100 : 5, quiet: true, webhookTimeoutMs: 5000,
    }]] : []),
    ["json", { outputFile }],
  ];
  const testMatch = ["**/artifact.spec.cjs"];
  if (largeFailure) testMatch.splice(0, testMatch.length, "**/large.spec.cjs");
  else if (legacyFailure) testMatch.splice(0, testMatch.length, "**/legacy.spec.cjs");
  else if (includeTypes) testMatch.push("**/types.spec.ts");
  const config = {
    testDir: path.join(directory, "tests"),
    testMatch,
    workers: 1, retries: 0, outputDir: path.join(directory, "results"), reporter: reporters,
  };
  if (format === "esm") {
    return `import rootReporter from "@martymcfly9597/playwright-msteams-reporter";\n` +
      `import healthReporter from "@martymcfly9597/playwright-msteams-reporter/healthReporter";\n` +
      `import captureModule from "@martymcfly9597/playwright-msteams-reporter/healthCapture";\n` +
      `if (typeof rootReporter.default !== "function" || typeof healthReporter.default !== "function" || typeof captureModule.captureEnvSignals !== "function") throw new Error("Packed ESM imports failed");\n` +
      `export default ${JSON.stringify(config)};\n`;
  }
  return `module.exports = ${JSON.stringify(config)};\n`;
}

async function runConsumer({ directory, format, webhookType, includeHealth, includeTypes = false, legacyFailure = false, largeFailure = false, timeoutMs = 250, signal, receiverUrl }) {
  const outputFile = path.join(directory, "report.json");
  const configFile = path.join(directory, format === "esm" ? "playwright.config.mjs" : "playwright.config.cjs");
  writeFileSync(configFile, configSource({ directory, format, webhookType, includeHealth, includeTypes, legacyFailure, largeFailure, timeoutMs, outputFile }));
  const cli = path.join(directory, "node_modules", "@playwright", "test", "cli.js");
  let result;
  try {
    result = await execute(process.execPath, [cli, "test", "--config", configFile], {
      cwd: directory,
      env: childEnvironment({ PACKED_WEBHOOK: receiverUrl, PACKED_SIGNAL: signal ? "1" : "0", MSTEAMS_WEBHOOK_URL: "", NODE_ENV: "production" }),
      timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    });
    result.exitCode = 0;
  } catch (error) {
    if ((!legacyFailure && !largeFailure) || typeof error.code !== "number") throw error;
    result = { stdout: error.stdout ?? "", stderr: error.stderr ?? "", exitCode: error.code };
  }
  const hasExpectedFailure = legacyFailure || largeFailure;
  assert.equal(result.exitCode, hasExpectedFailure ? 1 : 0, "Playwright test exit status must match the synthetic fixture outcome");
  const report = JSON.parse(readFileSync(outputFile, "utf8"));
  assert.deepEqual(report.errors, []);
  let expectedCount = includeTypes ? 2 : 1;
  let unexpectedCount = 0;
  if (legacyFailure) {
    expectedCount = 0;
    unexpectedCount = 1;
  }
  if (largeFailure) {
    expectedCount = 0;
    unexpectedCount = 12;
  }
  assert.equal(report.stats.unexpected, unexpectedCount);
  assert.equal(report.stats.expected, expectedCount);
  return result;
}

async function verifyStalledDelivery({ behavior, directory, receiver, receiverUrl }) {
  receiver.setBehavior(behavior);
  const stalled = await runConsumer({ directory, format: "cjs", webhookType: "msteams", includeHealth: true, includeTypes: true, timeoutMs: 1000, signal: true, receiverUrl });
  assert.equal(receiver.requests.length, 2, `${behavior} must settle before the second report`);
  assert.equal(receiver.requests[0].responseClosed, true, `${behavior} first response did not close`);
  assert.equal(receiver.requests[1].firstResponseClosedBeforeRequest, true, `${behavior} second request began before the first response closed`);
  const requestGap = receiver.requests[1].receivedAt - receiver.requests[0].receivedAt;
  assert.ok(requestGap >= 700, `${behavior} second post arrived after only ${requestGap}ms, before the bounded wait settled`);
  assert.match(stalled.stderr, /Webhook delivery timed out after 1000ms/);
  assert.equal((stalled.stdout.match(/PACKED_STDOUT_ONCE/g) || []).length, 1);
  assert.doesNotMatch(stalled.stdout + stalled.stderr, /synthetic-package-secret/);
}

async function verifyTypes(consumer) {
  const compiler = path.join(root, "node_modules", "typescript", "bin", "tsc");
  await execute(process.execPath, [compiler, "--noEmit", "--strict", "--skipLibCheck", "--module", "Node16",
    "--moduleResolution", "Node16", "--target", "ES2022", "--types", "node",
    "--typeRoots", path.join(consumer, "node_modules", "@types"), path.join(consumer, "tests", "types-consumer.ts")], {
    cwd: consumer, timeout: 30000, windowsHide: true, maxBuffer: 2 * 1024 * 1024,
  });
}

async function verifyNodeEsmImports(consumer) {
  const packageName = "@martymcfly9597/playwright-msteams-reporter";
  const source = [
    `import reporter from "${packageName}";`,
    `import health from "${packageName}/healthReporter";`,
    `import capture from "${packageName}/healthCapture";`,
    `import models from "${packageName}/models";`,
    'if (typeof reporter.default !== "function" || typeof health.default !== "function" || typeof capture.captureEnvSignals !== "function" || typeof models !== "object") process.exit(1);',
  ].join("\n");
  await execute(process.execPath, ["--input-type=module", "-e", source], {
    cwd: consumer, env: childEnvironment(), timeout: 30000, windowsHide: true, maxBuffer: 2 * 1024 * 1024,
  });
}

function seedGeneratedArtifactFixtures() {
  const fixtures = [];
  const cleanup = () => {
    for (const fixture of fixtures.reverse()) {
      rmSync(fixture.directory, { recursive: true, force: true, maxRetries: 3 });
      if (!fixture.parentExisted) {
        try { rmdirSync(fixture.parent); } catch (error) {
          if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
        }
      }
    }
  };
  try {
    for (const name of ["playwright-report", "test-results", "blob-report"]) {
      const parent = path.join(root, name);
      const parentExisted = existsSync(parent);
      mkdirSync(parent, { recursive: true });
      const directory = mkdtempSync(path.join(parent, "npm-pack-gate-"));
      fixtures.push({ parent, parentExisted, directory });
      writeFileSync(path.join(directory, "artifact.txt"), "generated artifact sentinel");
    }
  } catch (error) {
    cleanup();
    throw error;
  }
  return cleanup;
}

async function main() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "playwright-reporter-pack-"));
  const receiver = createReceiver();
  let primaryFailure;
  try {
    const npmConfigFile = path.join(directory, "npmrc");
    writeFileSync(npmConfigFile, [
      "registry=https://registry.npmjs.org/",
      "@playwright:registry=https://registry.npmjs.org/",
      "@types:registry=https://registry.npmjs.org/",
      "",
    ].join("\n"));
    const cleanupPackFixtures = seedGeneratedArtifactFixtures();
    let packOutput;
    try {
      packOutput = execFileSync(process.execPath, [npmCli, "pack", "--json", "--pack-destination", directory], {
        cwd: root, encoding: "utf8", timeout: 120000, windowsHide: true, maxBuffer: 2 * 1024 * 1024,
      });
    } finally {
      cleanupPackFixtures();
    }
    const [packed] = JSON.parse(packOutput);
    const tarball = path.join(directory, packed.filename);
    const files = new Set(packed.files.map(file => file.path));
    for (const file of ["dist/index.js", "dist/index.d.ts", "dist/healthReporter.js", "dist/healthReporter.d.ts", "dist/healthCapture.js", "dist/healthCapture.d.ts", "dist/models/index.js"]) {
      assert(files.has(file), `Packed artifact is missing ${file}`);
    }
    const packageExports = require(path.join(root, "package.json")).exports;
    assert(packageExports, "Package must declare its public exports");
    for (const subpath of [".", "./healthReporter", "./healthCapture", "./models"]) {
      assert(Object.hasOwn(packageExports, subpath), `Package exports are missing ${subpath}`);
    }
    assert(!Object.keys(packageExports).some(subpath => subpath.startsWith("./dist/")), "Build output paths must not be public package exports");
    assert(!packed.files.some(file => /\.test\.(?:js|d\.ts)$/.test(file.path)), "Packed artifact must not contain compiled tests");
    const allowedRootFiles = new Set(["package.json", "README.md", "CHANGELOG.md", "LICENSE"]);
    const unexpectedFiles = packed.files.filter(file =>
      !allowedRootFiles.has(file.path) && !/^dist\/.+\.(?:js|d\.ts)$/.test(file.path)
    );
    assert.deepEqual(unexpectedFiles, [], "Packed artifact may contain only package metadata/docs/license and runtime/declaration files under dist");
    assert(!packed.files.some(file => /(?:^|\/)(?:playwright-report|test-results|blob-report)(?:\/|$)/.test(file.path)), "Packed artifact must not contain generated Playwright reports, blobs, or test results");

    const currentConsumer = path.join(directory, "consumer-current");
    const floorConsumer = path.join(directory, "consumer-floor");
    mkdirSync(currentConsumer);
    mkdirSync(floorConsumer);
    writeConsumerFiles(currentConsumer);
    writeConsumerFiles(floorConsumer);
    const installations = await Promise.allSettled([
      installConsumer(currentConsumer, tarball, currentPlaywright, npmConfigFile),
      installConsumer(floorConsumer, tarball, "1.45.0", npmConfigFile),
    ]);
    const installationFailure = installations.find(result => result.status === "rejected");
    if (installationFailure) throw installationFailure.reason;
    await verifyNodeEsmImports(currentConsumer);
    await verifyTypes(currentConsumer);
    const receiverUrl = await receiver.listen();

    receiver.setBehavior("success");
    const baselineMsteams = await runConsumer({ directory: currentConsumer, format: "cjs", webhookType: "msteams", includeHealth: false, includeTypes: true, signal: false, receiverUrl });
    assert.equal(receiver.requests.length, 1);
    assert.equal((baselineMsteams.stdout.match(/PACKED_STDOUT_ONCE/g) || []).length, 1);
    const originalMsteamsBody = receiver.requests[0].body;

    receiver.setBehavior("success");
    const healthMsteams = await runConsumer({ directory: currentConsumer, format: "esm", webhookType: "msteams", includeHealth: true, includeTypes: true, signal: true, receiverUrl });
    assert.equal(receiver.requests.length, 2);
    assert.equal(receiver.requests[0].body, originalMsteamsBody);
    assert.match(receiver.requests[1].body, /Passed with signals: 1/);
    assert.equal((healthMsteams.stdout.match(/PACKED_STDOUT_ONCE/g) || []).length, 1);

    receiver.setBehavior("success");
    await runConsumer({ directory: currentConsumer, format: "esm", webhookType: "powerautomate", includeHealth: false, includeTypes: true, signal: false, receiverUrl });
    assert.equal(receiver.requests.length, 1);
    const originalPowerAutomateBody = receiver.requests[0].body;

    receiver.setBehavior("fail-second");
    const failedHealthPost = await runConsumer({ directory: currentConsumer, format: "cjs", webhookType: "powerautomate", includeHealth: true, includeTypes: true, signal: true, receiverUrl });
    assert.equal(receiver.requests.length, 2);
    assert.equal(receiver.requests[1].statusCode, 500);
    assert.equal(receiver.requests[0].body, originalPowerAutomateBody);
    assert.equal((failedHealthPost.stdout.match(/PACKED_STDOUT_ONCE/g) || []).length, 1);
    assert.doesNotMatch(failedHealthPost.stdout + failedHealthPost.stderr, /synthetic-package-secret/);

    receiver.setBehavior("success");
    await runConsumer({ directory: currentConsumer, format: "cjs", webhookType: "msteams", includeHealth: true, largeFailure: true, signal: false, receiverUrl });
    assert.equal(receiver.requests.length, 2);
    assert.ok(Buffer.byteLength(receiver.requests[1].body, "utf8") <= 4096, "Unicode health envelope must respect its configured UTF-8 budget");
    assert.match(receiver.requests[1].body, /Release gate Unicode/);
    assert.match(receiver.requests[1].body, /12 failed/);
    assert.match(receiver.requests[1].body, /additional detail groups omitted/);

    await verifyStalledDelivery({ behavior: "stall-headers", directory: currentConsumer, receiver, receiverUrl });
    await verifyStalledDelivery({ behavior: "stall-body", directory: currentConsumer, receiver, receiverUrl });

    receiver.setBehavior("success");
    await runConsumer({ directory: floorConsumer, format: "cjs", webhookType: "msteams", includeHealth: true, legacyFailure: true, signal: false, receiverUrl });
    assert.equal(receiver.requests.length, 2, "Playwright 1.45 should run both reporters for a failing test");
    assert.match(receiver.requests[1].body, /Final signal evidence unavailable or unsupported/);
    console.log(`Packed artifact verified: ${packed.filename}; CJS/ESM/TS consumers, both webhook types, ordering, stalls, and Playwright 1.45/${currentPlaywright} annotation behavior`);
  } catch (error) {
    primaryFailure = error;
  }
  const cleanup = await Promise.allSettled([
    receiver.close(),
    Promise.resolve().then(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3 })),
  ]);
  if (primaryFailure) throw primaryFailure;
  for (const result of cleanup) {
    if (result.status === "rejected") throw result.reason;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});