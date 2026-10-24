const sensitiveFields = [
  "ocp-apim-subscription-key", "x-functions-key", "x-api-key", "client_secret", "client-secret",
  "db_password", "db-password", "access_token", "refresh_token", "id_token", "set-cookie",
  "access[_-]?token", "refresh[_-]?token", "id[_-]?token", "client[_-]?secret", "api[_-]?key",
  "auth[_-]?token", "secret[_-]?key", "private[_-]?token", "secret[_-]?access[_-]?key",
  "sharedaccesskey", "accountkey", "authorization", "signature", "password", "passwd", "secret",
  "cookie", "api-key", "api_key", "token", "pwd", "sig", "credential", "access token", "auth token",
];

export const sensitiveFieldPattern = sensitiveFields.join("|");
const sensitiveName = new RegExp(String.raw`(?:^|[^a-z0-9])(?:${sensitiveFieldPattern})$`, "i");
const bareKey = /[-A-Za-z_][A-Za-z0-9_.-]*(?:[ \t]+token)?/y;

function isSensitiveName(name: string): boolean {
  return sensitiveName.test(name) || sensitiveName.test(name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2"));
}

function skipWhitespace(value: string, start: number): number {
  let index = start;
  while (index < value.length && /\s/.test(value[index])) index += 1;
  return index;
}

function indexQuoteEnds(value: string): Map<number, number> {
  const ends = new Map<number, number>();
  const next = new Map<string, number>();
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const character = value[index];
    if (!['"', "'", "`"].includes(character)) continue;
    ends.set(index, next.get(character) ?? value.length + 1);
    let preceding = index - 1;
    while (value[preceding] === "\\") preceding -= 1;
    if ((index - preceding - 1) % 2 === 0) next.set(character, index + 1);
  }
  return ends;
}

function quoteEnd(value: string, start: number, slashes = 0, ends?: Map<number, number>): number {
  if (slashes === 0 && ends) return ends.get(start) ?? value.length + 1;
  const quote = value[start];
  let backslashes = 0;
  for (let index = start + 1; index < value.length; index += 1) {
    if (value[index] === "\\") {
      backslashes += 1;
      continue;
    }
    if (value[index] === quote && backslashes >= slashes &&
      (backslashes - slashes) % (2 * (slashes + 1)) === 0) return index + 1;
    backslashes = 0;
  }
  return value.length;
}

function containerEnd(value: string, start: number, slashes = 0, ends?: Map<number, number>): number {
  const closing = [value[start] === "{" ? "}" : "]"];
  let backslashes = 0;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if ((character === '"' || character === "'" || character === "`") &&
      (character === '"' ? backslashes === slashes : backslashes % 2 === 0)) {
      index = quoteEnd(value, index, character === '"' ? slashes : 0, ends) - 1;
    } else if (character === "{" || character === "[") closing.push(character === "{" ? "}" : "]");
    else if (character === closing.at(-1)) {
      closing.pop();
      if (closing.length === 0) return index + 1;
    }
    backslashes = 0;
  }
  return value.length;
}

interface Key {
  name: string;
  end: number;
  separator: number;
  sensitive: boolean;
}

function decodeStringEscapes(value: string): { decoded: string; valid: boolean } {
  let valid = true;
  const decoded = value.replace(/\\(?:u\{([a-f0-9]{1,6})\}|u([a-f0-9]{4})|x([a-f0-9]{2})|\r\n|([\s\S]))/gi,
    (escape, point: string, unicode: string, hex: string, character: string, offset: number) => {
      if (point || unicode || hex) {
        const code = parseInt(point ?? unicode ?? hex, 16);
        if (code <= 0x10ffff) return String.fromCodePoint(code);
        valid = false;
        return escape;
      }
      if (!character || /[\r\n\u2028\u2029]/.test(character)) return "";
      if (/[ux1-9]/i.test(character) || (character === "0" && /[0-9]/.test(value[offset + 2] ?? ""))) {
        valid = false;
        return escape;
      }
      const controls: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "0": "\0" };
      return controls[character] ?? character;
    });
  if (/(?:^|[^\\])(?:\\\\)*\\$/.test(value)) valid = false;
  return { decoded, valid };
}

