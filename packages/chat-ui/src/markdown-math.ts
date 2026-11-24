import type { CompileContext, Extension as MarkdownExtension } from "mdast-util-from-markdown";
import type { Code, Extension, State, Token } from "micromark-util-types";
import type { Plugin } from "unified";
import type { HastNode } from "./table-utils";

declare module "micromark-util-types" {
  interface TokenTypeMap {
    chatInlineMath: "chatInlineMath";
    chatDisplayMath: "chatDisplayMath";
  }
}

const dollar = 36;
const backslash = 92;
const openParen = 40;
const closeParen = 41;
const openBracket = 91;
const closeBracket = 93;

function space(code: Code) {
  return code === null || code < 0 || code === 32;
}

const tokenizer: Extension = {
  text: {
    [dollar]: {
      previous: (code) => code !== dollar,
      tokenize(effects, ok, nok) {
        let previous: Code;
        return (code) => {
          effects.enter("chatInlineMath");
          effects.consume(code);
          return first;
        };

        // Spaces directly inside the delimiters and digits after the closing
        // dollar are excluded so prices such as "$5 and $10" stay ordinary text.
        function first(code: Code) {
          if (space(code) || code === dollar) return nok(code);
          return body(code);
        }

        function body(code: Code): State | undefined {
          if (code === null || code < 0) return nok(code);
          if (code === dollar) {
            if (space(previous)) return nok(code);
            effects.consume(code);
            return after;
          }
          previous = code;
          effects.consume(code);
          return code === backslash ? escaped : body;
        }

        function escaped(code: Code): State | undefined {
          if (code !== dollar && code !== backslash) return body(code);
          previous = code;
          effects.consume(code);
          return body;
        }

        function after(code: Code) {
          if (code === dollar || (code !== null && code >= 48 && code <= 57)) return nok(code);
          effects.exit("chatInlineMath");
          return ok(code);
        }
      },
    },
    [backslash]: {
      tokenize(effects, ok, nok) {
        let open: number;
        let close: number;
        let token: "chatInlineMath" | "chatDisplayMath";
        return (code) => {
          // Include the backslash in the token so the raw text can be recovered.
          const opener = effects.enter("chatInlineMath");
          effects.consume(code);
          return (code) => {
            if (code !== openParen && code !== openBracket) return nok(code);
            open = code;
            close = code === openParen ? closeParen : closeBracket;
            token = code === openParen ? "chatInlineMath" : "chatDisplayMath";
            opener.type = token;
            effects.consume(code);
            return body;
          };
        };

        function body(code: Code) {
          if (code === null) return nok(code);
          effects.consume(code);
          return code === backslash ? escaped : body;
        }

        function escaped(code: Code): State | undefined {
          if (code === close) {
            effects.consume(code);
            effects.exit(token);
            return ok;
          }
          // A new opener of the same kind supersedes an unmatched one.
          if (code === open) return nok(code);
          if (code !== backslash) return body(code);
          effects.consume(code);
          return body;
        }
      },
    },
  },
};

const fromMarkdown: MarkdownExtension = {
  exit: {
    chatInlineMath: writeMath,
    chatDisplayMath: writeMath,
  },
};

function writeMath(this: CompileContext, token: Token) {
  const source = this.sliceSerialize(token);
  const delimiterLength = source.startsWith("$") ? 1 : 2;
  const value = source.slice(delimiterLength, -delimiterLength);
  this.enter(
    {
      type: "inlineCode",
      value,
      data: {
        hName: "span",
        hProperties: {
          "data-math": token.type === "chatDisplayMath" ? "block" : "inline",
          "data-math-source": source,
        },
      },
    },
    token,
  );
  this.exit(token);
}

export const remarkChatMath: Plugin = function () {
  const data = this.data();
  data.micromarkExtensions ??= [];
  data.fromMarkdownExtensions ??= [];
  data.micromarkExtensions.push(tokenizer);
  data.fromMarkdownExtensions.push(fromMarkdown);
};

// remark-math handles double-dollar fences, including ones in lists and quotes.
// A fence ending at EOF can be incomplete, which should stay visible as source.
export function rehypeDisplayMath() {
  return (tree: HastNode, file: { value: unknown }) => {
    const source = String(file.value);
    function walk(node: HastNode) {
      const code = node.tagName === "pre" ? node.children?.[0] : node;
      const classes = code?.properties?.className;
      if (
        Array.isArray(classes) &&
        (classes.includes("math-display") || classes.includes("math-inline"))
      ) {
        const start = node.position?.start?.offset;
        const end = node.position?.end?.offset;
        const raw = start === undefined || end === undefined ? "" : source.slice(start, end);
        if (node.tagName === "pre") {
          const opening = raw.match(/^\$+/)?.[0].length ?? 0;
          const closing = raw.match(/\n[\t >]*(\$+)[\t ]*$/)?.[1]?.length ?? 0;
          if (closing < opening || !opening) {
            Object.assign(node, { type: "text", value: raw });
            return;
          }
        }
        node.tagName = "span";
        node.properties = { "data-math": "block", "data-math-source": raw };
        node.children = code?.children;
        return;
      }
      node.children?.forEach(walk);
    }
    walk(tree);
  };
}
