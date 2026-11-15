// SDK 58's Hermes rejects async arrows whose rest parameter is a destructuring pattern
// (`async (...[a, b]) => {}`), which `@orpc/client` and lib/api.ts ship, and babel-preset-expo
// 58.0.18 stopped rewriting them, so only bytecode (release) builds fail.
// Remove this plugin once https://github.com/expo/expo/issues/52983 is fixed.
//
// Defaults must keep running in the parameter scope, where they cannot see body declarations
// and keep their temporal dead zone. An array pattern therefore becomes ordinary parameters:
// `async (a, ...[b, c = 1]) =>` is `async (a, b, c = 1) =>`, which only changes the arrow's
// `length`. Any other pattern moves into the parameter of an inner async arrow.
function asyncArrowRestPattern({ types: t }) {
  // The pattern's elements as parameters, or null when a nested rest is not an array pattern.
  function spread(pattern, scope) {
    const params = [];
    for (const element of pattern.elements) {
      if (element === null) params.push(scope.generateUidIdentifier("hole"));
      else if (!t.isRestElement(element) || t.isIdentifier(element.argument)) params.push(element);
      else if (t.isArrayPattern(element.argument)) {
        const nested = spread(element.argument, scope);
        if (!nested) return null;
        params.push(...nested);
      } else return null;
    }
    return params;
  }

  return {
    name: "async-arrow-rest-pattern",
    visitor: {
      ArrowFunctionExpression(path) {
        const { node } = path;
        const rest = node.params.at(-1);
        if (!node.async || !t.isRestElement(rest) || t.isIdentifier(rest.argument)) return;
        const pattern = rest.argument;
        const params = t.isArrayPattern(pattern) ? spread(pattern, path.scope) : null;
        if (params) {
          node.params = [...node.params.slice(0, -1), ...params];
          return;
        }
        const args = path.scope.generateUidIdentifier("args");
        rest.argument = args;
        node.body = t.callExpression(t.arrowFunctionExpression([pattern], node.body, true), [
          t.cloneNode(args),
        ]);
      },
    },
  };
}

// The preset is Expo's own dependency; resolving it through `expo` keeps the version it pins.
const preset = require.resolve("babel-preset-expo", {
  paths: [require.resolve("expo/package.json")],
});

module.exports = (api) => {
  api.cache(true);
  return {
    presets: [preset],
    plugins: [
      asyncArrowRestPattern,
      // Release builds keep each string's English text, so a string the catalogs do not list yet
      // shows in English instead of its id.
      ["@lingui/babel-plugin-lingui-macro", { descriptorFields: "message" }],
    ],
  };
};
