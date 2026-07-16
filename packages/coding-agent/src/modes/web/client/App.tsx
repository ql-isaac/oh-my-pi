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
	const client = useMemo(() => buildGuestClient(agent), [agent]);
	const [railOpen, setRailOpen] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const autoOpenedRef = useRef(false);

	// Handle browser back/forward: if the URL returns to /, the server
	// doesn't emit a reset frame - just go back to the picker.
	useEffect(() => {
		const onPop = () => {
			const path = window.location.pathname;
			if (path === "/") {
				agent.reconnect();
			}
		};
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, [agent.reconnect, agent.selectSession, agent.sessionList]);

	// Auto-open the rail the first time a subagent appears.
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
					history.pushState(null, "", "/");
				}}
				onNew={() => {
					agent.newSession();
					history.pushState(null, "", "/");
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
				onLeave={() => { agent.reconnect(); history.pushState(null, "", "/"); }}
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
