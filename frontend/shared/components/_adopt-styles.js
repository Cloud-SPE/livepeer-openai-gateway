/**
 * Idempotent adoptedStyleSheets injector. Light-DOM Lit components don't get
 * `static styles` — call adoptStyles(tagName, cssText) once per tag (the
 * registry below dedupes) to inject into the document.
 */

const adopted = new Set();

/**
 * @param {string} tagName  unique key, usually the custom-element tag
 * @param {string} cssText
 */
export function adoptStyles(tagName, cssText) {
  if (adopted.has(tagName)) return;
  adopted.add(tagName);
  if (typeof document === 'undefined') return;
  const supportsConstructable = 'adoptedStyleSheets' in Document.prototype;
  if (supportsConstructable) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(cssText);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    return;
  }
  // Fallback: inject a <style> element.
  const style = document.createElement('style');
  style.dataset.bridge = tagName;
  style.textContent = cssText;
  document.head.appendChild(style);
}
