const lingui = require("@lingui/metro-transformer/expo");

const upstream = require(process.env.RAKAZO_UPSTREAM_BABEL_TRANSFORMER);

module.exports = {
  ...upstream,
  transform: (params) =>
    params.filename.endsWith(".po") ? lingui.transform(params) : upstream.transform(params),
};