function readKey(value: string, start: number, ends?: Map<number, number>): Key | undefined {
  let name: string;
  let end: number;
  let sensitive = false;
  if (["'", '"', "`"].includes(value[start])) {
    end = quoteEnd(value, start, 0, ends);
    if (end > value.length || value[end - 1] !== value[start]) return undefined;
    if (!/[:=]/.test(value[skipWhitespace(value, end)] ?? "")) return undefined;
    name = value.slice(start + 1, end - 1);
    for (let layer = 0; layer < 16; layer += 1) {
      const decoded = decodeStringEscapes(name);
      sensitive ||= !decoded.valid || /[\u0000-\u001f\u007f]/.test(decoded.decoded);
      if (decoded.decoded === name) break;
      name = decoded.decoded;
      if (layer === 15) sensitive = true;
    }
  } else {
    if (/[A-Za-z0-9_.-]/.test(value[start - 1] ?? "")) return undefined;
    bareKey.lastIndex = start;
    const match = bareKey.exec(value);
    if (!match) return undefined;
    name = match[0];
    end = bareKey.lastIndex;
  }
  const separator = skipWhitespace(value, end);
  return value[separator] === ":" || value[separator] === "="
    ? { name, end, separator, sensitive: sensitive || isSensitiveName(name) } : undefined;
}

function isSiblingBoundary(value: string, index: number, ends?: Map<number, number>): boolean {
  return value[index] === "," && readKey(value, skipWhitespace(value, index + 1), ends) !== undefined;
}

function isStructuredBoundary(value: string, index: number, ends?: Map<number, number>): boolean {
  if (isSiblingBoundary(value, index, ends)) return true;
  let end = index;
  while (end < value.length && /[}\]]/.test(value[end])) end += 1;
  return end > index && (end === value.length || /[\s,;)]/.test(value[end]));
}

function ownsQuotedSpan(value: string, start: number, end: number, structured: boolean, ends: Map<number, number>, jsonDocument: boolean): boolean {
  if (jsonDocument) return true;
  const contents = decodeStringEscapes(value.slice(start + 1, end - 1)).decoded;
  const contentEnds = indexQuoteEnds(contents);
  for (let index = 0; index < contents.length;) {
    const key = readKey(contents, index, contentEnds);
    if (key?.sensitive && skipWhitespace(contents, key.separator + 1) === contents.length) return false;
    index = key ? key.end : index + 1;
  }
  if (/[A-Za-z0-9]/.test(value[start - 1] ?? "")) return false;
  if (/[A-Za-z0-9]/.test(value[end] ?? "")) return false;
  if (readKey(value, end - 1, ends)) return false;
  let previous = start - 1;
  while (previous >= 0 && /\s/.test(value[previous])) previous -= 1;
  if (previous < 0 || /[:=]/.test(value[previous]) || (structured && /[\[{,]/.test(value[previous]))) return true;
  const opening = contents.search(/[\[{]/);
  return opening < 0 || contents.length === 1 ||
    containerEnd(contents, opening) < contents.length || /[}\]]$/.test(contents);
}

function secretEnd(value: string, start: number, structured: boolean, parameterPrefix: string, ends: Map<number, number>): number {
  let index = start;
  let slashes = 0;
  while (value[index] === "\\") { slashes += 1; index += 1; }
  if (["'", '"', "`"].includes(value[index])) {
    index = Math.min(value.length, quoteEnd(value, index, value[index] === '"' ? slashes : 0, ends));
    if (index === value.length || /\s/.test(value[index]) ||
      (structured ? isStructuredBoundary(value, index, ends) : /[;)]/.test(value[index]))) return index;
  } else index = start;
  while (index < value.length) {
    const character = value[index];
    if (/[\r\n]/.test(character)) return index;
    if (/[?&]/.test(parameterPrefix) && /\s/.test(character)) return index;
    if (parameterPrefix === ";" && character === ";" && readKey(value, skipWhitespace(value, index + 1), ends)) return index;
    if (!structured && /\s/.test(character) && /[\[{]/.test(value[skipWhitespace(value, index)] ?? "")) return index;
    if (structured && isStructuredBoundary(value, index, ends)) return index;
    if (structured && /[}\]]/.test(character)) {
      while (index < value.length && /[}\]]/.test(value[index])) index += 1;
      continue;
    }
    if (character === "{" || character === "[") {
      index = containerEnd(value, index, 0, ends);
      if (index === value.length || /\s/.test(value[index]) ||
        (structured && isStructuredBoundary(value, index, ends))) return index;
      continue;
    }
    if (structured && (character === '"' || character === "'" || character === "`") &&
      /[:,=]/.test(value[index - 1] ?? "")) {
      index = Math.min(value.length, quoteEnd(value, index, 0, ends));
      continue;
    }
    index += 1;
  }
  return value.length;
}

