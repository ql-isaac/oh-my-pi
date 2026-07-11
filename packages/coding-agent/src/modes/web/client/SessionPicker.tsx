/**
 * Session picker - the default landing page in web mode, mirroring `omp -r`
 * in the TUI. Lists local + cross-project sessions with status badges, a
 * per-row delete action (with inline confirmation, matching the TUI's
 * "Delete session? Yes/No" dialog), and a "new session" entry point.
 */

import { useMemo, useState, type ReactNode } from "react";
import type { SessionListItem, SessionListPayload } from "./useAgent";

interface SessionPickerProps {
	list: SessionListPayload | null;
	error: string | null;
	loading: boolean;
	switching: boolean;
	cwd: string;
	onSelect: (path: string) => void;
	onNew: () => void;
	onRefresh: () => void;
	onDelete: (path: string) => Promise<boolean>;
}

interface DisplayRow {
	item: SessionListItem;
	isLocal: boolean;
	/** Lower-case prefix used to group/insert headings; "" for the local group. */
	group: string;
}

const formatTimeAgo = (ms: number): string => {
	const diff = Date.now() - ms;
	const m = Math.floor(diff / 60_000);
	if (m < 1) return "just now";
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	if (d < 7) return `${d}d ago`;
	return new Date(ms).toLocaleDateString();
};

// Map session lifecycle status to a tone used by the pill badge. The TUI shows
// the same labels; we add a color cue so users can scan a long list faster.
const STATUS_TONE: Record<string, string> = {
	complete: "ok",
	interrupted: "warn",
	aborted: "muted",
	error: "err",
	pending: "warn",
	unknown: "muted",
};

export function SessionPicker(props: SessionPickerProps): ReactNode {
	const { list, error, loading, switching, cwd, onSelect, onNew, onRefresh, onDelete } = props;

	// Path of the row currently in the "delete? yes/no" state. Null = none.
	const [confirming, setConfirming] = useState<string | null>(null);
	// Path of the row whose delete is in flight (so the buttons go inert).
	const [deleting, setDeleting] = useState<string | null>(null);

	// Local sessions first, then the rest of the world, each sorted by mtime desc
	// (server already sorts; the merge keeps the ordering stable if it didn't).
	const rows = useMemo<DisplayRow[]>(() => {
		if (!list) return [];
		const local = list.local.map((item): DisplayRow => ({ item, isLocal: true, group: "" }));
		const seen = new Set(local.map(r => r.item.path));
		const remote = list.all
			.filter(item => !seen.has(item.path))
			.map((item): DisplayRow => ({ item, isLocal: false, group: item.cwd || "(unknown cwd)" }));
		return [...local, ...remote];
	}, [list]);

	const confirmDelete = async (path: string) => {
		setDeleting(path);
		try {
			const ok = await onDelete(path);
			if (ok) setConfirming(null);
		} finally {
			setDeleting(null);
		}
	};

	return (
		<div className="sh-connect">
			<div className="sh-connect-card sh-picker-card">
				<div className="sh-connect-head">
					<div className="sh-lockup">
						<span className="sh-lockup-mark">{"\u{1F916}"}</span>
					</div>
					<h2>pick a session</h2>
					<p className="sh-connect-sub">cwd: {cwd || "(unknown)"}</p>
				</div>

				<div className="sh-picker-actions">
					<button
						type="button"
						className="sh-btn sh-btn-primary"
						onClick={onNew}
						disabled={switching}
					>
						new session
					</button>
					<button
						type="button"
						className="sh-btn sh-btn-ghost"
						onClick={onRefresh}
						disabled={loading}
					>
						{loading ? "refreshing..." : "refresh"}
					</button>
				</div>

				{error && <div className="sh-picker-error">{error}</div>}

				{!loading && rows.length === 0 && (
					<div className="sh-picker-empty">
						<div className="sh-picker-empty-title">no saved sessions yet</div>
						<div className="sh-picker-empty-sub">start one with the button above</div>
					</div>
				)}

				{rows.length > 0 && (
					<ul className="sh-picker-list" role="list">
						{rows.map((row, idx) => {
							const prev = idx > 0 ? rows[idx - 1] : undefined;
							const showHeader = row.group && prev?.group !== row.group;
							const isConfirming = confirming === row.item.path;
							const isDeleting = deleting === row.item.path;
							const statusTone = row.item.status ? STATUS_TONE[row.item.status] ?? "muted" : null;
							return (
								<li key={row.item.path}>
									{showHeader && (
										<div className="sh-picker-group">{row.group}</div>
									)}
									{isConfirming ? (
										<div className="sh-picker-confirm" role="alertdialog" aria-label="Confirm delete">
											<div className="sh-picker-confirm-text">
												delete <strong>{row.item.title || row.item.firstMessage || "(untitled)"}</strong>?
											</div>
											<div className="sh-picker-confirm-actions">
												<button
													type="button"
													className="sh-btn sh-btn-ghost"
													onClick={() => setConfirming(null)}
													disabled={isDeleting}
												>
													cancel
												</button>
												<button
													type="button"
													className="sh-btn sh-btn-danger"
													onClick={() => void confirmDelete(row.item.path)}
													disabled={isDeleting}
												>
													{isDeleting ? "deleting..." : "delete"}
												</button>
											</div>
										</div>
									) : (
										<div className="sh-picker-row">
											<button
												type="button"
												className="sh-picker-row-main"
												disabled={switching}
												onClick={() => onSelect(row.item.path)}
											>
												<div className="sh-picker-title-row">
													<span className="sh-picker-title">{row.item.title || row.item.firstMessage || "(untitled)"}</span>
													{statusTone && row.item.status && (
														<span className={`sh-pill sh-pill-${statusTone}`}>{row.item.status}</span>
													)}
												</div>
												<span className="sh-picker-meta">
													{row.item.messageCount} msg · {formatTimeAgo(row.item.modified)}
												</span>
											</button>
											<button
												type="button"
												className="sh-picker-row-delete"
												disabled={switching}
												aria-label="Delete session"
												title="Delete this session"
												onClick={() => setConfirming(row.item.path)}
											>
												×
											</button>
										</div>
									)}
								</li>
							);
						})}
					</ul>
				)}
			</div>
		</div>
	);
}
