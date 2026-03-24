import type { RecordedRequest } from '@/types'

type OperationKind = 'query' | 'mutation' | 'subscription'

type OperationAggregate = {
  operationName: string
  operationType: OperationKind
  responses: any[]
  variableTypeHints: Record<string, string>
}

const GRAPHQL_NAME_PATTERN = /^[_A-Za-z][_0-9A-Za-z]*$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toGraphqlName(raw: string, fallback: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return fallback
  if (GRAPHQL_NAME_PATTERN.test(trimmed)) return trimmed

  const parts = trimmed
    .split(/[^A-Za-z0-9_]+/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) return fallback

  const joined = parts
    .map((part, index) => {
      const head = part.charAt(0)
      const tail = part.slice(1)
      if (index === 0) return `${head.toLowerCase()}${tail}`
      return `${head.toUpperCase()}${tail}`
    })
    .join('')

  const normalized = /^\d/.test(joined) ? `_${joined}` : joined
  return GRAPHQL_NAME_PATTERN.test(normalized) ? normalized : fallback
}

function toPascalCase(raw: string, fallback: string): string {
  const safe = toGraphqlName(raw, fallback)
  return safe.charAt(0).toUpperCase() + safe.slice(1)
}

function normalizeVariableTypeHint(hint: string): string {
  if (hint === 'String' || hint === 'Boolean' || hint === 'Int' || hint === 'Float' || hint === 'ID') {
    return hint
  }
  if (/^\[(String|Boolean|Int|Float|ID|JSON)\]$/.test(hint)) {
    return hint
  }
  return 'JSON'
}

function mergeVariableTypeHint(existing: string | undefined, nextHint: string): string {
  const normalizedNext = normalizeVariableTypeHint(nextHint)
  if (!existing) return normalizedNext
  if (existing === normalizedNext) return existing
  if (existing === 'JSON' || normalizedNext === 'JSON') return 'JSON'
  if ((existing === 'Int' && normalizedNext === 'Float') || (existing === 'Float' && normalizedNext === 'Int')) {
    return 'Float'
  }
  return 'JSON'
}

function inferScalarType(values: unknown[]): string {
  const nonNullValues = values.filter((value) => value !== null && value !== undefined)
  if (nonNullValues.length === 0) return 'JSON'

  const kinds = new Set(
    nonNullValues.map((value) => {
      if (Array.isArray(value)) return 'array'
      if (isPlainObject(value)) return 'object'
      if (typeof value === 'string') return 'string'
      if (typeof value === 'number') return 'number'
      if (typeof value === 'boolean') return 'boolean'
      return 'other'
    }),
  )

  if (kinds.size !== 1) return 'JSON'

  const kind = Array.from(kinds)[0]
  if (kind === 'string') return 'String'
  if (kind === 'number') {
    return nonNullValues.every((value) => typeof value === 'number' && Number.isInteger(value)) ? 'Int' : 'Float'
  }
  if (kind === 'boolean') return 'Boolean'
  return 'JSON'
}

function inferFieldType(
  values: unknown[],
  typeNamePrefix: string,
  typeDefinitions: Map<string, string>,
  inProgress: Set<string>,
): string {
  const nonNullValues = values.filter((value) => value !== null && value !== undefined)
  if (nonNullValues.length === 0) return 'JSON'

  const hasObject = nonNullValues.some((value) => isPlainObject(value))
  const hasArray = nonNullValues.some((value) => Array.isArray(value))
  const hasPrimitive = nonNullValues.some((value) => !Array.isArray(value) && !isPlainObject(value))

  if ((hasObject && (hasArray || hasPrimitive)) || (hasArray && hasPrimitive)) {
    return 'JSON'
  }

  if (hasObject) {
    return buildObjectType(
      nonNullValues.filter((value): value is Record<string, unknown> => isPlainObject(value)),
      typeNamePrefix,
      typeDefinitions,
      inProgress,
    )
  }

  if (hasArray) {
    const flattened = nonNullValues.flatMap((value) => (Array.isArray(value) ? value : []))
    const itemType = inferFieldType(flattened, `${typeNamePrefix}Item`, typeDefinitions, inProgress)
    return `[${itemType}]`
  }

  return inferScalarType(nonNullValues)
}

function buildObjectType(
  objects: Record<string, unknown>[],
  typeName: string,
  typeDefinitions: Map<string, string>,
  inProgress: Set<string>,
): string {
  const safeTypeName = toPascalCase(typeName, 'GeneratedObject')
  if (typeDefinitions.has(safeTypeName)) {
    return safeTypeName
  }
  if (inProgress.has(safeTypeName)) {
    return 'JSON'
  }

  inProgress.add(safeTypeName)
  try {
    const fieldMap = new Map<string, unknown[]>()
    objects.forEach((obj) => {
      Object.entries(obj).forEach(([key, value]) => {
        if (!fieldMap.has(key)) {
          fieldMap.set(key, [])
        }
        fieldMap.get(key)!.push(value)
      })
    })

    if (fieldMap.size === 0) {
      return 'JSON'
    }

    const fields = Array.from(fieldMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([rawKey, values], index) => {
        const fieldName = toGraphqlName(rawKey, `field${index + 1}`)
        const fieldType = inferFieldType(values, `${safeTypeName}${toPascalCase(rawKey, `Field${index + 1}`)}`, typeDefinitions, inProgress)
        return `  ${fieldName}: ${fieldType}`
      })

    typeDefinitions.set(safeTypeName, `type ${safeTypeName} {\n${fields.join('\n')}\n}`)
    return safeTypeName
  } finally {
    inProgress.delete(safeTypeName)
  }
}

