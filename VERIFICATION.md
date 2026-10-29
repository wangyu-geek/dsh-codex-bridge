# 验证与复现

## 已验证环境

| 组件 | 版本或快照 |
|---|---|
| 本项目 | 0.1.0 |
| Node.js | v24.22.1 |
| DeepSeek Harness | 0.2.1-rc.3、0.2.2-alpha.2 |
| DSH 源码快照 | 22ddee3792、f3803c9697 |

DSH API 尚未稳定；使用其他版本时，应重新运行集成测试。

## 单元与协议测试

在本项目目录执行：

```sh
pnpm install --ignore-scripts
pnpm test
```

已验证结果：36 项测试全部通过。

覆盖内容：

- HTTP 鉴权、Origin 拒绝、只读模式下的控制操作拒绝。
- 发现目录和凭据文件的权限检查，以及符号链接拒绝。
- 多实例选择、离线状态与会话列表分页。
- 区分运行状态、本轮结束原因和目标验收状态。
- 事件等待、取消传播、子任务状态变化及插件卸载。
- 固定 requestId 的并发请求去重，以及写入结果未知的处理。
- UTF-8 文本截断、输入限额和完整 MCP 输出限额。
- 真实 stdio MCP 握手、工具调用及凭据不进入工具输出。
- 早先创建、最近继续的会话，工作区/标题筛选、日期显示和结果预览。
- 未加载 MCP 时，经已安装 skill 符号链接从其他工作区调用只读 helper。

## 真实 DSH 端到端测试

准备好与上表兼容的 DSH 源码环境后，在本项目目录执行。将占位路径替换为 DSH 源码目录：

```sh
DSH_SOURCE=/absolute/path/to/deepseek-harness node --test tests/real-dsh.integration.js
```

已验证结果：1 项端到端测试通过。

测试链路为：

```text
标准 stdio MCP 客户端
  → 本地 MCP 适配器
  → DSH Web profile 中的 Host 插件
  → 原 AgentLoop
```

测试在临时 DSH_HOME 中启动正常 Web profile，经 Loader 挂载插件和确定性模型，不需要外部模型密钥。它验证：

1. 发现实例并读取会话。
2. 读取冷会话不会恢复 Agent。
3. 通过 MCP 发送指令并读取正常结束的结果。
4. 重用相同 requestId 不会创建重复执行轮。
5. 等待执行中的会话变化，并中断当前轮。
6. 卸载时清理实例发现文件。

测试只使用隔离的临时会话，不依赖已有个人会话、进程号或安装记录。

## 安装后的检查

完成 [README 中的安装步骤](README.md#安装) 后：

1. 重新加载 Codex 的 MCP 配置，确认 `dsh-bridge` 已启用。
2. 调用 `dsh_instances`，确认目标 DSH 实例在线。
3. 调用 `dsh_recent` 按最近活动列出对话及结果；或用 `dsh_sessions` 选择会话，保留返回的 instanceId 和 sessionId。
4. 调用 `dsh_status` 和 `dsh_read`，与 DSH 原界面核对状态及最近结果。
5. 如需验证发送和中断，创建专用测试会话，避免干扰正在执行的任务。

MCP 工具可调用并不代表所有客户端界面均已验证。当前实现提供会话控制接口，不包含 Codex 原生侧栏、新看板、审批代答或手机推送。
