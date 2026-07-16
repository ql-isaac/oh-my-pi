/**
 * WebGuestLink - TUI-side WebSocket client that connects to the web mode
 * server and renders the remote session in the terminal.
 */

import * as path from "node:path";
import type { HostFrame, SessionEntry, SessionHeader, SessionState } from "@oh-my-pi/pi-wire";
import type { AgentSessionEvent } from "../../session/agent-session";
import type { SessionEntry as LocalSessionEntry } from "../../session/session-entries";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import type { CollabSessionState } from "../../collab/protocol";
import { getConfigRootDir, logger } from "@oh-my-pi/pi-utils";
import type { InteractiveModeContext } from "../types";
import { setSessionTerminalTitle } from "../../utils/title-generator";

interface SessionListItem { path: string; id: string; title: string; modified: number; }
interface SessionListResponse { local: SessionListItem[]; all: SessionListItem[]; cwd: string; }

const RECONNECT_DELAY_MS = 2000;
const WELCOME_TIMEOUT_MS = 15_000;

export class WebGuestLink {
	#ctx: InteractiveModeContext;
	#url: string;
	#ws: WebSocket | null = null;
	#welcomed = false;
	#left = false;
	#returnSessionFile: string | null = null;
	#applyChain: Promise<void> = Promise.resolve();
	#pendingEntries: SessionEntry[] = [];
	#pendingHeader: SessionHeader | null = null;
	#pendingState: SessionState | null = null;
	#pendingEntryCount = 0;
	#assistantStreamSynced = false;
	#reconnectTimer: Timer | null = null;
	#sessionPath: string | undefined;
	#firstWelcome: { resolve: () => void; reject: (err: Error) => void } | null = null;
	#welcomeTimer: Timer | null = null;

	state: SessionState | null = null;
	readonly readOnly = false;

