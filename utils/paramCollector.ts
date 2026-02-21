/**
 * URLからクエリパラメータを抽出
 */
export function extractQueryParams(url: string): Record<string, string[]> {
    try {
        const urlObj = new URL(url);
        const params: Record<string, string[]> = {};

        urlObj.searchParams.forEach((value, key) => {
            if (!params[key]) {
                params[key] = [];
            }
            params[key].push(value);
        });

        return params;
    } catch {
        return {};
    }
}

/**
 * データから型を推論
 */
export function inferDataType(value: any): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'object') return 'object';
    if (typeof value === 'number') {
        return Number.isInteger(value) ? 'number' : 'number';
    }
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'string') return 'string';
    return 'unknown';
}

/**
 * 複数のサンプルから統合されたパラメータ情報を生成
 */
export interface ParamInfo {
    name: string;
    types: Set<string>;
    samples: any[];
    frequency: number; // 出現回数
}

export function aggregateParams(
    requests: Array<{ queryParams?: Record<string, string[]>; requestBody?: any }>,
    sampleLimit: number = 20,
): Record<string, ParamInfo> {
    const paramMap: Record<string, ParamInfo> = {};
    const cappedSampleLimit = Number.isFinite(sampleLimit)
        ? Math.max(1, Math.floor(sampleLimit))
        : 20;

    requests.forEach(req => {
        // クエリパラメータの処理
        if (req.queryParams) {
            Object.entries(req.queryParams).forEach(([key, values]) => {
                if (!paramMap[key]) {
                    paramMap[key] = {
                        name: key,
                        types: new Set(),
                        samples: [],
                        frequency: 0,
                    };
                }

                values.forEach(value => {
                    paramMap[key].types.add(inferDataType(value));
                    if (paramMap[key].samples.length < cappedSampleLimit) {
                        paramMap[key].samples.push(value);
                    }
                });
                paramMap[key].frequency++;
            });
        }

        // リクエストボディの処理
        if (req.requestBody && typeof req.requestBody === 'object') {
            Object.entries(req.requestBody).forEach(([key, value]) => {
                const bodyKey = `body.${key}`;
                if (!paramMap[bodyKey]) {
                    paramMap[bodyKey] = {
                        name: bodyKey,
                        types: new Set(),
                        samples: [],
                        frequency: 0,
                    };
                }

                paramMap[bodyKey].types.add(inferDataType(value));
                if (paramMap[bodyKey].samples.length < cappedSampleLimit) {
                    paramMap[bodyKey].samples.push(value);
                }
                paramMap[bodyKey].frequency++;
            });
        }
    });

    return paramMap;
}
