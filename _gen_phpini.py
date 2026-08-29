import io, os

PHP_DIR = r"C:\php-8.3.31-nts-Win32-vs16-x64"
src = os.path.join(PHP_DIR, "php.ini-development")
dst = os.path.join(PHP_DIR, "php.ini")

with io.open(src, "r", encoding="utf-8", errors="replace") as f:
    text = f.read()

# 关键：extension_dir 必须用绝对路径，否则会被解析到构建前缀 C:\php\ext
# 去掉所有 (含注释) 已有的 extension_dir 行，统一插入一条生效的绝对路径
import re
text = re.sub(r'(?im)^\s*;?\s*extension_dir\s*=.*$', '', text)
text = 'extension_dir = "%s\\ext"\n' % PHP_DIR + text

# 关闭启动期错误输出到 stdout（否则会污染 CGI 头），改为写入日志文件
text = text.replace("; display_startup_errors = Off", "display_startup_errors = Off")
text = text.replace("display_startup_errors = On", "display_startup_errors = Off")
text = text.replace('; error_log = syslog', 'error_log = "%s\\php_errors.log"' % PHP_DIR)
# 允许运行时错误显示在页面（开发友好），但不影响 CGI 头
text = text.replace("; display_errors = Off", "display_errors = On")

enable = [
    "curl", "mbstring", "openssl", "fileinfo", "gd", "zip",
    "pdo_sqlite", "sqlite3", "intl", "sockets", "soap", "tidy",
    "xsl", "mysqli", "pdo_mysql", "bcmath", "exif", "gettext",
    "gmp", "ftp", "opcache",
]
for ext in enable:
    text = text.replace(";extension=%s" % ext, "extension=%s" % ext)

text = text.replace("; date.timezone =", 'date.timezone = "Asia/Shanghai"')
text = text.replace("upload_max_filesize = 2M", "upload_max_filesize = 200M")
text = text.replace("post_max_size = 8M", "post_max_size = 200M")

with io.open(dst, "w", encoding="utf-8") as f:
    f.write(text)

print("php.ini rewritten ->", dst)
