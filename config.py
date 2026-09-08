# -*- coding: utf-8 -*-
"""php-server 配置与 PHP 运行时探测"""
import os
import re
import shutil
import subprocess
import json

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def _env_list(name):
    val = os.environ.get(name, "")
    return [v.strip() for v in val.split(os.pathsep) if v.strip()]


def detect_all_php_cgi():
    """扫描并返回所有可用的 php-cgi（含多版本），按版本号降序。
    覆盖：环境变量、固定候选、phpstudy 多版本目录、独立解压版（D:\\php-*）、
    Linux 多版本（/usr/bin/phpX.Y）、PATH。返回 [{"path", "version"}]。"""
    found, seen = [], set()
    candidates = []

    env_val = os.environ.get("PHP_CGI")
    if env_val:
        candidates.append(env_val)

    extra = [
        # ---- Windows 常见路径 ----
        r"C:\php-8.3.31-nts-Win32-vs16-x64\php-cgi.exe",
        r"C:\php-8.3.31-nts-Win32-vs16-x64\php.exe",
        r"C:\php\php-cgi.exe",
        r"D:\php-8.2.31-nts-Win32-vs16-x64\php-cgi.exe",
        r"D:\php-8.3.31-nts-Win32-vs16-x64\php-cgi.exe",
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

    # 扫描独立解压版：D:\php-*、C:\php-*、A:\php-*（如 php-7.4.33-nts-Win32 等）
    for drive in ("C:", "D:", "A:"):
        try:
            for name in os.listdir(drive + os.sep):
                if name.lower().startswith("php-") and os.path.isdir(os.path.join(drive, name)):
                    p = os.path.join(drive, name, "php-cgi.exe")
                    if os.path.isfile(p):
                        candidates.append(p)
        except Exception:
            pass

    # Linux 常见多版本
    for p in ("/usr/bin/php7.4", "/usr/bin/php8.0", "/usr/bin/php8.1",
              "/usr/bin/php8.2", "/usr/bin/php8.3"):
        candidates.append(p)

    # PATH 探测（php-cgi / php / 明确版本）
    for exe in ("php-cgi", "php", "php7.4", "php8.2"):
        p = shutil.which(exe)
        if p:
            candidates.append(p)

    for c in candidates:
        if not c:
            continue
        c = os.path.abspath(c)
        if c in seen:
            continue
        if os.path.isfile(c):
            seen.add(c)
            found.append({"path": c, "version": get_php_version(c)})

    def _vk(item):
        v = (item["version"] or "0").split(".")
        v = (v + ["0", "0", "0"])[:3]
        try:
            return tuple(int(x) for x in v)
        except Exception:
            return (0, 0, 0)

    found.sort(key=_vk, reverse=True)
    return found


def detect_php_cgi():
    """兼容旧调用：返回探测到的第一个 php-cgi（优先级同 detect_all）。"""
    allc = detect_all_php_cgi()
    return allc[0]["path"] if allc else None


def get_selected_php_cgi():
    """返回用户选中的 php-cgi：优先 settings.json 中保存的，否则自动探测首个。"""
    s = load_settings()
    sel = s.get("php_cgi")
    if sel and os.path.isfile(sel):
        return os.path.abspath(sel)
    return detect_php_cgi()


def set_php_cgi(path):
    """保存用户选中的 php-cgi 路径到 settings.json（供切换生效）。"""
    path = os.path.abspath(path)
    if not os.path.isfile(path):
        return False
    s = load_settings()
    s["php_cgi"] = path
    return save_settings(s)


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

# 用户设置持久化：存放选中的 PHP 运行时路径等（重启不丢失）
SETTINGS_FILE = os.path.join(AUTH_DIR, "settings.json")

def load_settings():
    try:
        if os.path.isfile(SETTINGS_FILE):
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        pass
    return {}

def save_settings(d):
    try:
        os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
        tmp = SETTINGS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=2)
        os.replace(tmp, SETTINGS_FILE)
        return True
    except Exception:
        return False


# 计划任务「选择脚本」按钮允许浏览的白名单根目录（绝对路径）。
# 仅这些目录及其子目录下的文件可被选作脚本路径，杜绝任意路径穿越。
# 默认含：文档根、php-server 本体、Desktop/mefrp(签到脚本)、用户 Desktop。
# 需要扩充时直接编辑此列表，或通过环境变量 SCRIPT_ROOTS 用 ; 分隔追加。
def _default_script_roots():
    cands = [
        DOC_ROOT,                                                # php-server/www（站点脚本）
        BASE_DIR,                                                # php-server 本体（含 cron.py 等项目脚本）
        os.path.join(os.environ.get("USERPROFILE", "C:/Users/Administrator"), "Desktop", "mefrp"),  # mefrp 签到脚本所在目录
        os.path.join(os.environ.get("USERPROFILE", "C:/Users/Administrator"), "Desktop"),            # 用户桌面（兜底）
    ]
    seen, out = set(), []
    for p in cands:
        if not p:
            continue
        ap = os.path.abspath(p)
        if ap in seen or not os.path.isdir(ap):
            continue
        seen.add(ap)
        out.append(ap)
    return out

_env_roots = os.environ.get("SCRIPT_ROOTS", "")
if _env_roots:
    SCRIPT_ROOTS = _default_script_roots() + [
        os.path.abspath(p) for p in _env_roots.split(";") if p.strip()
    ]
else:
    SCRIPT_ROOTS = _default_script_roots()

HOST = os.environ.get("PHP_SERVER_HOST", "0.0.0.0")
try:
    PORT = int(os.environ.get("PHP_SERVER_PORT", "5000"))
except ValueError:
    PORT = 5000

PHP_VERSIONS = detect_all_php_cgi()
PHP_CGI = get_selected_php_cgi()
PHP_VERSION = get_php_version(PHP_CGI)
