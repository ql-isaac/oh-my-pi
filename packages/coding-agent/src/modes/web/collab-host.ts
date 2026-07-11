/**
 * Collab host protocol - emits HostFrame messages directly from the agent
 * session over WebSocket. Replaces the RPC subprocess bridge.
 */

import type { WireMessage } from "@oh-my-pi/pi-wire";
import type { AgentSession } from "../../session/agent-session";
// The collab HostFrame type re-exports AgentEvent so we don't import it separately.
import type { SessionEntry, SessionHeader, SessionState, HostFrame } from "@oh-my-pi/pi-wire";
import { $env, logger } from "@oh-my-pi/pi-utils";
import { generateSessionTitle } from "../../utils/title-generator";

// ---------------------------------------------------------------------------
// Outbound helpers
// ---------------------------------------------------------------------------

function sendFrame(ws: { send(obj: unknown): void }, frame: HostFrame): void {
	try {
		ws.send(frame);
	} catch {
		// client disconnected
	}
}

function toTimestamp(ts?: number): string {
	return new Date(ts ?? Date.now()).toISOString();
}

// ---------------------------------------------------------------------------
// Collab Host
// ---------------------------------------------------------------------------

export interface CollabOpts {
	/** Current working directory. */
	cwd: string;
}

export class CollabHost {
	#session: AgentSession;
	#opts: CollabOpts;
	#clients = new Set<{ send(obj: unknown): void }>();
	#unsubSession?: () => void;
	#unsubTitle?: () => void;
	/**
	 * Drops session events to clients while a session switch is in flight, so the
	 * teardown/abort/replay noise from `switchSession` never reaches them. The
	 * switch path then explicitly sends a fresh snapshot, which is the only
	 * truth worth shipping for the new session.
	 */
	#paused = false;

	constructor(session: AgentSession, opts: CollabOpts) {
		this.#session = session;
		this.#opts = opts;
	}

	start(): void {
		// Subscribe to session events and forward as collab `event` frames.
		// The session emits AgentSessionEvent (extends AgentEvent) - we feed
		// everything through to the WebSocket; the collab protocol tolerates
		// unknown event types via a default: in applyEvent.
		this.#unsubSession = this.#session.subscribe((_event: object) => {
			// Drop the teardown/abort/replay noise from an in-flight
			// switchSession; the new welcome frame is the only state worth
			// shipping for the new session.
			if (this.#paused) return;
			const event = _event as Record<string, unknown>;
			for (const client of this.#clients) {
				sendFrame(client, { t: "event", event } as unknown as HostFrame);
			}

			// Also emit `entry` frames for finalized messages
			if (event.type === "message_end") {
				const msg = event.message as Record<string, unknown> | undefined;
				const role = msg?.role as string | undefined;
				if (role === "user" || role === "assistant" || role === "toolResult") {
					const entry = buildEntry(msg ?? {});
					if (entry) {
						for (const client of this.#clients) {
							sendFrame(client, { t: "entry", entry } as HostFrame);
						}
					}
				}
			}
		});

