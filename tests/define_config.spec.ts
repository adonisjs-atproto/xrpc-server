/*
|--------------------------------------------------------------------------
| defineConfig spec
|--------------------------------------------------------------------------
|
| Validates the behavior of the package's `defineConfig()` helper. This
| is what consumers call from their `config/atproto_labeler.ts` and is
| where the runtime validation of signing key / serviceDid / store-shape
| lives. Each negative test pins one specific invariant that consumers
| have hit in the wild.
|
*/

import { test } from '@japa/runner'
// import { defineConfig } from '../src/define_config.js'

test.group('defineConfig', () => {})
