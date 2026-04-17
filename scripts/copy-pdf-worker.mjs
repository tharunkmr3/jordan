// Copy the pdf.js worker used by react-pdf into /public so the browser
// can load it as a static asset. Runs automatically after `npm install`
// via the postinstall hook, and any time the react-pdf / pdfjs-dist
// versions change.
//
// Why: react-pdf nests its own pinned pdfjs-dist version. If we use the
// hoisted pdfjs-dist (pulled in by pdf-parse / other deps), the worker
// API version mismatches react-pdf's main-thread code and PDFs fail to
// open with "API version does not match the Worker version". Always
// pin the worker to react-pdf's own copy.

import { copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')

// Prefer react-pdf's nested pdfjs-dist (pinned to its API version);
// fall back to the hoisted copy if npm deduplicated them.
const candidates = [
  resolve(repoRoot, 'node_modules/react-pdf/node_modules/pdfjs-dist/build/pdf.worker.min.mjs'),
  resolve(repoRoot, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs'),
]

const src = candidates.find((p) => existsSync(p))
if (!src) {
  console.error('[copy-pdf-worker] Could not find pdf.worker.min.mjs in node_modules')
  console.error('  Tried:\n    ' + candidates.join('\n    '))
  process.exit(1)
}

const destDir = resolve(repoRoot, 'public')
mkdirSync(destDir, { recursive: true })
const dest = resolve(destDir, 'pdf.worker.min.mjs')

copyFileSync(src, dest)
console.log(`[copy-pdf-worker] ${src.replace(repoRoot + '/', '')} → public/pdf.worker.min.mjs`)
