import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { FakeElementCore } from "./helpers/fake-element.mjs";

const source = readFileSync(new URL("../public/chatgpt-window.js", import.meta.url), "utf8");
const route = "/plugins/codey-chatgpt-window";

function setup(url = "app://-/index.html", account = "test-account") {
  const body = new FakeElementCore("body");
  const settings = new FakeElementCore("button");
  settings.id = "codey-settings-button";
  body.append(settings);
  if (account) {
    const pricing = new FakeElementCore("webview");
    pricing.setAttribute("partition", "codex-pricing-test");
    pricing.setAttribute("src", "about:blank?accountId=" + account);
    body.append(pricing);
  }
  const messages = [], alerts = [], timers = new Map(), events = new Map();
  let observe, disconnected = false, uuid = 0;
  const document = {
    body,
    createElement: (tag) => new FakeElementCore(tag),
    getElementById: (id) => body.querySelector("#" + id),
    querySelectorAll: (selector) => body.querySelectorAll(selector),
  };
  const context = vm.createContext({
    location: new URL(url), document, URL,
    crypto: { randomUUID: () => "unique-" + ++uuid },
    electronBridge: { sendMessageFromView: async (message) => messages.push(message) },
    alert: (message) => alerts.push(message),
    MutationObserver: class {
      constructor(callback) { observe = callback; }
      observe() {}
      disconnect() { disconnected = true; }
    },
    setTimeout: (callback) => { const id = timers.size + 1; timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id),
    addEventListener: (name, callback) => events.set(name, callback),
  });
  const run = () => vm.runInContext(source, context);
  run();
  return { body, document, context, messages, alerts, timers, events, run,
    observe: () => observe?.(), disconnected: () => disconnected };
}

test("entry opens an isolated native route using account metadata only", async () => {
  const app = setup();
  const button = app.document.getElementById("codey-chatgpt-window-button");
  await button.listeners.get("click")[0]();
  assert.equal(app.messages.length, 1);
  assert.equal(app.messages[0].type, "open-in-new-window");
  assert.equal(app.messages[0].path, route + "?accountId=test-account");
  assert.equal(button.disabled, false);
  app.run();
  app.observe();
  assert.equal(app.body.querySelectorAll("#codey-chatgpt-window-button").length, 1);
  app.events.get("pagehide")();
  assert.equal(app.disconnected(), true);
});

test("missing account or native bridge fails without opening a different account", async () => {
  for (const missing of ["account", "bridge"]) {
    const app = setup(undefined, missing === "account" ? null : "test-account");
    if (missing === "bridge") delete app.context.electronBridge;
    const button = app.document.getElementById("codey-chatgpt-window-button");
    await button.listeners.get("click")[0]();
    assert.equal(app.messages.length, 0);
    assert.equal(app.alerts.length, 1);
    assert.equal(button.disabled, false);
  }
});

test("host uses the native authenticated partition and retries with a fresh partition", () => {
  const app = setup("app://-/index.html?initialRoute=" + encodeURIComponent(route + "?accountId=test-account"));
  const host = app.document.getElementById("codey-chatgpt-window");
  const first = host.querySelector("webview");
  const bootstrap = new URL(first.getAttribute("src"));
  assert.equal(bootstrap.protocol, "about:");
  assert.equal(bootstrap.searchParams.get("toUrl"), "https://chatgpt.com/");
  assert.equal(bootstrap.searchParams.get("accountId"), "test-account");
  assert.match(first.getAttribute("partition"), /^codex-first-party-plugin-authenticated-chatgpt-codey-/);
  assert.equal(first.hasAttribute("preload"), false);
  assert.equal(first.hasAttribute("nodeintegration"), false);
  assert.equal(app.document.getElementById("codey-chatgpt-window-button"), null);
  first.dispatchEvent({ type: "did-fail-load", errorCode: -105 });
  assert.match(host.querySelector("span").textContent, /-105/);
  host.querySelector("button").dispatchEvent({ type: "click" });
  const second = host.querySelector("webview");
  assert.notEqual(second.getAttribute("partition"), first.getAttribute("partition"));
  assert.equal(first.isConnected, false);
  first.dispatchEvent({ type: "did-fail-load", errorCode: -999 });
  assert.doesNotMatch(host.querySelector("span").textContent, /-999/);
  app.events.get("pagehide")();
  assert.equal(app.timers.size, 0);
});

test("entry also mounts when the main window starts on an existing conversation", () => {
  const app = setup("app://-/index.html?initialRoute=%2Flocal%2Fthread-1");
  assert.ok(app.document.getElementById("codey-chatgpt-window-button"));
});

test("invalid host account never starts a webview", () => {
  const app = setup("app://-/index.html?initialRoute=" + encodeURIComponent(route + "?accountId=bad%2Faccount"));
  assert.equal(app.body.querySelectorAll("webview").length, 1); // only the fixture's pricing view
  assert.equal(app.document.getElementById("codey-chatgpt-window").querySelector("webview"), null);
});

test("remote pages and native auxiliary windows receive no entry or host", () => {
  for (const url of ["https://chatgpt.com/", "app://-/index.html?initialRoute=%2Favatar-overlay", "app://-/detached-window.html"]) {
    const app = setup(url);
    assert.equal(app.document.getElementById("codey-chatgpt-window-button"), null);
    assert.equal(app.document.getElementById("codey-chatgpt-window"), null);
  }
});
