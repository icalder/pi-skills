#!/usr/bin/env node

// Start Edge on the Windows side with remote debugging on :9222, then wait
// until CDP answers.
//
// Every Windows exec goes through WSL interop, which maps the *current
// directory* to \\wsl.localhost\<distro>\<cwd> and resolves it against the host
// distro's filesystem. A directory that exists only inside a private mount
// namespace (the agent sandbox, a container) cannot be resolved, and the exec
// dies with "Invalid argument" before Edge ever starts. So no Windows exec
// below may inherit the caller's cwd: they all pin it to interopCwd().

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const CDP_URL = "http://localhost:9222";
const CMD_EXE = process.env.WSL_CMD_EXE || "/mnt/c/Windows/System32/cmd.exe";
const EDGE_EXE = process.env.EDGE_EXE || "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const WINDOWS_USERS_DIR = process.env.WIN_USERS_DIR || "/mnt/c/Users";
const PROFILE_SUBDIR = "AppData/Local/Pi/browser-profile";
const EDGE_USER_DATA = "AppData/Local/Microsoft/Edge/User Data";
const SINGLETON_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"];
// Profile dirs Windows creates for itself; none of them is the interactive user.
const BUILTIN_PROFILE_PREFIXES = ["default", "public", "wdagutilityaccount", "wsiaccount", "all users"];
// Directories that exist in the host distro root, so interop can resolve them.
// Only these exact paths: a fresh subdirectory of /tmp is invisible to the host
// when the real cwd lives in a private mount namespace.
const INTEROP_CWD_CANDIDATES = ["/tmp", "/var/tmp", "/"];
const PROFILE_COPY_EXCLUDES = [
	"--exclude=SingletonLock",
	"--exclude=SingletonSocket",
	"--exclude=SingletonCookie",
	"--exclude=*/Sessions/*",
	"--exclude=*/Current Session",
	"--exclude=*/Current Tabs",
	"--exclude=*/Last Session",
	"--exclude=*/Last Tabs",
];
const READY_POLLS = 30;
const READY_DELAY_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// BROWSER_TOOLS_DEBUG=1 traces the decisions that are hardest to see when the
// launcher misbehaves: which Windows profile was picked and where the Windows
// processes are launched from.
function debug(...args) {
	if (process.env.BROWSER_TOOLS_DEBUG) console.error("[browser-start]", ...args);
}

function fail(message) {
	console.error(`✗ ${message}`);
	process.exit(1);
}

function printUsage() {
	console.log("Usage: browser-start.js [--profile]");
	console.log("\nOptions:");
	console.log("  --profile  Copy your default Edge profile (cookies, logins)");
	console.log("\nEnvironment:");
	console.log("  WIN_USER              Windows profile name; skips discovery");
	console.log("  BROWSER_PROFILE_DIR   Edge profile dir to use (must be under /mnt/c)");
	console.log("  WIN_USERS_DIR         Windows users root (default /mnt/c/Users)");
	console.log("  EDGE_EXE, WSL_CMD_EXE  Windows binaries to launch");
}

// A directory the Windows side can resolve. Never the caller's cwd.
function interopCwd() {
	return INTEROP_CWD_CANDIDATES.find((dir) => existsSync(dir)) ?? "/";
}

function interopHint() {
	return (
		`WSL interop cannot run Windows binaries from here: it maps the cwd to a ` +
		`\\\\wsl.localhost path, and only paths that exist in the host distro resolve. ` +
		`Windows execs in this script run from "${interopCwd()}". Inside the agent ` +
		`sandbox, /init, /run/WSL and the .exe paths must be bound (sandbox.sh does this).`
	);
}

let cachedWinUser;

// The Windows profile Edge runs under. Used only to build two paths, so it is
// resolved without interop wherever possible: an interop call costs a spawn and
// needs a host-resolvable cwd.
function winUser() {
	if (cachedWinUser === undefined) cachedWinUser = resolveWinUser();
	return cachedWinUser;
}

function resolveWinUser() {
	const override = (process.env.WIN_USER || "").trim();
	if (override) {
		debug("Windows user from WIN_USER:", override);
		return override;
	}

	const candidates = profileCandidates();
	if (candidates.length > 0) {
		if (candidates.length > 1) {
			const names = candidates.map((candidate) => candidate.name).join(", ");
			console.log(`Using Windows user "${candidates[0].name}" (found: ${names}) — set WIN_USER to choose.`);
		}
		debug("Windows user discovered:", candidates[0].name, JSON.stringify(candidates));
		return candidates[0].name;
	}

	const fromWindows = winUserFromInterop();
	if (fromWindows) {
		debug("Windows user from cmd.exe:", fromWindows);
		return fromWindows;
	}

	fail(
		`Cannot determine the Windows user: no usable profile in ${WINDOWS_USERS_DIR}, ` +
			`and the ${CMD_EXE} probe failed. Set WIN_USER=<profile name>, or ` +
			`BROWSER_PROFILE_DIR=<dir under /mnt/c> to skip discovery entirely.`,
	);
}

