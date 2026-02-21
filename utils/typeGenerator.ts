/**
 * JSONオブジェクトからTypeScript型定義を生成するユーティリティ
 */

interface TypeGenerationOptions {
    indentSize?: number
    detectDates?: boolean
    analyzeAllArrayElements?: boolean
    readonly?: boolean
    generateComments?: boolean
    maxArraySamples?: number
}

const DEFAULT_OPTIONS: Required<TypeGenerationOptions> = {
    indentSize: 2,
    detectDates: true,
    analyzeAllArrayElements: false,
    readonly: false,
    generateComments: false,
    maxArraySamples: 100,
}

let visitedObjects: WeakSet<object> = new WeakSet<object>()

function compareUnionType(a: string, b: string): number {
    const order = (type: string): number => {
        if (type === 'undefined') return 1
        if (type === 'null') return 2
        return 0
    }

    const oa = order(a)
    const ob = order(b)
    if (oa !== ob) return oa - ob
    return a.localeCompare(b)
}

function normalizeUnionTypes(types: Iterable<string>): string[] {
    return Array.from(new Set(Array.from(types))).sort(compareUnionType)
}

function buildUnion(types: Iterable<string>, fallback = 'unknown'): string {
    const normalized = normalizeUnionTypes(types)
    if (normalized.length === 0) return fallback
    if (normalized.length === 1) return normalized[0]
    return normalized.join(' | ')
}

function toSafeKey(key: string): string {
    return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : `"${key}"`
}

export function generateTypeFromJson(
    json: any,
    typeName: string,
    options: TypeGenerationOptions = {},
): string {
    const opts = { ...DEFAULT_OPTIONS, ...options }
    visitedObjects = new WeakSet<object>()

    const typeDefinition = generateType(json, typeName, 0, opts)

    if (typeof json === 'object' && json !== null && !Array.isArray(json)) {
        return typeDefinition
    }

    return `type ${typeName} = ${typeDefinition};`
}

function generateType(
    value: any,
    typeName: string,
    indent: number,
    options: Required<TypeGenerationOptions>,
): string {
    if (value === null || value === undefined) {
        return value === null ? 'null' : 'undefined'
    }

    const indentStr = ' '.repeat(options.indentSize * indent)
    const nextIndent = ' '.repeat(options.indentSize * (indent + 1))

    if (typeof value === 'object' && visitedObjects.has(value)) {
        return 'unknown /* 循環参照を検出 */'
    }

    if (Array.isArray(value)) {
        if (value.length === 0) {
            return 'unknown[]'
        }

        const samplesToAnalyze = options.analyzeAllArrayElements
            ? value
            : value.slice(0, options.maxArraySamples)

        const itemTypes = samplesToAnalyze.map((item) => inferType(item, options))
        const union = buildUnion(itemTypes)
        return normalizedArrayUnion(union)
    }

    if (typeof value === 'object') {
        visitedObjects.add(value)

        const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
        const properties = entries.map(([key, val]) => {
            const propType = inferType(val, options)
            const readonly = options.readonly ? 'readonly ' : ''
            const comment = options.generateComments
                ? `\n${nextIndent}/** ${getPropertyComment(key, val)} */`
                : ''

            return `${comment}\n${nextIndent}${readonly}${toSafeKey(key)}: ${propType};`
        })

        if (indent === 0) {
            const interfaceBody = properties.join('')
            const comment = options.generateComments ? `/**\n * ${typeName} の型定義\n */\n` : ''
            return `${comment}interface ${typeName} {${interfaceBody}\n}`
        }

        return `{${properties.join('')}\n${indentStr}}`
    }

    return typeof value
}

function inferType(value: any, options: Required<TypeGenerationOptions>): string {
    if (value === null) return 'null'
    if (value === undefined) return 'undefined'

    if (options.detectDates && typeof value === 'string' && isDateString(value)) {
        return 'string /* ISO Date */'
    }

    if (Array.isArray(value)) {
        if (value.length === 0) return 'unknown[]'

        const samplesToAnalyze = options.analyzeAllArrayElements
            ? value
            : value.slice(0, options.maxArraySamples)

        const itemTypes = samplesToAnalyze.map((item) => inferType(item, options))
        const union = buildUnion(itemTypes)
        return normalizedArrayUnion(union)
    }

    if (typeof value === 'object') {
        if (visitedObjects.has(value)) {
            return 'unknown /* 循環参照 */'
        }

        const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
        const properties = entries.map(([key, val]) => `${toSafeKey(key)}: ${inferType(val, options)}`)

        if (properties.length === 0) {
            return 'Record<string, unknown>'
        }

        return `{ ${properties.join('; ')} }`
    }

    return typeof value
}

