# -*- coding: utf-8 -*-
"""简易 PHP 服务器 / 文件管理器 (Flask + php-cgi)"""
import io
import json
import mimetypes
import os
import secrets
import shutil
import subprocess
import zipfile
from datetime import datetime

import config
import cron
from flask import (
    Flask,
    abort,
    jsonify,
    redirect,
    render_template,
    request,
    Response,
    session,
    send_file,
    url_for,
)
from werkzeug.security import check_password_hash, generate_password_hash

app = Flask(__name__)

DOC_ROOT = config.DOC_ROOT


# ------------------------- 应用版本 -------------------------
def _read_app_version():
    """应用版本：优先仓库根 VERSION 文件(Docker `COPY . .` 已包含，作为唯一真相源)，
    其次运行时环境变量 APP_VERSION(覆盖用)，最后 'dev'。
    说明：旧逻辑先读环境变量，导致镜像构建时 ENV APP_VERSION=dev(dev 为 ARG 默认值) 直接锁死成 vdev；
    改为文件优先后，只要镜像里 VERSION 文件存在(内容 1.5.2)，即使未传 --build-arg 也显示正确版本。"""
    # 1) VERSION 文件优先(唯一真相源)
    for cand in (os.path.join(os.path.dirname(os.path.abspath(__file__)), "VERSION"),
                 "/app/VERSION"):
        try:
            with open(cand, "r", encoding="utf-8") as f:
                v = f.read().strip()
                if v:
                    return v
        except OSError:
            continue
    # 2) 运行时环境变量覆盖
    env_v = os.environ.get("APP_VERSION")
    if env_v:
        return env_v
    return "dev"


PHP_CGI = config.PHP_CGI

# ------------------------- 登录认证 -------------------------
AUTH_DIR = config.AUTH_DIR
AUTH_FILE = os.path.join(AUTH_DIR, "auth.json")
SECRET_FILE = os.path.join(AUTH_DIR, "secret.key")


