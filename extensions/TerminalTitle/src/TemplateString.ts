/*
 * Copyright 2019 Simon Edwards <simon@simonzone.com>
 *
 * This source code is licensed under the MIT license which is detailed in the LICENSE.txt file.
 */
import he = require("he");


export interface TextSegment {
  type: "text";
  text: string;

  startColumn: number;
  endColumn: number;
}

export interface FieldSegment {
  type: "field";
  namespace: string;
  key: string;

  startColumn: number;
  endColumn: number;
}

export interface ErrorSegment {
  type: "error";
  text: string;
  error: string;

  startColumn: number;
  endColumn: number;
}

export type Segment = TextSegment | FieldSegment | ErrorSegment;

export interface FieldFormatter {
  formatHtml(key: string): string;
  getErrorMessage(key: string): string;
}

export class TemplateString {

  private _template: string = null;
  _segments: Segment[] = null;

  private _formatterMap = new Map<string, FieldFormatter>();

  getTemplateString(): string {
    return this._template;
  }
  
  setTemplateString(template: string): void {
    this._template = template;
    this._segments = this._parse(template);
  }

  addFormatter(namespace: string, formatter: FieldFormatter): void {
    this._formatterMap.set(namespace.toLowerCase(), formatter);
  }

  private _tokenIndex = 0;
  private _tokens: Token[];
  
  private _parse(template: string): Segment[] {
    this._tokens = lex(template);
    this._tokenIndex = 0;

    let result: Segment[] = [];
    while (this._peekTokenType() !== TokenType.EOF) {
      result = [...result, ...this._processTextStateTokens()];
      result = [...result, ...this._processFieldStateTokens()];
    }

    // Correct the start and end column info.
    let i = 0;
    for (const segment of result) {
      segment.startColumn = i;
      i += segment.endColumn;
      segment.endColumn = i;
    }

    return result;
  }

  private _peekTokenType(): TokenType {
    return this._tokens.length === this._tokenIndex ? TokenType.EOF : this._tokens[this._tokenIndex].type;
  }

  private _takeToken(): Token {
    this._tokenIndex++;
    return this._tokens[this._tokenIndex-1];
  }

  private _processTextStateTokens(): Segment[] {
    const textTokens = [TokenType.STRING, TokenType.ESCAPE_DOLLAR];

    let textSegment: TextSegment = { text: "", type: "text", startColumn: 0, endColumn: 0 };

    while (textTokens.indexOf(this._peekTokenType()) !== -1) {
      const token = this._takeToken();
      if (token.type === TokenType.STRING) {
        textSegment.text += token.text;
        textSegment.endColumn += token.text.length;
      } else if (token.type === TokenType.ESCAPE_DOLLAR) {
        textSegment.text += "$";
        textSegment.endColumn += 2;
      }
    }

    return textSegment.text.length !== 0 ? [textSegment] : [];
  }

  private _processFieldStateTokens(): Segment[] {
    if (this._peekTokenType() === TokenType.EOF) {
      return [];
    }

    if (this._checkFieldTokens()) {
      return [this._processCompleteField()];
    } else {
      return [this._processBadField()];
    }
  }

  private _checkFieldTokens(): boolean {
    const fieldTokenTypeList = [
      TokenType.OPEN_BRACKET,
      TokenType.SYMBOL,
      TokenType.COLON,
      TokenType.SYMBOL,
      TokenType.CLOSE_BRACKET
    ];

    const startIndex = this._tokenIndex;
    let pass = true;
    for (const type of fieldTokenTypeList) {
      if (this._peekTokenType() !== type) {
        pass = false;
        break;
      }
      this._takeToken();
    }
    this._tokenIndex = startIndex;
    return pass;
  }

  private _processCompleteField(): Segment {
    this._takeToken();                        // TokenType.OPEN_BRACKET
    const namespace = this._takeToken().text; // TokenType.SYMBOL
    this._takeToken();                        // TokenType.COLON
    const key = this._takeToken().text;       // TokenType.SYMBOL
    this._takeToken();                        // TokenType.CLOSE_BRACKET
    const fieldSegment: FieldSegment = {
      type: "field",
      namespace: namespace,
      key: key,
      startColumn: 0,
      endColumn: 2 + namespace.length + 1 + key.length + 1
    };
    return fieldSegment;
  }

