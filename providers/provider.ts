import type { ApplicationService } from '@adonisjs/core/types'

declare module '@adonisjs/core/types' {
  export interface ContainerBindings {}
}

// Lifecycle skeleton — Plan 04 will rewrite this with real container
// bindings, HTTP dispatch wiring, and WebSocket upgrade installation.
// Kept minimal here so the package typechecks while plans 01-03 land.
export default class AtProtoXrpcProvider {
  constructor(protected app: ApplicationService) {}

  register() {}

  async boot() {}

  async ready() {}

  async shutdown() {}
}
