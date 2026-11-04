import type { DashboardModel } from '@contract'
import { formatNumber } from '../../lib/format'

export function modelLimits(model: DashboardModel, separator: string) {
  const limits = model.upstream.capabilities.limits
  const values = [
    `context ${formatNumber(limits.max_context_window_tokens)}`,
    `prompt ${formatNumber(limits.max_prompt_tokens)}`,
    `output ${formatNumber(limits.max_output_tokens)}`,
  ]
  if (limits.max_inputs !== undefined)
    values.push(`max inputs ${formatNumber(limits.max_inputs)}`)
  if (limits.vision?.max_prompt_images !== undefined)
    values.push(`images ${formatNumber(limits.vision.max_prompt_images)}`)
  if (limits.vision?.max_prompt_image_size !== undefined)
    values.push(`image size ${formatNumber(limits.vision.max_prompt_image_size)}`)
  if (limits.vision?.supported_media_types?.length)
    values.push(`image types ${limits.vision.supported_media_types.join(', ')}`)
  return values.join(separator)
}

export function modelCapabilities(model: DashboardModel) {
  return Object.entries(model.upstream.capabilities.supports)
    .filter(([, value]) => value === true || (Array.isArray(value) && value.length > 0))
    .map(([key]) => key)
    .join(', ') || '—'
}

export function modelCompatibility(model: DashboardModel) {
  const effective = model.effective
  const route = effective.defaultResponsesStrategy === 'responses-passthrough'
    ? 'native'
    : effective.defaultResponsesStrategy === 'responses-chat-completions' ? 'via Chat Completions' : 'unavailable'
  return [
    `responses ${route}`,
    `structured ${effective.messagesStructuredOutput ? 'yes' : 'no'}`,
    `output_config ${effective.outputConfig ? 'yes' : 'no'}`,
    `chat tokens ${effective.chatTokenParameter}`,
    effective.responsesParameterFilters.length ? `filters ${effective.responsesParameterFilters.join(',')}` : 'filters none',
    effective.contextManagement ? 'context managed' : 'context passthrough',
  ]
}

const TSV_LINE_BREAKS_RE = /[\t\r\n]+/g

function tsvCell(value: string) {
  return value.replace(TSV_LINE_BREAKS_RE, ' ').trim()
}

export function selectedModelsTsv(models: DashboardModel[], selected: ReadonlySet<string>, apiBaseUrl: string) {
  const rows = models.filter(model => selected.has(model.id))
    .sort((left, right) => (left.name || left.id).localeCompare(right.name || right.id))
    .map(model => [
      model.id,
      model.name + (model.preview ? ' / preview' : ''),
      model.vendor,
      model.version,
      model.effective.defaultMessagesStrategy,
      model.upstream.endpoints.join(', ') || '-',
      modelLimits(model, '; '),
      modelCapabilities(model),
      modelCompatibility(model).join('; '),
    ].map(tsvCell).join('\t'))
  return [
    `Endpoint: ${tsvCell(apiBaseUrl)}`,
    'Model ID\tModel Name\tVendor\tVersion\tMessages Route\tUpstream Endpoints\tLimits\tCapabilities\tProxy Compatibility',
    ...rows,
  ].join('\n')
}
