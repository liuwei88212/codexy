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

## 2026-11-16 - 旧会话保留 Provider，以启动参数切换传输

Scope: project
Status: active
Source: agent-suggested
Related: ../../INTERNAL_DEVELOPMENT.md

Summary:
恢复聊天时保留原 Provider，官方旧聊天用原生支持的 `openai_base_url` 临时接入网关，不能通过覆盖内置 Provider 或只修改数据库解决。

Details:
- 检索词：modelProviderMismatch、Cannot change this thread's model provider、openai、codey_router、openai_base_url、Codey/Codex 切换。
- 适用范围：Windows Codey 与 Codex CLI `0.169.0-alpha.11.1`；当前 Store CLI 与 Codey 缓存副本 SHA256 相同。
- 根因与证据：本机 CLI 实测拒绝 `openai` 到 `codey_router` 的恢复请求，也拒绝 `model_providers.openai` 覆盖；省略恢复参数中的 Provider 可沿用历史身份，`openai_base_url` 可独立改变传输地址。旧测试中不生成内置 Provider 覆盖的断言本身不等于原生行为证据。
- 解决步骤：包装器恢复时移除 Provider 覆盖，启动时临时指定官方传输地址；网关通过带令牌的能力路径鉴权，仅允许模型接口，记录请求前归一化路径，不能借此访问管理接口。页面保留官方旧会话身份，仍按模型别名选择线路；不迁移历史或凭据。
- 验证：`CODEY_TEST_NATIVE_CLI` 与 `CODEY_TEST_BINARY` 指定本机 CLI 和新编译的测试版后，`node --test tests/native-model-restart.test.mjs` 通过；同一聊天在原生→Codey→原生之间保留 ID、Provider，并发送到各自的本地测试端点。`local_router::tests::native_openai_*` 两项 HTTP/WebSocket 鉴权与端点白名单测试通过。原生集成测试使用临时 HOME、假凭据和回环服务；网关鉴权测试不连接外部模型。
- 复用边界：未验证真实账号的桌面收发，也未打包安装；其他版本需重新验证原生协议。返回原生模式只恢复原生传输，不代表不运行 Codey 时还能使用其第三方线路。HTTP 夹具需用 426 明确拒绝 WebSocket，普通 400 会被原生 CLI 当作请求失败而非 HTTP 回退。

## 2026-11-16 - HTTP 上传压缩与结果未知时禁止整轮重发

Scope: project
Status: active
Source: agent-suggested
Related: ../../INTERNAL_DEVELOPMENT.md

Summary:
官方 Codex 的 HTTP 大正文恢复传输压缩；网络结果未知时不在网关外层重复上传整轮上下文。

Details:
- 检索词：上传流量、zstd、Content-Encoding、previous_response_id、upstream_network_retry。
- 适用范围：Codey 本地路由的 HTTP Responses 发送；不改变原生客户端自身的重试策略。
- 根因与证据：入站 zstd 解压后原先直接上传 JSON；HTTP 回退可能恢复完整上下文，外层网络循环还会在响应头前断线后每分钟重发正文。这些路径可能叠加，但未通过 VPN 统计确认实际增长倍数。
- 解决步骤：仅向默认官方 Codex 的 Responses 与 compact 端点压缩大正文，压缩无收益或失败时保留明文，第三方和插件传输不改；使用独立的传输头避免修复重试时编码标记与正文不一致。移除无限外层网络重发，只保留发送层尚未发出请求时的有限建连重试，以及原有有界业务修复；必要的历史展开保留，不能用丢上下文换流量。
- 验证：`cargo test -p codey --lib --offline --no-fail-fast local_router:: -- --test-threads=4`，698 通过、0 失败、7 忽略；覆盖压缩端点白名单、压缩往返、无收益回退、实际 TCP 正文解压一致、上传完成回调，以及上游收完正文后断开时不重发和内存名额释放；原有历史恢复、协议桥接与有限修复测试通过。`git diff --check` 通过。
- 复用边界：未进行真实账号或 VPN 流量验收，也未打包安装；不能向未声明支持请求压缩的第三方盲发 zstd。HTTP 回退仍可能上传完整有效上下文，客户端自己的重试也可能产生额外流量。
