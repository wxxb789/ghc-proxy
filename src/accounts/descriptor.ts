import type { AccountRuntime } from '~/state'

export interface RoutedAccountDescriptor {
  hostname: string
  isDefault: boolean
  name: string
  runtime: AccountRuntime
}