  private _processBadField(): Segment {
    const nonFieldTypes = [TokenType.STRING, TokenType.ESCAPE_DOLLAR, TokenType.EOF];

    let badInput = "";
    while (nonFieldTypes.indexOf(this._peekTokenType()) === -1) {
      const token = this._takeToken();
      badInput += token.text;
    }
    const errorSegment: ErrorSegment = {
      type: "error",
      text: badInput,
      startColumn: 0,
      endColumn: badInput.length,
      error: ""
    };
    return errorSegment;
  }

  formatHtml(): string {
    return this._segments.map(segment => {
      switch (segment.type) {
        case "text":
          return he.encode(segment.text);
        case "field":
          const namespace = segment.namespace.toLowerCase();
          const formatter = this._formatterMap.get(namespace);
          if (formatter == null) {
            return "";
          }
          return formatter.formatHtml(segment.key);
        case "error":
          return "";
      }      
    }).join("");
  }

  formatDiagnosticHtml(): string {
    return this._segments.map(segment => {
      switch (segment.type) {
        case "text":
          return `<span class="segment_text">${he.encode(segment.text)}</span>`;

        case "field":
          const namespace = segment.namespace.toLowerCase();
          const formatter = this._formatterMap.get(namespace);
          if (formatter == null) {
            return `<span class="segment_error">Unknown '${segment.namespace}'</span>`;
          }
          const errorMsg = formatter.getErrorMessage(segment.key);
          if (errorMsg == null) {
            return `<span class="segment_field">${formatter.formatHtml(segment.key)}</span>`;
          } else {
            return `<span class="segment_error">${errorMsg}</span>`;
          }

        case "error":
          return `<span class="segment_error">Unknown '${segment.text}'</span>`;
      }      
    }).join("");
  }
}


enum LexerState {
  NORMAL = "NORMAL",
  FIELD = "FIELD",
}

enum TokenType {
  STRING,
  ESCAPE_DOLLAR,
  OPEN_BRACKET,
  SYMBOL,
  COLON,
  CLOSE_BRACKET,
  EOF
}

interface Token {
  type: TokenType;
  text: string;
}

interface LexMatcher {
  match: RegExp;
  type: TokenType;
  newState: LexerState;
}

const NormalParseRules: LexMatcher[] = [
  { match: new RegExp("^[$][{]"), type: TokenType.OPEN_BRACKET, newState: LexerState.FIELD },
  { match: new RegExp("^[\\\\][$]"), type: TokenType.ESCAPE_DOLLAR, newState: LexerState.NORMAL },
  { match: new RegExp("^[^$\\\\]+"), type: TokenType.STRING, newState: LexerState.NORMAL },
  { match: new RegExp("^[$]"), type: TokenType.STRING, newState: LexerState.NORMAL },
  { match: new RegExp("^[\\\\]"), type: TokenType.STRING, newState: LexerState.NORMAL },
];

const FieldParseRules: LexMatcher[] = [
  { match: new RegExp("^[^:}]+"), type:TokenType.SYMBOL, newState: LexerState.FIELD },
  { match: new RegExp("^:"), type: TokenType.COLON, newState: LexerState.FIELD },
  { match: new RegExp("^}"), type: TokenType.CLOSE_BRACKET, newState: LexerState.NORMAL }
];

const LexerStateRules: { [key: string]: LexMatcher[]; } = {
  [LexerState.NORMAL]: NormalParseRules,
  [LexerState.FIELD]: FieldParseRules,
}

function lex(input: string): Token[] {
  const result: Token[] = [];
  let currentInput = input;
  let state = LexerState.NORMAL;

  while (currentInput.length !== 0) {
    let didMatch = false;
    for (const rule of LexerStateRules[state]) {
      const matchResult = currentInput.match(rule.match);
      if (matchResult != null) {
        result.push( { type: rule.type, text: matchResult[0] } );
        currentInput = currentInput.slice(matchResult[0].length);
        state = rule.newState;
        didMatch = true;
        break;
      }
    }
    if ( ! didMatch) {
      throw "Unable to parse!";
    }
  }

  return result;
}
