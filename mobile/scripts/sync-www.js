#!/usr/bin/env node
/**
 * Copy ui-template into mobile/www and inject Capacitor bootstrap.
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const src = path.join(root, "ui-template");
const dest = path.join(__dirname, "../www");

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const a = path.join(from, name);
    const b = path.join(to, name);
    if (fs.statSync(a).isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

if (!fs.existsSync(src)) {
  console.error("Missing ui-template at", src);
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
copyDir(src, dest);

const bootstrap = `/* Capacitor bootstrap — do not edit www by hand; run npm run sync-www */
(function () {
  window.ASR_STANDALONE = true;
})();
`;

fs.writeFileSync(path.join(dest, "capacitor-bootstrap.js"), bootstrap, "utf8");

function injectScripts(htmlPath) {
  let html = fs.readFileSync(htmlPath, "utf8");
  if (!html.includes("capacitor-bootstrap.js")) {
    html = html.replace(
      /<head>/i,
      '<head>\n  <script src="capacitor-bootstrap.js"></script>'
    );
  }
  if (!html.includes('src="standalone.js"')) {
    html = html.replace(
      /<script src="app\.js"><\/script>/i,
      '<script src="standalone.js"></script>\n  <script src="app.js"></script>'
    );
  }
  if (!/viewport-fit=cover/.test(html)) {
    html = html.replace(
      /content="width=device-width,\s*initial-scale=1\.0"/i,
      'content="width=device-width, initial-scale=1.0, viewport-fit=cover"'
    );
  }
  fs.writeFileSync(htmlPath, html, "utf8");
}

for (const name of fs.readdirSync(dest)) {
  if (name.endsWith(".html")) injectScripts(path.join(dest, name));
}

console.log("Synced", src, "→", dest);
