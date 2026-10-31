#!/usr/bin/env python3
# 中文说明：按目标平台下载单个官方 Headless Shell；检查解压体积，临时安装产物在失败时自行清理。
import argparse
import json
import io
import os
import platform
import shutil
import stat
import tempfile
import urllib.request
import zipfile
from pathlib import Path

parser = argparse.ArgumentParser(description='安装可远程操作的精简 Chromium；不安装桌面/VNC。')
parser.add_argument('--target', choices=['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64'])
parser.add_argument('--max-mb', type=int, default=400, help='浏览器解压后预算，十进制 MB；默认留出约 100 MB 给登录资料')
parser.add_argument('--inspect', action='store_true', help='只读取远程 ZIP 目录，估算实际解压体积，不下载浏览器主体')
args = parser.parse_args()
target = args.target or ('darwin' if platform.system() == 'Darwin' else 'linux') + ('-arm64' if platform.machine() in ('arm64', 'aarch64') else '-x64')
platform_id = {'linux-x64': 'linux64', 'linux-arm64': 'linux-arm64', 'darwin-arm64': 'mac-arm64', 'darwin-x64': 'mac-x64'}[target]
root = Path(os.environ.get('BROWSER_HUB_RUNTIME_ROOT', str(Path(__file__).resolve().parents[3] / '.venvs/browser-hub')))
metadata_url = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json'
with urllib.request.urlopen(metadata_url, timeout=30) as response:
    stable = json.load(response)['channels']['Stable']
downloads = [item for item in stable['downloads'].get('chrome-headless-shell', []) if item['platform'] == platform_id]
if not downloads:
    raise SystemExit(f'官方当前没有 {target} 安装包，请安装该平台系统 Chromium 后用 --browser 指定。')
url = downloads[0]['url']
if not url.startswith('https://storage.googleapis.com/chrome-for-testing-public/'):
    raise SystemExit('浏览器下载源不符合官方地址约束。')

class RemoteArchive(io.RawIOBase):
    # 中文说明：通过 HTTP Range 仅读取 ZIP 目录，避免为体积核验保存多个平台浏览器。
    def __init__(self, address):
        self.address, self.position = address, 0
        with urllib.request.urlopen(urllib.request.Request(address, headers={'Range': 'bytes=0-0'}), timeout=30) as response:
            if response.status != 206:
                raise RuntimeError('下载服务器不支持 Range，无法只读核验体积。')
            self.length = int(response.headers['Content-Range'].split('/')[-1])
    def seek(self, offset, whence=0):
        self.position = offset + (self.position if whence == 1 else self.length if whence == 2 else 0)
        return self.position
    def tell(self):
        return self.position
    def read(self, size=-1):
        size = min(self.length - self.position, size if size >= 0 else self.length)
        if size <= 0:
            return b''
        request = urllib.request.Request(self.address, headers={'Range': f'bytes={self.position}-{self.position + size - 1}'})
        with urllib.request.urlopen(request, timeout=30) as response:
            if response.status != 206:
                raise RuntimeError('下载服务器忽略 Range，停止只读核验。')
            value = response.read(size)
        self.position += len(value)
        return value

if args.inspect:
    remote = RemoteArchive(url)
    with zipfile.ZipFile(remote) as bundle:
        size = sum(item.file_size for item in bundle.infolist())
    print(json.dumps({'target': target, 'version': stable['version'], 'download_bytes': remote.length, 'unpacked_bytes': size, 'within_browser_budget': size <= args.max_mb * 1_000_000}, ensure_ascii=False, indent=2))
    raise SystemExit(0)
root.mkdir(parents=True, exist_ok=True)
destination = root / f'{target}-{stable["version"]}'
if destination.exists():
    raise SystemExit(f'目标已存在，保留原文件，不覆盖：{destination}')
with tempfile.TemporaryDirectory(prefix='.browser-install-', dir=root) as temporary:
    temporary = Path(temporary)
    archive = temporary / 'browser.zip'
    print(f'下载 {target} Chromium {stable["version"]} …', flush=True)
    with urllib.request.urlopen(url, timeout=60) as response, archive.open('wb') as output:
        shutil.copyfileobj(response, output)
    download_bytes = archive.stat().st_size
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        total = sum(item.file_size for item in entries)
        if total > args.max_mb * 1_000_000:
            raise SystemExit(f'解压体积 {total / 1_000_000:.1f} MB 超过 {args.max_mb} MB 预算，未安装。')
        existing = sum(name.stat().st_size for name in root.rglob('*') if name.is_file() and temporary not in name.parents)
        if total + existing > args.max_mb * 1_000_000:
            raise SystemExit('现有浏览器加本次安装将超过预算；请确认不再需要旧版本后自行清理，不自动删除原文件。')
        extracted = temporary / 'unpacked'
        for item in entries:
            relative = Path(item.filename)
            if relative.is_absolute() or '..' in relative.parts or stat.S_ISLNK(item.external_attr >> 16):
                raise SystemExit('安装包含不安全路径或软链接，已中止。')
            bundle.extract(item, extracted)
            mode = item.external_attr >> 16
            if mode and not item.is_dir():
                (extracted / item.filename).chmod(mode & 0o777)
    executable = next((name for name in extracted.rglob('chrome-headless-shell') if name.is_file()), None)
    if not executable:
        raise SystemExit('安装包没有 chrome-headless-shell 可执行文件。')
    executable.chmod(executable.stat().st_mode | 0o111)
    relative_executable = executable.relative_to(extracted)
    extracted.rename(destination)
installed = {'version': stable['version'], 'target': target, 'relative_executable': str(destination.relative_to(root) / relative_executable), 'unpacked_bytes': total, 'download_bytes': download_bytes, 'source': url}
(root / 'installed.json').write_text(json.dumps(installed, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(installed, ensure_ascii=False, indent=2))
