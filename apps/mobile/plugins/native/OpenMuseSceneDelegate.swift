import React
import UIKit

class OpenMuseSceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  private func applicationOptions(for context: UIOpenURLContext) -> [UIApplication.OpenURLOptionsKey: Any] {
    var options: [UIApplication.OpenURLOptionsKey: Any] = [
      .openInPlace: context.options.openInPlace,
    ]
    if let sourceApplication = context.options.sourceApplication {
      options[.sourceApplication] = sourceApplication
    }
    if let annotation = context.options.annotation {
      options[.annotation] = annotation
    }
    return options
  }

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
    guard let windowScene = scene as? UIWindowScene,
          let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }

    var launchOptions = appDelegate.initialLaunchOptions ?? [:]
    if let urlContext = connectionOptions.urlContexts.first {
      launchOptions[.url] = urlContext.url
    } else if let activity = connectionOptions.userActivities.first {
      launchOptions[.userActivityDictionary] = [
        UIApplication.LaunchOptionsKey.userActivityType.rawValue: activity.activityType,
        "UIApplicationLaunchOptionsUserActivityKey": activity,
      ]
    }

    let rootAlreadyMounted = appDelegate.hasReactNativeRoot
    let controller = appDelegate.ensureReactNativeRoot(launchOptions: launchOptions)
    let window = UIWindow(windowScene: windowScene)
    window.rootViewController = controller
    self.window = window
    appDelegate.window = window
    window.makeKeyAndVisible()

    // A background PushKit launch can mount React before a scene exists.
    // Cold links use launchOptions; warm links also emit React Native events.
    for context in connectionOptions.urlContexts {
      appDelegate.forwardSceneURL(context.url, options: applicationOptions(for: context), rootAlreadyMounted: rootAlreadyMounted)
    }
    for activity in connectionOptions.userActivities {
      appDelegate.forwardSceneUserActivity(activity, rootAlreadyMounted: rootAlreadyMounted)
    }
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
    for context in URLContexts {
      appDelegate.forwardSceneURL(context.url, options: applicationOptions(for: context), rootAlreadyMounted: true)
    }
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
    appDelegate.forwardSceneUserActivity(userActivity, rootAlreadyMounted: true)
  }

  func sceneDidBecomeActive(_ scene: UIScene) {
    (UIApplication.shared.delegate as? AppDelegate)?.applicationDidBecomeActive(UIApplication.shared)
  }

  func sceneWillResignActive(_ scene: UIScene) {
    (UIApplication.shared.delegate as? AppDelegate)?.applicationWillResignActive(UIApplication.shared)
  }

  func sceneWillEnterForeground(_ scene: UIScene) {
    (UIApplication.shared.delegate as? AppDelegate)?.applicationWillEnterForeground(UIApplication.shared)
  }

  func sceneDidEnterBackground(_ scene: UIScene) {
    (UIApplication.shared.delegate as? AppDelegate)?.applicationDidEnterBackground(UIApplication.shared)
  }

  func sceneDidDisconnect(_ scene: UIScene) {
    (UIApplication.shared.delegate as? AppDelegate)?.window = nil
    window = nil
  }
}
