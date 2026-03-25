import type { ApiRoute, AppSettings, GeneratedType, RecordedRequest, StorageData } from '@/types'
import { type OperationDefinitionNode, type OperationTypeNode, parse, type TypeNode } from 'graphql'
import { extractQueryParams } from '@/utils/paramCollector'
import { formatCode } from '@/utils/format'
import { generateGraphqlSchemaFromRequests } from '@/utils/graphqlSchemaGenerator'
import {
  extractPath,
  generateRouteName,
  getBaseUrl,
  matchesBaseUrl,
  matchesPattern,
} from '@/utils/urlParser'
import { generateTypeFromSamples, generateTypeName } from '@/utils/typeGenerator'

const TRACKED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
const MAX_REQUESTS = 100
const STORAGE_FLUSH_DELAY_MS = 500
const DEFAULT_SAMPLE_LIMIT = 20

const STATUS_BUCKET_ORDER = ['SUCCESS_2XX', 'REDIRECT_3XX', 'CLIENT_ERROR_4XX', 'SERVER_ERROR_5XX', 'OTHER']

type PersistedState = StorageData

type PersistedKey = keyof PersistedState

type StatusBucket = 'SUCCESS_2XX' | 'REDIRECT_3XX' | 'CLIENT_ERROR_4XX' | 'SERVER_ERROR_5XX' | 'OTHER'

type BucketGroup = {
  bucket: StatusBucket
  isError: boolean
  samples: any[]
  count: number
}

const state: PersistedState = {
  routes: [],
  requests: [],
  types: [],
  sampleLimit: DEFAULT_SAMPLE_LIMIT,
}

const dirtyKeys = new Set<PersistedKey>()
let storageFlushTimer: ReturnType<typeof setTimeout> | null = null
let storageWriteChain: Promise<void> = Promise.resolve()

const requestBodies = new Map<string, any>()
const responseBodies = new Map<string, any>()
const responseMeta = new Map<string, { contentType?: string }>()
let typesDirty = true

interface FilterResponseDataEvent {
  data: ArrayBuffer
}

interface StreamFilter {
  ondata: ((event: FilterResponseDataEvent) => void) | null
  onstop: (() => void) | null
  onerror: ((event: any) => void) | null
  write(data: ArrayBuffer | Uint8Array): void
  disconnect(): void
  close(): void
}

interface FirefoxWebRequest {
  filterResponseData(requestId: string): StreamFilter
}

export default defineBackground(async () => {
  console.log('API Type Detector background started')

  await initStorage()
  setupWebRequestListeners()
  setupMessageListeners()
})

function normalizeSampleLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_SAMPLE_LIMIT
  }
  return Math.max(1, Math.floor(value))
}

function normalizeGraphqlEndpoint(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  try {
    const parsed = new URL(trimmed)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return undefined
  }
}

function operationTypeFromNode(node: OperationTypeNode): 'query' | 'mutation' | 'subscription' {
  return node
}

function graphqlTypeNodeToHint(node: TypeNode): string {
  if (node.kind === 'NamedType') {
    return node.name.value
  }

  if (node.kind === 'ListType') {
    return `[${graphqlTypeNodeToHint(node.type)}]`
  }

  if (node.kind === 'NonNullType') {
    return graphqlTypeNodeToHint(node.type)
  }

  return 'JSON'
}

function parseGraphqlOperation(query: string, preferredOperationName?: string): {
  operationType?: 'query' | 'mutation' | 'subscription'
  operationName?: string
  variableTypeHints?: Record<string, string>
  documentHash?: string
} {
  const normalized = query.trim()
  if (!normalized) return {}

  try {
    const document = parse(normalized, { noLocation: true })
    const operations = document.definitions.filter(
      (definition): definition is OperationDefinitionNode => definition.kind === 'OperationDefinition',
    )
    if (operations.length === 0) {
      return {}
    }

    const namedPreferred = preferredOperationName?.trim()
    const selected =
      (namedPreferred
        ? operations.find((operation) => operation.name?.value === namedPreferred)
        : undefined) ?? operations[0]

    const variableTypeHints: Record<string, string> = {}
    selected.variableDefinitions?.forEach((variable) => {
      variableTypeHints[variable.variable.name.value] = graphqlTypeNodeToHint(variable.type)
    })

    return {
      operationType: operationTypeFromNode(selected.operation),
      operationName: selected.name?.value,
      variableTypeHints: Object.keys(variableTypeHints).length > 0 ? variableTypeHints : undefined,
      documentHash: fnv1aHash(normalized),
    }
  } catch {
    return {}
  }
}

