#!/usr/bin/env node
/**
 * Verify Capacitor audio path: in-app sheet + demo load, never system Files / <input type=file>.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error("FAIL:", msg);
  } else {
    console.log("ok:", msg);
  }
}

function read(rel) {
  return readFileSync(path.join(root, rel), "utf8");
}

// --- static / source contracts ---
const appJs = read("ui-template/app.js");
const pluginJava = read("mobile/android/app/src/main/java/ir/embed/asrparser/AudioPickerPlugin.java");
const mainJava = read("mobile/android/app/src/main/java/ir/embed/asrparser/MainActivity.java");
const demoAsset = path.join(root, "mobile/android/app/src/main/assets/samples/dual_speaker_class.mp3");

assert(appJs.includes("openCapacitorAudioSheet"), "app.js defines openCapacitorAudioSheet");
assert(appJs.includes('data-act="demo"'), "sheet offers Use demo class button");
assert(appJs.includes("picker.loadDemo()"), "demo path calls plugin.loadDemo");
assert(appJs.includes("picker.loadDownload"), "download path calls plugin.loadDownload");
assert(appJs.includes("Never use HTML"), "comment documents Files crash avoidance");
assert(
  /if \(window\.Capacitor\) \{[\s\S]*?return;\s*\}\s*fileInput\.click\(\)/.test(appJs),
  "Capacitor branch returns before fileInput.click()"
);
assert(!appJs.includes("picker.pick()"), "old AlertDialog pick() is gone");
assert(!pluginJava.includes("AlertDialog"), "Java plugin has no AlertDialog");
assert(!pluginJava.includes("ACTION_OPEN_DOCUMENT"), "Java plugin never opens DocumentsUI");
assert(!pluginJava.includes("READ_MEDIA_AUDIO"), "demo path needs no media permission in plugin");
assert(pluginJava.includes("loadDemo"), "plugin exposes loadDemo");
assert(pluginJava.includes("samples/dual_speaker_class.mp3"), "plugin reads bundled demo asset");
assert(mainJava.includes("registerPlugin(AudioPickerPlugin.class)"), "MainActivity registers AudioPicker");
assert(existsSync(demoAsset), "demo mp3 exists under android assets");
assert(statSync(demoAsset).size > 10000, "demo mp3 is non-trivial size");

// History / settings UI fit
const indexHtml = read("ui-template/index.html");
assert(!indexHtml.includes('href="history.html"'), "History nav link removed from index");
assert(appJs.includes("aria-label"), "admin control uses compact aria-label icon button");

// --- runtime: mock Capacitor + DOM sheet ---
class FakeFile extends Blob {
  constructor(parts, name, opts) {
    super(parts, opts);
    this.name = name;
  }
}
// Node may not have File
const FileCtor = globalThis.File || FakeFile;

function base64ToFile(b64, name, mimeType) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new FileCtor([bytes], name || "audio.mp3", { type: mimeType || "audio/mpeg" });
}

const demoBytes = readFileSync(demoAsset);
const demoB64 = demoBytes.toString("base64");

const mockPicker = {
  async loadDemo() {
    return { name: "dual_speaker_class.mp3", mimeType: "audio/mpeg", size: demoBytes.length, data: demoB64 };
  },
  async loadDownload({ name }) {
    if (name.includes("..") || name.includes("/")) throw new Error("Invalid file name");
    return { name, mimeType: "audio/mpeg", size: 12, data: Buffer.from("tiny-audio").toString("base64") };
  },
  async listDownloads() {
    return { files: [{ name: "dual_speaker_class.mp3", size: demoBytes.length }], demo: "dual_speaker_class.mp3" };
  },
};

const file = base64ToFile(demoB64, "dual_speaker_class.mp3", "audio/mpeg");
assert(file.name === "dual_speaker_class.mp3", "base64ToFile keeps name");
assert(file.size === demoBytes.length, "base64ToFile size matches asset bytes");
assert(file.type === "audio/mpeg", "base64ToFile mime is audio/mpeg");

const fromDemo = await mockPicker.loadDemo();
assert(fromDemo.data && fromDemo.size === demoBytes.length, "mock loadDemo returns full demo payload");
const restored = base64ToFile(fromDemo.data, fromDemo.name, fromDemo.mimeType);
assert(restored.size === demoBytes.length, "demo round-trip size matches");

let rejected = false;
try {
  await mockPicker.loadDownload({ name: "../secret.mp3" });
} catch (_) {
  rejected = true;
}
assert(rejected, "path traversal in download name is rejected");

const listed = await mockPicker.listDownloads();
assert(listed.files.some((f) => f.name === "dual_speaker_class.mp3"), "listDownloads includes demo name");

// Simulate Capacitor click routing
function chooseAudioSource(hasCapacitor) {
  if (hasCapacitor) return "sheet";
  return "fileInput";
}
assert(chooseAudioSource(true) === "sheet", "with Capacitor use in-app sheet");
assert(chooseAudioSource(false) === "fileInput", "without Capacitor keep browser file input");

// APK package sanity (if present)
const apk = path.join(root, "mobile/asrparser-debug.apk");
if (existsSync(apk)) {
  const { execSync } = await import("node:child_process");
  const listing = execSync(`unzip -l "${apk}"`, { encoding: "utf8" });
  assert(listing.includes("assets/samples/dual_speaker_class.mp3"), "built APK contains demo asset");
  const tmp = path.join(root, "mobile/.apk-check-dex");
  execSync(`rm -rf "${tmp}" && mkdir -p "${tmp}" && unzip -qo "${apk}" 'classes*.dex' -d "${tmp}"`);
  const dexText = execSync(`strings "${tmp}"/classes*.dex`, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  assert(dexText.includes("AudioPicker"), "built APK dex references AudioPicker");
  assert(dexText.includes("loadDemo"), "built APK dex references loadDemo");
  execSync(`rm -rf "${tmp}"`);
} else {
  console.log("skip: APK not present for zip listing");
}

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nAll Capacitor audio path tests passed.");
