# DSH ↔ Codex 会话中转

把**已经运行的 DeepSeek Harness Web 会话**接入 Codex。DSH 继续执行任务；Codex 通过 MCP 查看事实、发送指令和中断当前轮。

本包同时包含 DSH Host 插件和本地 stdio MCP 服务。它复用原有 DSH runtime 的会话服务，通过稳定的桥接接口提供查询和控制。

## 已实现

| 工具 | 用途 |
|---|---|
| `dsh_recent` | 按最近用户活动列出对话、最新回复及产物，支持工作区和标题筛选 |
| `dsh_instances` | 发现本机实例，区分在线和离线 |
| `dsh_sessions` | 会话标题、目录、活动时间、运行状态、父会话 |
| `dsh_status` | 实时 running/idle、等待审批或回答、子任务、队列、上一轮结束原因 |
| `dsh_read` | 最近一轮或向前分页的消息、最终可见回复、产物路径 |
| `dsh_send` | 用固定 requestId 排队发送或 steer 干预 |
| `dsh_interrupt` | 请求中断当前轮，保留待执行队列 |
| `dsh_wait` | 等待状态/事件变化，最多 45 秒 |

读取会话和历史不会自动恢复冷会话。发送消息可能恢复它。`completed` 表示一轮正常结束；`goalCompletion: not-evaluated` 表示桥接层没有验收用户目标。冷会话的 `running` 是 `null`，不能据此宣称仍在执行或已经成功。

## 安装

要求 Node.js ≥24.9、pnpm，以及可用的 Codex CLI 和 DeepSeek Harness 源码环境。已验证 DSH `0.2.1-rc.3`（`22ddee3792`）和 `0.2.2-alpha.2`（`f3803c9697`）。DSH API 尚未稳定，升级后应重跑集成测试。

克隆本项目并安装依赖，保留项目和 Node 的绝对路径供后续命令使用：

```sh
git clone https://github.com/wangyu-geek/dsh-codex-bridge.git
cd dsh-codex-bridge
pnpm install --ignore-scripts
BRIDGE_DIR="$PWD"
NODE_BIN="$(command -v node)"
```

在同一个终端中切换到 DSH 源码目录，通过官方 profile 插件命令安装。将占位路径替换为自己的 DSH 源码目录：

```sh
cd /absolute/path/to/deepseek-harness
pnpm dsh plugin --profile web add "$BRIDGE_DIR" --ignore-scripts
```

不要手动改 profile 的 package.json 或 cordis.patch.yml。HMR 开启时新插件可以热激活；否则要等原任务结束后重启 DSH。确认实例发现成功才能认为插件已经生效。

将适配器加入 Codex：

```sh
codex mcp add dsh-bridge -- "$NODE_BIN" "$BRIDGE_DIR/bin/mcp.js"
codex mcp get dsh-bridge
```

建议使用 Node 的绝对路径，以免桌面应用的 PATH 与终端不同。新配置在 MCP 重新加载或新会话启动后生效；已经开启的 Codex 会话未必即时获得工具。

安装配套查询 skill，让 Codex 将“最近 DSH 对话与结果”路由到实时桥接接口：

```sh
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
ln -s "$BRIDGE_DIR/skills/dsh-sessions" "${CODEX_HOME:-$HOME/.codex}/skills/dsh-sessions"
```

如果该名称已有其他 skill，先检查已有内容，不要直接覆盖。skill 用符号链接安装；其查询 helper 会沿真实文件路径找到桥接程序。它不把记忆记录或 Codex 自身的聊天列表当成 DSH 实时会话。

部分 Codex 界面尚未加载 MCP 工具时，可以直接使用同一数据源的只读命令。默认输出 Markdown 表格，`--json` 输出完整 ID 和结构化结果：

```sh
node "$BRIDGE_DIR/bin/query.js" recent --limit 5
node "$BRIDGE_DIR/bin/query.js" recent --workspace my-project --json
```

默认从 `$DSH_HOME/bridges/instances` 发现实例；未指定 DSH_HOME 时使用 `~/.dsh/bridges/instances`。可用 `DSH_BRIDGE_DIR` 指定发现目录，或在 DSH 插件 config 中配置 `discoveryDirectory`，二者应一致。

插件的默认代码配置是只读；随包 patch 显式设置 `allowControl: true`，开启发送和中断能力。要设为只读，通过 DSH profile 的受支持配置入口把该行 config 调整为 `allowControl: false`。