function normalizedArrayUnion(union: string): string {
    const types = union.split('|').map((item) => item.trim())
    const normalized = buildUnion(types)
    if (!normalized.includes('|')) {
        return `${normalized}[]`
    }
    return `(${normalized})[]`
}

function isDateString(value: string): boolean {
    const isoDatePattern = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?)?$/
    if (!isoDatePattern.test(value)) return false

    const date = new Date(value)
    return !isNaN(date.getTime())
}

function getPropertyComment(key: string, value: any): string {
    if (Array.isArray(value)) {
        return `${key} の配列 (${value.length}件)`
    }
    if (typeof value === 'object' && value !== null) {
        return `${key} オブジェクト`
    }
    return key
}

export function generateTypeFromSamples(
    samples: any[],
    typeName: string,
    options: TypeGenerationOptions = {},
): string {
    const opts = { ...DEFAULT_OPTIONS, ...options }

    if (samples.length === 0) {
        return `interface ${typeName} {\n  [key: string]: unknown;\n}`
    }

    const propertyMap = new Map<string, any[]>()

    samples.forEach((sample) => {
        if (typeof sample !== 'object' || sample === null || Array.isArray(sample)) {
            return
        }

        Object.entries(sample).forEach(([key, value]) => {
            if (!propertyMap.has(key)) {
                propertyMap.set(key, [])
            }
            propertyMap.get(key)!.push(value)
        })
    })

    const properties: string[] = []
    const totalSamples = samples.length
    const indentStr = ' '.repeat(opts.indentSize)
    const sortedPropertyKeys = Array.from(propertyMap.keys()).sort((a, b) => a.localeCompare(b))

    sortedPropertyKeys.forEach((key) => {
        const values = propertyMap.get(key) ?? []
        const inferredTypes: string[] = []
        let hasNull = false
        let hasUndefined = values.length < totalSamples

        values.forEach((value) => {
            if (value === null) {
                hasNull = true
                return
            }
            if (value === undefined) {
                hasUndefined = true
                return
            }
            inferredTypes.push(inferType(value, opts))
        })

        const unionTypes = [...normalizeUnionTypes(inferredTypes)]
        if (hasUndefined) unionTypes.push('undefined')
        if (hasNull) unionTypes.push('null')

        const typeStr = buildUnion(unionTypes, 'unknown')
        const readonly = opts.readonly ? 'readonly ' : ''
        const comment = opts.generateComments
            ? `\n${indentStr}/** 出現回数: ${values.length}/${totalSamples} */`
            : ''

        properties.push(`${comment}\n${indentStr}${readonly}${toSafeKey(key)}: ${typeStr};`)
    })

    const interfaceBody = properties.join('')
    const comment = opts.generateComments
        ? `/**\n * ${typeName} の型定義\n * ${totalSamples}件のサンプルから生成\n */\n`
        : ''

    return `${comment}interface ${typeName} {${interfaceBody}\n}`
}

export function generateTypeName(routeName: string): string {
    const segments = routeName
        .split(/[\/\-_\s\(\)\{\}\[\]]+/)
        .filter((segment) => segment.length > 0)
        .map((segment) =>
            segment
                .split(/[\-_]/)
                .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
                .join(''),
        )

    const cleaned = segments
        .map((segment) => segment.replace(/^(Api|Endpoint|Route)$/i, ''))
        .filter((segment) => segment.length > 0)

    if (cleaned.length === 0) {
        return 'ApiResponse'
    }

    const typeName = cleaned.join('') + 'Response'
    if (/^\d/.test(typeName)) {
        return 'T' + typeName
    }

    return typeName
}

export function formatTypeDefinition(typeDefinition: string): string {
    return typeDefinition
        .split('\n')
        .filter((line, index, arr) => {
            if (line.trim() === '') {
                return arr[index - 1]?.trim() !== ''
            }
            return true
        })
        .join('\n')
        .trim()
}

export function mergeTypeDefinitions(types: string[], namespaceName?: string): string {
    const formatted = types.map(formatTypeDefinition).join('\n\n')

    if (namespaceName) {
        const indented = formatted
            .split('\n')
            .map((line) => '  ' + line)
            .join('\n')
        return `export namespace ${namespaceName} {\n${indented}\n}`
    }

    return formatted
}
