# 项目经验

## 2026-11-06 - Store 更新路径恢复与 CLI 误识别

Scope: project
Status: active
Source: agent-suggested
Related: ../../INTERNAL_DEVELOPMENT.md

Summary:
Windows Store 升级后先从当前用户注册包刷新旧版本路径，自动扫描中的 CLI 目录不能阻断有效桌面客户端的识别。

Details:
- 检索词：app_paths、ensure_windows_codex_app_path、OpenAI.Codex、CLI bin、Store 旧路径。
- 适用范围：codexy 的 Windows 桌面客户端发现与启动检查。
- 症状：保存的 Store 版本目录已不存在时要求手选；常见安装目录中的 Codex CLI 缺少桌面元数据，导致自动发现提前失败。
- 根因与证据：启发式目录与系统注册安装原先均按必需候选校验；真实 Windows 用例中 CLI 的 bin 目录使默认解析失败。
- 解决步骤：启动检查复用 launcher 的安装解析器，在判断旧目录存在前刷新同渠道 Store 注册路径；将常见目录候选设为可选，仍严格验证系统注册与显式选择的安装，多个有效桌面候选仍要求手选。
- 验证：`cargo test --release --offline --config profile.release.lto=false -p codey-runtime-core --lib app_paths::tests -- --test-threads=1`，52 项通过；编译后的后端测试程序执行 `installed_store_codex_recovers_and_saves_a_removed_version_path --ignored --nocapture` 通过，确认真实注册路径恢复、保存和重复检查幂等。
- 复用边界：真实路径用例使用临时配置，不等同于安装后桌面启动验收；不允许借自动发现切换到其他 Store 渠道或忽略损坏的显式安装。

## 2026-11-06 - 启动代理不应以远端连通作为初始化条件

Scope: project
Status: active
Source: agent-suggested
Related: ../../INTERNAL_DEVELOPMENT.md

Summary:
代理初始化只准备本地转发能力，远端连接延迟到实际请求，使用户能进入控制台修正不可达的代理。

Details:
- 检索词：LaunchProxyPlan、launch_proxy_relay、代理改错无法启动、upstream preflight。
- 适用范围：Codex 启动代理，不改变模型线路代理的选择规则。
- 根因与证据：启动流程原先等待代理上游探活，错误地址使启动提前失败，用户难以进入设置修正。
- 解决步骤：直连代理计划直接初始化；认证中继只建立回环监听，按实际请求连接上游；保留地址和凭据校验、连接超时、失败响应及回环直连规则。
- 验证：后端回归中不可达 HTTP/SOCKS 代理启动、请求失败响应与监听复用用例通过；实际请求的测试期限包含上游连接超时，避免 Windows 拒绝连接时序造成误报。
- 复用边界：代理不可达时联网仍会失败，修改代理需重启 Codex；本地中继不是网络连通性保证，也不能无声回退到直连。
