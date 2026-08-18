#!/bin/bash
# v1.10 A2/A3 E2E fixture restore: rewrite TB-5 back to awaiting_human with
# evidence, then restart the demo instance so the running process picks the
# store up. The run is idempotent — a previous bounce is undone first.
set -u
HOME_DIR="${E2E_DSH_HOME:-/tmp/dsh-e2e-v02}"
STORE="$HOME_DIR/storages/taskboard.json"

python3 - "$STORE" << 'PYEOF'
import json
import sys
path = sys.argv[1]
with open(path) as f:
    doc = json.load(f)
for task in doc['tables']['tasks'].values():
    if task.get('key') == 'TB-5':
        task['status'] = 'awaiting_human'
        task['evidence'] = {
            'criteria': [
                {'criterion': 'domain/changed 推送到面板', 'met': True, 'note': 'SSE 端点已通'},
                {'criterion': '断线重连', 'met': False, 'note': '重连逻辑未覆盖'},
            ],
            'artifacts': ['src/routes.ts', 'feat/sse'],
            'summary': 'SSE 端点可用，重连逻辑缺测试。',
        }
        task['revision'] = task.get('revision', 1) + 1
        task['notes'] = ''
        break
with open(path, 'w') as f:
    json.dump(doc, f, ensure_ascii=False, indent=2)
print('TB-5 restored to awaiting_human')
PYEOF

lsof -ti :3099 | xargs -r kill 2>/dev/null
sleep 1
export DSH_HOME="$HOME_DIR"
cd /
nohup node /Users/ahyk/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --port 3099 > /tmp/dsh-3099.log 2>&1 &
for i in $(seq 1 30); do
  if curl -s -o /dev/null --max-time 2 http://127.0.0.1:3099/ 2>/dev/null; then
    echo "instance up after ${i}s"
    exit 0
  fi
  sleep 1
done
echo "instance did not come back" >&2
exit 1
