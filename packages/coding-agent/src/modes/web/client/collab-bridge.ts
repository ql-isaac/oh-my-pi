/**
 * Thin bridge: useAgent returns data in collab-native format (HostFrame-sourced),
 * so the bridge just wraps it into GuestSnapshot for Composer.
 */

import type { GuestClient, GuestSnapshot, SessionHeader, AgentSnapshot, SubagentProgressPayload, SubagentLifecyclePayload } from "../../../collab-web/src/lib/client";
import type { UseAgentReturn } from "./useAgent";

export function buildGuestClient(agent: UseAgentReturn): GuestClient {
	return {
		sendPrompt(text: string) { agent.sendPrompt(text); },
		sendAbort() { agent.abort(); },
		sendUiResponse() {},
	} as unknown as GuestClient;
}

export function buildSnapshot(agent: UseAgentReturn): GuestSnapshot {
	const header: SessionHeader = {
		type: "session",
		id: "web-mode",
		title: agent.state?.sessionName ?? undefined,
		timestamp: new Date().toISOString(),
		cwd: agent.state?.cwd ?? "",
	};
	return {
		phase: agent.phase,
		endedReason: agent.endedReason,
		header,
		entries: agent.entries,
		state: agent.state,
		agents: Object.freeze([]) as readonly AgentSnapshot[],
		progress: new Map<string, SubagentProgressPayload>(),
		lifecycle: new Map<string, SubagentLifecyclePayload>(),
		stream: agent.stream,
		streamDone: agent.streamDone,
		activeTools: agent.activeTools,
		working: agent.working,
		readOnly: false,
		uiRequest: null,
		notices: Object.freeze([]),
	} as GuestSnapshot;
}
