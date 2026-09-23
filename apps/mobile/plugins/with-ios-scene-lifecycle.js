const fs = require("node:fs");
const path = require("node:path");
const {
  IOSConfig,
  withAppDelegate,
  withDangerousMod,
  withInfoPlist,
  withXcodeProject,
} = require("expo/config-plugins");

const sceneFile = "OpenMuseSceneDelegate.swift";
const sceneMarker = "// OpenMuse iOS 27 scene lifecycle";

function transformAppDelegate(source) {
  if (source.includes(sceneMarker)) return source;

  const properties = "  var reactNativeFactory: RCTReactNativeFactory?\n";
  const startup =
    /#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\([\s\S]*?launchOptions: launchOptions\)\n#endif\n\n\s*return super\.application\(application, didFinishLaunchingWithOptions: launchOptions\)/;
  const linking = "  // Linking API";
  if (!source.includes(properties) || !startup.test(source) || !source.includes(linking)) {
    throw new Error(
      "with-ios-scene-lifecycle: Expo AppDelegate template changed; review migration",
    );
  }

  source = source.replace(
    properties,
    `${properties}\n  ${sceneMarker}\n  var initialLaunchOptions: [UIApplication.LaunchOptionsKey: Any]?\n  private var reactNativeRootController: UIViewController?\n\n  var hasReactNativeRoot: Bool { reactNativeRootController != nil }\n\n  func ensureReactNativeRoot(launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> UIViewController {\n    if let reactNativeRootController { return reactNativeRootController }\n    guard let factory = reactNativeFactory, let delegate = reactNativeDelegate else {\n      fatalError("OpenMuse React Native factory is not ready")\n    }\n    let rootView = factory.rootViewFactory.view(\n      withModuleName: "main",\n      initialProperties: nil,\n      launchOptions: launchOptions)\n    let controller = delegate.createRootViewController()\n    delegate.setRootView(rootView, toRootViewController: controller)\n    reactNativeRootController = controller\n    return controller\n  }\n\n  private func scheduleHeadlessStart() {\n    // PushKit can launch the app without a UIWindowScene. Mount one React root so\n    // the queued CallKit answer event can reach JavaScript before its watchdog.\n    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in\n      guard let self, !self.hasReactNativeRoot, UIApplication.shared.connectedScenes.isEmpty else { return }\n      _ = self.ensureReactNativeRoot(launchOptions: self.initialLaunchOptions)\n    }\n  }\n`,
  );
  source = source.replace(
    startup,
    `    initialLaunchOptions = launchOptions\n    // ExpoAppDelegate subscribers still start PushKit and handle APNs at launch.\n    let didFinish = super.application(application, didFinishLaunchingWithOptions: launchOptions)\n    scheduleHeadlessStart()\n    return didFinish`,
  );
  source = source.replace(
    linking,
    `  // Cold scene links enter React through launchOptions. Expo subscribers still\n  // receive the link; warm links also notify React Native's event listener.\n  func forwardSceneURL(_ url: URL, options: [UIApplication.OpenURLOptionsKey: Any], rootAlreadyMounted: Bool) {\n    if rootAlreadyMounted {\n      _ = application(UIApplication.shared, open: url, options: options)\n    } else {\n      _ = super.application(UIApplication.shared, open: url, options: options)\n    }\n  }\n\n  func forwardSceneUserActivity(_ userActivity: NSUserActivity, rootAlreadyMounted: Bool) {\n    let restore: ([UIUserActivityRestoring]?) -> Void = { _ in }\n    if rootAlreadyMounted {\n      _ = application(UIApplication.shared, continue: userActivity, restorationHandler: restore)\n    } else {\n      _ = super.application(UIApplication.shared, continue: userActivity, restorationHandler: restore)\n    }\n  }\n\n${linking}`,
  );
  return source;
}

module.exports = function withIOSSceneLifecycle(config) {
  config = withInfoPlist(config, (value) => {
    value.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "OpenMuse Default Scene",
            UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).OpenMuseSceneDelegate",
          },
        ],
      },
    };
    return value;
  });

  config = withAppDelegate(config, (value) => {
    if (value.modResults.language !== "swift") {
      throw new Error("with-ios-scene-lifecycle: expected Swift AppDelegate");
    }
    value.modResults.contents = transformAppDelegate(value.modResults.contents);
    return value;
  });

  config = withDangerousMod(config, [
    "ios",
    async (value) => {
      const destination = path.join(
        value.modRequest.platformProjectRoot,
        value.modRequest.projectName,
        sceneFile,
      );
      const template = path.join(__dirname, "native", sceneFile);
      fs.copyFileSync(template, destination);
      return value;
    },
  ]);

  return withXcodeProject(config, (value) => {
    IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
      filepath: `${value.modRequest.projectName}/${sceneFile}`,
      groupName: value.modRequest.projectName,
      project: value.modResults,
    });
    return value;
  });
};

module.exports.transformAppDelegate = transformAppDelegate;
