import type { Suite } from "@playwright/test/reporter";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { aggregateHealth, compileCategories } from "./aggregate";
import { buildHealthMessage, sanitizeHealthText } from "./render";

describe("health card rendering", () => {
  it('keeps JSON message ownership when an embedded assignment ends empty', () => {
    const input = JSON.stringify({ message: 'DB_PASSWORD=FIRST,region=PRIVATE_SUFFIX token=', other: 'visible' });
    const sanitized = sanitizeHealthText(input, 8000, undefined, undefined, false);
    expect(sanitized).not.toContain('PRIVATE_SUFFIX');
    expect(sanitized).toContain('visible');
  });

  it.each([
    String.raw`C:\token=PRIVATE_CREDENTIAL`,
    String.raw`Error: 'C:\token=PRIVATE_CREDENTIAL'`,
    JSON.stringify(String.raw`C:\token=PRIVATE_CREDENTIAL`),
  ])('checks literal backslash assignments alongside decoded text: %s', input => {
    expect(sanitizeHealthText(input, 8000, undefined, undefined, false)).not.toContain('PRIVATE_CREDENTIAL');
  });

  it('bounds closed escaped-quote diagnostics before clipping', () => {
    const script = String.raw`
      require.extensions['.ts'] = (module, filename) => module._compile(require('typescript').transpileModule(
        require('node:fs').readFileSync(filename, 'utf8'), { compilerOptions: { module: 1, target: 9 } }
      ).outputText, filename);
      const clean = require('./src/health/render.ts').sanitizeHealthText;
      clean(JSON.stringify(String.fromCharCode(92, 34).repeat(8000) + '"'), 300, undefined, undefined, false);
      for (const quote of [String.fromCharCode(39), String.fromCharCode(96)]) {
        clean('"' + (String.fromCharCode(92) + quote).repeat(16000) + 'x' + quote + ':"', 300, undefined, undefined, false);
      }
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: resolve(__dirname, '../..'), encoding: 'utf8', timeout: 5000,
    });
    expect({ error: result.error?.message, stderr: result.stderr, status: result.status })
      .toEqual({ error: undefined, stderr: '', status: 0 });
  });

  it.each([
    JSON.stringify({ message: "C:\\repo\nBearer\tPRIVATE_CREDENTIAL", other: "visible" }),
    JSON.stringify({ message: "C:\\repo\neyJheader.payload.PRIVATE_CREDENTIAL", other: "visible" }),
    String.raw`{"message":"C:\repo\1eyJheader.payload.PRIVATE_CREDENTIAL","other":"visible"}`,
    String.raw`{"C:\pass\word":"PRIVATE_CREDENTIAL","other":"visible"}`,
    String.raw`{"C:\to\ken":"PRIVATE_CREDENTIAL","other":"visible"}`,
    String.raw`{"C:\build\repo\npassword":"PRIVATE_CREDENTIAL","other":"visible"}`,
    String.raw`{"C:\build\1password":"PRIVATE_CREDENTIAL","other":"visible"}`,
    String.raw`Error: 'C:\u0070assword=PRIVATE_CREDENTIAL'`,
    String.raw`Error: 'C:\x20password=PRIVATE_CREDENTIAL'`,
    String.raw`"C:\build\repo: pass\u0077ord=PRIVATE_CREDENTIAL"`,
    String.raw`{"c:\pass\u0077ord":"PRIVATE_CREDENTIAL","other":"visible"}`,
    String.raw`"C:\build\repo\npassword: " '#FIRST PRIVATE_CREDENTIAL'`,
    JSON.stringify({ message: "C:\\build\\repo\nBearer PRIVATE_CREDENTIAL", other: "visible" }),
  ])('redacts encoded credentials after a Windows drive prefix: %s', original => {
    let input = original;
    for (let layer = 0; layer <= 2; layer += 1) {
      expect(sanitizeHealthText(input, 32000, undefined, undefined, false)).not.toContain('PRIVATE_CREDENTIAL');
      input = JSON.stringify(input);
    }
  });

  it.each([
    ['mixed escape depths', String.raw`Log: \"pass\\u0077ord\": \"PRIVATE_CREDENTIAL\"`],
    ['identity escaped key', String.raw`\"\p\a\s\s\w\o\r\d\"=\"PRIVATE_CREDENTIAL\"`],
    ['codepoint escaped key', String.raw`\"pass\u{77}ord\"=\"PRIVATE_CREDENTIAL\"`],
    ['escaped quoted scheme', String.raw`\"Be\u0061rer PRIVATE_CREDENTIAL\"`],
    ['newline empty assignment', String.raw`Retrying, 'til ready:\npassword: '#FIRST PRIVATE_SUFFIX'`],
    ['return empty assignment', String.raw`Retrying, 'til ready:\rpassword: '#FIRST PRIVATE_SUFFIX'`],
    ['tab empty assignment', String.raw`Retrying, 'til ready:\tpassword: '#FIRST PRIVATE_SUFFIX'`],
    ['quoted empty assignment', String.raw`Retrying, 'til ready: "password": '#FIRST PRIVATE_SUFFIX'`],
    ['decoded quoted empty assignment', String.raw`Retrying, 'til ready:\n"pass\u0077ord": '#FIRST PRIVATE_SUFFIX'`],
    ['return quoted empty assignment', String.raw`Retrying, 'til ready:\r"password": '#FIRST PRIVATE_SUFFIX'`],
    ['tab quoted empty assignment', String.raw`Retrying, 'til ready:\t"password": '#FIRST PRIVATE_SUFFIX'`],
    ['malformed encoded key', String.raw`{"pass\u{110000}word":"PRIVATE_CREDENTIAL","other":"visible"}`],
    ['invalid hex before assignment', String.raw`"\xZZpassword=PRIVATE_CREDENTIAL"`],
    ['invalid unicode scheme separator', String.raw`Error: 'Be\u0061rer\u{110000} PRIVATE_CREDENTIAL'`],
  ])('final candidates: fails closed for %s', (_name, original) => {
    let input = original;
    for (let layer = 0; layer <= 2; layer += 1) {
      const sanitized = sanitizeHealthText(input, 32000, undefined, undefined, false);
      expect(sanitized).not.toContain('PRIVATE_CREDENTIAL');
      expect(sanitized).not.toContain('PRIVATE_SUFFIX');
      if (original.includes('"other":"visible"')) expect(sanitized).toContain('visible');
      input = JSON.stringify(input);
    }
  });

  it.each([
    String.raw`D:\a\repo\tests\home.png`,
    String.raw`"C:\build\runner\tests\home.png"`,
    String.raw`Error: 'D:\a\repo\tests\home.png'`,
  ])('final candidates: preserves nonsensitive path or malformed diagnostic %s', input => {
    expect(sanitizeHealthText(input, 8000, undefined, undefined, false)).toBe(input);
  });

  it('final candidates: omits invalid quoted diagnostics even without a decoded-text change', () => {
    expect(sanitizeHealthText(String.raw`"\xZZordinary"`, 8000, undefined, undefined, false)).toBe('<redacted>');
  });

  it('final candidates: bounds unrecognized backslash runs', () => {
    const script = String.raw`
      require.extensions['.ts'] = (module, filename) => module._compile(require('typescript').transpileModule(
        require('node:fs').readFileSync(filename, 'utf8'), { compilerOptions: { module: 1, target: 9 } }
      ).outputText, filename);
      const input = String.fromCharCode(92).repeat(100000) + 'ordinary text';
      const start = performance.now();
      const preserved = require('./src/health/render.ts').sanitizeHealthText(input, input.length, undefined, undefined, false) === input;
      console.log(JSON.stringify({ milliseconds: performance.now() - start, preserved }));
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: resolve(__dirname, '../..'), encoding: 'utf8', timeout: 5000,
    });
    expect({ error: result.error?.message, stderr: result.stderr, status: result.status }).toEqual({ error: undefined, stderr: '', status: 0 });
    expect(JSON.parse(result.stdout).preserved).toBe(true);
    expect(JSON.parse(result.stdout).milliseconds).toBeLessThan(4000);
  });

  it.each([
    ['truncated pretty JSON', String.raw`Received: "{\\n  \\\"password\\\": \\\"FIRST PRIVATE_SUFFIX\\\",\\n  \\\"other\\\": \\\"visible\\\"`],
    ['bare escaped fragment', String.raw`Log: \\\"password\\\": \\\"PRIVATE_SUFFIX\\\"`],
  ])('final review: bounded escaped layers for %s', (name, original) => {
    expect(original).toContain(String.raw`\\\"password\\\"`);
    if (name === 'truncated pretty JSON') {
      expect(original.startsWith('Received: "{')).toBe(true);
      expect(original).toContain(String.raw`\\n`);
      expect(original.endsWith(String.raw`\\\"`)).toBe(true);
    }
    let input = original;
    for (let layer = 0; layer <= 4; layer += 1) {
      expect(sanitizeHealthText(input, 32000, undefined, undefined, false)).not.toContain('PRIVATE_SUFFIX');
      input = JSON.stringify(input);
    }
  });

  it.each([
    ['hex assignment', String.raw`"password\x3dPRIVATE_CREDENTIAL"`],
    ['hex scheme', String.raw`"Be\x61rer PRIVATE_CREDENTIAL"`],
    ['unicode single assignment', String.raw`Error: 'pass\u0077ord=PRIVATE_CREDENTIAL'`],
    ['unicode backtick assignment', 'Error: `pass\\u0077ord=PRIVATE_CREDENTIAL`'],
    ['unicode single scheme', String.raw`Error: 'Be\u0061rer PRIVATE_CREDENTIAL'`],
    ['unicode backtick scheme', 'Error: `Be\\u0061rer PRIVATE_CREDENTIAL`'],
    ['escaped apostrophe assignment', String.raw`\'password\'=\'PRIVATE_CREDENTIAL\'`],
    ['invalid hex after recognized assignment', String.raw`"password=FIRST\xZZ PRIVATE_CREDENTIAL"`],
    ['invalid unicode after recognized scheme', String.raw`Error: 'Be\u0061rer FIRST\u{110000} PRIVATE_CREDENTIAL'`],
  ])('final review: safely decodes JS diagnostic %s', (_name, original) => {
    let input = original;
    for (let layer = 0; layer <= 2; layer += 1) {
      expect(sanitizeHealthText(input, 16000, undefined, undefined, false)).not.toContain('PRIVATE_CREDENTIAL');
      input = JSON.stringify(input);
    }
  });

  it('final review: preserves arbitrary nonsensitive password suffixes', () => {
    for (const input of ['Notapassword=visible', String.raw`"Notapassword\x3dvisible"`, String.raw`'Notapassword\u003dvisible'`]) {
      expect(sanitizeHealthText(input, 8000, undefined, undefined, false)).toBe(input);
    }
  });

  it.each([
    ['escaped scheme', String.raw`{"message":"Be\u0061rer PRIVATE_CREDENTIAL","other":"visible"}`, 'PRIVATE_CREDENTIAL'],
    ['escaped URL', String.raw`{"message":"https:\/\/alice:PRIVATE_PASSWORD@localhost/path","other":"visible"}`, 'PRIVATE_PASSWORD'],
  ])('remaining audit: full decoded pipeline for %s', (_name, original, secret) => {
    let input = original;
    for (let layer = 0; layer <= 2; layer += 1) {
      const sanitized = sanitizeHealthText(input, 8000, undefined, undefined, false);
      expect(sanitized).not.toContain(secret);
      expect(sanitized).toContain('visible');
      input = JSON.stringify(input);
    }
  });

  it.each([
    ["Retrying, 'til ready: password: '#FIRST PRIVATE_SUFFIX'", 'PRIVATE_SUFFIX'],
    ['Unexpected " in password: "#FIRST PRIVATE_SUFFIX"', 'PRIVATE_SUFFIX'],
    ["sh -c 'PASSWORD='$hunter2' npm test'", 'hunter2'],
  ])('remaining audit: empty sensitive assignment quote ownership in %s', (input, secret) => {
    expect(sanitizeHealthText(input, 8000, undefined, undefined, false)).not.toContain(secret);
  });

  it('remaining audit: preserves Windows paths without exposing escaped newline keys', () => {
    const input = String.raw`D:\a\repo\tests\home.png; rerun with --update-snapshots`;
    expect(sanitizeHealthText(input, 8000, undefined, undefined, false)).toBe(input);
    for (const prefix of [String.raw`\n`, String.raw`\r`, String.raw`\t`, String.raw`\n\r\t `]) {
      expect(sanitizeHealthText(`stderr: Starting${prefix}password=PRIVATE_SUFFIX`, 8000, undefined, undefined, false)).not.toContain('PRIVATE_SUFFIX');
    }
  });

  it('remaining audit: bounds repeated escaped whitespace lookahead', () => {
    const script = String.raw`
      require.extensions['.ts'] = (module, filename) => module._compile(require('typescript').transpileModule(
        require('node:fs').readFileSync(filename, 'utf8'), { compilerOptions: { module: 1, target: 9 } }
      ).outputText, filename);
      const clean = require('./src/health/render.ts').sanitizeHealthText;
      const prefix = String.fromCharCode(92, 110).repeat(50000);
      const input = prefix + 'ordinary text';
      const start = performance.now();
      const preserved = clean(input, input.length, undefined, undefined, false) === input;
      const hidden = clean(prefix + 'password=PRIVATE_SUFFIX', input.length, undefined, undefined, false).includes('PRIVATE_SUFFIX') === false;
      console.log(JSON.stringify({ milliseconds: performance.now() - start, preserved, hidden }));
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: resolve(__dirname, '../..'), encoding: 'utf8', timeout: 5000,
    });
    expect({ error: result.error?.message, stderr: result.stderr, status: result.status }).toEqual({ error: undefined, stderr: '', status: 0 });
    expect(JSON.parse(result.stdout)).toEqual({ milliseconds: expect.any(Number), preserved: true, hidden: true });
    expect(JSON.parse(result.stdout).milliseconds).toBeLessThan(4000);
  });

  it.each(['DBPassword', 'APISecret', 'JWTToken', 'AWSSecretAccessKey'])(
    'remaining audit: normalizes acronym-prefixed field %s', name => {
      const sanitized = sanitizeHealthText(JSON.stringify({ [name]: 'PRIVATE_SUFFIX', other: 'visible' }), 8000, undefined, undefined, false);
      expect(sanitized).not.toContain('PRIVATE_SUFFIX');
      expect(sanitized).toContain('visible');
      expect(sanitizeHealthText('Notapassword=visible', 8000, undefined, undefined, false)).toBe('Notapassword=visible');
    }
  );

  it('remaining audit: invokes the custom callback once after decoded builtins and sanitizes its result', () => {
    const custom = jest.fn((text: string) => {
      expect(text).not.toContain('PRIVATE_CREDENTIAL');
      expect(text).toContain('visible');
      return String.raw`{"message":"Be\u0061rer CALLBACK_CREDENTIAL","other":"visible"}`;
    });
    const sanitized = sanitizeHealthText(String.raw`{"message":"Be\u0061rer PRIVATE_CREDENTIAL","other":"visible"}`, 8000, undefined, custom, false);
    expect(custom).toHaveBeenCalledTimes(1);
    expect(sanitized).not.toContain('CALLBACK_CREDENTIAL');
    expect(sanitized).toContain('visible');
  });

  it.each([
    ['quoted command argument', 'Invalid argument "--password=hunter2": unexpected value', 'hunter2'],
    ['assignment-shaped object key', "{'token=abc123': bad}", 'abc123'],
    ['prose apostrophe before quoted value', "Retrying, 'til ready: password: 'FIRST PRIVATE_SUFFIX'", 'PRIVATE_SUFFIX'],
    ['stray quote before quoted value', 'Unexpected " in password: "FIRST PRIVATE_SUFFIX"', 'PRIVATE_SUFFIX'],
    ['shell quote concatenation', "Command failed: sh -c 'PASSWORD='hunter2' npm test'", 'hunter2'],
    ['apostrophe inside diagnostic wrapper', `Error: '{"password":"it's PRIVATE_SUFFIX","other":"visible"}'`, 'PRIVATE_SUFFIX'],
    ['encoded single-quoted key', String.raw`{'pass\u0077ord':'PRIVATE_SUFFIX','other':'visible'}`, 'PRIVATE_SUFFIX'],
    ['truncated escaped JSON wrapper', String.raw`Received: "{\n  \"password\": \"FIRST PRIVATE_SUFFIX\",\n  \"other\": \"visible\"`, 'PRIVATE_SUFFIX'],
    ['escaped field fragment', String.raw`Log: \"password\": \"FIRST PRIVATE_SUFFIX\"`, 'PRIVATE_SUFFIX'],
    ['literal escaped log newline', String.raw`stderr: Starting\npassword=hunter2`, 'hunter2'],
    ['multiword connection password', 'Server=db;User Id=sa;Password=correct horse battery;Database=app', 'horse battery'],
  ])("review regression: %s", (_name, input, secret) => {
    const sanitized = sanitizeHealthText(input, 8000, undefined, undefined, false);
    expect(sanitized).not.toContain(secret);
    if (input.includes('"other":"visible"')) expect(sanitized).toContain('visible');
    if (input.startsWith('Server=')) expect(sanitized).toContain('Database=app');
  });

  it.each(['Authorization: Bearer secret1', 'Cookie: session=secret1'])('review regression: compact sibling after %s', message => {
    const sanitized = sanitizeHealthText(JSON.stringify({ message, other: 'visible' }), 8000, undefined, undefined, false);
    expect(sanitized).not.toContain('secret1');
    expect(sanitized).toContain('visible');
  });

  it.each(['single', 'double'])('review regression: bounded malformed %s quote scanning', quote => {
    const script = String.raw`
      require.extensions['.ts'] = (module, filename) => module._compile(require('typescript').transpileModule(
        require('node:fs').readFileSync(filename, 'utf8'), { compilerOptions: { module: 1, target: 9 } }
      ).outputText, filename);
      const input = process.argv[1] === 'single' ? String.fromCharCode(92, 39).repeat(50000) + 'x' : '"' + String.fromCharCode(92, 34).repeat(100000);
      const start = performance.now();
      require('./src/health/render.ts').sanitizeHealthText(input, 1000, undefined, undefined, false);
      console.log(JSON.stringify({ milliseconds: performance.now() - start, length: input.length }));
    `;
    const result = spawnSync(process.execPath, ['-e', script, quote], {
      cwd: resolve(__dirname, '../..'), encoding: 'utf8', timeout: 5000,
    });
    expect({ error: result.error?.message, stderr: result.stderr, status: result.status }).toEqual({ error: undefined, stderr: '', status: 0 });
    expect(JSON.parse(result.stdout).milliseconds).toBeLessThan(4000);
  });

  it("owns secret boundaries within each decoded diagnostic layer", () => {
    const inputs = [
      String.raw`DB_PASSWORD=\FIRST"PRIVATE_SUFFIX`,
      JSON.stringify({ message: 'DB_PASSWORD: "FIRST",PRIVATE_SUFFIX', other: "visible" }),
      JSON.stringify({ log: "password=secret1\nclient_secret=FIRST PRIVATE_SUFFIX", other: "visible" }),
      String.raw`{"pass\u0077ord":"PRIVATE_SUFFIX","other":"visible"}`,
      JSON.stringify(String.raw`{'password':'FIRST\' PRIVATE_SUFFIX','other':'visible'}`),
      JSON.stringify({ message: "{'token':null,'password':'FIRST PRIVATE_SUFFIX'}", other: "visible" }),
      'password=a,"b {"token":null,"password":"FIRST PRIVATE_SUFFIX","other":"visible"}',
      '{password:secret1,client_secret:"FIRST PRIVATE_SUFFIX",other:"visible"}',
      `Retrying, 'til ready: {"token":null,"password":"FIRST PRIVATE_SUFFIX","other":"visible"}`,
    ];
    for (const input of inputs) {
      const sanitized = sanitizeHealthText(input, 4000, undefined, undefined, false);
      expect({ input, sanitized }).toEqual({ input, sanitized: expect.not.stringContaining("PRIVATE_SUFFIX") });
      if (input.includes("visible")) expect(sanitized).toContain("visible");
    }
  });

  it("keeps diagnostic punctuation outside the following secret container", () => {
    for (const quote of ["'", '"', "`"]) {
      for (const punctuation of ["{", "["]) {
        const input = `Unexpected token ${quote}${punctuation}${quote} in {"token":null,"password":"FIRST PRIVATE_SUFFIX","other":"visible"}`;
        const sanitized = sanitizeHealthText(input, 4000, undefined, undefined, false);
        expect(sanitized).not.toContain("PRIVATE_SUFFIX");
        expect(sanitized).toContain("visible");
      }
    }
  });

  it("redacts the cross-family layer ownership matrix", () => {
    for (const predecessor of ["null", "[]", '{"scheme":"custom"}']) {
      for (const separator of [":", "="]) {
        for (const prefix of ["", "Received: ", `Retrying, 'til ready: `, `Unexpected token '{' in `]) {
          let input = `${prefix}{"token"${separator}${predecessor},"password"${separator}"FIRST PRIVATE_SUFFIX","other":"visible"}`;
          for (let layer = 0; layer <= 2; layer += 1) {
            const sanitized = sanitizeHealthText(input, 8000, undefined, undefined, false);
            expect({ input, sanitized }).toEqual({ input, sanitized: expect.not.stringContaining("PRIVATE_SUFFIX") });
            expect(sanitized).toContain("visible");
            input = JSON.stringify(input);
          }
        }
      }
    }
  });

  it("does not let ambiguous prose quotes own a following diagnostic container", () => {
    for (const prefix of [
      'Expected 27" monitor. Received: ',
      `Retrying, 'til ready: `,
      'A stray " before the object: ',
      `Error: 'til ready: `,
      '" before the object: ',
      String.raw`Path "C:\work\" then: `,
    ]) {
      for (const quote of ['"', "'", "`"]) {
        let input = `${prefix}{${quote}token${quote}:null,${quote}password${quote}:${quote}FIRST PRIVATE_SUFFIX${quote},${quote}other${quote}:${quote}visible${quote}}`;
        for (let layer = 0; layer <= 2; layer += 1) {
          const sanitized = sanitizeHealthText(input, 8000, undefined, undefined, false);
          expect({ input, sanitized }).toEqual({ input, sanitized: expect.not.stringContaining("PRIVATE_SUFFIX") });
          expect(sanitized).toContain("visible");
          input = JSON.stringify(input);
        }
      }
    }
  });

  it("redacts encoded keys and escaped non-JSON value quotes across layers", () => {
    for (const original of [
      String.raw`{"pass\u0077ord":"FIRST PRIVATE_SUFFIX","other":"visible"}`,
      String.raw`{'token':null,'password':'FIRST\' PRIVATE_SUFFIX','other':'visible'}`,
      '{`token`:null,`password`:`FIRST\\` PRIVATE_SUFFIX`,`other`:`visible`}',
      String.raw`{"token":null,"password":"FIRST\\\" PRIVATE_SUFFIX","other":"visible"}`,
    ]) {
      let input = original;
      for (let layer = 0; layer <= 2; layer += 1) {
        const sanitized = sanitizeHealthText(input, 8000, undefined, undefined, false);
        expect({ input, sanitized }).toEqual({ input, sanitized: expect.not.stringContaining("PRIVATE_SUFFIX") });
        expect(sanitized).toContain("visible");
        input = JSON.stringify(input);
      }
    }
  });

  it("fails closed on malformed escaped containers", () => {
    for (const input of [
      String.raw`Log: {\"token\":null,\"password\":\"FIRST PRIVATE_SUFFIX\",\"note\":\q}`,
      String.raw`Log: {\"pass\u0077ord\":\"FIRST PRIVATE_SUFFIX\",\"note\":\q}`,
    ]) {
      expect(sanitizeHealthText(input, 4000, undefined, undefined, false)).not.toContain("PRIVATE_SUFFIX");
    }
  });

  it("does not leak attached closing delimiters from unquoted structured secrets", () => {
    for (const password of ["FIRST]PRIVATE_SUFFIX", "FIRST}PRIVATE_SUFFIX", "FIRST]}PRIVATE_SUFFIX", `FIRST${"]".repeat(40000)}PRIVATE_SUFFIX`]) {
      let input = `{password:${password},other:"visible"}`;
      for (let layer = 0; layer <= 2; layer += 1) {
        const sanitized = sanitizeHealthText(input, 8000, undefined, undefined, false);
        expect({ input, sanitized }).toEqual({ input, sanitized: expect.not.stringContaining("PRIVATE_SUFFIX") });
        expect(sanitized).toContain("visible");
        input = JSON.stringify(input);
      }
    }
  });

  it("bounds string decoding while preserving outer diagnostic siblings", () => {
    let message = '{"password":"FIRST PRIVATE_SUFFIX"}';
    for (let layer = 0; layer < 18; layer += 1) message = JSON.stringify(message);
    const input = JSON.stringify({ message, other: "visible" });
    const sanitized = sanitizeHealthText(input, input.length, undefined, undefined, false);
    expect(sanitized).not.toContain("PRIVATE_SUFFIX");
    expect(sanitized).toContain("visible");
    expect(sanitized.length).toBeLessThan(input.length);
  });

  it("preserves secret boundaries after single-quoted diagnostic punctuation", () => {
    for (const punctuation of [":", "=", ","]) {
      const input = `Unexpected token '${punctuation}' in {"password":"FIRST","client_secret":"NEXT PRIVATE_SUFFIX","other":"visible"}`;
      const sanitized = sanitizeHealthText(input, 1000, undefined, undefined, false);
      expect(sanitized).not.toContain("PRIVATE_SUFFIX");
      expect(sanitized).toContain("visible");
    }
  });

  it("redacts sensitive fields inside quoted diagnostic wrappers", () => {
    for (const wrapper of ["'", "`"]) {
      const input = `Error: ${wrapper}{"token":null,"password":"FIRST PRIVATE_SUFFIX","other":"visible"}${wrapper}`;
      const sanitized = sanitizeHealthText(input, 1000, undefined, undefined, false);
      expect(sanitized).not.toContain("PRIVATE_SUFFIX");
      expect(sanitized).toContain("visible");
    }
  });

  it("redacts contextual Token credentials after serialized separator whitespace", () => {
    for (const whitespace of ["\n", "\r", "\t"]) {
      const input = JSON.stringify({ log: `token=${whitespace} Token synthetic-credential`, other: "visible" });
      const sanitized = sanitizeHealthText(input, 1000, undefined, undefined, false);
      expect(sanitized).not.toContain("synthetic-credential");
      expect(sanitized).toContain("visible");
    }
  });

  it("recognizes serialized whitespace before structural string quotes", () => {
    for (const whitespace of ["\n", "\r", "\t", " \n\t "]) {
      const input = JSON.stringify(`{"note":${whitespace}"}","token":null,"password":"FIRST PRIVATE_SUFFIX","other":"visible"}`);
      const sanitized = sanitizeHealthText(input, 1000, undefined, undefined, false);
      expect(sanitized).not.toContain("PRIVATE_SUFFIX");
      expect(sanitized).toContain("visible");
    }
  });

  it("preserves backtick delimiters during early authentication scheme redaction", () => {
    for (const scheme of ["Bearer", "NTLM", "Negotiate", "ApiKey", "credential: Token"]) {
      const input = '{"password":`' + scheme + ' SCHEMELEAK`,"client_secret":`FIRST TAILLEAK`,"other":"visible"}';
      const sanitized = sanitizeHealthText(input, 1000, undefined, undefined, false);
      expect(sanitized).not.toContain("SCHEMELEAK");
      expect(sanitized).not.toContain("TAILLEAK");
      expect(sanitized).toContain("visible");
    }
  });

  it("redacts short Token values on quoted authentication labels", () => {
    for (const label of ["credential", "access token", "auth token"]) {
      const plain = JSON.stringify({ [label]: "Token synthetic-credential", other: "visible" });
      for (const input of [plain, JSON.stringify(plain)]) {
        const sanitized = sanitizeHealthText(input, 1000, undefined, undefined, false);
        expect(sanitized).not.toContain("synthetic-credential");
        expect(sanitized).toContain("visible");
      }
    }
    expect(sanitizeHealthText("waiting for Token refresh", 1000, undefined, undefined, false)).toBe("waiting for Token refresh");
  });

  it("redacts quoted Azure account and shared access keys", () => {
    const input = JSON.stringify({ AccountKey: "ACCOUNTLEAK", SharedAccessKey: "SHAREDLEAK", other: "visible" });
    const sanitized = sanitizeHealthText(input, 1000, undefined, undefined, false);
    expect(sanitized).not.toContain("ACCOUNTLEAK");
    expect(sanitized).not.toContain("SHAREDLEAK");
    expect(sanitized).toContain("visible");
  });

  it("redacts assignments at the start of ordinary quoted field values", () => {
    for (const assignment of ["password=EMBEDDEDLEAK", "token=EMBEDDEDLEAK"]) {
      const input = JSON.stringify({ message: assignment, other: "visible" });
      const sanitized = sanitizeHealthText(input, 1000, undefined, undefined, false);
      expect(sanitized).not.toContain("EMBEDDEDLEAK");
      expect(sanitized).toContain("visible");
    }
  });

  it("redacts assignments after quoted keys with unquoted values", () => {
    const sanitized = sanitizeHealthText('{"message":password=EMBEDDEDLEAK,"other":"visible"}', 1000, undefined, undefined, false);
    expect(sanitized).not.toContain("EMBEDDEDLEAK");
  });

  it("redacts sensitive siblings after multiline authorization values", () => {
    for (const authorization of ["Digest username=alice", "Authorization: Bearer synthetic-credential"]) {
      const input = JSON.stringify({ authorization, password: "FIRST SECONDLEAK", other: "visible" }, null, 2);
      const sanitized = sanitizeHealthText(input, 1000, undefined, undefined, false);
      expect(sanitized).not.toContain("SECONDLEAK");
      expect(sanitized).toContain("visible");
    }
  });

  it("redacts short Token credentials on environment-prefixed labels", () => {
    for (const input of ["GITHUB_TOKEN=Token synthetic-credential", "AZURE_CLIENT_SECRET=Token synthetic-credential"]) {
      const sanitized = sanitizeHealthText(input, 1000, undefined, undefined, false);
      expect(sanitized).not.toContain("synthetic-credential");
    }
  });

  it("redacts short Token credentials after serialized whitespace", () => {
    const input = JSON.stringify({ log: "start\ntoken=Token synthetic-credential", other: "visible" });
    const sanitized = sanitizeHealthText(input, 1000, undefined, undefined, false);
    expect(sanitized).not.toContain("synthetic-credential");
    expect(sanitized).toContain("visible");
  });

  it("sanitizes secrets, URL credentials and signed queries before truncating", () => {
    const text = sanitizeHealthText(
      "Bearer opaque-secret https://user:password@acme.example/file?sig=secret#token eyJabc.def.ghi",
      500,
      undefined,
      undefined,
      false
    );
    expect(text).not.toContain("opaque-secret");
    expect(text).not.toContain("password");
    expect(text).not.toContain("sig=");
    expect(text).not.toContain("#token");
    expect(text).not.toContain("eyJabc.def.ghi");
    expect(text).toContain("https://acme.example/file");
  });

  it("redacts complete Basic and Digest authorization credentials", () => {
    for (const scheme of ["Basic", "Digest", "Bearer"]) {
      expect(sanitizeHealthText(`Authorization: ${scheme} synthetic-credential`))
        .not.toContain("synthetic-credential");
    }
    expect(sanitizeHealthText('Received: "{\\"access_token\\":\\"synthetic-token\\"}"'))
      .not.toContain("synthetic-token");
    expect(sanitizeHealthText('Received: "{\\"password\\":\\"correct horse battery\\"}"'))
      .not.toContain("correct horse battery");
    expect(sanitizeHealthText('Digest username="alice", realm="example", response="digest-secret"')).not.toContain("digest-secret");
  });

  it("redacts credentials even when ANSI styling splits the key or value", () => {
    expect(sanitizeHealthText('password:\u001b[32m"alpha beta"\u001b[39m')).not.toContain("alpha beta");
    expect(sanitizeHealthText('pass\u001b[32mword: "alpha beta"')).not.toContain("alpha beta");
    expect(sanitizeHealthText("password: `alpha beta`")).not.toContain("alpha beta");
  });

  it("redacts credentials from non-HTTP schemes and webhook paths but preserves ordinary text", () => {
    const sanitized = sanitizeHealthText([
      "amqp://user:synthetic-secret@broker.acme.example:5672",
      "amqp://user:synthetic-secret@localhost:5672",
      "wss://user:synthetic-secret@socket.acme.example/?token=synthetic-token",
      "https://tenant.webhook.office.com/webhookb2/tenant/IncomingWebhook/private-token/id",
      "Response: 500; file.csv: value",
    ].join(" "));
    expect(sanitized).not.toContain("synthetic-secret");
    expect(sanitized).not.toContain("synthetic-token");
    expect(sanitized).not.toContain("private-token");
    expect(sanitized).toContain("Response: 500");
    expect(sanitized).toContain("file.csv: value");
  });

  it("redacts quoted and escaped credentials without consuming neighboring fields", () => {
    const sanitized = sanitizeHealthText(
      String.raw`{"password":"correct horse battery","client_secret":"synthetic-secret","x-api-key":"key-value","Cookie":"session=private"}`,
      1000,
      undefined,
      undefined,
      false
    );
    expect(sanitized).not.toContain("correct horse battery");
    expect(sanitized).not.toContain("synthetic-secret");
    expect(sanitized).not.toContain("key-value");
    expect(sanitized).not.toContain("session=private");
    expect(sanitizeHealthText("Cookie: theme=light; session=private")).not.toContain("session=private");
    expect(sanitizeHealthText("DB_PASSWORD=private", 300, undefined, undefined, false)).not.toContain("DB_PASSWORD=private");
    expect(sanitizeHealthText("DB_PASSWORD=alpha,SECRET-SUFFIX", 300, undefined, undefined, false)).not.toContain("SECRET-SUFFIX");
    const cookieArray = sanitizeHealthText(String.raw`{"set-cookie":["first-session","second-session"],"other":"visible"}`, 300, undefined, undefined, false);
    expect(cookieArray).not.toContain("second-session");
    expect(cookieArray).toContain("visible");
    const multilineCookies = sanitizeHealthText(JSON.stringify({ "set-cookie": ["session=private", "auth=private"] }, null, 2), 300, undefined, undefined, false);
    expect(multilineCookies).not.toContain("session=private");
    expect(multilineCookies).not.toContain("auth=private");
    const singleQuotedCookies = sanitizeHealthText(String.raw`{ 'set-cookie': [ 'session=first]PRIVATE', 'session=SECOND_SECRET' ] }`, 300, undefined, undefined, false);
    expect(singleQuotedCookies).not.toContain("PRIVATE");
    expect(singleQuotedCookies).not.toContain("SECOND_SECRET");
    const escapedSingleQuote = sanitizeHealthText(String.raw`{ 'set-cookie': [ 'session=first\']PRIVATE', 'session=SECOND_SECRET' ] }`, 300, undefined, undefined, false);
    expect(escapedSingleQuote).not.toContain("PRIVATE");
    expect(escapedSingleQuote).not.toContain("SECOND_SECRET");
    const backtickCookies = sanitizeHealthText("{ 'set-cookie': [ `session=first]PRIVATE`, `session=SECOND_SECRET` ] }", 300, undefined, undefined, false);
    expect(backtickCookies).not.toContain("PRIVATE");
    expect(backtickCookies).not.toContain("SECOND_SECRET");
    expect(sanitizeHealthText("Response: 500; file.csv: value")).toContain("Response: 500; file.csv: value");
  });

  it("redacts secrets after unquoted values and in escaped JSON fragments", () => {
    const cases = [
      [String.raw`{"token":null,"password":"correct horse battery","other":"visible"}`, "correct horse battery"],
      [String.raw`{"authorization":{"scheme":"Custom","secret":"part1 part2"}}`, "part1 part2"],
      [String.raw`Log: {\"password\":\"secret1\"} {"password":"secret2"}`, "secret2"],
      [String.raw`Error: '{\"password\":\"secret1\"}' in {"password":"secret2"}`, "secret2"],
    ];

    for (const [input, secret] of cases) {
      expect(sanitizeHealthText(input)).not.toContain(secret);
    }
    expect(sanitizeHealthText(cases[2][0])).not.toContain("secret1");
    expect(sanitizeHealthText(cases[3][0])).not.toContain("secret1");
    expect(sanitizeHealthText(cases[0][0])).toContain("visible");
    expect(sanitizeHealthText("SRI digest mismatch for main.js")).toContain("SRI digest mismatch for main.js");
    expect(sanitizeHealthText("waiting for token refresh")).toContain("waiting for token refresh");
    expect(sanitizeHealthText("Digest algorithm=MD5, username=alice, response=credential-proof")).not.toContain("credential-proof");
  });

  it("redacts escaped JSON secrets followed by prose and another object", () => {
    const embeddedBoundary = JSON.stringify(JSON.stringify({
      password: 'part1"} {PRIVATE_SUFFIX',
      other: "visible",
    }));
    const separatedByProse = String.raw`Log: {\"password\":\"secret1\"} failed: {"password":"secret2"}`;

    expect(sanitizeHealthText(embeddedBoundary, 1000, undefined, undefined, false)).not.toContain("PRIVATE_SUFFIX");
    expect(sanitizeHealthText(embeddedBoundary, 1000, undefined, undefined, false)).toContain("visible");
    expect(sanitizeHealthText(separatedByProse)).not.toContain("secret1");
    expect(sanitizeHealthText(separatedByProse)).not.toContain("secret2");
  });

  it("does not treat an embedded escaped quote as the end of a serialized secret", () => {
    const password = String.raw`part1\"} {PRIVATE_SUFFIX`;
    const value = JSON.stringify(JSON.stringify({
      password,
      other: "visible",
    }));

    expect(sanitizeHealthText(value, 1000, undefined, undefined, false)).not.toContain("PRIVATE_SUFFIX");
    expect(sanitizeHealthText(value, 1000, undefined, undefined, false)).toContain("visible");
  });

  it("closes escaped structured values before scanning following secret fields", () => {
    const value = String.raw`Log: {\"authorization\":{\"scheme\":\"Custom\",\"note\":\"visible\"},\"other\":\"visible\"} {"password":"following-secret"}`;
    const sanitized = sanitizeHealthText(value);

    expect(sanitized).toContain("visible");
    expect(sanitized).not.toContain("following-secret");
  });

  it("redacts unquoted secrets containing closing delimiters", () => {
    for (const value of ["password=FIRST]PRIVATE_SUFFIX", "password=FIRST}PRIVATE_SUFFIX"]) {
      expect(sanitizeHealthText(value, 300, undefined, undefined, false)).not.toContain("PRIVATE_SUFFIX");
    }
  });

  it("preserves following structured fields after quoted assignments", () => {
    const inputs = [
      JSON.stringify({ message: 'DB_PASSWORD="FIRST"PRIVATE_SUFFIX', other: "visible" }),
      JSON.stringify({ first: "Error: password=secret", password: "FIRST SECOND", other: "visible" }),
    ];
    for (const input of inputs) {
      const sanitized = sanitizeHealthText(input, 1000, undefined, undefined, false);
      expect(sanitized).not.toContain("PRIVATE_SUFFIX");
      expect(sanitized).not.toContain("SECOND");
      expect(sanitized).toContain("visible");
    }
  });

  it("redacts quoted credentials with an attached suffix", () => {
    for (const input of [
      'DB_PASSWORD="FIRST"PRIVATE_SUFFIX',
      JSON.stringify({ message: 'DB_PASSWORD="FIRST"PRIVATE_SUFFIX' }),
    ]) {
      expect(sanitizeHealthText(input, 1000, undefined, undefined, false)).not.toContain("PRIVATE_SUFFIX");
    }
  });

  it("does not infer structured context from prose commas", () => {
    const inputs = [
      String.raw`Diagnostic, DB_PASSWORD=\"FIRST\"PRIVATE_SUFFIX`,
      String.raw`Diagnostic, DB_PASSWORD=1,PRIVATE_SUFFIX`,
      String.raw`Diagnostic, DB_PASSWORD=prefix,"region":"PRIVATE_SUFFIX`,
      String.raw`Attempt 1, "password": "FIRST",PRIVATE_SUFFIX`,
      String.raw`Status true, "password":1,PRIVATE_SUFFIX`,
    ];
    for (const input of inputs) {
      expect(sanitizeHealthText(input, 1000, undefined, undefined, false)).not.toContain("PRIVATE_SUFFIX");
    }
  });

  it("preserves real JSON structure after a preceding string value", () => {
    const input = JSON.stringify({ previous: "visible", password: "FIRST PRIVATE_SUFFIX", other: "visible-too" });
    const sanitized = sanitizeHealthText(input, 1000, undefined, undefined, false);
    expect(sanitized).not.toContain("PRIVATE_SUFFIX");
    expect(sanitized).toContain("visible-too");
  });

  it("preserves JSON siblings after attached secret suffixes", () => {
    const input = JSON.stringify({
      message: 'DB_PASSWORD="FIRST"PRIVATE_SUFFIX',
      other: "visible sibling",
    });
    const sanitized = sanitizeHealthText(input, 1000, undefined, undefined, false);
    expect(sanitized).not.toContain("PRIVATE_SUFFIX");
    expect(sanitized).toContain("visible sibling");
  });

  it("preserves siblings after assignment-shaped fields in serialized strings", () => {
    const cases = [
      JSON.stringify({ message: "DB_PASSWORD=secret1", password: "correct horse battery", other: "visible" }),
      JSON.stringify({ first: "Error: password=secret", password: "FIRST SECOND", other: "visible" }),
      "{'previous':'visible','password':'FIRST SECOND','other':'visible'}",
      '{password:"FIRST SECOND",client_secret:"part1 part2",other:"visible"}',
    ];
    for (const input of cases) {
      const sanitized = sanitizeHealthText(input, 1000, undefined, undefined, false);
      expect(sanitized).not.toContain("horse");
      expect(sanitized).not.toContain("SECOND");
      expect(sanitized).toContain("visible");
    }
  });

  it("does not treat quoted prose labels as structured JSON boundaries", () => {
    for (const input of [
      String.raw`Attempt "init", "password": "FIRST",PRIVATE_SUFFIX`,
      String.raw`Attempt 1, "password": "FIRST",PRIVATE_SUFFIX`,
      String.raw`Status true, "password": 1,PRIVATE_SUFFIX`,
    ]) {
      expect(sanitizeHealthText(input, 1000, undefined, undefined, false)).not.toContain("PRIVATE_SUFFIX");
    }
  });

  it("does not infer serialized quote state from prose apostrophes", () => {
    const rawAssignment = String.raw`Can't connect: DB_PASSWORD=\"FIRST\"PRIVATE_SUFFIX`;
    const nestedJson = `Can't parse ${JSON.stringify({ note: "won't retry", message: String.raw`DB_PASSWORD=\"FIRST PRIVATE_SUFFIX\"` })}`;
    const unexpectedQuote = String.raw`Error: unexpected '"' in {"message":"DB_PASSWORD=\"FIRST PRIVATE_SUFFIX\""}`;
    const quoteInsidePreviousSecret = String.raw`password='a"b' Received: {"message":"DB_PASSWORD=\"FIRST PRIVATE_SUFFIX\""}`;
    const quoteBeforeJson = String.raw`Expected 27" monitor. Received: {"message":"DB_PASSWORD=\"FIRST PRIVATE_SUFFIX\""}`;
    const quoteInQuotedSecret = String.raw`password: 'a"b' {"message":"DB_PASSWORD=\"FIRST PRIVATE_SUFFIX\""}`;
    for (const input of [rawAssignment, nestedJson, unexpectedQuote, quoteInsidePreviousSecret, quoteBeforeJson, quoteInQuotedSecret]) {
      expect(sanitizeHealthText(input, 1000, undefined, undefined, false)).not.toContain("PRIVATE_SUFFIX");
    }
    expect(sanitizeHealthText(nestedJson, 1000, undefined, undefined, false)).toContain("won't retry");
  });

  it("does not treat literal escaped whitespace as a free-form assignment boundary", () => {
    const input = String.raw`DB_PASSWORD=\"{FIRST}\nPRIVATE_SUFFIX\"`;
    expect(sanitizeHealthText(input, 1000, undefined, undefined, false)).not.toContain("PRIVATE_SUFFIX");
  });

  it("redacts attached suffixes after quoted credential boundaries", () => {
    for (const input of [
      String.raw`DB_PASSWORD="FIRST"PRIVATE_SUFFIX`,
      JSON.stringify({ message: String.raw`DB_PASSWORD="FIRST"PRIVATE_SUFFIX` }),
    ]) {
      expect(sanitizeHealthText(input, 1000, undefined, undefined, false)).not.toContain("PRIVATE_SUFFIX");
    }
  });

  it("only treats an actually open serialized string as assignment context", () => {
    const nestedAfterLogText = JSON.stringify({
      message: 'Connection failed: DB_PASSWORD="FIRST PRIVATE_SUFFIX"',
    });
    const afterClosedQuote = String.raw`"trace" DB_PASSWORD=\"FIRST\"PRIVATE_SUFFIX`;

    expect(sanitizeHealthText(nestedAfterLogText, 1000, undefined, undefined, false)).not.toContain("PRIVATE_SUFFIX");
    expect(sanitizeHealthText(afterClosedQuote, 1000, undefined, undefined, false)).not.toContain("PRIVATE_SUFFIX");
  });
  it("does not leak array suffixes after a quoted value ending in a backslash", () => {
    const value = JSON.stringify({ authorization: ["prefix\\", "PRIVATE]TAIL"], other: "visible" });

    for (const input of [value, JSON.stringify(value)]) {
      const sanitized = sanitizeHealthText(input);
      expect(sanitized).not.toContain("TAIL");
      expect(sanitized).toContain("visible");
    }
  });

  it("scans deeply nested adjacent credential segments without recursion", () => {
    const input = `DB_PASSWORD=${"{}".repeat(20000)}PRIVATE_SUFFIX`;

    expect(() => sanitizeHealthText(input, 1000, undefined, undefined, false)).not.toThrow();
    expect(sanitizeHealthText(input, 1000, undefined, undefined, false)).not.toContain("PRIVATE_SUFFIX");
  });
  it("scans many serialized sensitive fields without rescanning prior prefixes", () => {
    const input = JSON.stringify(JSON.stringify(Array.from({ length: 3000 }, () => ({ token: "private-token" }))));
    expect(sanitizeHealthText(input, 1000, undefined, undefined, false)).not.toContain("private-token");
  });
  it("redacts Digest username-star directives", () => {
    expect(sanitizeHealthText("Digest username*=UTF-8''alice, realm=api, response=credential-proof", 300, undefined, undefined, false))
      .not.toContain("credential-proof");
  });

  it("redacts Token credentials without redacting ordinary token prose", () => {
    expect(sanitizeHealthText("Request credential: Token synthetic-credential", 300, undefined, undefined, false))
      .not.toContain("synthetic-credential");
    expect(sanitizeHealthText("Request access token: Token synthetic-credential", 300, undefined, undefined, false))
      .not.toContain("synthetic-credential");
    for (const [input, credential] of [
      ["access_token: Bearer opaque-secret", "opaque-secret"],
      ["token: Token opaque-secret", "opaque-secret"],
      ["api_key: ApiKey opaque-secret", "opaque-secret"],
      ["password: Basic YWxpY2U6c2VjcmV0", "YWxpY2U6c2VjcmV0"],
      ["token: Bearer opaque-secret", "opaque-secret"],
      ["refresh_token: Token opaque-secret", "opaque-secret"],
      ["x-api-key: ApiKey opaque-secret", "opaque-secret"],
      ["auth token: Token opaque-secret", "opaque-secret"],
    ]) {
      expect(sanitizeHealthText(input, 300, undefined, undefined, false)).not.toContain(credential);
    }
    expect(sanitizeHealthText("Token 9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b", 300, undefined, undefined, false))
      .not.toContain("9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b");
    expect(sanitizeHealthText("waiting for token refresh", 300, undefined, undefined, false)).toContain("waiting for token refresh");
    expect(sanitizeHealthText("Token refresh failed", 300, undefined, undefined, false)).toContain("Token refresh failed");
    expect(sanitizeHealthText("Token configuration failed", 300, undefined, undefined, false)).toBe("Token configuration failed");
  });

  it("redacts attached suffixes after brace-prefixed credentials", () => {
    for (const input of [
      "DB_PASSWORD={FIRST}PRIVATE_SUFFIX",
      "DB_PASSWORD=[FIRST]PRIVATE_SUFFIX",
      String.raw`DB_PASSWORD={FIRST}\PRIVATE_SUFFIX`,
      String.raw`DB_PASSWORD=[FIRST]\PRIVATE_SUFFIX`,
    ]) {
      expect(sanitizeHealthText(input, 1000, undefined, undefined, false)).not.toContain("PRIVATE_SUFFIX");
    }
  });

  it("does not treat escaped shell quotes or JSON-like fragments as assignment boundaries", () => {
    for (const input of [
      String.raw`DB_PASSWORD=\"FIRST\"PRIVATE_SUFFIX`,
      String.raw`"DB_PASSWORD"=null}PRIVATE_SUFFIX`,
      String.raw`DB_PASSWORD=prefix,"region":"PRIVATE_SUFFIX`,
    ]) {
      expect(sanitizeHealthText(input, 1000, undefined, undefined, false)).not.toContain("PRIVATE_SUFFIX");
    }
  });

  it("redacts suffixes in indented JSON after serialization", () => {
    const value = JSON.stringify(JSON.stringify({
      password: "FIRST PRIVATE_SUFFIX",
      other: "visible",
    }, null, 2));
    const sanitized = sanitizeHealthText(value, 1000, undefined, undefined, false);

    expect(sanitized).not.toContain("PRIVATE_SUFFIX");
    expect(sanitized).toContain("visible");
  });

  it("redacts quoted assignments after serialization", () => {
    const value = JSON.stringify('DB_PASSWORD="correct horse battery"');
    const sanitized = sanitizeHealthText(value, 1000, undefined, undefined, false);

    expect(sanitized).not.toContain("correct");
    expect(sanitized).not.toContain("horse");
    expect(sanitized).not.toContain("battery");
  });

  it("redacts assignments nested in and prefixed before serialized strings", () => {
    const nested = JSON.stringify({ message: 'DB_PASSWORD="FIRST PRIVATE_SUFFIX"' });
    const prefixed = `Received: ${JSON.stringify('DB_PASSWORD="FIRST PRIVATE_SUFFIX"')}`;

    for (const input of [nested, prefixed]) {
      expect(sanitizeHealthText(input, 1000, undefined, undefined, false)).not.toContain("PRIVATE_SUFFIX");
    }
  });

  it("recognizes escaped whitespace between serialized structured values", () => {
    const scalarArray = JSON.stringify('[{"token":null\n},{"password":"FIRST PRIVATE_SUFFIX"}]');
    const indentedNestedArray = JSON.stringify(JSON.stringify([
      { token: [] },
      { password: "FIRST PRIVATE_SUFFIX", other: "visible" },
    ], null, "\t"));

    const sanitizedScalarArray = sanitizeHealthText(scalarArray, 1000, undefined, undefined, false);
    expect(sanitizedScalarArray).not.toContain("PRIVATE_SUFFIX");

    const sanitizedIndentedArray = sanitizeHealthText(indentedNestedArray, 1000, undefined, undefined, false);
    expect(sanitizedIndentedArray).not.toContain("FIRST");
    expect(sanitizedIndentedArray).not.toContain("PRIVATE_SUFFIX");
    expect(sanitizedIndentedArray).toContain("visible");
  });

  it("recognizes escaped whitespace around serialized field separators", () => {
    for (const input of [
      JSON.stringify('{"password"\n:"FIRST SECOND","other":"visible"}'),
      JSON.stringify('{"password":\n"FIRST SECOND","other":"visible"}'),
      JSON.stringify('{"token":null\n,"password":"FIRST SECOND","other":"visible"}'),
    ]) {
      const sanitized = sanitizeHealthText(input, 1000, undefined, undefined, false);
      expect(sanitized).not.toContain("SECOND");
      expect(sanitized).toContain("visible");
    }
  });

  it("redacts sensitive fields after serialized line breaks and in object key variants", () => {
    const inputs = [
      { input: JSON.stringify("line\npassword=hunter2"), secret: "hunter2" },
      { input: "{'previous':'visible','password':'a b','other':'visible'}", secret: "a b", sibling: "visible" },
      { input: '{password:"a b",other:"visible"}', secret: "a b", sibling: "visible" },
    ];
    for (const { input, secret, sibling } of inputs) {
      const sanitized = sanitizeHealthText(input, 1000, undefined, undefined, false);
      expect(sanitized).not.toContain(secret);
      if (sibling) expect(sanitized).toContain(sibling);
    }
  });

  it("continues scanning after scalar values in separate array objects", () => {
    for (const token of [null, true, false, 42, -1.5]) {
      const input = JSON.stringify([{ token }, { password: "correct horse battery", other: "visible" }]);
      for (const value of [input, JSON.stringify(input)]) {
        const sanitized = sanitizeHealthText(value, 1000, undefined, undefined, false);
        expect(sanitized).not.toContain("horse");
        expect(sanitized).not.toContain("battery");
        expect(sanitized).toContain("visible");
      }
    }
  });

  it("redacts case-insensitive and padded Token credentials", () => {
    const credential = "9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b";
    for (const scheme of ["token", "tOkEn", "Token"]) {
      for (const suffix of ["", "=", "==", ".~+/=="]) {
        expect(sanitizeHealthText(`${scheme} ${credential}${suffix}`, 1000, undefined, undefined, false))
          .not.toContain(credential);
      }
    }
  });

  it("preserves Basic prose while redacting Basic credentials", () => {
    expect(sanitizeHealthText("Basic configuration failed", 1000, undefined, undefined, false))
      .toBe("Basic configuration failed");
    const credential = Buffer.from("alice:synthetic-password").toString("base64");
    expect(sanitizeHealthText(`Basic ${credential}`, 1000, undefined, undefined, false)).not.toContain(credential);
  });

  it("redacts Basic credentials before log-wrapper punctuation", () => {
    for (const credential of ["YWxpY2U6c2VjcmV0", "YWxpY2U6c2VjcmV0IQ=="]) {
      for (const punctuation of [")", "]", "}", ",", ";", ":", "!", "?", "<", ">", "."]) {
        expect(sanitizeHealthText(`Received (Basic ${credential}${punctuation} visible`, 1000, undefined, undefined, false))
          .toBe(`Received (<redacted-authorization>${punctuation} visible`);
      }
    }
  });

  it("redacts Token credentials before log-wrapper punctuation", () => {
    for (const credential of ["9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b", "9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b=="]) {
      for (const punctuation of [")", "]", "}", ",", ";", ":", "!", "?", "<", ">"]) {
        expect(sanitizeHealthText(`Received (tOkEn ${credential}${punctuation} visible`, 1000, undefined, undefined, false))
          .toBe(`Received (Token <redacted>${punctuation} visible`);
      }
    }
  });

  it("preserves short field names outside SAS parameter contexts", () => {
    const ordinaryFields = "sv=version se=expiry sp=permissions sr=resource";

    expect(sanitizeHealthText(ordinaryFields, 1000, undefined, undefined, false)).toBe(ordinaryFields);
    expect(sanitizeHealthText('{"sp":"visible","sr":"visible"}', 1000, undefined, undefined, false))
      .toContain('"sp":"visible"');
    const sasParameters = sanitizeHealthText("?sv=PRIVATE_VERSION&se=PRIVATE_EXPIRY&sp=PRIVATE_PERMISSIONS&sr=PRIVATE_RESOURCE;sig=PRIVATE_SIGNATURE", 1000, undefined, undefined, false);
    expect(sasParameters).not.toContain("PRIVATE_");
    const signedUrl = sanitizeHealthText("https://acme.example/file?sp=PRIVATE_PERMISSIONS&sig=PRIVATE_SIGNATURE", 1000, undefined, undefined, false);
    expect(signedUrl).toContain("https://acme.example/file");
    expect(signedUrl).not.toContain("PRIVATE_");
  });

  it("redacts sensitive keys with environment, header, CLI, and camel-case prefixes", () => {
    const inputs = [
      ["GITHUB_TOKEN=SECRET_VALUE", "SECRET_VALUE"],
      ["AZURE_CLIENT_SECRET=SECRET_VALUE", "SECRET_VALUE"],
      ["--password=SECRET_VALUE", "SECRET_VALUE"],
      ["X-Auth-Token: SECRET_VALUE", "SECRET_VALUE"],
      ['{"accessToken":"SECRET_VALUE","apiKey":"OTHER_SECRET"}', "SECRET_VALUE"],
      ['{"accessToken":"SECRET_VALUE","apiKey":"OTHER_SECRET"}', "OTHER_SECRET"],
    ];
    for (const [input, secret] of inputs) {
      expect(sanitizeHealthText(input, 1000, undefined, undefined, false)).not.toContain(secret);
    }
  });

  it("redacts prefixed sensitive keys when they are quoted", () => {
    const sanitized = sanitizeHealthText(
      '{"GITHUB_TOKEN":"SECRET_VALUE","AZURE_CLIENT_SECRET":"OTHER_SECRET","dbPassword":"THIRD_SECRET","other":"visible"}',
      1000,
      undefined,
      undefined,
      false
    );

    expect(sanitized).not.toContain("SECRET_VALUE");
    expect(sanitized).not.toContain("OTHER_SECRET");
    expect(sanitized).not.toContain("THIRD_SECRET");
    expect(sanitized).toContain("visible");
  });

  it("preserves structured siblings after apostrophes and punctuation in prose", () => {
    const inputs = [
      `Can't parse ${JSON.stringify({ password: "FIRST PRIVATE_SUFFIX", other: "visible" })}`,
      `Unexpected token ":" in ${JSON.stringify({ password: "secret1", client_secret: "LEAKED_SECRET", other: "visible" })}`,
      `Expected "id=" in ${JSON.stringify({ password: "secret1", client_secret: "LEAKED_SECRET", other: "visible" })}`,
    ];

    for (const input of inputs) {
      const sanitized = sanitizeHealthText(input, 1000, undefined, undefined, false);
      expect(sanitized).not.toContain("PRIVATE_SUFFIX");
      expect(sanitized).not.toContain("LEAKED_SECRET");
      expect(sanitized).toContain("visible");
    }
  });

  it("preserves siblings in multiline serialized authorization and cookie values", () => {
    const inputs = [
      JSON.stringify({ message: "Authorization: Bearer secret1", other: "visible" }, null, 2),
      JSON.stringify({ message: "Cookie: session=secret", other: "visible" }, null, 2),
      JSON.stringify({ authorization: "Digest username=alice", other: "visible" }, null, 2),
    ];

    for (const input of inputs) {
      const sanitized = sanitizeHealthText(input, 1000, undefined, undefined, false);
      expect(sanitized).toContain("visible");
    }
  });

  it("redacts escaped quotes in secrets and home paths across platforms", () => {
    const sanitized = sanitizeHealthText(String.raw`{"password":"part1\"part2","url":"amqp://user:secret@broker.acme.example"} C:\Users\alice\work /Users/bob/work /home/carol/work C:/Users/dave/work`);
    expect(sanitized).not.toContain("part2");
    expect(sanitized).not.toContain("secret");
    expect(sanitized).not.toContain("alice");
    expect(sanitized).not.toContain("bob");
    expect(sanitized).not.toContain("carol");
    expect(sanitized).not.toContain("dave");
    expect(sanitizeHealthText(String.raw`C:\Users\Alice Smith\work`)).not.toContain("Alice Smith");
  });

  it("redacts escaped JSON values with delimiters and preserves neighboring secret fields", () => {
    const sanitized = sanitizeHealthText(String.raw`{"password":"part1,part2","client_secret":"secret2","other":"visible"}`);
    expect(sanitized).not.toContain("part1");
    expect(sanitized).not.toContain("part2");
    expect(sanitized).not.toContain("secret2");
    expect(sanitized).toContain("visible");
    expect(sanitizeHealthText(String.raw`{"Authorization":"Bearer secret1","password":"secret2"}`)).not.toContain("secret2");
    const wrapped = sanitizeHealthText('Received: "{\\"password\\":\\"secret\\",\\"other\\":\\"visible\\"}"');
    expect(wrapped).not.toContain("secret");
    expect(wrapped).toContain("visible");
    expect(sanitizeHealthText(String.raw`{"password":"part1\" part2","client_secret":"secret2"}`)).not.toContain("part2");
    expect(sanitizeHealthText(String.raw`{"password":"part1\"} part2","client_secret":"secret2"}`)).not.toContain("part2");
    const trailingSlash = sanitizeHealthText(String.raw`{"password":"ends\\","other":"visible"}`);
    expect(trailingSlash).not.toContain("ends");
    expect(trailingSlash).toContain("visible");
    expect(sanitizeHealthText(String.raw`Received: "{\"password\":\"part1\\\"} part2\",\"client_secret\":\"secret2\"}"`)).not.toContain("part2");
    expect(sanitizeHealthText(String.raw`{"password":"part1\\","other":"visible"}`)).toContain("visible");
    const nested = JSON.stringify(JSON.stringify({ password: 'part1"} part2', client_secret: "secret2", other: "visible" }));
    expect(sanitizeHealthText(nested)).not.toContain("part2");
    expect(sanitizeHealthText(nested)).not.toContain("secret2");
    expect(sanitizeHealthText(nested)).toContain("visible");
    const reviewRepro = JSON.stringify(JSON.stringify({ password: 'part1"},part2', other: "visible" }));
    expect(sanitizeHealthText(reviewRepro)).not.toContain("part2");
    expect(sanitizeHealthText(reviewRepro)).toContain("visible");
    const tripleEncoded = JSON.stringify(JSON.stringify(JSON.stringify({ password: "triple-secret", other: "visible" })));
    expect(sanitizeHealthText(tripleEncoded)).not.toContain("triple-secret");
  });

  it("sanitizes final signal kinds on non-recovered flaky tests", () => {
    const summary = aggregateHealth({ allTests: () => [{
      id: "flaky-final-sensitive-signal", titlePath: () => ["flaky-final-sensitive-signal"], outcome: () => "flaky", expectedStatus: "passed",
      results: [
        { status: "passed", annotations: [], errors: [] },
        { status: "failed", annotations: [
          { type: "env-signal:token=private" },
          { type: "env-signal:untrusted-kind" },
        ], errors: [] },
      ],
    }] } as unknown as Suite, compileCategories());
    const message = buildHealthMessage(summary, {
      sanitizeText: text => text.replace("untrusted-kind", "sanitized-kind"),
    }, { status: "failed", duration: 0, errors: [] });

    expect(message).not.toContain("token=private");
    expect(message).toContain("token: <redacted");
    expect(message).not.toContain("untrusted-kind");
    expect(message).toContain("sanitized-kind");
  });

  it("drops the optional results action before rejecting a minimum-budget summary", () => {
    const summary = {
      outcomes: { expected: 1, unexpected: 1, flaky: 1, skipped: 0 },
      assessments: { environment: 0, regression: 0, mixed: 0, undetermined: 0 },
      categories: [], noise: [], failures: [], unavailable: 1,
      passedWithSignals: 1, recoveredWithSignals: 1, flakyWithFinalSignals: 0,
      flakyFinalKinds: [], previousAttemptsWithSignals: 1,
    } as ReturnType<typeof aggregateHealth>;
    const message = buildHealthMessage(summary, {
      title: "😀".repeat(500),
      maxPayloadBytes: 4096,
      linkToResultsUrl: `https://a.co/${"x".repeat(1987)}`,
      linkToResultsText: "😀".repeat(100),
    }, { status: "passed", duration: 0, errors: [] });
    const card = JSON.parse(message).attachments[0].content;
    expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(4096);
    expect(card.actions).toEqual([]);
    expect(card.body.some((entry: { text: string }) => entry.text.includes("Final signal evidence unavailable"))).toBe(true);
    expect(card.body.some((entry: { text: string }) => entry.text.includes("Recovered flaky tests"))).toBe(true);
  });

  it("enforces the envelope byte limit when runner errors fill the detail section", () => {
    const summary = aggregateHealth({ allTests: () => [] } as unknown as Suite, compileCategories());
    const body = buildHealthMessage(summary, { maxPayloadBytes: 4096 }, {
      status: "failed", duration: 0, errors: Array.from({ length: 20 }, (_, index) => `Runner error ${index}: ${"x".repeat(300)}`),
    });
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(4096);
    expect(body).toContain("omitted");
  });

  it("sanitizes the entire assertion before extracting expected/received lines", () => {
    const suite = { allTests: () => [{
      id: "multiline", titlePath: () => ["multiline"], outcome: () => "unexpected",
      results: [{ status: "failed", annotations: [], errors: [{ message:
        `Expected: PRIVATE[${"x".repeat(200)}\n${"y".repeat(200)}]\nReceived: public` }] }],
    }] } as unknown as Suite;
    const summary = aggregateHealth(suite, compileCategories());
    const body = buildHealthMessage(summary, {
      sanitizeText: text => text.replace(/PRIVATE\[[\s\S]*?\]/g, "[redacted]"),
    }, { status: "failed", duration: 0, errors: [] });
    expect(body).not.toContain("PRIVATE[");
    expect(body).not.toContain("x".repeat(20));
    const entries = JSON.parse(body).attachments[0].content.body;
    expect(entries.find((entry: { text: string }) => entry.text.startsWith("Expected:")).text).toContain("redacted");
  });

  it("runs the custom sanitizer before clipping and applies it to action labels", () => {
    const sanitizer = (text: string) => text.replace(/PRIVATE\[[\s\S]*?\]/g, "[redacted]");
    const suite = { allTests: () => [{
      id: "test", titlePath: () => ["PRIVATE[" + "x".repeat(400) + "]"], outcome: () => "unexpected",
      results: [{ status: "failed", annotations: [], errors: [] }],
    }] } as unknown as Suite;
    const summary = aggregateHealth(suite, compileCategories());
    const body = buildHealthMessage(summary, {
      sanitizeText: sanitizer,
      linkToResultsText: "PRIVATE[action-label]",
      linkToResultsUrl: "https://reports.acme.example/run",
    }, { status: "failed", duration: 0, errors: [] });
    expect(body).not.toContain("PRIVATE[");
    const card = JSON.parse(body).attachments[0].content;
    expect(card.body[4].text).toBe("\\[redacted\\]");
    expect(card.actions[0].title).toBe("\\[redacted\\]");
  });

  it("escapes Markdown markers in test-controlled text", () => {
    const suite = { allTests: () => [{
      id: "markdown", titlePath: () => ["[click](https://evil.acme.example) **bold**"], outcome: () => "unexpected",
      results: [{ status: "failed", annotations: [], errors: [{ message: "Expected string: [click](https://evil.acme.example)" }] }],
    }] } as unknown as Suite;
    const summary = aggregateHealth(suite, compileCategories());
    const body = buildHealthMessage(summary, {}, { status: "failed", duration: 0, errors: [] });
    expect(body).not.toContain("[click](");
    expect(body).not.toContain("**bold**");
  });

  it("redacts credentials in webhook URLs embedded in paths", () => {
    const suite = { allTests: () => [{
      id: "webhook", titlePath: () => ["webhook"], outcome: () => "unexpected",
      results: [{ status: "failed", annotations: [], errors: [{ message:
        "Error posting https://tenant.webhook.office.com/webhookb2/tenant/IncomingWebhook/private-token/id" }] }],
    }] } as unknown as Suite, summary = aggregateHealth(suite, compileCategories());
    const body = buildHealthMessage(summary, {}, { status: "failed", duration: 0, errors: [] });
    expect(body).not.toContain("private-token");
  });

  it("renders previous-attempt evidence for a failed test with an interrupted final attempt", () => {
    const suite = { allTests: () => [{
      id: "interrupted", titlePath: () => ["interrupted"], outcome: () => "unexpected",
      results: [
        { status: "failed", annotations: [{ type: "env-signal:http-5xx" }], errors: [{ message: "HTTP 503" }] },
        { status: "interrupted", annotations: [], errors: [] },
      ],
    }] } as unknown as Suite;
    const summary = aggregateHealth(suite, compileCategories());
    const body = buildHealthMessage(summary, {}, { status: "interrupted", duration: 0, errors: [] });
    expect(summary.assessments.undetermined).toBe(1);
    expect(body).toContain("superseded-attempt signals: 1");
    expect(body).not.toContain("environment-suspect: 1");
  });

  it("reports generic timeout evidence as undetermined in the default taxonomy", () => {
    const suite = { allTests: () => [{
      id: "timeout", titlePath: () => ["timeout"], outcome: () => "unexpected",
      results: [{ status: "timedOut", annotations: [{ type: "env-signal:test-timeout" }], errors: [] }],
    }] } as unknown as Suite;
    const summary = aggregateHealth(suite, compileCategories());
    const body = buildHealthMessage(summary, {}, { status: "timedout", duration: 0, errors: [] });
    expect(summary.assessments.undetermined).toBe(1);
    expect(body).toContain("1 Cause undetermined / developer review");
  });

  it("renders assertion text as one wrapped ordinary entry and leaves summaries intact", () => {
    const suite = { allTests: () => [{
      id: "test", titlePath: () => ["ACME", "example"], outcome: () => "unexpected",
      results: [{ status: "failed", annotations: [], errors: [{ message: 'Error: mismatch\nExpected: "hello"\nReceived: "world"' }] }],
    }] } as unknown as Suite;
    const summary = aggregateHealth(suite, compileCategories());
    const envelope = JSON.parse(buildHealthMessage(summary, {}, { status: "failed", duration: 1200, errors: [] }));
    const card = envelope.attachments[0].content;
    expect(card.version).toBe("1.4");
    const errorEntry = card.body.find((entry: { text?: string }) => entry.text?.startsWith("Error:"));
    expect(errorEntry).toEqual(expect.objectContaining({ type: "TextBlock", wrap: true }));
    expect(errorEntry.text).toContain("Expected:");
    expect(errorEntry.text).toContain("Received:");
    expect(errorEntry.fontType).toBeUndefined();
    expect(summary.assessments.undetermined).toBe(1);
    expect(JSON.stringify(card)).toContain("Cause undetermined");
  });

  it("renders emoji headings, colors and a developer-review group", () => {
    const suite = { allTests: () => [
      { id: "a", titlePath: () => ["a"], outcome: () => "unexpected",
        results: [{ status: "failed", annotations: [{ type: "env-signal:net-fail" }], errors: [] }] },
      { id: "b", titlePath: () => ["b"], outcome: () => "unexpected",
        results: [{ status: "failed", annotations: [], errors: [] }] },
    ] } as unknown as Suite;
    const summary = aggregateHealth(suite, compileCategories());
    const body = JSON.parse(buildHealthMessage(summary, { environment: "QA" }, { status: "failed", duration: 74 * 60_000, errors: [] }))
      .attachments[0].content.body as { text: string; color?: string }[];
    expect(body[0].text).toBe("🩺 QA - Test Run Health");
    expect(body[1].text).toContain("⏱ 2 failed");
    expect(body[1].text).toContain("1h 14m");
    expect(body[2]).toEqual(expect.objectContaining({ color: "attention" }));
    expect(body.some(entry => entry.text.startsWith("📡 Backend and network: 1 failed tests"))).toBe(true);
    expect(body.find(entry => entry.text.startsWith("🤷"))).toEqual(
      expect.objectContaining({ text: "🤷 Developer review (no actionable environment signal): 1 failed tests", color: "attention" }));
  });

  it("places the developer-review heading only before uncategorized failures, within maxTests", () => {
    const suite = { allTests: () => [
      { id: "a", titlePath: () => ["signalled"], outcome: () => "unexpected",
        results: [{ status: "failed", annotations: [{ type: "env-signal:net-fail" }], errors: [] }] },
      { id: "b", titlePath: () => ["plain"], outcome: () => "unexpected",
        results: [{ status: "failed", annotations: [], errors: [] }] },
    ] } as unknown as Suite;
    const summary = aggregateHealth(suite, compileCategories());
    const context = { status: "failed" as const, duration: 0, errors: [] };
    const texts = (maxTests: number) => (JSON.parse(buildHealthMessage(summary, { maxTests }, context))
      .attachments[0].content.body as { text: string }[]).map(entry => entry.text);
    const both = texts(5);
    expect(both.findIndex(text => text === "signalled")).toBeLessThan(both.findIndex(text => text.startsWith("🤷")));
    expect(both.findIndex(text => text.startsWith("🤷"))).toBeLessThan(both.findIndex(text => text === "plain"));
    const capped = texts(1);
    expect(capped).toContain("signalled");
    expect(capped).not.toContain("plain");
    expect(capped.some(text => text.startsWith("🤷"))).toBe(true);
  });

  it("does not decorate custom category names that match Object prototype members", () => {
    const suite = { allTests: () => [{
      id: "a", titlePath: () => ["a"], outcome: () => "unexpected",
      results: [{ status: "failed", annotations: [{ type: "env-signal:custom" }], errors: [] }],
    }] } as unknown as Suite;
    const summary = aggregateHealth(suite, compileCategories([{ name: "constructor", kinds: ["custom"] }]));
    const texts = (JSON.parse(buildHealthMessage(summary, {}, { status: "failed", duration: 0, errors: [] }))
      .attachments[0].content.body as { text: string }[]).map(entry => entry.text);
    expect(texts).toContain("constructor: 1 failed tests");
  });

  it("renders a green no-failures line", () => {
    const summary = aggregateHealth({ allTests: () => [] } as unknown as Suite, compileCategories());
    const body = JSON.parse(buildHealthMessage(summary, {}, { status: "passed", duration: 0, errors: [] }))
      .attachments[0].content.body as { text: string; color?: string }[];
    expect(body[2]).toEqual(expect.objectContaining({ text: "✅ No failures.", color: "good" }));
  });

  it("renders Playwright value-only thrown errors", () => {
    const suite = { allTests: () => [{
      id: "value-error", titlePath: () => ["value-error"], outcome: () => "unexpected",
      results: [{ status: "failed", annotations: [], errors: [{ value: "backend unavailable" }] }],
    }] } as unknown as Suite;
    const summary = aggregateHealth(suite, compileCategories());
    const message = buildHealthMessage(summary, {}, { status: "failed", duration: 0, errors: [] });
    expect(message).toContain("backend unavailable");
  });

  it("enforces full-envelope UTF-8 limits and deterministically reports omitted details", () => {
    const suite = { allTests: () => Array.from({ length: 120 }, (_, index) => ({
      id: String(index), titlePath: () => ["\u00e9".repeat(200)], outcome: () => "unexpected",
      results: [{ status: "failed", annotations: [{ type: `env-signal:custom-${index}` }], errors: [] }],
    })) } as unknown as Suite;
    const summary = aggregateHealth(suite, compileCategories());
    const context = { status: "failed" as const, duration: 1000, errors: [] };
    const body = buildHealthMessage(summary, { maxPayloadBytes: 4096 }, context);
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(4096);
    expect(body).toContain("omitted");
    expect(body).toContain("120 failed");
    expect(buildHealthMessage(summary, { maxPayloadBytes: 4096 }, context)).toBe(body);
    expect(summary.outcomes.unexpected).toBe(120);
  });

  it("redacts configured destinations and strips signed results links by default", () => {
    const summary = aggregateHealth({ allTests: () => [] } as unknown as Suite, compileCategories());
    const webhookUrl = "https://acme.example/webhook?sig=secret";
    const body = buildHealthMessage(summary, {
      title: webhookUrl, linkToResultsUrl: "https://reports.acme.example/index.html?sig=private#fragment",
    }, { status: "failed", duration: 0, errors: [webhookUrl] }, webhookUrl);
    expect(body).not.toContain("sig=");
    expect(body).not.toContain("fragment");
    expect(JSON.parse(body).attachments[0].content.actions[0].url).toBe("https://reports.acme.example/index.html");
  });

  it("rejects results links that canonicalize to the configured webhook", () => {
    const summary = aggregateHealth({ allTests: () => [] } as unknown as Suite, compileCategories());
    const webhookUrl = "https://tenant.webhook.office.com:443/webhookb2/tenant/IncomingWebhook/private-token/id";
    const resultUrl = "https://TENANT.webhook.office.com/webhookb2/tenant/IncomingWebhook/private-token/id";
    const card = JSON.parse(buildHealthMessage(summary, { linkToResultsUrl: resultUrl }, {
      status: "failed", duration: 0, errors: [],
    }, webhookUrl)).attachments[0].content;
    expect(card.actions).toEqual([]);
  });
});