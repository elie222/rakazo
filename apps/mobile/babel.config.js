// SDK 58's Hermes rejects async arrows whose rest parameter is a destructuring pattern
// (`async (...[a, b]) => {}`), which `@orpc/client` and lib/api.ts ship, and babel-preset-expo
// 58.0.18 stopped rewriting them, so only bytecode (release) builds fail.
// Remove this plugin once https://github.com/expo/expo/issues/52983 is fixed.
function asyncArrowRestPattern({ types: t }) {
  return {
    name: "async-arrow-rest-pattern",
    visitor: {
      ArrowFunctionExpression(path) {
        const { node } = path;
        const rest = node.params.at(-1);
        if (!node.async || !t.isRestElement(rest) || t.isIdentifier(rest.argument)) return;
        const args = path.scope.generateUidIdentifier("args");
        const pattern = rest.argument;
        rest.argument = args;
        const body = t.isBlockStatement(node.body)
          ? node.body
          : t.blockStatement([t.returnStatement(node.body)]);
        body.body.unshift(
          t.variableDeclaration("var", [t.variableDeclarator(pattern, t.cloneNode(args))]),
        );
        node.body = body;
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
  return { presets: [preset], plugins: [asyncArrowRestPattern] };
};
