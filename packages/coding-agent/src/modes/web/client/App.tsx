import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAgent } from "./useAgent";
import { buildSnapshot, buildGuestClient } from "./collab-bridge";
import { SessionPicker } from "./SessionPicker";

import { Transcript } from "@oh-my-pi/collab-web/transcript";
import { HeaderBar } from "@oh-my-pi/collab-web/header-bar";
import { Composer } from "@oh-my-pi/collab-web/composer";
import { Banners } from "@oh-my-pi/collab-web/banners";
import { Toasts } from "@oh-my-pi/collab-web/toasts";
import { AgentsPanel } from "@oh-my-pi/collab-web/agents-panel";
import { AgentDrawer } from "@oh-my-pi/collab-web/agent-drawer";
import type { ToolRenderHost } from "@oh-my-pi/collab-web/tool-render";

export function App({ initialSessionId }: { initialSessionId?: string }): ReactNode {
	const agent = useAgent({ initialSessionId });
	const snap = useMemo(() => buildSnapshot(agent), [agent]);
	// buildGuestClient wraps agent's useCallback-stable methods (sendPrompt,
	// abort, sendAgentCmd, fetchTranscript) - so the wrapper itself is stable
	// across renders even though `agent` is a fresh object each render. The
	// empty-deps memo prevents AgentDrawer's polling useEffect from re-running
	// on every render (it lists `client` in its deps); re-running it calls
	// setEntries([]) which blanks the transcript and causes visible flicker.
	const client = useMemo(() => buildGuestClient(agent), []);
	const [railOpen, setRailOpen] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const autoOpenedRef = useRef(false);

	// Handle browser back/forward. Two cases:
	// - pathname is /                          -> return to picker (reconnect)
	// - pathname is /session/<id> (different  -> reopen that session
	//   from the current one, e.g. user backed
	//   out of a session into another one)
	useEffect(() => {
		const onPop = () => {
			const path = window.location.pathname;
			if (path === "/") { agent.reconnect(); return; }
			const m = path.match(/^\/session\/([^/]+)$/);
			if (m) {
				const id = m[1];
				const match = agent.sessionList?.local.find(s => s.id.startsWith(id))
					?? agent.sessionList?.all.find(s => s.id.startsWith(id));
				if (match) agent.selectSession(match.path);
			}
		};
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, [agent.reconnect, agent.selectSession, agent.sessionList]);

	// Drive URL from the live session header. The welcome frame sets the
	// real session id; resetLocal() and reconnect() clear it back to null.
	// - header set -> /session/<id> (the shareable, direct-access URL)
	// - header null -> / (the picker)
	// pushState (not replaceState) so the back button moves from a session
	// back to the picker, and from the picker back to whatever preceded it.
	const headerId = snap.header?.id;
	useEffect(() => {
		const target = headerId ? `/session/${headerId}` : "/";
		if (window.location.pathname !== target) history.pushState(null, "", target);
}, [headerId]);

// Auto-open the rail the first time a subagent appears. Must be declared
// before the early returns below - otherwise phase transitions from
// 'selecting' to 'live' would change the hook count, violating Rules of Hooks.
const subCount = snap.agents.filter(a => a.kind === "sub").length;
useEffect(() => {
	if (subCount > 0 && !autoOpenedRef.current) {
		autoOpenedRef.current = true;
		setRailOpen(true);
	}
}, [subCount]);



	if (agent.phase === "connecting" || agent.phase === "ended") {
		return (
			<div className="sh-connect">
				<div className="sh-connect-card">
					<div className="sh-brand-mark">⚡</div>
					<div className="sh-connect-text">
						{agent.phase === "connecting" ? "Connecting…" : `Ended: ${agent.endedReason ?? "unknown"}`}
					</div>
				</div>
			</div>
		);
	}

	// `selecting` lands here on first connect and after every session switch the
	// server drives; the picker drives `selectSession`/`newSession` which round
	// trip back through the server's `reset`+welcome before phase flips to live.
	if (agent.phase === "selecting") {
		return (
			<SessionPicker
				list={agent.sessionList}
				error={agent.sessionListError}
				loading={!agent.sessionList && !agent.sessionListError}
				switching={agent.switching}
				cwd={agent.sessionList?.cwd ?? ""}
				onSelect={(path) => {
					agent.selectSession(path);
					// URL is updated by the header-driven useEffect above once the
					// server's welcome frame arrives with the real session id.
				}}
				onNew={() => {
					agent.newSession();
					// Same: welcome frame's header.id drives the URL.
				}}
				onRefresh={agent.refreshSessionList}
				onDelete={agent.deleteSession}
			/>
		);
	}



	const agentIds = new Set(snap.agents.map(a => a.id));
	const toolHost: ToolRenderHost = {
		hasAgent: id => agentIds.has(id),
		openAgent: id => { if (agentIds.has(id)) setSelectedId(id); },
	};

	const drawerAgent = selectedId != null ? snap.agents.find(a => a.id === selectedId) : undefined;

	return (
		<div className="sh-app">
			<HeaderBar
				snapshot={snap}
				subCount={subCount}
				railOpen={railOpen}
				onToggleRail={() => setRailOpen(open => !open)}
				onLeave={() => { agent.reconnect(); }}
			/>
			<main className="sh-main">
				<section className="sh-content" data-rail={railOpen ? "true" : "false"}>
					<div className="sh-transcript">
						<Transcript
							entries={agent.entries}
							stream={agent.stream}
							streamDone={agent.streamDone}
							activeTools={agent.activeTools}
							working={agent.working}
							host={toolHost}
						/>
					</div>
				</section>
				{railOpen && (
					<>
						<div className="sh-rail-backdrop" onClick={() => setRailOpen(false)} />
						<aside className="sh-rail">
							<AgentsPanel
								agents={snap.agents}
								progress={snap.progress}
								lifecycle={snap.lifecycle}
								selectedId={selectedId}
								onSelect={setSelectedId}
							/>
						</aside>
					</>
				)}
			</main>
			<Composer client={client} snapshot={snap} />
			{drawerAgent && (
				<>
					<div className="ag-drawer-backdrop" onClick={() => setSelectedId(null)} />
					<AgentDrawer
						agent={drawerAgent}
						progress={snap.progress.get(drawerAgent.id)}
						client={client}
						readOnly={snap.readOnly}
						host={toolHost}
						onClose={() => setSelectedId(null)}
					/>
				</>
			)}
			<Banners phase={snap.phase} endedReason={snap.endedReason} onRejoin={agent.reconnect} onNewLink={agent.reconnect} />
			<Toasts notices={snap.notices} />
		</div>
	);
}