	constructor(ctx: InteractiveModeContext, url: string) { this.#ctx = ctx; this.#url = url.replace(/\/$/, ""); }

	async connect(sessionPath?: string): Promise<void> {
		this.#returnSessionFile = this.#ctx.sessionManager.getSessionFile() ?? null;
		this.#sessionPath = sessionPath;
		await this.#openSocket();
		let resolvedPath = sessionPath;
		if (sessionPath && !sessionPath.includes("/") && !sessionPath.includes("\\") && !sessionPath.endsWith(".jsonl")) {
			resolvedPath = await this.#resolveSessionId(sessionPath);
		}
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#firstWelcome = { resolve, reject }; this.#armWelcomeTimer();
		if (resolvedPath) { this.#sessionPath = resolvedPath; this.#send({ t: "resume", path: resolvedPath }); }
		else { const p = await this.#pickSession(); this.#sessionPath = p ?? undefined; if (p) { this.#send({ t: "resume", path: p }); } else { this.#send({ t: "new" }); } }
		try { await promise; } catch (err) { this.#left = true; this.#ws?.close(); this.#ws = null; throw err; }
		finally { this.#firstWelcome = null; this.#clearWelcomeTimer(); }
		this.#ctx.webGuest = this; this.#ctx.showStatus("Connected to web session");
	}

	async leave(): Promise<void> {
		if (this.#left) return; this.#left = true;
		this.#clearReconnectTimer(); this.#clearWelcomeTimer();
		this.#ws?.close(); this.#ws = null;
		this.#ctx.webGuest = undefined; this.#ctx.statusLine.setCollabStatus(null);
		await this.#restoreLocalSession();
	}

	sendPrompt(text: string, _images?: ImageContent[]): void { this.#send({ t: "prompt", text }); }
	sendAbort(): void { this.#send({ t: "abort" }); }

	async #openSocket(): Promise<void> {
		const wsUrl = this.#url.replace(/^http/, "ws") + "/ws";
		const ws = new WebSocket(wsUrl); this.#ws = ws;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		ws.onopen = () => resolve();
		ws.onerror = () => reject(new Error(`Failed to connect to ${wsUrl}`));
		await promise;
		ws.onmessage = (ev: MessageEvent) => {
			let frame: HostFrame;
			try { frame = JSON.parse(ev.data as string) as HostFrame; }
			catch { logger.warn("web-guest: received non-JSON frame"); return; }
			this.#applyChain = this.#applyChain.then(() => this.#handleFrame(frame)).catch(err => logger.warn("web-guest frame fail", { type: frame.t, error: String(err) }));
		};
		ws.onclose = () => { if (!this.#left && this.#ws === ws) { this.#ctx.showStatus("Web session disconnected - reconnecting..."); this.#scheduleReconnect(); } };
		ws.onerror = () => {};
	}

	#scheduleReconnect(): void { this.#clearReconnectTimer(); this.#reconnectTimer = setTimeout(() => { this.#reconnectTimer = null; void this.#reconnect(); }, RECONNECT_DELAY_MS); }
	async #reconnect(): Promise<void> {
		if (this.#left) return;
		try { await this.#openSocket(); this.#welcomed = false; this.#assistantStreamSynced = false; this.#pendingEntries = []; this.#pendingHeader = null; this.#pendingState = null;
			const { promise, resolve, reject } = Promise.withResolvers<void>(); this.#firstWelcome = { resolve, reject }; this.#armWelcomeTimer();
			if (this.#sessionPath) { this.#send({ t: "resume", path: this.#sessionPath }); } else { this.#send({ t: "new" }); }
			await promise; this.#ctx.showStatus("Reconnected to web session"); } catch { this.#scheduleReconnect(); }
		finally { this.#firstWelcome = null; this.#clearWelcomeTimer(); }
	}
	#clearReconnectTimer(): void { if (this.#reconnectTimer !== null) { clearTimeout(this.#reconnectTimer); this.#reconnectTimer = null; } }

	async #handleFrame(frame: HostFrame): Promise<void> {
		switch (frame.t) {
			case "reset": { this.#welcomed = false; this.#assistantStreamSynced = false; this.#pendingEntries = []; this.#pendingHeader = null; this.#pendingState = null; this.#clearTransientUi(); return; }
			// snapshot-chunks may arrive before or after welcome. Only finalize when
			// both have arrived: header from welcome, final chunk or matching count.
			case "snapshot-chunk": { this.#pendingEntries.push(...frame.entries); if (frame.final && this.#pendingHeader) { await this.#finalizeSnapshot(); this.#firstWelcome?.resolve(); } return; }
			case "welcome": { this.#pendingHeader = frame.header; this.#pendingState = frame.state; this.#pendingEntryCount = frame.entryCount; if (frame.entryCount === 0 || this.#pendingEntries.length >= frame.entryCount) { await this.#finalizeSnapshot(); this.#firstWelcome?.resolve(); } return; }
			case "event": if (!this.#welcomed) return; this.#applyEvent(frame.event as AgentSessionEvent); return;
			case "entry": if (!this.#welcomed) return; try { this.#ctx.sessionManager.ingestReplicatedEntry(frame.entry as unknown as LocalSessionEntry); if (frame.entry.type === "message") { this.#ctx.session.agent.replaceMessages([...this.#ctx.session.messages, frame.entry.message as AgentMessage]); } } catch (err) { logger.warn("web-guest entry fail", { error: String(err) }); } return;
			case "state": if (!this.#welcomed) return; this.state = frame.state; this.#applyHostState(frame.state); setSessionTerminalTitle(frame.state.sessionName ?? "", frame.state.cwd); this.#updateStatusSegment(); this.#ctx.statusLine.invalidate(); this.#ctx.ui.requestRender(); return;
			case "error": if (!this.#welcomed) { this.#firstWelcome?.reject(new Error(frame.message)); } else { this.#ctx.showError(`Web host: ${frame.message}`); } return;
			case "bye": this.#ctx.showStatus(`Web session ended (${frame.reason})`); this.#ws?.close(); await this.#restoreLocalSession(); return;
			default: return;
		}
	}

	async #finalizeSnapshot(): Promise<void> {
		const header = this.#pendingHeader; const state = this.#pendingState; const entries = this.#pendingEntries;
		this.#pendingEntries = []; this.#pendingHeader = null; this.#pendingState = null;
		if (!header || this.#left) return;
		await Bun.write(path.join(getConfigRootDir(), "web-guest", `${header.id}.jsonl`), [header, ...entries].map(e => JSON.stringify(e)).join("\n") + "\n");
		this.#clearTransientUi(); await this.#ctx.session.switchSession(path.join(getConfigRootDir(), "web-guest", `${header.id}.jsonl`));
		if (state) { this.state = state; this.#applyHostState(state); reconcileGuestSnapshotHostState(this.#ctx, state.isStreaming); }
		this.#ctx.resetObserverRegistry(); this.#ctx.syncRunningSubagentBadge(); this.#assistantStreamSynced = false;
		setSessionTerminalTitle(state?.sessionName ?? header.title ?? "", state?.cwd ?? "");
		this.#ctx.chatContainer.clear(); this.#ctx.renderInitialMessages({ clearTerminalHistory: true }); await this.#ctx.reloadTodos(); this.#updateStatusSegment();
		this.#welcomed = true;
	}

	#applyEvent(event: AgentSessionEvent): void {
		if (event.type === "message_start" && event.message.role === "assistant") { this.#assistantStreamSynced = true; }
		else if (event.type === "message_update" && event.message.role === "assistant" && !this.#assistantStreamSynced) { this.#assistantStreamSynced = true; void this.#ctx.eventController.handleEvent({ type: "message_start", message: event.message }); }
		void this.#ctx.eventController.handleEvent(event);
	}

	#applyHostState(state: SessionState): void { const s = this.#ctx.session; if (state.model && (s.agent.state.model?.id !== state.model.id || s.agent.state.model?.provider !== state.model.provider)) { s.agent.setModel(state.model as unknown as Model); } }
	#updateStatusSegment(): void { this.#ctx.statusLine.setCollabStatus({ role: "guest", participantCount: 1, stateOverride: this.state as unknown as CollabSessionState }); }
	#clearTransientUi(): void { this.#ctx.statusContainer.clear(); this.#ctx.pendingMessagesContainer.clear(); this.#ctx.compactionQueuedMessages = []; this.#ctx.streamingComponent = undefined; this.#ctx.streamingMessage = undefined; this.#ctx.pendingTools.clear(); if (this.#ctx.loadingAnimation) { this.#ctx.loadingAnimation.stop(); this.#ctx.loadingAnimation = undefined; } }
	async #restoreLocalSession(): Promise<void> { if (this.#left) return; this.#left = true; this.#ws = null; this.#ctx.webGuest = undefined; this.#ctx.statusLine.setCollabStatus(null); this.#ctx.syncRunningSubagentBadge(); this.#ctx.resetObserverRegistry(); this.#clearTransientUi(); if (this.#returnSessionFile) { await this.#ctx.handleResumeSession(this.#returnSessionFile); return; } await this.#ctx.session.newSession(); setSessionTerminalTitle(this.#ctx.sessionManager.getSessionName(), this.#ctx.sessionManager.getCwd()); this.#ctx.statusLine.invalidate(); this.#ctx.statusLine.resetActiveTime(); this.#ctx.ui.requestRender(); this.#ctx.updateEditorBorderColor(); this.#ctx.renderInitialMessages({ clearTerminalHistory: true }); await this.#ctx.reloadTodos(); this.#ctx.ui.requestRender(true, { clearScrollback: true }); }

	#send(frame: object): void { if (this.#ws?.readyState === WebSocket.OPEN) { this.#ws.send(JSON.stringify(frame)); } }
	async #pickSession(): Promise<string | undefined> { try { const r = await fetch(`${this.#url}/api/sessions`); if (!r.ok) return undefined; const d = (await r.json()) as SessionListResponse; return d.local?.[0]?.path ?? d.all?.[0]?.path; } catch { return undefined; } }
	async #resolveSessionId(id: string): Promise<string | undefined> { try { const r = await fetch(`${this.#url}/api/sessions`); if (!r.ok) return undefined; const d = (await r.json()) as SessionListResponse; const li = id.toLowerCase(); const m = d.local.find(s => s.id.toLowerCase().startsWith(li)) ?? d.all.find(s => s.id.toLowerCase().startsWith(li)); return m?.path; } catch { return undefined; } }
	#armWelcomeTimer(): void { if (!this.#firstWelcome) return; this.#clearWelcomeTimer(); this.#welcomeTimer = setTimeout(() => { this.#welcomeTimer = null; this.#firstWelcome?.reject(new Error("Timed out waiting for web server welcome")); }, WELCOME_TIMEOUT_MS); }
	#clearWelcomeTimer(): void { if (this.#welcomeTimer !== null) { clearTimeout(this.#welcomeTimer); this.#welcomeTimer = null; } }
}

interface ReconcilerCtx { loadingAnimation: { stop(): void } | undefined; streamingComponent: unknown; streamingMessage: unknown; }
function reconcileGuestSnapshotHostState(ctx: ReconcilerCtx, isStreaming: boolean): void { if (!isStreaming) { if (ctx.loadingAnimation) { ctx.loadingAnimation.stop(); ctx.loadingAnimation = undefined; } ctx.streamingComponent = undefined; ctx.streamingMessage = undefined; } }
