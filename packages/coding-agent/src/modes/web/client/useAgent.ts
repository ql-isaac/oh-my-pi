/**
 * React hook that consumes collab HostFrame messages over WebSocket.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentSnapshot, HostFrame, SessionEntry, SessionHeader, SessionState, AgentEvent, AssistantMessage, ActiveTool, SubagentProgressPayload, SubagentLifecyclePayload } from "@oh-my-pi/pi-wire";
import type { Notice, TranscriptResult } from "@oh-my-pi/collab-web/guest-client";

export type ConnectionPhase = "connecting" | "selecting" | "live" | "reconnecting" | "ended";

export interface SessionListItem {
	path: string;
	id: string;
	cwd: string;
	title: string;
	created: number;
	modified: number;
	messageCount: number;
	firstMessage: string;
	status?: string;
}

export interface SessionListPayload {
	local: SessionListItem[];
	all: SessionListItem[];
	cwd: string;
}

export interface UseAgentReturn {
	phase: ConnectionPhase;
	endedReason: string | null;
	entries: readonly SessionEntry[];
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	working: boolean;
	state: SessionState | null;
	header: SessionHeader | null;
	agents: readonly AgentSnapshot[];
	progress: ReadonlyMap<string, SubagentProgressPayload>;
	lifecycle: ReadonlyMap<string, SubagentLifecyclePayload>;
	notices: readonly Notice[];
	sessionList: SessionListPayload | null;
	sessionListError: string | null;
	switching: boolean;
	sendPrompt: (text: string) => void;
	abort: () => void;
	reconnect: () => void;
	selectSession: (path: string) => void;
	newSession: () => void;
	refreshSessionList: () => void;
	deleteSession: (path: string) => Promise<boolean>;
	sendAgentCmd: (cmd: "chat" | "kill" | "revive", agentId: string, text?: string) => void;
	fetchTranscript: (agentId: string, fromByte: number) => Promise<TranscriptResult | null>;
}

function wsUrl(): string {
	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	return `${proto}//${location.host}/ws`;
}

export function useAgent(opts?: { initialSessionId?: string }): UseAgentReturn {
	const wsRef = useRef<WebSocket | null>(null);
	const reconnectRef = useRef<Timer | undefined>(undefined);
	const pendingChunks = useRef<SessionEntry[]>([]);
	const chunkFinalRef = useRef(false);
	const pendingTranscripts = useRef(new Map<number, { resolve: (r: TranscriptResult | null) => void; timer: Timer }>());
	const reqSeqRef = useRef(0);
	const noticeSeqRef = useRef(0);

	const [phase, setPhase] = useState<ConnectionPhase>("connecting");
	const [endedReason, setEndedReason] = useState<string | null>(null);
	const [entries, setEntries] = useState<readonly SessionEntry[]>([]);
	const [stream, setStream] = useState<AssistantMessage | null>(null);
	// Mirrors `streamDone` so the WebSocket onmessage closure (built once in
	// `connect`) can read the live value. The setter updates both - keeping the
	// ref in sync inside the call site avoids a render-boundary race where the
	// next message arrives before React commits the state change.
	const streamDoneRef = useRef(false);
	const [streamDone, setStreamDoneState] = useState(false);
	const setStreamDone = useCallback((d: boolean) => {
		streamDoneRef.current = d;
		setStreamDoneState(d);
	}, []);
	const [activeTools, setActiveTools] = useState<ReadonlyMap<string, ActiveTool>>(new Map());
	const [working, setWorking] = useState(false);
	const [state, setState] = useState<SessionState | null>(null);
	const [header, setHeader] = useState<SessionHeader | null>(null);
	const [agents, setAgents] = useState<readonly AgentSnapshot[]>([]);
	const [progress, setProgress] = useState<ReadonlyMap<string, SubagentProgressPayload>>(new Map());
	const [lifecycle, setLifecycle] = useState<ReadonlyMap<string, SubagentLifecyclePayload>>(new Map());
	const [notices, setNotices] = useState<readonly Notice[]>([]);
	const [sessionList, setSessionList] = useState<SessionListPayload | null>(null);
	const [sessionListError, setSessionListError] = useState<string | null>(null);
	/** Set while a `resume`/`new` is in flight; picker is disabled until the
	 *  server's `reset`+welcome completes. */
	const [switching, setSwitching] = useState(false);
	const initialId = opts?.initialSessionId;
	// Reset the transcript back to a clean slate. Called on `reset` frames from
	// the server (signals an imminent session switch) and never from anywhere
	const resetLocal = useCallback(() => {
		setEntries([]);
		setStream(null);
		setStreamDone(false);
		streamDoneRef.current = false;
		setActiveTools(new Map());
		setWorking(false);
		setAgents([]);
		setProgress(new Map());
		setLifecycle(new Map());
		setHeader(null);
		pendingChunks.current = [];
		chunkFinalRef.current = false;
	}, []);

	const pushNotice = useCallback((level: Notice["level"], message: string) => {
		setNotices(prev => {
			const next = [...prev, { id: ++noticeSeqRef.current, level, message, at: Date.now() }];
			if (next.length > 50) next.splice(0, next.length - 50);
			return next;
		});
	}, []);

	const connect = useCallback(() => {
		if (wsRef.current?.readyState === WebSocket.OPEN) return;
		setPhase("connecting");
		setEndedReason(null);
		resetLocal();
		setSwitching(false);
		pendingChunks.current = [];
		chunkFinalRef.current = false;

		const ws = new WebSocket(wsUrl());
		wsRef.current = ws;

		ws.onopen = () => {
			// Land in the picker first; the server emits a welcome only after
			// the user picks a session. If they want a fresh one, they hit
			// "new session" - the server then resets and welcomes.
			setPhase("selecting");
			fetchSessionList();
		};
		ws.onmessage = (event) => {
			let frame: HostFrame;
			try {
				frame = JSON.parse(event.data) as HostFrame;
			} catch {
				return;
			}

			switch (frame.t) {
				case "snapshot-chunk": {
					pendingChunks.current.push(...frame.entries);
					if (frame.final) chunkFinalRef.current = true;
					break;
				}
				case "welcome": {
					// chunkFinalRef tracks whether the snapshot stream is complete.
					// resetLocal() clears it; the trailing snapshot-chunk with
					// `final: true` re-arms it. When set, pendingChunks holds the
					// entire new transcript and we replace entries wholesale -
					// no prev-merge, no length guard: under React 18's auto
					// batching, multiple setState calls in one tick see a stale
					// `prev`, so any conditional skip silently drops the new
					// transcript when a prior session had populated entries.
					if (chunkFinalRef.current) {
						const queued = pendingChunks.current;
						pendingChunks.current = [];
						chunkFinalRef.current = false;
						setEntries(Object.freeze(queued));
					}
					setState(frame.state);
					setHeader(frame.header);
					setWorking(frame.state.isStreaming);
					setAgents(frame.agents ?? []);
					setProgress(new Map());
					setLifecycle(new Map());
					// Server has accepted our session pick and shipped the snapshot;
					// move out of the picker.
					setPhase("live");
					setSwitching(false);
					break;
				}
				// Web-mode-only frame: server is tearing down the current session
				// in response to a `resume`/`new` from this client. Drop every
				// in-flight UI hint (stream ghost, active tools, queued chunks)
				// so the upcoming welcome seeds a clean transcript.
				case "reset": {
					resetLocal();
					setSwitching(true);
					setPhase("selecting");
					break;
				}
				case "entry": {
					setEntries(prev => Object.freeze([...prev, frame.entry]));
					// streamDoneRef (not the captured `streamDone` state - that's
					// pinned to `false` in this closure) reflects whether the
					// message_end event already set a streaming ghost. When the
					// entry lands, drop the ghost so the entry owns the row.
					if (
						streamDoneRef.current &&
						frame.entry.type === "message" &&
						frame.entry.message.role === "assistant"
					) {
						setStream(null);
						setStreamDone(false);
					}
					break;
				}
				case "event": {
					handleEvent(frame.event, {
						setStream, setStreamDone, setActiveTools, setWorking, setState, pushNotice,
					});
					break;
				}
				case "state": {
					setState(frame.state);
					if (!frame.state.isStreaming) {
						setWorking(false);
						if (streamDoneRef.current) {
							setStream(null);
							setStreamDone(false);
						}
					}
					break;
				}
				case "error": {
					// Server-side failure (e.g. session switch rejected). Release the
					// stuck switching lock so the picker is interactive again.
					setSwitching(false);
					setSessionListError(frame.message ?? "unknown error");
					break;
				}
				case "bye": {
					setPhase("ended");
					setEndedReason(frame.reason);
					break;
				}
				case "agents": {
					setAgents(frame.agents);
					break;
				}
				case "bus": {
					if (frame.channel === "task:subagent:progress") {
						const payload = frame.data as SubagentProgressPayload;
						setProgress(prev => new Map(prev).set(payload.progress.id, payload));
					} else if (frame.channel === "task:subagent:lifecycle") {
						const payload = frame.data as SubagentLifecyclePayload;
						setLifecycle(prev => new Map(prev).set(payload.id, payload));
					}
					break;
				}
				case "transcript": {
					const pending = pendingTranscripts.current.get(frame.reqId);
					if (pending) {
						pendingTranscripts.current.delete(frame.reqId);
						clearTimeout(pending.timer);
						pending.resolve(
							frame.error !== undefined
								? { kind: "error", message: frame.error }
								: { kind: "rows", text: frame.text, newSize: frame.newSize },
						);
					}
					break;
				}
			}
		};

		ws.onerror = () => { setPhase("reconnecting"); };
		ws.onclose = () => {
			setPhase("reconnecting");
			if (wsRef.current === ws) wsRef.current = null;
			reconnectRef.current = setTimeout(() => {
				if (wsRef.current) return;
				connect();
			}, 2000);
		};
	}, []);

	const sendGuestFrame = useCallback((frame: Record<string, unknown>) => {
		wsRef.current?.send(JSON.stringify(frame));
	}, []);

	const sendPrompt = useCallback((text: string) => {
		sendGuestFrame({ t: "prompt", text });
	}, [sendGuestFrame]);

	const abort = useCallback(() => {
		sendGuestFrame({ t: "abort" });
	}, [sendGuestFrame]);

	const fetchSessionList = useCallback(async () => {
		setSessionListError(null);
		try {
			const res = await fetch("/api/sessions");
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as SessionListPayload;
			setSessionList(data);
		} catch (e) {
			setSessionListError(e instanceof Error ? e.message : String(e));
		}
	}, []);

	const selectSession = useCallback((path: string) => {
		if (switching) return;
		setSwitching(true);
		sendGuestFrame({ t: "resume", path });
	}, [sendGuestFrame, switching]);

	const newSession = useCallback(() => {
		if (switching) return;
		setSwitching(true);
		sendGuestFrame({ t: "new" });
	}, [sendGuestFrame, switching]);

	const deleteSession = useCallback(async (path: string): Promise<boolean> => {
		try {
			const res = await fetch("/api/sessions/delete", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path }),
			});
			const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
			if (!res.ok || !data.ok) {
				setSessionListError(data.error ?? `HTTP ${res.status}`);
				return false;
			}
			// Refresh the list so the deleted row disappears; preserves order/filtering.
			await fetchSessionList();
			return true;
		} catch (e) {
			setSessionListError(e instanceof Error ? e.message : String(e));
			return false;
		}
	}, [fetchSessionList]);

	// If the user navigated directly to /session/<id>, resolve the ID from the
	// session list and auto-switch to that session once the list arrives.
	const [initialIdResolved, setInitialIdResolved] = useState(false);

	useEffect(() => {
		if (!initialId || initialIdResolved) return;
		if (phase !== "selecting" || switching || !sessionList) return;
		// Try local sessions first, then all sessions
		const match = sessionList.local.find(s => s.id.startsWith(initialId))
			?? sessionList.all.find(s => s.id.startsWith(initialId));
		if (match) {
			setInitialIdResolved(true);
			selectSession(match.path);
		}
	}, [initialId, initialIdResolved, phase, switching, sessionList, selectSession]);

	useEffect(() => {
		connect();
		return () => {
			clearTimeout(reconnectRef.current);
			wsRef.current?.close();
		};
	}, [connect]);

	const reconnect = useCallback(() => {
		wsRef.current?.close();
		wsRef.current = null;
		setHeader(null);
		connect();
	}, [connect]);

	return {
	phase, endedReason, entries, stream, streamDone, activeTools, working, state, header,
		agents, progress, lifecycle, notices,
		sessionList, sessionListError, switching,
		sendPrompt, abort, reconnect, selectSession, newSession, refreshSessionList: fetchSessionList,
		deleteSession,
		sendAgentCmd: (cmd: "chat" | "kill" | "revive", agentId: string, text?: string) => sendGuestFrame({ t: "agent-cmd", cmd, agentId, text }),
		fetchTranscript: (agentId: string, fromByte: number) => {
			const reqId = ++reqSeqRef.current;
			const { promise, resolve } = Promise.withResolvers<TranscriptResult | null>();
			const timer = setTimeout(() => { pendingTranscripts.current.delete(reqId); resolve(null); }, 10_000);
			pendingTranscripts.current.set(reqId, { resolve, timer });
			sendGuestFrame({ t: "fetch-transcript", reqId, agentId, fromByte });
			return promise;
		},
	};
}

