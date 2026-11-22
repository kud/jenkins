/**
 * Log sanitizer utility.
 *
 * Goals:
 * - Normalize line endings (CRLF -> LF)
 * - Remove stray carriage returns used for in-place updates when not interpreted
 * - Strip ANSI escape sequences when desired (configurable)
 * - Drop other non-printable control characters that blessed renders as '?'
 * - Preserve tabs and newlines
 */

export interface SanitizeOptions {
  stripAnsi?: boolean;      // default true
  preserveCarriageReturn?: boolean; // if true, standalone \r become \n instead of being removed
}

// Regex to match ANSI escape sequences, in their 7-bit (ESC-prefixed) and
// 8-bit (C1) forms:
// - control strings: OSC (ESC ] / \x9d), DCS (ESC P / \x90), SOS (ESC X / \x98),
//   PM (ESC ^ / \x9e) and APC (ESC _ / \x9f), terminated by BEL or ST (ESC \ / \x9c).
//   OSC carries hyperlinks (OSC 8), window titles and clipboard writes (OSC 52).
// - CSI (ESC [ / \x9b) with parameters, intermediates and a final byte.
// - two-character escapes (ESC followed by one byte in 0x40-0x5F or 0x60-0x7E).
const ANSI_PATTERN =
  /(?:\x1B[\]PX^_]|[\x90\x98\x9D\x9E\x9F])[^\x07\x1B\x9C]*(?:\x07|\x1B\\|\x9C)|(?:\x1B\[|\x9B)[0-?]*[ -/]*[@-~]|\x1B[@-Z\\-~]/g;

// Select Graphic Rendition (colour, bold, ...) only: ESC [ params m.
const SGR_PATTERN = /^\x1B\[[0-9;:]*m$/;

// Control chars to remove (keep \n, \t). C0 0x00-0x1F excluding 0x09 (tab) & 0x0A (LF) & 0x0D handled separately,
// DEL (0x7F), and the C1 block 0x80-0x9F, which some terminals act on as 8-bit CSI/OSC.
const CONTROL_PATTERN = /[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g;

export function sanitizeLogChunk(chunk: string | Buffer, opts: SanitizeOptions = {}): string {
  const { stripAnsi = true, preserveCarriageReturn = false } = opts;
  let s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');

  // Normalize CRLF first
  s = s.replace(/\r\n/g, '\n');

  // Handle any remaining standalone CR (progress / spinner updates)
  if (preserveCarriageReturn) {
    // Convert remaining CR to newline so we don't lose intended separation
    s = s.replace(/\r/g, '\n');
  } else {
    // Remove them entirely (acts like terminal overwrite without showing '?')
    s = s.replace(/\r/g, '');
  }

  if (stripAnsi) {
    s = s.replace(ANSI_PATTERN, '');
  }

  // Remove other control chars that would render as placeholders
  s = s.replace(CONTROL_PATTERN, '');

  return s;
}

/** Convenience function for streaming concatenation. */
export function sanitizeAndAppend(previous: string, next: string | Buffer, opts?: SanitizeOptions) {
  return previous + sanitizeLogChunk(next, opts);
}

export interface TerminalSanitizeOptions {
  /** Keep SGR colour/style sequences (ESC [ ... m); every other escape is still removed. Default false. */
  preserveColors?: boolean;
}

/**
 * Make untrusted text (a Jenkins console log, a job description, a commit
 * message) safe to write to a terminal.
 *
 * ⚠ A BUILD LOG IS WRITTEN BY WHOEVER CONTROLS THE BUILD. Printed raw, its
 * escape sequences reach the reader's terminal: OSC 52 can write the clipboard,
 * OSC 8 can dress a link as another, CSI can move the cursor and rewrite lines
 * already shown, and a bare CR can overprint a line with a different one. This
 * removes every escape sequence (7-bit and 8-bit), every C0 and C1 control
 * except newline and tab, and carriage returns, so what prints is what was in
 * the text. `getConsoleText` still returns the log untouched; printing callers
 * decide.
 */
export function sanitizeForTerminal(
  text: string | Buffer,
  opts: TerminalSanitizeOptions = {},
): string {
  let s = typeof text === 'string' ? text : text.toString('utf8');
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '');
  if (opts.preserveColors) {
    // Park SGR sequences behind private-use markers that hold no control
    // character, strip everything else, then put them back. Markers already in
    // the input are dropped first, so only this call's own can be restored.
    s = s.replace(/[\uE000\uE001]/g, '');
    const kept: string[] = [];
    s = s.replace(ANSI_PATTERN, (m) => {
      if (!SGR_PATTERN.test(m)) return '';
      kept.push(m);
      return `\uE000${kept.length - 1}\uE001`;
    });
    s = s.replace(CONTROL_PATTERN, '');
    return s.replace(/\uE000(\d+)\uE001/g, (m, i) => kept[Number(i)] ?? '');
  }
  return s.replace(ANSI_PATTERN, '').replace(CONTROL_PATTERN, '');
}
