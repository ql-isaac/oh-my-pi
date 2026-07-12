import { useEffect, useMemo, type ReactNode } from "react";
import { useAgent } from "./useAgent";
import { buildSnapshot, buildGuestClient } from "./collab-bridge";
import { SessionPicker } from "./SessionPicker";

import { Transcript } from "@oh-my-pi/collab-web/transcript";
import { HeaderBar } from "@oh-my-pi/collab-web/header-bar";
import { Composer } from "@oh-my-pi/collab-web/composer";
import { Banners } from "@oh-my-pi/collab-web/banners";

export function App({ initialSessionId }: { initialSessionId?: string }): ReactNode {
	const agent = useAgent({ initialSessionId });
	const snap = useMemo(() => buildSnapshot(agent), [agent]);
	const client = useMemo(() => buildGuestClient(agent), [agent]);

	// Handle browser back/forward: if the URL returns to /, the server
	// doesn't emit a reset frame — just go back to the picker.
	useEffect(() => {
		const onPop = () => {
			const path = window.location.pathname;
			if (path === "/" || path === "") {
				agent.reconnect();
			} else if (path.startsWith("/session/")) {
				// Back to a session URL - find it in the list and select
				const id = path.replace("/session/", "");
				const s = agent.sessionList?.local.find(s => s.id.startsWith(id))
					?? agent.sessionList?.all.find(s => s.id.startsWith(id));
				if (s) agent.selectSession(s.path);
			}
		};
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, [agent.reconnect, agent.selectSession, agent.sessionList]);

	if (agent.phase === "connecting" || agent.phase === "ended") {
		return (
			<div className="sh-connect">
				<div className="sh-connect-card">
					<div className="sh-connect-head">
						<div className="sh-lockup">
							<span className="sh-lockup-mark">{"\u{1F916}"}</span>
						</div>
						<h2>{agent.phase === "connecting" ? "Connecting..." : agent.endedReason ?? "Disconnected"}</h2>
					</div>
					<p className="sh-connect-sub">
						{agent.phase === "connecting" ? "Connecting to agent..." : "The agent process is not running."}
					</p>
					<button type="button" className="sh-btn sh-btn-primary" onClick={agent.reconnect}>
						Reconnect
					</button>
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
				loading={agent.sessionList === null && agent.sessionListError === null}
				switching={agent.switching}
				cwd={agent.sessionList?.cwd ?? agent.state?.cwd ?? ""}
				onSelect={(path) => {
					agent.selectSession(path);
					// Update the URL so the session is bookmarked and shareable.
					// The session ID comes from the list we just fetched.
					const session = agent.sessionList?.local.find(s => s.path === path)
						?? agent.sessionList?.all.find(s => s.path === path);
					const id = session?.id;
					if (id) {
						history.pushState({ sessionId: id }, "", `/session/${id}`);
					}
				}}
				onNew={agent.newSession}
				onRefresh={agent.refreshSessionList}
				onDelete={agent.deleteSession}
			/>
		);
	}

	return (
		<div className="sh-app">
			<HeaderBar snapshot={snap} subCount={0} railOpen={false} onToggleRail={() => {}} onLeave={() => { agent.reconnect(); history.pushState(null, "", "/"); }} />
			<main className="sh-main">
				<section className="sh-content">
					<div className="sh-transcript">
						<Transcript
							entries={agent.entries}
							stream={agent.stream}
							streamDone={agent.streamDone}
							activeTools={agent.activeTools}
							working={agent.working}
						/>
					</div>
				</section>
			</main>
			<Composer client={client} snapshot={snap} />
			<Banners phase={snap.phase} endedReason={snap.endedReason} onRejoin={agent.reconnect} onNewLink={agent.reconnect} />
		</div>
	);
}
