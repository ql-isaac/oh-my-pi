# omp Web UI 设计与实现方案

## 一、整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                        浏览器                                 │
│  React SPA (main.js + main.css + styles.css)                 │
│  ┌──────────────────────────────────────┐                    │
│  │  collab-web 复用的组件和样式            │                    │
│  │  Transcript, HeaderBar, Composer,     │                    │
│  │  Banners, tokens.css, base.css,       │                    │
│  │  transcript.css, shell.css,           │                    │
│  │  tool-render.css                      │                    │
│  ├──────────────────────────────────────┤                    │
│  │  自研组件                              │                    │
│  │  App.tsx, useAgent.ts,                │                    │
│  │  SessionPicker.tsx,                   │                    │
│  │  collab-bridge.ts, styles.css         │                    │
│  └──────────────────────────────────────┘                    │
│         │ WebSocket │ REST API                               │
└─────────┼───────────┼───────────────────────────────────────┘
          │           │
┌─────────▼───────────▼───────────────────────────────────────┐
│               omp --mode web (Bun.serve)                     │
│  ┌──────────────────────────────────────┐                    │
│  │  静态文件服务                          │                    │
│  │  index.html / main.js / main.css     │                    │
│  │  styles.css                          │                    │
│  ├──────────────────────────────────────┤                    │
│  │  REST API                            │                    │
│  │  /api/health      — 健康检查           │                    │
│  │  /api/sessions    — 会话列表 + 删除     │                    │
│  ├──────────────────────────────────────┤                    │
│  │  CollabHost                          │                    │
│  │  ┌─ session.subscribe() 直接订阅      │                    │
│  │  ├─ sessionManager.onSessionName-    │                    │
│  │  │   Changed()                      │                    │
│  │  ├─ HostFrame 序列化 + 广播           │                    │
│  │  └─ generateSessionTitle()           │                    │
│  └──────────────────────────────────────┘                    │
│         │ AgentSession (同一进程，非子进程)                     │
└─────────┼────────────────────────────────────────────────────┘
          │
┌─────────▼────────────────────────────────────────────────────┐
│          packages/coding-agent/src/session/                   │
│          AgentSession (会话生命周期 + 引擎)                     │
│          SessionManager (持久化 + 切换/新建)                   │
└──────────────────────────────────────────────────────────────┘
```

**数据流向**：浏览器 ←WebSocket (HostFrame)→ CollabHost ←subscribe()→ AgentSession（同一进程内直接调用，非 RPC 子进程）

## 二、架构决策

### 2.1 直接订阅 vs RPC 子进程桥接

初版使用了 `omp --mode rpc` 子进程方案：Bun.serve spawn `omp --mode rpc`，通过 stdin/stdout JSONL 双向通信，Bridge 层做 WebSocket ↔ JSONL 转换。该方案被废弃，原因：

1. **事件顺序问题**：子进程 stdout 是异步管道，JSONL 行到达顺序可能错位。例如 `tool_execution_start` 在 `message_end` 之后才到达，导致流式 ghost 已完成但工具卡还没收到 start 事件。
2. **无谓的序列化开销**：AgentEvent → JSON string → stdin pipe → JSON parse → HostFrame，全都在本机内完成。
3. **子进程生命周期管理**：重启、退避、崩溃恢复等额外复杂度。

当前方案：CollabHost 直接持有 `AgentSession`，通过 `session.subscribe()` 接收事件，在同一进程中完成 HostFrame 构造和 WebSocket 广播。事件源头到终端的延迟为零。

### 2.2 HostFrame 协议

复用 collab-web 的 wire 协议（`packages/wire/src/index.ts`），不做任何修改：

| 方向 | 帧类型 | 用途 |
|------|-------|------|
| 服务端→客户端 | `welcome` | 会话快照（header + state + entryCount） |
| 服务端→客户端 | `snapshot-chunk` | 分批传输历史消息（每批 50 条，最后一个 `final:true`） |
| 服务端→客户端 | `event` | Agent 事件（message_start/end, tool_execution, agent_start/end 等） |
| 服务端→客户端 | `entry` | 单条消息固化为 SessionEntry（message_end 触发） |
| 服务端→客户端 | `state` | 会话状态更新（isStreaming, sessionName 等） |
| 客户端→服务端 | `prompt` | 用户发送消息 |
| 客户端→服务端 | `abort` | 中止当前 Agent |

**Web mode 扩展帧**（不走共享协议，在 `web-mode.ts` 的 WS handler 中直接处理）：

| 方向 | 帧类型 | 用途 |
|------|-------|------|
| 客户端→服务端 | `resume { path }` | 切换到指定历史会话（调 `session.switchSession(path)`） |
| 客户端→服务端 | `new` | 新建会话（调 `session.newSession()`） |
| 服务端→客户端 | `reset` | 通知前端清空本地状态，随后将收到新的 welcome+snapshot-chunk |

## 三、启动流程

```
用户执行: omp --mode web
    ↓
