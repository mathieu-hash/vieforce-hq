"""Offline verification of the Margin Explorer branch.

Serves the repository root on 127.0.0.1:8912, opens the harness in headless
Chromium for every mock scenario, fails on any console error or page error,
and writes full-page screenshots (dark + light for the happy path) to
test/screenshots/.  Run from the repository root:

    python test/verify_harness.py

Requires: python 3, playwright (`pip install playwright && playwright install chromium`).
Exit code 0 = clean.  This is what "verified" means on this branch.
"""
import json
import os
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "test", "screenshots")
PORT = 8912
SCENARIOS = ["happy", "empty-scope", "malformed", "bridge-unavailable", "rounding-drift", "trust-signals"]


def main():
    os.makedirs(OUT, exist_ok=True)
    srv = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1"],
                           cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)
    report, failed = {}, False
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            for scen in SCENARIOS:
                page = browser.new_page(viewport={"width": 1400, "height": 3600})
                errors = []
                page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
                page.on("console", lambda m: errors.append("console.error: " + m.text) if m.type == "error" else None)
                page.goto("http://127.0.0.1:%d/test/margin-explorer-harness.html?scenario=%s" % (PORT, scen),
                          wait_until="networkidle")
                page.wait_for_timeout(1500)
                facts = page.evaluate("""() => ({
                    matrixRows: document.querySelectorAll('#mexp-matrix-host tbody tr').length,
                    bridgeSvg: document.querySelectorAll('#mexp-bridge-host svg').length,
                    netSvg: document.querySelectorAll('#mexp-net-host svg').length,
                    lensCards: document.querySelectorAll('#mexp-net-host .mx2-lens').length,
                    netKpi: document.body.innerText.indexOf('net of discount') >= 0
                })""")
                page.screenshot(path=os.path.join(OUT, scen + "-dark.png"))
                if scen == "happy":
                    page.evaluate("document.documentElement.setAttribute('data-theme','light')")
                    page.wait_for_timeout(600)
                    page.screenshot(path=os.path.join(OUT, "happy-light.png"))
                report[scen] = dict(facts, errors=errors)
                if errors:
                    failed = True
                page.close()
            browser.close()
    finally:
        srv.terminate()
    print(json.dumps(report, indent=1))
    if failed:
        print("FAILED: console or page errors above", file=sys.stderr)
        sys.exit(1)
    print("OK: %d scenarios, no console errors, screenshots in test/screenshots/" % len(SCENARIOS))


if __name__ == "__main__":
    main()
