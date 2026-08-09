/** Strip // and block comments so tsconfig.json (JSONC) can be JSON.parse'd. */
export function stripJsoncComments(text: string): string {
  let result = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      const start = i;
      i++;
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      result += text.slice(start, i);
      continue;
    }

    if (text[i] === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        i++;
      }
      continue;
    }

    if (text[i] === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        i++;
      }
      i += 2;
      continue;
    }

    result += text[i];
    i++;
  }
  return result;
}

export function parseJsonc<T>(text: string): T {
  return JSON.parse(stripJsoncComments(text)) as T;
}
