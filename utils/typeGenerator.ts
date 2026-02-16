/**
 * JSONオブジェクトからTypeScript型定義を生成する高度なユーティリティ
 */

interface TypeGenerationOptions {
  /** インデントのスペース数 */
  indentSize?:  number;
  /** 日付文字列を Date 型として認識するか */
  detectDates?: boolean;
  /** 配列内の全要素を分析してUnion型を生成するか */
  analyzeAllArrayElements?: boolean;
  /** readonly修飾子を付与するか */
  readonly?: boolean;
  /** JSDocコメントを生成するか */
  generateComments?: boolean;
  /** 最大分析要素数（配列） */
  maxArraySamples?: number;
}

const DEFAULT_OPTIONS: Required<TypeGenerationOptions> = {
  indentSize: 2,
  detectDates: true,
  analyzeAllArrayElements: false,
  readonly: false,
  generateComments: false,
  maxArraySamples: 100,
};

/**
 * 循環参照を検出するためのWeakSet
 */
let visitedObjects: WeakSet<object> = new WeakSet<object>();

/**
 * JSONオブジェクトからTypeScript型定義を生成
 */
export function generateTypeFromJson(
  json: any,
  typeName: string,
  options: TypeGenerationOptions = {}
): string {
  const opts = { ...DEFAULT_OPTIONS, ... options };
  visitedObjects = new WeakSet<object>();
  
  const typeDefinition = generateType(json, typeName, 0, opts);
  
  if (typeof json === 'object' && json !== null && !Array.isArray(json)) {
    return typeDefinition;
  }
  
  // プリミティブ型や配列の場合は type エイリアスとして返す
  return `type ${typeName} = ${typeDefinition};`;
}

/**
 * 内部的な型生成関数
 */
function generateType(
  value: any,
  typeName: string,
  indent: number,
  options: Required<TypeGenerationOptions>
): string {
  if (value === null || value === undefined) {
    return value === null ? 'null' : 'undefined';
  }

  const indentStr = ' '.repeat(options.indentSize * indent);
  const nextIndent = ' '.repeat(options.indentSize * (indent + 1));

  // 循環参照チェック
  if (typeof value === 'object' && visitedObjects.has(value)) {
    return 'any /* 循環参照を検出 */';
  }

  // 配列の処理
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return 'any[]';
    }

    const samplesToAnalyze = options. analyzeAllArrayElements
      ?  value
      : value.slice(0, options.maxArraySamples);

    const types = new Set<string>();
    samplesToAnalyze.forEach((item) => {
      types.add(inferType(item, options));
    });

    const uniqueTypes = Array.from(types);
    if (uniqueTypes.length === 1) {
      return `${uniqueTypes[0]}[]`;
    }
    
    // Union型として返す
    return `(${uniqueTypes.join(' | ')})[]`;
  }

  // オブジェクトの処理
  if (typeof value === 'object') {
    visitedObjects.add(value);

    const properties = Object.entries(value).map(([key, val]) => {
      const propType = inferType(val, options);
      const readonly = options.readonly ?  'readonly ' : '';
      const comment = options.generateComments
        ? `\n${nextIndent}/** ${getPropertyComment(key, val)} */`
        : '';
      
      // キーに特殊文字が含まれる場合はクォートで囲む
      const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) 
        ? key 
        : `"${key}"`;
      
      return `${comment}\n${nextIndent}${readonly}${safeKey}: ${propType};`;
    });

    if (indent === 0) {
      const interfaceBody = properties.join('');
      const comment = options.generateComments
        ? `/**\n * ${typeName} の型定義\n */\n`
        : '';
      return `${comment}interface ${typeName} {${interfaceBody}\n}`;
    } else {
      return `{${properties.join('')}\n${indentStr}}`;
    }
  }

  return typeof value;
}

/**
 * 値から型を推論（改善版）
 */
function inferType(value: any, options: Required<TypeGenerationOptions>): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  // 日付の検出
  if (options. detectDates && typeof value === 'string' && isDateString(value)) {
    return 'string /* ISO Date */';
  }

  // 配列の処理
  if (Array.isArray(value)) {
    if (value.length === 0) return 'any[]';

    const samplesToAnalyze = options.analyzeAllArrayElements
      ? value
      : value.slice(0, options.maxArraySamples);

    const types = new Set<string>();
    samplesToAnalyze. forEach((item) => {
      types.add(inferType(item, options));
    });

    const uniqueTypes = Array.from(types);
    if (uniqueTypes.length === 1) {
      return `${uniqueTypes[0]}[]`;
    }
    return `(${uniqueTypes.join(' | ')})[]`;
  }

  // オブジェクトの処理
  if (typeof value === 'object') {
    if (visitedObjects.has(value)) {
      return 'any /* 循環参照 */';
    }

    const properties = Object.entries(value).map(([key, val]) => {
      const propType = inferType(val, options);
      const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)
        ? key
        : `"${key}"`;
      return `${safeKey}: ${propType}`;
    });
    
    if (properties.length === 0) {
      return 'Record<string, never>';
    }
    
    return `{ ${properties.join('; ')} }`;
  }

  // プリミティブ型
  const primitiveType = typeof value;
  
  // 数値の整数チェック