main.ts 解析参数 → 创建 AgentSession → 分发到 runWebMode()
    ↓
┌─────────────────────────────────────┐
│ 1. collectEntries(session)          │  从 session.messages 构建历史条目
│ 2. new CollabHost(session, {cwd})   │  持有 session，注册订阅，注册标题监听
│ 3. collabHost.start()               │  开始事件广播
│ 4. Bun.serve({ port: 3000 })        │  HTTP + WebSocket
│    ├── GET  /api/health             │  健康检查
│    ├── GET  /api/sessions           │  会话列表 (local + all)
│    ├── POST /api/sessions/delete    │  删除会话
│    ├── GET  /ws → WebSocket upgrade │  注册 client，不发 welcome
│    ├── GET  /main.js, /styles.css   │  静态文件
│    └── GET  /* → index.html (SPA)   │  SPA 回退
└─────────────────────────────────────┘
    ↓
浏览器打开 http://127.0.0.1:3000
    ↓
加载 index.html → main.js (React SPA)
    ↓
React 挂载 → useAgent hook 启动 → WebSocket 连接到 /ws
    ↓
ws.onopen → phase = "selecting" → 拉取 /api/sessions → 渲染 SessionPicker
    ↓
用户选择会话或点击 "new session" → 客户端发送 { t: "resume", path } 或 { t: "new" }
    ↓
服务端 switchSession / newSession → 给所有 client 发 reset + snapshot-chunk + welcome
    ↓
客户端收到 welcome → phase = "live" → 渲染 Transcript + Composer
```

## 四、前端组件架构

### 4.1 组件层次

```
main.tsx (入口)
  ├── 导入 collab-web CSS (tokens.css, base.css, …)
  ├── 导入 styles.css (布局覆盖 + picker 样式)
  └── 渲染 App
       │
       App.tsx (主应用)
       ├── 调用 useAgent() hook
       ├── 连接屏 (phase === "connecting" / "ended")
       ├── 会话选择器 (phase === "selecting")
       │    └── <SessionPicker>
       │         ├── 会话列表 (本地优先 → 跨项目分组)
       │         ├── 状态徽章 (complete/aborted/interrupted 等)
       │         ├── 删除按钮 → inline confirm → API delete
       │         └── new session / refresh 操作
       └── 主界面 (phase === "live")
            ├── <HeaderBar> (collab-web 组件)
            ├── <Transcript> (collab-web 组件)
            │    ├── entries: 已完成的消息列表
            │    ├── stream: 流式生成中的 ghost 消息
            │    └── tailTools: 运行中的工具卡片
            ├── <Composer> (collab-web 组件)
            │    └── 输入框 + 发送/中止按钮
            └── <Banners> (collab-web 组件)
                 └── 连接中/重连中/结束提示
```

### 4.2 复用关系

| 来源 | 组件/文件 | 用途 |
|---|---|---|
| `@oh-my-pi/collab-web` | `Transcript` | 消息转录（思考块、Markdown、工具卡片） |
| `@oh-my-pi/collab-web` | `HeaderBar` | 会话标题栏（模型/上下文/状态/离开） |
| `@oh-my-pi/collab-web` | `Composer` | 输入框（发送/中止/扩展 UI） |
| `@oh-my-pi/collab-web` | `Banners` | 连接状态横幅 |
| `@oh-my-pi/collab-web` | `tokens.css` | 设计色板（深紫+粉红 accent） |
| `@oh-my-pi/collab-web` | `base.css` | 全局 reset + 滚动条 |
| `@oh-my-pi/collab-web` | `transcript.css` | 转录行模型（`tr-*`） |
| `@oh-my-pi/collab-web` | `shell.css` | 外壳布局（`sh-*`） |
| `@oh-my-pi/collab-web` | `tool-render.css` | 工具卡片（`tv-*`） |
| 自研 | `App.tsx` | 三态路由（连接/选择/会话） |
| 自研 | `useAgent.ts` | WebSocket ↔ 状态管理 hook |
| 自研 | `SessionPicker.tsx` | 会话选择+删除界面 |
| 自研 | `collab-bridge.ts` | 数据格式适配（useAgentReturn → GuestSnapshot） |
| 自研 | `styles.css` | 布局覆盖 + picker 样式 |

## 五、核心模块详解

### 5.1 useAgent.ts — WebSocket 状态管理

**状态机**：

```
connecting → selecting → live → (selecting) → (live) → ... → ended
                  ↑                      │
                  └── reset 帧触发 ──────┘
```

**状态字段**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `phase` | `ConnectionPhase` | 连接/选择/会话中/重连/结束 |
| `entries` | `SessionEntry[]` | 已完成的消息条目（历史 + 实时固化） |
| `stream` | `AssistantMessage \| null` | 当前流式生成中的 ghost 消息 |
| `streamDone` | `boolean` | ghost 是否已完成（message_end 已到） |
| `activeTools` | `Map<string, ActiveTool>` | 运行中的工具（用于工具卡状态） |
| `working` | `boolean` | Agent 是否正在工作 |
| `state` | `SessionState \| null` | 会话状态（模型/上下文使用率等） |
| `sessionList` | `SessionListPayload \| null` | 会话列表（来自 /api/sessions） |
| `switching` | `boolean` | 是否正在切换会话（picker 禁用写） |

**entries/stream 分离设计**：

- `message_start` (assistant) → 设置 stream ghost
- `message_update` (assistant) → 更新 stream ghost (text_delta / toolCall)
- `message_end` (assistant) → streamDone=true，stream ghost 保留
- `entry` frame 到达 → entries 追加，stream ghost 清除
- `message_start/message_end`（user 和 toolResult）→ `entry` frame 到达时追加到 entries

两者严格分离。Transcript 组件将二者独立渲染，stream ghost 显示在消息列表末尾，entry 固化后 ghost 消失。

**streamDone Ref 模式**：

```typescript
const streamDoneRef = useRef(false);
const [streamDone, setStreamDoneState] = useState(false);

// 每次 setStreamDone 同步更新 ref
const setStreamDone = useCallback((d: boolean) => {
    streamDoneRef.current = d;
    setStreamDoneState(d);
}, []);
```

原因：`ws.onmessage` 闭包构建于 `connect()`（`useCallback([], ...)` 仅执行一次），无法读取最新的 state 值。使用 ref 打破闭包陈旧性。

**React 18 Auto-Batching 下的 welcome 处理**：

切换会话时，服务端在同一个 tick 内连续发送 reset + snapshot-chunk × N + welcome。React 18 将所有 setState 合并为一次 commit。原实现的 `setEntries(prev => prev.length > 0 ? prev : pendingChunks)` 会在 batch 内误读未 commit 的上一个会话的 entries。修复：直接用 ref 中的 pendingChunks 替换，不使用 prev 守卫。

### 5.2 CollabHost — 服务端事件广播

直接持有 `AgentSession` 实例，在进程内完成所有工作。

**事件订阅**：

```typescript
// start() 中注册
this.#unsubSession = this.#session.subscribe((event) => {
    for (const client of this.#clients) {
        sendFrame(client, { t: "event", event });  // 所有事件 → 客户端
    }
    if (event.type === "message_end") {
        const entry = buildEntry(event.message);    // 构造 SessionEntry
        if (entry) for (client) sendFrame(client, { t: "entry", entry });
    }
});
```

**自动标题生成**：

web mode 绕过了 interactive mode 的 `input-controller`（标题自动生成路径），因此需要在 `handlePrompt()` 中自行触发：

```typescript
handlePrompt(text: string): void {
    this.#maybeGenerateTitle(text);  // 调 generateSessionTitle()
    this.#session.prompt(text).catch(() => {});
}
```

标题变更后通过 `sessionManager.onSessionNameChanged()` 监听，广播 `state` frame 让所有 client 的 HeaderBar 实时更新。

**会话切换（resume + new）**：

```typescript
async switchSession(path: string): Promise<boolean> {
    this.#paused = true;                     // 暂停事件广播
    try {
        const ok = await this.#session.switchSession(path);
        if (ok) for (client) this.#sendResetAndWelcome(client);  // reset + 新 transcript
        return ok;
    } finally { this.#paused = false; }
}
```

`#paused` 标志阻止 switchSession 期间（teardown/load/replay）的内部事件泄漏到客户端。`reset` 帧清空前端状态后紧接新的 welcome+snapshot-chunk，客户端端到端用时控制在单个 HTTP round trip 内。

### 5.3 SessionPicker.tsx — 会话选择界面

对标 TUI 的 `omp -r` session picker。

**布局**：
- 卡片容器（border + shadow + radius-lg），标题 "pick a session" + cwd 路径
- 操作栏：new session（primary）、refresh（ghost）
- 会话列表：本地项目优先，跨项目按 cwd 分组，每组显示 project 路径 header
- 每个会话行：title + status 徽章 + msg 数量 + 时间 + × 删除按钮

**状态徽章**：与 TUI 使用相同标签，添加颜色语义：

| TUI Status | Web 徽章 | 意义 |
|---|---|---|
| `complete` | 绿色 `sh-pill-ok` | 会话正常完成 |
| `interrupted` | 黄色 `sh-pill-warn` | 被中断（有未执行的 tool call） |
| `aborted` | 灰色 `sh-pill-muted` | 被用户中止 |
| `error` | 红色 `sh-pill-err` | 出错 |
| `pending` | 黄色 `sh-pill-warn` | 有未回复的用户消息 |
| `unknown` | 灰色 `sh-pill-muted` | 状态无法判定 |

**删除流程**：点击 × → 行内出现确认面板（"delete <title>? [cancel] [delete]"）→ 确认 → POST `/api/sessions/delete` → 成功后列表自动刷新。如果 session 已被其他进程清理（ENOENT），返回成功。

### 5.4 collab-bridge.ts — 数据适配层

薄包装层，将 `useAgentReturn` 转换为 collab-web 的 `GuestSnapshot` 和 `GuestClient`：

```typescript
buildGuestClient(agent) → { sendPrompt, sendAbort, sendUiResponse }
buildSnapshot(agent) → { phase, entries, stream, streamDone, activeTools, working, state, ... }
```

注意 `streamDone` 需与 `stream` 同步传递给 Transcript，否则 ghost 消息末端的停止原因 chip 不会显示。

### 5.5 styles.css — 布局+Picker 样式

**布局约束**：

```css
.sh-content {
    align-items: center;   /* 让 transcript 列在宽屏居中 */
}
.sh-transcript {
    max-width: 880px;      /* 与 Composer 的 sh-composer-inner 同宽，视觉对齐 */
    width: 100%;
}
```

所有 picker 样式使用 collab-web 的设计 token（`--bg-raised`, `--accent`, `--fg-muted`, `--ok`/`--warn`/`--err` 等），不引用不存在的变量。

## 六、构建流程

```
scripts/build-web-client.ts
    ↓
