# -*- coding: utf-8 -*-
"""计划任务调度模块（基于 APScheduler）

任务定义持久化在 data/cron.json，执行日志落在 data/cron_logs/<task_id>.log。
支持四类任务：
  - shell  : 定时执行系统命令
  - url    : 定时访问 HTTP 接口（GET/POST）
  - php    : 定时运行 PHP 脚本（CLI）
  - backup : 目录 / MySQL 备份
周期支持两种模式：
  - simple : 分钟/时/日/周/月 可视化选择（间隔 + 时间点）
  - cron   : 标准 5 段 cron 表达式
"""
import os
import json
import uuid
import zipfile
import subprocess
import urllib.request
import urllib.error

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

import config

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CRON_FILE = os.path.join(config.AUTH_DIR, "cron.json")
LOG_DIR = os.path.join(config.AUTH_DIR, "cron_logs")

scheduler = None  # BackgroundScheduler 单例
_RUNNING_LOCK = {}  # 进程锁字典: task_id -> True（运行中）


# ----------------------------- 存储 -----------------------------
def load_tasks():
    """读取全部任务定义；损坏或缺失时返回空列表。"""
    if not os.path.isfile(CRON_FILE):
        return []
    try:
        with open(CRON_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data.get("tasks", []) if isinstance(data, dict) else []
    except Exception:
        return []


def save_tasks(tasks):
    """覆盖写入任务定义。"""
    os.makedirs(os.path.dirname(CRON_FILE), exist_ok=True)
    with open(CRON_FILE, "w", encoding="utf-8") as f:
        json.dump({"tasks": tasks}, f, ensure_ascii=False, indent=2)


def _patch_meta(tasks, tid, **fields):
    """更新某个任务的元数据（last_run / last_status 等）并落盘。"""
    for x in tasks:
        if x.get("id") == tid:
            x.update(fields)
            break
    save_tasks(tasks)


# ----------------------------- 日志 -----------------------------
def _log(tid, text):
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        with open(os.path.join(LOG_DIR, f"{tid}.log"), "a", encoding="utf-8") as f:
            f.write(text + "\n")
    except Exception:
        pass


def get_logs(tid, lines=200):
    path = os.path.join(LOG_DIR, f"{tid}.log")
    if not os.path.isfile(path):
        return ""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            all_lines = f.readlines()
        return "".join(all_lines[-lines:])
    except Exception:
        return ""


# ----------------------------- 执行器 -----------------------------
def _exec_shell(task):
    cmd = task.get("command", "")
    timeout = int(task.get("timeout", 300))
    if not cmd.strip():
        return False, "命令为空"
    try:
        r = subprocess.run(
            cmd, shell=True, cwd=BASE_DIR,
            capture_output=True, text=True, timeout=timeout,
        )
        out = f"[返回码 {r.returncode}]\n--- stdout ---\n{r.stdout}\n--- stderr ---\n{r.stderr}"
        return r.returncode == 0, out
    except subprocess.TimeoutExpired:
        return False, f"执行超时（>{timeout}s）"
    except Exception as e:
        return False, f"执行异常: {e}"


def _exec_url(task):
    url = task.get("url", "")
    if not url.strip():
        return False, "URL 为空"
    method = (task.get("method") or "GET").upper()
    headers = task.get("headers") or {}
    body = task.get("body") or ""
    timeout = int(task.get("timeout", 30))
    data = body.encode("utf-8") if body else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            code = resp.getcode()
            txt = resp.read().decode("utf-8", "replace")
        return True, f"[HTTP {code}]\n{txt[:3000]}"
    except urllib.error.HTTPError as e:
        return False, f"[HTTP {e.code}]\n{e.read().decode('utf-8', 'replace')[:3000]}"
    except Exception as e:
        return False, f"请求失败: {e}"


def _detect_php_cli():
    cgi = config.PHP_CGI
    if cgi:
        d = os.path.dirname(cgi)
        for name in ("php.exe", "php"):
            p = os.path.join(d, name)
            if os.path.isfile(p):
                return p
    import shutil as _s
    p = _s.which("php")
    return os.path.abspath(p) if p else None


def _exec_php(task):
    php = _detect_php_cli()
    if not php:
        return False, "未找到 PHP CLI（php.exe/php），无法执行 PHP 脚本"
    script = task.get("php_path", "")
    if not script.strip():
        return False, "未指定 PHP 脚本路径"
    if not os.path.isabs(script):
        script = os.path.join(config.DOC_ROOT, script)
    if not os.path.isfile(script):
        return False, f"PHP 脚本不存在: {script}"
    timeout = int(task.get("timeout", 300))
    try:
        r = subprocess.run(
            [php, "-f", script], capture_output=True, text=True,
            timeout=timeout, cwd=os.path.dirname(script),
        )
        out = f"[返回码 {r.returncode}]\n{r.stdout}\n{r.stderr}"
        return r.returncode == 0, out
    except subprocess.TimeoutExpired:
        return False, f"执行超时（>{timeout}s）"
    except Exception as e:
        return False, f"执行异常: {e}"


def _exec_backup(task):
    cfg = task.get("backup", {}) or {}
    target = cfg.get("target", "dir")
    timeout = int(task.get("timeout", 600))
    if target == "dir":
        src = cfg.get("src", "")
        dest = cfg.get("dest", "")
        if not src or not os.path.isdir(src):
            return False, f"备份源目录不存在: {src}"
        if not dest:
            return False, "未指定备份目标路径"
        os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
        try:
            with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
                for root, _, files in os.walk(src):
                    for fn in files:
                        fp = os.path.join(root, fn)
                        try:
                            z.write(fp, os.path.relpath(fp, src))
                        except Exception:
                            pass
            return True, f"目录备份完成: {src} -> {dest}（{os.path.getsize(dest)} 字节）"
        except Exception as e:
            return False, f"备份失败: {e}"
    elif target == "mysql":
        dump = cfg.get("mysqldump") or "mysqldump"
        host = cfg.get("host", "127.0.0.1")
        port = cfg.get("port", "3306")
        user = cfg.get("user", "")
        pwd = cfg.get("password", "")
        db = cfg.get("db", "")
        dest = cfg.get("dest", "")
        if not db or not dest:
            return False, "未指定数据库名或备份目标"
        cmd = [dump, f"-h{host}", f"-P{port}", f"-u{user}", f"-p{pwd}", db]
        try:
            with open(dest, "w", encoding="utf-8") as out:
                r = subprocess.run(cmd, stdout=out, stderr=subprocess.PIPE,
                                   text=True, timeout=timeout)
            if r.returncode != 0:
                return False, f"mysqldump 失败(返回码{r.returncode}): {r.stderr[:2000]}"
            return True, f"数据库备份完成: {db} -> {dest}"
        except FileNotFoundError:
            return False, f"未找到 mysqldump 命令: {dump}"
        except subprocess.TimeoutExpired:
            return False, f"备份超时（>{timeout}s）"
        except Exception as e:
            return False, f"执行异常: {e}"
    else:
        return False, f"未知备份类型: {target}"


_EXECUTORS = {
    "shell": _exec_shell,
    "url": _exec_url,
    "php": _exec_php,
    "backup": _exec_backup,
}


def run_task(task):
    """执行单个任务，写日志并更新 last_run/last_status。返回 (ok, detail)。"""
    tid = task.get("id")
    from datetime import datetime
    if task.get("proclock") and _RUNNING_LOCK.get(tid):
        skip_ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        skip_msg = "[%s] 跳过: 任务上次执行尚未结束（进程锁）" % skip_ts
        _log(tid, "\n" + skip_msg)
        return False, skip_msg
    _RUNNING_LOCK[tid] = True
    try:
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        _log(tid, "\n===== 执行开始 " + ts + " | 类型=" + str(task.get("type")) + " | 名称=" + str(task.get("name")) + " =====")
        fn = _EXECUTORS.get(task.get("type"))
        if not fn:
            ok, out = False, ("未知任务类型: " + str(task.get("type")))
        else:
            try:
                ok, out = fn(task)
            except Exception as e:
                ok, out = False, ("执行异常: " + str(e))
        status = "成功" if ok else "失败"
        _log(tid, "结果: " + status + "\n" + out)
        _patch_meta(load_tasks(), tid,
                    last_run=int(datetime.now().timestamp()),
                    last_status="success" if ok else "fail")
        return ok, out
    finally:
        _RUNNING_LOCK.pop(tid, None)
# ----------------------------- 触发器 -----------------------------
def build_trigger(task):
    """根据任务周期配置构造 APScheduler 触发器。"""
    if task.get("schedule_mode") == "cron":
        return CronTrigger.from_crontab(task.get("cron", "0 * * * *"))
    s = task.get("simple", {}) or {}
    unit = s.get("unit", "day")
    interval = max(1, int(s.get("interval", 1)))
    if unit == "minute":
        return IntervalTrigger(minutes=interval)
    if unit == "hour":
        return IntervalTrigger(hours=interval)
    if unit == "random":
        # 每天在 [rstart, rend) 小时窗口内随机一个时刻执行一次
        start = int(s.get("rstart", 6))
        end = int(s.get("rend", 22))
        if end <= start:
            end = start + 1
        span = (end - start) * 3600
        return CronTrigger(hour=start, minute=int(s.get("rminute", 0)), jitter=span)
    if unit == "day":
        return CronTrigger(hour=int(s.get("hour", 0)), minute=int(s.get("minute", 0)))
    if unit == "week":
        # cron day_of_week: 0=周一 ... 6=周日（与宝塔一致：0=周一）
        return CronTrigger(day_of_week=int(s.get("weekday", 0)),
                           hour=int(s.get("hour", 0)), minute=int(s.get("minute", 0)))
    if unit == "month":
        return CronTrigger(day=int(s.get("day", 1)),
                           hour=int(s.get("hour", 0)), minute=int(s.get("minute", 0)))
    return IntervalTrigger(days=1)


# ----------------------------- 调度器 -----------------------------
def _add_job(task):
    if not scheduler:
        return
    try:
        scheduler.add_job(
            lambda t=task: run_task(t),
            trigger=build_trigger(task),
            id=task["id"], replace_existing=True,
            max_instances=1, coalesce=True,
        )
    except Exception as e:
        _log(task.get("id"), f"添加调度失败: {e}")


def _remove_job(tid):
    if scheduler:
        try:
            scheduler.remove_job(tid)
        except Exception:
            pass


def next_run_time(tid):
    if scheduler:
        job = scheduler.get_job(tid)
        if job and job.next_run_time:
            return int(job.next_run_time.timestamp())
    return None


def start_scheduler():
    """初始化并启动后台调度器，加载所有启用任务。"""
    global scheduler
    if scheduler and scheduler.running:
        return scheduler
    scheduler = BackgroundScheduler()
    for t in load_tasks():
        if t.get("enabled", True):
            _add_job(t)
    scheduler.start()
    return scheduler


# ----------------------------- 任务增删改 -----------------------------
def add_task(data):
    """新增任务，返回完整任务对象。"""
    tasks = load_tasks()
    tid = uuid.uuid4().hex
    task = {
        "id": tid,
        "name": data.get("name", "未命名任务"),
        "type": data.get("type", "shell"),
        "enabled": bool(data.get("enabled", True)),
        "schedule_mode": data.get("schedule_mode", "simple"),
        "proclock": bool(data.get("proclock", False)),
        "simple": data.get("simple", {"unit": "day", "interval": 1, "hour": 0, "minute": 0}),
        "cron": data.get("cron", "0 * * * *"),
        "command": data.get("command", ""),
        "url": data.get("url", ""),
        "method": data.get("method", "GET"),
        "headers": data.get("headers", {}),
        "body": data.get("body", ""),
        "php_path": data.get("php_path", ""),
        "backup": data.get("backup", {"target": "dir", "src": "", "dest": ""}),
        "timeout": int(data.get("timeout", 300)),
        "created": int(__import__("datetime").datetime.now().timestamp()),
        "last_run": None,
        "last_status": None,
    }
    tasks.append(task)
    save_tasks(tasks)
    if task["enabled"]:
        _add_job(task)
    return task


def update_task(tid, data):
    """更新任务字段并重启调度。返回更新后的任务或 None。"""
    tasks = load_tasks()
    for i, t in enumerate(tasks):
        if t.get("id") == tid:
            t.update({
                "name": data.get("name", t.get("name")),
                "type": data.get("type", t.get("type")),
                "enabled": bool(data.get("enabled", t.get("enabled", True))),
                "schedule_mode": data.get("schedule_mode", t.get("schedule_mode", "simple")),
                "proclock": bool(data.get("proclock", t.get("proclock", False))),
                "simple": data.get("simple", t.get("simple", {})),
                "cron": data.get("cron", t.get("cron", "0 * * * *")),
                "command": data.get("command", t.get("command", "")),
                "url": data.get("url", t.get("url", "")),
                "method": data.get("method", t.get("method", "GET")),
                "headers": data.get("headers", t.get("headers", {})),
                "body": data.get("body", t.get("body", "")),
                "php_path": data.get("php_path", t.get("php_path", "")),
                "backup": data.get("backup", t.get("backup", {})),
                "timeout": int(data.get("timeout", t.get("timeout", 300))),
            })
            save_tasks(tasks)
            _remove_job(tid)
            if t["enabled"]:
                _add_job(t)
            return t
    return None


def delete_task(tid):
    """删除任务并移除调度。"""
    tasks = load_tasks()
    tasks = [t for t in tasks if t.get("id") != tid]
    save_tasks(tasks)
    _remove_job(tid)
    # 清理日志
    try:
        os.remove(os.path.join(LOG_DIR, f"{tid}.log"))
    except Exception:
        pass


def toggle_task(tid, enabled):
    """启用/停用任务。"""
    tasks = load_tasks()
    for t in tasks:
        if t.get("id") == tid:
            t["enabled"] = bool(enabled)
            save_tasks(tasks)
            _remove_job(tid)
            if t["enabled"]:
                _add_job(t)
            return True
    return False


def run_once(tid):
    """立即手动执行一次（不依赖调度）。返回 (ok, detail)。"""
    for t in load_tasks():
        if t.get("id") == tid:
            return run_task(t)
    return False, "任务不存在"