		// Broadcast a fresh `state` frame whenever the session name changes so
		// the header title updates live. Without this the auto-generated title
		// (or a /rename) never reaches already-connected clients.
		this.#unsubTitle = this.#session.sessionManager.onSessionNameChanged(() => {
			this.#broadcastState();
		});
	}

	stop(): void {
		this.#unsubSession?.();
		this.#unsubSession = undefined;
		this.#unsubTitle?.();
		this.#unsubTitle = undefined;
	}

	/** Register a freshly-connected client. Welcome is deferred until the user
	 *  picks a session via `resume`/`new` - sending it eagerly here would race
	 *  the picker UI and auto-flip the client into the transcript view. */
	addClient(client: { send(obj: unknown): void }): void {
		this.#clients.add(client);
	}

	/** Send snapshot + welcome to a single (already-registered) client. Reads
	 *  the current session's messages, so a fresh `switchSession` followed by
	 *  `sendWelcomeTo` always reflects the new session. */
	sendWelcomeTo(client: { send(obj: unknown): void }): void {
		const entries = this.#buildEntries();

		// Send snapshot chunks
		const CHUNK_SIZE = 50;
		for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
			const chunk = entries.slice(i, i + CHUNK_SIZE);
			const final = i + CHUNK_SIZE >= entries.length;
			sendFrame(client, { t: "snapshot-chunk", entries: chunk, final });
		}

		// If no existing entries, just send empty welcome
		if (entries.length === 0) {
			sendFrame(client, { t: "snapshot-chunk", entries: [], final: true });
		}

		// Send welcome after chunks
		sendFrame(client, {
			t: "welcome",
			proto: 3,
			header: this.#buildHeader(),
			state: this.#buildState(),
			agents: [],
			entryCount: entries.length,
		});
	}

	removeClient(client: { send(obj: unknown): void }): void {
		this.#clients.delete(client);
	}
	async switchSession(sessionPath: string): Promise<boolean> {
		if (this.#paused) return false;
		this.#paused = true;
		try {
			const ok = await this.#session.switchSession(sessionPath);
			if (!ok) return false;
			for (const client of this.#clients) this.#sendResetAndWelcome(client);
			return true;
		} finally {
			this.#paused = false;
		}
	}

	/** Start a fresh in-memory session. Same broadcast contract as switchSession. */
	async newSession(): Promise<boolean> {
		if (this.#paused) return false;
		this.#paused = true;
		try {
			const ok = await this.#session.newSession();
			if (!ok) return false;
			for (const client of this.#clients) this.#sendResetAndWelcome(client);
			return true;
		} finally {
			this.#paused = false;
		}
	}

	#sendResetAndWelcome(client: { send(obj: unknown): void }): void {
		// Custom frame — see useAgent.ts. Tells the client to drop any in-flight
		// stream ghost, active tools, and pending entries; the subsequent welcome
		// then seeds the new transcript fresh. Not part of the shared wire protocol.
		sendFrame(client, { t: "reset" } as unknown as HostFrame);
		this.sendWelcomeTo(client);
	}

	handlePrompt(text: string): void {
		// Auto-generate a session title from the first user message, mirroring
		// input-controller's path. Web mode bypasses input-controller entirely,
		// so without this the header title stays empty until a /rename. Only
		// fires when no name is set yet and titling isn't disabled (--no-title).
		this.#maybeGenerateTitle(text);
		this.#session.prompt(text).catch(() => {});
	}

	handleAbort(): void {
		this.#session.abort().catch(() => {});
	}

	#buildState(): SessionState {
		return {
			isStreaming: this.#session.isStreaming,
			queuedMessageCount: this.#session.queuedMessageCount,
			sessionName: this.#session.sessionName ?? undefined,
			cwd: this.#opts.cwd,
			model: this.#session.model
				? {
						id: this.#session.model.id,
						name: this.#session.model.id,
						provider: this.#session.model.provider,
						contextWindow: this.#session.model.contextWindow ?? 0,
					}
				: undefined,
			contextUsage: this.#session.getContextUsage() ?? undefined,
			participants: [],
		};
	}

	#buildHeader(): SessionHeader {
		return {
			type: "session",
			id: this.#session.sessionId,
			title: this.#session.sessionName ?? undefined,
			timestamp: toTimestamp(),
			cwd: this.#opts.cwd,
		};
	}

	/** Push the current state to every connected client. */
	#broadcastState(): void {
		const state = this.#buildState();
		for (const client of this.#clients) {
			sendFrame(client, { t: "state", state } as HostFrame);
		}
	}

	/** Convert session.messages (AgentMessage[]) into the SessionEntry[] that
	 *  ships in the welcome snapshot. Lives next to the existing buildEntry()
	 *  helper for the live event path so the two stay in sync. */
	#buildEntries(): SessionEntry[] {
		const out: SessionEntry[] = [];
		for (const raw of this.#session.messages) {
			const entry = buildEntry(raw);
			if (entry) out.push(entry);
		}
		return out;
	}

	#maybeGenerateTitle(text: string): void {
		const mgr = this.#session.sessionManager;
		if (mgr.getSessionName()) return;
		if ($env.PI_NO_TITLE) return;
		// Capture the session identity at call time. If a switchSession occurs
		// while the title generation is in flight, the `then` block detects the
		// mismatch and drops the stale result instead of writing session-A's
		// first message into session-B's name.
		const sessionId = this.#session.sessionId;
		generateSessionTitle(
			text,
			this.#session.modelRegistry,
			this.#session.settings,
			sessionId,
			this.#session.model ?? undefined,
			(provider: string) => this.#session.agent.metadataForProvider(provider),
			this.#session.titleSystemPrompt,
		)
			.then(async title => {
				// Re-check after the async gap: session may have been switched.
				if (this.#session.sessionId !== sessionId) return;
				if (title && !mgr.getSessionName()) {
					await mgr.setSessionName(title, "auto");
				}
			})
			.catch(err => {
				logger.warn("web-mode: auto-title error", {
					sessionId,
					reason: "auto-title-error",
					error: err instanceof Error ? err.message : String(err),
				});
			});
	}
}

// ---------------------------------------------------------------------------
// Build SessionEntry from a message_end event
// ---------------------------------------------------------------------------

function buildEntry(message: unknown): SessionEntry | null {
	if (!message || typeof message !== "object") return null;
	if (!("role" in message)) return null;
	const role = message.role;
	// Only user/assistant/toolResult become visible entries; the other roles
	// (developer/custom) are skipped on purpose — collab-web doesn't render them.
	if (role !== "user" && role !== "assistant" && role !== "toolResult") return null;
	const ts = "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : undefined;
	// Messages have no stable id of their own; synthesize a unique one per emission.
	const id = `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
	// role-narrowed to {user, assistant, toolResult} — a strict subset of WireMessage.
	// Compiler can't prove the narrowing from `unknown`, but the `role` check above
	// guarantees we never feed a developer/custom message into a message entry.
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: toTimestamp(ts),
		message: message as unknown as WireMessage,
	};
}
