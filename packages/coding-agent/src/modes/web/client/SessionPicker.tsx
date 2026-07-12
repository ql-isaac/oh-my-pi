/**
 * Session picker - the default landing page in web mode, mirroring `omp -r`
 * in the TUI. Lists local + cross-project sessions with status badges, a
 * per-row delete action (with inline confirmation, matching the TUI's
 * "Delete session? Yes/No" dialog), and a "new session" entry point.
 *
 * Responsive: full-width card on mobile with touch-friendly 44px tap targets;
 * compact centered card on desktop. The inline confirm prompt stacks
 * vertically below 420px so the title and buttons never truncate.
 */

import { useMemo, useState, type ReactNode, type SVGProps } from "react";
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

/* ---- Icons (Lucide-style, 24x24 viewBox, stroke-based) ---- */

const TrashIcon = (props: SVGProps<SVGSVGElement>): ReactNode => (
	<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
		<polyline points="3 6 5 6 21 6" />
		<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
		<line x1="10" y1="11" x2="10" y2="17" />
		<line x1="14" y1="11" x2="14" y2="17" />
	</svg>
);

const PlusIcon = (props: SVGProps<SVGSVGElement>): ReactNode => (
	<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
		<line x1="12" y1="5" x2="12" y2="19" />
		<line x1="5" y1="12" x2="19" y2="12" />
	</svg>
);

const RefreshIcon = (props: SVGProps<SVGSVGElement>): ReactNode => (
	<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
		<polyline points="23 4 23 10 17 10" />
		<polyline points="1 20 1 14 7 14" />
		<path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
	</svg>
);

const InboxIcon = (props: SVGProps<SVGSVGElement>): ReactNode => (
	<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
		<polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
		<path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
	</svg>
);

/* ---- Loading skeleton ---- */

function SkeletonRows(): ReactNode {
	return (
		<ul className="sh-picker-list sh-picker-skeleton" aria-hidden="true">
			{Array.from({ length: 5 }, (_, i) => (
				<li key={i} className="sh-picker-skeleton-row">
					<div className="sh-picker-skeleton-line" style={{ width: `${55 + (i % 3) * 14}%` }} />
					<div className="sh-picker-skeleton-line sh-picker-skeleton-meta" style={{ width: `${30 + (i % 2) * 10}%` }} />
				</li>
			))}
		</ul>
	);
}

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
			// Only clear confirming if it still matches this row (prevents
			// racing with another row's delete confirm UI).
			setConfirming(prev => prev === path && ok ? null : prev);
		} finally {
			setDeleting(prev => prev === path ? null : prev);
		}
	};

	const showSkeleton = loading && rows.length === 0;
	const showEmpty = !loading && !showSkeleton && rows.length === 0;

	return (
		<div className="sh-connect">
			<div className="sh-connect-card sh-picker-card">
				<div className="sh-connect-head">
					<div className="sh-lockup">
						<span className="sh-lockup-mark">{"\u{1F916}"}</span>
					</div>
					<h2>pick a session</h2>
					<p className="sh-connect-sub">
						<span className="sh-picker-cwd-label">cwd</span>
						<code className="sh-picker-cwd">{cwd || "(unknown)"}</code>
					</p>
				</div>

				<div className="sh-picker-actions">
					<button
						type="button"
						className="sh-btn sh-btn-primary sh-picker-btn-new"
						onClick={onNew}
						disabled={switching}
					>
						<PlusIcon />
						<span>new session</span>
					</button>
					<button
						type="button"
						className="sh-btn sh-btn-ghost sh-picker-btn-refresh"
						onClick={onRefresh}
						disabled={loading}
						aria-label="Refresh session list"
					>
						<RefreshIcon className={loading ? "sh-icon-spin" : undefined} />
						<span>{loading ? "refreshing" : "refresh"}</span>
					</button>
				</div>

				{error && <div className="sh-picker-error">{error}</div>}

				{showSkeleton && <SkeletonRows />}

				{showEmpty && (
					<div className="sh-picker-empty">
						<InboxIcon className="sh-picker-empty-icon" />
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
							const title = row.item.title || row.item.firstMessage || "(untitled)";
							return (
								<li key={row.item.path}>
									{showHeader && (
									<div className="sh-picker-group"><span className="sh-picker-group-text">{row.group}</span></div>
									)}
									{isConfirming ? (
										// Inline confirm - not a modal dialog, so no alertdialog role.
										// role="group" + aria-label gives screen readers context without
										// implying focus trapping that alertdialog requires.
										<div className="sh-picker-confirm" role="group" aria-label={`Confirm delete: ${title}`}>
											<div className="sh-picker-confirm-text">
												delete <strong>{title}</strong>?
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
													{isDeleting ? "deleting" : "delete"}
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
													<span className="sh-picker-title">{title}</span>
													{statusTone && row.item.status && (
														<span className={`sh-pill sh-pill-${statusTone}`}>
															<span className="sh-pill-dot" aria-hidden="true" />
															{row.item.status}
														</span>
													)}
												</div>
												<div className="sh-picker-meta">
													{row.isLocal && <span className="sh-picker-local-tag">this project</span>}
													<span>{row.item.messageCount} msg</span>
													<span className="sh-picker-meta-sep" aria-hidden="true">{"\u00B7"}</span>
													<span>{formatTimeAgo(row.item.modified)}</span>
												</div>
											</button>
											<button
												type="button"
												className="sh-picker-row-delete"
												disabled={switching}
												aria-label={`Delete session: ${title}`}
												title="Delete this session"
												onClick={() => setConfirming(row.item.path)}
											>
												<TrashIcon />
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
