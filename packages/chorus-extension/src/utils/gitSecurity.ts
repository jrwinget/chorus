/**
 * Security utilities for git command parameter validation.
 *
 * This module provides defense-in-depth validation for parameters passed to git commands,
 * even though spawn() with array arguments is inherently safe from shell injection when
 * using shell: false (the default).
 *
 * Security Context:
 * - Node.js spawn(command, [args], {shell: false}) passes arguments directly to execve()
 * - Array arguments are NOT interpreted by a shell, preventing injection attacks
 * - Validation here provides defense-in-depth for:
 *   1. Catching malformed inputs early with clear error messages
 *   2. Preventing potential git command confusion attacks
 *   3. Protecting against future code changes that might introduce vulnerabilities
 *   4. Ensuring data integrity (e.g., dates are actually dates)
 *
 * Threat Model:
 * - PRIMARY RISK: Data from GitHub API (merged_at, created_at, PR numbers)
 *   - These come from external sources and should be validated
 *   - GitHub could be compromised, or API responses could be MITM'd
 *   - Malicious PR titles/descriptions could contain unexpected characters
 *
 * - SECONDARY RISK: Workspace paths from VS Code
 *   - Generally trusted (user's own filesystem)
 *   - Could theoretically be manipulated if workspace file is malicious
 *
 * References:
 * - Node.js spawn security: https://nodejs.org/api/child_process.html#child_processspawncommand-args-options
 * - Git command injection: https://git-scm.com/docs/git#_security
 */

/**
 * Validates that a string is a properly formatted ISO 8601 date string.
 *
 * Accepts formats:
 * - YYYY-MM-DD
 * - YYYY-MM-DDTHH:MM:SS
 * - YYYY-MM-DDTHH:MM:SS.sss
 * - YYYY-MM-DDTHH:MM:SSZ
 * - YYYY-MM-DDTHH:MM:SS±HH:MM
 *
 * @param date - Date string to validate
 * @returns true if valid, false otherwise
 *
 * @example
 * isValidISODate('2023-01-15') // true
 * isValidISODate('2023-01-15T10:30:00Z') // true
 * isValidISODate('2023-01-15T10:30:00.123Z') // true
 * isValidISODate('2023-01-15T10:30:00+05:30') // true
 * isValidISODate('invalid') // false
 * isValidISODate('2023-01-15; rm -rf /') // false
 */
export function isValidISODate(date: string): boolean {
  // Comprehensive ISO 8601 regex
  // Allows: YYYY-MM-DD, YYYY-MM-DDTHH:MM:SS, with optional milliseconds and timezone
  const isoDateRegex = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|([+-]\d{2}:\d{2}))?)?$/;

  if (!isoDateRegex.test(date)) {
    return false;
  }

  // Additional validation: ensure it's actually parseable as a date
  // This catches invalid dates like 2023-02-30
  const parsed = Date.parse(date);
  return !isNaN(parsed);
}

/**
 * Validates that a string is a valid git commit hash.
 * Accepts short (7-40 chars) or full (40 chars) SHA-1 hashes.
 *
 * @param hash - Commit hash to validate
 * @returns true if valid, false otherwise
 *
 * @example
 * isValidCommitHash('abc123f') // true
 * isValidCommitHash('abc123fdef456abc123fdef456abc123fdef456a') // true
 * isValidCommitHash('invalid') // false
 * isValidCommitHash('abc123; rm -rf') // false
 */
export function isValidCommitHash(hash: string): boolean {
  // Git SHA-1 hashes are 40 hex characters, but short hashes can be 7-40
  return /^[0-9a-f]{7,40}$/i.test(hash);
}

/**
 * Validates that a string is a valid PR reference.
 * Accepts formats: #123, owner/repo#123, or just numeric ID.
 *
 * @param prRef - PR reference to validate
 * @returns true if valid, false otherwise
 *
 * @example
 * isValidPRReference('#123') // true
 * isValidPRReference('owner/repo#123') // true
 * isValidPRReference('123') // true
 * isValidPRReference('abc') // false
 * isValidPRReference('#123; rm -rf') // false
 */
export function isValidPRReference(prRef: string): boolean {
  // Matches: #123, owner/repo#123, or numeric-only
  // GitHub owner/repo names: alphanumeric, hyphens, underscores, dots
  return /^([\w\-\.]+\/[\w\-\.]+)?#?\d+$/.test(prRef);
}

