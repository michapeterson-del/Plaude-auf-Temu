import SwiftUI

@main
struct PlaudeApp: App {
    @AppStorage("serverURL") private var serverURL = ""

    var body: some Scene {
        WindowGroup {
            if let url = URL(string: serverURL), url.scheme == "https", url.host != nil {
                WebView(url: url, onResetServer: { serverURL = "" })
                    .ignoresSafeArea()
            } else {
                SetupView { serverURL = $0 }
            }
        }
    }
}

/// Erster Start: Adresse der eigenen Plaude-Seite (Vercel) eintragen.
struct SetupView: View {
    @State private var address = "https://plaude-auf-temu.vercel.app"
    let onDone: (String) -> Void

    private var normalized: String? {
        var s = address.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return nil }
        if !s.lowercased().hasPrefix("https://") {
            s = "https://" + s.replacingOccurrences(of: "http://", with: "")
        }
        while s.hasSuffix("/") { s.removeLast() }
        guard let url = URL(string: s), url.host?.contains(".") == true else { return nil }
        return url.absoluteString
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Plaude")
                .font(.largeTitle.bold())
            Text("Adresse deiner Plaude-Seite (bei Vercel):")
                .foregroundStyle(.secondary)
            TextField("https://…", text: $address)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .textFieldStyle(.roundedBorder)
            Button("Verbinden") {
                if let url = normalized { onDone(url) }
            }
            .buttonStyle(.borderedProminent)
            .disabled(normalized == nil)
            Spacer()
        }
        .padding(24)
    }
}
