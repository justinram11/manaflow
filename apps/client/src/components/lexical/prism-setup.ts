// This file must be imported BEFORE any @lexical/code imports
// to ensure Prism is available globally for syntax highlighting
import Prism from "prismjs";

// @lexical/code expects Prism to be available globally
if (typeof globalThis !== "undefined") {
  (globalThis as typeof globalThis & { Prism?: typeof Prism }).Prism = Prism;
}
if (typeof window !== "undefined") {
  (window as typeof window & { Prism?: typeof Prism }).Prism = Prism;
}

export { Prism };