## 使用示例

在 Codex 中说：

- “查看 DSH 正在执行哪些会话。”
- “列出 DSH 最近对话和结果，按工作区筛选。”
- “查看‘示例任务’会话的状态和最近结果。”
- “给这个 DSH 会话发送：继续分析，并把新增结论写入文档。”
- “中断这个会话当前这轮执行，然后确认它已经停下来。”

首次操作先调用 `dsh_instances`、`dsh_sessions`，后续使用确定的 `instanceId/sessionId`。多个实例同时在线时适配器拒绝猜测目标。会话列表单页最多 100 项；如 `hasMore` 为 true，把 `nextOffset` 作为下一次的 `offset` 继续读取。列表按活动时间排序，执行期间发生变化时可以重新刷新。

查看最近结果优先使用 `dsh_recent`。它按 DSH 的最后用户活动时间排序，保留早先创建、最近继续的原会话；默认排除子 agent 和空会话。返回查询时间、最近对话时间、回复时间、状态、回复预览和产物。`workspace` 可用目录名或绝对路径，`query` 按标题/工作区筛选，均先筛选再分页。完整回复用 `dsh_read` 读取。

`dsh_send` 要求调用者生成 requestId，例如 UUID；重试同一条指令必须复用同一个 ID。桥接层不自动重试写操作。如果响应丢失，会返回 `WRITE_OUTCOME_UNKNOWN`，应先读状态/历史核对，而非用新 ID 再发一次。

消息输出默认只显示最新一轮，单次最多 40 条消息。文本有 UTF-8 字节上限和明确的 `truncated` 标记；`hasMore/beforeSeq/throughSeq` 支持向前分页。私有 reasoning、模型请求头、工具输入和鉴权字段不会作为结构化元数据导出。会话本身写出的可见文本仍是该会话的数据。

## 安全和生命周期

- 插件只接受 loopback、Bearer 认证的 POST JSON 请求，并拒绝带 Origin 的浏览器请求。
- 发现目录 0700、凭据文件 0600；适配器拒绝符号链接和其他用户可读的凭据。工具输出不会包含桥接 token。
- MCP 的 readOnlyHint 只是提示；真正控制权限在 Host 检查 `allowControl`。
- 插件卸载会撤销路由、结束等待请求、清理自己的实例文件，不会停止 DSH。
- DSH 异常退出可能留下发现文件；`dsh_instances` 会显示为离线，不会伪装成任务完成，也不会自动删除其他实例文件。
- 长等待只监听事件，不轮询 Agent；断开 Codex 不会中断 DSH。

## 测试

```sh
pnpm test
DSH_SOURCE=/absolute/path/to/deepseek-harness node --test tests/real-dsh.integration.js
```

单元及协议测试覆盖认证、只读控制、输出/输入限额、状态区别、等待取消、发现文件安全、多实例选择、未知写结果及真实 stdio MCP 握手。

真实集成测试用临时 DSH_HOME 启动正常 Web profile，通过 Loader 挂载插件和一个本地确定性模型，验证 MCP → 插件 → 原 AgentLoop 的发送、完成、固定 ID 重试、中断、冷读取及卸载。测试无需模型密钥，使用隔离的测试会话。完整验证方法见 [VERIFICATION.md](VERIFICATION.md)。

## 当前边界

这一版交付插件和 MCP，不包含 Codex 原生侧栏接入或新仪表板。审批和提问只展示等待状态，回答仍在 DSH 原界面完成。`interrupt` 不会清空队列或保证所有子任务停止。适配器关闭后不会主动唤醒空闲 Codex，也不提供手机推送。

目前只面向本机 macOS/Linux 的 Web profile；Windows 文件权限和跨主机部署尚未验证。DSH Web 监听地址必须是 loopback。插件使用现有 API，但版本漂移需要重新验证。

## 移除

```sh
codex mcp remove dsh-bridge
# 如已按上文安装 skill，确认它仍是指向本项目的符号链接后移除：
unlink "${CODEX_HOME:-$HOME/.codex}/skills/dsh-sessions"
# 在 DSH 源码目录执行：
pnpm dsh plugin --profile web remove @local/dsh-codex-bridge
```

若当前 profile 没有 HMR，移除配置后仍须在合适时机重启，才能撤销已加载代码。

## 许可证

本项目采用 [MIT License](LICENSE)。
