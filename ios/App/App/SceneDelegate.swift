import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = FitFlowBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func sceneWillResignActive(_ scene: UIScene) {
        (window?.rootViewController as? FitFlowBridgeViewController)?.invalidateNativeAccountContext()
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        (window?.rootViewController as? FitFlowBridgeViewController)?.invalidateNativeAccountContext()
    }

    func sceneDidDisconnect(_ scene: UIScene) {
        (window?.rootViewController as? FitFlowBridgeViewController)?.invalidateNativeAccountContext()
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
