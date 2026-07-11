# 如何提交这次修复

## 目录

1. [准备工作](#1-准备工作)
2. [创建分支并提交](#2-创建分支并提交)
3. [提交 PR](#3-提交-pr)
4. [恢复工作区](#4-恢复工作区)

---

## 1. 准备工作

当前仓库状态：

```
前 2 个提交是你的个性化修改，需要跳过
  ┌─ 261d09e67  Display the tool's intent annotation...
  ├─ 5b2ec42da  Support git source installs via omp update
  │
  ├─ ac2ea80fa  ← 从这里创建分支（官方的合并点）
  ├─ b24743a9c
  ├─ ...
```

工作区还有其他未提交的修改（coding-agent web client 等），需要先安全保存。

### 保存当前工作区修改

```bash
cd ~/oh-my-pi

# 把所有改动暂存到 stash，包括未跟踪的新文件
git stash push -u -m "personal wip: coding-agent web client and other changes"
```

验证工作区干净了：

```bash
git status --short
# 应该没有输出
```

---

## 2. 创建分支并提交

```bash
# 从官方合并点创建分支（跳过你的 2 个个性化提交）
git checkout -b fix/collab-duplicate-tool-cards ac2ea80fa
```

确认分支起点正确：

```bash
git log --oneline -1
# 应该显示: ac2ea80fa Merge pull request #4775 ...
```

从 stash 中**只提取 Transcript.tsx** 的修改：

```bash
git diff stash@{0} -- packages/collab-web/src/components/transcript/Transcript.tsx | git apply
```

确认只有 Transcript.tsx 被修改：

```bash
git diff --stat
# 应该只显示:
# packages/collab-web/src/components/transcript/Transcript.tsx | 23 ++++++++++++++++-------
```

提交：

```bash
git add packages/collab-web/src/components/transcript/Transcript.tsx
git commit -m "fix(collab-web): deduplicate tool cards and hide thinking shimmer during tool execution"
```

---

## 3. 提交 PR

### 3.1 推送分支

```bash
# 添加你的 fork 为远程仓库（如果还没添加）
git remote add fork https://github.com/<你的GitHub用户名>/oh-my-pi.git

# 推送
git push fork fix/collab-duplicate-tool-cards
```

### 3.2 创建 PR

去 [https://github.com/can1357/oh-my-pi/pulls](https://github.com/can1357/oh-my-pi/pulls) 点 "New pull request"。

- **base repository**: `can1357/oh-my-pi`
- **base branch**: `main`
- **head repository**: `你的用户名/oh-my-pi`
- **head branch**: `fix/collab-duplicate-tool-cards`

### 3.3 PR 内容

**Title（标题）：**

```
fix(collab-web): deduplicate tool cards and hide thinking shimmer during tool execution
```

**Body（正文）：**

```
## Problem

Two rendering bugs in the collab-web transcript (`packages/collab-web/src/components/transcript/Transcript.tsx`) when a tool is executing:

**1. Duplicate tool execution boxes**

The `tailTools` dedup only checks `streamIds` (tool calls in the streaming ghost). When the streaming ghost is cleared after the entry is committed, `streamIds` becomes empty and every running tool leaks into a separate `tailTools` row — producing an identical ToolCard alongside the one already rendered from the committed entry's content.

**2. Stale "thinking…" shimmer during tool execution**

The shimmer condition `working && stream === null` stays true for the entire tool execution phase. This is because the agent's `isStreaming` flag isn't set to `false` until `agent_end` fires, which happens after all tools finish. The "thinking…" text persists when it should be hidden — the model has already finished reasoning and is now executing tools.

## Root Cause

1. The `tailTools` computation was missing an `entryIds` pass that collects toolCall IDs from committed assistant-message entries. Without it, a tool already shown in the entry row was also rendered in `tailTools`.

2. The shimmer condition had no check for active tools. `working` stays `true` during tool execution because streaming is considered "active" until `agent_end`.

## Changes

- Added a loop that iterates all committed entries, extracts toolCall IDs, and stores them in an `entryIds` Set. The `tailTools` filter now requires the tool to be absent from **both** `streamIds` and `entryIds`.
- Added `activeTools.size === 0` to the shimmer condition so it only renders when no tools are executing.

## Files Changed

- `packages/collab-web/src/components/transcript/Transcript.tsx` — +23 / -1 lines

## Verification

- Tested with a real omp collab session executing `bash sleep 10`: single tool card, no duplicate, no thinking shimmer during execution.
- `bun test packages/collab-web/test/` — 65 tests pass.
```

---

## 4. 恢复工作区

PR 提交完成后，切回 main 分支，恢复之前 stash 的个人修改：

```bash
git checkout main
git stash pop
```

检查工作区是否恢复：

```bash
git status --short
# 应该能看到你之前的所有改动
```
