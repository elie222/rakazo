const { withPodfile } = require("expo/config-plugins");

const SEARCH_PATH = "$(PODS_ROOT)/RNWorklets/Common/cpp";
const MARKER = "RNWorklets/Common/cpp";

const HOOK = `
    installer.pods_project.targets.each do |target|
      next unless %w[RNReanimated RNWorklets].include?(target.name)
      target.build_configurations.each do |bc|
        extra = "${SEARCH_PATH}"
        quoted = "\\"#{extra}\\""
        paths = bc.build_settings["HEADER_SEARCH_PATHS"]
        if paths.nil? || paths == ""
          bc.build_settings["HEADER_SEARCH_PATHS"] = ["$(inherited)", quoted]
        elsif paths.is_a?(Array)
          unless paths.include?(quoted) || paths.include?(extra)
            bc.build_settings["HEADER_SEARCH_PATHS"] = paths + [quoted]
          end
        else
          unless paths.to_s.include?(extra)
            bc.build_settings["HEADER_SEARCH_PATHS"] = "#{paths} #{quoted}"
          end
        end
      end
    end
`;

/**
 * RNReanimated 4.5 includes <worklets/Compat/StableApi.h>. CocoaPods header
 * maps drop that nested path in Expo's static-framework iOS prebuild, so a
 * Release compile fails unless dependents also search the Worklets C++ root.
 */
function withWorkletsHeaders(config) {
  return withPodfile(config, (config) => {
    const contents = config.modResults.contents;
    if (contents.includes(MARKER)) {
      return config;
    }

    if (contents.includes("post_install do |installer|")) {
      config.modResults.contents = contents.replace(
        "post_install do |installer|",
        `post_install do |installer|${HOOK}`,
      );
      return config;
    }

    config.modResults.contents = `${contents}\npost_install do |installer|${HOOK}end\n`;
    return config;
  });
}

module.exports = withWorkletsHeaders;