Bun.build({
    entrypoints: ["src/modes/web/client/main.tsx"],
    outdir: "dist/web-client",
    minify: true,
})
    ↓
产出文件:
    dist/web-client/
    ├── index.html    (构建脚本生成，含 theme 初始化 script)
    ├── main.js       (React SPA + collab-web 组件 + 自研组件)
    ├── main.css      (collab-web CSS 自动合并)
    └── styles.css    (复制自 src/)
```

启动命令：

```bash
cd packages/coding-agent
bun run gen:web-client          # 构建前端（首次或修改前端后）
omp --mode web                  # 默认 127.0.0.1:3000
omp --mode web --port 8080      # 自定义端口
omp --mode web --web-open       # 自动打开浏览器
```

## 七、遇到的问题与解决方案

### 7.1 buildEntry 返回 null（entry frame 从未发送）

**现象**：用户和助理消息在 transcript 中完全不显示。

**原因**：`buildEntry(msg)` 内部执行 `const message = msg.message`。但 `msg` 自身就是 message 对象（来自 AgentEvent 的 `event.message`），`.message` 字段不存在，始终返回 null。entry frame 从未发送。之前仅移除了一个 SyntaxError（const id 声明），未发现这个结构 bug。

**修复**：重写 `buildEntry`，直接使用 `in`/`typeof` 收窄 message 对象，不再嵌套读取。

### 7.2 streamDone 陈旧闭包（stream ghost 不消失）

**现象**：助理回复完成后，stream ghost 和 entry 同时显示（重复消息）。

**原因**：`ws.onmessage` 闭包在 `connect()`（`useCallback([], ...)`，仅初始渲染时创建一次）中构建，捕获的 `streamDone` 始终为 `false`。entry handler 中的 `if (streamDone && ...)` 永远跳过。

**修复**：引入 `streamDoneRef`，setter 同步更新 ref 和 state，handler 中读取 `streamDoneRef.current`。

### 7.3 React 18 Auto-Batching 导致 welcome 吞掉 entries

**现象**：切换到有消息的历史会话后，transcript 显示为空。

**原因**：reset 帧和后续的 snapshot-chunks + welcome 在同一 tick 到达。React 18 将所有 setState 合并为一个 commit。`setEntries(prev => prev.length > 0 ? prev : pendingChunks)` 中的 prev 此时还是上一个会话的 entries（> 0），直接 return prev。

**修复**：去掉 prev 守卫，直接用 ref `pendingChunks.current` 的值调用 `setEntries(Object.freeze(queued))`。

### 7.4 右上角标题不自动生成

**现象**：HeaderBar 标题始终显示 "session"。

**原因**：`main.ts` 将 web mode 归入 `PI_NO_TITLE=1` 的协议模式组（与 rpc/acp 并列），禁用了 `input-controller` 的自动标题生成路径。但 web mode 没有外部 host 来生成标题。

**修复**：
1. 从 `PI_NO_TITLE` 条件中移除 `"web"` 模式
2. CollabHost.handlePrompt 中新增 `#maybeGenerateTitle(text)`，调 `generateSessionTitle()` 后 `sessionManager.setSessionName(title, "auto")`
3. 订阅 `sessionManager.onSessionNameChanged()`，标题变化时广播 `state` frame

