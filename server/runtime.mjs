const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 24 || major === 24 && minor < 15) throw new Error('The optional FitFlow account server requires Node.js 24.15 or newer. The local-only web app can still use Node.js 22+.')
