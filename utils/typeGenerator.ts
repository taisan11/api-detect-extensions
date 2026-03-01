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

/**
 * 複数のオブジェクトサンプルを1つの統合型に変換する。
 * 全サンプルに存在しないキーはオプショナルになる。
 * ネストされたオブジェクトも再帰的に統合する。
 */
function mergeObjectValues(
    objects: Record<string, unknown>[],
    options: Required<TypeGenerationOptions>,
    visited: WeakSet<object>,
    indent: number,
): string {
    const propertyMap = new Map<string, unknown[]>()
    const total = objects.length

    for (const obj of objects) {
        for (const [key, value] of Object.entries(obj).sort(([a], [b]) => a.localeCompare(b))) {
            if (!propertyMap.has(key)) propertyMap.set(key, [])
            propertyMap.get(key)!.push(value)
        }
    }

    if (propertyMap.size === 0) return 'Record<string, unknown>'

    const indentStr = ' '.repeat(options.indentSize * indent)
    const nextIndent = ' '.repeat(options.indentSize * (indent + 1))
    const sortedKeys = Array.from(propertyMap.keys()).sort((a, b) => a.localeCompare(b))
    const properties: string[] = []

    for (const key of sortedKeys) {
        const values = propertyMap.get(key)!
        const hasNull = values.some(v => v === null)
        const hasUndefined = values.length < total || values.some(v => v === undefined)
        const nonNullValues = values.filter(v => v !== null && v !== undefined)

        const objVals = nonNullValues.filter(
            v => typeof v === 'object' && !Array.isArray(v)
        ) as Record<string, unknown>[]
        const otherVals = nonNullValues.filter(
            v => !(typeof v === 'object' && !Array.isArray(v))
        )

        let typeStr: string
        if (objVals.length > 0 && otherVals.length === 0) {
            typeStr = mergeObjectValues(objVals, options, visited, indent + 1)
        } else {
            const types = nonNullValues.map(v => inferType(v, options, visited))
            typeStr = buildUnion(normalizeUnionTypes(types), 'unknown')
        }

        const parts: string[] = [typeStr]
        if (hasNull) parts.push('null')
        const finalType = parts.length === 1 ? parts[0] : parts.join(' | ')

        const optional = hasUndefined ? '?' : ''
        const readonly = options.readonly ? 'readonly ' : ''
        properties.push(`\n${nextIndent}${readonly}${toSafeKey(key)}${optional}: ${finalType};`)
    }

    return `{${properties.join('')}\n${indentStr}}`
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function generateTypeFromJson(
    json: any,
    typeName: string,
    options: TypeGenerationOptions = {},
): string {
    const opts = { ...DEFAULT_OPTIONS, ...options }
    const visited = new WeakSet<object>()

    const typeDefinition = generateType(json, typeName, 0, opts, visited)

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
    visited: WeakSet<object>,
): string {
    if (value === null || value === undefined) {
        return value === null ? 'null' : 'undefined'
    }

    const indentStr = ' '.repeat(options.indentSize * indent)
    const nextIndent = ' '.repeat(options.indentSize * (indent + 1))

    if (typeof value === 'object' && visited.has(value)) {
        return 'unknown /* 循環参照を検出 */'
    }

    if (Array.isArray(value)) {
        if (value.length === 0) {
            return 'unknown[]'
        }

        const samplesToAnalyze = options.analyzeAllArrayElements
            ? value
            : value.slice(0, options.maxArraySamples)

        const objItems = samplesToAnalyze.filter(isPlainObject) as Record<string, unknown>[]
        const otherItems = samplesToAnalyze.filter(item => !isPlainObject(item))

        if (objItems.length > 0 && otherItems.length === 0) {
            const merged = mergeObjectValues(objItems, options, visited, indent + 1)
            return normalizedArrayUnion([merged])
        }

        const itemTypes = samplesToAnalyze.map((item) => inferType(item, options, visited))
        return normalizedArrayUnion(itemTypes)
    }

    if (typeof value === 'object') {
        visited.add(value)
        try {
            const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
            const properties = entries.map(([key, val]) => {
                const propType = inferType(val, options, visited)
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
        } finally {
            visited.delete(value)
        }
    }

    return typeof value
}

function inferType(value: any, options: Required<TypeGenerationOptions>, visited: WeakSet<object>): string {
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

        const objItems = samplesToAnalyze.filter(isPlainObject) as Record<string, unknown>[]
        const otherItems = samplesToAnalyze.filter(item => !isPlainObject(item))

        if (objItems.length > 0 && otherItems.length === 0) {
            const merged = mergeObjectValues(objItems, options, visited, 0)
            return normalizedArrayUnion([merged])
        }

        const itemTypes = samplesToAnalyze.map((item) => inferType(item, options, visited))
        return normalizedArrayUnion(itemTypes)
    }

    if (typeof value === 'object') {
        if (visited.has(value)) {
            return 'unknown /* 循環参照 */'
        }

        visited.add(value)
        try {
            const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
            const properties = entries.map(([key, val]) => `${toSafeKey(key)}: ${inferType(val, options, visited)}`)

            if (properties.length === 0) {
                return 'Record<string, unknown>'
            }

            return `{ ${properties.join('; ')} }`
        } finally {
            visited.delete(value)
        }
    }

    return typeof value
}

function normalizedArrayUnion(itemTypes: string[]): string {
    const normalized = buildUnion(itemTypes)
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
    const visited = new WeakSet<object>()

    if (samples.length === 0) {
        return `interface ${typeName} {\n  [key: string]: unknown;\n}`
    }

    const objectSamples = samples.filter(isPlainObject) as Record<string, unknown>[]
    const nonObjectSamples = samples.filter((sample) => !isPlainObject(sample))

    if (objectSamples.length === 0) {
        const inferredTypes = samples.map((sample) => inferType(sample, opts, visited))
        const topLevelType = buildUnion(normalizeUnionTypes(inferredTypes), 'unknown')
        return `type ${typeName} = ${topLevelType};`
    }

    if (nonObjectSamples.length > 0) {
        const objectType = mergeObjectValues(objectSamples, opts, visited, 0)
        const inferredTypes = nonObjectSamples.map((sample) => inferType(sample, opts, visited))
        const nonObjectType = buildUnion(normalizeUnionTypes(inferredTypes), 'unknown')
        const topLevelType = buildUnion([objectType, nonObjectType], 'unknown')
        return `type ${typeName} = ${topLevelType};`
    }

    const propertyMap = new Map<string, any[]>()

    objectSamples.forEach((sample) => {
        Object.entries(sample).forEach(([key, value]) => {
            if (!propertyMap.has(key)) {
                propertyMap.set(key, [])
            }
            propertyMap.get(key)!.push(value)
        })
    })

    const properties: string[] = []
    const totalSamples = objectSamples.length
    const indentStr = ' '.repeat(opts.indentSize)
    const sortedPropertyKeys = Array.from(propertyMap.keys()).sort((a, b) => a.localeCompare(b))

    sortedPropertyKeys.forEach((key) => {
        const values = propertyMap.get(key) ?? []
        let hasNull = false
        let hasUndefined = values.length < totalSamples

        const nonNullValues: unknown[] = []
        values.forEach((value) => {
            if (value === null) { hasNull = true; return }
            if (value === undefined) { hasUndefined = true; return }
            nonNullValues.push(value)
        })

        // 全て plain object なら統合、それ以外は従来通り Union
        const objVals = nonNullValues.filter(isPlainObject) as Record<string, unknown>[]
        const otherVals = nonNullValues.filter(v => !isPlainObject(v))

        let baseType: string
        if (objVals.length > 0 && otherVals.length === 0) {
            baseType = mergeObjectValues(objVals, opts, visited, 1)
        } else {
            const inferredTypes = nonNullValues.map(v => inferType(v, opts, visited))
            baseType = buildUnion(normalizeUnionTypes(inferredTypes), 'unknown')
        }

        const unionParts: string[] = [baseType]
        if (hasNull) unionParts.push('null')
        const typeStr = unionParts.length === 1 ? unionParts[0] : unionParts.join(' | ')

        const optional = hasUndefined ? '?' : ''
        const readonly = opts.readonly ? 'readonly ' : ''
        const comment = opts.generateComments
            ? `\n${indentStr}/** 出現回数: ${values.length}/${totalSamples} */`
            : ''

        properties.push(`${comment}\n${indentStr}${readonly}${toSafeKey(key)}${optional}: ${typeStr};`)
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