// Real user profiles under /mnt/c/Users, best first. Inside the agent sandbox
// only the profile the sandbox bound is visible, so the answer is unambiguous.
function profileCandidates() {
	let entries;
	try {
		entries = readdirSync(WINDOWS_USERS_DIR, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
		.map((entry) => ({
			name: entry.name,
			score: profileScore(entry.name),
			mtime: mtimeOf(path.join(WINDOWS_USERS_DIR, entry.name)),
		}))
		.filter((candidate) => candidate.score > 0)
		.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
}

// How strongly a dir looks like a profile someone actually uses. Zero: it does not.
function profileScore(name) {
	if (BUILTIN_PROFILE_PREFIXES.some((prefix) => name.toLowerCase().startsWith(prefix))) return 0;
	const dir = path.join(WINDOWS_USERS_DIR, name);
	let score = 0;
	if (existsSync(path.join(dir, EDGE_USER_DATA))) score += 4; // what --profile copies from
	if (existsSync(path.join(dir, "AppData", "Local"))) score += 2; // only real profiles have it
	if (process.env.USER && name.toLowerCase() === process.env.USER.toLowerCase()) score += 1;
	return score;
}

function mtimeOf(target) {
	try {
		return statSync(target).mtimeMs;
	} catch {
		return 0;
	}
}

// Last resort: ask Windows. Runs from interopCwd(), never from the caller's cwd.
function winUserFromInterop() {
	try {
		const stdout = execFileSync(CMD_EXE, ["/c", "echo %USERNAME%"], {
			cwd: interopCwd(),
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
		return lines.at(-1) ?? null;
	} catch {
		return null;
	}
}

// Where Edge keeps its profile: the Linux path for mkdir/rsync, the Windows
// path for --user-data-dir.
function profileLocation() {
	const override = (process.env.BROWSER_PROFILE_DIR || "").trim();
	const linux = override || path.join(WINDOWS_USERS_DIR, winUser(), PROFILE_SUBDIR);
	return { linux, windows: toWindowsPath(linux) };
}

// /mnt/c/Users/x/AppData -> C:\Users\x\AppData
function toWindowsPath(linuxPath) {
	const drive = /^\/mnt\/([a-z])(\/.*)?$/i.exec(linuxPath);
	if (!drive) fail(`The Edge profile dir must live on the Windows filesystem (/mnt/c/…), got: ${linuxPath}`);
	const rest = (drive[2] ?? "").replace(/^\/+/, "").replaceAll("/", "\\");
	return rest ? `${drive[1].toUpperCase()}:\\${rest}` : `${drive[1].toUpperCase()}:\\`;
}

function createProfileDir(profile) {
	try {
		mkdirSync(profile.linux, { recursive: true });
	} catch (err) {
		fail(
			`Cannot create the Edge profile dir ${profile.linux}: ${err.message}. ` +
				`Inside the agent sandbox this path must be bound read-write.`,
		);
	}
}

function clearSingletonLocks(profile) {
	for (const name of SINGLETON_FILES) {
		// A lock Edge left behind is its own problem to solve; a stale one is
		// what stops a new instance from starting, so try and move on.
		try {
			rmSync(path.join(profile.linux, name), { force: true });
		} catch { }
	}
}

function copyEdgeProfile(profile) {
	console.log("Syncing profile...");
	const source = path.join(WINDOWS_USERS_DIR, winUser(), EDGE_USER_DATA);
	try {
		execFileSync("rsync", ["-a", "--delete", ...PROFILE_COPY_EXCLUDES, `${source}/`, `${profile.linux}/`], {
			stdio: ["ignore", "ignore", "pipe"],
		});
	} catch (err) {
		fail(`Cannot copy the Edge profile from ${source}: ${err.stderr?.toString().trim() || err.message}`);
	}
}

async function cdpIsUp() {
	try {
		const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null });
		await browser.disconnect();
		return true;
	} catch {
		return false;
	}
}

async function waitForCdp(abandon) {
	for (let attempt = 0; attempt < READY_POLLS; attempt++) {
		if (abandon()) return false;
		if (await cdpIsUp()) return true;
		await sleep(READY_DELAY_MS);
	}
	return false;
}

function describeSpawnFailure(err) {
	if (err.code === "ENOENT") return `${EDGE_EXE} is not visible from here`;
	if (err.code === "EACCES") return `${EDGE_EXE} is not executable from here`;
	if (err.code === "EINVAL") return `the Windows side rejected the exec (Invalid argument) from cwd ${interopCwd()}`;
	return `${err.code || "error"}: ${err.message}`;
}

function parseArgs(args) {
	if (args.length === 0) return false;
	if (args.length === 1 && args[0] === "--profile") return true;
	printUsage();
	process.exit(1);
}

const useProfile = parseArgs(process.argv.slice(2));

if (await cdpIsUp()) {
	console.log("✓ Edge already running on :9222");
	process.exit(0);
}

const profile = profileLocation();
debug("interop cwd:", interopCwd(), "profile:", profile);
createProfileDir(profile);
clearSingletonLocks(profile);
if (useProfile) copyEdgeProfile(profile);

if (!existsSync(EDGE_EXE)) fail(`Edge not found at ${EDGE_EXE} — set EDGE_EXE to your msedge.exe path.`);

console.log("Starting Edge...");
// detached + unref: Edge must outlive this script. Interop failures (EINVAL,
// ENOENT, EACCES) arrive as an async 'error' event, so keep the handle and let
// the poll loop stop early instead of waiting out the full timeout.
let spawnFailure = null;
const edge = spawn(EDGE_EXE, ["--remote-debugging-port=9222", `--user-data-dir=${profile.windows}`, "--no-first-run", "--no-default-browser-check"], {
	cwd: interopCwd(),
	detached: true,
	stdio: "ignore",
});
edge.on("error", (err) => {
	spawnFailure = err;
});
edge.unref();

if (await waitForCdp(() => spawnFailure !== null)) {
	console.log(`✓ Edge started on :9222${useProfile ? " with your profile" : ""}`);
	process.exit(0);
}

if (spawnFailure) fail(`Edge did not start: ${describeSpawnFailure(spawnFailure)}\n${interopHint()}`);
fail(`Edge did not answer on ${CDP_URL}. If it is already open, quit it fully or check the profile dir ${profile.linux}.`);
