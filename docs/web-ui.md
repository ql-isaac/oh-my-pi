# omp Web UI 设计与实现方案

## 一、整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    浏览器 (多个标签页独立)                          │
│  React SPA (main.js + main.css + styles.css)                     │
│  ┌──────────────────────────────────────────┐                    │
│  │  collab-web 复用: Transcript, HeaderBar, │                    │
│  │  Composer, Banners, 5 个 CSS 文件          │                    │
│  ├──────────────────────────────────────────┤                    │
│  │  自研: App.tsx, useAgent.ts,              │                    │
│  │  SessionPicker.tsx (移动端适配),           │                    │
│  │  collab-bridge.ts, styles.css             │                    │
│  └──────────────────────────────────────────┘                    │
│         │ WebSocket │ REST API                                   │
└─────────┼───────────┼───────────────────────────────────────────┘
          │           │
          │     ┌─────▼─────────────────────────────────────────┐
          │     │  TUI (omp --web-client http://localhost:3000)   │
          │     │  WebGuestLink → EventController → TUI 渲染       │
          │     │  InputController → sendPrompt → WebSocket       │
          │     └─────┬───────────────────────────────────────────┘
          │           │
┌─────────▼───────────▼───────────────────────────────────────────┐
│               omp --mode web (Bun.serve)                         │
│                                                                   │
│  REST API                                                        │
│    /api/health          健康检查                                   │
│    /api/sessions        会话列表 (local + all + cwd)               │
│    /api/sessions/delete 删除会话 (路径穿越防护)                     │
│                                                                   │
│  CollabHost (多 AgentSession 池)                                  │
│    ┌─────────────────────────────────────────────────────┐       │
│    │  #slots: Map<path, { session, unsubEvents, unsubTitle }>│       │
│    │    "path/A.jsonl" → AgentSession A (独立 Agent)      │       │
│    │    "path/B.jsonl" → AgentSession B (独立 Agent)      │       │
│    │  每个槽独立处理 prompt，事件按 sessionPath 过滤广播    │       │
│    └─────────────────────────────────────────────────────┘       │
│  forkSession(path) → SessionManager.open + createAgentSession    │
│                                                                   │
│  WebSocket /ws                                                    │
│    每个连接 = 一个 client，按 sessionPath 独立路由                   │
│  静态文件                                                         │
│    index.html (<base href="/">) / main.js / main.css / styles.css│
│    SPA 回退: /session/<id> → index.html                          │
└──────────────────────────────────────────────────────────────────┘
```

**数据流向**：
- **浏览器/TUI → 服务器**：GuestFrame（prompt/abort/resume/new）经 WebSocket
- **服务器 → 浏览器/TUI**：HostFrame（event/entry/state/welcome/snapshot-chunk/reset）经 WebSocket，按 sessionPath 过滤
- **多客户端协作**：同一 sessionPath 的客户端共享同一个 AgentSession 槽，事件互相可见
- **多客户端独立**：不同 sessionPath 的客户端使用各自的 AgentSession 槽，互不干扰

## 二、架构决策

### 2.1 直接订阅 vs RPC 子进程桥接

初版使用了 `omp --mode rpc` 子进程方案。该方案被废弃，原因：

1. **事件顺序问题**：子进程 stdout 是异步管道，JSONL 行到达顺序可能错位
2. **无谓的序列化开销**：AgentEvent → JSON → pipe → parse → HostFrame
3. **子进程生命周期管理**：重启、退避、崩溃恢复等额外复杂度

当前方案：CollabHost 通过 `forkSession` 为每个会话路径创建独立的 AgentSession，通过 `session.subscribe()` 接收事件。

### 2.2 多 AgentSession 池 vs 单 AgentSession

**问题**：单 AgentSession 只能同时处理一个会话。两个标签页在不同会话上发消息时，`switchSession` 会导致事件归属混乱。

**方案**：CollabHost 维护 `#slots: Map<path, { session, ... }>`，每个不同的会话路径有自己独立的 AgentSession 实例。`forkSession(path)` 工厂通过 `SessionManager.open(path)` + `createAgentSession()` 创建完全独立的会话（包括独立的 Agent 实例）。

**效果**：
- 不同会话的 prompt 完全并发，互不阻塞
- 事件按 `sessionPath` 过滤，只发给同一会话的客户端
- 同一会话的多个客户端（如 TUI + 浏览器）共享同一个槽，事件互相可见（协作模式）

### 2.3 TUI ↔ Web 双向同步

TUI 通过 `omp --web-client <url>` 连接到 Web 服务器，作为 WebSocket 客户端运行。`WebGuestLink` 类复用 `CollabGuestLink` 的模式：

1. 连接 WebSocket，发送 `{t:"resume", path}`
2. 收到 `welcome` + `snapshot-chunk` → 写入副本文件 → `switchSession(replicaPath)` 加载到本地 AgentSession
3. 事件通过 `EventController.handleEvent()` 直接渲染到 TUI
4. 用户输入通过 `InputController` 检查 `ctx.webGuest`，路由到 `webGuest.sendPrompt()` → WebSocket

### 2.4 HostFrame 协议

复用 collab-web 的 wire 协议（`packages/wire/src/index.ts`）：

| 方向 | 帧类型 | 用途 |
|------|-------|------|
| S→C | `welcome` | 会话快照元数据（header + state + entryCount） |
| S→C | `snapshot-chunk` | 分批历史消息（每批 50 条，最后一个 `final:true`） |
| S→C | `event` | Agent 事件（message_start/end, tool_execution, agent_start/end 等） |
| S→C | `entry` | 单条消息固化为 SessionEntry |
| S→C | `state` | 会话状态更新 |
| C→S | `prompt` | 用户发送消息 |
| C→S | `abort` | 中止当前客户端所在会话的 Agent |

**Web mode 扩展帧**：

| 方向 | 帧类型 | 用途 |
|------|-------|------|
| C→S | `resume { path }` | 切换到指定会话（仅对该客户端生效） |
| C→S | `new` | 新建会话（仅对该客户端生效） |
| S→C | `reset` | 通知客户端清空状态，随后收到 snapshot-chunk + welcome |
| S→C | `error { message }` | 错误通知 |

### 2.5 URL 路由

| URL | 行为 |
|-----|------|
| `http://localhost:3000/` | 显示会话选择器 |
| `http://localhost:3000/session/<id>` | 直接打开指定会话（ID 前缀匹配） |

- `index.html` 中 `<base href="/">` 确保子路径下的相对资源引用正确
- 选择会话时 `history.pushState` 更新 URL
- 点击 "leave session" 时 `pushState` 回 `/`
- 浏览器后退按钮触发 `popstate`，回到选择器

## 三、启动流程

### 3.1 Web 服务器

```
omp --mode web
    ↓
main.ts → runWebMode({ forkSession, port, ... })
    ↓
new CollabHost({ cwd, forkSession })
Bun.serve({ port: 3000 })
    ├── GET  /api/health
    ├── GET  /api/sessions
    ├── POST /api/sessions/delete
    ├── GET  /ws → WebSocket upgrade → collabHost.addClient(client)
    ├── GET  /session/<id> → index.html (SPA 回退)
    └── GET  /main.js, /styles.css → 静态文件
```

### 3.2 TUI 客户端

```
omp --web-client http://localhost:3000 --resume <id>
    ↓
main.ts → runInteractiveMode(..., webClient)
    ↓
InteractiveMode.init() → 本地 AgentSession 就绪
    ↓
new WebGuestLink(mode, url)
guest.connect(sessionPath)
    ├── 解析短 ID → fetch /api/sessions → 匹配完整路径
    ├── WebSocket 连接 → 发送 {t:"resume", path}
    ├── 收到 reset → snapshot-chunk → welcome
    ├── 写入副本文件 → switchSession(replicaPath) → 渲染历史
    └── ctx.webGuest = this → InputController 路由 prompt 到 WebSocket
    ↓
TUI 进入正常交互循环（getUserInput → submitInteractiveInput）
    ↓
用户输入 → ctx.webGuest.sendPrompt(text) → WebSocket → 服务器
服务器 → AgentSession.prompt(text) → 事件广播 → TUI + 浏览器同步更新
```

## 四、前端组件架构

### 4.1 组件层次

```
main.tsx (入口)
  ├── 解析 /session/<id> URL → initialSessionId
  ├── 导入 collab-web CSS (5 个文件)
  ├── 导入 styles.css
  └── 渲染 <App initialSessionId={...} />
       │
       App.tsx
       ├── useAgent({ initialSessionId }) hook
       ├── popstate 监听 (后退回到 /)
       ├── 连接屏 (connecting / ended)
       ├── 会话选择器 (selecting) → <SessionPicker>
       │    └── SVG 图标 + 骨架屏 + 移动端适配
       └── 主界面 (live)
            ├── <HeaderBar> onLeave → reconnect + pushState("/")
            ├── <Transcript>
            ├── <Composer>
            └── <Banners>
```

### 4.2 复用关系

| 来源 | 组件/文件 | 用途 |
|---|---|---|
| collab-web | Transcript, HeaderBar, Composer, Banners | 核心交互组件 |
| collab-web | tokens.css, base.css, transcript.css, shell.css, tool-render.css | 设计系统 |
| 自研 | App.tsx | 三态路由 + URL 管理 |
| 自研 | useAgent.ts | WebSocket 状态管理 + initialSessionId 自动解析 |
| 自研 | SessionPicker.tsx | 会话选择（SVG 图标 + 骨架屏 + 移动端响应式） |
| 自研 | collab-bridge.ts | 数据格式适配 |
| 自研 | styles.css | 布局 + picker 样式 + 移动端断点 |

## 五、核心模块详解

### 5.1 CollabHost - 多 AgentSession 池

```typescript
class CollabHost {
    #slots = Map<string, { session: AgentSession; unsubEvents; unsubTitle }>;
    #clientSessions = Map<client, string>;  // client → sessionPath

    // 按客户端切换会话（仅该客户端收到 reset+welcome）
    async switchSessionForClient(client, path) {
        const slot = await this.#getOrCreateSlot(path);
        this.#clientSessions.set(client, path);
        this.#sendResetAndWelcome(client, slot.session);
    }

    // 按客户端路由 prompt（确保加载该客户端的会话后处理）
    async handlePrompt(client, text) {
        const path = this.#clientSessions.get(client);
        const slot = this.#slots.get(path);
        generateTitle(slot.session, text);
        slot.session.prompt(text);  // 独立 AgentSession，并发安全
    }

    // 事件广播：仅发给同一 sessionPath 的客户端
    #installSlot(path, session) {
        session.subscribe((event) => {
            for (const c of this.#clients) {
                if (this.#clientSessions.get(c) !== path) continue;
                sendFrame(c, { t: "event", event });
            }
        });
    }
}
```

**forkSession 工厂**（在 main.ts 中创建）：

```typescript
webOpts.forkSession = async (path) => {
    const mgr = await SessionManager.open(path, sessionDir);
    const { session } = await createSession({
        ...sessionOptions,
        sessionManager: mgr,
        eventBus: new EventBus(),
        preloadedExtensions: extensionsResult,
    });
    return session;
};
```

### 5.2 WebGuestLink - TUI 客户端

```typescript
class WebGuestLink {
    // 连接 + 加载会话快照
    async connect(sessionPath?) {
        await this.#openSocket();
        // 解析短 ID 或自动选择
        this.#send({ t: "resume", path: resolvedPath });
        // 等待 welcome → 写副本文件 → switchSession → 渲染
        await firstWelcome;
        this.#ctx.webGuest = this;
    }

    // 事件 → EventController
    #applyEvent(event) {
        void this.#ctx.eventController.handleEvent(event);
    }

    // Prompt → WebSocket
    sendPrompt(text) { this.#send({ t: "prompt", text }); }
}
```

**帧顺序处理**：服务器发送顺序是 `snapshot-chunk` → `welcome`。WebGuestLink 的 `#handleFrame` 需要处理两种到达顺序：

- `snapshot-chunk` 先到：累积 entries，仅在 `frame.final && #pendingHeader` 时完成
- `welcome` 先到：设置 header/state/entryCount，在 entries 已满时完成
- 两者都到达后才调用 `#finalizeSnapshot()` → `#welcomed = true`

### 5.3 SessionPicker - 移动端适配

**响应式断点**：

| 断点 | 效果 |
|------|------|
| `≤640px` | 卡片 padding 收窄，列表全展开 |
| `≤480px` | 卡片全屏（无圆角无边框），行高 48px，确认框垂直堆叠，safe-area-inset |
| `≤360px` | refresh 按钮隐藏文字仅留图标 |

**触控目标**：所有可交互元素 ≥ 44px（WCAG/Apple 标准），删除按钮在触摸设备始终可见。

**SVG 图标**：Lucide 风格 stroke-based 图标替换原文本符号（trash/plus/refresh/inbox）。

**骨架屏**：加载中显示 5 行 shimmer 动画占位条。

### 5.4 useAgent.ts - initialSessionId 自动解析

```typescript
useAgent({ initialSessionId }) {
    // ...
    useEffect(() => {
        if (!initialId || resolved || phase !== "selecting") return;
        const match = sessionList?.local.find(s => s.id.startsWith(initialId))
                   ?? sessionList?.all.find(s => s.id.startsWith(initialId));
        if (match) { setResolved(true); selectSession(match.path); }
    }, [initialId, phase, sessionList, ...]);
}
```

## 六、构建与启动

```bash
cd packages/coding-agent
bun run gen:web-client          # 构建前端
bun run check:types             # 类型检查 (tsgo --noEmit)

# Web 服务器
omp --mode web                  # 默认 127.0.0.1:3000
omp --mode web --port 8080      # 自定义端口
omp --mode web --web-open       # 自动打开浏览器

# TUI 客户端（连接到 Web 服务器）
omp --web-client http://localhost:3000
omp --web-client http://localhost:3000 --resume <会话ID>
omp --web-client http://localhost:3000 --resume /path/to/session.jsonl
```

## 七、遇到的问题与解决方案

### 7.1 多会话事件串话

**现象**：浏览器标签页 A 在会话 X 上，标签页 B 在会话 Y 上。A 发消息，事件出现在 B 的 transcript 中。

**原因**：单 AgentSession 的 `switchSession` 会改变全局会话状态，事件广播无差别发送给所有客户端。

**修复**：
1. 多 AgentSession 池：每个 sessionPath 有独立的 AgentSession
2. 按客户端跟踪会话：`#clientSessions` map
3. 事件按 sessionPath 过滤：只发给同一会话的客户端
4. Prompt 按客户端路由：`handlePrompt(client, text)` 使用客户端的会话路径

### 7.2 snapshot-chunk / welcome 帧顺序导致 #welcomed 永不为 true

**现象**：TUI 连接后能显示历史会话内容，但后续事件不更新（TUI 端无同步）。

**原因**：服务器发送顺序是 `snapshot-chunk` → `welcome`。`snapshot-chunk` 处理器在 `#pendingEntryCount` 为 0 时触发 `#finalizeSnapshot()`，但因 header 为 null 而提前返回。`#welcomed` 永不设为 `true`，所有后续 `event` 帧被 `if (!this.#welcomed) return` 丢弃。

**修复**：
- `snapshot-chunk`：仅在 `frame.final && this.#pendingHeader`（welcome 已到达）时完成
- `welcome`：在 entries 已累积满时也触发完成
- 两种到达顺序均正确处理

### 7.3 buildEntry 返回 null

**现象**：消息在 transcript 中不显示。

**修复**：重写 `buildEntry`，直接使用 `in`/`typeof` 收窄 message 对象。

### 7.4 streamDone 陈旧闭包

**现象**：助理回复完成后，stream ghost 和 entry 同时显示。

**修复**：引入 `streamDoneRef`，setter 同步更新 ref 和 state。

### 7.5 React 18 Auto-Batching 导致 welcome 吞掉 entries

**现象**：切换到有消息的历史会话后，transcript 显示为空。

**修复**：去掉 prev 守卫，直接用 ref 中的 `pendingChunks` 替换 entries。

### 7.6 路径穿越漏洞

**修复**：`path.resolve(target).startsWith(sessionsRoot + path.sep)` 检查，不匹配返回 403。

### 7.7 /session/<id> 路径下资源 404

**现象**：直接访问 `http://localhost:3000/session/<id>` 页面空白。

**原因**：`index.html` 中 CSS/JS 引用为相对路径（`main.js`），在 `/session/<id>` 下被解析为 `/session/main.js`（404）。

**修复**：`index.html` 添加 `<base href="/">`，所有相对路径从根解析。

### 7.8 自动标题跨会话竞态

**修复**：`generateTitle` 捕获 `sessionId`，异步完成后检查 `session.sessionId !== sessionId` 守门。

### 7.9 Slot 资源泄漏（P0）

**现象**：Client 断开后，对应的 AgentSession 槽位（`#slots` 中的条目）永不清理。每个被访问过的 session 路径永久占用内存和事件订阅资源。

**修复**：`removeClient` 中新增 `#maybeCleanupSlot`：遍历 `#clientSessions` 检查是否还有客户端挂载在该 sessionPath，无则取消订阅并删除槽位。

### 7.10 handleAbort 全局中止（P1）

**现象**：`handleAbort()` 遍历所有 slot 对所有会话调用 `abort()`，任意客户端的中止请求会中断所有会话。

**修复**：改为 `handleAbort(client)`，通过 `#clientSessions` 定位客户端所属会话，仅中止该槽位的 Agent。

### 7.11 #getOrCreateSlot TOCTOU 竞态（P1）

**现象**：两个客户端同时请求同一 sessionPath，都发现不存在且都调用 `forkSession`，导致创建两个独立 AgentSession，第二个覆盖第一个使前者成为孤儿。

**修复**：新增 `#pendingSlots` Map 缓存进行中的创建 Promise，并发请求复用相同 Promise。

### 7.12 "reset" 帧类型缺失（P2）

**现象**：`reset` 帧不在 `packages/wire` 的 `HostFrame` 联合类型中，发送端和接收端均通过 `as unknown as HostFrame` 绕过类型检查。

**修复**：`packages/wire/src/index.ts` 的 `HostFrame` 联合类型中添加 `{ t: "reset" }` 变体，移除各处的类型断言。

### 7.13 WebSocket 陈旧 onclose 竞态（P2）

**现象**：`#reconnect()` 创建新 WebSocket 后，旧 socket 的 `onclose` 仍可能在之后触发，导致误调 `#scheduleReconnect()` 创建第三个连接。

**修复**：`ws.onclose` 守卫新增 `this.#ws === ws` 检查，仅当关闭的 socket 仍然是当前连接时才触发重连。

### 7.14 popstate 无法返回 /session/<id>（P3）

**现象**：用户点击 "leave session" 后按后退按钮，URL 变为 `/session/<id>` 但应用停留在选择器界面。

**修复**：`popstate` 处理器新增 `/session/<id>` 分支，从 URL 提取 session ID，在 `sessionList` 中匹配后调用 `agent.selectSession(path)`。

### 7.15 initialMessage 绕过 webGuest 路由（P2）

**现象**：`--web-client` 模式下 `--prompt` 或管道输入通过 `session.prompt()` 直接发送到本地 session，而不是路由到 Web 服务器。

**修复**：`initialMessage` 和 `initialMessages` 处理块中新增 `webClient === undefined` 守卫，web 客户端模式下跳过本地 prompt。

### 7.16 confirmDelete 无条件清除 confirm 状态（P2）

**现象**：A 行删除进行中时点击 B 行删除，A 完成后的 `setConfirming(null)` 会错误清除 B 的确认 UI。

**修复**：`setConfirming`/`setDeleting` 改用函数式更新 `prev => prev === path ? ... : prev`，仅当状态仍指向当前行时才修改。

## 八、文件清单

### 新增文件

```
packages/coding-agent/src/modes/web/
├── web-mode.ts                   服务端入口 (HTTP + WS + REST API)
├── collab-host.ts                CollabHost (多 AgentSession 池 + 按客户端路由)
├── web-guest.ts                  WebGuestLink (TUI 客户端 WebSocket 桥接)
└── client/
    ├── index.html                SPA 外壳 (<base href="/"> + theme init)
    ├── main.tsx                  入口 (URL 解析 + CSS 导入)
    ├── App.tsx                   三态路由 + URL 管理 + popstate
    ├── useAgent.ts               WebSocket hook + initialSessionId 自动解析
    ├── SessionPicker.tsx          会话选择 (SVG 图标 + 骨架屏 + 移动端)
    ├── collab-bridge.ts          数据格式适配
    └── styles.css                布局 + picker 样式 + 移动端断点

packages/coding-agent/scripts/
└── build-web-client.ts           前端构建脚本
```

### 修改的现有文件

| 文件 | 改动 |
|---|---|
| `src/cli/args.ts` | 添加 `webClient?: string` 字段 |
| `src/cli/flag-tables.ts` | 添加 `--web-client` 到 STRING_SETTERS；`--mode` 添加 `"web"` |
| `src/main.ts` | web 模式分发；`forkSession` 工厂；`runInteractiveMode` 添加 `webClient` 参数；WebGuestLink 初始化 |
| `src/modes/types.ts` | 添加 `webGuest?: WebGuestLink` 到 InteractiveModeContext |
| `src/modes/interactive-mode.ts` | 添加 `webGuest` 字段 |
| `src/modes/controllers/input-controller.ts` | prompt/abort/retry 路由检查 `ctx.webGuest` |
| `tsconfig.json` | 排除 `client/` 目录 |
| `package.json` | 添加 `gen:web-client` 脚本 |
| `packages/collab-web/package.json` | 添加 `exports` 字段 |
| `packages/wire/src/index.ts` | `HostFrame` 联合类型添加 `{ t: "reset" }` |

## 九、技术要点

1. **多 AgentSession 池**：每个会话路径有独立的 AgentSession（含独立 Agent），不同会话的 prompt 完全并发，互不阻塞。事件按 sessionPath 过滤广播。

2. **TUI ↔ Web 双向同步**：WebGuestLink 复用 CollabGuestLink 模式（副本文件 + EventController 事件注入 + WebSocket prompt 转发）。InputController 优先检查 `ctx.webGuest` 路由。

3. **URL 路由**：`/session/<id>` 直接打开会话，`<base href="/">` 确保子路径资源引用正确，`history.pushState` + `popstate` 管理 URL 状态。

4. **移动端适配**：三级响应式断点（640px/480px/360px），44px 触控目标，safe-area-inset，垂直堆叠确认框，SVG 图标，骨架屏加载。

5. **帧顺序鲁棒性**：`snapshot-chunk` 和 `welcome` 可在任意顺序到达，通过 `#pendingHeader` 守卫和双触发完成确保 `#welcomed` 正确设置。

6. **forkSession 工厂**：`SessionManager.open(path)` + `createAgentSession()` 创建完全独立的 AgentSession，包括独立的 Agent 实例和 EventBus。