export function redactSensitiveFields(
  value: string,
  layer = 0,
  sanitizeDecoded: (decoded: string, nextLayer: number) => string = (decoded, nextLayer) => redactSensitiveFields(decoded, nextLayer)
): string {
  if (layer >= 16) return "<redacted>";
  let output = "";
  let copiedThrough = 0;
  const containers: string[] = [];
  const ends = indexQuoteEnds(value);
  let jsonDocument = false;
  if (/^\s*[\[{]/.test(value)) {
    try { JSON.parse(value); jsonDocument = true; } catch {}
  }
  for (let index = 0; index < value.length;) {
    const character = value[index];
    let escapedWhitespaceKey = false;
    if (character === "\\" && /[nrt]/.test(value[index + 1] ?? "")) {
      let keyStart = index;
      do {
        keyStart = skipWhitespace(value, keyStart + 2);
      } while (value[keyStart] === "\\" && /[nrt]/.test(value[keyStart + 1] ?? ""));
      const followingKey = readKey(value.slice(keyStart), 0);
      escapedWhitespaceKey = followingKey?.sensitive === true;
      if (!escapedWhitespaceKey) {
        index = readKey(value, index + 1, ends)?.sensitive ? index + 1 : keyStart;
        continue;
      }
    }
    let escapedQuote = index;
    if (character === "\\") while (value[escapedQuote] === "\\") escapedQuote += 1;
    if (character === "\\" && (escapedWhitespaceKey || ['"', "'", "`"].includes(value[escapedQuote]))) {
      const decoded = decodeStringEscapes(value.slice(index));
      const sanitized = sanitizeDecoded(decoded.decoded, layer + 1);
      return output + value.slice(copiedThrough, index) + (decoded.valid
        ? JSON.stringify(sanitized).slice(1, -1) : "<redacted>");
    }
    if (escapedQuote > index) {
      index = escapedQuote;
      continue;
    }
    if ((character === "{" || character === "[") && /^(?:\s|\\+[nrt])*\\+"/.test(value.slice(index + 1))) {
      const slashes = /^(?:\s|\\+[nrt])*(\\+)"/.exec(value.slice(index + 1))![1].length;
      const end = containerEnd(value, index, slashes);
      const fragment = value.slice(index, end);
      try {
        const decoded: string = JSON.parse(`"${fragment}"`);
        const sanitized = sanitizeDecoded(decoded, layer + 1);
        output += value.slice(copiedThrough, index) + JSON.stringify(sanitized).slice(1, -1);
        copiedThrough = end;
        index = end;
        continue;
      } catch {
        output += value.slice(copiedThrough, index) + "<redacted>";
        copiedThrough = end;
        index = end;
        continue;
      }
    }
    const key = readKey(value, index, ends);
    if (key?.sensitive) {
      const start = skipWhitespace(value, key.separator + 1);
      const end = secretEnd(value, start, containers.at(-1) === "{", value[index - 1] ?? "", ends);
      output += value.slice(copiedThrough, index) + value.slice(index, key.end) + ": <redacted>";
      copiedThrough = end;
      index = end;
      continue;
    }
    if (key && !["'", '"', "`"].includes(character)) { index = key.end; continue; }
    if (["'", '"', "`"].includes(character)) {
      const end = quoteEnd(value, index, 0, ends);
      if (end <= value.length && value[end - 1] === character && ownsQuotedSpan(value, index, end, containers.length > 0, ends, jsonDocument)) {
        const literal = value.slice(index, end);
        const contents = literal.slice(1, -1);
        let literalAssignment = false;
        const literalEnds = indexQuoteEnds(contents);
        for (let cursor = contents.indexOf("\\"); cursor >= 0; cursor = contents.indexOf("\\", cursor + 1)) {
          if (["'", '"', "`"].includes(contents[cursor + 1])) continue;
          if (readKey(contents, cursor + 1, literalEnds)?.sensitive) { literalAssignment = true; break; }
        }
        if (literalAssignment) {
          output += value.slice(copiedThrough, index) + "<redacted>";
          copiedThrough = end;
          index = end;
          continue;
        }
        const decoded = decodeStringEscapes(contents);
        const sanitized = sanitizeDecoded(decoded.decoded, layer + 1);
        const normalized = decoded.decoded
          .replace(/[\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029]+/g, " ")
          .replace(/[ \t]+/g, " ").trim();
        const unchangedPath = decoded.valid && /^[a-z]:[\\/][a-z0-9_.\\/-]*$/i.test(contents) &&
          sanitized === normalized;
        if (!unchangedPath && (!decoded.valid || sanitized !== decoded.decoded)) {
          output += value.slice(copiedThrough, index) + (!decoded.valid ? "<redacted>" : character === '"'
            ? JSON.stringify(sanitized) : character + sanitized + character);
          copiedThrough = end;
        }
        index = end;
        continue;
      }
    }
    if (character === "{" || character === "[") containers.push(character);
    else if (character === "}" && containers.at(-1) === "{") containers.pop();
    else if (character === "]" && containers.at(-1) === "[") containers.pop();
    index += 1;
  }
  return output + value.slice(copiedThrough);
}
