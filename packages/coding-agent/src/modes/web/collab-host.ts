/**
 * Collab host protocol - emits HostFrame messages directly from the agent
 * session over WebSocket. Each distinct session path gets its own
 * AgentSession instance, so multiple browser tabs on different sessions
 * can stream responses concurrently without blocking.
 */

import type { WireMessage } from "@oh-my-pi/pi-wire";
import type { AgentSession } from "../../session/agent-session";
import type { SessionEntry, SessionHeader, SessionState, HostFrame } from "@oh-my-pi/pi-wire";
import { $env, logger } from "@oh-my-pi/pi-utils";
import { generateSessionTitle } from "../../utils/title-generator";

function sendFrame(ws: { send(obj: unknown): void }, frame: HostFrame): void {
	try { ws.send(frame); } catch {}
}

function toTimestamp(ts?: number): string { return new Date(ts ?? Date.now()).toISOString(); }

export interface CollabOpts { cwd: string; forkSession: (path: string) => Promise<AgentSession>; }

export class CollabHost {
	#opts: CollabOpts;
	#clients = new Set<{ send(obj: unknown): void }>();
	#clientSessions = new Map<{ send(obj: unknown): void }, string>();
	#slots = new Map<string, { session: AgentSession; unsubEvents: () => void; unsubTitle: () => void }>();

	constructor(opts: CollabOpts) { this.#opts = opts; }

	addClient(client: { send(obj: unknown): void }): void { this.#clients.add(client); }
	removeClient(client: { send(obj: unknown): void }): void {
		this.#clients.delete(client);
		const path = this.#clientSessions.get(client);
		this.#clientSessions.delete(client);
		// P0 fix: clean up slot when no clients remain on this session path.
		if (path) this.#maybeCleanupSlot(path);
	}

	async switchSessionForClient(client: { send(obj: unknown): void }, sessionPath: string): Promise<boolean> {
		try {
			const slot = await this.#getOrCreateSlot(sessionPath);
			if (!slot) return false;
			this.#clientSessions.set(client, sessionPath);
			this.#sendResetAndWelcome(client, slot.session);
			return true;
		} catch { return false; }
	}

	async newSessionForClient(client: { send(obj: unknown): void }): Promise<boolean> {
		try {
			const session = await this.#opts.forkSession("__empty");
			await session.newSession();
			const filePath = session.sessionManager.getSessionFile();
			if (!filePath) return false;
			this.#installSlot(filePath, session);
			this.#clientSessions.set(client, filePath);
			this.#sendResetAndWelcome(client, session);
			return true;
		} catch { return false; }
	}

	async handlePrompt(client: { send(obj: unknown): void }, text: string): Promise<void> {
		const clientPath = this.#clientSessions.get(client);
		if (!clientPath) { logger.info("collab-host handlePrompt: no session for client"); return; }
		const slot = this.#slots.get(clientPath);
		if (!slot) { logger.info("collab-host handlePrompt: no slot", { path: clientPath.slice(-40) }); return; }
		generateTitle(slot.session, text);
		slot.session.prompt(text).catch(() => {});
	}

	handleAbort(client: { send(obj: unknown): void }): void {
		const clientPath = this.#clientSessions.get(client);
		if (!clientPath) return;
		const slot = this.#slots.get(clientPath);
		if (slot) slot.session.abort().catch(() => {});
	}

	/** Deduplicates concurrent slot creation for the same path (TOCTOU fix). */
	#pendingSlots = new Map<string, Promise<{ session: AgentSession; unsubEvents: () => void; unsubTitle: () => void } | null>>();

	async #getOrCreateSlot(sessionPath: string) {
		const existing = this.#slots.get(sessionPath);
		if (existing) return existing;
		const pending = this.#pendingSlots.get(sessionPath);
		if (pending) return pending;
		const p = (async () => {
			logger.info("collab-host creating slot", { path: sessionPath.slice(-50) });
			const session = await this.#opts.forkSession(sessionPath);
			if (!session) return null;
			this.#installSlot(sessionPath, session);
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
		slot.unsubEvents(); slot.unsubTitle();
		this.#slots.delete(sessionPath);
		logger.info("collab-host slot cleaned up", { path: sessionPath.slice(-50) });
	}

	#installSlot(sessionPath: string, session: AgentSession): void {
		const unsubEvents = session.subscribe((_event: object) => {
			const event = _event as Record<string, unknown>;
			let matchCount = 0;
			for (const c of this.#clients) { if (this.#clientSessions.get(c) !== sessionPath) continue; matchCount++; sendFrame(c, { t: "event", event } as unknown as HostFrame); }
			if (event.type === "message_end") {
				const msg = event.message as Record<string, unknown> | undefined;
				if (msg && (msg.role === "user" || msg.role === "assistant" || msg.role === "toolResult")) {
					const entry = buildEntry(msg);
					if (entry) for (const c of this.#clients) { if (this.#clientSessions.get(c) !== sessionPath) continue; sendFrame(c, { t: "entry", entry } as HostFrame); }
				}
			}
		});
		const unsubTitle = session.sessionManager.onSessionNameChanged(() => {
			const state = buildState(session, this.#opts.cwd);
			for (const c of this.#clients) { if (this.#clientSessions.get(c) !== sessionPath) continue; sendFrame(c, { t: "state", state } as HostFrame); }
		});
		this.#slots.set(sessionPath, { session, unsubEvents, unsubTitle });
	}

	#sendResetAndWelcome(client: { send(obj: unknown): void }, session: AgentSession): void {
		sendFrame(client, { t: "reset" });
		const entries = buildEntries(session);
		if (entries.length === 0) { sendFrame(client, { t: "snapshot-chunk", entries: [], final: true }); }
		else { let o = 0; while (o < entries.length) { const c = entries.slice(o, o + 50); o += 50; sendFrame(client, { t: "snapshot-chunk", entries: c, final: o >= entries.length }); } }
		sendFrame(client, { t: "welcome", proto: 3, header: buildHeader(session), state: buildState(session, this.#opts.cwd), agents: [], entryCount: entries.length });
	}
}

function buildEntry(message: Record<string, unknown>): SessionEntry | null {
	if (typeof message?.role !== "string") return null;
	const role = message.role;
	if (role !== "user" && role !== "assistant" && role !== "toolResult") return null;
	const ts = typeof message.timestamp === "number" ? message.timestamp : undefined;
	return { type: "message", id: `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, parentId: null, timestamp: toTimestamp(ts), message: message as unknown as WireMessage };
}

function buildState(session: AgentSession, cwd: string): SessionState {
	return { isStreaming: session.isStreaming, queuedMessageCount: session.queuedMessageCount, sessionName: session.sessionName ?? undefined, cwd, model: session.model ? { id: session.model.id, name: session.model.id, provider: session.model.provider, contextWindow: session.model.contextWindow ?? 0 } : undefined, contextUsage: session.getContextUsage() ?? undefined, participants: [] };
}

function buildHeader(session: AgentSession): SessionHeader {
	return { type: "session", id: session.sessionId, title: session.sessionName ?? undefined, timestamp: toTimestamp(), cwd: session.sessionManager.getCwd() };
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
