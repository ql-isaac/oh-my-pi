/**
 * Web mode: serve a web UI for the coding agent.
 *
 * Architecture:
 *   Browser (React SPA) ← WebSocket (collab HostFrame) → Bun.serve ← session events → AgentSession
 *
 * Runs directly in the agent process (like RPC mode), subscribes to session
 * events, and emits collab-protocol HostFrame messages over WebSocket.
 *
 * Usage:
 *   omp --mode web                 (default port 3000)
 *   omp --mode web --port 8080     (custom port)
 *   omp --mode web --web-open      (open browser automatically)
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getProjectDir, getSessionsDir, logger } from "@oh-my-pi/pi-utils";
import { listAllSessions, listSessions, type SessionInfo } from "../../session/session-listing";

import { FileSessionStorage } from "../../session/session-storage";
import type { AgentSession } from "../../session/agent-session";
import type { EventBus } from "../../utils/event-bus";
import { CollabHost } from "./collab-host";
// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface WebModeOptions {
	port?: number;
	host?: string;
	open?: boolean;
	/** Factory: creates a fresh AgentSession + its EventBus. With a path, opens an existing session; without, creates a new empty one. */
	forkSession?: (path?: string) => Promise<{ session: AgentSession; eventBus: EventBus }>;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function runWebMode(
	options: WebModeOptions = {},
): Promise<never> {
	const port = options.port ?? 3000;
	const host = options.host ?? "127.0.0.1";
	const cwd = process.cwd();

	// Collab host — each session path gets its own AgentSession on demand.
	const collabHost = new CollabHost({
		cwd,
		forkSession: options.forkSession ?? (async () => { throw new Error("forkSession not provided"); }),
	});

	// Resolve client directories
	const clientDir = path.resolve(import.meta.dir, "client");
	const builtClientDir = path.resolve(import.meta.dir, "..", "..", "..", "dist", "web-client");

	// Client registry: maps connected WebSocket to the collab-host client
	// wrapper so the close handler can unregister and avoid zombie clients.
	const clientsByWs = new WeakMap<import("bun").ServerWebSocket, { send(obj: unknown): void }>();
	const sessionsRoot = getSessionsDir();
	const server = Bun.serve({
		port,
		hostname: host,
		async fetch(req) {
			const url = new URL(req.url);
			const pathname = url.pathname;
			// WebSocket upgrade
			if (pathname === "/ws" && req.headers.get("upgrade") === "websocket") {
				// Origin check: when the server binds to a non‑localhost address,
				// reject cross‑origin WebSocket upgrades so an arbitrary webpage
				// on a third‑party host cannot command the agent session.
				const origin = req.headers.get("origin");
				const isLocal = host === "127.0.0.1" || host === "localhost" || host === "::1";
				if (!isLocal && origin) {
					const originHost = new URL(origin).host;
					if (originHost !== url.host) {
						return new Response("forbidden", { status: 403 });
					}
				}
				logger.debug("web-mode: WS upgrade request from", { host: url.host });
				const upgraded = server.upgrade(req);
				if (!upgraded) {
					logger.debug("web-mode: WS upgrade failed");
					return new Response("WebSocket upgrade failed", { status: 400 });
				}
				logger.debug("web-mode: WS upgrade succeeded");
				return undefined;
			}
			// REST API
			if (pathname === "/api/health") {
				return Response.json({ status: "ok", uptime: Date.now() });
			}
			if (pathname === "/api/sessions") {
				try {
					const storage = new FileSessionStorage();
					const [local, all] = await Promise.all([
						listSessions(getProjectDirOrCwd(cwd), storage),
						listAllSessions(storage),
					]);
					return Response.json({ local: toSessionListItems(local), all: toSessionListItems(all), cwd });
				} catch (e) {
					logger.warn("web-mode: /api/sessions failed", { error: e instanceof Error ? e.message : String(e) });
					return Response.json({ local: [], all: [], cwd }, { status: 200 });
				}
			}
			if (pathname === "/api/sessions/delete" && req.method === "POST") {
				try {
					const body = (await req.json().catch(() => null)) as { path?: unknown } | null;
					const target = body?.path;
					if (typeof target !== "string" || !target) {
						return Response.json({ ok: false, error: "missing path" }, { status: 400 });
					}
					// Path traversal guard: resolve against the sessions root;
					// reject anything that escapes the expected directory.
					if (!path.resolve(target).startsWith(sessionsRoot + path.sep)) {
						logger.warn("web-mode: /api/sessions/delete path outside sessions dir", { path: target });
						return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
					}
					const storage = new FileSessionStorage();
					try {
						await storage.deleteSessionWithArtifacts(target);
						return Response.json({ ok: true });
					} catch (e) {
						if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "ENOENT") {
							return Response.json({ ok: true });
						}
						const msg = e instanceof Error ? e.message : String(e);
						logger.warn("web-mode: /api/sessions/delete failed", { path: target, error: msg });
						return Response.json({ ok: false, error: msg }, { status: 500 });
					}
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					return Response.json({ ok: false, error: msg }, { status: 500 });
				}
			}
			let rootDir: string;

			try {
				await fs.access(path.join(builtClientDir, "index.html"));
				rootDir = builtClientDir;
			} catch {
				rootDir = clientDir;
			}

			const ext = path.extname(pathname);
			if (ext && MIME_TYPES[ext]) {
				const servePath = path.join(rootDir, pathname === "/" ? "index.html" : pathname);
				const file = Bun.file(servePath);
				if (await file.exists()) {
					return new Response(file, { headers: { "Content-Type": MIME_TYPES[ext] } });
				}
			}
			// SPA fallback
			const indexFile = Bun.file(path.join(rootDir, "index.html"));
			if (await indexFile.exists()) {
				return new Response(indexFile, { headers: { "Content-Type": "text/html" } });
			}
			return new Response("Not found", { status: 404 });
		},

		websocket: {
			open(ws) {
				logger.debug("web-mode: WS client connected");
				// Register the client but don't send welcome. The first welcome ships
				// only after the user picks a session (or hits "new session");
				// sending it eagerly here would race the picker UI and auto-flip
				// the client into the transcript view before they choose.
				const client = { send: (obj: unknown) => {
					try {
						const json = JSON.stringify(obj);
						ws.send(json);
					} catch (e) { logger.warn("web-mode: WS send error", { error: String(e) }); }
				} };
				clientsByWs.set(ws, client);
				collabHost.addClient(client);
			},
			message(ws, raw) {
				const text = typeof raw === "string" ? raw : raw instanceof Buffer ? raw.toString() : String(raw);
				try {
					const frame = JSON.parse(text) as Record<string, unknown>;
					const t = frame.t as string;
					if (t === "prompt") {
						const client = clientsByWs.get(ws);
						if (client) {
							collabHost.handlePrompt(client, frame.text as string ?? "").catch((err: unknown) => {
								const msg = err instanceof Error ? err.message : String(err);
								logger.warn("web-mode: handlePrompt rejected", { error: msg });
								client.send(JSON.stringify({ t: "error", message: msg }));
							});
						}
					} else if (t === "abort") {
						const client = clientsByWs.get(ws);
						if (client) collabHost.handleAbort(client);
					} else if (t === "resume") {
						const target = frame.path as string | undefined;
						const client = clientsByWs.get(ws);
						if (target && client) {
							collabHost.switchSessionForClient(client, target).then(ok => {
								if (!ok && client) {
									client.send(JSON.stringify({ t: "error", message: "failed to switch session" }));
								}
							}).catch((err: unknown) => {
								const msg = err instanceof Error ? err.message : String(err);
								logger.warn("web-mode: switchSession rejected", { error: msg });
								client.send(JSON.stringify({ t: "error", message: msg }));
							});
						}
					} else if (t === "new") {
						const client = clientsByWs.get(ws);
						if (client) {
							collabHost.newSessionForClient(client).then(ok => {
								if (!ok && client) {
									client.send(JSON.stringify({ t: "error", message: "failed to create new session" }));
								}
							}).catch((err: unknown) => {
								const msg = err instanceof Error ? err.message : String(err);
								logger.warn("web-mode: newSession rejected", { error: msg });
								client.send(JSON.stringify({ t: "error", message: msg }));
							});
						}
					} else if (t === "agent-cmd") {
						const client = clientsByWs.get(ws);
						if (client) collabHost.handleAgentCmd(client, frame.cmd as "chat" | "kill" | "revive", frame.agentId as string, frame.text as string | undefined);
					} else if (t === "fetch-transcript") {
						const client = clientsByWs.get(ws);
						if (client) collabHost.handleFetchTranscript(client, frame.reqId as number, frame.agentId as string, frame.fromByte as number).catch((err: unknown) => {
							logger.warn("web-mode: fetchTranscript rejected", { error: String(err) });
						});
					}
				} catch {
					// ignore invalid frames
				}
			},
			close(ws) {
				logger.debug("web-mode: WS client disconnected");
				const client = clientsByWs.get(ws);
				if (client) {
					collabHost.removeClient(client);
					clientsByWs.delete(ws);
				}
			},
		},
	});

	const url = `http://${host}:${server.port}`;
	logger.info(`web-mode: server listening at ${url}`);
	if (options.open) {
		void Bun.$`open ${url}`.nothrow().quiet();
	}

	process.on("SIGINT", async () => {
		logger.info("web-mode: shutting down...");
		server.stop();
		process.exit(0);
	});
	process.on("SIGTERM", async () => {
		logger.info("web-mode: shutting down...");
		server.stop();
		process.exit(0);
	});

	await new Promise(() => {});
	process.exit(0);
}

