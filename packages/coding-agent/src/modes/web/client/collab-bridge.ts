/**
 * Thin bridge: useAgent returns data in collab-native format (HostFrame-sourced),
 * so the bridge just wraps it into GuestSnapshot for Composer.
 */

import type { GuestClient, GuestSnapshot, SessionHeader } from "../../../collab-web/src/lib/client";
import type { UseAgentReturn } from "./useAgent";

export function buildGuestClient(agent: UseAgentReturn): GuestClient {
	return {
		sendPrompt(text: string) { agent.sendPrompt(text); },
		sendAbort() { agent.abort(); },
		sendUiResponse() {},
		sendAgentCmd(cmd: "chat" | "kill" | "revive", agentId: string, text?: string) { agent.sendAgentCmd(cmd, agentId, text); },
		fetchTranscript(agentId: string, fromByte: number) { return agent.fetchTranscript(agentId, fromByte); },
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
		agents: agent.agents,
		progress: agent.progress,
		lifecycle: agent.lifecycle,
		stream: agent.stream,
		streamDone: agent.streamDone,
		activeTools: agent.activeTools,
		working: agent.working,
		readOnly: false,
		uiRequest: null,
		notices: agent.notices,
	} as GuestSnapshot;
}
