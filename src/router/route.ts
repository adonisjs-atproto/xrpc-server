import Macroable from '@poppinss/macroable'

export class XrpcRoute extends Macroable {
  constructor(public nsid: string) {
    super()
  }
}