export function generateGraphqlSchemaFromRequests(requests: RecordedRequest[], routeName: string): string {
  const operationMap = new Map<string, OperationAggregate>()

  let anonymousCounter = 0
  requests.forEach((request) => {
    if (!request.response) return
    const operationType: OperationKind = request.graphqlOperationType ?? 'query'
    const operationName = request.graphqlOperationName?.trim()
      ? request.graphqlOperationName.trim()
      : `Anonymous${operationType.charAt(0).toUpperCase()}${operationType.slice(1)}${++anonymousCounter}`
    const key = `${operationType}:${operationName}`

    if (!operationMap.has(key)) {
      operationMap.set(key, {
        operationName,
        operationType,
        responses: [],
        variableTypeHints: {},
      })
    }

    const aggregate = operationMap.get(key)!
    aggregate.responses.push(request.response)

    if (request.graphqlVariableTypeHints) {
      Object.entries(request.graphqlVariableTypeHints).forEach(([name, hint]) => {
        aggregate.variableTypeHints[name] = mergeVariableTypeHint(aggregate.variableTypeHints[name], hint)
      })
    }
  })

  if (operationMap.size === 0) {
    const fallbackName = toPascalCase(routeName, 'Api')
    return [
      'scalar JSON',
      '',
      'schema {',
      '  query: Query',
      '}',
      '',
      'type Query {',
      `  ${toGraphqlName(`${fallbackName}Fallback`, 'fallback')}: JSON`,
      '}',
    ].join('\n')
  }

  const queryFields: string[] = []
  const mutationFields: string[] = []
  const subscriptionFields: string[] = []
  const typeDefinitions = new Map<string, string>()
  const inProgress = new Set<string>()
  let usesGraphqlError = false

  Array.from(operationMap.values())
    .sort((a, b) => `${a.operationType}:${a.operationName}`.localeCompare(`${b.operationType}:${b.operationName}`))
    .forEach((operation, index) => {
      const operationBaseName = toPascalCase(operation.operationName, `Operation${index + 1}`)
      const fieldName = toGraphqlName(operation.operationName, `operation${index + 1}`)
      const resultTypeName = `${operationBaseName}Result`
      const dataTypeName = `${operationBaseName}Data`

      const responseObjects = operation.responses.filter((response): response is Record<string, unknown> =>
        isPlainObject(response),
      )
      const dataValues = responseObjects.map((response) => response.data).filter((value) => value !== undefined)
      const errorsValues = responseObjects.map((response) => response.errors).filter((value) => value !== undefined)
      const extensionValues = responseObjects
        .map((response) => response.extensions)
        .filter((value) => value !== undefined)

      const args = Object.entries(operation.variableTypeHints)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, hint], argIndex) => `${toGraphqlName(name, `arg${argIndex + 1}`)}: ${normalizeVariableTypeHint(hint)}`)
        .join(', ')
      const fieldSignature = `${fieldName}${args ? `(${args})` : ''}: ${resultTypeName}`

      if (operation.operationType === 'mutation') {
        mutationFields.push(`  ${fieldSignature}`)
      } else if (operation.operationType === 'subscription') {
        subscriptionFields.push(`  ${fieldSignature}`)
      } else {
        queryFields.push(`  ${fieldSignature}`)
      }

      const resultFields: string[] = []
      if (dataValues.length > 0) {
        const dataType = inferFieldType(dataValues, dataTypeName, typeDefinitions, inProgress)
        resultFields.push(`  data: ${dataType}`)
      }
      if (errorsValues.length > 0) {
        resultFields.push('  errors: [GraphQLError]')
        usesGraphqlError = true
      }
      if (extensionValues.length > 0) {
        resultFields.push('  extensions: JSON')
      }
      if (resultFields.length === 0) {
        resultFields.push('  raw: JSON')
      }

      typeDefinitions.set(resultTypeName, `type ${resultTypeName} {\n${resultFields.join('\n')}\n}`)
    })

  const schemaLines = ['schema {']
  if (queryFields.length > 0) schemaLines.push('  query: Query')
  if (mutationFields.length > 0) schemaLines.push('  mutation: Mutation')
  if (subscriptionFields.length > 0) schemaLines.push('  subscription: Subscription')
  schemaLines.push('}')

  const blocks: string[] = ['scalar JSON', '', schemaLines.join('\n')]

  if (queryFields.length > 0) {
    blocks.push('', `type Query {\n${queryFields.join('\n')}\n}`)
  }
  if (mutationFields.length > 0) {
    blocks.push('', `type Mutation {\n${mutationFields.join('\n')}\n}`)
  }
  if (subscriptionFields.length > 0) {
    blocks.push('', `type Subscription {\n${subscriptionFields.join('\n')}\n}`)
  }
  if (usesGraphqlError) {
    blocks.push('', 'type GraphQLError {\n  message: String\n  path: [JSON]\n  extensions: JSON\n}')
  }

  const otherTypes = Array.from(typeDefinitions.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, definition]) => definition)
  if (otherTypes.length > 0) {
    blocks.push('', otherTypes.join('\n\n'))
  }

  return blocks.join('\n')
}
