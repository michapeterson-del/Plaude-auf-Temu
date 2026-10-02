import SwiftUI
import WebKit

/// Zeigt die Plaude-Seite an und verbindet sie mit dem nativen Rekorder.
struct WebView: UIViewRepresentable {
    let url: URL
    let onResetServer: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.websiteDataStore = .default()
        let ucc = config.userContentController
        ucc.addScriptMessageHandler(context.coordinator, contentWorld: .page, name: "plaude")
        ucc.addUserScript(WKUserScript(source: "window.plaudeNative = { version: 1 };",
                                       injectionTime: .atDocumentStart, forMainFrameOnly: true))

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.isOpaque = false
        web.backgroundColor = .systemBackground
        context.coordinator.webView = web
        web.load(URLRequest(url: url))
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply {
        let parent: WebView
        weak var webView: WKWebView?

        init(_ parent: WebView) { self.parent = parent }

        // MARK: Brücke Web ↔ Rekorder

        func userContentController(_ userContentController: WKUserContentController,
                                   didReceive message: WKScriptMessage,
                                   replyHandler: @escaping (Any?, String?) -> Void) {
            // Nur die eigene Plaude-Seite darf den Rekorder steuern
            guard message.frameInfo.securityOrigin.host == parent.url.host else {
                replyHandler(nil, "Nicht erlaubt")
                return
            }
            let body = message.body as? [String: Any] ?? [:]
            let rec = AudioRecorder.shared
            switch body["action"] as? String ?? "" {
            case "start":
                rec.start(tag: body["tag"] as? String ?? "") { result in
                    switch result {
                    case .success:
                        replyHandler(["ok": true, "startedAt": rec.startedAtMs], nil)
                    case .failure(let error):
                        replyHandler(["ok": false,
                                      "denied": (error as? RecorderError) == .denied,
                                      "error": error.localizedDescription], nil)
                    }
                }
            case "stop":
                rec.stop()
                replyHandler(["ok": true], nil)
            case "status":
                replyHandler(rec.status(), nil)
            case "collect":
                replyHandler(rec.collect(), nil)
            case "ack":
                rec.ack(body["ids"] as? [String] ?? [])
                replyHandler(["ok": true], nil)
            case "resetServer":
                replyHandler(["ok": true], nil)
                DispatchQueue.main.async { self.parent.onResetServer() }
            default:
                replyHandler(nil, "Unbekannte Aktion")
            }
        }

        // MARK: Navigation – fremde Links und Apps (Things, Kurzbefehle …) außerhalb öffnen

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
            let scheme = url.scheme?.lowercased() ?? ""
            if scheme == "about" {
                decisionHandler(.allow)
            } else if (scheme == "https" || scheme == "http"), url.host == parent.url.host {
                decisionHandler(.allow)
            } else if scheme == "blob" || scheme == "data" {
                decisionHandler(.cancel)
            } else {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
            }
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.reload()
        }

        // MARK: alert / confirm / prompt der Seite

        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
            present(alert, otherwise: completionHandler)
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Abbrechen", style: .cancel) { _ in completionHandler(false) })
            alert.addAction(UIAlertAction(title: "OK", style: .destructive) { _ in completionHandler(true) })
            present(alert) { completionHandler(false) }
        }

        func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                     defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                     completionHandler: @escaping (String?) -> Void) {
            let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
            alert.addTextField { $0.text = defaultText }
            alert.addAction(UIAlertAction(title: "Abbrechen", style: .cancel) { _ in completionHandler(nil) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in
                completionHandler(alert.textFields?.first?.text)
            })
            present(alert) { completionHandler(nil) }
        }

        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                     initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                     decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            decisionHandler(origin.host == parent.url.host ? .grant : .deny)
        }

        private func present(_ controller: UIViewController, otherwise fallback: () -> Void) {
            guard var top = webView?.window?.rootViewController else { fallback(); return }
            while let next = top.presentedViewController { top = next }
            top.present(controller, animated: true)
        }
    }
}
