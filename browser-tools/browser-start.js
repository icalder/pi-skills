#!/usr/bin/env node

import { spawn, execSync } from "node:child_process";
import puppeteer from "puppeteer-core";

const useProfile = process.argv[2] === "--profile";

if (process.argv[2] && process.argv[2] !== "--profile") {
	console.log("Usage: browser-start.js [--profile]");
	console.log("\nOptions:");
	console.log("  --profile  Copy your default Edge profile (cookies, logins)");
	process.exit(1);
}

const SCRAPING_DIR = `C:\\Users\\iainc\\AppData\\Local\\Pi\\browser-profile`

// Check if already running on :9222
try {
	const browser = await puppeteer.connect({
		browserURL: "http://localhost:9222",
		defaultViewport: null,
	});
	await browser.disconnect();
	console.log("✓ Edge already running on :9222");
	process.exit(0);
} catch { }

// Setup profile directory
execSync(`mkdir -p "${SCRAPING_DIR}"`, { stdio: "ignore" });

// Remove SingletonLock to allow new instance
try {
	execSync(`rm -f "${SCRAPING_DIR}/SingletonLock" "${SCRAPING_DIR}/SingletonSocket" "${SCRAPING_DIR}/SingletonCookie"`, { stdio: "ignore" });
} catch { }

if (useProfile) {
	console.log("Syncing profile...");
	execSync(
		`rsync -a --delete \
			--exclude='SingletonLock' \
			--exclude='SingletonSocket' \
			--exclude='SingletonCookie' \
			--exclude='*/Sessions/*' \
			--exclude='*/Current Session' \
			--exclude='*/Current Tabs' \
			--exclude='*/Last Session' \
			--exclude='*/Last Tabs' \
			"/mnt/c/Users/${process.env.USER}/AppData/Local/Microsoft/Edge/User Data/" "${SCRAPING_DIR}/"`,
		{ stdio: "pipe" },
	);
}

console.log("Starting Edge...");
// Start Edge with flags to force new instance
spawn(
	'/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
	[
		"--remote-debugging-port=9222",
		`--user-data-dir=${SCRAPING_DIR}`,
		"--no-first-run",
		"--no-default-browser-check",
	],
	{ detached: true, stdio: "ignore" },
).unref();

console.log("Started Edge...");

// Wait for Edge to be ready
let connected = false;
for (let i = 0; i < 30; i++) {
	try {
		const browser = await puppeteer.connect({
			browserURL: "http://localhost:9222",
			defaultViewport: null,
		});
		await browser.disconnect();
		connected = true;
		break;
	} catch {
		await new Promise((r) => setTimeout(r, 500));
	}
}

if (!connected) {
	console.error("✗ Failed to connect to Edge");
	process.exit(1);
}

console.log(`✓ Edge started on :9222${useProfile ? " with your profile" : ""}`);
