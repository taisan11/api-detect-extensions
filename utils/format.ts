import { format } from "prettier/standalone";
import estree from "prettier/plugins/estree.js"
import typescript from "prettier/plugins/typescript.js"

export function formatCode(code:string):Promise<string> {
    return format(code, {
        parser: "typescript",
        plugins: [estree, typescript],
        singleQuote: true,
        semi: false,
        trailingComma: "all",
    })
}