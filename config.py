# -*- coding: utf-8 -*-
"""php-server 配置与 PHP 运行时探测"""
import os
import re
import shutil
import subprocess

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def _env_list(name):
    val = os.environ.get(name, "")
    return [v.strip() for v in val.split(os.pathsep) if v.strip()]


def detect_php_cgi():
    """按优先级探测 php-cgi 可执行文件：
    1. 环境变量 PHP_CGI
    2. 常见安装目录（含用户提供的路径）
    3. PATH 中的 php-cgi / php
    """
    candidates = []
    env_val = os.environ.get("PHP_CGI")
    if env_val:
        candidates.append(env_val)

    extra = [
        # ---- Windows 常见路径 ----
        r"C:\php-8.3.31-nts-Win32-vs16-x64\php-cgi.exe",
        r"C:\php-8.3.31-nts-Win32-vs16-x64\php.exe",
        r"C:\php\php-cgi.exe",
        r"C:\phpstudy_pro\Extensions\php\php8.3.31nts\php-cgi.exe",
        r"D:\phpstudy_pro\Extensions\php\php8.3.31nts\php-cgi.exe",
        r"A:\phpstudy_pro\Extensions\php\php8.3.31nts\php-cgi.exe",
        os.path.join(BASE_DIR, "php", "php-cgi.exe"),
        # ---- Linux / 容器常见路径 ----
        "/usr/bin/php-cgi",
        "/usr/local/bin/php-cgi",
        "/usr/bin/php",
        "/usr/local/bin/php",
        os.path.join(BASE_DIR, "php", "php-cgi"),
    ]
    candidates.extend(extra)

    # 扫描 phpstudy_pro 常见父目录下的所有 php 版本（Windows）
    for drive in ("C:", "D:", "A:"):
        for root in (
            os.path.join(drive, "phpstudy_pro", "Extensions", "php"),
            os.path.join(drive, "phpstudy_pro", "PHPTutorial", "php"),
        ):
            if os.path.isdir(root):
                for name in sorted(os.listdir(root), reverse=True):
                    p = os.path.join(root, name, "php-cgi.exe")
                    if os.path.isfile(p):
                        candidates.append(p)

    for c in candidates:
        if c and os.path.isfile(c):
            return os.path.abspath(c)

    # PATH 探测（php-cgi / php，跨平台）
    for exe in ("php-cgi", "php"):
        p = shutil.which(exe)
        if p and os.path.isfile(p):
            return os.path.abspath(p)
    return None


def get_php_version(php_cgi):
    """返回 PHP 版本字符串，例如 '8.3.31'；失败返回 None"""
    if not php_cgi or not os.path.isfile(php_cgi):
        return None
    try:
        out = subprocess.run(
            [php_cgi, "-v"],
            capture_output=True,
            text=True,
            timeout=10,
            cwd=os.path.dirname(php_cgi),
        )
        m = re.search(r"PHP\s+([\d.]+)", out.stdout or out.stderr or "")
        return m.group(1) if m else None
    except Exception:
        return None


# 文档根目录：默认 ./www，可用 PHP_SERVER_DOCROOT 覆盖
DOC_ROOT = os.environ.get("PHP_SERVER_DOCROOT") or os.path.join(BASE_DIR, "www")
DOC_ROOT = os.path.abspath(DOC_ROOT)

# 账号数据目录：存放 auth.json 与 secret.key。可用 AUTH_DIR 覆盖
# （Docker 部署建议挂卷到 /data，保证重启 / 重建容器账号不丢失）
AUTH_DIR = os.environ.get("AUTH_DIR") or os.path.join(BASE_DIR, "data")
AUTH_DIR = os.path.abspath(AUTH_DIR)

HOST = os.environ.get("PHP_SERVER_HOST", "0.0.0.0")
try:
    PORT = int(os.environ.get("PHP_SERVER_PORT", "5000"))
except ValueError:
    PORT = 5000

PHP_CGI = detect_php_cgi()
PHP_VERSION = get_php_version(PHP_CGI)
