// PostgreSQL jsonb cannot represent NUL or unpaired UTF-16 surrogates.
export function isPostgresJsonText(value: string): boolean {
  return !/\0|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value);
}
