import type { ApplicationService } from '@adonisjs/core/types'
import type { XrpcConfig } from '../src/types.js'
// XRPC WebSocket wiring depends on @atcute/xrpc-server(-node), which this
// scaffolding branch doesn't yet declare — the stacked implementation branches
// add it properly. Commented out so the package self-typechecks meanwhile.
// import { XRPCRouter } from '@atcute/xrpc-server'
// import { createNodeWebSocket } from '@atcute/xrpc-server-node'
import { RuntimeException } from '@adonisjs/core/exceptions'

declare module '@adonisjs/core/types' {
  export interface ContainerBindings {
    'atproto.xrpc.config': XrpcConfig
  }
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
    // TODO: WebSocket upgrade-handler installation is wired up in the dispatch
    // work (see docs/specs). It depends on @atcute/xrpc-server(-node), so it's
    // commented out on this scaffolding branch to avoid declaring deps the
    // stacked implementation branches add properly.
    //
    // // Skip WebSocket handler installation outside the HTTP server context.
    // // ace commands, tests, and repl all run providers through ready() but
    // // never start a server — without this gate we'd log a misleading error.
    // if (this.app.getEnvironment() !== 'web') return
    //
    // const appServer = await this.app.container.make('server')
    // const logger = await this.app.container.make('logger')
    //
    // try {
    //   const server = appServer.getNodeServer()
    //   if (!server) {
    //     logger.error('Failed to acquire server to install labeler websocket handler on.')
    //     return
    //   }
    //
    //   const ws = createNodeWebSocket()
    //   const router = new XRPCRouter({ websocket: ws.adapter })
    //
    //   ws.injectWebSocket(server, router)
    //   logger.trace('Labeler WebSocket handler installed at /xrpc/com.atproto.label.subscribeLabels')
    // } catch (err) {
    //   // Surface anything that goes wrong during ready() — without this,
    //   // exceptions from container.make / injectWebSocket get swallowed by
    //   // the AdonisJS lifecycle and the only symptom is a 404 on the endpoint.
    //   logger.error({ err }, 'Failed to install labeler WebSocket handler')
    // }
  }

  async shutdown() {}
}
