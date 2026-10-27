import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { FakeElementCore } from "./helpers/fake-element.mjs";

const source = readFileSync(new URL("../public/codey-inject.js", import.meta.url), "utf8");

class FakeElement extends FakeElementCore {
  constructor(tag = "div", attributes = {}) {
    super(tag, { attributes, connected: true });
    this.className = "";
    const classes = new Set();
    this.classList = {
      add: (value) => classes.add(value),
      remove: (value) => classes.delete(value),
      contains: (value) => classes.has(value),
      toggle(value, enabled) {
        if (enabled) classes.add(value);
        else classes.delete(value);
      },
    };
  }

  getBoundingClientRect() {
    const offset = this.hasAttribute("data-codey-session-tabs-header")
      ? Number.parseFloat(this.style.getPropertyValue("--codey-session-tabs-height")) || 0 : 0;
    const height = this.id === "codey-session-tabs" ? 44 : 24;
    return { top: 100 + offset, bottom: 100 + offset + height, left: 100, right: 124, width: 24, height };
  }

  getClientRects() { return [this.getBoundingClientRect()]; }
  get firstChild() { return this.children[0] || null; }
  removeChild(child) { child.remove(); return child; }
  click() { this.dispatchEvent({ type: "click" }); }
}

function fixture({ idle = true, bridge, controller, pathname = "/" } = {}) {
  let sequence = 0;
  let queries = 0;
  const queriesBySelector = new Map();
  const timeouts = new Map();
  const intervals = new Map();
  const idleCallbacks = new Map();
  const observers = [];
  const calls = [];
  const document = new FakeElement("document");
  document.body = new FakeElement("body");
  document.documentElement = new FakeElement("html");
  document.appendChild(document.documentElement);
  document.documentElement.appendChild(document.body);
  document.visibilityState = "visible";
  document.scripts = [];
  document.createElement = (tag) => new FakeElement(tag);
  const placeholder = new FakeElement();
  document.getElementById = (id) => {
    if (["codey-injected-style", "codey-settings-button", "codey-message-toolbar"].includes(id)) {
      return placeholder;
    }
    return document.querySelector(`#${id}`);
  };
  document.querySelectorAll = (selector) => {
    queries += 1;
    queriesBySelector.set(selector, (queriesBySelector.get(selector) || 0) + 1);
    return FakeElementCore.prototype.querySelectorAll.call(document, selector);
  };
  const window = new FakeElement("window");
  Object.assign(window, {
    __codeyCodexSessionController: controller,
    __codexSessionDeleteBridge(path, payload, options) {
      calls.push({ path, payload, options });
      return bridge?.(path, payload) ?? Promise.resolve({ status: "ok", timestamps: {} });
    },
    clearTimeout: (id) => timeouts.delete(id),
    clearInterval: (id) => intervals.delete(id),
    cancelIdleCallback: (id) => idleCallbacks.delete(id),
    setTimeout(callback, delay = 0) {
      const id = ++sequence;
      timeouts.set(id, { callback, delay });
      return id;
    },
    setInterval(callback) {
      const id = ++sequence;
      intervals.set(id, callback);
      return id;
    },
    localStorage: { length: 0, key() {}, getItem() {}, setItem() {} },
  });
  if (idle) window.requestIdleCallback = (callback) => {
    const id = ++sequence;
    idleCallbacks.set(id, callback);
    return id;
  };
  const context = vm.createContext({
    console, document, window, URL, URLSearchParams,
    HTMLElement: FakeElement, Element: FakeElement,
    Node: { TEXT_NODE: 3 },
    location: { pathname, search: "" },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        this.connected = false;
        observers.push(this);
      }
      observe() { this.connected = true; }
      disconnect() { this.connected = false; }
    },
  });
  return {
    document, window, timeouts, intervals, idleCallbacks, observers, calls,
    queries: (selector) => selector ? (queriesBySelector.get(selector) || 0) : queries,
    load: () => vm.runInContext(source.replace(
      "  const scan = ",
      "  window.__testSyncSessionTabs = syncSessionTabs;\n  const scan = ",
    ), context),
    runTimeout(delay) {
      const entry = [...timeouts].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `missing timeout with delay ${delay}`);
      timeouts.delete(entry[0]);
      return entry[1].callback();
    },
  };
}

