import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve('dist')
const assets = (await readdir(resolve(root, 'assets'))).filter(name => !name.endsWith('.map')).map(name => `/assets/${name}`)
const shell = ['/index.html', '/manifest.webmanifest', '/icon.svg', ...assets].sort()
const contents = await Promise.all(shell.map(path => readFile(resolve(root, `.${path}`))))
const hash = createHash('sha256')
contents.forEach(content => hash.update(content))
const version = hash.digest('hex').slice(0, 16)
const source = await readFile('public/sw.js', 'utf8')
await writeFile(resolve(root, 'sw.js'), source.replace('__BUILD_ID__', version).replace('__PRECACHE_ASSETS__', JSON.stringify(shell)))
console.log(`Offline shell: ${shell.length} files, release ${version}`)
