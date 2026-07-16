/**
 * Collab host protocol - emits HostFrame messages directly from the agent
 * session over WebSocket. Each distinct session path gets its own
 * AgentSession instance, so multiple browser tabs on different sessions
 * can stream responses concurrently without blocking.
 */

import type { WireMessage } from "@oh-my-pi/pi-wire";
import type { AgentSession } from "../../session/agent-session";
import type { AgentSnapshot, BusChannel, SessionEntry, SessionHeader, SessionState, HostFrame, SubagentLifecyclePayload } from "@oh-my-pi/pi-wire";
import { $env, logger } from "@oh-my-pi/pi-utils";
import * as fs from "node:fs/promises";
import { generateSessionTitle } from "../../utils/title-generator";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import { type AgentRef, AgentRegistry } from "../../registry/agent-registry";
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import type { EventBus } from "../../utils/event-bus";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "../../task/types";

type Client = { send(obj: unknown): void };

interface Slot {
	session: AgentSession;
	eventBus: EventBus;
	unsubEvents: () => void;
	unsubTitle: () => void;
	unsubBus: () => void;
	/** Agent IDs belonging to this session (subagents, tracked via lifecycle events). */
	agentIds: Set<string>;
	/** Debounce timer for agents broadcast. */
	agentsDebounce: Timer | undefined;
}

const AGENTS_DEBOUNCE_MS = 100;
const TRANSCRIPT_READ_CAP = 4 * 1024 * 1024;
const TRANSCRIPT_ENTRY_TOO_LARGE_ERROR = `transcript entry exceeds transcript fetch cap (${TRANSCRIPT_READ_CAP} bytes)`;

const BUS_CHANNELS: readonly BusChannel[] = [
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
] as const;

function sendFrame(ws: Client, frame: HostFrame): void {
	try { ws.send(frame); } catch {}
}

function toTimestamp(ts?: number): string { return new Date(ts ?? Date.now()).toISOString(); }

export interface CollabOpts { cwd: string; forkSession: (path?: string) => Promise<{ session: AgentSession; eventBus: EventBus }>; }

export class CollabHost {
	#opts: CollabOpts;
	#clients = new Set<Client>();
	#clientSessions = new Map<Client, string>();
	#slots = new Map<string, Slot>();
	#registryUnsub: (() => void) | null = null;

	constructor(opts: CollabOpts) {
		this.#opts = opts;
		this.#registryUnsub = AgentRegistry.global().onChange(() => this.#scheduleAllAgentsBroadcasts());
	}