function thread(document, sessionId, running = false) {
  const item = new FakeElement("div", { role: "listitem" });
  const row = new FakeElement("div", {
    "data-app-action-sidebar-thread-row": "",
    "data-app-action-sidebar-thread-id": sessionId,
    "data-app-action-sidebar-thread-title": sessionId,
  });
  const content = new FakeElement();
  content.className = "flex h-full w-full items-center";
  const title = new FakeElement();
  title.className = "flex min-w-0 flex-1 items-center gap-2";
  const rail = new FakeElement();
  rail.className = "ml-[3px] flex items-center justify-end gap-1";
  const spinner = new FakeElement();
  spinner.className = "animate-spin rounded-full";
  if (running) rail.appendChild(spinner);
  content.append(title, rail);
  row.appendChild(content);
  item.appendChild(row);
  document.body.appendChild(item);
  return { row, spinner };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("incremental sidebar roots synchronize session tabs once per batch", () => {
  const runtime = fixture();
  const rows = ["one", "two", "three"].map((id) => thread(runtime.document, id).row);
  runtime.load();
  const selector = "[data-app-action-sidebar-thread-id]";
  const before = runtime.queries(selector);
  runtime.observers[0].callback(rows.map((target) => ({
    type: "attributes", attributeName: "aria-label", target,
  })));
  runtime.runTimeout(60);
  assert.equal(runtime.queries(selector) - before, 1);
});

test("incremental conversation turns skip global session tab synchronization", () => {
  const runtime = fixture();
  const turns = ["one", "two"].map((id) => {
    const turn = new FakeElement("div", { "data-turn-key": id });
    runtime.document.body.appendChild(turn);
    return turn;
  });
  runtime.load();
  const selector = "[data-app-action-sidebar-thread-id]";
  const before = runtime.queries(selector);
  runtime.observers[0].callback(turns.map((target) => ({
    type: "attributes", attributeName: "data-turn-key", target,
  })));
  runtime.runTimeout(60);
  assert.equal(runtime.queries(selector), before);
});

function tabsFixture() {
  const runtime = fixture();
  const main = new FakeElement("main");
  const composer = new FakeElement("div", { "data-above-composer-conversation-id": "one" });
  main.appendChild(composer);
  runtime.document.body.appendChild(main);
  const first = thread(runtime.document, "one").row;
  const second = thread(runtime.document, "two").row;
  const select = (row, id) => {
    composer.setAttribute("data-above-composer-conversation-id", id);
    for (const item of [first, second]) {
      item.setAttribute("data-app-action-sidebar-thread-active", String(item === row));
    }
  };
  for (const [row, id] of [[first, "one"], [second, "two"]]) {
    const onClick = () => select(row, id);
    row.addEventListener("click", onClick);
    row.__reactProps$test = { onClick };
  }
  select(first, "one");
  runtime.load();
  const sync = () => runtime.window.__testSyncSessionTabs();
  const tabs = () => main.querySelectorAll("[data-codey-tab]");
  return { ...runtime, main, composer, first, second, select, sync, tabs };
}

test("session tabs deduplicate visits, switch natively and close without deleting the conversation", () => {
  const runtime = tabsFixture();
  runtime.sync();
  runtime.sync();
  assert.equal(runtime.tabs().length, 1);
  runtime.second.click();
  runtime.sync();
  assert.equal(runtime.tabs().length, 2);
  runtime.tabs()[0].querySelector("[data-codey-tab-title]").click();
  assert.equal(runtime.composer.getAttribute("data-above-composer-conversation-id"), "one");
  runtime.sync();
  runtime.runTimeout(3000);
  const firstTab = runtime.tabs()[0];
  firstTab.children.at(-1).click();
  runtime.sync();
  assert.equal(runtime.tabs().length, 1);
  assert.equal(runtime.composer.getAttribute("data-above-composer-conversation-id"), "one");
  assert.equal(runtime.first.isConnected, true);
  assert.equal(runtime.calls.length, 0);
  runtime.second.click();
  runtime.sync();
  runtime.first.click();
  runtime.sync();
  assert.equal(runtime.tabs().length, 2);
});

test("tabs mirror native running and unread state and retain it while rows are virtualized", () => {
  const runtime = tabsFixture();
  const statusState = { type: "loading", unread: false };
  runtime.first.__reactFiber$test = { memoizedProps: { statusState } };
  runtime.sync();
  assert.equal(runtime.tabs()[0].getAttribute("data-codey-tab-status"), "running");
  statusState.type = "idle";
  statusState.unread = true;
  runtime.sync();
  assert.equal(runtime.tabs()[0].getAttribute("data-codey-tab-status"), "unread");
  runtime.first.remove();
  runtime.sync();
  assert.equal(runtime.tabs()[0].getAttribute("data-codey-tab-status"), "unread");
  runtime.document.body.appendChild(runtime.first);
  statusState.unread = false;
  runtime.sync();
  assert.equal(runtime.tabs()[0].getAttribute("data-codey-tab-status"), "idle");
});

test("tab context actions protect locked tabs until explicitly unlocked", () => {
  const runtime = tabsFixture();
  runtime.sync();
  runtime.second.click();
  runtime.sync();
  const menuAction = (index, label) => {
    runtime.tabs()[index].dispatchEvent({ type: "contextmenu", clientX: 20, clientY: 20, preventDefault() {} });
    const menu = runtime.document.querySelector('[role="menu"]');
    const button = [...menu.querySelectorAll("button")].find((item) => item.textContent === label);
    assert.ok(button);
    button.click();
  };
  menuAction(1, "锁定");
  assert.equal(runtime.tabs()[0].querySelector("[data-codey-tab-title]").textContent, "two");
  assert.ok(runtime.tabs()[0].querySelector('[aria-label="已锁定"]'));
  runtime.tabs()[0].children.at(-1).click();
  assert.equal(runtime.tabs().length, 2);
  menuAction(1, "关闭其他");
  assert.equal(runtime.tabs().length, 2);
  menuAction(1, "关闭左侧");
  assert.equal(runtime.tabs().length, 2);
  menuAction(0, "解除锁定");
  menuAction(1, "关闭左侧");
  assert.equal(runtime.tabs().length, 1);
  runtime.second.click();
  runtime.sync();
  menuAction(0, "关闭右侧");
  assert.equal(runtime.tabs().length, 1);
  assert.equal(runtime.second.isConnected, true);
  assert.equal(runtime.calls.length, 0);
});

test("session tabs retain native navigation when a virtual sidebar row unmounts", () => {
  const runtime = tabsFixture();
  runtime.sync();
  runtime.second.click();
  runtime.sync();
  runtime.first.remove();
  runtime.tabs()[0].querySelector("button").click();
  assert.equal(runtime.composer.getAttribute("data-above-composer-conversation-id"), "one");
  runtime.runTimeout(3000);
  assert.equal(runtime.document.getElementById("codey-runtime-toast"), null);
});

test("session tabs create a chat through the native entry without sending or deleting anything", () => {
  const runtime = tabsFixture();
  let clicks = 0;
  const native = new FakeElement("button", { "aria-label": "新聊天" });
  native.addEventListener("click", () => { clicks += 1; });
  runtime.document.body.appendChild(native);
  runtime.sync();
  const newChat = runtime.main.querySelector("[data-codey-tab-new]");
  assert.ok(newChat);
  newChat.click();
  assert.equal(clicks, 1);
  assert.equal(runtime.calls.length, 0);
  assert.equal(runtime.first.isConnected, true);
});

test("session tabs report an unavailable native new-chat entry instead of guessing a route", () => {
  const runtime = tabsFixture();
  runtime.sync();
  runtime.main.querySelector("[data-codey-tab-new]").click();
  assert.match(runtime.document.getElementById("codey-runtime-toast").textContent, /未找到新聊天入口/);
  assert.equal(runtime.calls.length, 0);
});

test("desktop tabs ignore hidden main overlays and preserve native header and side-panel controls", () => {
  const runtime = tabsFixture();
  runtime.main.setAttribute("aria-hidden", "true");
  const pane = new FakeElement("div", { "data-codex-thread-reference-drop-target": "" });
  const header = new FakeElement("div", { "data-app-shell-main-titlebar": "true" });
  const menu = new FakeElement("button", { "aria-label": "更多" });
  const summary = new FakeElement("button", { "aria-label": "摘要" });
  const rightPane = new FakeElement("div", { "data-app-shell-titlebar-slot": "content" });
  const sideToggle = new FakeElement("button", { "aria-label": "侧边栏" });
  header.append(menu, summary);
  rightPane.appendChild(sideToggle);
  pane.appendChild(runtime.composer);
  runtime.document.body.append(pane, header, rightPane);
  let resize;
  let disconnected = false;
  runtime.window.ResizeObserver = class {
    constructor(callback) { resize = callback; }
    observe() {}
    disconnect() { disconnected = true; }
  };
  runtime.sync();
  const bar = runtime.document.getElementById("codey-session-tabs");
  assert.equal(bar.parentElement, runtime.document.body);
  assert.equal(runtime.main.querySelector("#codey-session-tabs"), null);
  assert.equal(pane.getAttribute("data-codey-session-tabs-pane"), "");
  assert.equal(header.getAttribute("data-codey-session-tabs-header"), "");
  assert.deepEqual(header.children, [menu, summary]);
  assert.deepEqual(rightPane.children, [sideToggle]);
  header.getBoundingClientRect = () => ({ left: 200, top: 90, width: 500 });
  resize();
  assert.equal(bar.style.left, "200px");
  assert.equal(bar.style.top, "46px");
  assert.equal(bar.style.width, "500px");
  runtime.window.__codeySessionToolsInstall.dispose();
  assert.equal(disconnected, true);
  assert.equal(header.getAttribute("data-codey-session-tabs-header"), null);
  assert.equal(pane.getAttribute("data-codey-session-tabs-pane"), null);
  assert.deepEqual(header.children, [menu, summary]);
});

test("tabs offset alternate titlebars once using measured height and restore all on disposal", () => {
  const runtime = tabsFixture();
  const pane = new FakeElement("div", { "data-codex-thread-reference-drop-target": "" });
  const header = new FakeElement("div", { "data-app-shell-main-titlebar": "" });
  const alternate = new FakeElement("div", { "data-app-shell-main-titlebar": "true" });
  pane.appendChild(runtime.composer);
  runtime.document.body.append(pane, header, alternate);
  let resize;
  runtime.window.ResizeObserver = class {
    constructor(callback) { resize = callback; }
    observe() {}
    disconnect() {}
  };
  runtime.sync();
  const bar = runtime.document.getElementById("codey-session-tabs");
  assert.equal(header.getBoundingClientRect().top, 144);
  assert.equal(alternate.getBoundingClientRect().top, 144);
  runtime.sync();
  assert.equal(header.getBoundingClientRect().top, 144, "does not accumulate offsets");
  header.removeAttribute("data-codey-session-tabs-header");
  runtime.sync();
  assert.equal(header.getBoundingClientRect().top, 144, "recovers a replaced marker");
  bar.getBoundingClientRect = () => ({ height: 36 });
  resize();
  assert.equal(header.getBoundingClientRect().top, 136);
  assert.equal(alternate.getBoundingClientRect().top, 136);
  assert.equal(bar.style.top, "100px");
  assert.equal(pane.style.getPropertyValue("--codey-session-tabs-height"), "36px");
  runtime.window.__codeySessionToolsInstall.dispose();
  for (const node of [header, alternate]) {
    assert.equal(node.hasAttribute("data-codey-session-tabs-header"), false);
    assert.equal(node.style.getPropertyValue("--codey-session-tabs-height"), "");
    assert.equal(node.getBoundingClientRect().top, 100);
  }
});

test("titlebar reserves tab space even before the chat drop target mounts", () => {
  const runtime = tabsFixture();
  const empty = new FakeElement("div", { "data-app-shell-main-titlebar": "true" });
  empty.getBoundingClientRect = () => ({ width: 0, height: 0, top: 0, left: 0 });
  const header = new FakeElement("div", { "data-app-shell-main-titlebar": "" });
  runtime.document.body.append(empty, header);
  runtime.sync();
  assert.equal(header.getBoundingClientRect().top, 144);
  assert.equal(empty.hasAttribute("data-codey-session-tabs-header"), false);
  assert.equal(runtime.document.getElementById("codey-session-tabs").style.top, "100px");
  runtime.window.__codeySessionToolsInstall.dispose();
  assert.equal(header.getBoundingClientRect().top, 100);
});

test("desktop tabs survive an empty identity and replaced chat anchors without removing the bar", () => {
  const runtime = tabsFixture();
  runtime.main.setAttribute("aria-hidden", "true");
  const pane = new FakeElement("div", { "data-codex-thread-reference-drop-target": "" });
  const header = new FakeElement("div", { "data-app-shell-main-titlebar": "true" });
  pane.appendChild(runtime.composer);
  runtime.document.body.append(pane, header);
  runtime.sync();
  const bar = runtime.document.getElementById("codey-session-tabs");
  const firstTab = bar.firstChild;
  runtime.composer.removeAttribute("data-above-composer-conversation-id");
  runtime.first.setAttribute("data-app-action-sidebar-thread-active", "false");
  runtime.sync();
  assert.equal(runtime.document.getElementById("codey-session-tabs"), bar);
  assert.equal(bar.firstChild, firstTab);
  pane.remove();
  header.remove();
  runtime.sync();
  assert.equal(runtime.document.getElementById("codey-session-tabs"), bar);
  const nextPane = new FakeElement("div", { "data-codex-thread-reference-drop-target": "" });
  const nextHeader = new FakeElement("div", { "data-app-shell-main-titlebar": "true" });
  nextPane.appendChild(runtime.composer);
  runtime.document.body.append(nextPane, nextHeader);
  runtime.select(runtime.second, "two");
  runtime.sync();
  assert.equal(runtime.document.getElementById("codey-session-tabs"), bar);
  assert.equal(nextPane.getAttribute("data-codey-session-tabs-pane"), "");
  assert.equal(nextHeader.getAttribute("data-codey-session-tabs-header"), "");
  assert.equal([...runtime.timeouts.values()].some(({ delay }) => delay === 1000), false);
  assert.equal(bar.querySelectorAll("[data-codey-tab]").length, 2);
  // 离开聊天后卸载有上限，后续扫描不能不断延长清理时间。
  nextPane.remove();
  nextHeader.remove();
  runtime.sync();
  runtime.sync();
  assert.equal([...runtime.timeouts.values()].filter(({ delay }) => delay === 1000).length, 1);
  runtime.runTimeout(1000);
  assert.equal(runtime.document.getElementById("codey-session-tabs"), null);
  runtime.sync();
  assert.equal(runtime.document.getElementById("codey-session-tabs"), null);
});

test("session tabs resolve a temporary sidebar ID through the existing React identity", () => {
  const runtime = tabsFixture();
  const id = "12345678-1234-1234-1234-123456789abc";
  runtime.first.setAttribute("data-app-action-sidebar-thread-id", "client-new-thread:temporary");
  runtime.first.setAttribute("data-app-action-sidebar-thread-title", "Resolved title");
  runtime.first.__reactFiber$test = { memoizedProps: { conversationId: id } };
  runtime.select(runtime.first, id);
  runtime.sync();
  assert.equal(runtime.tabs()[0].querySelector("button").textContent, "Resolved title");
});

test("session tab installation is idempotent and disposal removes bars and navigation timers", () => {
  const runtime = tabsFixture();
  runtime.sync();
  runtime.tabs()[0].querySelector("button").click();
  const install = runtime.window.__codeySessionToolsInstall;
  runtime.load();
  assert.equal(runtime.window.__codeySessionToolsInstall, install);
  assert.equal(runtime.main.querySelectorAll("#codey-session-tabs").length, 1);
  install.dispose();
  assert.equal(runtime.main.querySelectorAll("#codey-session-tabs").length, 0);
  assert.equal([...runtime.timeouts.values()].some(({ delay }) => delay === 3000), false);
  runtime.load();
  runtime.sync();
  assert.equal(runtime.main.querySelectorAll("#codey-session-tabs").length, 1);
  assert.equal(runtime.tabs().length, 1);
});

test("session tabs omit project dropdowns and hide in maximized layouts without losing tabs", () => {
  const runtime = tabsFixture();
  const layout = new FakeElement("div", {
    "data-app-shell-workspace-layout": "split",
    "data-app-shell-right-panel-full-width": "false",
  });
  const pane = new FakeElement("div", { "data-codex-thread-reference-drop-target": "" });
  const header = new FakeElement("div", { "data-app-shell-main-titlebar": "true" });
  pane.appendChild(runtime.composer);
  layout.appendChild(pane);
  runtime.document.body.append(layout, header);
  runtime.sync();
  const bar = runtime.document.getElementById("codey-session-tabs");
  assert.equal(bar.querySelector("[data-codey-tab]").children.length, 2);
  for (const fullWidth of ["false", "true"]) {
    layout.setAttribute("data-app-shell-workspace-layout", "full");
    layout.setAttribute("data-app-shell-right-panel-full-width", fullWidth);
    runtime.observers[0].callback([{ type: "attributes", attributeName: "data-app-shell-workspace-layout", target: layout }]);
    assert.equal(bar.hidden, true);
    assert.equal(pane.getAttribute("data-codey-session-tabs-pane"), null);
    assert.equal(header.getAttribute("data-codey-session-tabs-header"), null);
    layout.setAttribute("data-app-shell-workspace-layout", "split");
    layout.setAttribute("data-app-shell-right-panel-full-width", "false");
    runtime.observers[0].callback([{ type: "attributes", attributeName: "data-app-shell-workspace-layout", target: layout }]);
    assert.equal(runtime.document.getElementById("codey-session-tabs"), bar);
    assert.equal(bar.hidden, false);
    assert.equal(bar.querySelectorAll("[data-codey-tab]").length, 1);
  }
  assert.equal(runtime.calls.length, 0);
});

test("session tabs keep native layout actions separate from the scrolling tab list", () => {
  const runtime = tabsFixture();
  let clicks = 0;
  const native = new FakeElement("button", {
    "data-app-shell-workspace-layout-toggle": "main",
    "aria-label": "进入完整视图",
  });
  native.innerHTML = "<svg></svg>";
  native.addEventListener("click", () => { clicks += 1; });
  runtime.document.body.appendChild(native);
  runtime.sync();
  const bar = runtime.document.getElementById("codey-session-tabs");
  const button = bar.querySelector('[data-codey-layout-toggle="main"]');
  assert.equal(button.parentElement.getAttribute("data-codey-tab-actions"), "");
  assert.equal(button.getAttribute("aria-label"), "进入完整视图");
  assert.equal(button.innerHTML, native.innerHTML);
  assert.equal(bar.querySelector("[data-codey-tab-list]").contains(button), false);
  button.click();
  assert.equal(clicks, 1);
  assert.equal(native.parentElement, runtime.document.body);
  assert.equal(runtime.calls.length, 0);
});

test("maximize lives in the conversation header and stays usable while tabs are hidden", () => {
  const runtime = tabsFixture();
  const layout = new FakeElement("div", { "data-app-shell-workspace-layout": "split" });
  const pane = new FakeElement("div", { "data-codex-thread-reference-drop-target": "" });
  const header = new FakeElement("div", { "data-app-shell-main-titlebar": "true" });
  const summary = new FakeElement("button", { "aria-label": "摘要" });
  header.appendChild(summary);
  pane.appendChild(runtime.composer);
  layout.appendChild(pane);
  const native = new FakeElement("button", {
    "data-app-shell-workspace-layout-toggle": "right-panel",
    "aria-label": "进入完整视图", "aria-pressed": "false",
  });
  native.innerHTML = "<svg></svg>";
  native.addEventListener("click", () => {
    const full = layout.getAttribute("data-app-shell-workspace-layout") !== "full";
    layout.setAttribute("data-app-shell-workspace-layout", full ? "full" : "split");
    native.setAttribute("aria-pressed", String(full));
    native.setAttribute("aria-label", full ? "退出完整视图" : "进入完整视图");
    runtime.sync();
  });
  runtime.document.body.append(layout, header, native);
  runtime.sync();
  runtime.sync();
  const bar = runtime.document.getElementById("codey-session-tabs");
  const button = header.querySelector('[data-codey-chat-maximize]');
  assert.ok(button);
  assert.equal(header.querySelectorAll('[data-codey-chat-maximize]').length, 1);
  assert.equal(bar.querySelector('[data-codey-layout-toggle="right-panel"]'), null);
  button.click();
  assert.equal(bar.hidden, true);
  assert.equal(header.contains(button), true);
  assert.equal(button.getAttribute("aria-label"), "退出完整视图");
  assert.equal(button.getAttribute("aria-pressed"), "true");
  button.click();
  assert.equal(bar.hidden, false);
  assert.equal(header.querySelector('[data-codey-chat-maximize]'), button);
  assert.equal(native.parentElement, runtime.document.body);
  assert.equal(summary.parentElement, header);
  const replacement = new FakeElement("div", { "data-app-shell-main-titlebar": "true" });
  header.remove();
  runtime.document.body.appendChild(replacement);
  runtime.sync();
  assert.equal(replacement.querySelectorAll('[data-codey-chat-maximize]').length, 1);
  runtime.window.__codeySessionToolsInstall.dispose();
  assert.equal(replacement.querySelector('[data-codey-chat-maximize]'), null);
  assert.equal(native.parentElement, runtime.document.body);
});

test("overflowing tabs map wheel movement horizontally without capturing zoom or fitting lists", () => {
  const runtime = tabsFixture();
  runtime.sync();
  const list = runtime.main.querySelector("[data-codey-tab-list]");
  list.clientWidth = 200;
  list.scrollWidth = 600;
  list.scrollLeft = 100;
  let prevented = 0;
  const wheel = (options) => list.dispatchEvent({ type: "wheel", deltaX: 0, deltaY: 40, deltaMode: 0,
    preventDefault() { prevented += 1; }, ...options });
  wheel({});
  assert.equal(list.scrollLeft, 140);
  wheel({ deltaY: -2, deltaMode: 1 });
  assert.equal(list.scrollLeft, 108);
  wheel({ deltaX: -20, deltaY: 2 });
  assert.equal(list.scrollLeft, 88);
  wheel({ ctrlKey: true });
  list.scrollWidth = list.clientWidth;
  wheel({});
  assert.equal(list.scrollLeft, 88);
  assert.equal(prevented, 3);
});

for (const idle of [true, false]) {
  test(`dispose cancels the initial ${idle ? "idle callback" : "timeout"} and stale callbacks stay inert`, () => {
    const runtime = fixture({ idle });
    runtime.load();
    const initial = idle ? [...runtime.idleCallbacks.values()][0] : [...runtime.timeouts.values()][0].callback;
    const observer = runtime.observers[0];
    const install = runtime.window.__codeySessionToolsInstall;
    install.dispose();
    install.dispose();
    const queries = runtime.queries();
    initial();
    observer.callback([]);
    assert.equal(runtime.queries(), queries);
    assert.equal(runtime.timeouts.size + runtime.idleCallbacks.size + runtime.intervals.size, 0);
    assert.equal(observer.connected, false);
    runtime.load();
    assert.notEqual(runtime.window.__codeySessionToolsInstall, install);
    install.dispose();
    assert.equal(runtime.window.__codeySessionToolsInjectLoaded, true);
  });
}

test("failed installation releases registered resources and can be loaded again", () => {
  const runtime = fixture();
  const original = runtime.window.setInterval;
  let count = 0;
  runtime.window.setInterval = (callback) => {
    if (++count === 2) throw new Error("injected interval failure");
    runtime.document.dispatchEvent({ type: "pointerdown" });
    return original(callback);
  };
  assert.throws(runtime.load, /injected interval failure/);
  assert.equal(runtime.timeouts.size + runtime.intervals.size, 0);
  assert.equal(runtime.observers[0].connected, false);
  assert.equal([...runtime.document.listeners.values()].flat().length, 0);
  assert.equal([...runtime.window.listeners.values()].flat().length, 0);
  runtime.window.setInterval = original;
  runtime.load();
  assert.equal(runtime.window.__codeySessionToolsInjectLoaded, true);
  assert.equal(runtime.intervals.size, 2);
});

test("dispose cancels scan, watcher, sidebar tooltip and running recheck timers", () => {
  const runtime = fixture();
  const { row, spinner } = thread(runtime.document, "thread-1", true);
  runtime.load();
  runtime.window.__codeyInstallThreadUpdatedTimes(row);
  spinner.remove();
  runtime.window.__codeyInstallThreadUpdatedTimes(row);
  runtime.document.dispatchEvent({ type: "pointerdown" });
  runtime.observers[0].callback([{ type: "attributes", attributeName: "aria-label", target: row }]);

  const archive = new FakeElement("button", { "aria-label": "归档任务" });
  row.appendChild(archive);
  runtime.window.__codeyInstallSessionDeleteButtons(row);
  const button = row.querySelector("[data-codey-session-delete]");
  assert.ok(button);
  button.dispatchEvent({ type: "mouseenter" });
  const delays = [...runtime.timeouts.values()].map(({ delay }) => delay);
  for (const delay of [40, 60, 400, 2_000, 30_000]) assert.ok(delays.includes(delay), `missing ${delay} timer`);
  const callbacks = [...runtime.timeouts.values()].map(({ callback }) => callback);
  runtime.window.__codeySessionToolsInstall.dispose();
  const queries = runtime.queries();
  callbacks.forEach((callback) => callback());
  button.dispatchEvent({ type: "mouseenter" });
  assert.equal(runtime.timeouts.size, 0);
  assert.equal(runtime.queries(), queries);
});

for (const wrapped of [false, true]) test(`session actions stay inside native rail with wrapped archive=${wrapped}`, () => {
  const runtime = fixture();
  const { row } = thread(runtime.document, "thread-1");
  const title = row.children[0];
  const hover = new FakeElement("div", { class: "contents" });
  const rail = new FakeElement("div", { class: "absolute flex" });
  const pin = new FakeElement("button", { "aria-label": "置顶聊天" });
  const archive = new FakeElement("button", { "aria-label": "归档聊天" });
  rail.appendChild(pin);
  if (wrapped) {
    const wrapper = new FakeElement("span", { class: "contents" });
    wrapper.appendChild(archive);
    rail.appendChild(wrapper);
  } else rail.appendChild(archive);
  hover.appendChild(rail);
  row.appendChild(hover);
  // 模拟旧脚本把导出按钮错放在原生操作栏外，重装应迁移而不是复制。
  const retainedExport = new FakeElement("button", { "data-codey-session-export": "true" });
  hover.appendChild(retainedExport);
  runtime.load();
  runtime.window.__codeyInstallSessionDeleteButtons(row);
  runtime.window.__codeyInstallSessionDeleteButtons(row);
  assert.equal(retainedExport.parentElement, rail);
  assert.equal(row.querySelector("[data-codey-session-delete]").parentElement, rail);
  assert.equal(row.querySelectorAll("[data-codey-session-delete]").length, 1);
  assert.equal(row.querySelectorAll("[data-codey-session-action-row]").length, 1);
  assert.equal(rail.getAttribute("data-codey-session-action-row"), "true");
  assert.equal(title.getAttribute("data-codey-session-title-row"), "true");
  assert.equal(pin.parentElement, rail);
  assert.equal(archive.parentElement, wrapped ? rail.children[2] : rail);
  assert.equal(rail.parentElement, hover, "native positioning wrapper is not moved");
});

test("retained action buttons use the current tooltip installation after reload", () => {
  const runtime = fixture();
  const { row } = thread(runtime.document, "thread-1");
  row.appendChild(new FakeElement("button", { "aria-label": "归档任务" }));
  runtime.load();
  runtime.window.__codeyInstallSessionDeleteButtons(row);
  const button = row.querySelector("[data-codey-session-delete]");
  const oldToast = runtime.window.__codeyShowRuntimeToast;
  runtime.window.__codeySessionToolsInstall.dispose();
  runtime.load();
  runtime.window.__codeyInstallSessionDeleteButtons(row);
  assert.equal(row.querySelector("[data-codey-session-delete]"), button);
  button.dispatchEvent({ type: "mouseenter" });
  runtime.runTimeout(400);
  assert.equal(button.getAttribute("aria-describedby"), "codey-sidebar-action-tooltip");
  button.dispatchEvent({ type: "mouseleave" });
  assert.equal(button.getAttribute("aria-describedby"), null);
  assert.equal(runtime.document.getElementById("codey-sidebar-action-tooltip"), null);
  // Previously started user operations can still report their final result.
  oldToast("operation finished");
  assert.equal(runtime.document.getElementById("codey-runtime-toast").textContent, "operation finished");
});

test("retained delete button opens native confirmation once per click after repeated reloads", async () => {
  const runtime = fixture();
  const { row } = thread(runtime.document, "thread-1");
  row.appendChild(new FakeElement("button", { "aria-label": "归档任务" }));
  let confirmations = 0;
  row.__reactFiber$test = { memoizedProps: { getItems: async () => [
    { id: "delete-thread", onSelect: () => { confirmations += 1; } },
  ] } };
  runtime.load();
  runtime.window.__codeyInstallSessionDeleteButtons(row);
  const button = row.querySelector("[data-codey-session-delete]");
  for (let index = 0; index < 3; index += 1) {
    runtime.window.__codeySessionToolsInstall.dispose();
    runtime.load();
    runtime.window.__codeyInstallSessionDeleteButtons(row);
    assert.equal(row.querySelectorAll("[data-codey-session-delete]").length, 1);
    assert.equal(row.querySelector("[data-codey-session-delete]"), button);
    const click = () => button.dispatchEvent({ type: "click", preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
    click();
    click();
    await settle();
    assert.equal(confirmations, index + 1);
    assert.equal(button.disabled, false);
  }
  assert.equal(runtime.calls.length, 0, "only the native confirmation is opened");
});

test("a listener registration failure releases the listeners already installed", () => {
  const runtime = fixture();
  const register = runtime.document.addEventListener.bind(runtime.document);
  runtime.document.addEventListener = (type, ...args) => {
    if (type === "pointerdown") throw new Error("injected listener failure");
    register(type, ...args);
  };
  assert.throws(runtime.load, /injected listener failure/);
  assert.equal([...runtime.document.listeners.values()].flat().length, 0);
  assert.equal(runtime.observers[0].connected, false);
});

test("a dispatcher inspection failure unsubscribes the installed mutation handler", () => {
  const runtime = fixture();
  let subscriptions = 0;
  runtime.window.__codeyMutationDispatcher = {
    subscribe() {
      subscriptions += 1;
      return () => { subscriptions -= 1; };
    },
    snapshot() { throw new Error("injected dispatcher failure"); },
  };
  assert.throws(runtime.load, /injected dispatcher failure/);
  assert.equal(subscriptions, 0);
});

test("the sidebar timestamp fetch passes a bounded bridge timeout", async () => {
  const runtime = fixture();
  const { row } = thread(runtime.document, "thread-1");
  runtime.load();
  runtime.window.__codeyInstallThreadUpdatedTimes(row);
  runtime.runTimeout(40);
  const call = runtime.calls.find(({ path }) => path === "/session/timestamps");
  assert.ok(call);
  assert.ok(
    Number.isFinite(call.options?.timeoutMs) && call.options.timeoutMs > 0,
    "a lost bridge response must not freeze timestamp refreshes",
  );
  await settle();
});

test("an old timestamp response neither updates rows nor schedules the queued batch after reload", async () => {
  let complete;
  const runtime = fixture({ bridge: (path) => path === "/session/timestamps"
    ? new Promise((resolve) => { complete = resolve; }) : Promise.resolve({ status: "ok" }) });
  const first = thread(runtime.document, "thread-1");
  runtime.load();
  runtime.window.__codeyInstallThreadUpdatedTimes(first.row);
  runtime.runTimeout(40);
  const second = thread(runtime.document, "thread-2");
  runtime.window.__codeyInstallThreadUpdatedTimes(second.row);
  runtime.window.__codeySessionToolsInstall.dispose();
  runtime.load();
  complete({ status: "ok", timestamps: { "thread-1": Date.now() } });
  await settle();
  assert.equal(first.row.querySelector("[data-codey-thread-updated-at]"), null);
  assert.equal(runtime.timeouts.size, 0);
  assert.equal(runtime.calls.filter(({ path }) => path === "/session/timestamps").length, 1);
});

test("disposal preserves native wait settlement and prevents a subsequent reconciliation", async () => {
  let reconcileCalls = 0;
  const controller = {
    kind: "manager",
    discardConversation() {},
    notifyConversationDeleted() {},
    resumeConversation() {},
    refreshRecentConversations() {},
    reconcileCompletedConversation() {
      reconcileCalls += 1;
      return new Promise(() => {});
    },
  };
  const runtime = fixture({ controller });
  runtime.load();
  const active = new FakeElement("div", { "data-session-id": "thread-1" });
  runtime.document.body.appendChild(active);
  const result = runtime.window.__codeyReconcileStaleCompletedTask();
  await settle();
  assert.equal(reconcileCalls, 1);
  runtime.window.__codeySessionToolsInstall.dispose();
  active.setAttribute("data-session-id", "thread-2");
  runtime.runTimeout(5_000);
  assert.equal(await result, false);
  assert.equal(reconcileCalls, 1);
  assert.equal(runtime.timeouts.size, 0);
});
