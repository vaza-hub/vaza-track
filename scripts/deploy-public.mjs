// Build the browser bundle and place it in every repo that serves it as
// /track.js. The served file is dist/index.global.js PLUS shim/auto-init.js —
// the shim reads data-vaza-key off the script tag. Copying the raw dist file
// by hand silently drops the shim (which is exactly what happened on
// 2026-08-12; tests/track-autoinit.test.ts in vaza-app guards it now).

import { execSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const workspace = join(root, "..")

/** Every repo that serves the SDK same-origin. */
const CONSUMERS = ["vaza.ai/public/track.js", "vaza-app/public/track.js"]

execSync("npm run build", { cwd: root, stdio: "inherit" })

const bundle = readFileSync(join(root, "dist/index.global.js"), "utf8")
const shim = readFileSync(join(root, "shim/auto-init.js"), "utf8")
const served = `${bundle}\n${shim}`

let placed = 0
for (const rel of CONSUMERS) {
	const dest = join(workspace, rel)
	if (!existsSync(dirname(dest))) {
		console.warn(`skip ${rel} — consumer not checked out`)
		continue
	}
	writeFileSync(dest, served)
	console.log(`placed ${rel}`)
	placed++
}
console.log(`\n${placed}/${CONSUMERS.length} consumers updated. Commit each repo's track.js.`)
