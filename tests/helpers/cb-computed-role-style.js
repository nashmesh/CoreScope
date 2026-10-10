'use strict';

// These VM tests have no CSS engine. Read the shipped preset declaration,
// rather than pretending a removed root inline override is the whole cascade.
module.exports = function computedRoleStyle(root, body, css) {
  return function getComputedStyle(element) {
    return {
      getPropertyValue(property) {
        if (element === body) {
          const inline = body.style.getPropertyValue(property);
          if (inline) return inline;
          const preset = body.getAttribute('data-cb-preset');
          if (preset && /^[a-z0-9-]+$/.test(preset)) {
            const selector = 'body[data-cb-preset="' + preset + '"]';
            const start = css.indexOf(selector + ' {');
            if (start >= 0) {
              const block = css.slice(start, css.indexOf('}', start));
              const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const declaration = block.match(new RegExp(escaped + ':\\s*([^;]+);'));
              if (declaration) return declaration[1].trim();
            }
          }
        }
        return root.style.getPropertyValue(property);
      }
    };
  };
};