### 7.5 Transform 未居中

**现象**：进入 live 视图后，transcript 内容未居中显示。

**原因**：styles.css 重写时只设置了 `.sh-main` 的 flex 布局，未给 `.sh-content` 和 `.sh-transcript` 加宽屏居中约束。collab-web 的 `.sh-composer-inner` 已有 `max-width: 880px; margin: 0 auto`，但 transcript 列没有对应的宽度限制。

**修复**：`.sh-content` 设 `align-items: center`，`.sh-transcript` 设 `max-width: 880px; width: 100%`，与 Composer 精确对齐。

### 7.6 路径穿越漏洞（POST /api/sessions/delete）

**现象**：安全审计发现 `/api/sessions/delete` 端点未校验 `path` 参数是否在合法目录内，攻击者可构造 `../etc/passwd` 删除任意文件。

**修复**：解析 `target` 为绝对路径后检查 `path.resolve(target).startsWith(sessionsRoot + path.sep)`，不匹配返回 403。

### 7.7 WebSocket 资源泄漏与会话切换失败死锁

**现象**：
- WebSocket 断开时未从 `CollabHost.#clients` 移除，导致 zombie 对象累积（内存 + CPU 泄漏）
- `switchSession` / `newSession` 失败时未向客户端发送任何帧，`switching=true` 永久锁定 SessionPicker UI
- `void collabHost.switchSession()` 忽略 Promise rejection，可能触发 unhandled rejection 进程崩溃

