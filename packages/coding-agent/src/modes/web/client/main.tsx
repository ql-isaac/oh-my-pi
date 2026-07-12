import { createRoot } from "react-dom/client";

// Import collab-web's CSS for exact styling
import "@oh-my-pi/collab-web/tokens-css";
import "@oh-my-pi/collab-web/base-css";
import "@oh-my-pi/collab-web/transcript-css";
import "@oh-my-pi/collab-web/shell-css";
import "@oh-my-pi/collab-web/tool-render-css";

// Import our layout overrides
import "./styles.css";

import { App } from "./App";

/**
 * Extract a session ID from the URL pathname.
 * Pattern: /session/<id>  →  returns the ID.
 * Anything else (including /) returns undefined.
 */
function parseInitialSessionId(): string | undefined {
	const m = window.location.pathname.match(/^\/session\/([^/]+)$/);
	return m ? m[1] : undefined;
}

const initialSessionId = parseInitialSessionId();
const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(<App initialSessionId={initialSessionId} />);
