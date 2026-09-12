import AVFAudio
import SwiftUI
import WebKit
import OSLog

struct NookWebView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> NookWebController { NookWebController() }
    func updateUIViewController(_ controller: NookWebController, context: Context) {}
    static func dismantleUIViewController(_ controller: NookWebController, coordinator: ()) { controller.shutdown() }
}

@MainActor
final class NookWebController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply {
    private let audio = NativeAudio()
    private var webView: WKWebView!
    private var commands: [UUID: Task<Void, Never>] = [:]
    private let serverURL = URL(string: Bundle.main.object(forInfoDictionaryKey: "NookServerURL") as? String ?? "https://omp-amos.vxn.rs/")!
    private let loginURL = URL(string: Bundle.main.object(forInfoDictionaryKey: "NookLoginURL") as? String ?? "https://auth.vxn.rs/")!
    private let logger = Logger(subsystem: "rs.vxn.nook", category: "web")

    override func viewDidLoad() {
        super.viewDidLoad()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "nookAudioV1")
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        #if DEBUG
        webView.isInspectable = true
        #endif
        webView.inputAssistantItem.leadingBarButtonGroups = []
        webView.inputAssistantItem.trailingBarButtonGroups = []
        view = webView
        webView.load(URLRequest(url: serverURL))
        NotificationCenter.default.addObserver(self, selector: #selector(suspendAudio), name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(suspendAudio), name: AVAudioSession.interruptionNotification, object: nil)
    }

    func shutdown() {
        NotificationCenter.default.removeObserver(self)
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "nookAudioV1", contentWorld: .page)
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.stopLoading()
        run { [audio] in await audio.cancel() }
    }

    @objc private func suspendAudio() {
        run { [audio] in await audio.cancel() }
    }

    private func run(_ operation: @escaping @MainActor () async -> Void) {
        let id = UUID()
        commands[id] = Task { [weak self] in
            await operation()
            self?.commands[id] = nil
        }
    }

    private func trusted(_ url: URL?) -> Bool {
        guard let url else { return false }
        return url.scheme == serverURL.scheme && url.host == serverURL.host && url.port == serverURL.port
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, trusted(message.frameInfo.request.url), trusted(webView.url),
              let body = message.body as? [String: Any], let command = body["command"] as? String,
              let id = body["id"] as? String, UUID(uuidString: id) != nil else {
            replyHandler(nil, "Untrusted or invalid microphone request")
            return
        }
        run { [audio] in
            do {
                switch command {
                case "start": try await audio.start(id: id); replyHandler(["version": 1], nil)
                case "read": replyHandler(try audio.read(id: id), nil)
                case "stop": replyHandler(try await audio.stop(id: id), nil)
                case "cancel": await audio.cancel(id: id); replyHandler(true, nil)
                default: replyHandler(nil, "Unsupported microphone command")
                }
            } catch { replyHandler(nil, error.localizedDescription) }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        let login = url.scheme == loginURL.scheme && url.host == loginURL.host && url.port == loginURL.port
        if trusted(url) || login { decisionHandler(.allow) }
        else {
            decisionHandler(.cancel)
            if navigationAction.navigationType == .linkActivated, ["https", "http", "mailto"].contains(url.scheme) {
                UIApplication.shared.open(url)
            }
        }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        run { [audio] in await audio.cancel() }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        run { [audio] in await audio.cancel() }
        webView.reload()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        logger.error("Page load failed: \(error.localizedDescription, privacy: .public)")
        let alert = UIAlertController(title: "Cannot connect to Nook", message: error.localizedDescription, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Retry", style: .default) { [weak self] _ in
            guard let self else { return }
            self.webView.load(URLRequest(url: self.serverURL))
        })
        present(alert, animated: true)
    }
}
