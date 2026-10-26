import Cocoa
for s in ["magnet:?xt=urn:btih:0000000000000000000000000000000000000000", "web+magnetweb:test", "web+magnetweb2:test"] {
    if let u = URL(string: s) {
        let app = NSWorkspace.shared.urlForApplication(toOpen: u)
        print(s.prefix(22), "->", app?.path ?? "(no handler)")
    }
}
