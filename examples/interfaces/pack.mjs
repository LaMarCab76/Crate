// Run from any directory: node examples/interfaces/pack.mjs
// These files are already plain browser code; no dependencies need installation.
import { readFileSync, writeFileSync } from 'node:fs'
const source = new URL('./nightdesk/', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('manifest.json', source), 'utf8'))
const files = ['index.html', 'style.css', 'app.js'].map(path => ({ path, content: readFileSync(new URL(path, source), 'utf8'), encoding: 'utf8' }))
writeFileSync(new URL('./nightdesk.crate-interface', import.meta.url), `${JSON.stringify({ manifest, files }, null, 2)}\n`)
console.log('Generated examples/interfaces/nightdesk.crate-interface')
