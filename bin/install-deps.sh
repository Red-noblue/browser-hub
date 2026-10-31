#!/usr/bin/env bash
# 中文说明：把 WebSocket 与轻量正文转换依赖装入共享目录；不自动下载浏览器或创建软链接。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
NODE_BIN="${BROWSER_HUB_NODE_BIN:-$PROJECT_ROOT/.venvs/0node/bin/node}"
NPM_BIN="${BROWSER_HUB_NPM_BIN:-$PROJECT_ROOT/.venvs/0node/bin/npm}"
[[ -x "$NODE_BIN" ]] || NODE_BIN="$(command -v node)"
[[ -x "$NPM_BIN" ]] || NPM_BIN="$(command -v npm)"
DEPENDENCIES=()
while IFS= read -r dependency; do DEPENDENCIES+=("$dependency"); done < <("$NODE_BIN" --input-type=commonjs - "$SCRIPT_DIR/../package-lock.json" <<'JS'
// 中文说明：安装锁文件中的直接依赖版本，保留共享目录已有的其他工具包。
const lock = require(process.argv[2]);
for (const name of Object.keys(lock.packages[''].dependencies)) console.log(`${name}@${lock.packages[`node_modules/${name}`].version}`);
JS
)
export npm_config_cache="$PROJECT_ROOT/.venvs/0node_module/.npm-cache"
PATH="$(dirname "$NODE_BIN"):$PATH" "$NPM_BIN" install --global \
  --prefix "${BROWSER_HUB_NODE_PREFIX:-$PROJECT_ROOT/.venvs/0node_module}" \
  --ignore-scripts --no-bin-links --no-audit --no-fund "${DEPENDENCIES[@]}"
