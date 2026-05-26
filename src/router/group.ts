import Macroable from '@poppinss/macroable'
import type { XrpcRoute } from './route.ts'

export class XrpcRouteGroup extends Macroable {
  constructor(public routes: XrpcRoute[]) {
    super()
  }
}