/**
 * Validates that a string is a safe git reference (branch, tag).
 * Git references can contain most characters but not certain dangerous ones.
 *
 * @param ref - Git reference to validate
 * @returns true if valid, false otherwise
 *
 * @example
 * isValidGitReference('main') // true
 * isValidGitReference('feature/new-feature') // true
 * isValidGitReference('v1.0.0') // true
 * isValidGitReference('refs/heads/main') // true
 * isValidGitReference('../../../etc/passwd') // false
 * isValidGitReference('branch; rm -rf') // false
 */
export function isValidGitReference(ref: string): boolean {
  // Git refs cannot contain: spaces, ^, ~, :, ?, *, [, \, .., @{, control characters
  // They cannot start or end with /, ., or contain consecutive dots
  // See: https://git-scm.com/docs/git-check-ref-format

  if (!ref || ref.length === 0 || ref.length > 255) {
    return false;
  }

  // Reject dangerous patterns
  const dangerousPatterns = [
    /\.\./, // Directory traversal
    /[\x00-\x1f\x7f]/, // Control characters
    /[ ~^:?*\[\\]/, // Git-invalid characters
    /^[.\/]/, // Starts with . or /
    /[.\/]$/, // Ends with . or /
    /@\{/, // Ref log syntax
    /^-/, // Starts with dash (looks like option)
  ];

  return !dangerousPatterns.some((pattern) => pattern.test(ref));
}

/**
 * Validates that a path is safe for use with git cwd option.
 * This provides basic validation to catch obviously malicious paths.
 *
 * Note: Since workspacePath comes from VS Code workspace folders (trusted),
 * this is primarily defense-in-depth.
 *
 * @param path - File system path to validate
 * @returns true if valid, false otherwise
 */
export function isValidWorkspacePath(path: string): boolean {
  if (!path || path.length === 0) {
    return false;
  }

  // Basic sanity checks
  // Reject control characters and null bytes
  if (/[\x00-\x1f]/.test(path)) {
    return false;
  }

  // Reject paths that look like command injection attempts
  if (/[;&|`$(){}]/.test(path)) {
    return false;
  }

  return true;
}

/**
 * Validates an ISO date string and throws a descriptive error if invalid.
 * Use this for required date parameters.
 *
 * @param date - Date string to validate
 * @param paramName - Parameter name for error message
 * @throws Error if date is invalid
 *
 * @example
 * validateISODate('2023-01-15', 'sinceDate') // returns '2023-01-15'
 * validateISODate('invalid', 'sinceDate') // throws Error
 */
export function validateISODate(date: string, paramName: string): string {
  if (!isValidISODate(date)) {
    throw new Error(
      `Invalid ${paramName}: expected ISO 8601 date format (e.g., YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ), got: ${date}`
    );
  }
  return date;
}

/**
 * Validates an ISO date string for optional parameters.
 * Returns the date if valid, or undefined if not provided.
 *
 * @param date - Date string to validate (optional)
 * @param paramName - Parameter name for error message
 * @returns Validated date or undefined
 * @throws Error if date is provided but invalid
 *
 * @example
 * validateOptionalISODate('2023-01-15', 'sinceDate') // returns '2023-01-15'
 * validateOptionalISODate(undefined, 'sinceDate') // returns undefined
 * validateOptionalISODate('invalid', 'sinceDate') // throws Error
 */
export function validateOptionalISODate(
  date: string | undefined,
  paramName: string
): string | undefined {
  if (date === undefined) {
    return undefined;
  }
  return validateISODate(date, paramName);
}

/**
 * Sanitizes a PR reference by extracting just the numeric ID.
 * This ensures we only pass numbers to git log grep patterns.
 *
 * @param prRef - PR reference in any format (#123, owner/repo#123, 123)
 * @returns Numeric PR ID as string
 * @throws Error if no valid PR number found
 *
 * @example
 * sanitizePRReference('#123') // returns '123'
 * sanitizePRReference('owner/repo#456') // returns '456'
 * sanitizePRReference('789') // returns '789'
 * sanitizePRReference('invalid') // throws Error
 */
export function sanitizePRReference(prRef: string): string {
  if (!isValidPRReference(prRef)) {
    throw new Error(`Invalid PR reference format: ${prRef}`);
  }

  // Extract numeric part
  const match = prRef.match(/(\d+)$/);
  if (!match) {
    throw new Error(`Could not extract PR number from: ${prRef}`);
  }

  return match[1];
}
