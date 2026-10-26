// Verification aid: evaluate navigator.registerProtocolHandler availability in the SYSTEM WebKit (the engine Safari 27.x on this Mac uses).
// No network: loadHTMLString with a secure https baseURL. Prints one JSON line and exits.
import Cocoa
import WebKit

final class Delegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var web: WKWebView!
    var timeout: DispatchWorkItem?
    func applicationDidFinishLaunching(_ n: Notification) {
        let cfg = WKWebViewConfiguration()
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 320, height: 240), configuration: cfg)
        web.navigationDelegate = self
        web.loadHTMLString("<!doctype html><meta charset=utf-8><title>wk</title><body>wk</body>", baseURL: URL(string: "https://example.com/")!)
        let t = DispatchWorkItem { print("{\"error\":\"timeout\"}"); NSApp.terminate(nil) }
        timeout = t
        DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: t)
    }
    func webView(_ w: WKWebView, didFinish navigation: WKNavigation!) {
        let js = """
        JSON.stringify({
          href: location.href,
          isSecureContext: isSecureContext,
          typeofRegister: typeof navigator.registerProtocolHandler,
          typeofUnregister: typeof navigator.unregisterProtocolHandler,
          typeofRegisterContentHandler: typeof navigator.registerContentHandler,
          inNavigator: 'registerProtocolHandler' in navigator,
          protoHas: Object.prototype.hasOwnProperty.call(Object.getPrototypeOf(navigator), 'registerProtocolHandler'),
          navigatorProtoKeys: Object.getOwnPropertyNames(Object.getPrototypeOf(navigator)).filter(k => /handler|protocol|content/i.test(k)),
          ua: navigator.userAgent
        })
        """
        w.evaluateJavaScript(js) { res, err in
            let wkBundle = Bundle(identifier: "com.apple.WebKit")
            let ver = (wkBundle?.infoDictionary?["CFBundleVersion"] as? String) ?? "?"
            let short = (wkBundle?.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "?"
            let os = ProcessInfo.processInfo.operatingSystemVersionString
            if let s = res as? String {
                print("{\"webkitFrameworkBundleVersion\":\"\(ver)\",\"webkitShortVersion\":\"\(short)\",\"os\":\"\(os)\",\"result\":\(s)}")
            } else {
                print("{\"error\":\"\(String(describing: err))\"}")
            }
            NSApp.terminate(nil)
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let d = Delegate()
app.delegate = d
app.run()
