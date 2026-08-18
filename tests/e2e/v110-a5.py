#!/usr/bin/env python3
"""E2E v1.10 A5 (certificate of completion, browser): on the demo instance,
open the awaiting_human card's certificate and assert:
  - the certificate block renders (data-certificate) with a verdict badge,
  - per-criterion ✓/✗ marks are present,
  - each artifact renders as a clickable chip (data-artifact),
  - clicking an artifact copies it to the clipboard (flash "Copied!").

Env: BASE (default http://127.0.0.1:3099). Requires the A5 client bundle
(restart the instance after `pnpm run build`).
"""
import os
import sys
from playwright.sync_api import sync_playwright

BASE = os.environ.get('BASE', 'http://127.0.0.1:3099')
failures = 0

def check(name, ok, detail=''):
    global failures
    print(f"{'PASS' if ok else 'FAIL'}  {name}{' <- ' + detail if detail else ''}")
    if not ok:
        failures += 1

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    ctx = b.new_context(viewport={'width': 1600, 'height': 1000}, permissions=['clipboard-read', 'clipboard-write'])
    pg = ctx.new_page()
    pg.goto(BASE, wait_until='domcontentloaded', timeout=30000)
    pg.wait_for_timeout(2500)
    pg.get_by_text('你好').first.click()
    pg.wait_for_timeout(3000)
    pg.get_by_text('Board', exact=True).first.click()
    pg.wait_for_timeout(2500)

    certs = pg.locator('[data-certificate]')
    check('awaiting_human card renders a certificate', certs.count() >= 1, f'{certs.count()} certs')
    if certs.count() == 0:
        b.close()
        print('E2E-V110-A5-FAIL (1)')
        sys.exit(1)

    cert = certs.first
    text = cert.inner_text()
    check('certificate header present', 'Certificate of completion' in text, text[:80])
    check('verdict badge present', ('·' in text), '')
    check('criteria marks present', ('✓' in text or '✗' in text), '')

    chips = cert.locator('[data-artifact]')
    n = chips.count()
    check('artifacts render as clickable chips', n >= 1, f'{n} chips')
    first_artifact = chips.first.get_attribute('data-artifact') if n else None
    check('artifact chip has a value', bool(first_artifact), str(first_artifact))

    if n >= 1:
        chips.first.click()
        pg.wait_for_timeout(400)
        flash = cert.locator('[data-artifact]').first.inner_text()
        check('clicking an artifact flashes Copied!', 'Copied' in flash, flash)
        # clipboard content matches the artifact value
        clip = pg.evaluate('navigator.clipboard.readText()')
        check('clipboard holds the artifact', clip == first_artifact, f'{clip!r} vs {first_artifact!r}')

    b.close()

print('E2E-V110-A5-PASS' if failures == 0 else f'E2E-V110-A5-FAIL ({failures})')
sys.exit(0 if failures == 0 else 1)