**修复**：
- 新增 `WeakMap<ServerWebSocket, client>` 注册表，`close` 回调通过它调用 `collabHost.removeClient()`
- 失败路径向客户端发送 HostFrame `{ t: "error", message }`，useAgent 中新增 `case "error"` 处理 `setSwitching(false)` + `setSessionListError()`
- `switchSession` / `newSession` 改为 `.then(...).catch(...)` 链

### 7.8 自动标题跨会话竞态

**现象**：用户在会话 A 发送消息触发异步标题生成后立即切换至会话 B。标题生成完成时 `mgr.getSessionName()` 检查的是会话 B（无名称），于是用会话 A 的首条消息为会话 B 命名。

**修复**：`#maybeGenerateTitle` 在调用 `generateSessionTitle()` 前捕获 `this.#session.sessionId`，then 块中先做 `if (this.#session.sessionId !== sessionId) return` 守门。

### 7.9 Reconnecting 相位缺失与错误帧静默丢弃

**现象**：`ConnectionPhase` 声明了 `"reconnecting"` 但从未设置；HostFrame `error` 帧到达时被 switch 默认分支丢弃。

**修复**：`ws.onerror` 和 `ws.onclose` 均 `setPhase("reconnecting")`；`onmessage` 新增 `case "error"` 分支处理服务端错误。

