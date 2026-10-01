export const REDACTED_SENTINEL = '<REDACTED>';

export function redactCommandLine(value: string): string {
  return redactSecrets(value)
    .replace(
      /((?:--|\/)(?:token|api[-_]?key|secret|password|credential)(?:=|\s+))[^\s"']+/gi,
      `$1${REDACTED_SENTINEL}`,
    );
}

export function redactSecrets(value: string): string {
  return value
    .replace(
      /(?i:bearer)\s+[A-Za-z0-9._~+\/-]{12,}/g,
      `Bearer ${REDACTED_SENTINEL}`,
    )
    .replace(
      /((?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|CREDENTIAL)\s*[=:]\s*)[^\s;,]+/gi,
      `$1${REDACTED_SENTINEL}`,
    )
    .replace(
      /(^|\n)(\s*[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|CREDENTIAL)[A-Za-z0-9_]*\s*=\s*)([^\r\n]+)/gi,
      (_m, prefix, key) => `${prefix}${key}${REDACTED_SENTINEL}`,
    );
}

export function containsRedactableSecrets(value: string): boolean {
  return redactSecrets(value) !== value;
}
