/**
 * Build the web mode frontend (React SPA).
 *
 * Output goes to `dist/web-client/` — the web mode server serves from there.
 */

import * as path from "node:path";
const PACKAGE_DIR = path.resolve(import.meta.dir, "..");
const CLIENT_DIR = path.join(PACKAGE_DIR, "src", "modes", "web", "client");
const OUT_DIR = path.join(PACKAGE_DIR, "dist", "web-client");

console.log("[build:web] Building frontend...");

// Build the React app
const result = await Bun.build({
	entrypoints: [path.join(CLIENT_DIR, "main.tsx")],
	outdir: OUT_DIR,
	minify: true,
	naming: "[dir]/[name].[ext]",
	root: CLIENT_DIR,
});

if (!result.success) {
	console.error("[build:web] Build failed:");
	for (const msg of result.logs) {
		console.error(msg);
	}
	process.exit(1);
}

// Generate index.html with correct script reference
const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <meta name="theme-color" media="(prefers-color-scheme: light)" content="#faf7fc" />
    <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0f0b14" />
    <title>omp — agent web ui</title>
    <script>
      (function() {
        try {
          var stored = localStorage.getItem("omp-web-theme");
          var system = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
          var theme = stored === "light" || stored === "dark" ? stored : system;
          document.documentElement.dataset.theme = theme;
          document.documentElement.style.colorScheme = theme;
        } catch(e) {}
      })();
    </script>
    <link rel="stylesheet" href="main.css">
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <div id="root"></div>
    <script src="main.js" type="module"></script>
</body>
</html>`;
const outIndex = path.join(OUT_DIR, "index.html");
await Bun.write(outIndex, indexHtml);

// Copy styles.css
const srcCss = path.join(CLIENT_DIR, "styles.css");
const outCss = path.join(OUT_DIR, "styles.css");
await Bun.write(outCss, Bun.file(srcCss));

console.log(`[build:web] Done. Output in ${OUT_DIR}`);