// ---------------------------------------------------------------------------
// Session list
// ---------------------------------------------------------------------------

interface SessionListItem {
	path: string;
	id: string;
	cwd: string;
	title: string;
	created: number;
	modified: number;
	messageCount: number;
	firstMessage: string;
	status?: SessionInfo["status"];
}

function toSessionListItems(list: SessionInfo[]): SessionListItem[] {
	return list.map(info => ({
		path: info.path,
		id: info.id,
		cwd: info.cwd,
		title: info.title ?? info.firstMessage ?? "(untitled)",
		created: info.created.getTime(),
		modified: info.modified.getTime(),
		messageCount: info.messageCount,
		firstMessage: info.firstMessage,
		status: info.status,
	}));
}
function getProjectDirOrCwd(fallback: string): string {
	try {
		return getProjectDir() || fallback;
	} catch {
		return fallback;
	}
}

const MIME_TYPES: Record<string, string> = {
	".html": "text/html",
	".js": "text/javascript",
	".ts": "text/typescript",
	".tsx": "text/typescript",
	".css": "text/css",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
};

// ---------------------------------------------------------------------------
// CLI helper
// ---------------------------------------------------------------------------

export function parseWebModeArgs(argv: string[]): WebModeOptions {
	const options: WebModeOptions = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--port" && i + 1 < argv.length) options.port = Number.parseInt(argv[++i], 10);
		if (argv[i] === "--host" && i + 1 < argv.length) options.host = argv[++i];
		if (argv[i] === "--web-open") options.open = true;
	}
	return options;
}