function handleEvent(
	event: AgentEvent,
	ctx: {
		setStream: (s: AssistantMessage | null) => void;
		setStreamDone: (d: boolean) => void;
		setActiveTools: (cb: (prev: Map<string, ActiveTool>) => Map<string, ActiveTool>) => void;
		setWorking: (w: boolean) => void;
		setState: (s: SessionState | ((prev: SessionState | null) => SessionState | null)) => void;
		pushNotice: (level: Notice["level"], message: string) => void;
	},
): void {
	switch (event.type) {
		case "message_start":
		case "message_update":
			if (event.message.role === "assistant") {
				ctx.setStream(event.message);
				ctx.setStreamDone(false);
			}
			break;
		case "message_end":
			if (event.message.role === "assistant") {
				ctx.setStream(event.message);
				ctx.setStreamDone(true);
			}
			break;
		case "tool_execution_start":
			ctx.setActiveTools(prev => new Map(prev).set(event.toolCallId, {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				intent: event.intent,
				startedAt: Date.now(),
			}));
			break;
		case "tool_execution_update":
			ctx.setActiveTools(prev => {
				const existing = prev.get(event.toolCallId);
				if (!existing) return prev;
				return new Map(prev).set(event.toolCallId, { ...existing, partialResult: event.partialResult });
			});
			break;
		case "tool_execution_end":
			ctx.setActiveTools(prev => {
				const next = new Map(prev);
				next.delete(event.toolCallId);
				return next;
			});
			break;
		case "agent_start":
			ctx.setWorking(true);
			break;
		case "agent_end":
			ctx.setWorking(false);
			break;
		case "notice":
			ctx.pushNotice(event.level, event.message);
			break;
		case "auto_retry_start":
			ctx.pushNotice("info", `retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`);
			break;
		case "auto_compaction_start":
			ctx.pushNotice("info", `compacting context (${event.reason})`);
			break;
		case "auto_compaction_end":
			if (!event.skipped) {
				ctx.pushNotice("info", event.aborted ? "compaction aborted" : event.errorMessage ? `compaction failed: ${event.errorMessage}` : "context compacted");
			}
			break;
	}
}
