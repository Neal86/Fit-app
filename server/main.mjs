import { createApp } from './app.mjs'
import { configFromEnv } from './config.mjs'
import { openDatabase } from './database.mjs'
import { createHttpServer } from './http.mjs'

const config = configFromEnv()
if (!config.enabled) {
  process.stderr.write('FitFlow account server is disabled. Set FITFLOW_SERVER_ENABLED=true only for an explicitly configured local/synthetic environment.\n')
  process.exitCode = 1
} else {
  // This entry point intentionally has no live email provider. Integrators must inject an approved
  // mail adapter through createApp; do not log verification/reset links or add a secret debug route.
  process.umask(0o077)
  const db = openDatabase(config.databasePath)
  const server = createHttpServer(createApp({ db, config }))
  server.listen(config.port, config.host, () => { process.stdout.write('FitFlow account API started. Email delivery is disabled.\n') })
  server.on('error', () => { process.stderr.write('FitFlow account API could not start.\n'); db.close(); process.exitCode = 1 })
  const stop = () => { server.close(() => { db.close() }); server.closeIdleConnections() }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}
