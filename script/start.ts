import webpack from 'webpack'
import DevMiddleware from 'webpack-dev-middleware'
import HotMiddleware from 'webpack-hot-middleware'

import { forceUnwrap as u } from '../app/src/lib/fatal-error'

import configs from '../app/webpack.development'

import { run } from './run'
import { createServer } from 'http'

function getPortOrDefault() {
  const port = process.env.PORT
  if (port != null) {
    const result = parseInt(port)
    if (isNaN(result)) {
      throw new Error(`Unable to parse '${port}' into valid number`)
    }
    return result
  }

  return 3000
}

function startApp() {
  const runningApp = run({ stdio: 'inherit' })
  if (runningApp == null) {
    console.error(
      "Couldn't launch the app. You probably need to build it first. Run `yarn build:dev`."
    )
    process.exit(1)
  }

  const launchedAt = Date.now()

  runningApp.on('close', () => {
    // A window takes a beat to open. If the process is gone almost immediately
    // it's usually because another instance already holds the single-instance
    // lock (for example one started from the desktop launcher), not because the
    // build failed. That otherwise looks like the app "crashed" on launch.
    if (Date.now() - launchedAt < 5000) {
      console.log(
        'The app exited immediately. Another Git Desktop instance is probably ' +
          'already running; close it and start again to launch this build.'
      )
    }

    process.exit(0)
  })
}

if (process.env.NODE_ENV === 'production') {
  startApp()
} else {
  const rendererConfig = configs[1]
  const compiler = webpack(rendererConfig)
  const port = getPortOrDefault()
  const message = 'Could not find public path from configuration'

  const devMiddleware = DevMiddleware(compiler, {
    publicPath: u(
      message,
      u(message, u(message, rendererConfig).output).publicPath
    ),
  })

  const hotMiddleware = HotMiddleware(compiler)

  const server = createServer((req, res) => {
    devMiddleware(req, res, () => {
      hotMiddleware(req, res, () => {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Not found')
      })
    })
  })

  server.listen(port, 'localhost')
  server.on('listening', () => {
    console.log(`Server running at http://localhost:${port}`)
    startApp()
  })
  server.on('error', (err: Error) => {
    console.error(err)
    process.exit(1)
  })
}
