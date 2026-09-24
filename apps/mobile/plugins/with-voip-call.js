const { withEntitlementsPlist, withInfoPlist, withPodfile } = require("expo/config-plugins");

module.exports = function withVoipCall(config, options = {}) {
  const environment = process.env.EXPO_APNS_ENVIRONMENT || options.apnsEnvironment || "development";
  if (!["development", "production"].includes(environment)) {
    throw new Error("with-voip-call: apnsEnvironment must be development or production");
  }
  config = withInfoPlist(config, (value) => {
    const info = value.modResults;
    info.NSMicrophoneUsageDescription =
      info.NSMicrophoneUsageDescription || "Talk with your OpenMuse assistant.";
    info.UIBackgroundModes = [
      ...new Set([...(info.UIBackgroundModes || []), "audio", "voip", "remote-notification"]),
    ];
    return value;
  });
  config = withEntitlementsPlist(config, (value) => {
    value.modResults["aps-environment"] = environment;
    return value;
  });
  // Xcode 27 rejects older resource-pod deployment targets in OpenMuse's RN dependencies.
  return withPodfile(config, (value) => {
    if (!value.modResults.contents.includes("# OpenMuse minimum iOS deployment target")) {
      value.modResults.contents = value.modResults.contents.replace(
        / {2}post_install do \|installer\|/,
        `  post_install do |installer|\n    # OpenMuse minimum iOS deployment target\n    installer.pods_project.targets.each do |target|\n      target.build_configurations.each do |build|\n        build.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '15.1'\n      end\n    end`,
      );
    }
    return value;
  });
};
