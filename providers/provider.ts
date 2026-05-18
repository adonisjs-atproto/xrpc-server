import type { ApplicationService } from '@adonisjs/core/types'
import type { XrpcConfig } from '../src/types.js'
import { XRPCRouter, XRPCSubscriptionError } from '@atcute/xrpc-server'
import { createNodeWebSocket } from '@atcute/xrpc-server-node'
import { RuntimeException } from '@adonisjs/core/exceptions'

declare module '@adonisjs/core/types' {
  export interface ContainerBindings {}
}

export default class AtProtoProvider {
  constructor(protected app: ApplicationService) {}

  register() {
    this.app.container.singleton('atproto.xrpc.config', async () => {
      const config = this.app.config.get<XrpcConfig>('atproto_xrpc', {})

      if (!config) {
        throw new RuntimeException('Invalid config exported from "config/atproto-xrpc.ts" file.')
      }

      return config
    })
  }

  async boot() {}

  async ready() {
    // Skip WebSocket handler installation outside the HTTP server context.
    // ace commands, tests, and repl all run providers through ready() but
    // never start a server — without this gate we'd log a misleading error.
    if (this.app.getEnvironment() !== 'web') return

    // TODO: I think we'll want this more in a middleware rather than in on
    // ready, see the spec.
    const appServer = await this.app.container.make('server')
    const logger = await this.app.container.make('logger')

    try {
      const server = appServer.getNodeServer()
      if (!server) {
        logger.error('Failed to acquire server to install labeler websocket handler on.')
        return
      }

      const ws = createNodeWebSocket()
      // TODO: we probably want this at boot instead of ready:
      const router = new XRPCRouter({ websocket: ws.adapter })

      ws.injectWebSocket(server, router)
      logger.trace('Labeler WebSocket handler installed at /xrpc/com.atproto.label.subscribeLabels')
    } catch (err) {
      // Surface anything that goes wrong during ready() — without this,
      // exceptions from container.make / injectWebSocket get swallowed
      // by the AdonisJS lifecycle and the only symptom is a 404 on the
      // subscription endpoint.
      logger.error({ err }, 'Failed to install labeler WebSocket handler')
    }
  }

  async shutdown() {}
}
