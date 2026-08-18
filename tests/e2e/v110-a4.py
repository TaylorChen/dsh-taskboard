#!/usr/bin/env python3
"""E2E v1.10 A4 (status ball animation, browser): load the board on the demo
instance and assert the per-status balls:
  - every card has a [data-status-ball] dot,
  - in_progress balls carry the pulsing animation (animation-name
    taskboard-pulse),
  - awaiting_human and blocked balls carry the breathing animation
    (taskboard-breathe),
  - done and parked cards have no animation (a still ball).

Env: BASE (default http://127.0.0.1:3099). Requires the A4 client bundle to
be served (restart the instance after `pnpm run build`).
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
    pg = b.new_page(viewport={'width': 1600, 'height': 1000})
    pg.goto(BASE, wait_until='domcontentloaded', timeout=30000)
    pg.wait_for_timeout(2500)
    pg.get_by_text('你好').first.click()
    pg.wait_for_timeout(3000)
    pg.get_by_text('Board', exact=True).first.click()
    pg.wait_for_timeout(2500)

    balls = pg.locator('[data-status-ball]')
    count = balls.count()
    check('every card renders a status ball', count > 0, f'{count} balls')

    states = pg.evaluate("""() => {
      const out = {};
      for (const el of document.querySelectorAll('[data-status-ball]')) {
        const status = el.getAttribute('data-status-ball');
        const cs = getComputedStyle(el);
        out[status] = out[status] || { n: 0, anims: new Set(), colours: new Set() };
        out[status].n += 1;
        out[status].anims.add(cs.animationName);
        out[status].colours.add(cs.backgroundColor);
      }
      const plain = {};
      for (const [k, v] of Object.entries(out)) {
        plain[k] = { n: v.n, anims: [...v.anims], colours: [...v.colours] };
      }
      return plain;
    }""")
    print('states seen:', {k: f"{v['n']}x anims={v['anims']}" for k, v in states.items()})

    def anim(st):
        return (states.get(st) or {}).get('anims') or []

    check('in_progress balls pulse', 'taskboard-pulse' in anim('in_progress'), str(anim('in_progress')))
    check('awaiting_human balls breathe', 'taskboard-breathe' in anim('awaiting_human'), str(anim('awaiting_human')))
    check('blocked balls breathe', 'taskboard-breathe' in anim('blocked'), str(anim('blocked')))
    check('done balls are still', all(a == 'none' for a in anim('done')), str(anim('done')))
    check('draft balls are still', all(a == 'none' for a in anim('draft')), str(anim('draft')))

    def rgb(st):
        return (states.get(st) or {}).get('colours') or []

    # color-mix resolves to oklab here: blue has a strongly negative b axis,
    # red a strongly positive a axis.
    blueish = any(
        __import__('re').search(r'oklab\([^)]* -0\.[0-9]+ -0\.[0-9]+\)', c)
        for c in rgb('in_progress')
    )
    reddish = any(
        __import__('re').search(r'oklab\([^)]* 0\.1[0-9]+ 0\.[0-9]+\)', c)
        for c in rgb('awaiting_human')
    )
    check('in_progress ball is blue', blueish, str(rgb('in_progress')))
    check('awaiting_human ball is red', reddish, str(rgb('awaiting_human')))
    b.close()

print('E2E-V110-A4-PASS' if failures == 0 else f'E2E-V110-A4-FAIL ({failures})')
sys.exit(0 if failures == 0 else 1)
