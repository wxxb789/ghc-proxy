import type { ModelMappingInfo } from "~/lib/request-logger"

declare module "hono" {
  interface ContextVariableMap {
    modelMappingInfo?: ModelMappingInfo
  }
}