function inferGraphqlVariableTypeHint(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return '[JSON]'
    const first = inferGraphqlVariableTypeHint(value[0])
    return `[${first}]`
  }
  if (value === null) return 'JSON'
  if (typeof value === 'string') return 'String'
  if (typeof value === 'number') return Number.isInteger(value) ? 'Int' : 'Float'
  if (typeof value === 'boolean') return 'Boolean'
  if (typeof value === 'object') return 'JSON'
  return 'JSON'
}

function mergeTypeHint(existing: string | undefined, nextHint: string): string {
  if (!existing || existing === nextHint) return nextHint
  if (existing === 'JSON' || nextHint === 'JSON') return 'JSON'
  if ((existing === 'Int' && nextHint === 'Float') || (existing === 'Float' && nextHint === 'Int')) {
    return 'Float'
  }
  return 'JSON'
}

function extractGraphqlInfoFromBody(requestBody: any): {
  operationType?: 'query' | 'mutation' | 'subscription'
  operationName?: string
  documentHash?: string
  variableTypeHints?: Record<string, string>
} | null {
  if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) {
    return null
  }

  const query = typeof requestBody.query === 'string' ? requestBody.query : ''
  const explicitOperationName =
    typeof requestBody.operationName === 'string' && requestBody.operationName.trim()
      ? requestBody.operationName.trim()
      : undefined

  const parsed = parseGraphqlOperation(query, explicitOperationName)
  const operationType = parsed.operationType ?? 'query'
  const operationName = explicitOperationName ?? parsed.operationName

  const variableTypeHints: Record<string, string> = {}
  if (parsed.variableTypeHints) {
    Object.entries(parsed.variableTypeHints).forEach(([key, hint]) => {
      variableTypeHints[key] = hint
    })
  }

  if (
    requestBody.variables &&
    typeof requestBody.variables === 'object' &&
    !Array.isArray(requestBody.variables)
  ) {
    Object.entries(requestBody.variables as Record<string, unknown>).forEach(([key, value]) => {
      variableTypeHints[key] = mergeTypeHint(variableTypeHints[key], inferGraphqlVariableTypeHint(value))
    })
  }

  return {
    operationType,
    operationName,
    documentHash: parsed.documentHash,
    variableTypeHints: Object.keys(variableTypeHints).length > 0 ? variableTypeHints : undefined,
  }
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(',')}}`
}

function fnv1aHash(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function markDirty(keys: PersistedKey[]) {
  keys.forEach((key) => dirtyKeys.add(key))
}

function scheduleStorageFlush(keys: PersistedKey[], immediate = false) {
  markDirty(keys)

  if (immediate) {
    void flushDirtyKeys()
    return
  }

  if (storageFlushTimer !== null) {
    clearTimeout(storageFlushTimer)
  }

  storageFlushTimer = setTimeout(() => {
    storageFlushTimer = null
    void flushDirtyKeys()
  }, STORAGE_FLUSH_DELAY_MS)
}

async function flushDirtyKeys() {
  if (dirtyKeys.size === 0) {
    return
  }

  const keys = Array.from(dirtyKeys)
  dirtyKeys.clear()

  const payload: Partial<PersistedState> = {}
  for (const key of keys) {
    if (key === 'routes') payload.routes = state.routes
    if (key === 'requests') payload.requests = state.requests
    if (key === 'types') payload.types = state.types
    if (key === 'sampleLimit') payload.sampleLimit = state.sampleLimit
  }

  storageWriteChain = storageWriteChain
    .then(() => browser.storage.local.set(payload))
    .catch((error) => {
      console.error('Failed to persist storage payload:', error)
    })

  await storageWriteChain
}

async function initStorage() {
  const data = (await browser.storage.local.get([
    'routes',
    'requests',
    'types',
    'sampleLimit',
  ])) as Partial<PersistedState>

  state.routes = Array.isArray(data.routes) ? data.routes : []
  state.requests = Array.isArray(data.requests) ? data.requests : []
  state.types = Array.isArray(data.types) ? data.types : []
  state.sampleLimit = normalizeSampleLimit(data.sampleLimit)

  const initialPayload: Partial<PersistedState> = {}
  if (!Array.isArray(data.routes)) initialPayload.routes = state.routes
  if (!Array.isArray(data.requests)) initialPayload.requests = state.requests
  if (!Array.isArray(data.types)) initialPayload.types = state.types
  if (data.sampleLimit !== state.sampleLimit) {
    initialPayload.sampleLimit = state.sampleLimit
  }

  if (Object.keys(initialPayload).length > 0) {
    await browser.storage.local.set(initialPayload)
  }
}

function cleanupRequestCache(requestId: string) {
  requestBodies.delete(requestId)
  responseBodies.delete(requestId)
  responseMeta.delete(requestId)
}

function findMatchedRoute(details: any): ApiRoute | undefined {
  const cleanUrl = getBaseUrl(details.url)
  const routes = state.routes

  const graphqlRoute = routes.find((route) => {
    if (!route.enabled || route.parentId || !route.isGraphQL) return false
    const endpoint = normalizeGraphqlEndpoint(route.graphqlEndpoint)
    if (!endpoint) return false
    return cleanUrl === endpoint
  })
  if (graphqlRoute) {
    return graphqlRoute
  }

  let matchedRoute = routes.find((route) => {
    if (!route.enabled || route.parentId || route.isAutoDetect || route.isGraphQL) return false
    if (!route.pattern) return false
    return matchesPattern(cleanUrl, route.pattern)
  })

  const autoDetectRoute = routes.find(
    (route) =>
      route.enabled && route.isAutoDetect && route.baseUrl && matchesBaseUrl(cleanUrl, route.baseUrl),
  )

  if (autoDetectRoute) {
    const path = extractPath(cleanUrl)
    const childRoute = routes.find(
      (route) => route.parentId === autoDetectRoute.id && route.method === details.method && route.path === path,
    )
    if (childRoute) {
      return childRoute
    }
    return autoDetectRoute
  }

  return matchedRoute
}

function hasCaptureCandidate(details: any): boolean {
  const cleanUrl = getBaseUrl(details.url)
  return state.routes.some((route) => {
    if (!route.enabled || route.parentId) return false

    if (route.isGraphQL) {
      const endpoint = normalizeGraphqlEndpoint(route.graphqlEndpoint)
      return !!endpoint && endpoint === cleanUrl
    }

    if (route.isAutoDetect) {
      return !!route.baseUrl && matchesBaseUrl(cleanUrl, route.baseUrl)
    }

    if (!route.pattern) return false
    return matchesPattern(cleanUrl, route.pattern)
  })
}

function setupWebRequestListeners() {
  browser.webRequest.onHeadersReceived.addListener(
    (details) => {
      const requestId = `${details.requestId}`
      const contentType = details.responseHeaders
        ?.find((header) => header.name.toLowerCase() === 'content-type')
        ?.value

      if (contentType) {
        responseMeta.set(requestId, { contentType })
      }
      return undefined
    },
    { urls: ['<all_urls>'] },
    ['responseHeaders'],
  )

  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.tabId === -1 || !TRACKED_METHODS.has(details.method) || !hasCaptureCandidate(details)) {
        return undefined
      }

      const webRequest = browser.webRequest as any as FirefoxWebRequest
      if (!webRequest.filterResponseData) {
        return undefined
      }

      const requestId = `${details.requestId}`

      try {
        const filter = webRequest.filterResponseData(details.requestId.toString())
        const chunks: Uint8Array[] = []

        filter.onerror = (event) => {
          console.error(`Filter error for ${details.url}:`, event)
        }

        filter.ondata = (event: FilterResponseDataEvent) => {
          chunks.push(new Uint8Array(event.data))
          filter.write(event.data)
        }

        filter.onstop = () => {
          try {
            const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
            const combined = new Uint8Array(totalLength)
            let offset = 0
            for (const chunk of chunks) {
              combined.set(chunk, offset)
              offset += chunk.length
            }

            const text = new TextDecoder('utf-8').decode(combined)
            if (!text.trim()) {
              filter.close()
              return
            }

            responseBodies.set(requestId, JSON.parse(text))
          } catch {
            // JSONでないレスポンスはスキップ
          } finally {
            filter.close()
          }
        }
      } catch (error) {
        console.error(`Failed to create filter for ${details.url}:`, error)
      }

      return undefined
    },
    { urls: ['<all_urls>'] },
    ['blocking'],
  )

  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (
        !details.requestBody ||
        details.tabId === -1 ||
        !TRACKED_METHODS.has(details.method) ||
        !hasCaptureCandidate(details)
      ) {
        return undefined
      }

      const requestId = `${details.requestId}`

      if (details.requestBody.formData) {
        requestBodies.set(requestId, details.requestBody.formData)
      } else if (details.requestBody.raw) {
        try {
          const decoder = new TextDecoder('utf-8')
          const combined = details.requestBody.raw.map((item) => decoder.decode(item.bytes)).join('')
          requestBodies.set(requestId, JSON.parse(combined))
        } catch {
          // パースできない場合はスキップ
        }
      }

      return undefined
    },
    { urls: ['<all_urls>'] },
    ['requestBody'],
  )

  browser.webRequest.onCompleted.addListener(
    (details) => {
      const requestId = `${details.requestId}`

      Promise.resolve()
        .then(async () => {
          try {
            if (details.tabId === -1 || !TRACKED_METHODS.has(details.method)) {
              return
            }

            let matchedRoute = findMatchedRoute(details)

            if (matchedRoute?.isAutoDetect && matchedRoute.baseUrl) {
              const path = extractPath(getBaseUrl(details.url))
              let childRoute = state.routes.find(
                (route) =>
                  route.parentId === matchedRoute?.id &&
                  route.method === details.method &&
                  route.path === path,
              )

              if (!childRoute) {
                childRoute = await createChildRoute(matchedRoute, path, details.method)
              }

              matchedRoute = childRoute
            }

            if (matchedRoute) {
              await captureResponse(details, matchedRoute, requestId)
            }
          } finally {
            cleanupRequestCache(requestId)
          }
        })
        .catch((error) => {
          console.error('onCompleted handler error:', error)
          cleanupRequestCache(requestId)
        })
    },
    { urls: ['<all_urls>'] },
  )
}

async function createChildRoute(parentRoute: ApiRoute, path: string, method: string): Promise<ApiRoute> {
  const existing = state.routes.find(
    (route) => route.parentId === parentRoute.id && route.method === method && route.path === path,
  )
  if (existing) {
    return existing
  }

  const childRoute: ApiRoute = {
    id: `${Date.now()}-${Math.random()}`,
    pattern: '',
    name: generateRouteName(path, method),
    enabled: true,
    createdAt: Date.now(),
    parentId: parentRoute.id,
    method,
    path,
  }

  state.routes.push(childRoute)
  scheduleStorageFlush(['routes'])

  return childRoute
}

async function captureResponse(details: any, route: ApiRoute, requestId: string) {
  try {
    const queryParams = extractQueryParams(details.url)
    const requestBody = requestBodies.get(requestId)

    const contentType = responseMeta.get(requestId)?.contentType ?? ''
    const json = responseBodies.get(requestId)

    if (!json || (contentType && !contentType.includes('application/json'))) {
      return
    }

    const graphqlInfo = route.isGraphQL ? extractGraphqlInfoFromBody(requestBody) : null
    const variableTypeHints = graphqlInfo?.variableTypeHints
    const mergedVariableTypeHints: Record<string, string> | undefined = variableTypeHints
      ? Object.entries(variableTypeHints).reduce<Record<string, string>>((acc, [key, hint]) => {
          const existing = acc[key]
          acc[key] = mergeTypeHint(existing, hint)
          return acc
        }, {})
      : undefined

    const recordedRequest: RecordedRequest = {
      id: `${Date.now()}-${Math.random()}`,
      routeId: route.id,
      url: details.url,
      method: details.method,
      timestamp: Date.now(),
      response: json,
      statusCode: details.statusCode,
      queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
      requestBody,
      graphqlOperationType: graphqlInfo?.operationType,
      graphqlOperationName: graphqlInfo?.operationName,
      graphqlDocumentHash: graphqlInfo?.documentHash,
      graphqlVariableTypeHints: mergedVariableTypeHints,
    }

    state.requests.push(recordedRequest)
    if (state.requests.length > MAX_REQUESTS) {
      state.requests.shift()
    }

    typesDirty = true
    scheduleStorageFlush(['requests'])
  } catch (error) {
    console.error('Failed to capture response:', error)
  }
}

function getStatusBucket(statusCode?: number): StatusBucket {
  if (!statusCode || statusCode < 100) return 'OTHER'
  if (statusCode >= 200 && statusCode < 300) return 'SUCCESS_2XX'
  if (statusCode >= 300 && statusCode < 400) return 'REDIRECT_3XX'
  if (statusCode >= 400 && statusCode < 500) return 'CLIENT_ERROR_4XX'
  if (statusCode >= 500 && statusCode < 600) return 'SERVER_ERROR_5XX'
  return 'OTHER'
}

function statusBucketSuffix(bucket: StatusBucket): string {
  if (bucket === 'SUCCESS_2XX') return 'Success2xx'
  if (bucket === 'REDIRECT_3XX') return 'Redirect3xx'
  if (bucket === 'CLIENT_ERROR_4XX') return 'ClientError4xx'
  if (bucket === 'SERVER_ERROR_5XX') return 'ServerError5xx'
  return 'OtherStatus'
}

function toTypeBaseName(routeName: string): string {
  const typeName = generateTypeName(routeName)
  return typeName.endsWith('Response') ? typeName.slice(0, -'Response'.length) : typeName
}

function sortGroupsForStableOutput(groups: BucketGroup[]): BucketGroup[] {
  return [...groups].sort((a, b) => {
    const orderA = STATUS_BUCKET_ORDER.indexOf(a.bucket)
    const orderB = STATUS_BUCKET_ORDER.indexOf(b.bucket)
    if (orderA !== orderB) return orderA - orderB
    return Number(a.isError) - Number(b.isError)
  })
}

function buildRouteTypeSignature(routeId: string, groups: BucketGroup[]): string {
  const normalized = sortGroupsForStableOutput(groups).map((group) => ({
    bucket: group.bucket,
    isError: group.isError,
    count: group.count,
    samples: group.samples,
  }))

  return fnv1aHash(stableSerialize({ routeId, normalized }))
}

function buildGraphqlTypeSignature(routeId: string, routeRequests: RecordedRequest[]): string {
  const normalized = routeRequests.map((req) => ({
    statusCode: req.statusCode ?? null,
    documentHash: req.graphqlDocumentHash ?? null,
    operationType: req.graphqlOperationType ?? null,
    operationName: req.graphqlOperationName ?? null,
    variableTypeHints: req.graphqlVariableTypeHints ?? null,
    response: req.response ?? null,
  }))
  return fnv1aHash(stableSerialize({ routeId, normalized }))
}

function buildGroupedSamples(routeRequests: RecordedRequest[]): BucketGroup[] {
  const grouped = new Map<string, BucketGroup>()

  routeRequests.forEach((req) => {
    const bucket = getStatusBucket(req.statusCode)
    const isError = (req.statusCode ?? 0) >= 400
    const key = `${bucket}:${isError ? 'error' : 'normal'}`

    const existing = grouped.get(key)
    if (existing) {
      existing.samples.push(req.response)
      existing.count += 1
      return
    }

    grouped.set(key, {
      bucket,
      isError,
      samples: [req.response],
      count: 1,
    })
  })

  return sortGroupsForStableOutput(Array.from(grouped.values()))
}

async function updateTypeDefinition(route: ApiRoute, allRequests: RecordedRequest[]): Promise<boolean> {
  const routeRequests = allRequests
    .filter((req) => req.routeId === route.id && req.response)
    .slice(-state.sampleLimit)

  const existingIndex = state.types.findIndex((item) => item.routeId === route.id)

  if (routeRequests.length === 0) {
    if (existingIndex >= 0) {
      state.types.splice(existingIndex, 1)
      return true
    }
    return false
  }

  const groups = buildGroupedSamples(routeRequests)
  if (groups.length === 0) {
    if (existingIndex >= 0) {
      state.types.splice(existingIndex, 1)
      return true
    }
    return false
  }

  const signature = route.isGraphQL
    ? buildGraphqlTypeSignature(route.id, routeRequests)
    : buildRouteTypeSignature(route.id, groups)
  const existingType = state.types.find((item) => item.routeId === route.id)
  if (existingType?.signature === signature) {
    return false
  }

  if (route.isGraphQL) {
    const graphqlSchema = generateGraphqlSchemaFromRequests(routeRequests, route.name)
    const generatedType: GeneratedType = {
      routeId: route.id,
      routeName: route.name,
      typeName: `${toTypeBaseName(route.name)}Schema`,
      typeDefinition: graphqlSchema,
      format: 'graphql',
      sampleCount: routeRequests.length,
      lastUpdated: Date.now(),
      signature,
    }

    if (existingIndex >= 0) {
      state.types[existingIndex] = generatedType
    } else {
      state.types.push(generatedType)
    }

    return true
  }

  const baseName = toTypeBaseName(route.name)
  const groupedDefinitions: string[] = []

  for (const group of groups) {
    const suffix = statusBucketSuffix(group.bucket)
    const typeName = group.isError ? `${baseName}${suffix}ErrorResponse` : `${baseName}${suffix}Response`
    const definition = generateTypeFromSamples(group.samples, typeName, {
      analyzeAllArrayElements: true,
    })
    groupedDefinitions.push(definition)
  }

  const mergedDefinitions = groupedDefinitions.join('\n\n')
  const generatedType: GeneratedType = {
    routeId: route.id,
    routeName: route.name,
    typeName: `${baseName}Response`,
    typeDefinition: await formatCode(mergedDefinitions),
    format: 'typescript',
    sampleCount: routeRequests.length,
    lastUpdated: Date.now(),
    signature,
  }

  if (existingIndex >= 0) {
    state.types[existingIndex] = generatedType
  } else {
    state.types.push(generatedType)
  }

  return true
}

async function regenerateAllTypes() {
  if (!typesDirty) {
    return
  }

  let hasChanges = false
  for (const route of state.routes) {
    const changed = await updateTypeDefinition(route, state.requests)
    if (changed) {
      hasChanges = true
    }
  }

  if (hasChanges) {
    scheduleStorageFlush(['types'], true)
  }
  typesDirty = false
}

function setupMessageListeners() {
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'GET_DATA') {
      sendResponse(state)
      return true
    }

    if (message.type === 'GET_RESULT_DATA') {
      regenerateAllTypes()
        .then(() => sendResponse(state))
        .catch((error) => sendResponse({ ...state, __error: String(error) }))
      return true
    }

    if (message.type === 'REGENERATE_TYPES') {
      regenerateAllTypes()
        .then(() => sendResponse({ success: true }))
        .catch((error) => sendResponse({ success: false, error: String(error) }))
      return true
    }

    if (message.type === 'CLEAR_ALL') {
      state.routes = []
      state.requests = []
      state.types = []
      typesDirty = true
      scheduleStorageFlush(['routes', 'requests', 'types'], true)
      sendResponse({ success: true })
      return true
    }

    if (message.type === 'ADD_ROUTE') {
      const isAutoDetect = message.isAutoDetect === true
      const isGraphQL = message.isGraphQL === true
      const graphqlEndpoint = normalizeGraphqlEndpoint(message.graphqlEndpoint)

      if (isGraphQL && !graphqlEndpoint) {
        sendResponse({ success: false, error: 'Invalid GraphQL endpoint' })
        return true
      }

      const newRoute: ApiRoute = {
        id: `${Date.now()}-${Math.random()}`,
        pattern: isAutoDetect || isGraphQL ? '' : message.pattern,
        name: message.name,
        enabled: true,
        createdAt: Date.now(),
        isAutoDetect: isAutoDetect && !isGraphQL,
        isGraphQL,
        baseUrl: isAutoDetect ? message.baseUrl : undefined,
        graphqlEndpoint: isGraphQL ? graphqlEndpoint : undefined,
      }

      state.routes.push(newRoute)
      typesDirty = true
      scheduleStorageFlush(['routes'])
      sendResponse({ success: true, route: newRoute })
      return true
    }

    if (message.type === 'DELETE_ROUTE') {
      const routeIdsToDelete = new Set<string>([message.routeId])
      for (const route of state.routes) {
        if (route.parentId === message.routeId) {
          routeIdsToDelete.add(route.id)
        }
      }

      state.routes = state.routes.filter((route) => !routeIdsToDelete.has(route.id))
      state.requests = state.requests.filter((request) => !routeIdsToDelete.has(request.routeId))
      state.types = state.types.filter((typeItem) => !routeIdsToDelete.has(typeItem.routeId))

      typesDirty = true
      scheduleStorageFlush(['routes', 'requests', 'types'])
      sendResponse({ success: true })
      return true
    }

    if (message.type === 'TOGGLE_ROUTE') {
      const route = state.routes.find((item) => item.id === message.routeId)
      if (route) {
        route.enabled = !route.enabled
        scheduleStorageFlush(['routes'])
      }
      sendResponse({ success: true })
      return true
    }

    if (message.type === 'GET_SETTINGS') {
      const settings: AppSettings = { sampleLimit: state.sampleLimit }
      sendResponse({ success: true, settings })
      return true
    }

    if (message.type === 'UPDATE_SETTINGS') {
      const sampleLimit = normalizeSampleLimit(message.sampleLimit)
      state.sampleLimit = sampleLimit
      typesDirty = true
      scheduleStorageFlush(['sampleLimit'], true)
      sendResponse({ success: true, settings: { sampleLimit } })
      return true
    }

    if (message.type === 'PROMOTE_TO_PATTERN') {
      const parentRoute = state.routes.find((r) => r.id === message.parentRouteId)
      if (!parentRoute || !parentRoute.isAutoDetect || !parentRoute.baseUrl) {
        sendResponse({ success: false, error: 'AUTO parent route not found' })
        return true
      }

      let parentOrigin: string
      try {
        parentOrigin = new URL(parentRoute.baseUrl).origin
      } catch {
        sendResponse({ success: false, error: 'Invalid baseUrl on AUTO route' })
        return true
      }

      // 子ルートの中でパターンにマッチするものを全て収集
      const childRoutes = state.routes.filter((r) => r.parentId === parentRoute.id)
      const matchingChildren = childRoutes.filter((child) => {
        if (!child.path) return false
        if (message.method && child.method !== message.method) return false
        return matchesPattern(`${parentOrigin}${child.path}`, message.pattern)
      })

      if (matchingChildren.length === 0) {
        sendResponse({ success: false, error: 'No matching collected routes found for this pattern' })
        return true
      }

      const newRoute: ApiRoute = {
        id: `${Date.now()}-${Math.random()}`,
        pattern: message.pattern,
        name: message.name,
        enabled: true,
        createdAt: Date.now(),
        method: message.method || undefined,
      }

      const matchingIds = new Set(matchingChildren.map((r) => r.id))

      // マッチした子ルートのリクエストを新ルートに付け替え
      state.requests.forEach((req) => {
        if (matchingIds.has(req.routeId)) {
          req.routeId = newRoute.id
        }
      })

      // マッチした子ルートの型定義を削除（新ルート名で再生成させる）
      state.types = state.types.filter((t) => !matchingIds.has(t.routeId))

      // マッチした子ルートを削除して新ルートを追加
      state.routes = state.routes.filter((r) => !matchingIds.has(r.id))
      state.routes.push(newRoute)

      typesDirty = true
      scheduleStorageFlush(['routes', 'requests', 'types'])
      sendResponse({ success: true, route: newRoute, promotedCount: matchingChildren.length })
      return true
    }

    return false
  })
}