def _load_auth():
    try:
        with open(AUTH_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return None


def _save_auth(username, pw_hash):
    os.makedirs(AUTH_DIR, exist_ok=True)
    with open(AUTH_FILE, "w", encoding="utf-8") as f:
        json.dump({"username": username, "pw_hash": pw_hash}, f,
                  ensure_ascii=False, indent=2)


def has_account():
    a = _load_auth()
    return bool(a and a.get("username"))


def get_secret_key():
    """读取或生成持久化的 Flask 会话密钥，保证重启后登录态不失效。"""
    try:
        with open(SECRET_FILE, "r", encoding="utf-8") as f:
            k = f.read().strip()
            if k:
                return k
    except FileNotFoundError:
        pass
    k = secrets.token_hex(32)
    try:
        with open(SECRET_FILE, "w", encoding="utf-8") as f:
            f.write(k)
        try:
            os.chmod(SECRET_FILE, 0o600)
        except OSError:
            pass
    except Exception:
        pass
    return k


app.secret_key = get_secret_key()


# 文本类文件扩展名（可在前端编辑）
TEXT_EXTS = {
    "txt", "php", "html", "htm", "css", "js", "json", "xml", "md", "py", "ini",
    "cfg", "conf", "log", "sql", "sh", "bat", "yml", "yaml", "vue", "ts", "jsx",
    "inc", "tpl", "twig", "env", "htaccess", "gitignore", "csv", "java", "c",
    "cpp", "h", "go", "rb", "pl", "lua", "r", "scss", "less",
}


# ------------------------- 路径安全 -------------------------
def safe_path(rel):
    """把相对路径（正斜杠）解析为 DOC_ROOT 内的绝对路径，杜绝穿越。"""
    if rel is None:
        rel = ""
    rel = rel.replace("\\", "/").strip("/")
    if rel == "":
        return DOC_ROOT
    target = os.path.normpath(os.path.join(DOC_ROOT, rel))
    if target != DOC_ROOT and not target.startswith(DOC_ROOT + os.sep):
        abort(403, "非法路径")
    return target


def rel_of(abs_path):
    """绝对路径转相对 DOC_ROOT 的 URL 友好字符串（正斜杠）。"""
    if abs_path == DOC_ROOT:
        return ""
    rel = os.path.relpath(abs_path, DOC_ROOT)
    return rel.replace(os.sep, "/")


def is_text_file(path):
    ext = os.path.splitext(path)[1].lower().lstrip(".")
    if ext in TEXT_EXTS:
        return True
    # 无扩展名且体积小，尝试按文本判定
    if ext == "" and os.path.getsize(path) < 512 * 1024:
        try:
            with open(path, "rb") as f:
                chunk = f.read(4096)
            chunk.decode("utf-8")
            return True
        except Exception:
            return False
    return False


def fmt_size(n):
    if n < 1024:
        return f"{n} B"
    for unit in ("KB", "MB", "GB", "TB"):
        n /= 1024.0
        if n < 1024:
            return f"{n:.1f} {unit}"
    return f"{n:.1f} PB"


def fmt_time(ts):
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")


# ------------------------- 登录守卫 -------------------------
# 以下路径无需登录即可访问（静态资源、初始化页、登录/登出接口）
_EXEMPT_PATHS = {"/setup", "/login", "/api/setup", "/api/login", "/api/logout", "/favicon.ico"}


@app.before_request
def require_login():
    p = request.path
    if p.startswith("/static/"):
        return
    # 外链直链：按 token 映射，匿名可访问（用于外部分享）
    if p.startswith("/dl/"):
        return
    if p in _EXEMPT_PATHS:
        return

    # 文档根目录（www/）下部署的项目：一律公开、不拦截。
    # 这样在 php-server 上再部署任何站点/脚本（如 /os/、/央视频.php、或任意子目录），
    # 都可直接访问，无需逐个加白名单。仅 php-server 自身的管理后台（/ 与 /api/*）需要登录。
    rel = p[len("/serve/"):] if p.startswith("/serve/") else p
    rel = rel.lstrip("/")  # 去掉前导斜杠，否则 safe_path 会解析到盘符/系统根之外
    if rel:
        target = safe_path(rel)
        is_deployed = os.path.isfile(target)
        if not is_deployed and os.path.isdir(target):
            for idx in ("index.html", "index.php", "index.htm"):
                if os.path.isfile(os.path.join(target, idx)):
                    is_deployed = True
                    break
        if is_deployed:
            return

    # 以下是 php-server 管理后台，需登录
    if not has_account():
        if p.startswith("/api/"):
            return jsonify(ok=False, error="请先创建管理员账号"), 401
        return redirect("/setup")
    if not session.get("user"):
        if p.startswith("/api/"):
            return jsonify(ok=False, error="未登录"), 401
        return redirect("/login")
    return


# ------------------------- 页面 -------------------------
@app.route("/")
def index():
    return render_template(
        "index.html",
        php_ok=bool(PHP_CGI),
        php_version=config.PHP_VERSION or "",
        doc_root=DOC_ROOT,
        app_version=_read_app_version(),
        username=session.get("user", ""),
    )


# ------------------------- 初始化 / 登录 / 登出 -------------------------
@app.route("/setup")
def setup_page():
    if has_account():
        return redirect("/login")
    return render_template("setup.html")


@app.route("/api/setup", methods=["POST"])
def api_setup():
    if has_account():
        return jsonify(ok=False, error="账号已初始化"), 400
    data = request.get_json(force=True)
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    if not username or not password:
        abort(400, "用户名和密码不能为空")
    if len(username) > 32:
        abort(400, "用户名过长（≤32 字符）")
    if len(password) < 6:
        abort(400, "密码至少 6 位")
    _save_auth(username, generate_password_hash(password))
    session["user"] = username
    return jsonify(ok=True, username=username)


@app.route("/login")
def login_page():
    if not has_account():
        return redirect("/setup")
    if session.get("user"):
        return redirect("/")
    return render_template("login.html")


@app.route("/api/login", methods=["POST"])
def api_login():
    if not has_account():
        return jsonify(ok=False, error="请先创建管理员账号"), 400
    data = request.get_json(force=True)
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    a = _load_auth()
    if a and username == a.get("username") and check_password_hash(a.get("pw_hash", ""), password):
        session["user"] = username
        return jsonify(ok=True, username=username)
    return jsonify(ok=False, error="用户名或密码错误"), 401


@app.route("/api/logout", methods=["POST"])
def api_logout():
    session.clear()
    return jsonify(ok=True)


@app.route("/api/info")
def api_info():
    return jsonify(
        {
            "php_cgi": PHP_CGI,
            "php_version": config.PHP_VERSION,
            "php_ok": bool(PHP_CGI),
            "doc_root": DOC_ROOT,
            "python_version": __import__("sys").version.split()[0],
            "version": _read_app_version(),
        }
    )


@app.route("/api/version")
def api_version():
    return jsonify(version=_read_app_version())


# ------------------------- 计划任务 -------------------------
# 所有计划任务路由一律包 try/except，任何异常都返回 ok=False，
# 避免 Flask 默认 handler 把 500/HTML 文本传到前端触发 toast 误显示。
def _cron_err(msg="加载失败"):
    return jsonify(ok=False, error=msg), 200


@app.route("/api/cron/list")
def api_cron_list():
    try:
        tasks = cron.load_tasks()
        out = []
        for t in tasks:
            t = dict(t)
            try:
                t["next_run"] = cron.next_run_time(t["id"])
            except Exception:
                t["next_run"] = 0
            out.append(t)
        return jsonify(ok=True, tasks=out)
    except Exception as e:
        return _cron_err(str(e) or "加载任务失败")


@app.route("/api/cron/add", methods=["POST"])
def api_cron_add():
    try:
        data = request.get_json(force=True, silent=True) or {}
        if not (data.get("name") or "").strip():
            return jsonify(ok=False, error="任务名称不能为空")
        task = cron.add_task(data)
        return jsonify(ok=True, task=task)
    except Exception as e:
        import traceback, os
        tb = traceback.format_exc()
        try:
            with open(os.path.join(cron.BASE_DIR, "data", "cron_err.log"), "a", encoding="utf-8") as f:
                f.write(tb + "\n")
        except Exception:
            pass
        return jsonify(ok=False, error=str(e) or "保存失败")


@app.route("/api/cron/update", methods=["POST"])
def api_cron_update():
    try:
        data = request.get_json(force=True, silent=True) or {}
        tid = data.get("id")
        if not tid:
            return jsonify(ok=False, error="缺少任务 id")
        t = cron.update_task(tid, data)
        if not t:
            return jsonify(ok=False, error="任务不存在")
        return jsonify(ok=True, task=t)
    except Exception as e:
        return jsonify(ok=False, error=str(e) or "更新失败")


@app.route("/api/cron/delete", methods=["POST"])
def api_cron_delete():
    try:
        data = request.get_json(force=True, silent=True) or {}
        cron.delete_task(data.get("id"))
        return jsonify(ok=True)
    except Exception as e:
        return jsonify(ok=False, error=str(e) or "删除失败")


@app.route("/api/cron/toggle", methods=["POST"])
def api_cron_toggle():
    try:
        data = request.get_json(force=True, silent=True) or {}
        ok = cron.toggle_task(data.get("id"), bool(data.get("enabled", True)))
        return jsonify(ok=bool(ok))
    except Exception as e:
        return jsonify(ok=False, error=str(e) or "切换失败")


@app.route("/api/cron/run", methods=["POST"])
def api_cron_run():
    try:
        data = request.get_json(force=True, silent=True) or {}
        ok, detail = cron.run_once(data.get("id"))
        return jsonify(ok=ok, detail=detail)
    except Exception as e:
        return jsonify(ok=False, detail=f"执行异常: {e}")


@app.route("/api/cron/logs")
def api_cron_logs():
    try:
        tid = request.args.get("id")
        try:
            lines = int(request.args.get("lines", 200))
        except ValueError:
            lines = 200
        return jsonify(ok=True, log=cron.get_logs(tid, lines))
    except Exception as e:
        return jsonify(ok=False, error=str(e) or "读取日志失败")


# ------------------------- 计划任务「选择脚本」白名单浏览 -------------------------
@app.route("/api/script_browse")
def api_script_browse():
    """在 config.SCRIPT_ROOTS 注册的白名单根下列出单层目录项，供「选择脚本」按钮使用。
    Query:
      root=<int>    SCRIPT_ROOTS 中的索引（默认 0）
      path=<str>    相对该 root 的子路径（默认空=根）
    返回: {ok, roots:[{idx,label,abs}], root_abs, current_abs, parent_abs, entries:[{name,abs,is_dir,size_text,ext}]}
    仅 ROOT 用户可调用；路径必须落在白名单根下（realpath 校验），杜绝穿越。"""
    try:
        import config as _cfg
        roots = getattr(_cfg, "SCRIPT_ROOTS", [])
        if not roots:
            return jsonify(ok=False, error="未配置 SCRIPT_ROOTS"), 200
        try:
            root_idx = int(request.args.get("root", 0))
        except ValueError:
            root_idx = 0
        if root_idx < 0 or root_idx >= len(roots):
            return jsonify(ok=False, error="根目录索引越界"), 200
        root_abs = os.path.abspath(roots[root_idx])
        rel = (request.args.get("path", "") or "").replace("\\", "/").strip("/")
        # 拼接后必须仍在 root_abs 之内（realpath 双重校验）
        candidate = os.path.normpath(os.path.join(root_abs, rel)) if rel else root_abs
        real_candidate = os.path.realpath(candidate)
        real_root = os.path.realpath(root_abs)
        if real_candidate != real_root and not real_candidate.startswith(real_root + os.sep):
            return jsonify(ok=False, error="路径越界"), 200
        if not os.path.isdir(real_candidate):
            return jsonify(ok=False, error="目录不存在"), 200

        entries = []
        try:
            listing = sorted(os.listdir(real_candidate))
        except PermissionError:
            return jsonify(ok=False, error="无权限访问"), 200
        for name in listing:
            if name.startswith(".") or name == "__pycache__":
                continue
            fp = os.path.join(real_candidate, name)
            try:
                st = os.stat(fp)
            except OSError:
                continue
            is_dir = os.path.isdir(fp)
            entries.append({
                "name": name,
                "abs": fp,
                "is_dir": is_dir,
                "size_text": "" if is_dir else fmt_size(st.st_size),
                "ext": "" if is_dir else os.path.splitext(name)[1].lower().lstrip("."),
            })
        # 文件夹优先，再按名称
        entries.sort(key=lambda x: (not x["is_dir"], x["name"].lower()))

        # 父目录的相对路径（若已在根，parent 留空）
        parent_rel = ""
        if real_candidate != real_root:
            parent_abs = os.path.dirname(real_candidate)
            parent_rel = os.path.relpath(parent_abs, real_root).replace("\\", "/")
            parent_abs_out = parent_abs
        else:
            parent_abs_out = ""

        return jsonify(ok=True,
                       roots=[{"idx": i, "label": os.path.basename(r) or r, "abs": r} for i, r in enumerate(roots)],
                       root_idx=root_idx,
                       current_abs=real_candidate,
                       parent_abs=parent_abs_out,
                       path_rel=parent_rel if real_candidate == real_root else rel,
                       entries=entries)
    except Exception as e:
        return jsonify(ok=False, error=str(e) or "浏览失败"), 200


# ------------------------- 目录树 -------------------------
@app.route("/api/tree")
def api_tree():
    """返回 DOC_ROOT 下的目录树（仅目录，限制深度避免过大）。"""
    MAX_DEPTH = 7

    def walk(abs_dir, depth):
        nodes = []
        if depth >= MAX_DEPTH:
            return nodes
        try:
            entries = sorted(os.listdir(abs_dir))
        except (PermissionError, OSError):
            return nodes
        for name in entries:
            if name.startswith(".") or name.startswith("__"):
                continue
            fp = os.path.join(abs_dir, name)
            if os.path.isdir(fp):
                nodes.append(
                    {"name": name, "path": rel_of(fp), "children": walk(fp, depth + 1)}
                )
        return nodes

    return jsonify({"ok": True, "tree": walk(DOC_ROOT, 0)})


# ------------------------- 重启服务 -------------------------
@app.route("/api/restart", methods=["POST"])
def api_restart():
    """以相同参数重启当前 Flask 进程（仿宝塔重启）。"""
    import sys

    # os.execv 会替换当前进程映像，端口短暂不可用后恢复，环境变量保留
    os.execv(sys.executable, [sys.executable] + sys.argv)
    return "", 200  # 实际不会执行到这里


# ------------------------- 文件列表 -------------------------
@app.route("/api/list")
def api_list():
    rel = request.args.get("path", "")
    d = safe_path(rel)
    if not os.path.isdir(d):
        abort(404, "目录不存在")
    items = []
    try:
        entries = sorted(os.listdir(d))
    except PermissionError:
        abort(403, "无权限访问")
    for name in entries:
        full = os.path.join(d, name)
        try:
            st = os.stat(full)
        except OSError:
            continue
        is_dir = os.path.isdir(full)
        items.append(
            {
                "name": name,
                "path": rel_of(full),
                "is_dir": is_dir,
                "size": 0 if is_dir else st.st_size,
                "size_text": "" if is_dir else fmt_size(st.st_size),
                "mtime": fmt_time(st.st_mtime),
                "ext": "" if is_dir else os.path.splitext(name)[1].lower().lstrip("."),
                "editable": (not is_dir) and is_text_file(full),
            }
        )
    # 文件夹优先，再按名称
    items.sort(key=lambda x: (not x["is_dir"], x["name"].lower()))
    return jsonify({"path": rel, "items": items, "parent": rel_of(os.path.dirname(d))})


# ------------------------- 读取 / 保存 -------------------------
@app.route("/api/read")
def api_read():
    rel = request.args.get("path", "")
    p = safe_path(rel)
    if not os.path.isfile(p):
        abort(404, "文件不存在")
    if not is_text_file(p):
        abort(400, "二进制文件不可编辑")
    if os.path.getsize(p) > 5 * 1024 * 1024:
        abort(400, "文件过大（>5MB），请下载后编辑")
    with open(p, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()
    return jsonify(
        {
            "path": rel,
            "name": os.path.basename(p),
            "content": content,
            "size": os.path.getsize(p),
        }
    )


@app.route("/api/save", methods=["POST"])
def api_save():
    data = request.get_json(force=True)
    rel = data.get("path", "")
    content = data.get("content", "")
    p = safe_path(rel)
    if not os.path.isfile(p):
        abort(404, "文件不存在")
    try:
        with open(p, "w", encoding="utf-8", newline="") as f:
            f.write(content)
    except Exception as e:
        abort(500, f"保存失败：{e}")
    return jsonify({"ok": True, "path": rel})


# ------------------------- 新建 -------------------------
@app.route("/api/create", methods=["POST"])
def api_create():
    data = request.get_json(force=True)
    rel = data.get("path", "")
    name = (data.get("name") or "").strip()
    kind = data.get("type", "file")
    if not name:
        abort(400, "名称不能为空")
    if any(c in name for c in ('\\', '/', ':', '*', '?', '"', '<', '>', '|')):
        abort(400, "名称含非法字符")
    d = safe_path(rel)
    target = os.path.join(d, name)
    if os.path.exists(target):
        abort(400, "已存在同名文件/文件夹")
    try:
        if kind == "dir":
            os.makedirs(target)
        else:
            with open(target, "w", encoding="utf-8") as f:
                f.write("")
    except Exception as e:
        abort(500, f"创建失败：{e}")
    return jsonify({"ok": True, "path": rel_of(target)})


# ------------------------- 删除 -------------------------
@app.route("/api/delete", methods=["POST"])
def api_delete():
    data = request.get_json(force=True)
    paths = data.get("paths", [])
    removed = []
    for rel in paths:
        p = safe_path(rel)
        if p == DOC_ROOT:
            continue
        try:
            if os.path.isdir(p):
                shutil.rmtree(p)
            else:
                os.remove(p)
            removed.append(rel)
        except Exception as e:
            return jsonify({"ok": False, "error": f"删除 {rel} 失败：{e}"})
    return jsonify({"ok": True, "removed": removed})


# ------------------------- 重命名 -------------------------
@app.route("/api/rename", methods=["POST"])
def api_rename():
    data = request.get_json(force=True)
    rel = data.get("path", "")
    new_name = (data.get("new_name") or "").strip()
    if not new_name:
        abort(400, "名称不能为空")
    if any(c in new_name for c in ('\\', '/', ':', '*', '?', '"', '<', '>', '|')):
        abort(400, "名称含非法字符")
    p = safe_path(rel)
    parent = os.path.dirname(p)
    target = os.path.join(parent, new_name)
    if os.path.exists(target):
        abort(400, "已存在同名文件/文件夹")
    try:
        os.rename(p, target)
    except Exception as e:
        abort(500, f"重命名失败：{e}")
    return jsonify({"ok": True, "path": rel_of(target)})


# ------------------------- 复制 / 移动 -------------------------
def _unique_target(src_abs, dest_dir_abs):
    base = os.path.basename(src_abs)
    name, ext = os.path.splitext(base)
    cand = os.path.join(dest_dir_abs, base)
    i = 1
    while os.path.exists(cand):
        cand = os.path.join(dest_dir_abs, f"{name} - 副本{i}{ext}")
        i += 1
    return cand


@app.route("/api/copy", methods=["POST"])
def api_copy():
    data = request.get_json(force=True)
    sources = data.get("sources", [])
    dest_rel = data.get("dest", "")
    dest_dir = safe_path(dest_rel)
    if not os.path.isdir(dest_dir):
        abort(400, "目标必须是目录")
    copied = []
    for rel in sources:
        src = safe_path(rel)
        if not os.path.exists(src):
            continue
        tgt = _unique_target(src, dest_dir)
        try:
            if os.path.isdir(src):
                shutil.copytree(src, tgt)
            else:
                shutil.copy2(src, tgt)
            copied.append(rel_of(tgt))
        except Exception as e:
            return jsonify({"ok": False, "error": f"复制 {rel} 失败：{e}"})
    return jsonify({"ok": True, "copied": copied})


@app.route("/api/move", methods=["POST"])
def api_move():
    data = request.get_json(force=True)
    sources = data.get("sources", [])
    dest_rel = data.get("dest", "")
    dest_dir = safe_path(dest_rel)
    if not os.path.isdir(dest_dir):
        abort(400, "目标必须是目录")
    moved = []
    for rel in sources:
        src = safe_path(rel)
        if src == DOC_ROOT:
            continue
        if os.path.dirname(src) == dest_dir:
            continue
        tgt = _unique_target(src, dest_dir)
        try:
            shutil.move(src, tgt)
            moved.append(rel_of(tgt))
        except Exception as e:
            return jsonify({"ok": False, "error": f"移动 {rel} 失败：{e}"})
    return jsonify({"ok": True, "moved": moved})


# ------------------------- 上传前冲突检测 -------------------------
@app.route("/api/exists", methods=["POST"])
def api_exists():
    body = request.get_json(silent=True) or {}
    d = safe_path(body.get("path", ""))
    rels = body.get("files", []) or []
    existing = []
    for rel_path in rels:
        if not rel_path:
            continue
        parts = str(rel_path).replace("\\", "/").split("/")
        fp = os.path.join(d, *parts)
        if os.path.exists(fp):
            existing.append(rel_path)
    return jsonify(ok=True, exists=existing)


# ------------------------- 上传 -------------------------
@app.route("/api/upload", methods=["POST"])
def api_upload():
    rel = request.form.get("path", "")
    d = safe_path(rel)
    if not os.path.isdir(d):
        abort(400, "目标目录不存在")
    files = request.files.getlist("files")
    if not files:
        abort(400, "未收到文件")
    overwrite = request.form.get("overwrite") == "1"
    saved = []
    for f in files:
        if not f.filename:
            continue
        rel_path = f.filename.replace("\\", "/")
        parts = rel_path.split("/")
        # 支持目录上传（webkitdirectory）：在目标下重建子目录
        sub_dir = os.path.join(d, *parts[:-1]) if len(parts) > 1 else d
        os.makedirs(sub_dir, exist_ok=True)
        base = parts[-1]
        tgt = os.path.join(sub_dir, base)
        if os.path.exists(tgt):
            if overwrite:
                # 直接覆盖同名文件（浏览器已确认）
                f.save(tgt)
            else:
                # 去重（默认行为，避免误覆盖）
                i = 1
                while os.path.exists(tgt):
                    nm, ex = os.path.splitext(base)
                    tgt = os.path.join(sub_dir, f"{nm}({i}){ex}")
                    i += 1
                f.save(tgt)
        else:
            f.save(tgt)
        saved.append(rel_of(tgt))
    return jsonify({"ok": True, "saved": saved})


# ------------------------- 下载 -------------------------
@app.route("/api/download")
def api_download():
    rel = request.args.get("path", "")
    p = safe_path(rel)
    if not os.path.exists(p):
        abort(404, "文件不存在")
    return send_file(p, as_attachment=True)


@app.route("/api/download_zip", methods=["POST"])
def api_download_zip():
    data = request.get_json(force=True)
    paths = data.get("paths", [])
    if not paths:
        abort(400, "未选择文件")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel in paths:
            p = safe_path(rel)
            if not os.path.exists(p):
                continue
            if os.path.isdir(p):
                for root, _, files in os.walk(p):
                    for fn in files:
                        fp = os.path.join(root, fn)
                        arc = os.path.join(rel_of(p), os.path.relpath(fp, p))
                        zf.write(fp, arc)
            else:
                zf.write(p, rel_of(p))
    buf.seek(0)
    return send_file(
        buf,
        mimetype="application/zip",
        as_attachment=True,
        download_name="download.zip",
    )


# ------------------------- 属性 / 权限 / 压缩 / 分享 -------------------------
# 外链直链映射：token -> {"rel": 相对路径, "name": 文件名, "exp": 过期时间戳(秒)或 None, "created": 创建时间戳(秒)}
SHARE_LINKS = {}
SHARE_FILE = os.path.join(AUTH_DIR, "share_links.json")

# 文本类扩展名（小写）：命中后走浏览器内打开（as_attachment=False），二进制则保持下载
TEXT_EXTS = {
    # 代码
    "py", "js", "ts", "mjs", "cjs", "jsx", "tsx", "java", "c", "cpp", "cc", "h", "hpp",
    "cs", "php", "rb", "go", "rs", "swift", "kt", "dart", "m", "mm",
    "sh", "bash", "zsh", "ps1", "bat", "cmd", "sql", "r", "lua", "pl",
    # Web / 样式 / 标记
    "html", "htm", "css", "scss", "sass", "less", "vue", "svelte",
    "xml", "xsl", "wsdl",
    # 数据 / 配置
    "json", "yaml", "yml", "toml", "ini", "conf", "env", "properties",
    "csv", "tsv", "log",
    # 文档
    "md", "markdown", "rst", "txt", "text", "rtf", "tex",
    # 构建 / 杂项
    "gitignore", "gitattributes", "editorconfig", "dockerignore",
    "htaccess", "gradle", "cmake", "mk",
}
TEXT_MIME = {
    "html": "text/html", "htm": "text/html",
    "css": "text/css",
    "js": "application/javascript", "mjs": "application/javascript",
    "json": "application/json",
    "xml": "application/xml", "svg": "image/svg+xml",
    "md": "text/markdown", "markdown": "text/markdown",
    "csv": "text/csv",
}


def _load_share_links():
    """从 data/share_links.json 读取分享映射，过滤已过期项。"""
    try:
        with open(SHARE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return
        now = datetime.now().timestamp()
        for tok, rec in data.items():
            if not isinstance(rec, dict) or "rel" not in rec:
                continue
            exp = rec.get("exp")
            if exp and now > float(exp):
                continue  # 过期丢弃
            SHARE_LINKS[tok] = rec
    except (FileNotFoundError, ValueError, OSError):
        pass


def _save_share_links():
    """原子写：写临时文件后 os.replace 替换，避免半截 JSON 污染磁盘。"""
    tmp = SHARE_FILE + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(SHARE_LINKS, f, ensure_ascii=False, indent=2)
        os.replace(tmp, SHARE_FILE)
    except OSError:
        # 写盘失败不应影响本次分享创建；下次启动仍会丢失
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass


_load_share_links()


@app.route("/api/attrs")
def api_attrs():
    """返回单个文件/目录的属性，供右键菜单"属性"使用。"""
    rel = request.args.get("path", "")
    p = safe_path(rel)
    if not os.path.exists(p):
        abort(404, "文件不存在")
    st = os.stat(p)
    is_dir = os.path.isdir(p)
    info = {
        "path": rel,
        "name": os.path.basename(p) or rel or "/",
        "is_dir": is_dir,
        "size": st.st_size,
        "size_text": fmt_size(st.st_size),
        "mtime": st.st_mtime,
        "mtime_text": fmt_time(st.st_mtime),
        "ctime": st.st_ctime,
        "ctime_text": fmt_time(st.st_ctime),
        "mode": oct(st.st_mode & 0o777)[2:].zfill(3),
        "readonly": not os.access(p, os.W_OK),
    }
    if is_dir:
        fc = dc = 0
        try:
            for _, dirs, files in os.walk(p):
                fc += len(files)
                dc += len(dirs)
        except Exception:
            pass
        info["file_count"] = fc
        info["dir_count"] = dc
    else:
        info["file_count"] = None
        info["dir_count"] = None
    return jsonify(ok=True, info=info)


@app.route("/api/chmod", methods=["POST"])
def api_chmod():
    """修改文件/目录权限（Linux 生效；Windows 无 Unix 权限位，提示不支持）。"""
    data = request.get_json(force=True)
    rel = data.get("path", "")
    mode = data.get("mode")
    p = safe_path(rel)
    if not os.path.exists(p):
        abort(404, "文件不存在")
    if os.name == "nt":
        return jsonify(ok=False, error="Windows 不支持修改 Unix 权限位")
    try:
        m = int(str(mode), 8) if not isinstance(mode, int) else (mode & 0o777)
        os.chmod(p, m)
    except Exception as e:
        abort(500, f"修改权限失败：{e}")
    return jsonify(ok=True, mode=oct(os.stat(p).st_mode & 0o777)[2:].zfill(3))


@app.route("/api/zip", methods=["POST"])
def api_zip():
    """把选中的文件/目录打包成 zip，保存在服务器（仿宝塔"创建压缩"）。"""
    data = request.get_json(force=True)
    paths = data.get("paths", [])
    if not paths:
        abort(400, "未选择文件")
    name = (data.get("name") or "").strip() or "archive"
    if not name.lower().endswith(".zip"):
        name += ".zip"
    if any(c in name for c in ('\\', '/', ':', '*', '?', '"', '<', '>', '|')):
        abort(400, "压缩包名称含非法字符")
    first = safe_path(paths[0])
    dest_dir = os.path.dirname(first) if os.path.isfile(first) else first
    if not os.path.isdir(dest_dir):
        abort(400, "无法确定保存目录")
    tgt = os.path.join(dest_dir, name)
    if os.path.exists(tgt):
        abort(400, "已存在同名压缩包")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel in paths:
            p = safe_path(rel)
            if not os.path.exists(p):
                continue
            if os.path.isdir(p):
                for root, _, files in os.walk(p):
                    for fn in files:
                        fp = os.path.join(root, fn)
                        arc = os.path.join(rel_of(p), os.path.relpath(fp, p))
                        zf.write(fp, arc)
            else:
                zf.write(p, rel_of(p))
    buf.seek(0)
    with open(tgt, "wb") as f:
        f.write(buf.read())
    return jsonify(ok=True, path=rel_of(tgt), name=name)


@app.route("/api/unzip", methods=["POST"])
def api_unzip():
    """解压 zip：单根目录时原地解压到当前目录，多顶层时解压到同名文件夹。"""
    data = request.get_json(force=True, silent=True) or {}
    rel = data.get("path", "")
    p = safe_path(rel)
    if not os.path.isfile(p) or not p.lower().endswith(".zip"):
        abort(400, "仅支持解压 zip 文件")
    parent = os.path.dirname(p)
    try:
        with zipfile.ZipFile(p, "r") as zf:
            names = zf.namelist()
            if not names:
                abort(400, "压缩包为空")
            # 计算顶层成员，判断是否需要新建文件夹
            tops = set()
            for n in names:
                n = n.replace("\\", "/")
                if n.endswith("/"):
                    n = n[:-1]
                parts = n.split("/")
                if parts and parts[0]:
                    tops.add(parts[0])
            if len(tops) == 1 and names[0].replace("\\", "/").endswith("/"):
                dest = parent  # 单根目录：原地解压
            else:
                base = os.path.splitext(os.path.basename(p))[0]
                dest = os.path.join(parent, base)
                i = 1
                while os.path.exists(dest):
                    dest = os.path.join(parent, f"{base}({i})")
                    i += 1
            # 防 zip 路径穿越（zip slip）
            dest_real = os.path.realpath(dest)
            for n in names:
                target = os.path.realpath(os.path.join(dest, n.replace("\\", "/")))
                if target != dest_real and not target.startswith(dest_real + os.sep):
                    abort(400, "压缩包含非法路径，已拒绝")
            zf.extractall(dest)
    except zipfile.BadZipFile:
        abort(400, "不是有效的 zip 文件")
    return jsonify(ok=True, path=rel_of(dest), name=os.path.basename(dest))


@app.route("/api/share", methods=["POST"])
def api_share():
    """生成外链直链 token（匿名可下载/预览，用于外部分享）。"""
    data = request.get_json(force=True)
    rel = data.get("path", "")
    p = safe_path(rel)
    if not os.path.exists(p) or os.path.isdir(p):
        abort(400, "仅支持分享单个文件")
    try:
        expire = int(data.get("expire", 0) or 0)
    except (TypeError, ValueError):
        expire = 0
    token = secrets.token_urlsafe(16)
    now_ts = datetime.now().timestamp()
    exp_ts = (now_ts + expire) if expire > 0 else None
    SHARE_LINKS[token] = {
        "rel": rel,
        "name": os.path.basename(p),
        "exp": exp_ts,
        "created": now_ts,
    }
    _save_share_links()
    link = url_for("shared_file", token=token, _external=True)
    return jsonify(ok=True, token=token, link=link, expire=expire, exp_ts=exp_ts)


@app.route("/api/unshare", methods=["POST"])
def api_unshare():
    """取消（撤销）一个外链直链。body: {"token": "..."}"""
    data = request.get_json(force=True, silent=True) or {}
    token = (data.get("token") or "").strip()
    if not token:
        abort(400, "缺少 token")
    existed = SHARE_LINKS.pop(token, None) is not None
    if existed:
        _save_share_links()
    return jsonify(ok=True, existed=existed)


@app.route("/api/shares", methods=["GET"])
def api_shares():
    """列出当前所有有效分享（已自动剔除过期项）。"""
    now = datetime.now().timestamp()
    items = []
    expired_tokens = []
    for tok, rec in SHARE_LINKS.items():
        exp = rec.get("exp")
        if exp and now > float(exp):
            expired_tokens.append(tok)
            continue
        items.append({
            "token": tok,
            "path": rec.get("rel", ""),
            "name": rec.get("name") or os.path.basename(rec.get("rel", "")) or rec.get("rel", ""),
            "exp": exp,
            "created": rec.get("created"),
            "link": url_for("shared_file", token=tok, _external=True),
        })
    # 顺手清理过期项并落盘
    for tok in expired_tokens:
        SHARE_LINKS.pop(tok, None)
    if expired_tokens:
        _save_share_links()
    items.sort(key=lambda x: x.get("created") or 0, reverse=True)
    return jsonify(ok=True, shares=items)


@app.route("/dl/<token>")
def shared_file(token):
    """外链直链：匿名可访问，按 token 映射回文件，无需登录。
    文本类文件（按扩展名）走浏览器内打开（as_attachment=False），
    其余文件按附件下载。"""
    rec = SHARE_LINKS.get(token)
    if not rec:
        abort(404, "直链不存在或已失效")
    if rec["exp"] and datetime.now().timestamp() > rec["exp"]:
        SHARE_LINKS.pop(token, None)
        _save_share_links()
        abort(410, "直链已过期")
    p = safe_path(rec["rel"])
    if not os.path.isfile(p):
        abort(404, "文件不存在")
    ext = os.path.splitext(p)[1].lstrip(".").lower()
    if ext in TEXT_EXTS:
        mime = TEXT_MIME.get(ext, "text/plain")
        # 浏览器内打开：保留原文件名（避免转义后变 %xx），用 inline disposition
        return send_file(
            p,
            mimetype=mime,
            as_attachment=False,
            download_name=rec.get("name") or os.path.basename(p),
        )
    return send_file(p, as_attachment=True, download_name=rec.get("name") or os.path.basename(p))


# ------------------------- PHP 执行引擎 -------------------------
def run_php(script_abs, req):
    """以 CGI 模式调用 php-cgi 执行脚本，返回 Flask Response。"""
    if not PHP_CGI or not os.path.isfile(PHP_CGI):
        import sys
        is_win = sys.platform.startswith("win")
        hint = (
            "set PHP_CGI=C:\\php-8.3.31-nts-Win32-vs16-x64\\php-cgi.exe"
            if is_win else
            "export PHP_CGI=/usr/bin/php-cgi"
        )
        return Response(
            "<h2>PHP 未配置</h2><p>未检测到 php-cgi。请在启动前设置环境变量 "
            "<code>PHP_CGI</code> 指向 php-cgi 可执行文件，例如：</p>"
            f"<pre>{hint}</pre>"
            "<p>Linux/Docker 下通常安装 <code>php-cgi</code> 包即可自动探测。</p>",
            status=500,
            mimetype="text/html",
        )

    qs = req.query_string.decode("utf-8", "ignore")
    rel = rel_of(script_abs)
    script_name = "/" + rel
    uri = script_name + (("?" + qs) if qs else "")

    env = os.environ.copy()
    env["REDIRECT_STATUS"] = "200"
    env["GATEWAY_INTERFACE"] = "CGI/1.1"
    env["SERVER_SOFTWARE"] = "FlaskPHPServer/1.0"
    env["SERVER_NAME"] = (req.host or "localhost").split(":")[0]
    env["SERVER_PORT"] = str(req.environ.get("SERVER_PORT", config.PORT))
    env["SERVER_PROTOCOL"] = "HTTP/1.1"
    env["DOCUMENT_ROOT"] = DOC_ROOT
    env["SCRIPT_FILENAME"] = os.path.abspath(script_abs)
    env["SCRIPT_NAME"] = script_name
    env["REQUEST_URI"] = uri
    env["REQUEST_METHOD"] = req.method
    env["QUERY_STRING"] = qs
    env["REMOTE_ADDR"] = req.remote_addr or "127.0.0.1"
    env["PATH_INFO"] = ""

    body = req.get_data()
    if body:
        env["CONTENT_LENGTH"] = str(len(body))
    ct = req.headers.get("Content-Type")
    if ct:
        env["CONTENT_TYPE"] = ct

    # 透传部分请求头（仅保留 ASCII，避免 Windows 进程环境编码异常）
    for k, v in req.headers:
        key = k.upper().replace("-", "_")
        if key in ("CONTENT_TYPE", "CONTENT_LENGTH"):
            continue
        try:
            v.encode("ascii")
        except Exception:
            continue
        env.setdefault("HTTP_" + key, v)

    try:
        proc = subprocess.run(
            [PHP_CGI],
            env=env,
            input=body if body else None,
            capture_output=True,
            timeout=60,
            cwd=DOC_ROOT,
        )
    except subprocess.TimeoutExpired:
        return Response("PHP 执行超时", status=504)
    except Exception as e:
        return Response(f"PHP 执行错误：{e}", status=500)

    raw = proc.stdout
    # 拆分 CGI 头与正文
    if b"\r\n\r\n" in raw:
        head_blob, body_out = raw.split(b"\r\n\r\n", 1)
    elif b"\n\n" in raw:
        head_blob, body_out = raw.split(b"\n\n", 1)
    else:
        head_blob, body_out = b"", raw

    status = 200
    resp_headers = {}
    set_cookies = []
    for line in head_blob.split(b"\r\n") if b"\r\n" in head_blob else head_blob.split(b"\n"):
        if b":" not in line:
            continue
        k, v = line.split(b":", 1)
        k = k.strip().decode("latin-1")
        v = v.strip().decode("latin-1")
        lk = k.lower()
        if lk == "status":
            try:
                status = int(v.split()[0])
            except Exception:
                pass
        elif lk == "set-cookie":
            set_cookies.append(v)
        elif lk in (
            "content-type", "content-length", "location", "cache-control",
            "expires", "pragma", "content-disposition", "last-modified",
            "etag", "refresh", "x-powered-by",
        ):
            resp_headers[k] = v
        # 其余头（transfer-encoding/connection 等）忽略

    resp = Response(body_out, status=status)
    for k, v in resp_headers.items():
        resp.headers[k] = v
    for c in set_cookies:
        resp.headers.add("Set-Cookie", c)
    return resp


# ------------------------- 部署 / 运行 -------------------------
def _serve_file(rel, req):
    """实际执行/托管一个文件（PHP 走 CGI，其余走静态）。"""
    p = safe_path(rel)
    if os.path.isdir(p):
        for idx in ("index.html", "index.php", "index.htm"):
            cand = os.path.join(p, idx)
            if os.path.isfile(cand):
                p = cand
                break
        else:
            abort(403, "目录无默认首页")
    if not os.path.isfile(p):
        abort(404, "文件不存在")

    if p.lower().endswith(".php"):
        return run_php(p, req)

    # 静态文件
    mime = mimetypes.guess_type(p)[0] or "application/octet-stream"
    return send_file(p, mimetype=mime, as_attachment=False)


# 部署的 PHP 项目可能用到 POST/PUT/DELETE 等方法（登录、保存、上传、REST 接口等），
# 因此这些路由必须放行全部常用方法，否则 Flask 会返回 405 Method Not Allowed，
# 导致“提交没反应/密码永远不对”等问题。显式路由（/api/*、/setup、/login 等）优先级更高，不受影响。
@app.route("/serve/", methods=["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"])
@app.route("/serve/<path:rel>", methods=["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"])
def serve(rel=""):
    return _serve_file(rel, request)


@app.route("/<path:rel>", methods=["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"])
def root_serve(rel):
    """根路径直服务：http://localhost:5000/foo.php 也能直接运行。"""
    return _serve_file(rel, request)


@app.errorhandler(403)
@app.errorhandler(404)
@app.errorhandler(400)
@app.errorhandler(500)
def _err(e):
    if request.path.startswith("/api/"):
        return jsonify({"ok": False, "error": e.description}), e.code
    if request.path.startswith("/serve/"):
        return Response(f"<h2>错误 {e.code}</h2><p>{e.description}</p>", status=e.code)
    return render_template("error.html", code=e.code, msg=e.description), e.code


if __name__ == "__main__":
    os.makedirs(DOC_ROOT, exist_ok=True)
    os.makedirs(AUTH_DIR, exist_ok=True)
    # 模板热更新：以后改 templates/*.html 不必重启进程
    app.config["TEMPLATES_AUTO_RELOAD"] = True
    print("=" * 50)
    print(" PHP 服务器 / 文件管理器 已启动")
    print(f" 文档根目录 : {DOC_ROOT}")
    print(f" 账号数据   : {AUTH_DIR}")
    print(f" PHP 运行时 : {PHP_CGI or '未检测到'}")
    if PHP_CGI:
        print(f" PHP 版本   : {config.PHP_VERSION}")
    print(f" 管理界面   : http://localhost:{config.PORT}/")
    print(f" 运行站点   : http://localhost:{config.PORT}/serve/")
    print("=" * 50)
    # 启动计划任务调度器（后台线程，自动加载已启用任务）
    try:
        cron.start_scheduler()
        print(" 计划任务调度器: 已启动")
    except Exception as e:
        print(f" 计划任务调度器启动失败: {e}")
    app.run(host=config.HOST, port=config.PORT, threaded=True)