## 八、文件清单

### 新增文件

```
packages/coding-agent/src/modes/web/
├── web-mode.ts                   服务端入口 (HTTP + WS + collab-host)
├── collab-host.ts                CollabHost 类 (订阅+广播+标题+切换)
└── client/                       前端源码
    ├── index.html                SPA 外壳
    ├── main.tsx                  入口 (CSS 导入)
    ├── App.tsx                   三态路由 (连接/选择/会话)
    ├── useAgent.ts               WebSocket 状态管理 hook
    ├── SessionPicker.tsx          会话选择+删除界面
    ├── collab-bridge.ts          数据格式适配
    └── styles.css                布局覆盖 + picker 样式

packages/coding-agent/scripts/
└── build-web-client.ts           前端构建脚本
```

### 修改的现有文件

| 文件 | 改动 |
|---|---|
| `src/cli/args.ts` | `Mode` 类型添加 `"web"` |
| `src/cli/flag-tables.ts` | `--mode` 解析添加 `"web"` |
| `src/main.ts` | 添加 web 模式分发分支；web 模式从 `PI_NO_TITLE` 移除 |
| `tsconfig.json` | 排除 `client/` 目录（浏览器 JSX） |
| `package.json` | 添加 `gen:web-client` 构建脚本 |
| `packages/collab-web/package.json` | 添加 `exports` 字段，公开 Transcript/Composer/HeaderBar/Banners 等组件和 6 个 CSS 文件 |

## 九、技术要点

1. **零 RPC 桥接**：CollabHost 直接持有 AgentSession，通过 `session.subscribe()` 接收事件，同一进程内完成 HostFrame 构造和 WebSocket 广播。无子进程管理、无序列化开销、无事件顺序问题。

2. **组件复用**：直接使用 collab-web 的 Transcript/HeaderBar/Composer/Banners 组件，不做任何修改。6 个 CSS 文件自动合并，class 命名完全一致（`tr-*` / `sh-*` / `tv-*`）。

3. **会话选择界面**：对标 TUI 的 `omp -r` picker。支持本地+跨项目列表、状态徽章、inline 删除确认（与 TUI 的 "Delete session? Yes/No" 对话一致）。通过 REST API + 自定义 WS frame 交互。

4. **React 18 兼容**：处理了 auto-batching 下的 setEntries 竞争、stale closure 下的 streamDone 读取、reset→welcome 的顺序保证。

5. **自动标题生成**：复用了 TUI 的 `generateSessionTitle()` 路径，在 `handlePrompt()` 中触发，通过 `sessionManager.onSessionNameChanged()` 实时广播 state frame 刷新 HeaderBar。
