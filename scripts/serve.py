"""Serves dist/ on this computer. Browsers revalidate every file, so an update shows on the next reload.

Run: python scripts/serve.py [port] [--open]
"""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import webbrowser

ROOT = Path(__file__).resolve().parents[1] / "dist"


class Handler(SimpleHTTPRequestHandler):
    # The Windows registry can map these to text/plain, which browsers refuse for modules.
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".svg": "image/svg+xml"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *args):
        pass


def main():
    numbers = [arg for arg in sys.argv[1:] if arg.isdigit()]
    first = int(numbers[0]) if numbers else 8000
    for port in range(first, first + 20):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, directory=str(ROOT)))
            break
        except OSError:
            continue
    else:
        sys.exit(f"Ports {first}-{first + 19} are all in use.")
    url = f"http://localhost:{port}/"
    print(f"听腔已启动：{url}\n关闭这个窗口即可停止。", flush=True)
    if "--open" in sys.argv:
        webbrowser.open(url)
    server.serve_forever()


if __name__ == "__main__":
    main()