//   if (primitiveType === 'number' && Number.isInteger(value)) {
//     return 'number /* integer */';
//   }

  return primitiveType;
}

/**
 * 日付文字列かどうかを判定
 */
function isDateString(value: string): boolean {
  // ISO 8601形式の日付文字列を検出
  const isoDatePattern = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?)?$/;
  if (!isoDatePattern.test(value)) return false;
  
  const date = new Date(value);
  return !isNaN(date.getTime());
}

/**
 * プロパティのコメントを生成
 */
function getPropertyComment(key: string, value: any): string {
  if (Array.isArray(value)) {
    return `${key} の配列 (${value.length}件)`;
  }
  if (typeof value === 'object' && value !== null) {
    return `${key} オブジェクト`;
  }
  return key;
}

/**
 * 複数のJSONサンプルから統合された型定義を生成（改善版）
 */
export function generateTypeFromSamples(
  samples: any[],
  typeName: string,
  options: TypeGenerationOptions = {}
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (samples.length === 0) {
    return `interface ${typeName} {\n  [key: string]: any;\n}`;
  }

  // すべてのサンプルからプロパティを収集
  const propertyMap = new Map<string, any[]>();
  
  samples.forEach((sample) => {
    if (typeof sample === 'object' && sample !== null && !Array.isArray(sample)) {
      Object.entries(sample).forEach(([key, value]) => {
        if (!propertyMap.has(key)) {
          propertyMap. set(key, []);
        }
        propertyMap.get(key)!.push(value);
      });
    }
  });

  // 各プロパティの型を推論
  const properties: string[] = [];
  const totalSamples = samples.length;
  const indentStr = ' '.repeat(opts.indentSize);

  propertyMap.forEach((values, key) => {
    const types = new Set<string>();
    let hasNull = false;
    let hasUndefined = values.length < totalSamples;

    values.forEach((value) => {
      if (value === null) {
        hasNull = true;
      } else if (value !== undefined) {
        types.add(inferType(value, opts));
      }
    });

    let typeStr = Array.from(types).join(' | ') || 'any';
    if (hasNull && typeStr !== 'any') {
      typeStr = `${typeStr} | null`;
    }

    const optional = hasUndefined ? '?' : '';
    const readonly = opts.readonly ? 'readonly ' :  '';
    const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)
      ? key
      : `"${key}"`;
    
    const comment = opts.generateComments
      ? `\n${indentStr}/** 出現回数: ${values.length}/${totalSamples} */`
      : '';

    properties.push(`${comment}\n${indentStr}${readonly}${safeKey}${optional}: ${typeStr};`);
  });

  const interfaceBody = properties.join('');
  const comment = opts. generateComments
    ? `/**\n * ${typeName} の型定義\n * ${totalSamples}件のサンプルから生成\n */\n`
    : '';

  return `${comment}interface ${typeName} {${interfaceBody}\n}`;
}

/**
 * API RouteからTypeScript型名を生成（改善版）
 */
export function generateTypeName(routeName: string): string {
  // スラッシュやハイフンなどを処理
  const segments = routeName
    .split(/[\/\-_\s\(\)\{\}\[\]]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      // kebab-case や snake_case を PascalCase に
      return segment
        .split(/[\-_]/)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join('');
    });

  // APIの接尾辞を除去
  const cleaned = segments
    .map((segment) => {
      return segment.replace(/^(Api|Endpoint|Route)$/i, '');
    })
    .filter((s) => s.length > 0);

  if (cleaned.length === 0) {
    return 'ApiResponse';
  }

  // 最後のセグメントに Response を追加
  const typeName = cleaned.join('') + 'Response';
  
  // 数字で始まる場合は T をプレフィックス
  if (/^\d/.test(typeName)) {
    return 'T' + typeName;
  }

  return typeName;
}

/**
 * 型定義を整形してエクスポート
 */
export function formatTypeDefinition(typeDefinition: string): string {
  // 余分な空行を削除
  let formatted = typeDefinition
    .split('\n')
    .filter((line, index, arr) => {
      // 連続する空行を1つに
      if (line.trim() === '') {
        return arr[index - 1]?.trim() !== '';
      }
      return true;
    })
    .join('\n')
    .trim();

  // (Type1 | Type2)[] パターンを Type1[] | Type2[] に変換
  formatted = transformUnionArrays(formatted);

  return formatted;
}

/**
 * (Type1 | Type2)[] の形式を Type1[] | Type2[] に変換
 */
function transformUnionArrays(typeDefinition: string): string {
  // マルチライン対応の Union型配列パターンを検出・変換
  return typeDefinition.replace(/\(\s*([\s\S]*?)\s*\)\[\]/g, (match: string, union: string) => {
    const types = union.split('|').map((t: string) => t.trim());
    return types.map((t: string) => `${t}[]`).join(' | ');
  });
}

/**
 * 複数の型定義をマージ
 */
export function mergeTypeDefinitions(
  types: string[],
  namespaceName?:  string
): string {
  const formatted = types. map(formatTypeDefinition).join('\n\n');
  
  if (namespaceName) {
    const indented = formatted
      .split('\n')
      .map((line) => '  ' + line)
      .join('\n');
    return `export namespace ${namespaceName} {\n${indented}\n}`;
  }
  
  return formatted;
}