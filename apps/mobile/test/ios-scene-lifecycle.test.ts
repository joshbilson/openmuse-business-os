import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { transformAppDelegate } = require("../plugins/with-ios-scene-lifecycle.js") as {
  transformAppDelegate: (source: string) => string;
};

const expoAppDelegate = `
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    bindReactNativeFactory(factory)

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // Linking API
`;

test("scene migration keeps Expo launch subscribers and creates one retained React root", () => {
  const result = transformAppDelegate(expoAppDelegate);
  assert.match(
    result,
    /let didFinish = super\.application\(application, didFinishLaunchingWithOptions: launchOptions\)/,
  );
  assert.match(result, /scheduleHeadlessStart\(\)/);
  assert.match(result, /if let reactNativeRootController \{ return reactNativeRootController \}/);
  assert.match(result, /factory\.rootViewFactory\.view\(/);
  assert.match(result, /forwardSceneURL/);
  assert.match(result, /forwardSceneUserActivity/);
  assert.doesNotMatch(result, /UIWindow\(frame: UIScreen\.main\.bounds\)/);
  assert.equal(transformAppDelegate(result), result);
});

test("scene migration fails loudly when the upstream AppDelegate startup shape changes", () => {
  assert.throws(
    () =>
      transformAppDelegate(expoAppDelegate.replace("factory.startReactNative(", "factory.launch(")),
    /template changed/,
  );
});