	addClient(client: Client): void { this.#clients.add(client); }

	removeClient(client: Client): void {
		this.#clients.delete(client);
		const path = this.#clientSessions.get(client);
		this.#clientSessions.delete(client);
		if (path) this.#maybeCleanupSlot(path);
	}

	async switchSessionForClient(client: Client, sessionPath: string): Promise<boolean> {
		try {
			const slot = await this.#getOrCreateSlot(sessionPath);
			if (!slot) return false;
			this.#clientSessions.set(client, sessionPath);
			this.#sendResetAndWelcome(client, slot);
			return true;
		} catch { return false; }
	}

	async newSessionForClient(client: Client): Promise<boolean> {
		try {
			const { session, eventBus } = await this.#opts.forkSession();
			const filePath = session.sessionManager.getSessionFile();
			if (!filePath) return false;
			this.#installSlot(filePath, session, eventBus);
			this.#clientSessions.set(client, filePath);
			const slot = this.#slots.get(filePath);
			if (slot) this.#sendResetAndWelcome(client, slot);
			return true;
		} catch { return false; }
	}

	async handlePrompt(client: Client, text: string): Promise<void> {
		const clientPath = this.#clientSessions.get(client);
		if (!clientPath) return;
		const slot = this.#slots.get(clientPath);
		if (!slot) return;
		generateTitle(slot.session, text);
		slot.session.prompt(text).catch(() => {});
	}

	handleAbort(client: Client): void {
		const clientPath = this.#clientSessions.get(client);
		if (!clientPath) return;
		const slot = this.#slots.get(clientPath);
		if (slot) slot.session.abort().catch(() => {});
	}

	handleAgentCmd(client: Client, cmd: "chat" | "kill" | "revive", agentId: string, text?: string): void {
		const fail = (err: unknown) => {
			logger.warn("web-mode agent-cmd failed", { cmd, agentId, error: String(err) });
			sendFrame(client, { t: "error", message: `agent ${agentId}: ${String(err)}` });
		};
		if (AgentRegistry.global().get(agentId)?.kind === "advisor") {
			sendFrame(client, { t: "error", message: `agent ${agentId}: advisor transcripts are read-only` });
			return;
		}
		switch (cmd) {
			case "chat": {
				const trimmed = text?.trim();
				if (!trimmed) { sendFrame(client, { t: "error", message: `agent ${agentId}: empty chat message` }); return; }
				AgentLifecycleManager.global().ensureLive(agentId)
					.then(s => s.prompt(trimmed, { streamingBehavior: "steer" }))
					.catch(fail);
				break;
			}
			case "kill": {
				const kill = async () => {
					const ref = AgentRegistry.global().get(agentId);
					if (ref && ref.status === "running" && ref.session) await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
					await AgentLifecycleManager.global().release(agentId);
				};
				kill().catch(fail);
				break;
			}
			case "revive":
				AgentLifecycleManager.global().ensureLive(agentId).catch(fail);
				break;
		}
	}

	async handleFetchTranscript(client: Client, reqId: number, agentId: string, fromByte: number): Promise<void> {
		const reply = (text: string, newSize: number, error?: string) =>
			sendFrame(client, { t: "transcript", reqId, text, newSize, error });
		const file = AgentRegistry.global().get(agentId)?.sessionFile;
		if (!file) { reply("", fromByte, "no transcript available"); return; }
		try {
			const stat = await fs.stat(file);
			if (stat.size <= fromByte) { reply("", stat.size); return; }
			const want = Math.min(stat.size - fromByte, TRANSCRIPT_READ_CAP);
			const handle = await fs.open(file, "r");
			let bytesRead: number;
			const buf = Buffer.allocUnsafe(want);
			try { ({ bytesRead } = await handle.read(buf, 0, want, fromByte)); } finally { await handle.close(); }
			let slice = buf.subarray(0, bytesRead);
			const reachedEof = fromByte + bytesRead >= stat.size;
			if (!reachedEof) {
				const lastNewline = slice.lastIndexOf(0x0a);
				if (lastNewline < 0) { reply("", fromByte, TRANSCRIPT_ENTRY_TOO_LARGE_ERROR); return; }
				slice = slice.subarray(0, lastNewline + 1);
			}
			reply(slice.toString("utf-8"), reachedEof ? stat.size : fromByte + slice.byteLength);
		} catch (err) {
			logger.debug("web-mode transcript read failed", { agentId, error: String(err) });
			reply("", fromByte, String(err));
		}
	}

	/** Deduplicates concurrent slot creation for the same path (TOCTOU fix). */
	#pendingSlots = new Map<string, Promise<Slot | null>>();

	async #getOrCreateSlot(sessionPath: string): Promise<Slot | null> {
		const existing = this.#slots.get(sessionPath);
		if (existing) return existing;
		const pending = this.#pendingSlots.get(sessionPath);
		if (pending) return pending;
		const p = (async () => {
			const { session, eventBus } = await this.#opts.forkSession(sessionPath);
			this.#installSlot(sessionPath, session, eventBus);
			return this.#slots.get(sessionPath) ?? null;
		})();
		this.#pendingSlots.set(sessionPath, p);
		try { return await p; } finally { this.#pendingSlots.delete(sessionPath); }
	}

	/** Remove a slot if no clients remain on its session path (P0 leak fix). */
	#maybeCleanupSlot(sessionPath: string): void {
		const inUse = [...this.#clientSessions.values()].some(p => p === sessionPath);
		if (inUse) return;
		const slot = this.#slots.get(sessionPath);
		if (!slot) return;
		slot.unsubEvents(); slot.unsubTitle(); slot.unsubBus();
		clearTimeout(slot.agentsDebounce);
		this.#slots.delete(sessionPath);
	}

	#installSlot(sessionPath: string, session: AgentSession, eventBus: EventBus): void {
		const unsubEvents = session.subscribe((_event: object) => {
			const event = _event as Record<string, unknown>;
			for (const c of this.#clients) { if (this.#clientSessions.get(c) !== sessionPath) continue; sendFrame(c, { t: "event", event } as unknown as HostFrame); }
			if (event.type === "message_end") {
				const msg = event.message as Record<string, unknown> | undefined;
				if (msg && (msg.role === "user" || msg.role === "assistant" || msg.role === "toolResult")) {
					const entry = buildEntry(msg);
					if (entry) for (const c of this.#clients) { if (this.#clientSessions.get(c) !== sessionPath) continue; sendFrame(c, { t: "entry", entry } as unknown as HostFrame); }
				}
			}
		});
		const unsubTitle = session.sessionManager.onSessionNameChanged(() => {
		const state = buildState(session);
			for (const c of this.#clients) { if (this.#clientSessions.get(c) !== sessionPath) continue; sendFrame(c, { t: "state", state } as unknown as HostFrame); }
		});
		// Subscribe to EventBus for subagent progress/lifecycle channels.
		const agentIds = new Set<string>();
		const unsubBus = (() => {
			const unsubs: (() => void)[] = [];
			for (const channel of BUS_CHANNELS) {
				unsubs.push(eventBus.on(channel, data => {
					if (channel === TASK_SUBAGENT_LIFECYCLE_CHANNEL) {
						const payload = data as SubagentLifecyclePayload;
						agentIds.add(payload.id);
						if (payload.status !== "started") {
							// Agent ended - keep ID in set (still visible in registry until unregistered)
						}
					}
					for (const c of this.#clients) {
						if (this.#clientSessions.get(c) !== sessionPath) continue;
						sendFrame(c, { t: "bus", channel, data } as unknown as HostFrame);
					}
				}));
			}
			return () => { for (const u of unsubs) u(); };
		})();
		this.#slots.set(sessionPath, { session, eventBus, unsubEvents, unsubTitle, unsubBus, agentIds, agentsDebounce: undefined });
	}

	#sendResetAndWelcome(client: Client, slot: Slot): void {
		sendFrame(client, { t: "reset" });
		const entries = buildEntries(slot.session);
		if (entries.length === 0) { sendFrame(client, { t: "snapshot-chunk", entries: [], final: true }); }
		else { let o = 0; while (o < entries.length) { const c = entries.slice(o, o + 50); o += 50; sendFrame(client, { t: "snapshot-chunk", entries: c, final: o >= entries.length }); } }
		sendFrame(client, { t: "welcome", proto: 3, header: buildHeader(slot.session), state: buildState(slot.session), agents: this.#snapshotAgents(slot), entryCount: entries.length });
	}

	/** Build agent snapshot for a slot: main agent from session + subagents from registry. */
	#snapshotAgents(slot: Slot): AgentSnapshot[] {
		const session = slot.session;
		const mainId = session.getAgentId() ?? "Main";
		const mainRef = AgentRegistry.global().get(mainId);
		const agents: AgentSnapshot[] = [];
		// Main agent - prefer registry data, fall back to session-derived snapshot.
		if (mainRef && mainRef.kind !== "advisor") {
			agents.push(refToSnapshot(mainRef));
		} else {
			agents.push({
				id: mainId,
				displayName: "main",
				kind: "main",
				status: session.isStreaming ? "running" : "idle",
				hasSessionFile: !!session.sessionManager.getSessionFile(),
				createdAt: Date.now(),
				lastActivity: Date.now(),
			});
		}
		// Subagents tracked via lifecycle events.
		for (const id of slot.agentIds) {
			if (id === mainId) continue;
			const ref = AgentRegistry.global().get(id);
			if (ref && ref.kind !== "advisor") agents.push(refToSnapshot(ref));
		}
		return agents;
	}

	#scheduleAllAgentsBroadcasts(): void {
		for (const [sessionPath, slot] of this.#slots) {
			if (slot.agentsDebounce) continue;
			slot.agentsDebounce = setTimeout(() => {
				slot.agentsDebounce = undefined;
				const agents = this.#snapshotAgents(slot);
				for (const c of this.#clients) {
					if (this.#clientSessions.get(c) !== sessionPath) continue;
					sendFrame(c, { t: "agents", agents } as unknown as HostFrame);
				}
			}, AGENTS_DEBOUNCE_MS);
		}
	}
}

function refToSnapshot(ref: AgentRef): AgentSnapshot {
	return {
		id: ref.id,
		displayName: ref.displayName,
		kind: ref.kind as "main" | "sub",
		parentId: ref.parentId,
		status: ref.status,
		hasSessionFile: !!ref.sessionFile,
		createdAt: ref.createdAt,
		lastActivity: ref.lastActivity,
	};
}

function buildEntry(message: Record<string, unknown>): SessionEntry | null {
	if (typeof message?.role !== "string") return null;
	const role = message.role;
	if (role !== "user" && role !== "assistant" && role !== "toolResult") return null;
	const ts = typeof message.timestamp === "number" ? message.timestamp : undefined;
	return { type: "message", id: `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, parentId: null, timestamp: toTimestamp(ts), message: message as unknown as WireMessage };
}

// Both the header and state must report the CWD recorded in the session
// file. session.sessionManager.getCwd() returns the *resolved* cwd which
// falls back to getProjectDir() (the web server's cwd) when the original
// directory was deleted - displaying that as the session location is
// misleading. getHeader()?.cwd is the raw value persisted on disk.
function sessionCwd(session: AgentSession): string {
	return session.sessionManager.getHeader()?.cwd ?? session.sessionManager.getCwd();
}

function buildState(session: AgentSession): SessionState {
	return { isStreaming: session.isStreaming, queuedMessageCount: session.queuedMessageCount, sessionName: session.sessionName ?? undefined, cwd: sessionCwd(session), model: session.model ? { id: session.model.id, name: session.model.id, provider: session.model.provider, contextWindow: session.model.contextWindow ?? 0 } : undefined, contextUsage: session.getContextUsage() ?? undefined, participants: [] };
}

function buildHeader(session: AgentSession): SessionHeader {
	return { type: "session", id: session.sessionId, title: session.sessionName ?? undefined, timestamp: toTimestamp(), cwd: sessionCwd(session) };
}

function buildEntries(session: AgentSession): SessionEntry[] {
	const out: SessionEntry[] = [];
	for (const raw of session.messages) { const entry = buildEntry(raw as unknown as Record<string, unknown>); if (entry) out.push(entry); }
	return out;
}

function generateTitle(session: AgentSession, text: string): void {
	const mgr = session.sessionManager;
	if (mgr.getSessionName()) return;
	if ($env.PI_NO_TITLE) return;
	const sessionId = session.sessionId;
	generateSessionTitle(text, session.modelRegistry, session.settings, sessionId, session.model ?? undefined, (p: string) => session.agent.metadataForProvider(p), session.titleSystemPrompt)
		.then(async title => { if (session.sessionId !== sessionId) return; if (title && !mgr.getSessionName()) await mgr.setSessionName(title, "auto"); })
		.catch(err => logger.warn("web-mode: auto-title error", { sessionId, error: err instanceof Error ? err.message : String(err) }));
}
