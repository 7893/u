import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = join(import.meta.dirname, "..");
const prefix = "u-gate";
const passphrase = "example-passphrase";
const wrong = "0".repeat(64);

function digestOf(gatePrefix, pass) {
  return createHash("sha256").update(`${gatePrefix}:${pass}`, "utf8").digest("hex");
}

function pythonDigest(gatePrefix, pass) {
  const result = spawnSync(
    "python3",
    [
      "-c",
      "import hashlib,sys; print(hashlib.sha256(f'{sys.argv[1]}:{sys.argv[2]}'.encode()).hexdigest(), end='')",
      gatePrefix,
      pass,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function render(text, digest, origin, installRoot, { trackPort = "19204", altSvc = "" } = {}) {
  let rendered = text;
  if (altSvc) {
    rendered = rendered.replaceAll("__U_ALT_SVC_HEADER__", `add_header Alt-Svc '${altSvc}' always;`);
  } else {
    rendered = rendered.replace(/^[ \t]*__U_ALT_SVC_HEADER__[ \t]*\r?\n?/gm, "");
  }
  rendered = rendered
    .replaceAll("__U_PASS_SHA256__", digest)
    .replaceAll("__PUBLIC_ORIGIN__", origin)
    .replaceAll("__U_ROOT__", installRoot)
    .replaceAll("__U_TRACK_PORT__", trackPort);
  assert.equal(/__(?:U|PUBLIC)_[A-Z0-9_]+__/.test(rendered), false);
  return rendered;
}

function mapResult(conf, mapLabel, sample) {
  const start = conf.indexOf(mapLabel);
  assert.ok(start >= 0, `missing map ${mapLabel}`);
  const end = conf.indexOf("\n}", start);
  const block = conf.slice(start, end);
  let fallback = 0;
  for (const line of block.split("\n")) {
    const fallbackMatch = line.match(/default\s+(\d+)\s*;/);
    if (fallbackMatch) fallback = Number(fallbackMatch[1]);
    const patternMatch = line.match(/"~([^"]+)"\s+(\d+)\s*;/);
    if (patternMatch && new RegExp(patternMatch[1]).test(sample)) {
      return Number(patternMatch[2]);
    }
  }
  return fallback;
}

async function bundle(env) {
  const dir = await mkdtemp(join(tmpdir(), "u-gate-"));
  const childEnv = { ...process.env, ...env, U_DIST_DIR: dir };
  if (!Object.hasOwn(env, "U_GATE_PREFIX")) delete childEnv.U_GATE_PREFIX;
  if (!Object.hasOwn(env, "U_CUSTOM_FONTS")) delete childEnv.U_CUSTOM_FONTS;
  const result = spawnSync("bash", ["scripts/build.sh"], {
    cwd: root,
    env: childEnv,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  try {
    return {
      js: await readFile(join(dir, "app.js"), "utf8"),
      css: await readFile(join(dir, "app.css"), "utf8"),
      html: await readFile(join(dir, "index.html"), "utf8"),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the page and the installer hash the same prefix and passphrase", () => {
  const fromNode = digestOf(prefix, passphrase);
  assert.equal(fromNode, pythonDigest(prefix, passphrase));
  assert.match(fromNode, /^[0-9a-f]{64}$/);
  assert.notEqual(digestOf(prefix, "other-passphrase"), fromNode);
  assert.notEqual(digestOf("other-gate", passphrase), fromNode);
});

test("nginx accepts only the passphrase digest and is self-contained", async () => {
  const digest = digestOf(prefix, passphrase);
  const httpRaw = await readFile(join(root, "server/nginx/u_http.conf"), "utf8");
  const locationsRaw = await readFile(join(root, "server/nginx/u_locations.conf"), "utf8");

  const http = render(httpRaw, digest, "https://files.example", "/srv/u", { trackPort: "19999" });
  assert.equal(mapResult(http, "map $cookie_u_key $u_authed", digest), 1);
  assert.equal(mapResult(http, "map $cookie_u_key $u_authed", wrong), 0);
  assert.equal(mapResult(http, "map $cookie_u_key $u_authed", ""), 0);
  assert.equal(mapResult(http, "$u_auth_check", `${digest}:`), 1);
  assert.equal(mapResult(http, "$u_auth_check", `:${digest}`), 1);
  assert.equal(mapResult(http, "$u_auth_check", `${wrong}:`), 0);
  assert.equal(mapResult(http, "$u_auth_check", `:${wrong}`), 0);
  assert.equal(http.includes("zone=u_general:"), true);
  assert.equal(http.includes("listen 127.0.0.1:19999;"), true);

  const locationsDefault = render(locationsRaw, digest, "https://files.example", "/srv/u", {
    trackPort: "19999",
  });
  assert.match(locationsDefault, new RegExp(`u_key=${digest};`));
  assert.equal(locationsDefault.includes(`u_key=${wrong}`), false);
  assert.equal(locationsDefault.includes("/srv/u"), true);
  assert.equal(locationsDefault.includes("zone=u_general"), true);
  assert.equal(locationsDefault.includes("zone=general"), false);
  assert.equal(locationsDefault.includes("more_set_headers"), false);
  assert.equal(locationsDefault.includes("more_clear_headers"), false);
  assert.equal(locationsDefault.includes("Alt-Svc"), false);
  assert.equal(locationsDefault.includes("http://127.0.0.1:19999"), true);

  const locationsWithH3 = render(locationsRaw, digest, "https://files.example", "/srv/u", {
    altSvc: 'h3=":443"; ma=86400',
  });
  assert.equal(locationsWithH3.includes(`add_header Alt-Svc 'h3=":443"; ma=86400' always;`), true);
});

test("the built page contains the configured gate prefix and optional custom fonts", async () => {
  const configured = "u-gate-test";
  const withPrefix = await bundle({ U_GATE_PREFIX: configured, U_DEPLOY_ENV_FILE: "/dev/null" });
  assert.equal(withPrefix.js.includes(configured), true);
  assert.equal(withPrefix.js.includes("U_GATE_PREFIX"), false);
  assert.equal(withPrefix.html.includes("/u/fonts/"), false);
  assert.equal(withPrefix.html.includes("U_FONT_PRELOAD"), false);
  assert.equal(withPrefix.css.includes("/u/fonts/"), false);

  const withDefault = await bundle({ U_DEPLOY_ENV_FILE: "/dev/null" });
  assert.equal(withDefault.js.includes("u-gate"), true);
  assert.equal(withDefault.js.includes(configured), false);
  assert.equal(withDefault.js.includes("U_GATE_PREFIX"), false);

  const withFonts = await bundle({
    U_DEPLOY_ENV_FILE: "/dev/null",
    U_CUSTOM_FONTS: "1",
  });
  assert.equal(withFonts.html.includes("/u/fonts/Inter-UI-VF.woff2"), true);
  assert.equal(withFonts.html.includes("/u/fonts/NotoSansSC-UI-VF.woff2"), true);
  assert.equal(withFonts.css.includes("/u/fonts/Inter-UI-VF.woff2"), true);
  assert.equal(withFonts.css.includes("/u/fonts/NotoSansSC-Ext-VF.woff2"), true);
  assert.equal(withFonts.css.includes("unicode-range"), false);
});
