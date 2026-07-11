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

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(<App />);
