/**
 * Ambient declaration for `*.jss` imports — Angular's `application` builder
 * is configured (via angular.json `loader`) to inline `.jss` file content as
 * a UTF-8 string. The default export is that string, ready to feed into
 * `CompileJss(...)` from jaui-angular.
 */
declare module '*.jss' {
  const source: string;
  export default source;
}
