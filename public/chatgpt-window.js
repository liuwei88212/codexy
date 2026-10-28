(() => {
  if (location.protocol !== "app:" || location.host !== "-" || location.pathname !== "/index.html") return;
  if (globalThis.__codeyChatgptWindowInstalled) return;
  globalThis.__codeyChatgptWindowInstalled = true;

  // 使用原生允许的新窗口路由；独立标记供主页面注入筛选识别。
  const route = "/plugins/codey-chatgpt-window";
  const initialRoute = new URL(location.href).searchParams.get("initialRoute") || "/";
  const target = new URL(initialRoute, "https://chatgpt.com");
  const dedicated = target.pathname === route;
  const validAccount = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  let observer;
  let timer;

  function mountChatgpt() {
    const accountId = target.searchParams.get("accountId");
    const host = document.createElement("section");
    host.id = "codey-chatgpt-window";
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#fff;color:#222;display:flex;flex-direction:column;font:14px system-ui";
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;align-items:center;gap:16px;padding:8px 16px";
    const status = document.createElement("span");
    status.setAttribute("role", "status");
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "重新加载";
    bar.append(status, retry);
    host.append(bar);
    document.body.append(host);
    document.title = "ChatGPT";
    if (!validAccount(accountId)) {
      status.textContent = "无法取得当前登录账号，请从 Codex 窗口重新打开。";
      retry.disabled = true;
      return;
    }
    let view;
    const load = () => {
      clearTimeout(timer);
      view?.remove();
      status.textContent = "正在使用当前客户端登录 ChatGPT…";
      view = document.createElement("webview");
      const currentView = view;
      view.style.cssText = "display:flex;flex:1;min-height:0";
      // 只传账号标识，由原生主进程完成授权；每个窗口独立分区，关闭不影响 Codex。
      view.setAttribute("partition", "codex-first-party-plugin-authenticated-chatgpt-codey-" + crypto.randomUUID());
      const bootstrap = new URL("about:blank");
      bootstrap.searchParams.set("accountId", accountId);
      bootstrap.searchParams.set("toUrl", "https://chatgpt.com/");
      view.setAttribute("src", bootstrap.href);
      view.addEventListener("did-stop-loading", () => {
        if (view === currentView && currentView.getURL().startsWith("https://chatgpt.com/")) {
          clearTimeout(timer);
          status.textContent = "ChatGPT";
        }
      });
      view.addEventListener("did-fail-load", (event) => {
        if (view !== currentView || event.errorCode === -3) return;
        clearTimeout(timer);
        status.textContent = "ChatGPT 加载失败，请重新加载（" + event.errorCode + "）。";
      });
      timer = setTimeout(() => {
        status.textContent = "ChatGPT 加载较慢；若页面未显示，请重新加载或检查网络。";
      }, 45000);
      host.append(view);
    };
    retry.addEventListener("click", load);
    load();
  }

  function mountEntry() {
    const settings = document.getElementById("codey-settings-button");
    if (!settings) return;
    let button = document.getElementById("codey-chatgpt-window-button");
    if (!button) {
      button = document.createElement("button");
      button.id = "codey-chatgpt-window-button";
      button.type = "button";
      button.textContent = "GPT";
      button.title = "打开 ChatGPT 独立窗口";
      button.setAttribute("aria-label", button.title);
      button.style.cssText = "flex:none;width:36px;height:36px;border:0;border-radius:12px;background:transparent;color:inherit;cursor:pointer;font:600 10px system-ui;-webkit-app-region:no-drag";
      button.addEventListener("click", async () => {
        if (button.disabled) return;
        button.disabled = true;
        try {
          const pricing = Array.from(document.querySelectorAll("webview")).find((view) =>
            (view.getAttribute("partition") || "").startsWith("codex-pricing-"));
          const accountId = pricing && new URL(pricing.getAttribute("src")).searchParams.get("accountId");
          if (!validAccount(accountId)) throw new Error("无法取得当前登录账号，请确认客户端已登录 ChatGPT。");
          if (typeof globalThis.electronBridge?.sendMessageFromView !== "function") throw new Error("当前客户端不支持独立窗口。");
          await globalThis.electronBridge.sendMessageFromView({
            type: "open-in-new-window",
            path: route + "?accountId=" + encodeURIComponent(accountId),
          });
          button.title = "打开 ChatGPT 独立窗口";
        } catch (error) {
          button.title = error.message || "ChatGPT 窗口打开失败";
          globalThis.alert(button.title);
        } finally {
          button.disabled = false;
        }
      });
    }
    if (settings.nextElementSibling !== button) settings.insertAdjacentElement("afterend", button);
  }

  function start() {
    if (dedicated) {
      mountChatgpt();
    } else if (!["/avatar-overlay", "/detached-window", "/hotkey-window", "/spotlight"].includes(target.pathname)) {
      mountEntry();
      observer = new MutationObserver(mountEntry);
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
  addEventListener("pagehide", () => {
    observer?.disconnect();
    clearTimeout(timer);
  }, { once: true });
})();
